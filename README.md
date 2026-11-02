# muse-mail-bridge

さくらインターネットのメールボックスと Muse をつなぐ中間アダプタ (ブリッジ) の、Cloudflare Workers 専用リポジトリです。

Muse 側の資格情報の差し替えは HTTP リクエストの中でしか効かず、IMAP/SMTP のログインには使えません。そこでこの Worker が HTTPS でリクエストを受け、Workers の TCP ソケットでメールサーバーと IMAP/SMTP を話します。メールボックスのパスワードは Worker のシークレットにだけ置きます。

コネクター全体のドキュメントは [museconnectors/muse-email-connector](https://github.com/museconnectors/muse-email-connector) を参照してください。このリポジトリはデプロイ専用です。

## デプロイ (Git 連携)

コードエディタで貼り替える必要はありません。

1. Cloudflare ダッシュボードで **Workers & Pages → Create → Connect to Git** を選び、このリポジトリを選択する (GitHub 側で Cloudflare アプリの許可を求められたら承認する)。
2. そのままデプロイする。Worker 名は `wrangler.toml` の `muse-mail-bridge` になります。以後はこのリポジトリへの push で自動デプロイされます。

## 設定 (Worker の Settings → Variables and Secrets)

シークレット (種類: Secret):

- `BRIDGE_TOKEN` — ブリッジ用トークン。自分で決めた長いランダム文字列。Muse 側のコネクター保管庫にも同じ値を入れます。
- `MAIL_PASS` — メールボックスのパスワード。

平文の変数:

- `MAIL_USER` — メールアドレス全体 (例: `you@your-domain.example`)
- `IMAP_HOST` — さくらの初期ドメイン (例: `your-initial-domain.sakura.ne.jp`)
- `SMTP_HOST` — 同上

このリポジトリ内のアドレス・サーバー名はプレースホルダに置換してあります。実値は変数・シークレット側にだけ入れてください。

## 動作確認

```
curl -X POST https://<WorkerのURL> -H "Authorization: Bearer <BRIDGE_TOKEN>" -H "Content-Type: application/json" -d '{"action":"ping"}'
```

`{"ok":true,...}` が返ればトークン認証まで正常です。
