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
task gcp:setup    # API有効化 / Pub/Sub / Artifact Registry
# Secret Manager にトークン登録
echo -n "your-webhook-secret" | gcloud secrets versions add GITHUB_WEBHOOK_SECRET --data-file=-
echo -n "ghp_token"           | gcloud secrets versions add GITHUB_TOKEN --data-file=-
task gcp:deploy:all
```
Cloud Build トリガーをコンソールで2本設定:
- mainブランチ push → `cloudbuild/cloudbuild.yaml`
- PR作成 → `cloudbuild/cloudbuild.pr.yaml`

### トラブルシューティング (構成A)

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

