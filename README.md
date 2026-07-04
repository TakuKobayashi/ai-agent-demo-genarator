# DevOps AI Agent

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
│   └── wrangler.jsonc
├── local-worker/
│   └── src/server.ts             # 【構成B】自前GPUサーバー HTTPサーバー
├── src/
│   └── worker-entrypoint.ts      # 【構成A】ADKエージェント本体
├── cloudbuild/
│   ├── cloudbuild.yaml           # 【構成A】CI/CD 本番デプロイ
│   └── cloudbuild.pr.yaml        # 【構成A】CI/CD PRチェック
├── Dockerfile.webhook            # 【構成A】Cloud Run Webhook用
├── Dockerfile.worker             # 【構成A】Cloud Run Worker用
├── Dockerfile.local-worker       # 【構成B】自前GPUサーバー用
├── docker-compose.local.yml      # 【構成B】Ollama+Worker+Tunnel一括起動
├── scripts/deploy.ts             # デプロイ補助スクリプト
└── Taskfile.yml
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
