# `app.js` をネットワーク優先で配信する 設計書

## 背景

1.3.0（複数活動の同時計測）をデプロイした直後、本番で**新しい `index.html` と古い `app.js` の組み合わせ**が動いている状態を実際に観測した。ネットワーク上の `app.js` は新しかったため、デプロイ自体は正しく、原因は配信側のキャッシュだった。

古い `app.js` の出どころは次の2経路のどちらかで、観測時点ではどちらだったか断定できなかった（キャッシュ一覧を確認した時点で旧 `CACHE` は既に削除されていた）。ただしどちらも実在する経路である。

1. **旧 `CACHE` の Cache Storage**: 新しい Service Worker が `activate` して旧キャッシュを削除するタイミングと、そのページが `app.js` を読み込むタイミングが競合する。`CACHE` を正しくバンプしていても、デプロイ後の最初の1回はこの競合に負けうる。
2. **ブラウザの HTTP キャッシュ**: cache-first 分岐の `fetch(req)` はブラウザの HTTP キャッシュも参照する。GitHub Pages は `Cache-Control: max-age=600` を返すため、期限内なら古いコピーが返り、しかもそれが新しい `CACHE` に `put` されて焼き付く。次のバンプまで古いままになる。

## この問題が悪化した理由

1.3.0 で `index.html` から固定 ID（`rbName` / `rbTime` / `cancelBtn` / `pauseBtn` / `stopBtn`）を削除し、バナーを JS が生成する構造に変えた。そのため古い `app.js` が新しい `index.html` に対して動くと、`$("#rbName").textContent = ...` が `null` に対する代入となって TypeError を投げ、**バナーがまったく表示されなくなる**。

1.2.0 の事故（`2fe92dd`）では「一時停止ボタンが効かない」という部分的な劣化だったが、HTML と JS の契約が構造的に変わった以降は「計測を開始しても何も起きない」という全体的な機能停止になる。同じ原因で被害が大きくなった。

## 方針

`app.js` を `index.html` と同じ **network-first** に移す。

理由は、この2ファイルが常に同じデプロイで一緒に出荷され、互いの契約に依存しているからである。同じライフサイクルを持つものを別の配信戦略で扱っていたことが問題の根本であり、バージョン付きでない URL を cache-first で配ることが誤りだった。

### 却下した案: `fetch(req, { cache: "no-cache" })` の1行修正

cache-first 分岐の `fetch` に `cache: "no-cache"` を渡してブラウザの HTTP キャッシュを信用させない案も検討した。コストはほぼゼロだが、上記の経路2しか閉じられない。実際に観測された現象と整合する経路1（旧 Cache Storage との競合）が残るため、採用しない。

### 人間の規律に依存しない設計にする

従来は「`app.ts` を変えたら `CACHE` をバンプする」という手順を CLAUDE.md に明記して運用していた。しかし 1.2.0 の事故はその手順を忘れたことで起きている。忘れると壊れる設計より、忘れても壊れない設計を選ぶ。この変更で `app.ts` の変更時に `CACHE` をバンプする必要がなくなる。

## 実装

### `sw.js`

ネットワーク優先の処理を `networkFirst(req, cacheKey, fallback)` に共通化し、HTML と `app.js` の両方から使う。

```js
function networkFirst(req, cacheKey, fallback) {
  return fetch(req)
    .then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(cacheKey, copy));
      return res;
    })
    .catch(() => caches.match(req).then((hit) => hit || caches.match(fallback)));
}
```

`cacheKey` を引数にした理由: HTML はリクエスト URL がクエリ付きでも常に `./index.html` として保存する必要がある（既存の挙動）。一方 `app.js` はリクエストそのものをキーにする。

`app.js` の判定は `new URL(req.url).pathname.endsWith("/app.js")` で行う。GitHub Pages ではサブパス（`/howlong/app.js`）で配信されるため、パス末尾で判定する。

### `ASSETS` に `./app.js` を追加する

`install` 時に事前キャッシュする。従来は `ASSETS` に無かったため、Service Worker のインストール直後にオフラインになると `app.js` が取得できずアプリが起動しない穴があった。network-first でも初回のネットワーク取得が必要な点は同じなので、事前キャッシュで穴を埋める。

オンラインの読み込みごとに最新版で上書きされるため、事前キャッシュが古くても問題にならない。

### `CACHE` のバンプ

`howlong-v5` → `howlong-v6`。`sw.js` 自体の変更はバイト比較で検出されて再インストールされるが、旧 v5 には cache-first 時代の `app.js` エントリが残っている。バンプして `activate` で確実に破棄する。

## オフライン動作

変更後もオフラインで動く。`fetch` が失敗したら `caches.match(req)` → `caches.match(fallback)` の順にフォールバックし、network-first のレスポンスは毎回キャッシュへ書き戻されるため、最後に成功した版が常に残っている。

## テスト観点

自動テストが無いため、ローカルサーバー（`python3 -m http.server`）とブラウザで確認する。

- Service Worker が v6 でインストールされ、`activate` 後に `howlong-v6` のみが残ること。
- `howlong-v6` に `app.js` が事前キャッシュされていること（`install` 時点、初回の `app.js` リクエスト前）。
- **`CACHE` をバンプせずに `app.js` の内容を変更し、リロード1回で新しい内容が実行されること**（この変更の中心的な主張）。
- ネットワークを落とした状態でリロードしても、キャッシュから起動して動作すること。
- `manifest.json` / アイコンは従来どおり cache-first で配信されること。
