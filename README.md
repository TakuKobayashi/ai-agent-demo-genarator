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
#   8080 : gcp-webhook-dev   (Cloud Run Webhookレシーバー ローカルサーバー)
#   8086 : gcp-pubsub-relay  (Pull→Push配信ブリッジ / ヘルスチェック用)
#   8081 : adk-worker-dev    (ADKエージェントワーカー ローカルサーバー)

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
