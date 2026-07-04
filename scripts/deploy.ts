#!/usr/bin/env tsx
/**
 * scripts/deploy.ts
 * Google Cloud / Cloudflare へのデプロイ補助スクリプト
 *
 * 使用例:
 *   tsx scripts/deploy.ts gcp:setup --project my-project --region asia-northeast1 ...
 *   tsx scripts/deploy.ts gcp:deploy-webhook ...
 *   tsx scripts/deploy.ts gcp:deploy-worker ...
 *   tsx scripts/deploy.ts cf:deploy
 */

import { execSync } from "node:child_process";
import { Command } from "commander";

// ─── ユーティリティ ───────────────────────────────────────────────────────────

function run(cmd: string, opts: { cwd?: string; ignoreError?: boolean } = {}): void {
  console.log(`\n▶ ${cmd}\n`);
  try {
    execSync(cmd, { stdio: "inherit", cwd: opts.cwd, env: { ...process.env } });
  } catch (err) {
    if (!opts.ignoreError) throw err;
    console.warn(`⚠️  コマンドはエラーで終了しましたが無視します: ${cmd}`);
  }
}

function capture(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", env: { ...process.env } }).trim();
}

function section(title: string): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(60)}\n`);
}

// ─── プログラム定義 ───────────────────────────────────────────────────────────

const program = new Command();
program.name("deploy").description("DevOps AI Agent デプロイスクリプト");

// ─── gcp:setup ───────────────────────────────────────────────────────────────

program
  .command("gcp:setup")
  .description("GCPの初期リソースを一括作成 (API有効化 / Pub/Sub / Artifact Registry / Secret Manager)")
  .requiredOption("--project <project>", "GCPプロジェクトID")
  .requiredOption("--region <region>", "GCPリージョン")
  .requiredOption("--topic <topic>", "Pub/Subトピック名")
  .requiredOption("--artifact-repo <repo>", "Artifact Registryリポジトリ名")
  .action((opts: { project: string; region: string; topic: string; artifactRepo: string }) => {
    section("GCP 初期セットアップ");

    // ① 必要なAPIを有効化
    run([
      "gcloud services enable",
      "run.googleapis.com",
      "pubsub.googleapis.com",
      "artifactregistry.googleapis.com",
      "secretmanager.googleapis.com",
      "cloudbuild.googleapis.com",
      "iam.googleapis.com",
      "eventarc.googleapis.com",
      `--project=${opts.project}`,
    ].join(" "));

    // ② Artifact Registry リポジトリ
    run([
      `gcloud artifacts repositories create ${opts.artifactRepo}`,
      `--repository-format=docker`,
      `--location=${opts.region}`,
      `--description="DevOps AI Agent コンテナイメージ"`,
      `--project=${opts.project}`,
    ].join(" "), { ignoreError: true });

    // ③ Pub/Sub トピック
    run(`gcloud pubsub topics create ${opts.topic} --project=${opts.project}`, {
      ignoreError: true,
    });

    // ④ Secret Manager のシークレット枠を作成 (値は別途設定)
    for (const secretName of ["GITHUB_WEBHOOK_SECRET", "GITHUB_TOKEN"]) {
      run(`gcloud secrets create ${secretName} --replication-policy=automatic --project=${opts.project}`, {
        ignoreError: true,
      });
    }

    console.log(`
✅ GCP初期セットアップ完了

次のステップ:
  1. Secret Manager にシークレットの値を設定してください:
     gcloud secrets versions add GITHUB_WEBHOOK_SECRET --data-file=- --project=${opts.project}
     gcloud secrets versions add GITHUB_TOKEN --data-file=- --project=${opts.project}

  2. task gcp:deploy:all を実行してください
`);
  });

// ─── gcp:deploy-webhook ──────────────────────────────────────────────────────

program
  .command("gcp:deploy-webhook")
  .description("WebhookレシーバーをCloud Runにデプロイ")
  .requiredOption("--project <project>", "GCPプロジェクトID")
  .requiredOption("--region <region>", "GCPリージョン")
  .requiredOption("--service <service>", "Cloud Runサービス名")
  .requiredOption("--image <image>", "コンテナイメージURI")
  .requiredOption("--topic <topic>", "Pub/Subトピック名")
  .action((opts: { project: string; region: string; service: string; image: string; topic: string }) => {
    section("Webhookレシーバー Cloud Run デプロイ");

    const sa = `${opts.service}-sa`;
    const saEmail = `${sa}@${opts.project}.iam.gserviceaccount.com`;

    // サービスアカウント作成
    run(`gcloud iam service-accounts create ${sa} --display-name="Webhook Receiver SA" --project=${opts.project}`, {
      ignoreError: true,
    });

    // 権限付与: Pub/Sub パブリッシャー + Secret アクセス
    for (const role of ["roles/pubsub.publisher", "roles/secretmanager.secretAccessor"]) {
      run(`gcloud projects add-iam-policy-binding ${opts.project} --member="serviceAccount:${saEmail}" --role="${role}"`);
    }

    // Cloud Run デプロイ
    run([
      `gcloud run deploy ${opts.service}`,
      `--image=${opts.image}`,
      `--region=${opts.region}`,
      `--platform=managed`,
      `--allow-unauthenticated`,   // GitHub Webhookからの受信
      `--service-account=${saEmail}`,
      `--set-env-vars=GCP_PROJECT=${opts.project},PUBSUB_TOPIC=${opts.topic}`,
      `--memory=512Mi`,
      `--cpu=1`,
      `--concurrency=80`,
      `--project=${opts.project}`,
    ].join(" "));

    const url = capture([
      `gcloud run services describe ${opts.service}`,
      `--region=${opts.region}`,
      `--project=${opts.project}`,
      `--format="value(status.url)"`,
    ].join(" "));

    console.log(`
✅ Webhookレシーバーのデプロイ完了

📌 Webhook URL: ${url}/webhook
👉 このURLをGitHubリポジトリの Settings > Webhooks に設定してください
   Content-Type: application/json
   Events: Issues
`);
  });

// ─── gcp:deploy-worker ───────────────────────────────────────────────────────

program
  .command("gcp:deploy-worker")
  .description("ADKエージェントワーカーをCloud RunにデプロイしPub/Sub Pushサブスクリプションを設定")
  .requiredOption("--project <project>", "GCPプロジェクトID")
  .requiredOption("--region <region>", "GCPリージョン")
  .requiredOption("--service <service>", "Cloud Runサービス名")
  .requiredOption("--image <image>", "コンテナイメージURI")
  .requiredOption("--topic <topic>", "Pub/Subトピック名")
  .requiredOption("--subscription <subscription>", "Pub/Subサブスクリプション名")
  .action((opts: {
    project: string; region: string; service: string;
    image: string; topic: string; subscription: string;
  }) => {
    section("ADKエージェントワーカー Cloud Run デプロイ");

    const sa = `${opts.service}-sa`;
    const saEmail = `${sa}@${opts.project}.iam.gserviceaccount.com`;

    // サービスアカウント作成
    run(`gcloud iam service-accounts create ${sa} --display-name="ADK Worker SA" --project=${opts.project}`, {
      ignoreError: true,
    });

    // 権限付与: Secret アクセス
    run(`gcloud projects add-iam-policy-binding ${opts.project} --member="serviceAccount:${saEmail}" --role="roles/secretmanager.secretAccessor"`);

    // Pub/Sub が Cloud Run を呼び出すための権限
    const projectNumber = capture(`gcloud projects describe ${opts.project} --format="value(projectNumber)"`);
    const pubsubSa = `service-${projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`;
    run(`gcloud projects add-iam-policy-binding ${opts.project} --member="serviceAccount:${pubsubSa}" --role="roles/iam.serviceAccountTokenCreator"`);

    // Cloud Run デプロイ (no-allow-unauthenticated = Pub/Sub Pushのみ受け付ける)
    run([
      `gcloud run deploy ${opts.service}`,
      `--image=${opts.image}`,
      `--region=${opts.region}`,
      `--platform=managed`,
      `--no-allow-unauthenticated`,
      `--service-account=${saEmail}`,
      `--set-env-vars=GCP_PROJECT=${opts.project},AGENT_MODE=GEMINI_ADK`,
      `--memory=2Gi`,
      `--cpu=2`,
      `--timeout=3600`,         // エージェント実行に十分な時間
      `--concurrency=1`,         // 1コンテナ=1Issueで安全に処理
      `--max-instances=10`,
      `--project=${opts.project}`,
    ].join(" "));

    const serviceUrl = capture([
      `gcloud run services describe ${opts.service}`,
      `--region=${opts.region}`,
      `--project=${opts.project}`,
      `--format="value(status.url)"`,
    ].join(" "));

    // Pub/Sub Push サブスクリプション作成
    run([
      `gcloud pubsub subscriptions create ${opts.subscription}`,
      `--topic=${opts.topic}`,
      `--push-endpoint=${serviceUrl}/worker`,
      `--push-auth-service-account=${saEmail}`,
      `--ack-deadline=600`,
      `--project=${opts.project}`,
    ].join(" "), { ignoreError: true });

    console.log(`
✅ ADKエージェントワーカーのデプロイ完了

アーキテクチャ:
  GitHub Issue → Webhook (${serviceUrl}/webhook)
               → Pub/Sub (${opts.topic})
               → Cloud Run Worker (${serviceUrl}/worker)
               → Gemini ADK Agent
               → PR作成
`);
  });

// ─── cf:deploy ───────────────────────────────────────────────────────────────

program
  .command("cf:deploy")
  .description("Cloudflare Workerをビルド&デプロイ")
  .action(() => {
    section("Cloudflare Worker デプロイ");
    run("pnpm --filter ./cloudflare-workers exec wrangler deploy");
    console.log(`
✅ Cloudflare Workerのデプロイ完了

シークレットの設定:
  task cf:secret:set
`);
  });

program.parse();
