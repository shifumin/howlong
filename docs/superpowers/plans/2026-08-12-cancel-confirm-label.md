# 破棄の確認ラベルを「破棄？」に縮める Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 計測中バナーの破棄確認ラベルを「本当にやめる？」から「破棄？」に縮め、320px 級の
端末でボタンが切れる問題を解消する。

**Architecture:** 変更は `app.ts` の文字列とコメントの2箇所のみ。「破棄？」は平常時の「やめる」と
同じ 3 文字・同じ 65px なので、ボタン幅が armed の前後で変わらず、CSS の追加指定は不要。

**Tech Stack:** 素の HTML + インライン CSS、TypeScript（`tsc` でビルド）。テストフレームワークは無い。

## Global Constraints

- **`app.js` は編集しない。** `app.ts` から `tsc` が生成し、git-ignore されている（`CLAUDE.md`）。
- **`index.html` は変更しない。** 今回は CSS を一切足さない設計である。
- **`sw.js` の `CACHE` はバンプしない。** `app.js` は network-first で配信されるため不要。
- **`package.json` の `version` を 1.3.4 → 1.3.5 に上げる。**
- **`docs/superpowers/` 配下の既存文書は変更しない。** 同じ文字列が出てくるが、当時の
  設計判断を記録した履歴文書である。
- コミットは Conventional Commits、英語。Node コマンドは `mise exec --` 経由。

---

### Task 1: 確認ラベルを「破棄？」にする

**Files:**
- Modify: `app.ts:214`（armed 時のラベル）
- Modify: `app.ts:236`（そのラベルを引用しているコメント）

**Interfaces:**
- Consumes: `#runningBanner .rb-cancel` / `.rb-cancel.armed` の CSS（`index.html`）。
  変更しないが、`font-size: 13px; padding: 8px 12px` がラベル幅を決めている。
- Produces: なし。

**ラベルとコメントを1タスクにまとめる理由:** コメントは同じラベル文字列を引用している。
片方だけ変えるとコメントが実物と食い違う嘘になるため、分割しない。

- [ ] **Step 1: armed 時のラベルを差し替える**

`app.ts:214` を置き換える。

変更前:

```ts
        <button class="rb-cancel${armed ? " armed" : ""}">${armed ? "本当にやめる？" : "やめる"}</button>
```

変更後:

```ts
        <button class="rb-cancel${armed ? " armed" : ""}">${armed ? "破棄？" : "やめる"}</button>
```

「破棄？」は3文字で、平常時の「やめる」と同じ 65px にレンダリングされる（実測値）。
4文字にするとボタン幅が 78px に広がり、押した瞬間に隣のボタンがずれるため、
文字数を増やしてはならない。

- [ ] **Step 2: ラベルを引用しているコメントを直す**

`app.ts:236` を置き換える。

変更前:

```ts
// 行を作り直すと「本当にやめる？」の armed 表示やフォーカスが1秒で失われるため分けている
```

変更後:

```ts
// 行を作り直すと「破棄？」の armed 表示やフォーカスが1秒で失われるため分けている
```

- [ ] **Step 3: ライブのソースに古いラベルが残っていないことを確認する**

Run:

```bash
grep -rn "本当にやめる" app.ts index.html sw.js
```

Expected: 一致なし（終了コード 1）。`docs/` 配下には残るが、それは履歴文書なので正しい。

- [ ] **Step 4: TypeScript のビルドが通ることを確認する**

Run: `mise exec -- npm run build`
Expected: エラー出力なし、終了コード 0。

- [ ] **Step 5: ローカルサーバーを起動する**

バックグラウンドで起動する:

```bash
cd /Users/shifumin/ghq/github.com/shifumin/howlong && python3 -m http.server 8765
```

ブラウザで `http://localhost:8765/` を開く。

**注意:** この origin には過去の Service Worker が残っていて、古い `index.html` を
配ることがある（1.3.4 の検証で実際に遭遇した）。開いたら最初に次を実行して、
SW とキャッシュを消してからリロードすること。

```js
const regs = await navigator.serviceWorker.getRegistrations();
for (const r of regs) await r.unregister();
for (const k of await caches.keys()) await caches.delete(k);
```

また、`localStorage` の `howlong.v1` には利用者の実データが入っている。テストデータで
上書きする場合は、事前に `localStorage.getItem('howlong.v1')` の値を控え、検証後に必ず戻すこと。

- [ ] **Step 6: 溢れが解消したことを実測する**

ブラウザのコンソールで次を実行する。バナー幅 288px は 320px 端末相当。

**重要:** `.rb-cancel` の `click()` は `cancelActivity()` → `renderBanner()` を呼び、
`banner.innerHTML = ""` で行を作り直す。クリック前に取得した要素参照は DOM から外れ、
`getBoundingClientRect()` がすべて 0 を返すようになる。**押した後は必ず要素を取り直すこと。**

```js
const banner = document.querySelector('#runningBanner');
banner.style.width = '288px';
// 押す前の実測
const widthBefore = Math.round(document.querySelector('.rb-row .rb-cancel').getBoundingClientRect().width);
const labelBefore = document.querySelector('.rb-row .rb-cancel').textContent;
document.querySelector('.rb-row .rb-cancel').click();   // 1回だけ = armed
await new Promise(r => setTimeout(r, 150));
// 行が作り直されているので、ここから取り直す
const acts = document.querySelector('.rb-row .rb-actions');
const cancel = acts.querySelector('.rb-cancel');
const btns = [...acts.querySelectorAll('button')];
const aR = acts.getBoundingClientRect();
const total = btns.reduce((s,b)=>s+b.getBoundingClientRect().width,0) + 8*(btns.length-1);
console.log(JSON.stringify({
  labelBefore,
  labelArmed: cancel.textContent,
  widthBefore,
  widthArmed: Math.round(cancel.getBoundingClientRect().width),
  total: Math.round(total),
  available: Math.round(aR.width),
  overflowPx: Math.round(total) - Math.round(aR.width),
  clipped: btns.map(b => {
    const r = b.getBoundingClientRect();
    return Math.round(Math.max(0, aR.left - r.left) + Math.max(0, r.right - aR.right));
  })
}, null, 2));
banner.style.width = '';
```

`click()` から測定完了までは 3 秒以内に収めること。3 秒で armed が自動解除される。

Expected:
- `label` が `"破棄？"`
- `widthBefore` と `widthArmed` が**同じ値**（65 前後）— 押しても幅が動かない
- `total` が 227 前後、`available` が 252、`overflowPx` が**負の値**（溢れなし）
- `clipped` が `[0, 0, 0]` — どのボタンも切れていない

- [ ] **Step 7: armed が毎秒の更新で消えないことを確認する**

「やめる」を1回押して赤い「破棄？」にしたあと、**そのまま数秒観察する**。
Expected: 時刻が毎秒更新されても赤い「破棄？」の表示が維持される
（`renderBanner` と `tickBanner` を分けている理由そのもの）。

- [ ] **Step 8: 3秒で自動解除されることを確認する**

「やめる」を1回押してから 3 秒以上待つ。
Expected: ラベルが「やめる」に戻り、赤色が解除される。

- [ ] **Step 9: 実際に破棄できることを確認する**

「やめる」を押して赤い「破棄？」になった状態で、もう一度押す。
Expected: その行がバナーから消え、活動カードの「履歴」件数が増えていない
（記録が残らない＝破棄されている）。

- [ ] **Step 10: 後片付けとコミット**

`localStorage` を検証前の値に戻し、サーバーを停止する。そのうえでコミットする。

```bash
git add app.ts
git commit -m "fix: shorten the discard confirmation to 破棄？ so it fits narrow screens

At 320px the armed label 本当にやめる？ needed 278px of button row where only
252px existed, and the banner's overflow:hidden sliced 26px off its left edge —
mangling the confirmation for an irreversible action. 破棄？ is three characters,
the same rendered width as やめる, so the row fits with room to spare and the
button no longer changes size when it arms."
```

---

### Task 2: リリース版数を上げる

**Files:**
- Modify: `package.json:3`

**Interfaces:**
- Consumes: Task 1 のコミット。
- Produces: なし。

**Task 1 と分ける理由:** 版数を上げて `main` に push した時点で
`.github/workflows/release.yml` が `v1.3.5` タグとリリースを作る。つまりこのコミットは
リリース操作そのものであり、Task 1 の検証が通ってから行う。

- [ ] **Step 1: `version` を 1.3.5 にする**

`package.json:3` を置き換える。

変更前:

```json
  "version": "1.3.4",
```

変更後:

```json
  "version": "1.3.5",
```

- [ ] **Step 2: 版数以外が変わっていないことを確認する**

Run: `git diff package.json`
Expected: `-  "version": "1.3.4",` と `+  "version": "1.3.5",` の1行だけの差分。

- [ ] **Step 3: コミット**

```bash
git add package.json
git commit -m "chore: bump version to 1.3.5"
```

- [ ] **Step 4: push は利用者に確認する**

`main` への push はリリースを発行する。push するかどうかは利用者に確認してから行う。

---

## 変更しないもの

| ファイル | 理由 |
|----------|------|
| `index.html` | ラベルが平常時と同じ幅なので CSS の追加指定が要らない |
| `app.js` | 生成物。git-ignore されている |
| `sw.js` | `app.js` は network-first。`CACHE` バンプ不要 |
| `docs/superpowers/**` | 当時の設計判断を記録した履歴文書 |
