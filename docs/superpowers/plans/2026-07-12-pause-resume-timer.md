# 計測の一時停止・再開機能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 計測中のアクティビティを一時停止・再開できるようにし、一時停止していた時間は記録される合計時間から除外する。

**Architecture:** `Running` に `paused` フラグと `accumulatedMs`（一時停止を跨いだ実働時間の累計）、`firstStart`（履歴表示用の最初の開始時刻）を追加する。経過時間は常に `elapsedMs(running)` という単一のヘルパー関数で計算し、バナー表示・記録時の分計算の両方がこれを参照することで二重実装を避ける。UI側は既存の「やめる」「終了」ボタンの間に「一時停止」ボタンを1つ追加し、一時停止中はラベルが「再開」に切り替わるトグル式にする。

**Tech Stack:** TypeScript (`app.ts` → `tsc` → `app.js`)、素の HTML/CSS（フレームワークなし）。このプロジェクトに自動テストの仕組みは無いため、各タスクの検証は (1) `tsc` によるコンパイルチェック、(2) ローカルサーバー + ブラウザでの手動確認、の2段階で行う。`app.js` は生成物なので **`app.ts` 以外は直接編集しない**。

## Global Constraints

- 編集するのは `app.ts` のみ。`app.js` は `tsc` の生成物で git-ignore 対象なので直接編集しない。
- TypeScript は `strict: true`（`tsconfig.json`）。各タスクの最後に `mise exec -- npm run build` がエラーなく通ることを確認する。
- 全ての時間の値は分単位で、記録される分は常に最低1分（`Math.max(1, Math.round(...))`）。この不変条件を一時停止機能でも維持する。
- Node/TypeScript コマンドは `mise exec --` 経由で実行する（例: `mise exec -- npm run build`）。
- コミットメッセージは Conventional Commits 形式・英語。

---

### Task 1: `Running` のデータモデル拡張と後方互換ロード

**Files:**
- Modify: `app.ts`（`interface Running` 定義部、`load()`、`startActivity()`、`/* ---------- timer ---------- */` セクション）

**Interfaces:**
- Produces:
  - `interface Running { activityId: string; start: number; firstStart: number; accumulatedMs: number; paused: boolean; }`
  - `function elapsedMs(running: Running): number` — 一時停止時間を除いた実働の経過時間(ms)を返す
  - `function normalizeRunning(r: Partial<Running> | null | undefined): Running | null` — 旧形式の `running` データを補完する

- [ ] **Step 1: `Running` 型に一時停止用のフィールドを追加する**

`app.ts` の `interface Running` を以下に置き換える。

現在のコード:
```ts
// 計測中の状態
interface Running {
  activityId: string;
  start: number;
}
```

新しいコード:
```ts
// 計測中の状態
interface Running {
  activityId: string;
  start: number;         // 現在の計測セグメントの開始時刻(ms)。一時停止からの再開のたびに更新される
  firstStart: number;    // 計測を最初に開始した時刻(ms)。記録の開始日時表示に使う（再開しても変わらない）
  accumulatedMs: number;  // これまでに実行済みだった時間の合計(ms)
  paused: boolean;        // 一時停止中かどうか
}
```

- [ ] **Step 2: 旧データを補完する `normalizeRunning()` を追加し、`load()` から使う**

`app.ts` の `load()` を以下に置き換える（`normalizeRunning` を直前に新規追加する）。

現在のコード:
```ts
function load(): DB {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { activities?: unknown; running?: Running | null };
      if (parsed && Array.isArray(parsed.activities)) {
        // 古いデータに running が無くても null で補う
        return { activities: parsed.activities as Activity[], running: parsed.running ?? null };
      }
    }
  } catch (e) { /* fall through to default */ }
  return { activities: [], running: null };
}
```

新しいコード:
```ts
// 旧バージョンの localStorage データ（accumulatedMs/paused/firstStart が無い running）を補完する
function normalizeRunning(r: Partial<Running> | null | undefined): Running | null {
  if (!r || typeof r.activityId !== "string" || typeof r.start !== "number") return null;
  return {
    activityId: r.activityId,
    start: r.start,
    firstStart: typeof r.firstStart === "number" ? r.firstStart : r.start,
    accumulatedMs: typeof r.accumulatedMs === "number" ? r.accumulatedMs : 0,
    paused: typeof r.paused === "boolean" ? r.paused : false,
  };
}

function load(): DB {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { activities?: unknown; running?: Partial<Running> | null };
      if (parsed && Array.isArray(parsed.activities)) {
        // 古いデータに running が無くても null で補う
        return { activities: parsed.activities as Activity[], running: normalizeRunning(parsed.running) };
      }
    }
  } catch (e) { /* fall through to default */ }
  return { activities: [], running: null };
}
```

- [ ] **Step 3: 経過時間を計算する `elapsedMs()` ヘルパーを追加する**

`app.ts` の `/* ---------- timer ---------- */` セクション、`stopTimerLoop()` の直後に追加する。

現在のコード:
```ts
function stopTimerLoop(): void {
  if (tick) { clearInterval(tick); tick = null; }
}
function updateRunningBanner(): void {
```

新しいコード:
```ts
function stopTimerLoop(): void {
  if (tick) { clearInterval(tick); tick = null; }
}
// 一時停止時間を除いた実働の経過時間(ms)を返す
function elapsedMs(running: Running): number {
  return running.paused ? running.accumulatedMs : running.accumulatedMs + (Date.now() - running.start);
}
function updateRunningBanner(): void {
```

- [ ] **Step 4: `startActivity()` で新フィールドを初期化する**

現在のコード:
```ts
function startActivity(id: string): void {
  if (state.running) { toast("計測中の活動があります"); return; }
  state.running = { activityId: id, start: Date.now() };
  save();
  startTimerLoop();
}
```

新しいコード:
```ts
function startActivity(id: string): void {
  if (state.running) { toast("計測中の活動があります"); return; }
  const now = Date.now();
  state.running = { activityId: id, start: now, firstStart: now, accumulatedMs: 0, paused: false };
  save();
  startTimerLoop();
}
```

- [ ] **Step 5: ビルドを実行してエラーが無いことを確認する**

Run: `mise exec -- npm run build`
Expected: エラー無く終了し、`app.js` が更新される。

- [ ] **Step 6: ブラウザで手動確認する（新規開始時のフィールド）**

```bash
cd /Users/shifumin/ghq/github.com/shifumin/howlong && python3 -m http.server 8080
```

ブラウザで `http://localhost:8080/` を開き、以下を確認する。

1. 入力欄に「テスト」と入力してアクティビティを追加する。
2. 「▶ 開始」をクリックする。
3. devtools のコンソールで次を実行する:
   ```js
   JSON.parse(localStorage.getItem('howlong.v1')).running
   ```
4. `{ activityId: "...", start: <number>, firstStart: <number>, accumulatedMs: 0, paused: false }` の形で、`start === firstStart` になっていることを確認する。

- [ ] **Step 7: 旧形式データの後方互換を手動確認する**

同じブラウザのコンソールで続けて実行する。

```js
const raw = JSON.parse(localStorage.getItem('howlong.v1'));
raw.running = { activityId: raw.running.activityId, start: raw.running.start }; // 旧形式（accumulatedMs/paused/firstStart 無し）
localStorage.setItem('howlong.v1', JSON.stringify(raw));
location.reload();
```

リロード後、再度コンソールで `JSON.parse(localStorage.getItem('howlong.v1')).running` を実行し、`accumulatedMs: 0`, `paused: false`, `firstStart` が `start` と同じ値で補完されていること（エラーなく起動すること）を確認する。確認後、バナーの「終了」をクリックしてテストデータの計測を終わらせておく（活動自体は次タスクの確認でも使うので残してよい）。

- [ ] **Step 8: コミットする**

```bash
git add app.ts
git commit -m "$(cat <<'EOF'
feat: extend Running data model for pause/resume

Add paused/accumulatedMs/firstStart fields with backward-compatible
loading, and an elapsedMs() helper that computes active time excluding
paused duration.
EOF
)"
```

---

### Task 2: 一時停止・再開の挙動とUI

**Files:**
- Modify: `index.html`（`#runningBanner` 内のボタン、対応するCSS）
- Modify: `app.ts`（`pauseActivity()`/`resumeActivity()` の新設、`stopActivity()`、`updateRunningBanner()`、ブート処理、イベント登録）

**Interfaces:**
- Consumes: Task 1 の `interface Running { activityId, start, firstStart, accumulatedMs, paused }` と `function elapsedMs(running: Running): number`
- Produces: `function pauseActivity(): void`, `function resumeActivity(): void`（UIの `#pauseBtn` クリックから呼ばれる）

- [ ] **Step 1: `index.html` に一時停止ボタンを追加する**

`index.html` の `#runningBanner` 内、`やめる` と `終了` の間に追加する。

現在のコード:
```html
    <div class="rb-actions">
      <button id="cancelBtn">やめる</button>
      <button id="stopBtn">終了</button>
    </div>
```

新しいコード:
```html
    <div class="rb-actions">
      <button id="cancelBtn">やめる</button>
      <button id="pauseBtn">一時停止</button>
      <button id="stopBtn">終了</button>
    </div>
```

- [ ] **Step 2: 一時停止中のバナー・ボタンのCSSを追加する**

`index.html` の `<style>` 内、`#runningBanner #cancelBtn.armed { ... }` の直後に追加する。

現在のコード:
```css
  #runningBanner #cancelBtn.armed { background: #dc2626; border-color: #dc2626; color: #fff; font-weight: 600; }
```

新しいコード:
```css
  #runningBanner #cancelBtn.armed { background: #dc2626; border-color: #dc2626; color: #fff; font-weight: 600; }
  /* 一時停止中はバナー全体をグレー系にして一目で分かるようにする */
  #runningBanner.paused { background: var(--sub); }
  #runningBanner #pauseBtn.paused { background: #fff; color: var(--accent); font-weight: 600; }
```

- [ ] **Step 3: `pauseActivity()` / `resumeActivity()` を追加する**

`app.ts` の `startActivity()` の直後、`stopActivity()` の直前に追加する。

現在のコード:
```ts
function startActivity(id: string): void {
  if (state.running) { toast("計測中の活動があります"); return; }
  const now = Date.now();
  state.running = { activityId: id, start: now, firstStart: now, accumulatedMs: 0, paused: false };
  save();
  startTimerLoop();
}
function stopActivity(): void {
```

新しいコード:
```ts
function startActivity(id: string): void {
  if (state.running) { toast("計測中の活動があります"); return; }
  const now = Date.now();
  state.running = { activityId: id, start: now, firstStart: now, accumulatedMs: 0, paused: false };
  save();
  startTimerLoop();
}
function pauseActivity(): void {
  const running = state.running;
  if (!running || running.paused) return;
  running.accumulatedMs += Date.now() - running.start;
  running.paused = true;
  save();
  stopTimerLoop();
  updateRunningBanner();
}
function resumeActivity(): void {
  const running = state.running;
  if (!running || !running.paused) return;
  running.start = Date.now();
  running.paused = false;
  save();
  startTimerLoop();
}
function stopActivity(): void {
```

- [ ] **Step 4: `stopActivity()` の分計算を `elapsedMs()` ベースに変更する**

現在のコード:
```ts
function stopActivity(): void {
  const running = state.running;
  if (!running) return;
  disarmCancel();
  const act = state.activities.find((a) => a.id === running.activityId);
  const startMs = running.start;
  const endMs = Date.now();
  state.running = null;
  if (act) {
    const minutes = Math.max(1, Math.round((endMs - startMs) / 60000));
    act.records.push({ start: toLocalMinuteISO(startMs), end: toLocalMinuteISO(endMs), minutes });
  }
  save();
  stopTimerLoop();
  updateRunningBanner();
  render();
  if (act) toast("記録しました");
}
```

新しいコード:
```ts
function stopActivity(): void {
  const running = state.running;
  if (!running) return;
  disarmCancel();
  const act = state.activities.find((a) => a.id === running.activityId);
  const startMs = running.firstStart;
  const endMs = Date.now();
  const minutes = Math.max(1, Math.round(elapsedMs(running) / 60000));
  state.running = null;
  if (act) {
    act.records.push({ start: toLocalMinuteISO(startMs), end: toLocalMinuteISO(endMs), minutes });
  }
  save();
  stopTimerLoop();
  updateRunningBanner();
  render();
  if (act) toast("記録しました");
}
```

- [ ] **Step 5: `updateRunningBanner()` を一時停止表示に対応させる**

現在のコード:
```ts
function updateRunningBanner(): void {
  const banner = $("#runningBanner");
  const running = state.running;
  if (!running) {
    banner.classList.remove("show");
    document.body.classList.remove("running");
    stopTimerLoop();
    return;
  }
  const act = state.activities.find((a) => a.id === running.activityId);
  if (!act) { state.running = null; save(); banner.classList.remove("show"); document.body.classList.remove("running"); stopTimerLoop(); return; }
  banner.classList.add("show");
  document.body.classList.add("running");
  $("#rbName").textContent = act.name + " を計測中";
  const sec = Math.max(0, Math.floor((Date.now() - running.start) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  $("#rbTime").textContent = h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
```

新しいコード:
```ts
function updateRunningBanner(): void {
  const banner = $("#runningBanner");
  const running = state.running;
  if (!running) {
    banner.classList.remove("show");
    banner.classList.remove("paused");
    document.body.classList.remove("running");
    stopTimerLoop();
    return;
  }
  const act = state.activities.find((a) => a.id === running.activityId);
  if (!act) { state.running = null; save(); banner.classList.remove("show"); banner.classList.remove("paused"); document.body.classList.remove("running"); stopTimerLoop(); return; }
  banner.classList.add("show");
  document.body.classList.add("running");
  banner.classList.toggle("paused", running.paused);
  $("#rbName").textContent = act.name + (running.paused ? " を一時停止中" : " を計測中");
  const pauseBtn = $<HTMLButtonElement>("#pauseBtn");
  pauseBtn.textContent = running.paused ? "再開" : "一時停止";
  pauseBtn.classList.toggle("paused", running.paused);
  const sec = Math.max(0, Math.floor(elapsedMs(running) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  $("#rbTime").textContent = h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
```

- [ ] **Step 6: ブート処理を一時停止状態に対応させる**

現在のコード:
```ts
/* ---------- boot ---------- */
render();
if (state.running) startTimerLoop();
```

新しいコード:
```ts
/* ---------- boot ---------- */
render();
if (state.running) {
  if (state.running.paused) updateRunningBanner();
  else startTimerLoop();
}
```

- [ ] **Step 7: `#pauseBtn` のクリックイベントを登録する**

現在のコード:
```ts
$("#stopBtn").addEventListener("click", stopActivity);
$("#cancelBtn").addEventListener("click", cancelActivity);
```

新しいコード:
```ts
$("#stopBtn").addEventListener("click", stopActivity);
$("#cancelBtn").addEventListener("click", cancelActivity);
$("#pauseBtn").addEventListener("click", () => {
  if (state.running?.paused) resumeActivity(); else pauseActivity();
});
```

- [ ] **Step 8: ビルドを実行してエラーが無いことを確認する**

Run: `mise exec -- npm run build`
Expected: エラー無く終了し、`app.js` が更新される。

- [ ] **Step 9: ブラウザで一連の操作を手動確認する**

```bash
cd /Users/shifumin/ghq/github.com/shifumin/howlong && python3 -m http.server 8080
```

ブラウザで `http://localhost:8080/` を開き（既存データが残っていれば一旦 devtools コンソールで `localStorage.removeItem('howlong.v1')` してリロードしてもよい）、以下を確認する。

1. 「テスト」という名前でアクティビティを追加する。
2. 「▶ 開始」をクリックする。バナーに「テスト を計測中」、`やめる` / `一時停止` / `終了` の3ボタンが表示されることを確認する。
3. 5秒ほど待ってから「一時停止」をクリックする。
   - バナーの背景色がグレー系に変わること
   - テキストが「テスト を一時停止中」になること
   - 真ん中のボタンが白背景の「再開」になること
   - 経過時間の表示がその時点で止まること
4. 一時停止のまま5秒ほど待ち、経過時間の表示が増えていないことを確認する。もう1つ別名でアクティビティ（例:「テスト2」）を追加し、その「▶ 開始」ボタンが（一時停止中でも）無効のままであることを確認する。
5. 「再開」をクリックする。バナーが元のアクセントカラーに戻り、テキストが「テスト を計測中」に戻り、経過時間のカウントが一時停止前の値から再開することを確認する。
6. 「終了」をクリックする。「記録しました」のトーストが出ることを確認する。
7. 「テスト」カードの「履歴」を開き、記録された分数が一時停止していた時間を除いた実働時間（おおよそ手順2〜6の合計待機時間から一時停止中の待機時間を除いたもの、最低1分）になっていること、開始日時が手順2で開始した時刻（再開した時刻ではない）になっていることを確認する。
8. 再度「開始」→「一時停止」まで行い、ページをリロードする。リロード後もバナーが「〜を一時停止中」のグレー表示のまま復元され、時間が飛んでいないことを確認する。「やめる」で後始末する。

- [ ] **Step 10: コミットする**

```bash
git add app.ts index.html
git commit -m "$(cat <<'EOF'
feat: add pause/resume for the running timer

Add a pause button between "やめる" and "終了" in the running banner.
Paused time is excluded from the recorded minutes, and the paused
state persists across reloads via localStorage.
EOF
)"
```
