# デプロイ手順書：不動産クラファン 実質利回りカリキュレーター

## 前提

- GitHubアカウント：あり
- Cloudflareアカウント：これから作成（無料）
- このフォルダ（`real-yield-calc`）がローカルにある

---

## ステップ1：GitHubにリポジトリを作成してプッシュ

### 1-1. GitHubで新しいリポジトリを作る

1. https://github.com/new を開く
2. Repository name に `real-yield-calc` と入力
3. **Public** を選択（Cloudflare Pagesの無料プランで使うため）
4. 他はデフォルトのまま「Create repository」をクリック

### 1-2. ローカルからプッシュ

ターミナル（Claude Code等）で以下を実行：

```bash
cd real-yield-calc
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/あなたのユーザー名/real-yield-calc.git
git push -u origin main
```

※ `あなたのユーザー名` はGitHubのユーザー名に置き換えてください。

---

## ステップ2：Cloudflareアカウントを作成

1. https://dash.cloudflare.com/sign-up を開く
2. メールアドレスとパスワードで無料アカウントを作成
3. メール認証を完了

---

## ステップ3：Cloudflare Pagesでデプロイ

### 3-1. プロジェクトを作成

1. Cloudflareダッシュボード（https://dash.cloudflare.com）にログイン
2. 左メニューの **「Workers & Pages」** をクリック
3. **「Create」** ボタンをクリック
4. **「Pages」** タブを選択
5. **「Connect to Git」** をクリック

### 3-2. GitHubと連携

1. 「GitHub」を選択
2. GitHubアカウントとの連携を許可（初回のみ）
3. `real-yield-calc` リポジトリを選択
4. 「Begin setup」をクリック

### 3-3. ビルド設定

以下の通り設定してください：

| 項目 | 設定値 |
|---|---|
| Project name | `real-yield-calc`（そのままでOK） |
| Production branch | `main` |
| Framework preset | `Vite` を選択 |
| Build command | `npm run build` |
| Build output directory | `dist` |

「Save and Deploy」をクリック。

### 3-4. デプロイ完了

1〜2分でビルドが完了し、自動的にURLが発行されます。

例：`https://real-yield-calc.pages.dev`

このURLでツールが公開されます。

---

## ステップ4（任意）：独自ドメインの設定

独自ドメイン（例：`realyield.jp`）を使いたい場合：

1. ドメインを購入（お名前.com、ムームードメイン等で年額1,000〜3,000円）
2. Cloudflare Pagesの「Custom domains」タブで独自ドメインを追加
3. ドメインのネームサーバーをCloudflareに変更
4. SSL証明書は自動で発行される

※ 独自ドメインなしでも `*.pages.dev` のURLで十分公開可能です。

---

## 更新方法

コードを修正したら：

```bash
cd real-yield-calc
git add .
git commit -m "変更内容の説明"
git push
```

GitHubにプッシュするだけで、Cloudflare Pagesが自動的に再ビルド＆再デプロイします。
通常1〜2分で反映されます。

---

## プロジェクト構成

```
real-yield-calc/
├── index.html          ← エントリーポイント（HTMLテンプレート）
├── package.json        ← 依存関係・ビルドスクリプト
├── vite.config.js      ← Viteのビルド設定
├── .gitignore          ← Git除外設定
├── src/
│   ├── main.jsx        ← Reactのマウントポイント
│   └── App.jsx         ← カリキュレーター本体（全機能）
└── dist/               ← ビルド成果物（gitには含まない）
```

## トラブルシューティング

- **ビルドが失敗する場合**：`npm install` を実行してから `npm run build` を試す
- **画面が白い場合**：ブラウザの開発者ツール（F12）でConsoleタブのエラーを確認
- **Cloudflareで「Build failed」が出る場合**：Build commandとOutput directoryの設定を再確認
