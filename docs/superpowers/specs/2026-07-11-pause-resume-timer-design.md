# 計測の一時停止・再開機能 設計書

## 背景・目的

現在の howlong は「開始」→「終了（記録）」または「やめる（破棄）」しかなく、計測中に中断・再開する手段がない。計測を開始したあとに一時停止し、あとで再開できるようにする。

## 要件

- 計測中のアクティビティを一時停止できる。
- 一時停止中のアクティビティを再開できる。
- 一時停止していた時間は、最終的に記録される合計時間（分）から除外する。
- 一時停止中もバナー表示・ページリロードを跨いで状態が保持される。
- 「やめる」（破棄）・「終了」（記録して停止）は一時停止中でも従来どおり操作できる。
- 一時停止中は他のアクティビティの新規開始をブロックする（既存の「同時に1つだけ計測できる」制約を維持）。

## データモデル

`Running` 型に一時停止用のフィールドを追加する。

```ts
interface Running {
  activityId: string;
  start: number;         // 現在の計測セグメントの開始時刻(ms)
  accumulatedMs: number; // これまでに実行済みだった時間の合計(ms)
  paused: boolean;       // 一時停止中かどうか
}
```

- 経過時間の計算式:
  - 一時停止中: `accumulatedMs`
  - 実行中: `accumulatedMs + (Date.now() - start)`
- 一時停止時: `accumulatedMs += Date.now() - start; paused = true`
- 再開時: `start = Date.now(); paused = false`
- `state.running` は既存どおり `save()` で localStorage に永続化するため、ページリロードを跨いでも一時停止状態が復元される。

## 関数・振る舞い

### 新規関数

- `pauseActivity()`
  - `state.running` があり `paused === false` の場合のみ動作。
  - `accumulatedMs += Date.now() - start`、`paused = true` にして `save()`。
  - `stopTimerLoop()` で `setInterval` を止める（省電力のため、一時停止中はタイマーを回さない）。
  - `updateRunningBanner()` を呼び、表示を「一時停止中」に更新。

- `resumeActivity()`
  - `state.running` があり `paused === true` の場合のみ動作。
  - `start = Date.now()`、`paused = false` にして `save()`。
  - `startTimerLoop()` で `setInterval` を再開。

### 既存関数の変更

- `startActivity()`: `Running` 生成時に `accumulatedMs: 0, paused: false` を追加。
- `stopActivity()`: 記録する分の計算を、単純な `(endMs - startMs) / 60000` ではなく `accumulatedMs + (paused ? 0 : now - start)` を基準にした式に変更する。一時停止中に「終了」を押した場合もその時点の累積時間で記録される。1分未満は既存どおり最低1分に切り上げる。
- `updateRunningBanner()`:
  - `paused` なら: `banner.classList.add("paused")`、`#pauseBtn` のテキストを「再開」にし `paused` クラスを付与、`#rbName` を「〜を一時停止中」に、時間表示は `accumulatedMs` から固定計算して `setInterval` は回さない。
  - 実行中なら: 上記をすべて元に戻す（今までどおりの表示・更新）。
- ブート処理（`if (state.running) startTimerLoop();`）: `paused` なら `startTimerLoop()` を呼ばず `updateRunningBanner()` のみ呼んで固定表示にする。実行中なら従来どおり `startTimerLoop()`。

### 既存の挙動を維持するもの

- `cancelActivity()`（やめる）: 一時停止中でもそのまま使用可能。記録を残さず `state.running` を破棄する今の挙動を変えない。
- `deleteActivity()`: 一時停止中のアクティビティを削除した場合も `state.running = null` にする既存ロジックのまま。
- 各カードの「開始」ボタン: `state.running` が存在する間（一時停止中含む）は無効化し続ける（既存どおり）。

## UI

### HTML（`#runningBanner` 内）

`やめる` と `終了` の間に `一時停止` ボタンを追加する。

```html
<button id="cancelBtn">やめる</button>
<button id="pauseBtn">一時停止</button>
<button id="stopBtn">終了</button>
```

### CSS

- バナー全体に `paused` クラスを付与し、背景色を通常時の `--accent` から `--sub`（グレー系。ライト `#6b6b70` / ダーク `#9a9aa0`）に変更し、一時停止中であることを一目で分かるようにする。
- `#pauseBtn` は一時停止中に `paused` クラスを付与し、`#stopBtn` と同じ白背景の目立つスタイルにする（一時停止中に押すべき主操作が「再開」であることを示すため）。

### イベント登録

```ts
$("#pauseBtn").addEventListener("click", () => {
  if (state.running?.paused) resumeActivity(); else pauseActivity();
});
```

## エラーハンドリング・エッジケース

- `state.running` が null の状態で `pauseActivity()` / `resumeActivity()` が呼ばれても何もしない（ガード節）。
- 既に `paused === true` の状態で `pauseActivity()` が呼ばれても二重加算しない（ガード節）。
- 一時停止中にタブが非表示→表示に戻った場合（`visibilitychange`）も `updateRunningBanner()` が呼ばれるが、`paused` なら固定表示のままで問題ない。
- インポート（`importJSON`）実行時は既存どおり `state.running = null` にリセットする（一時停止中でも同様に破棄される）。

## テスト観点

- 開始 → 一時停止 → 再開 → 終了で、一時停止していた時間が記録から除外されていること。
- 一時停止を複数回繰り返しても正しく累積されること。
- 一時停止中に「やめる」で記録が残らないこと。
- 一時停止中に「終了」を押すと、その時点までの累積時間で記録されること。
- 一時停止中にページをリロードしても、一時停止状態・累積時間が復元され、バナーが固定表示のままであること。
- 一時停止中は他のアクティビティの「開始」ボタンが無効のままであること。
