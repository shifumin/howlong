# 複数活動の同時計測 設計書

## 背景・目的

現在の howlong は同時に1つの活動しか計測できない。しかし日常には活動が入れ子になる場面がある。たとえば入浴中に歯磨きもする場合、入浴を計測しながら歯磨きも計測し、歯磨きが先に終わり入浴が後に終わる、という記録の取り方ができない。

計測中に別の活動の計測を開始できるようにし、それぞれを独立に一時停止・終了・破棄できるようにする。

## 重複時間の扱い

重複した時間は**両方の活動にフル計上する**。入浴30分の中で歯磨きを5分した場合、入浴に30分、歯磨きに5分の記録が入る（入浴から歯磨き分を差し引かない）。

理由: このアプリの問いは「入浴には何分かかるか」であり、その答えは浴室にいた30分である。差し引きを導入すると「どちらが主でどちらが従か」の指定が必要になり、モデルもUIも複雑になる割に、知りたい値から遠ざかる。

この方針の帰結として、統計ロジック（`statsOf` / `average` / `median`）と記録ロジック（`records` への push）は**一切変更しない**。活動ごとに独立して記録が積まれるだけで、フル計上は自動的に実現される。

## 同時計測数

上限を設けない。実装上は配列にするだけなので上限なしが最も単純であり、「N個目は拒否する」という分岐を持たずに済む。

## 先行仕様の上書き

`2026-07-11-pause-resume-timer-design.md` の以下の要件は本設計で撤回される。

- 「一時停止中は他のアクティビティの新規開始をブロックする（既存の『同時に1つだけ計測できる』制約を維持）」
- 「各カードの『開始』ボタン: `state.running` が存在する間（一時停止中含む）は無効化し続ける」

一時停止・再開そのものの計算ロジック（`elapsedMs()`、`accumulatedMs` / `firstStart` / `paused` の扱い）は変更なく引き継ぐ。

## データモデル

`DB.running: Running | null` を `DB.runnings: Running[]` に置き換える。`Running` 型自体は変更しない。

```ts
interface DB {
  activities: Activity[];
  runnings: Running[];   // 計測中の活動。1つの activityId につき最大1件
}
```

不変条件: `runnings` に同じ `activityId` は2件以上存在しない。

### localStorage の移行

`STORAGE_KEY`（`howlong.v1`）は変更しない。`load()` で次の順に解釈する。

1. `parsed.runnings` が配列 → 各要素を既存の `normalizeRunning()` に通し、`null` を除外する
2. そうでなく `parsed.running` があれば（旧形式）→ `normalizeRunning()` に通し、`null` でなければ1件の配列にする
3. どちらも無ければ `[]`

`save()` は `{ activities, runnings }` を書き、旧 `running` キーは書かない。

**ダウングレード時の挙動**: 新形式のデータを旧 `app.js`（Service Worker のキャッシュが残った端末）が読むと `parsed.running` が `undefined` になるため、計測中のタイマーだけが失われる。`records` は影響を受けない。デプロイと同時に `sw.js` の `CACHE` をバンプするため実際に起こる場面は限られ、被害も「計測中だった1件が消える」に留まるので許容する。

## 関数・振る舞い

### 新規ヘルパー

- `findRunning(activityId: string): Running | undefined`
  - `state.runnings` から該当する計測を探す。

- `refreshRunning(): void`
  - バナー周りの再同期をまとめた唯一の入口。呼び出し順は次の通り。
    1. `state.activities` に存在しない `activityId` を指す `runnings` の要素を除去する（除去が発生したら `save()`）
    2. `renderBanner()` — 行を作り直す
    3. `tickBanner()` — 経過時間を即座に反映する
    4. `syncTimerLoop()`

- `renderBanner(): void`
  - `state.runnings` の各要素に対応する `.rb-row` を生成し、`#runningBanner` の中身を作り直す。
  - 末尾で `document.body.style.paddingBottom` を実測値から設定する（後述）。バナーの高さを変えるのはこの関数だけなので、ここに置けば `disarmCancel()` のように `renderBanner()` を単独で呼ぶ経路でも余白が追随する。
  - `runnings` が空なら `show` クラスを外す。1件以上なら付ける。
  - `runnings.length >= 2` のとき `#runningBanner` に `multi` クラスを付ける。
  - `armedCancels` に含まれる `activityId` の行は、「やめる」ボタンを armed 表示（`armed` クラス + テキスト「本当にやめる？」）で復元する。
  - 活動名は `textContent` で設定する（`innerHTML` に埋め込まない）。

- `tickBanner(): void`
  - 各行の `.rb-time` のテキストだけを `elapsedMs()` から書き換える。DOM構造・クラス・ボタンには触らない。
  - 時刻の書式は現行と同じ（1時間未満は `MM:SS`、以上は `H:MM:SS`）。

- `syncTimerLoop(): void`
  - `state.runnings.some(r => !r.paused)` が真かつ `tick == null` なら `tick = setInterval(tickBanner, 1000)`。
  - 偽かつ `tick != null` なら `clearInterval` して `tick = null`。
  - 既存の `startTimerLoop()` / `stopTimerLoop()` はこれに置き換える。呼び出し側は「回すべきか」を判断しなくてよい。

### `renderBanner()` と `tickBanner()` を分ける理由

現行の `updateRunningBanner()` は毎秒呼ばれ、テキストとクラスの更新だけを行っているため問題は起きていない。しかし行を動的生成する本設計では、毎秒行を作り直すと「本当にやめる？」の armed 状態とボタンのフォーカスが1秒で失われる。構造の再構築（イベント起点）と時刻の更新（毎秒）を分離することでこれを防ぐ。

### 既存関数の変更

- `startActivity(id)`
  - `findRunning(id)` が存在すれば `toast("この活動はすでに計測中です")` して return（他の活動が計測中でもブロックしない）。
  - `state.runnings.push({ activityId: id, start: now, firstStart: now, accumulatedMs: 0, paused: false })`。
  - `save()` → `refreshRunning()` → `render()`。
  - `render()` を追加する理由: 開始したカードの「開始」ボタンを「計測中…」の無効表示に切り替えるため。

- `pauseActivity(id)` / `resumeActivity(id)`
  - 引数で対象を特定する。ガード節（対象が無い / すでに目的の状態）は現行と同じ。
  - 計算ロジック（`accumulatedMs += Date.now() - start` / `start = Date.now()`）は現行のまま。
  - `save()` → `refreshRunning()`。カード側の表示は変わらないので `render()` は呼ばない。

- `stopActivity(id)`
  - 対象を `runnings` から除去し、`clearArmed(id)`。
  - 記録の生成は現行と完全に同じ: `start` に `firstStart`、`end` に現在時刻、`minutes` に `Math.max(1, Math.round(elapsedMs(running) / 60000))`。
  - `save()` → `refreshRunning()` → `render()` → `toast("記録しました")`。

- `cancelActivity(id)`
  - 2段階確認を活動ごとに持つ（後述）。確定時は記録を残さず `runnings` から除去し、`save()` → `refreshRunning()` → `render()` → `toast("計測をやめました")`。

- `deleteActivity(id)`
  - `state.runnings = state.runnings.filter(r => r.activityId !== id)` と `clearArmed(id)` に変更（現行の `state.running = null` 相当）。
  - `save()` → `refreshRunning()` → `render()`。

- `importJSON()`
  - `state.running = null` を `state.runnings = []` に変更し、armed タイマーを全て解除する。`stopTimerLoop()` 呼び出しは `refreshRunning()` に置き換える。

- `render()` 内の開始ボタン
  - `startBtn.disabled = !!state.running` → `startBtn.disabled = !!findRunning(act.id)`。
  - 無効時のラベルを `計測中…`、有効時は現行どおり `▶ 開始`。

- ブート処理
  - 現行の `if (state.running) { paused なら … else … }` を `refreshRunning()` の1行に置き換える。一時停止中かどうかの判断は `syncTimerLoop()` が行う。

- `visibilitychange`
  - `updateRunningBanner()` → `tickBanner()`。行の構造は変わっていないため時刻の更新だけでよい。

### 「やめる」の2段階確認

module 変数 `cancelArmed` / `cancelArmTimer` を活動ごとの Map に置き換える。

```ts
const armedCancels = new Map<string, number>();  // activityId -> setTimeout の ID
```

- `clearArmed(id)`: `clearTimeout` して Map から削除する。再描画はしない。
- `disarmCancel(id)`: `clearArmed(id)` してから `renderBanner()` を呼ぶ。3秒の自動解除タイマーとしてはこちらを使う。
- `cancelActivity(id)`: Map に `id` が無ければ armed にして（3秒後に `disarmCancel(id)`）`renderBanner()` して return。あれば `clearArmed(id)` して破棄を実行する。
- armed 状態は Map が持ち、表示は `renderBanner()` が Map から復元するため、他の行の操作で行を作り直しても失われない。

## UI

### HTML

`#runningBanner` の中身を空にし、`app.js` が行を生成する。固定 ID（`rbName` / `rbTime` / `cancelBtn` / `pauseBtn` / `stopBtn`）は行ごとのクラスに置き換える。

```html
<div id="runningBanner"></div>
```

生成される1行の構造:

```html
<div class="rb-row">
  <div>
    <div class="rb-name"></div>
    <div class="rb-time">00:00</div>
  </div>
  <div class="rb-actions">
    <button class="rb-cancel">やめる</button>
    <button class="rb-pause">一時停止</button>
    <button class="rb-stop">終了</button>
  </div>
</div>
```

`app.ts` 末尾のイベント登録（`#stopBtn` / `#cancelBtn` / `#pauseBtn` への `addEventListener`）は削除し、`renderBanner()` 内で各行のボタンに直接ハンドラを結ぶ。

### CSS

- パディングをバナーから行へ移す: `#runningBanner` の `padding: 14px 18px` を `padding: 2px 0` にし、`overflow: hidden`・`flex-direction: column`・`align-items: stretch` を加える（現行の `align-items: center` と `justify-content: space-between` は行側の責務になるので削除する）。`.rb-row { padding: 12px 18px; }`。これにより一時停止行が左右いっぱいの背景色を取れ、`overflow: hidden` が角丸を保つ。
- `#runningBanner.show { display: flex; }` は現行どおり。
- `.rb-name` / `.rb-time` のスタイル規則（`#runningBanner .rb-name` / `#runningBanner .rb-time`）は既にクラスセレクタなので変更不要。`#runningBanner` が祖先である構造は維持されるためそのまま適用される。
- 行の区切り: `.rb-row + .rb-row { border-top: 1px solid rgba(255,255,255,.22); }`
- 行の中身: `.rb-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }`
- ボタンのセレクタを ID からクラスへ: `#stopBtn` → `.rb-stop`、`#pauseBtn` → `.rb-pause`、`#cancelBtn` → `.rb-cancel`。各ボタンのスタイル（終了は白背景、やめるは枠線のみ、armed は赤、一時停止中の再開は白背景）は現行の意図をそのまま引き継ぐ。
- **一時停止の表現**: 現行の `#runningBanner.paused`（バナー全体をグレー化）は複数行では使えないため、`.rb-row.paused { background: rgba(0,0,0,.22); }` に落として行単位で暗くする。バナーの地色は `--accent` のまま。3件計測中のうち1件だけ一時停止している状態が一目で分かることを目的とする。名前は現行どおり「〜を一時停止中」と表示する。
- **時刻のフォントサイズ**: `.rb-time` の 30px のままでは3行で高さが200pxを超える。`#runningBanner.multi .rb-time { font-size: 22px; }` として2行以上のときだけ縮める。1行のときの見た目は現行と完全に同じにする。

### 狭い画面での行レイアウト（1.3.2 で追加）

初版は `.rb-row` を常に横1行（名前と時刻のブロック＋ボタン群）にしていたが、実機で不具合が出たため次を追加した。

- `.rb-actions { flex-shrink: 0; }` — **必須**。これが無いと、名前が長い行ではボタン群が縮められ、縮み幅が名前の長さで決まるため行ごとにボタンの寸法が変わる。実機（バナー幅358px）では「シェーバー洗浄」の行だけボタンが 49/64/46px に潰れ、ラベルまで「やめ／る」と折り返した。カード側の `.head-actions` には最初からこの指定があり、そちらが正解のパターンだった。
- `#runningBanner button { white-space: nowrap; }` — ラベルを絶対に折り返させない。
- `.rb-head { min-width: 0; }` — 縮む側を名前ブロックに寄せる。
- `#runningBanner .rb-pause { min-width: 88px; }` — 「一時停止」(88px) と「再開」(58px) で幅が変わると押すたびに隣のボタンが横にずれるため、長い方を下限にする。
- `@media (max-width: 560px)` で `.rb-row` を縦積みにし、名前と時刻を同じ行（`.rb-head` を `justify-content: space-between`）、ボタンを下段に回す。狭い画面ではボタン3つ（自然幅で計227px）と名前を1行に収める余地が無いため。

この結果、バナー幅358pxで全行のボタンが 65×38 / 88×43 / 58×43 に固定され、行の高さも約100pxで揃う。名前が40文字（`maxlength` 上限）の場合は名前だけが折り返して行が高くなるが、ボタンの寸法は変わらない。560px超の画面では従来の横1行レイアウトを維持する。

### 下部の余白

現行の `body.running { padding-bottom: calc(env(safe-area-inset-bottom) + 116px); }` は行数で高さが変わるため破綻する。このルールと `document.body.classList.add("running")` を削除し、`renderBanner()` の末尾で実測して設定する。

```ts
document.body.style.paddingBottom = state.runnings.length
  ? `calc(env(safe-area-inset-bottom) + ${banner.offsetHeight + 28}px)`
  : "";
```

計測が0件のときに空文字へ戻すと、`body` の `padding` 一括指定（`calc(env(safe-area-inset-bottom) + 24px)`）が復活する。

## エラーハンドリング・エッジケース

- 同じ活動の二重開始: `startActivity()` のガードで防ぐ。他の活動の計測中は妨げない。
- 存在しない活動を指す `runnings` の要素: `refreshRunning()` の先頭で除去する（現行 `updateRunningBanner()` にある自己修復ロジックの複数件版）。
- 計測中の活動を削除: その活動の計測のみ除去し、他の計測は継続する。
- インポート: 全ての計測を破棄する（現行の挙動を踏襲）。
- `pauseActivity` / `resumeActivity` / `stopActivity` / `cancelActivity` に存在しない `activityId` が渡された場合は何もしない（ガード節）。
- `save()` の失敗（`QuotaExceededError` 等）: 現行どおり toast を出すだけで、計測の状態は変えない。

## テスト観点

このリポジトリには自動テストが無いため、ブラウザでの手動確認とする。

- 旧形式（`running` 単一オブジェクト）の localStorage を持つ状態で開き、計測中の活動が引き継がれること。一時停止中でも引き継がれること。
- 入浴を開始 → 歯磨きを開始 → 歯磨きを終了 → 入浴を終了 の順で操作し、入浴と歯磨きそれぞれに正しい分数の記録が入ること（歯磨きの分が入浴から差し引かれていないこと）。
- 3件を同時に計測し、1件だけ一時停止したときに、その行だけが暗くなり他の行の時刻が進み続けること。
- 全件を一時停止すると `setInterval` が止まり、1件でも再開すると再び動くこと。
- 一覧の最後のカードがバナーに隠れないこと（1行・2行・3行のそれぞれで確認）。
- 「やめる」を1つの行で押した状態で別の行の「一時停止」を押しても、armed 表示が維持されること。
- armed のまま3秒放置すると、その行だけ「やめる」に戻ること。
- 計測中の活動のカードの「開始」ボタンが「計測中…」の無効表示になり、計測していない活動の「開始」は押せること。
- 計測中にページをリロードして、全ての計測と経過時間が復元されること。
- 計測中の活動を削除しても他の計測が継続すること。

## デプロイ

- `sw.js`: `CACHE` を `howlong-v4` → `howlong-v5` にバンプする（`app.ts` と `index.html` の両方が変わるため必須。`app.js` は cache-first で配信されるため、バンプを忘れると新しい HTML が古い JS で動く）。
- `package.json`: `1.2.2` → `1.3.0`（機能追加）。
