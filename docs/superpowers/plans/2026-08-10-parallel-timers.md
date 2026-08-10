# 複数活動の同時計測 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 計測中に別の活動の計測を開始できるようにし（入浴中に歯磨きを記録する等）、それぞれを独立に一時停止・終了・破棄できるようにする。

**Architecture:** `DB.running: Running | null` を `DB.runnings: Running[]` に置き換える。計測中バナーは固定1行の静的マークアップから、`runnings` の各要素に対応する `.rb-row` を JS が生成する構造に変える。重複時間は両方の活動にフル計上するため、統計・記録ロジックには一切手を入れない。3タスクに分け、Task 1（データモデル）と Task 2（バナーDOM）は既存の「同時に1つだけ」制約を維持したまま内部だけを入れ替えて振る舞いを変えず、Task 3 で制約を外す。

**Tech Stack:** TypeScript（strict、`tsc` で `app.js` へコンパイル）、素の DOM API、localStorage、Service Worker。テストフレームワークは無い。

**設計書:** `docs/superpowers/specs/2026-08-10-parallel-timers-design.md`

## Global Constraints

- **`app.ts` のみを編集する。`app.js` は `tsc` の生成物で git-ignore されている**（`CLAUDE.md`）。`app.js` を直接編集しても commit されず、CI が上書きする。
- Node コマンドは `mise exec --` 経由で実行する: `mise exec -- npm run build`。
- TypeScript は `strict` モード。`tsc` がエラー0で通ることが全タスクの完了条件。
- 時間の値は全て分単位、全ての入力経路で最低1分（`Math.max(1, ...)`）。0分の記録を作らない。
- コミットは Conventional Commits、英語。`Claude-Session:` トレーラは付けない。
- 活動名は必ず `textContent` で設定する（`innerHTML` に埋め込まない）。既存コードがこの規約を守っている。
- **ローカル動作確認時は Service Worker を無効化する。** `app.js` は cache-first で配信されるため、有効なままだと再ビルドしても古い `app.js` が返り、修正が反映されていないように見える。DevTools → Application → Service Workers → **Bypass for network** にチェックを入れてから確認する。
- 既存の日本語コメントのスタイル（「なぜそうするか」を書く）に合わせる。

## ローカルサーバーの起動

`file://` では Service Worker と localStorage の挙動が変わるため、必ず HTTP で開く。

```bash
cd /Users/shifumin/ghq/github.com/shifumin/howlong
python3 -m http.server 8765
```

ブラウザで <http://localhost:8765/> を開く。以降の動作確認手順の「コンソールで実行」は、このページの DevTools コンソールで実行する。

## File Structure

| ファイル | 変更内容 |
|---------|---------|
| `app.ts` | 全変更の中心。データモデル、タイマー制御、バナー生成、各 mutation 関数。 |
| `index.html` | `#runningBanner` を空のコンテナに変更。バナー関連 CSS を行ベースに書き換え、`body.running` ルールを削除。 |
| `sw.js` | `CACHE` を `howlong-v4` → `howlong-v5` にバンプ（Task 3）。 |
| `package.json` | `version` を `1.2.2` → `1.3.0`（Task 3）。 |

`app.ts` は564行の単一ファイルで、セクションコメント（`/* ---------- timer ---------- */` 等）で区切られている。この構成は維持し、ファイル分割はしない（ビルドが `tsc` 単一ファイル前提で、モジュール化は今回の目的から外れる）。

---

### Task 1: データモデルを `runnings` 配列に置き換える（振る舞いは変えない）

`DB.running: Running | null` を `DB.runnings: Running[]` にし、全ての呼び出し側を追随させる。**この時点では「同時に1つだけ計測できる」制約を維持する**ため、ユーザーから見た振る舞いは一切変わらない。レビュー観点は「アプリが今までと完全に同じに動くか」と「旧形式の localStorage が移行されるか」。

**Files:**
- Modify: `app.ts`（型定義、`load`、timer セクション、mutations、render、events、boot）

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces:
  - `interface DB { activities: Activity[]; runnings: Running[] }`
  - `function normalizeRunnings(parsed: { runnings?: unknown; running?: Partial<Running> | null }): Running[]`
  - `function findRunning(activityId: string): Running | undefined`
  - `function syncTimerLoop(): void`
  - `function refreshRunning(): void`
  - `function startActivity(id: string): void`（既存シグネチャのまま）
  - `function pauseActivity(id: string): void` / `resumeActivity(id: string): void` / `stopActivity(id: string): void` / `cancelActivity(id: string): void`（全て引数を取るようになる）
  - `function clearArmed(id: string): void` / `disarmCancel(id: string): void`
  - `const armedCancels: Map<string, number>`
  - `function elapsedMs(running: Running): number`（既存、変更なし）
  - `function updateRunningBanner(): void`（既存、`state.runnings[0]` を読むよう変更。Task 2 で `renderBanner` / `tickBanner` に置き換わる）

- [ ] **Step 1: `DB` 型と `load()` を書き換える**

`app.ts` の `interface DB`（25-29行目付近）を変更する。

```ts
// localStorage に保存するデータ全体
interface DB {
  activities: Activity[];
  runnings: Running[];   // 計測中の活動。1つの activityId につき最大1件
}
```

`normalizeRunning()` の直後に、新形式（`runnings` 配列）と旧形式（`running` 単一オブジェクト）の両方を読める関数を追加する。

```ts
// 新形式(runnings 配列)と旧形式(running 単一オブジェクト)の両方から計測中リストを復元する。
// 同じ activityId が重複していたら先勝ちで捨てる（1活動1計測の不変条件を読み込み時に担保する）
function normalizeRunnings(parsed: { runnings?: unknown; running?: Partial<Running> | null }): Running[] {
  if (Array.isArray(parsed.runnings)) {
    const out: Running[] = [];
    for (const raw of parsed.runnings) {
      const r = normalizeRunning(raw as Partial<Running>);
      if (r && !out.some((x) => x.activityId === r.activityId)) out.push(r);
    }
    return out;
  }
  const single = normalizeRunning(parsed.running);
  return single ? [single] : [];
}
```

`load()` を書き換える。

```ts
function load(): DB {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { activities?: unknown; runnings?: unknown; running?: Partial<Running> | null };
      if (parsed && Array.isArray(parsed.activities)) {
        // 古いデータに runnings が無くても running / 空配列で補う
        return { activities: parsed.activities as Activity[], runnings: normalizeRunnings(parsed) };
      }
    }
  } catch (e) { /* fall through to default */ }
  return { activities: [], runnings: [] };
}
```

`save()` は `JSON.stringify(state)` をそのまま書いているため変更不要。`state` の形が変わることで自動的に新形式が保存され、旧 `running` キーは書かれなくなる。

- [ ] **Step 2: ビルドしてコンパイルエラーが出ることを確認する**

Run: `mise exec -- npm run build`
Expected: FAIL。`state.running` を参照している箇所（`updateRunningBanner`、`startActivity`、`pauseActivity`、`resumeActivity`、`stopActivity`、`cancelActivity`、`deleteActivity`、`importJSON`、`render`、イベント登録、boot 処理）で `Property 'running' does not exist on type 'DB'` 系のエラーが多数出る。これが「これから直す箇所の一覧」になる。

- [ ] **Step 3: timer セクションを書き換える**

`/* ---------- timer ---------- */` 以下の `startTimerLoop` / `stopTimerLoop` / `updateRunningBanner` を次で置き換える。`elapsedMs` は変更しない。

```ts
/* ---------- timer ---------- */
let tick: number | null = null;

// 計測中(一時停止していない)活動が1つ以上ある間だけ毎秒更新を回す。
// 呼び出し側は「回すべきか」を判断せず、状態を変えたらこれを呼ぶだけでよい
function syncTimerLoop(): void {
  const needed = state.runnings.some((r) => !r.paused);
  if (needed && tick == null) {
    tick = setInterval(updateRunningBanner, 1000);
  } else if (!needed && tick != null) {
    clearInterval(tick);
    tick = null;
  }
}

// バナー周りの再同期の唯一の入口。状態を変えたあとに必ずこれを呼ぶ
function refreshRunning(): void {
  // 削除済みの活動を指す計測が残っていたら捨てる（自己修復）
  const alive = state.runnings.filter((r) => state.activities.some((a) => a.id === r.activityId));
  if (alive.length !== state.runnings.length) {
    state.runnings = alive;
    save();
  }
  updateRunningBanner();
  syncTimerLoop();
}

// 一時停止時間を除いた実働の経過時間(ms)を返す
function elapsedMs(running: Running): number {
  return running.paused ? running.accumulatedMs : running.accumulatedMs + (Date.now() - running.start);
}

function updateRunningBanner(): void {
  const banner = $("#runningBanner");
  const running = state.runnings[0];
  if (!running) {
    banner.classList.remove("show");
    banner.classList.remove("paused");
    document.body.classList.remove("running");
    return;
  }
  const act = state.activities.find((a) => a.id === running.activityId);
  if (!act) return;
  banner.classList.add("show");
  document.body.classList.add("running");
  banner.classList.toggle("paused", running.paused);
  $("#rbName").textContent = act.name + (running.paused ? " を一時停止中" : " を計測中");
  const pauseBtn = $<HTMLButtonElement>("#pauseBtn");
  pauseBtn.textContent = running.paused ? "再開" : "一時停止";
  pauseBtn.classList.toggle("paused", running.paused);
  $("#rbTime").textContent = fmtElapsed(elapsedMs(running));
}

// 経過ミリ秒を "MM:SS"（1時間以上は "H:MM:SS"）に整形する
function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
```

変更点の意図:
- `updateRunningBanner()` から `stopTimerLoop()` / 自己修復の副作用を取り除き、表示のみの責務にした。ループ制御は `syncTimerLoop()`、自己修復は `refreshRunning()` が持つ。
- 時刻の整形を `fmtElapsed()` に切り出した。Task 2 で毎秒更新専用の関数から使う。

- [ ] **Step 4: `findRunning` ヘルパーを追加する**

`/* ---------- helpers ---------- */` セクションの末尾（`fmtMin` の後）に追加する。次の Step 以降が全面的に使う。

```ts
// 指定した活動が計測中ならその Running を返す
function findRunning(activityId: string): Running | undefined {
  return state.runnings.find((r) => r.activityId === activityId);
}
```

- [ ] **Step 5: 計測の開始・一時停止・再開・終了を `activityId` 受け取りに変える**

`startActivity` から `stopActivity` までを次で置き換える。`startActivity` のガードは**今までどおり「他に計測中があれば拒否」のまま**にする（制約を外すのは Task 3）。

```ts
function startActivity(id: string): void {
  if (state.runnings.length) { toast("計測中の活動があります"); return; }
  const now = Date.now();
  state.runnings.push({ activityId: id, start: now, firstStart: now, accumulatedMs: 0, paused: false });
  save();
  refreshRunning();
  render();
}
function pauseActivity(id: string): void {
  const running = findRunning(id);
  if (!running || running.paused) return;
  running.accumulatedMs += Date.now() - running.start;
  running.paused = true;
  save();
  refreshRunning();
}
function resumeActivity(id: string): void {
  const running = findRunning(id);
  if (!running || !running.paused) return;
  running.start = Date.now();
  running.paused = false;
  save();
  refreshRunning();
}
function stopActivity(id: string): void {
  const running = findRunning(id);
  if (!running) return;
  clearArmed(id);
  const act = state.activities.find((a) => a.id === id);
  const startMs = running.firstStart;
  const endMs = Date.now();
  const minutes = Math.max(1, Math.round(elapsedMs(running) / 60000));
  state.runnings = state.runnings.filter((r) => r.activityId !== id);
  if (act) {
    act.records.push({ start: toLocalMinuteISO(startMs), end: toLocalMinuteISO(endMs), minutes });
  }
  save();
  refreshRunning();
  render();
  if (act) toast("記録しました");
}
```

`startActivity` に `render()` を追加した理由: 開始したカードの「開始」ボタン表示を切り替えるため（Task 3 で「計測中…」表示を入れる下地）。

- [ ] **Step 6: 「やめる」の2段階確認を活動ごとの Map に置き換える**

`let cancelArmed = false;` から `cancelActivity()` までのブロックを次で置き換える。

```ts
// 計測の取り消し（記録を残さない）。誤タップ防止に2段階確認。
// armed 状態は活動ごとに持つ。行を作り直しても Map から表示を復元できる
const armedCancels = new Map<string, number>();

// armed 解除のみ（再描画しない）。他の処理の途中から呼ぶ用
function clearArmed(id: string): void {
  const t = armedCancels.get(id);
  if (t != null) clearTimeout(t);
  armedCancels.delete(id);
}
// armed 解除して表示も戻す。3秒の自動解除タイマーはこちらを使う
function disarmCancel(id: string): void {
  clearArmed(id);
  updateRunningBanner();
}
function cancelActivity(id: string): void {
  if (!findRunning(id)) return;
  if (!armedCancels.has(id)) {
    armedCancels.set(id, window.setTimeout(() => disarmCancel(id), 3000));
    updateRunningBanner();
    return;
  }
  clearArmed(id);
  state.runnings = state.runnings.filter((r) => r.activityId !== id);
  save();
  refreshRunning();
  render();
  toast("計測をやめました");
}
```

`updateRunningBanner()` に armed 表示の復元を追加する（Step 3 で置き換えた `updateRunningBanner` の `$("#rbTime")` の行の直前に挿入）。

```ts
  const cancelBtn = $<HTMLButtonElement>("#cancelBtn");
  const armed = armedCancels.has(running.activityId);
  cancelBtn.classList.toggle("armed", armed);
  cancelBtn.textContent = armed ? "本当にやめる？" : "やめる";
```

- [ ] **Step 7: `deleteActivity` と `importJSON` を追随させる**

`deleteActivity` を書き換える。

```ts
function deleteActivity(id: string): void {
  state.activities = state.activities.filter((a) => a.id !== id);
  state.runnings = state.runnings.filter((r) => r.activityId !== id);
  clearArmed(id);
  save();
  refreshRunning();
  render();
}
```

`importJSON` の中の `state.activities = activities;` 以降のブロックを書き換える。

```ts
      state.activities = activities;
      state.runnings = [];
      armedCancels.forEach((t) => clearTimeout(t));
      armedCancels.clear();
      save();
      refreshRunning();
      render();
      toast("インポートしました");
```

（`state.running = null;` と `stopTimerLoop();` の2行が `state.runnings = []` と armed のクリア、`refreshRunning()` に置き換わる。）

- [ ] **Step 8: `render()` の開始ボタンと、末尾のイベント登録・boot 処理を追随させる**

`render()` 内の開始ボタン（440-442行目付近）を書き換える。**Task 1 では今までどおり「何か計測中なら全カード無効」を維持する。**

```ts
    const startBtn = $<HTMLButtonElement>(".start", card);
    startBtn.disabled = state.runnings.length > 0;
    startBtn.onclick = () => startActivity(act.id);
```

`/* ---------- events ---------- */` セクションのバナーボタン3つの登録を書き換える。`state.runnings[0]` から対象を解決する。

```ts
$("#stopBtn").addEventListener("click", () => {
  const r = state.runnings[0];
  if (r) stopActivity(r.activityId);
});
$("#cancelBtn").addEventListener("click", () => {
  const r = state.runnings[0];
  if (r) cancelActivity(r.activityId);
});
$("#pauseBtn").addEventListener("click", () => {
  const r = state.runnings[0];
  if (!r) return;
  if (r.paused) resumeActivity(r.activityId); else pauseActivity(r.activityId);
});
```

`visibilitychange` のハンドラは `updateRunningBanner()` のまま変更しない。

`/* ---------- boot ---------- */` の分岐を1行にする。

```ts
/* ---------- boot ---------- */
render();
refreshRunning();
```

（`if (state.running) { if (state.running.paused) updateRunningBanner(); else startTimerLoop(); }` の4行が `refreshRunning();` になる。一時停止中かどうかの判断は `syncTimerLoop()` が行う。）

- [ ] **Step 9: ビルドが通ることを確認する**

Run: `mise exec -- npm run build`
Expected: PASS（出力なし、終了コード0）。`app.js` が更新される。

- [ ] **Step 10: 旧形式（最古）の localStorage が移行されることを確認する**

ローカルサーバーを起動し（前述）、DevTools で Service Worker を Bypass for network にしてから、コンソールで実行する。

```js
localStorage.setItem("howlong.v1", JSON.stringify({
  activities: [
    { id: "aTest1", name: "入浴", plannedMinutes: 30, records: [] },
    { id: "aTest2", name: "歯磨き", plannedMinutes: null, records: [] }
  ],
  running: { activityId: "aTest1", start: Date.now() - 5 * 60000 }
}));
location.reload();
```

Expected:
- バナーに「入浴 を計測中」と `05:00` 付近が表示され、毎秒進む。
- 「歯磨き」カードの「開始」ボタンが無効（今までどおりの制約）。

続けてバナーの「一時停止」を押し、コンソールで実行する。

```js
JSON.parse(localStorage.getItem("howlong.v1"))
```

Expected: `runnings` が長さ1の配列で、`running` キーが存在しない。要素に `firstStart` / `accumulatedMs` / `paused: true` が入っている。

- [ ] **Step 11: 旧形式（一時停止中）の localStorage が移行されることを確認する**

コンソールで実行する。

```js
const now = Date.now();
localStorage.setItem("howlong.v1", JSON.stringify({
  activities: [{ id: "aTest1", name: "入浴", plannedMinutes: null, records: [] }],
  running: { activityId: "aTest1", start: now, firstStart: now - 600000, accumulatedMs: 420000, paused: true }
}));
location.reload();
```

Expected: バナーがグレーで「入浴 を一時停止中」、時刻は `07:00` で固定（進まない）。「再開」ボタンが白背景。

- [ ] **Step 12: 既存機能の回帰確認をする**

コンソールで `localStorage.clear(); location.reload();` を実行してから、UI だけで次を順に確認する。

1. 「入浴」を追加 → カードが出る。
2. 「開始」→ バナーが出て時刻が進む。「歯磨き」を追加して「開始」を押す → 「計測中の活動があります」の toast が出て開始されない。
3. 「一時停止」→ バナーがグレー、時刻が止まる。「再開」→ 進む。
4. 「やめる」を1回押す → 赤い「本当にやめる？」になる。3秒待つ → 「やめる」に戻る。
5. 「やめる」を2回連続で押す → 「計測をやめました」の toast、バナーが消え、履歴に記録が増えていない。
6. 再度「開始」→ 1分以上待たずに「終了」→ 「記録しました」、履歴に **1分** の記録が入る（最低1分の切り上げ）。
7. 「開始」してからページをリロード → 計測が復元され時刻が続いている。
8. 「開始」してから、そのカードの 🗑 で活動を削除 → バナーが消え、エラーが出ない。
9. 「書出」でJSONをダウンロード →「取込」で読み込む → 計測が破棄され、活動と記録が復元される。
10. 履歴の「手入力で追加」で 25 分を追加 → 統計の平均・中央値・回数・最新が更新される。

Expected: 全て今までどおり動く。Task 1 は内部構造の入れ替えのみで、ユーザーから見た振る舞いは変わらない。

- [ ] **Step 13: コミットする**

```bash
git add app.ts
git commit -m "refactor: hold running timers in a list instead of a single slot

Replaces DB.running (Running | null) with DB.runnings (Running[]) and
threads an activityId through pause/resume/stop/cancel. load() reads both
the new runnings array and the legacy single running object, so existing
localStorage migrates on first read.

Behavior is unchanged: startActivity still refuses while any timer runs
and the banner still renders runnings[0]. Lifting that restriction is a
separate change."
```

---

### Task 2: バナーを行ベースの動的生成に変える（まだ1件のみ）

`#runningBanner` を空のコンテナにし、`runnings` の各要素に対応する `.rb-row` を JS が生成する構造に変える。**この時点でも同時計測は1件のみ**なので、見た目は Task 1 と変わらない。レビュー観点は「見た目と操作感が変わっていないか」。

**Files:**
- Modify: `index.html`（`#runningBanner` のマークアップ、バナー関連 CSS）
- Modify: `app.ts`（timer セクション、`disarmCancel` / `cancelActivity`、events セクション）

**Interfaces:**
- Consumes: Task 1 の `state.runnings`、`findRunning()`、`refreshRunning()`、`syncTimerLoop()`、`armedCancels`、`clearArmed()`、`elapsedMs()`、`fmtElapsed()`
- Produces:
  - `function renderBanner(): void` — 行を作り直す。`updateRunningBanner()` を置き換える
  - `function tickBanner(): void` — 毎秒、各行の `.rb-time` のテキストだけ更新する
  - 生成される DOM: `#runningBanner > .rb-row[data-id]`、その中に `.rb-name` / `.rb-time` / `.rb-actions > .rb-cancel, .rb-pause, .rb-stop`

- [ ] **Step 1: `index.html` のバナーのマークアップを空コンテナにする**

197-208行目付近の `#runningBanner` ブロックを置き換える。

```html
  <!-- 計測中の活動ごとに app.js が .rb-row を生成する -->
  <div id="runningBanner"></div>
```

- [ ] **Step 2: `index.html` のバナー CSS を行ベースに書き換える**

`/* running banner */` から `#runningBanner #pauseBtn.paused { ... }` までのブロック全体（85-116行目付近）を置き換える。

```css
  /* running banner */
  #runningBanner {
    display: none;
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(env(safe-area-inset-bottom) + 12px);
    width: min(608px, calc(100% - 32px));
    box-sizing: border-box;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius);
    /* パディングは行側が持つ。一時停止行が左右いっぱいに背景色を敷けるようにするため */
    padding: 0;
    overflow: hidden;
    flex-direction: column;
    align-items: stretch;
    box-shadow: 0 8px 28px rgba(0,0,0,.32);
    z-index: 40;
  }
  #runningBanner.show { display: flex; }
  .rb-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 18px;
  }
  .rb-row + .rb-row { border-top: 1px solid rgba(255,255,255,.22); }
  /* 一時停止中の行だけを暗くする。複数計測中に一時停止が混ざっても一目で見分けられるようにするため */
  .rb-row.paused { background: rgba(0,0,0,.22); }
  #runningBanner .rb-name { font-weight: 600; font-size: 16px; }
  #runningBanner .rb-time { font-size: 30px; font-variant-numeric: tabular-nums; letter-spacing: .02em; font-weight: 300; }
  #runningBanner button { background: rgba(255,255,255,.22); color: #fff; }
  .rb-actions { display: flex; align-items: center; gap: 8px; }
  /* 「やめる」は記録を残さない破棄なので、終了より控えめに従属させる */
  #runningBanner .rb-stop { background: #fff; color: var(--accent); font-weight: 600; }
  #runningBanner .rb-cancel { background: transparent; border: 1px solid rgba(255,255,255,.5); color: rgba(255,255,255,.92); font-size: 13px; padding: 8px 12px; }
  #runningBanner .rb-cancel.armed { background: #dc2626; border-color: #dc2626; color: #fff; font-weight: 600; }
  #runningBanner .rb-pause.paused { background: #fff; color: var(--accent); font-weight: 600; }
```

削除されるルール（意図的に消す）:
- `body.running { padding-bottom: calc(env(safe-area-inset-bottom) + 116px); }` — 行数で高さが変わるため固定値では足りない。JS が実測して設定する（Step 3）。
- `#runningBanner.paused { background: var(--sub); }` — バナー全体のグレー化は複数行では使えない。`.rb-row.paused` が代わりを務める。
- `#runningBanner .rb-actions` → `.rb-actions` に変更（`#runningBanner #stopBtn` 等の ID セレクタも `.rb-stop` 等のクラスに変更）。

- [ ] **Step 3: `app.ts` の `updateRunningBanner()` を `renderBanner()` + `tickBanner()` に分割する**

`updateRunningBanner()` の関数全体を次の2つで置き換える。`syncTimerLoop()` 内の `setInterval(updateRunningBanner, 1000)` を `setInterval(tickBanner, 1000)` に、`refreshRunning()` 内の `updateRunningBanner()` を `renderBanner(); tickBanner();` に変える。

```ts
// バナーの行を作り直す。開始・終了・やめる・一時停止・再開のたびに呼ぶ（毎秒は呼ばない）
function renderBanner(): void {
  const banner = $("#runningBanner");
  banner.innerHTML = "";
  const runnings = state.runnings;
  banner.classList.toggle("show", runnings.length > 0);

  for (const r of runnings) {
    const act = state.activities.find((a) => a.id === r.activityId);
    if (!act) continue;
    const armed = armedCancels.has(r.activityId);
    const row = document.createElement("div");
    row.className = "rb-row" + (r.paused ? " paused" : "");
    row.dataset.id = r.activityId;
    row.innerHTML = `
      <div>
        <div class="rb-name"></div>
        <div class="rb-time">00:00</div>
      </div>
      <div class="rb-actions">
        <button class="rb-cancel${armed ? " armed" : ""}">${armed ? "本当にやめる？" : "やめる"}</button>
        <button class="rb-pause${r.paused ? " paused" : ""}">${r.paused ? "再開" : "一時停止"}</button>
        <button class="rb-stop">終了</button>
      </div>
    `;
    $(".rb-name", row).textContent = act.name + (r.paused ? " を一時停止中" : " を計測中");
    $(".rb-cancel", row).onclick = () => cancelActivity(r.activityId);
    $(".rb-pause", row).onclick = () => {
      if (findRunning(r.activityId)?.paused) resumeActivity(r.activityId);
      else pauseActivity(r.activityId);
    };
    $(".rb-stop", row).onclick = () => stopActivity(r.activityId);
    banner.appendChild(row);
  }

  // バナーの高さは行数で変わるので、最後のカードが隠れない余白を実測して確保する
  document.body.style.paddingBottom = runnings.length
    ? `calc(env(safe-area-inset-bottom) + ${banner.offsetHeight + 28}px)`
    : "";
}

// 毎秒呼ばれる。各行の経過時間のテキストだけを更新し、DOM 構造やクラスには触らない。
// 行を作り直すと「本当にやめる？」の armed 表示やフォーカスが1秒で失われるため分けている
function tickBanner(): void {
  const rows = document.querySelectorAll<HTMLElement>("#runningBanner .rb-row");
  rows.forEach((row) => {
    const r = findRunning(row.dataset.id || "");
    if (!r) return;
    $(".rb-time", row).textContent = fmtElapsed(elapsedMs(r));
  });
}
```

`document.body.classList.add("running")` / `remove("running")` は削除する（対応する CSS ルールを Step 2 で消したため）。

- [ ] **Step 4: `disarmCancel` / `cancelActivity` の再描画呼び出しを差し替える**

`disarmCancel()` 内の `updateRunningBanner();` を `renderBanner();` に、`cancelActivity()` の armed 分岐内の `updateRunningBanner();` を `renderBanner();` に変える。

Task 1 Step 6 で `updateRunningBanner()` に足した armed 表示の復元コード（`const cancelBtn = ...` の4行）は、`renderBanner()` が Map から復元するようになったため不要。`updateRunningBanner()` ごと削除される。

- [ ] **Step 5: events セクションと `visibilitychange` を差し替える**

Task 1 Step 8 で書いた `#stopBtn` / `#cancelBtn` / `#pauseBtn` の `addEventListener` 3ブロックを**削除する**（ハンドラは `renderBanner()` が行ごとに結ぶ）。

`visibilitychange` を書き換える。

```ts
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tickBanner();
});
```

（行の構造は変わっていないので、時刻の更新だけでよい。）

- [ ] **Step 6: ビルドが通ることを確認する**

Run: `mise exec -- npm run build`
Expected: PASS（出力なし、終了コード0）。`updateRunningBanner` への参照が残っていればここでエラーになる。

- [ ] **Step 7: 見た目と操作感が Task 1 と同じであることを確認する**

`python3 -m http.server 8765` を起動し（Service Worker は Bypass for network）、コンソールで `localStorage.clear(); location.reload();` を実行してから確認する。

1. 「入浴」を追加して「開始」→ バナーの見た目（紫背景・名前・大きな時刻・やめる/一時停止/終了の3ボタン）が Task 1 と同じ。時刻が毎秒進む。
2. 一覧を下までスクロール → 最後のカードがバナーに隠れない。
3. 「一時停止」→ 行が暗くなり（紫の上に黒25%程度）「入浴 を一時停止中」になり、時刻が止まる。「再開」ボタンが白背景。
4. 「再開」→ 元に戻り時刻が進む。
5. 「やめる」を1回押す → 赤い「本当にやめる？」。**その状態のまま5秒待たずに数秒観察** → 毎秒の時刻更新で赤い表示が消えないこと（`renderBanner` / `tickBanner` 分割の要点）。
6. 「やめる」を1回押して赤くしたあと「一時停止」を押す → 行が暗くなっても「本当にやめる？」が維持されている。
7. 3秒放置 → 「やめる」に戻る。
8. 「やめる」2回で破棄、「終了」で記録。どちらも Task 1 と同じ toast と結果。
9. 計測中にリロード → 復元される。
10. 計測中に活動を削除 → バナーが消え、`document.body.style.paddingBottom` が空に戻る（コンソールで `document.body.style.paddingBottom` が `""` であること）。

Expected: 全て Task 1 と同じ振る舞い。5 と 6 は今回の分割で初めて成立する挙動。

- [ ] **Step 8: コミットする**

```bash
git add app.ts index.html
git commit -m "refactor: render the running banner as one row per timer

Turns #runningBanner into an empty container and generates a .rb-row per
entry in state.runnings, replacing the fixed-ID markup. Splits the old
updateRunningBanner into renderBanner (rebuilds rows on state change) and
tickBanner (rewrites only the elapsed text each second) so the two-step
cancel confirmation is no longer wiped once a second.

Paused styling moves from the whole banner to the individual row, and the
bottom padding that keeps the last card clear of the banner is now
measured from the banner's height instead of a fixed 116px.

Still one timer at a time; the banner just renders a list of one."
```

---

### Task 3: 同時計測の制約を外して出荷する

「他に計測中があれば開始できない」制約を「同じ活動が計測中なら開始できない」に緩め、複数行に耐える表示を整え、Service Worker の `CACHE` とバージョンをバンプする。レビュー観点は「入浴中に歯磨きを記録できるか」と「重複時間が両方にフル計上されるか」。

**Files:**
- Modify: `app.ts`（`startActivity` のガード、`render()` の開始ボタン、`renderBanner()` の `multi` クラス）
- Modify: `index.html`（`.multi` 用 CSS の追加）
- Modify: `sw.js:2`（`CACHE`）
- Modify: `package.json:3`（`version`）

**Interfaces:**
- Consumes: Task 1 の `findRunning()`、Task 2 の `renderBanner()`
- Produces: なし（最終タスク）

- [ ] **Step 1: `startActivity` のガードを活動単位にする**

```ts
function startActivity(id: string): void {
  if (findRunning(id)) { toast("この活動はすでに計測中です"); return; }
  const now = Date.now();
  state.runnings.push({ activityId: id, start: now, firstStart: now, accumulatedMs: 0, paused: false });
  save();
  refreshRunning();
  render();
}
```

（`if (state.runnings.length)` が `if (findRunning(id))` に、toast の文言が変わる。）

- [ ] **Step 2: 開始ボタンを活動単位の無効化にする**

`render()` 内の開始ボタンを書き換える。

```ts
    const startBtn = $<HTMLButtonElement>(".start", card);
    const isRunning = !!findRunning(act.id);
    startBtn.disabled = isRunning;
    startBtn.textContent = isRunning ? "計測中…" : "▶ 開始";
    startBtn.onclick = () => startActivity(act.id);
```

- [ ] **Step 3: `renderBanner()` に `multi` クラスを付ける**

`banner.classList.toggle("show", runnings.length > 0);` の直後に1行追加する。

```ts
  // 2件以上のときは行を詰めて縦に伸びすぎないようにする
  banner.classList.toggle("multi", runnings.length > 1);
```

- [ ] **Step 4: `index.html` に `.multi` の CSS を追加する**

`#runningBanner .rb-time { ... }` のルールの直後に追加する。

```css
  /* 2件以上を同時に計測しているときは、バナーが画面を覆わないよう行を詰める */
  #runningBanner.multi .rb-row { padding: 8px 18px; }
  #runningBanner.multi .rb-time { font-size: 22px; }
```

- [ ] **Step 5: ビルドが通ることを確認する**

Run: `mise exec -- npm run build`
Expected: PASS（出力なし、終了コード0）。

- [ ] **Step 6: 入れ子の計測が両方にフル計上されることを確認する**

`python3 -m http.server 8765` を起動し（Service Worker は Bypass for network）、コンソールで実行して2つの活動を用意する。

```js
localStorage.setItem("howlong.v1", JSON.stringify({
  activities: [
    { id: "aBath", name: "入浴", plannedMinutes: 30, records: [] },
    { id: "aTeeth", name: "歯磨き", plannedMinutes: null, records: [] }
  ],
  runnings: []
}));
location.reload();
```

次の順に操作する。

1. 「入浴」の「開始」を押す → バナーに1行。「入浴」カードのボタンが「計測中…」の無効表示になる。
2. 「歯磨き」の「開始」を押す → **拒否されずに** バナーが2行になる。時刻のフォントが小さくなる（`multi`）。両方の時刻が独立して進む。
3. 「歯磨き」の行の「終了」を押す → 歯磨きの行だけ消え、入浴の行は残って進み続ける。時刻のフォントが大きい表示に戻る。歯磨きの履歴に1分の記録が入り、「開始」ボタンが押せる状態に戻る。
4. 「入浴」の行の「終了」を押す → バナーが消え、入浴の履歴に記録が入る。
5. 両方の履歴を開いて確認する → 入浴の記録の分数から歯磨きの分が差し引かれていない（どちらも自分の計測時間そのまま）。

Expected: 「入浴中に歯磨きも記録する」が成立し、重複時間が両方にフル計上されている。

- [ ] **Step 7: 3件同時と一時停止の混在を確認する**

コンソールで実行する。

```js
localStorage.setItem("howlong.v1", JSON.stringify({
  activities: [
    { id: "aBath", name: "入浴", plannedMinutes: null, records: [] },
    { id: "aTeeth", name: "歯磨き", plannedMinutes: null, records: [] },
    { id: "aMusic", name: "音楽鑑賞", plannedMinutes: null, records: [] }
  ],
  runnings: []
}));
location.reload();
```

1. 3つすべてを「開始」→ バナーが3行になる。一覧を下までスクロールして最後のカードが隠れないことを確認する。
2. 真ん中の行の「一時停止」を押す → **その行だけ**が暗くなり時刻が止まり、他の2行は進み続ける。
3. 残る2行も「一時停止」する → 全行が暗くなり、`setInterval` が止まる（コンソールで確認: 数秒待って時刻表示が変わらない）。
4. 1行だけ「再開」→ その行の時刻が再び進む。
5. 1行目の「やめる」を1回押して赤くし、3行目の「終了」を押す → 1行目の「本当にやめる？」が維持されている。
6. リロード → 3件（一時停止状態を含む）すべてが復元される。
7. 計測中の活動を1つ削除 → その行だけ消え、他の計測は継続する。
8. 「取込」で JSON をインポート → 全ての計測が破棄され、バナーが消える。

Expected: 各行が完全に独立して動く。

- [ ] **Step 8: `sw.js` の `CACHE` と `package.json` の `version` をバンプする**

`sw.js:2`:

```js
const CACHE = "howlong-v5";
```

`package.json:3`:

```json
  "version": "1.3.0",
```

`app.ts`（→ `app.js`）と `index.html` の両方が変わっており、`app.js` は Service Worker の `ASSETS` に含まれないため cache-first で配信される。`CACHE` をバンプしないと、再訪ユーザーに新しい HTML と古い JS の組み合わせが届く（1.2.0 で一時停止ボタンが動かなかった原因と同じ事故）。

- [ ] **Step 9: Service Worker のバンプが効いていることを確認する**

DevTools の Bypass for network の**チェックを外し**、Application → Storage → Clear site data でリセットしたあとページを2回リロードする。Application → Cache Storage に `howlong-v5` だけが存在し、`howlong-v4` が残っていないことを確認する。そのうえで、Step 6 の1〜4の操作がもう一度成功することを確認する。

Expected: `howlong-v5` のみ。同時計測が動く。

- [ ] **Step 10: コミットする**

```bash
git add app.ts index.html sw.js package.json
git commit -m "feat: allow several activities to be timed at once

Starting an activity now only fails if that same activity is already
running, so a bath and the teeth-brushing that happens during it can be
timed independently and stopped in either order. Overlapping time counts
in full toward both activities, leaving the stats untouched.

Each card's start button reflects only its own timer, and the banner
tightens its rows once a second timer appears.

Bumps the service worker CACHE to howlong-v5 so returning visitors get
the new app.js instead of the cached one."
```

---

## 完了条件

- `mise exec -- npm run build` がエラー0で通る。
- 入浴を計測中に歯磨きの計測を開始でき、歯磨きを先に終了して入浴を後で終了でき、両方に自分の計測時間がフル計上される。
- 旧形式（`running` 単一オブジェクト）の localStorage が、実行中・一時停止中のどちらでも移行される。
- 3件同時計測でも最後のカードがバナーに隠れない。
- `sw.js` の `CACHE` が `howlong-v5`、`package.json` の `version` が `1.3.0`。
