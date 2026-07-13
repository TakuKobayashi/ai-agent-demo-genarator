# AI Agent Demo Genarator

GitHubのIssueをトリガーにAIがコードを修正してPRを自動作成するイベント駆動パイプライン。

## 2つの構成

### 構成A: Google Cloud フルネイティブ (ハッカソン用)

```
GitHub Issue (opened)
        │
        ▼
  Cloud Run: Webhookレシーバー (Hono)
        │  HMAC-SHA256署名検証
        ▼
   Cloud Pub/Sub
        │  Push サブスクリプション
        ▼
  Cloud Run: ADKエージェントワーカー
        │  Gemini ADK + gemini-2.0-flash
        │  git clone → コード修正 → git push
        ▼
    GitHub PR 自動作成

CI/CD: Cloud Build
  main push → ビルド → デプロイ
  PR作成    → 型チェックのみ
```

### 構成B: GitHub Actions + Cloudflare + ローカルLLM (コスト最小)

```
GitHub Issue (opened)
        │
        ▼
 GitHub Actions (無料枠)
        │  Issue情報をJSONに組み立ててPOST
        ▼
 Cloudflare Workers (無料枠 / Hono)
        │  Bearer認証
        ▼
 Cloudflare Queues (無料枠)
        │  Queue Consumer → Cloudflare Tunnel経由でHTTP転送
        ▼
 自前GPUサーバー: local-worker (Hono HTTPサーバー)
        │  Aider + Ollama (Qwen2.5-coder)
        │  git clone → コード修正 → git push
        ▼
    GitHub PR 自動作成
```

## ディレクトリ構成

```
devops-ai-agent/
├── .github/workflows/
│   └── issue-to-agent.yml        # 【構成B】Issue→Cloudflare転送
├── gcp-webhook/
│   └── src/index.ts              # 【構成A】Cloud Run Webhookレシーバー
├── cloudflare-workers/
│   ├── src/index.ts              # 【構成B】Cloudflare Workerディスパッチャー
│   ├── .dev.vars                 # 【構成B】wrangler dev 用ローカル環境変数
│   └── wrangler.jsonc
├── local-worker/
│   └── src/server.ts             # 【構成B】自前GPUサーバー HTTPサーバー
├── src/
│   └── worker-entrypoint.ts      # 【構成A】ADKエージェント本体
├── local-dev/                    # ローカル動作確認専用 (本番デプロイには含めない)
│   ├── cf-queue-mock/            # 【構成B】Cloudflare Queues モックサーバー
│   └── gcp-pubsub-relay/         # 【構成A】Pub/SubエミュレータのPull→Push配信ブリッジ
├── local-test/                   # ローカル動作確認用テストスクリプト (commander + tsx)
│   └── src/
│       ├── test-cloudflare-flow.ts  # 【構成B】ダミーリクエスト送信スクリプト
│       ├── test-gcp-flow.ts         # 【構成A】ダミーリクエスト送信スクリプト
│       └── lib/dummy-issue.ts       # 共通: ダミーペイロード生成
├── cloudbuild/
│   ├── cloudbuild.yaml           # 【構成A】CI/CD 本番デプロイ
│   └── cloudbuild.pr.yaml        # 【構成A】CI/CD PRチェック
├── Dockerfile.webhook            # 【構成A】Cloud Run Webhook用
├── Dockerfile.worker             # 【構成A】Cloud Run Worker用
├── Dockerfile.local-worker       # 【構成B】自前GPUサーバー用
├── docker-compose.local.yml      # 【構成B】本番相当 Ollama+Worker+Tunnel一括起動
├── docker-compose.dev.cloudflare.yml  # 【構成B】ローカル動作確認環境 (別ポートで各サービス起動)
├── docker-compose.dev.gcp.yml         # 【構成A】ローカル動作確認環境 (別ポートで各サービス起動)
├── scripts/deploy.ts             # デプロイ補助スクリプト
└── Taskfile.yml
```

## ローカルでの動作確認

本番のクラウドサービスにデプロイしなくても、各構成のパイプラインを
ローカルで一気通貫または段階ごとに動作確認できる。
各サービスは別ポートで起動し、`local-test/` の commander CLI スクリプトで
ダミーのIssueリクエストを送信して疎通確認する。

デフォルトでは `DRY_RUN=true` になっており、実際の `git clone/push`・
GitHub PR作成・Aider/Gemini ADKの実行はスキップされ、ログ出力のみで
処理をシミュレートする。**GitHubトークンやOllama、GCP認証情報がなくても
HTTP層・認証・Queue/Pub/Subのリレーだけを確認できる。**

### package.json スクリプト一覧

すべて `pnpm run <script>` (追加の引数がある場合は `pnpm run <script> -- --issue-number 5` のように `--` の後ろに付ける)。

| コマンド | 内容 |
|---|---|
| `pnpm install:all` | 全パッケージの依存関係をインストール |
| `pnpm lint` | 全パッケージの型チェック |
| **構成B (Cloudflare) 環境起動** | |
| `pnpm dev:cf` | ローカル開発環境を起動 (cf-worker-dev / cf-queue-mock / local-gpu-worker) |
| `pnpm dev:cf:down` | 上記を停止 |
| **構成A (Google Cloud) 環境起動** | |
| `pnpm dev:gcp` | ローカル開発環境を起動 (pubsub-emulator / gcp-webhook-dev / gcp-pubsub-relay / adk-worker-dev) |
| `pnpm dev:gcp:down` | 上記を停止 |
| **本番相当の自前GPUサーバー環境 (Ollama込み)** | |
| `pnpm dev:prod-like` | `docker-compose.local.yml` をバックグラウンド起動 (Ollama + Aiderワーカー + Tunnel) |
| `pnpm dev:prod-like:down` | 上記を停止 |
| **構成B ダミーリクエストテスト** (`dev:cf` 起動後に実行) | |
| `pnpm test:cf:dispatch` | GitHub Actions → Cloudflare Worker `/dispatch` |
| `pnpm test:cf:queue` | Cloudflare Queues モックへ直接投入 |
| `pnpm test:cf:worker` | 自前GPUワーカー `/run` へ直接送信 |
| `pnpm test:cf:e2e` | 一気通貫 (dispatch → Queue → Worker) |
| **構成A ダミーリクエストテスト** (`dev:gcp` 起動後に実行) | |
| `pnpm test:gcp:webhook` | 署名付きGitHub Webhook → `gcp-webhook` `/webhook` |
| `pnpm test:gcp:pubsub` | Pub/Subエミュレータへ直接パブリッシュ |
| `pnpm test:gcp:worker` | ADKワーカー `/worker` へPush形式で直接送信 |
| `pnpm test:gcp:e2e` | 一気通貫 (webhook → Pub/Sub → relay → Worker) |
| **単体でのローカル起動 (Dockerなし)** | |
| `pnpm worker:dev` | ADKワーカーを単体起動 (GEMINI_ADK / DRY_RUN=true / port 8091) |
| `pnpm worker:dev:aider` | ADKワーカーを単体起動 (LOCAL_AIDER / DRY_RUN=true / port 8091) |
| `pnpm --filter ./gcp-webhook dev:local` | gcp-webhookを単体起動 (port 8090・ローカル用シークレット) |
| `pnpm --filter ./local-worker start:dry-run` | local-workerを単体起動 (DRY_RUN=true / port 3434) |
| `pnpm --filter ./local-dev/cf-queue-mock start:local` | cf-queue-mockを単体起動 (port 8788) |
| `pnpm --filter ./local-dev/gcp-pubsub-relay start:local` | gcp-pubsub-relayを単体起動 (port 8092) |
| **本番デプロイ** | |
| `pnpm deploy:gcp` | `task gcp:deploy:all` を実行 (要 gcloud認証) |
| `pnpm deploy:cf` | Cloudflare Workerをデプロイ (要 wrangler認証) |

### 構成B (Cloudflare + ローカルLLM) のローカル確認

```bash
# ① 各サービスを起動 (別ポートで独立起動)
docker compose -f docker-compose.dev.cloudflare.yml up
#   8787 : cf-worker-dev     (Cloudflare Workers ローカルサーバー / wrangler dev)
#   8788 : cf-queue-mock     (Cloudflare Queues モックサーバー ※ローカル開発専用)
#   3434 : local-gpu-worker  (自前GPUサーバー HTTPサーバー)

# ② 別ターミナルでダミーリクエストを送信
tsx local-test/src/test-cloudflare-flow.ts dispatch --issue-number 1 --title "テストIssue"
tsx local-test/src/test-cloudflare-flow.ts queue    --issue-number 2
tsx local-test/src/test-cloudflare-flow.ts worker   --issue-number 3
tsx local-test/src/test-cloudflare-flow.ts e2e      --issue-number 4

# Taskfile経由でも同様に実行可能
task test:cf:dispatch -- --issue-number 1
```

| サブコマンド | 送信先 | 確認できるホップ |
|---|---|---|
| `dispatch` | `cf-worker-dev` の `/dispatch` | GitHub Actions → CF Worker |
| `queue`    | `cf-queue-mock` の `/queues/:name/messages` | Queue → GPUワーカー転送ロジック単体 |
| `worker`   | `local-gpu-worker` の `/run` | GPUワーカー単体 (Queueをスキップ) |
| `e2e`      | `cf-worker-dev` の `/dispatch` | 一気通貫 (以降はwranglerのQueueシミュレーションが自動連携) |

### 構成A (Google Cloud) のローカル確認

```bash
# ① 各サービスを起動 (別ポートで独立起動)
docker compose -f docker-compose.dev.gcp.yml up
#   8085 : pubsub-emulator   (Pub/Sub エミュレータ)
#   8090 : gcp-webhook-dev   (Cloud Run Webhookレシーバー ローカルサーバー)
#   8091 : adk-worker-dev    (ADKエージェントワーカー ローカルサーバー)
#   8092 : gcp-pubsub-relay  (Pull→Push配信ブリッジ / ヘルスチェック用)

# ② 別ターミナルでダミーリクエストを送信 (署名は自動計算される)
tsx local-test/src/test-gcp-flow.ts webhook --issue-number 1 --title "テストIssue"
tsx local-test/src/test-gcp-flow.ts pubsub  --issue-number 2
tsx local-test/src/test-gcp-flow.ts worker  --issue-number 3
tsx local-test/src/test-gcp-flow.ts e2e     --issue-number 4

# Taskfile経由でも同様に実行可能
task test:gcp:webhook -- --issue-number 1
```

| サブコマンド | 送信先 | 確認できるホップ |
|---|---|---|
| `webhook` | `gcp-webhook-dev` の `/webhook` (署名付き) | GitHub → Webhookレシーバー |
| `pubsub`  | `pubsub-emulator` に直接パブリッシュ | Pub/Sub → relay → ADKワーカー |
| `worker`  | `adk-worker-dev` の `/worker` (Push形式) | ADKワーカー単体 (Pub/Subをスキップ) |
| `e2e`     | `gcp-webhook-dev` の `/webhook` | 一気通貫 (以降はrelayが自動連携) |

> **Pub/Subエミュレータについて**: gcloudのPub/SubエミュレータはPull配信のみ対応で、
> 本番のPush配信 (Cloud Run呼び出し) を再現できない。そのため `gcp-pubsub-relay` が
> Pullしたメッセージを本番と同じPush形式のJSONに変換してADKワーカーへ転送するブリッジ
> として動作する。本番デプロイ時は使用しない (実際のPub/Sub Pushサブスクリプションが
> 直接Cloud Runを呼び出す)。

### 実際にAider/Gemini ADKまで動かして確認したい場合

`DRY_RUN=false` にすると実際のgit操作・AIエージェント実行まで検証できる
(要 実際のGitHubリポジトリ・トークン・Ollama起動 or GCP認証)。

```bash
# 構成B: local-gpu-worker の環境変数を変更
#   docker-compose.dev.cloudflare.yml の DRY_RUN: "false" に変更し、
#   別途 docker-compose.local.yml で Ollama を起動しておく

# 構成A: adk-worker-dev の環境変数を変更
#   docker-compose.dev.gcp.yml の DRY_RUN: "false" に変更し、
#   GOOGLE_APPLICATION_CREDENTIALS 等で実際のGCP認証情報をマウントする
```

## セットアップ

### 構成B: コスト最小版

**ステップ1: GitHubリポジトリに Secrets を登録**
```
CF_WEBHOOK_URL   = https://your-worker.your-subdomain.workers.dev
CF_WEBHOOK_TOKEN = (openssl rand -hex 32 で生成した値)
```

**ステップ2: Cloudflare Worker をデプロイ**
```bash
task cf:deploy
task cf:secret:set  # CF_WEBHOOK_TOKEN と LOCAL_WORKER_TOKEN を登録
```

**ステップ3: 自前GPUサーバーで起動**
```bash
cp .env.example .env.local
# .env.local に GITHUB_TOKEN, LOCAL_WORKER_TOKEN を設定
docker compose -f docker-compose.local.yml up -d

# Ollamaにモデルを追加
docker compose -f docker-compose.local.yml exec ollama ollama pull qwen2.5-coder:32b
```

**ステップ4: Cloudflare Tunnel URLを設定**
```bash
# docker composeのログからTunnel URLを確認
docker compose -f docker-compose.local.yml logs cloudflared
# → "https://xxxx-xxxx.trycloudflare.com" が発行される

# wrangler.jsonc の LOCAL_WORKER_ENDPOINT に設定して再デプロイ
task cf:deploy
```

**以降は自動**: IssueをopenするだけでPRが作成される

---

### 構成A: Google Cloud版

構成Aをデプロイするには、事前にGoogle Cloud側でプロジェクトの作成・請求先の紐付けが必要です。
`task gcp:setup` は各種APIの有効化などを自動で行いますが、**プロジェクトの作成と請求先アカウントの紐付けだけは手動**です(危険な操作のため自動化していません)。

#### ① Google Cloud プロジェクトを作成する

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセスし、Googleアカウントでログイン
2. 画面上部のプロジェクト選択メニュー →「新しいプロジェクト」
3. プロジェクト名を入力 (表示名。日本語可、あとから変更可)
4. **プロジェクトID** を確認・メモする — これが `.env.local` の `GCP_PROJECT` に設定する値
   - 自動生成されるが、「編集」で自分で指定することも可能
   - 一度作成すると**変更不可**。世界で一意。6〜30文字の英小文字・数字・ハイフンのみ
   - 「プロジェクト**名**」と「プロジェクト**ID**」は別物。**必ずIDの方を使うこと**(今回のエラーもここが原因になりがち)
5. 「作成」をクリック

既存プロジェクトのIDを確認・一覧したい場合:
```bash
gcloud projects list
```

#### ② 請求先アカウント (Billing) を紐付ける

Cloud Run / Pub/Sub / Artifact Registry などには無料枠がありますが、**請求先アカウントが紐付いていないとAPIの有効化自体ができません**。

1. Console左メニュー →「お支払い」
2. 対象プロジェクトに請求先アカウントをリンク (未作成の場合はクレジットカード登録が必要)
3. リンク済みか確認: 「お支払い」画面で対象プロジェクトに請求先アカウント名が表示されていればOK

#### ③ 有効化されるAPI (参考)

`task gcp:setup` が下記APIを自動で有効化するため、手動で個別に有効化する必要はない。参考情報として掲載する。

| API | 用途 |
|---|---|
| Cloud Run Admin API (`run.googleapis.com`) | Webhookレシーバー・ADKワーカーのデプロイ先 |
| Cloud Pub/Sub API (`pubsub.googleapis.com`) | Issue受信→ワーカー起動のキュー |
| Artifact Registry API (`artifactregistry.googleapis.com`) | Dockerイメージの保管 |
| Secret Manager API (`secretmanager.googleapis.com`) | GitHubトークン・Webhookシークレットの保管 |
| Cloud Build API (`cloudbuild.googleapis.com`) | CI/CDパイプライン |
| IAM API (`iam.googleapis.com`) | サービスアカウントの権限管理 |
| Eventarc API (`eventarc.googleapis.com`) | イベント駆動連携 |

手動でConsoleから有効化したい場合は「APIとサービス」→「ライブラリ」→ 上記API名で検索 →「有効にする」。

#### ④ gcloud CLI のセットアップ

```bash
# ブラウザでログイン
gcloud auth login

# デフォルトプロジェクトを設定 (以後の gcloud コマンドの対象になる)
gcloud config set project <あなたのプロジェクトID>

# Node.jsのクライアントライブラリ (Secret Manager / Pub/Sub 等) が使う認証情報を設定
gcloud auth application-default login

# Dockerイメージpush用の認証 (docker:build:webhook / worker で使用)
gcloud auth configure-docker asia-northeast1-docker.pkg.dev
```

#### ⑤ 必要な権限

デプロイを実行するGoogleアカウントには、対象プロジェクトで以下のいずれかの権限が必要。

- 手早く進めたい場合: **オーナー (`roles/owner`)**
- 最小権限にしたい場合: 以下をまとめて付与
  - `roles/run.admin` (Cloud Run)
  - `roles/pubsub.admin` (Pub/Sub)
  - `roles/artifactregistry.admin` (Artifact Registry)
  - `roles/secretmanager.admin` (Secret Manager)
  - `roles/iam.serviceAccountAdmin` (サービスアカウント作成)
  - `roles/iam.securityAdmin` (IAMポリシーのbinding付与)
  - `roles/serviceusage.serviceUsageAdmin` (API有効化)
  - `roles/cloudbuild.builds.editor` (Cloud Build)

個人の検証目的であれば、オーナー権限で進めるのが簡単。

#### ⑥ .env.local に設定

```bash
cp .env.example .env.local
```
`.env.local` を開き、`GCP_PROJECT` に①で確認した**実際のプロジェクトID**を設定する:
```
GCP_PROJECT=あなたのプロジェクトID
```

> **重要**: `Taskfile.yml` は `.env.local` (無ければ `.env`) を自動的に読み込む。
> `GCP_PROJECT` を設定せずに `task gcp:setup` 等を実行すると、
> プレースホルダーの `your-gcp-project-id` のまま実行され、
> 存在しないプロジェクトとして扱われてエラーになる
> (下記「トラブルシューティング」参照)。

#### デプロイ

```bash
task gcp:setup    # API有効化 / Pub/Sub / Artifact Registry / Secret Manager
# Webhookシークレットを登録 (値は下記「GitHub Appを使った他リポジトリへの展開」で決める)
echo -n "your-webhook-secret" | gcloud secrets versions add GITHUB_WEBHOOK_SECRET --data-file=-
# GitHub Appの秘密鍵を登録 (同じく下記セクションで作成する)
gcloud secrets versions add GITHUB_APP_PRIVATE_KEY --data-file=path/to/private-key.pem
```
`.env.local` に `GITHUB_APP_ID` (下記で作成するGitHub AppのApp ID) を設定してから:
```bash
task gcp:deploy:all
```
Cloud Build トリガーをコンソールで2本設定:
- mainブランチ push → `cloudbuild/cloudbuild.yaml`
- PR作成 → `cloudbuild/cloudbuild.pr.yaml`

> このプロジェクトは元々、GitHubの個人アクセストークン(PAT)をSecret Managerに
> 保管してgit操作を行う設計でしたが、**現在はGitHub Appを使う方式が標準**になっています。
> PATを使わないことで、①長期間有効な強い権限のトークンを保管しなくて済む、
> ②taptappunさん以外の第三者が自分のリポジトリに対してGCPアカウントを
> 作ることなくこのシステムを使えるようになる、という2つの利点があります。
> (旧来のPAT方式も後方互換のフォールバックとして残っていますが非推奨です)

## GitHub Appを使った他リポジトリへの展開

このシステムは GitHub App の「インストール」という仕組みを使うことで、
**運営者(あなた)が一度だけGCP環境を用意すれば、他の誰かが自分のGCPアカウントを
一切作らずに、自分のリポジトリでこのシステムを使えるようにする**ことができる。

### 登場人物の整理

| 役割 | やること |
|---|---|
| **運営者 (あなた)** | GCP環境を1つ持ち、GitHub Appを1つ作成する。秘密鍵を自分のSecret Managerに保管する |
| **利用者(他の人)** | GitHub App のインストールページで「Install」を押すだけ。GCPのことは何も知らなくてよい |

### 動作の仕組み (参考)

1. 利用者がGitHub Appを自分のリポジトリにインストールする
2. 利用者のリポジトリでIssueが作成されると、GitHub Appのwebhook設定に従って
   運営者のCloud Run (`github-webhook-receiver`) にイベントが届く。
   このとき、ペイロードに「どのインストールからのイベントか」を示す
   `installation.id` が自動的に含まれる
3. Webhookレシーバーがこの`installation.id`をPub/Subメッセージに含めて送る
4. ADKワーカーが、運営者のGitHub App秘密鍵(Secret Manager保管)と
   受け取った`installation.id`を使って、**そのリポジトリだけに使える・
   約1時間で失効する**アクセストークンをその場で発行し、git push・PR作成を行う

利用者からPAT等の情報を受け取る必要は一切ない。

### ① GitHub App を作成する (運営者のみ・1回だけ)

1. GitHubの自分のアカウント (または組織) の Settings → **Developer settings** → **GitHub Apps** → **New GitHub App**
2. 以下を入力する

   | 項目 | 値 |
   |---|---|
   | GitHub App name | 好きな名前 (例: `my-devops-ai-agent`。これがインストールURLに使われる) |
   | Homepage URL | 何でもよい (例: このリポジトリのURL) |
   | Webhook > Active | ✅ チェックする |
   | Webhook URL | `task gcp:deploy:webhook` 実行後に出力される Webhook URL (`https://xxxx.a.run.app/webhook`) |
   | Webhook secret | 適当なランダム文字列を生成して入力 (例: `openssl rand -hex 32`)。これが Secret Manager の `GITHUB_WEBHOOK_SECRET` になる |
   | Permissions > Repository permissions > **Contents** | **Read and write** |
   | Permissions > Repository permissions > **Pull requests** | **Read and write** |
   | Permissions > Repository permissions > **Issues** | Read-only (必須ではないが推奨) |
   | Subscribe to events | **Issues** にチェック |
   | Where can this GitHub App be installed? | **Any account** (他リポジトリ/他ユーザーにも展開したい場合) |

3. 「Create GitHub App」をクリック
4. 作成後の画面で **App ID** をメモする (`.env.local` の `GITHUB_APP_ID` に使う)
5. 「Generate a private key」をクリックし、`.pem` ファイルをダウンロードする

### ② 秘密鍵とWebhookシークレットをGCPに登録する

```bash
# Webhookシークレット (①で決めたランダム文字列と同じ値)
echo -n "①で決めたランダム文字列" | gcloud secrets versions add GITHUB_WEBHOOK_SECRET --data-file=- --project=<プロジェクトID>

# GitHub Appの秘密鍵 (①でダウンロードした.pemファイルをそのまま渡す)
gcloud secrets versions add GITHUB_APP_PRIVATE_KEY --data-file=path/to/private-key.pem --project=<プロジェクトID>
```

`.env.local` に App ID を設定する:
```
GITHUB_APP_ID=①でメモしたApp ID
```

### ③ (推奨) 許可リポジトリを制限する

GitHub Appを「Any account」でインストール可能にすると、見知らぬ第三者が
勝手にインストールしてCloud Run/Gemini APIの実行コストを消費させる可能性がある。
これを防ぐため、利用を許可するリポジトリを制限できる:

`.env.local` に追加:
```
ALLOWED_REPOS=owner1/repo1,owner2/repo2
```

設定後、Webhookレシーバーを再デプロイして反映する:
```bash
task gcp:deploy:webhook
```

新しい利用者を許可したくなったら、`ALLOWED_REPOS` にリポジトリを追加して
同じコマンドで再デプロイすればよい。未設定 (空) の場合は全リポジトリを許可する。

### ④ 利用者への案内

利用者は、以下のURLを開いて「Install」を押すだけで使えるようになる
(`<App名>` は①で決めた名前):
```
https://github.com/apps/<App名>/installations/new
```

利用者向けの説明・トラブルシューティングは、デモ用に用意した
[demo-repo-README.md](https://github.com/TakuKobayashi/ai-agent-demo-genarator-demo-project)
のような、利用者にそのまま渡せる簡潔なREADMEを別リポジトリに配置しておくとよい。

### トラブルシューティング (構成A)

#### `docker build` 時に `ERR_PNPM_OUTDATED_LOCKFILE` / `Cannot install with "frozen-lockfile"` というエラーが出る

このプロジェクトは pnpm workspace 構成で、依存関係を解決する `pnpm-lock.yaml` は
**リポジトリルートに1つだけ**存在する想定になっている。

`gcp-webhook/` や `local-worker/` などのサブパッケージディレクトリの中で直接
`npm install` や (`--filter` を使わない) `pnpm install` を実行すると、
そのディレクトリの中にルートとは別の、単体の `pnpm-lock.yaml` が
生成されてしまうことがある。これが存在すると、Dockerビルド時に
ルートの `package.json` (依存関係) との内容不一致で `--frozen-lockfile` が失敗する。

**対処法**: 該当ディレクトリに紛れ込んだ `pnpm-lock.yaml` を削除し、
依存関係のインストールは必ずリポジトリルートから行う。

```bash
# 例: gcp-webhook配下に紛れ込んでいた場合
rm gcp-webhook/pnpm-lock.yaml

# ルートから正しくインストールし直す
pnpm install
# または
pnpm run install:all
```

以後は `cd gcp-webhook && pnpm install` のようにサブディレクトリへ移動して
直接インストールコマンドを実行せず、リポジトリルートから
`pnpm install` (全体) または `pnpm --filter ./gcp-webhook <script>` を使うこと。

#### `Project 'your-gcp-project-id' not found or permission denied` というエラーが出る

`.env.local` の `GCP_PROJECT` が未設定か、プレースホルダーのままになっている。
上記①・⑥の手順で実際のプロジェクトIDを設定すること。
`gcp:setup` / `gcp:deploy:webhook` / `gcp:deploy:worker` は、この状態のままだと
実行前に日本語のエラーメッセージで停止するようになっている
(それでもこのエラーが出る場合は `.env.local` の保存やタイポを再確認)。

#### `does not have permission to access projects instance` というエラーが出る

以下のいずれかが原因:
- プロジェクトIDのタイポ、あるいはプロジェクト**名**とプロジェクト**ID**の混同 (①を参照)
- `gcloud auth login` で使っているアカウントに、そのプロジェクトへのアクセス権がない (⑤を参照)
- プロジェクトがまだ作成されていない (①を参照)

現在ログイン中のアカウント・プロジェクト一覧の確認:
```bash
gcloud auth list
gcloud projects list
```

#### `FAILED_PRECONDITION` など、請求関連のエラーが出る

②の請求先アカウントの紐付けができていない。Console →「お支払い」から紐付けること。

#### Issueを作成してもWebhookレシーバーに何も届かない (GitHub App利用時)

以下を順に確認する:
1. GitHub Appが対象リポジトリにインストールされているか (GitHub Appの設定画面 → Install App)
2. GitHub Appの Webhook URL が、実際にデプロイした `github-webhook-receiver` のURLと一致しているか
   (`task gcp:deploy:webhook` の出力、または `gcloud run services describe github-webhook-receiver ...` で再確認できる)
3. GitHub Appの設定画面 → **Advanced** → **Recent Deliveries** で、実際にWebhookが送信され
   どんなレスポンスが返っているかを確認する (署名エラーなら401、許可リポジトリ外なら200 skippedが返る)

#### `署名が無効です` (401) が返る

GitHub App の Webhook secret と、Secret Manager の `GITHUB_WEBHOOK_SECRET` の値が
一致していない。GitHub Appの設定画面から Webhook secret を再設定するか、
Secret Managerの値を再登録して揃えること:
```bash
echo -n "GitHub App設定画面と同じ値" | gcloud secrets versions add GITHUB_WEBHOOK_SECRET --data-file=- --project=<プロジェクトID>
```

#### `repository 'xxx/yyy' is not in ALLOWED_REPOS` としてスキップされる (200が返るのでエラーには見えない)

意図的な仕様。`ALLOWED_REPOS` に対象リポジトリが含まれていない。
運営者側で `.env.local` の `ALLOWED_REPOS` にリポジトリを追加し、
`task gcp:deploy:webhook` で再デプロイすること。

#### ワーカーのログに `GITHUB_APP_ID が未設定です` と出る

ADKワーカー (`adk-agent-worker`) の環境変数に `GITHUB_APP_ID` が設定されていない。
`.env.local` に `GITHUB_APP_ID` を設定してから `task gcp:deploy:worker` を再実行すること。

#### PRの作成には成功するが、想定と違うリポジトリに作られる/認証エラーになる

GitHub Appのインストールが複数リポジトリ・複数アカウントにまたがっている場合、
`installation.id` は「そのインストール単位」を指す (1インストールが複数リポジトリを
含むことがある)。発行されるトークンは、そのインストールが許可している
リポジトリの範囲でのみ有効なため、通常は誤ったリポジトリを操作することはない。
それでも問題が起きる場合は、GitHub App側の Repository access 設定
(Only select repositories を推奨) を確認すること。

