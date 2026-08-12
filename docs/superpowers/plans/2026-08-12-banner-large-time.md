# 計測中バナーの時刻表示を拡大する Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 計測中バナーの各行を縦積みレイアウトに統一し、経過時刻を 44px で大きく表示する。

**Architecture:** 変更は `index.html` のインライン CSS のみ。行の HTML 構造（`.rb-head` の中に
`.rb-name` と `.rb-time` が並ぶ）は既に縦積みに適した形で、`app.ts` が生成するマークアップは
一切変えない。画面幅による分岐（`@media (max-width: 560px)`）を廃止し、どの幅でも同じ形にする。

**Tech Stack:** 素の HTML + インライン CSS、TypeScript（`tsc` でビルド）。テストフレームワークは無い。

## Global Constraints

- **`app.js` は編集しない。** `app.ts` から `tsc` が生成し、git-ignore されている（`CLAUDE.md`）。
  今回は `app.ts` も変更しない。
- **`sw.js` の `CACHE` はバンプしない。** `index.html` は network-first で配信されるため不要
  （`CLAUDE.md` のキャッシュ戦略表）。
- **ユーザーに見える変更なので `package.json` の `version` を上げる。** 1.3.3 → 1.3.4。
- コミットは Conventional Commits、英語（グローバル `CLAUDE.md`）。
- Node コマンドは `mise exec --` 経由で実行する。

---

### Task 1: バナー行を縦積みレイアウトにして時刻を 44px にする

**Files:**
- Modify: `index.html:106-140`（バナーの CSS ブロック）

**Interfaces:**
- Consumes: `app.ts:208-218` が生成する行のマークアップ。
  `.rb-row > (.rb-head > .rb-name, .rb-time), .rb-actions > (button.rb-cancel, button.rb-pause, button.rb-stop)`
  という構造に依存する。この構造自体は変更しない。
- Produces: なし（CSS のみ。後続タスクは版数を上げるだけ）。

**この変更を1タスクにまとめる理由:** CSS の書き換えを分割すると中間状態でレイアウトが壊れる。
例えばメディアクエリだけ先に削除すると、狭い画面で名前・時刻・ボタン3つが横1行に並んで
はみ出す。レビュアーが部分的に受け入れられる切れ目が無いため、まとめて1タスクとする。

- [ ] **Step 1: 変更前の見た目を記録する**

ローカルサーバーを起動する（`&` を付けてバックグラウンド実行）:

```bash
cd /Users/shifumin/ghq/github.com/shifumin/howlong && python3 -m http.server 8765
```

ブラウザで `http://localhost:8765/` を開き、活動を1件開始して現在のバナーを確認しておく。
比較のための基準であり、スクリーンショットを残せるなら残す。

- [ ] **Step 2: `.rb-row` を縦積みにする**

`index.html:106-112` を置き換える。

変更前:

```css
  .rb-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 18px;
  }
```

変更後:

```css
  /* 行は常に縦積み。名前を小さなラベルとして上に置き、その下に時刻を大きく出し、
     ボタンを最下段に並べる。画面幅で構造を変えないので、どの幅でも同じ形になる */
  .rb-row {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 12px 18px;
  }
```

`align-items: center` は縦方向になると横中央寄せになってしまうので `stretch` に変える。
`justify-content: space-between` は高さが内容で決まる縦積みでは効かないため削除する。

- [ ] **Step 3: `.rb-head` の `min-width: 0` とそのコメントを削除する**

`index.html:116-118` の以下3行をまるごと削除する。

```css
  /* 名前が長い行に押されてボタンが縮まないようにする。縮ませると縮み幅が名前の
     長さで変わり、行ごとにボタンの寸法が変わってしまう（カード側の .head-actions と同じ理由） */
  .rb-head { min-width: 0; }
```

削除する理由: この指定は名前とボタンが横1行に並んでいたときに、長い名前がボタンを押し潰すのを
防ぐためのものだった。縦積みでは名前とボタンが別の行になり、`align-items: stretch` で
`.rb-head` は常に全幅を取るので、`min-width: 0` は何もしない no-op になる。理由が消えた指定を
コメントごと残すと、次に読む人が誤った前提を引き継いでしまう。

`.rb-head` に CSS ルールが1つも無くなるが、`app.ts` が生成する名前と時刻をまとめるための
`div` としてマークアップ側には残る。中身の `.rb-name` と `.rb-time` はどちらも `div` なので、
素のブロック要素として上下に積まれる。

- [ ] **Step 4: 名前を控えめなラベルに、時刻を 44px にする**

`index.html:119-120`（Step 3 の削除により行番号は 2 つ前にずれている）を置き換える。

変更前:

```css
  #runningBanner .rb-name { font-weight: 600; font-size: 16px; }
  #runningBanner .rb-time { font-size: 30px; font-variant-numeric: tabular-nums; letter-spacing: .02em; font-weight: 300; }
```

変更後:

```css
  /* 時刻に視線を集めるため、名前は一段小さく暗いラベルとして時刻に従属させる */
  #runningBanner .rb-name { font-weight: 600; font-size: 14px; color: rgba(255,255,255,.82); }
  /* line-height は body の 1.5 のままだと 44px の行が 66px を占めてバナーが伸びすぎる */
  #runningBanner .rb-time { font-size: 44px; line-height: 1.1; font-variant-numeric: tabular-nums; letter-spacing: .02em; font-weight: 300; }
```

`font-variant-numeric: tabular-nums`（桁が動かない）と `font-weight: 300` は仕様どおり維持する。

- [ ] **Step 5: `multi` モードの時刻縮小ルールを削除する**

`index.html:121-123` 付近を置き換える。

変更前:

```css
  /* 2件以上を同時に計測しているときは、バナーが画面を覆わないよう行を詰める */
  #runningBanner.multi .rb-row { padding: 8px 18px; }
  #runningBanner.multi .rb-time { font-size: 22px; }
```

変更後:

```css
  /* 2件以上を同時に計測しているときは、バナーが画面を覆わないよう行を詰める。
     時刻の大きさは視認性を優先して据え置く */
  #runningBanner.multi .rb-row { padding: 8px 18px; }
```

`padding` を詰めるルールは残し、`font-size: 22px` の行だけを消す。

- [ ] **Step 6: `.rb-actions` を右寄せにする**

`index.html:125` 付近を置き換える。

変更前:

```css
  .rb-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
```

変更後:

```css
  .rb-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-shrink: 0; }
```

これまでメディアクエリの中だけで指定していた右寄せを、全幅共通の指定に引き上げる。

- [ ] **Step 7: `@media (max-width: 560px)` のバナー用ブロックを削除する**

`index.html:134-140` の以下7行をまるごと削除する。

```css
  /* 狭い画面ではボタン3つと名前を1行に並べる幅が無い。ボタンを下段に回し、
     名前と時刻を同じ行に並べて、どの行も同じ形・同じボタン寸法になるようにする */
  @media (max-width: 560px) {
    .rb-row { flex-direction: column; align-items: stretch; gap: 8px; }
    .rb-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .rb-actions { justify-content: flex-end; }
  }
```

3つの指定はすべて Step 2・Step 6 で全幅共通に移したか、縦積みでは不要になった
（`.rb-head` を横並びにする指定は、名前の下に時刻を置くという今回の目的と正面から衝突する）。
このメディアクエリはバナー用のルールしか含んでいないので、ブロックごと消える。

- [ ] **Step 8: TypeScript のビルドが通ることを確認する**

Run: `mise exec -- npm run build`
Expected: エラー出力なし、終了コード 0。`app.ts` は変更していないので通って当然だが、
作業中に誤って触っていないことの確認になる。

- [ ] **Step 9: ブラウザで4パターンを目視確認する**

Step 1 のサーバーが動いている状態で `http://localhost:8765/` を開き、**モバイル幅
（DevTools で 390px 程度）とデスクトップ幅（900px 程度）の両方**で次を確認する。
ページを開く前に、Service Worker のキャッシュを避けるため DevTools の
Application → Service Workers で "Update on reload" を有効にするか、ハードリロードする。

1. **単独計測**: 活動を1件開始する。名前ラベル（小さい）の下に大きな時刻、その下に
   「やめる」「一時停止」「終了」が右寄せで並ぶ。時刻が毎秒更新される。
2. **2件同時計測**: もう1件開始する。両方の行が同じ大きさの時刻で表示され、行間が
   単独時より詰まる。バナーが画面を覆い尽くしていない。最下部の活動カードが
   バナーに隠れていない（`renderBanner()` が余白を実測して確保する）。
3. **一時停止の混在**: 片方を「一時停止」にする。その行だけ背景が暗くなり
   （`.rb-row.paused`）、名前が「〜を一時停止中」に変わる。もう片方は動き続ける。
4. **長い活動名**: 30文字以上の名前（例:「あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ」）で
   活動を追加して開始する。名前が折り返しても時刻の大きさとボタンの寸法が変わらない。

あわせて「やめる」を1回押して「本当にやめる？」の確認表示になること（毎秒の更新で
消えないこと）も確認する。

確認が終わったらサーバーを止める。

- [ ] **Step 10: コミット**

```bash
git add index.html
git commit -m "feat: stack the running banner rows and show the time at 44px

The elapsed time is the one thing worth reading at a glance, but it sat on
the same line as the activity name at 30px, and shrank to 22px whenever two
timers ran at once. Stack every row instead: a small name label, the time
underneath at 44px, then the buttons. The layout no longer changes with the
viewport, so the 560px media query goes away with it."
```

---

### Task 2: リリース版数を上げる

**Files:**
- Modify: `package.json:3`

**Interfaces:**
- Consumes: Task 1 のコミットが `main` に載っていること。
- Produces: なし。

**Task 1 と分ける理由:** 版数を上げて `main` に push した時点で
`.github/workflows/release.yml` が `v1.3.4` タグとリリースを作る（`CLAUDE.md`）。
つまりこのコミットはリリース操作そのものであり、Task 1 の目視確認が通ってから
初めて行う。確認で問題が見つかった場合、版数を上げずに Task 1 をやり直せる。

- [ ] **Step 1: `version` を 1.3.4 にする**

`package.json:3` を置き換える。

変更前:

```json
  "version": "1.3.3",
```

変更後:

```json
  "version": "1.3.4",
```

- [ ] **Step 2: 版数以外が変わっていないことを確認する**

Run: `git diff package.json`
Expected: `-  "version": "1.3.3",` と `+  "version": "1.3.4",` の1行だけの差分。

- [ ] **Step 3: コミット**

```bash
git add package.json
git commit -m "chore: bump version to 1.3.4"
```

- [ ] **Step 4: push は利用者に確認する**

`main` への push はリリースを発行する。push するかどうかは利用者に確認してから行う。

---

## 変更しないもの

以下は今回の変更対象外である。触っていたら差し戻すこと。

| ファイル | 理由 |
|----------|------|
| `app.ts` | 行のマークアップは既に縦積みに適した構造で、変更不要 |
| `app.js` | 生成物。git-ignore されている |
| `sw.js` | `index.html` は network-first。`CACHE` バンプ不要 |
| `manifest.json` / `icons/` | 変更なし。変えていたら `CACHE` バンプが必要になる |
