# べびログ v2

赤ちゃんのお世話記録アプリ。ぴよログの代わりに、広告なし・自分好みのUXで使うためのWebアプリです。
iPhoneのSafariで開いて「ホーム画面に追加」するとアプリのように使えます。

## 自分の「◯◯ログ」を作る（10分・無料）

下のボタンを押すと、リポジトリのコピー → 合言葉の設定 → データベース(Upstash)と
写真置き場(Blob)の作成 → デプロイまで、画面の案内どおりに進むだけで完成します。
くわしい手順は **[SETUP.md](./SETUP.md)** へ。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fkcmnzn38%2Fbabylog&env=APP_TOKEN,CRON_SECRET&envDescription=%E5%AE%B6%E6%97%8F%E3%81%A7%E5%85%B1%E6%9C%89%E3%81%99%E3%82%8B%E3%80%8C%E5%90%88%E8%A8%80%E8%91%89%E3%80%8D%E3%82%92%E6%B1%BA%E3%82%81%E3%81%A6%E3%80%812%E3%81%A4%E3%81%A8%E3%82%82%E5%90%8C%E3%81%98%E5%80%A4%E3%82%92%E5%85%A5%E5%8A%9B%E3%81%97%E3%81%A6%E3%81%8F%E3%81%A0%E3%81%95%E3%81%84&envLink=https%3A%2F%2Fgithub.com%2Fkcmnzn38%2Fbabylog%2Fblob%2Fmain%2FSETUP.md&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%2C%22protocol%22%3A%22storage%22%7D%2C%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

## 構成

- `public/` … アプリ本体（静的HTML/CSS/JS、フレームワークなし・ビルド不要）
  - `app.js` … UI（記録 / 画像 / まとめ / 設定）
  - `store.js` … データ層（localStorage保存 + クラウド自動同期 + シート書き出しクライアント）
  - `parser.js` … ぴよログのエクスポートtxtのパーサー / ぴよログ形式書き出し
  - `growth-data.js` … 成長曲線のパーセンタイル帯データ（こども家庭庁 乳幼児身体発育調査）
- `api/db.js` … クラウド同期API（Upstash Redis・権限つき合言葉の判定）
- `api/photo.js` … 写真の保存/配信API（Vercel Blob・非公開ストア）
- `api/export.js` … 毎日の自動バックアップ（Vercel Cron → Apps Script）
- `api/voice.js` … 音声・自然文入力の解釈（Gemini・任意）
- `gas/` … スプレッドシート・Drive書き出し用のGoogle Apps Script
- `api/auth/` … Googleログイン（任意・現在はオフ）

## できること

- **記録タブ**: タイムライン（種類ごとの色分け・時間の間隔で行間が変わる）、
  日毎サマリー（前回からの経過時間つき・タップで内訳モーダル）、
  「◯時間ぶり」表示（ミルク・おしっこ・うんち）、「◯時間寝た」自動計算、
  ワンタップ記録・時刻の −5分/−30分/＋5分 調整・取り消し（Undo）、
  スワイプで日付移動・日付タップでカレンダージャンプ
- **画像タブ**: 写真アルバム（月別グリッド・メモつき・種類フィルタ）。
  写真は1記録に3枚まで、タップでモーダル表示（スワイプ切り替え・シェア・保存）
- **まとめタブ**: 週/月切り替えで 食事（量・回数と1回あたりの量）/
  睡眠（時間帯ガント・合計と最長ねんね）/ 排泄（回数）/
  健康（体温・成長曲線＋計測の記録テーブル）
- **設定タブ**: 赤ちゃんのプロフィール（よみがなを入れると「◯◯の写真」表示に）、
  ミルク初期量・クイックボタン6枠・「その他」の並び順のカスタマイズ、
  ぴよログtxt・JSONバックアップの取り込み（重複なしマージ）、
  JSON/CSV/ぴよログ形式のファイル書き出し、Googleへバックアップ（シート＋Drive写真）
- **Siriに話して記録**（任意・Gemini API）: 「Hey Siri、◯◯ログ」→「ミルク120飲んだ」で
  アプリを開かずに登録。ロック画面・Apple Watchからも（SETUP.md参照）
- 権限つき合言葉（編集/写真投稿/閲覧の3段階）、
  ライト/ダークテーマ自動切り替え、PWA（ホーム画面追加）対応

## データの持ち方

記録はまずブラウザの `localStorage` に保存され、合言葉を入れるとクラウド（Upstash Redis）と
自動同期します。写真は非公開のVercel Blobに保存され、合言葉なしではアクセスできません。
スキーマはスプレッドシートの `Records` シートと1:1対応：

```text
id, babyId, date, time, type, amountMl, leftMin, rightMin, note, createdAt, updatedAt, customTitle, photo
```

`type` 一覧: milk / breast / expressed / pump / frozen / sleep / wake / pee / poop / bath /
lotion / temperature / weight / height / medicine / vaccine / vomit / burp / hiccup / tummy /
walk / memo / custom
（`amountMl` は種類により ml / °C / kg / 睡眠分 を格納）

## ローカルで見る

```bash
npm run dev
# http://localhost:4173
```

## デプロイ（Vercel 無料枠）

リポジトリをVercelに接続していれば、`main` にpushするだけで `public/` が配信されます。
環境変数なしでも動きます（その場合は端末内保存のみ）。

## みんなで自動同期（クラウド / Vercel + Upstash Redis・無料）

記録はまず端末内に保存され、パスコードを設定すると自動でクラウドDBと同期します
（記録するたびにpush、60秒ごと＆アプリを開いたときにpull。オフライン時は復帰後に自動再送）。

### セットアップ（1回だけ・5分）

1. Vercelダッシュボード → `babylog` プロジェクト → **Storage** タブ
   → **Upstash (Redis)** を Create/Connect（Freeプラン）
   → 環境変数 `KV_REST_API_URL` / `KV_REST_API_TOKEN` が自動で入る
2. Settings → Environment Variables に追加:
   ```text
   APP_TOKEN=好きなパスコード（家族で共有する合言葉・記録できる人用）
   CRON_SECRET=APP_TOKENと同じ値（毎日の自動書き出し用）
   SHEET_WEBAPP_URL=Apps ScriptのウェブアプリURL（下記。自動書き出しを使う場合）
   APP_TOKEN_VIEW=閲覧専用の合言葉（任意。見るだけの人＝祖父母など用）
   APP_TOKEN_PHOTO=写真投稿用の合言葉（任意。閲覧＋写真の追加だけできる人用）
   GEMINI_API_KEY=Gemini APIキー（任意。音声・自然文入力を使う場合。無料: aistudio.google.com/apikey）
   ```
3. Deployments → 最新デプロイ → Redeploy（環境変数を反映）
4. 各端末のべびログ 設定タブ →「同期パスコード」に APP_TOKEN と同じ値を入れる

### 権限つきの合言葉（任意）

合言葉は3種類まで作れます。どれも入れ方は同じで、設定タブの「同期パスコード」に入れるだけ。
権限はサーバー側で判定されるので、UIをいじっても越えられません。

- `APP_TOKEN` … **編集**。記録・編集・削除・設定変更、なんでもできる（家族用）
- `APP_TOKEN_PHOTO` … **写真投稿**。閲覧＋日付横の📷からの写真追加だけできる（預かり中の祖父母用など）
- `APP_TOKEN_VIEW` … **閲覧**。見るだけ。成長を見てもらう用

## Googleへバックアップ（スプレッドシート＋Drive写真）

バックアップすると「**記録**」シート（日本語で整形: 日付・曜日・時刻・種類・内容・メモ）と
「Records」シート（生データ・復元用）の2枚が更新され、
Driveフォルダを指定していれば写真も種類ごとのサブフォルダへ保存されます。

コードの書き換えは不要です（合言葉は初回の書き出しで自動登録されます）。

1. 書き出し先のスプレッドシートを開く → 拡張機能 → Apps Script
2. ⚙プロジェクトの設定 →「appsscript.jsonを表示」にチェック → `gas/appsscript.json` の中身に差し替え
3. コード.gs に `gas/Code.gs` を貼り付けて保存
4. 関数「**setup**」を▶実行 → 承認画面を許可（シート・Drive・外部通信の権限がまとめて通ります）
5. デプロイ → 新しいデプロイ → ウェブアプリ（実行: 自分 / アクセス: 全員）→ URLをコピー
6. アプリの設定タブ「書き出し先URL」にそのURLを入れて「シートへ書き出す」

写真のDriveバックアップを使う場合は、アプリの設定「写真バックアップ先のDriveフォルダ」に
フォルダURLを貼るだけです。細かい手順・つまずきどころは **[SETUP.md](./SETUP.md)** を参照。

### 毎日の自動書き出し（Vercel Cron）

`vercel.json` の crons 設定により、**毎日 日本時間 3:00** に `/api/export` が走り、
クラウドDBの全記録をスプレッドシートへ書き出します（全件置き換えなので重複しません）。
必要な環境変数: `CRON_SECRET` と `SHEET_WEBAPP_URL`（上記）。
手動で試すには: `curl -H "X-App-Token: <APP_TOKEN>" https://<app>.vercel.app/api/export`

## Googleログインを後から付ける

`api/sync.js` は `GOOGLE_CLIENT_ID` と `AUTH_SECRET` が設定されている場合のみ
セッションを必須にします。ログインを有効化したくなったら:

1. Vercelに `GOOGLE_CLIENT_ID` と `AUTH_SECRET` を設定
2. `api/auth/allowed-users.js` に許可するGoogleアカウントを記載
3. フロントにログインUIを戻す（旧バージョンの `index.html` / `app.js` が参考になる）

## ぴよログからの引っ越し

ぴよログ → メニュー → 記録の出力 → テキスト形式で書き出し、
べびログの設定タブでファイル選択（複数可）または貼り付けで取り込みます。
同じ月のデータを何度取り込んでも重複しません（内容ベースのIDでマージ）。
