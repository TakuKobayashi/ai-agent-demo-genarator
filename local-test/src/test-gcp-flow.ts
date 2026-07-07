#!/usr/bin/env tsx
/**
 * local-test/src/test-gcp-flow.ts
 *
 * 構成A (GitHub → Cloud Run Webhook → Pub/Sub → Cloud Run ADKワーカー)
 * のローカル動作確認スクリプト。
 *
 * パイプラインの各ホップを個別に叩けるサブコマンドと、
 * 一気通貫でテストする e2e サブコマンドを提供する。
 *
 * 使用例:
 *   # ① GitHub Webhook (署名付き) → gcp-webhook /webhook
 *   tsx local-test/src/test-gcp-flow.ts webhook --issue-number 42 --title "テストIssue"
 *
 *   # ② Pub/Subエミュレータへの直接パブリッシュ
 *   tsx local-test/src/test-gcp-flow.ts pubsub --issue-number 42
 *
 *   # ③ ADKワーカーへの直接リクエスト (Pub/Subをスキップ)
 *   tsx local-test/src/test-gcp-flow.ts worker --issue-number 42
 *
 *   # ④ 一気通貫 (webhook → Pub/Sub → gcp-pubsub-relay → ワーカー が自動連携)
 *   tsx local-test/src/test-gcp-flow.ts e2e --issue-number 42
 *
 * docker-compose.dev.gcp.yml で起動したサービスに対して送信する想定:
 *   pubsub-emulator  : localhost:8085        (Pub/Sub エミュレータ)
 *   gcp-webhook-dev  : http://localhost:8090 (Cloud Run Webhookレシーバー ローカルサーバー)
 *   gcp-pubsub-relay : http://localhost:8092 (Push配信ブリッジ / ヘルスチェック用)
 *   adk-worker-dev   : http://localhost:8091 (ADKエージェントワーカー ローカルサーバー)
 */

import { Command } from "commander";
import { PubSub } from "@google-cloud/pubsub";
import {
  DEFAULT_DUMMY_ISSUE,
  buildGithubWebhookPayload,
  buildQueueMessage,
  buildPubSubPushEnvelope,
  computeGithubSignature,
  printResponse,
  type DummyIssueOptions,
} from "./lib/dummy-issue.js";

// ─── 共通オプション定義 ───────────────────────────────────────────────────────

interface CommonIssueOpts {
  issueNumber: string;
  title: string;
  body: string;
  author: string;
  repo: string;
  branch: string;
}

function addCommonIssueOptions(cmd: Command): Command {
  return cmd
    .option("--issue-number <number>", "Issue番号", String(DEFAULT_DUMMY_ISSUE.issueNumber))
    .option("--title <title>", "Issueタイトル", DEFAULT_DUMMY_ISSUE.title)
    .option("--body <body>", "Issue本文", DEFAULT_DUMMY_ISSUE.body)
    .option("--author <author>", "Issue作成者", DEFAULT_DUMMY_ISSUE.author)
    .option("--repo <owner/repo>", "対象リポジトリ", DEFAULT_DUMMY_ISSUE.repo)
    .option("--branch <branch>", "デフォルトブランチ", DEFAULT_DUMMY_ISSUE.branch);
}

function toDummyIssueOptions(opts: CommonIssueOpts): DummyIssueOptions {
  return {
    issueNumber: Number(opts.issueNumber),
    title: opts.title,
    body: opts.body,
    author: opts.author,
    repo: opts.repo,
    branch: opts.branch,
  };
}

// ─── プログラム定義 ───────────────────────────────────────────────────────────

const program = new Command();
program
  .name("test-gcp-flow")
  .description(
    "構成A (GitHub → Cloud Run Webhook → Pub/Sub → Cloud Run ADKワーカー) のローカル動作確認スクリプト"
  );

// ─── ① webhook: GitHub Webhook (署名付き) → gcp-webhook /webhook ─────────────

addCommonIssueOptions(
  program
    .command("webhook")
    .description("GitHubのIssue Webhookをシミュレートし、署名付きでgcp-webhookの /webhook へ送信する")
)
  .option("--url <url>", "gcp-webhookのURL", "http://localhost:8090")
  .option("--secret <secret>", "GITHUB_WEBHOOK_SECRET", "local-dev-webhook-secret")
  .action(async (opts: CommonIssueOpts & { url: string; secret: string }) => {
    const payload = buildGithubWebhookPayload(toDummyIssueOptions(opts));
    const rawBody = JSON.stringify(payload);
    const signature = computeGithubSignature(rawBody, opts.secret);

    console.log(`📤 POST ${opts.url}/webhook`);
    console.log(`   X-GitHub-Event: issues`);
    console.log(`   X-Hub-Signature-256: ${signature}`);
    console.log(rawBody);

    const res = await fetch(`${opts.url}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-Hub-Signature-256": signature,
      },
      body: rawBody,
    });

    await printResponse("gcp-webhook /webhook", res);
  });

// ─── ② pubsub: Pub/Subエミュレータへの直接パブリッシュ ───────────────────────

addCommonIssueOptions(
  program
    .command("pubsub")
    .description("Pub/Subエミュレータのトピックに直接メッセージをパブリッシュする (webhookをスキップして疎通確認)")
)
  .option("--project <project>", "GCPプロジェクトID", "local-dev-project")
  .option("--topic <topic>", "Pub/Subトピック名", "github-issues")
  .option(
    "--emulator-host <host:port>",
    "Pub/Subエミュレータのホスト:ポート",
    "localhost:8085"
  )
  .action(
    async (
      opts: CommonIssueOpts & { project: string; topic: string; emulatorHost: string }
    ) => {
      process.env["PUBSUB_EMULATOR_HOST"] = opts.emulatorHost;

      const message = buildQueueMessage(toDummyIssueOptions(opts));
      console.log(`📤 Pub/Sub パブリッシュ: project=${opts.project} topic=${opts.topic}`);
      console.log(`   PUBSUB_EMULATOR_HOST=${opts.emulatorHost}`);
      console.log(JSON.stringify(message, null, 2));

      const pubsub = new PubSub({ projectId: opts.project });
      const topic = pubsub.topic(opts.topic);

      try {
        const messageId = await topic.publishMessage({
          json: message,
          attributes: {
            issueNumber: String(message.issueNumber),
            repo: message.repoFullName,
            source: "local-test-script",
          },
        });
        console.log(`\n✅ パブリッシュ完了: messageId=${messageId}`);
        console.log(
          `\nℹ️  gcp-pubsub-relay がこのメッセージをPullし、ADKワーカーへPush形式で転送します。`
        );
        console.log(
          `   docker compose -f docker-compose.dev.gcp.yml logs -f gcp-pubsub-relay adk-worker-dev で確認できます`
        );
      } catch (err) {
        console.error(`\n❌ パブリッシュ失敗:`, err);
        process.exitCode = 1;
      }
    }
  );

// ─── ③ worker: ADKワーカーへの直接リクエスト (Pub/Subをスキップ) ─────────────

addCommonIssueOptions(
  program
    .command("worker")
    .description(
      "ADKワーカー (adk-worker-dev) の /worker に、本番のPub/Sub Push形式そのままで直接送信する (Pub/Subをスキップして疎通確認)"
    )
)
  .option("--url <url>", "adk-worker-devのURL", "http://localhost:8091")
  .option("--project <project>", "GCPプロジェクトID", "local-dev-project")
  .action(async (opts: CommonIssueOpts & { url: string; project: string }) => {
    const envelope = buildPubSubPushEnvelope(toDummyIssueOptions(opts), opts.project);

    console.log(`📤 POST ${opts.url}/worker`);
    console.log(JSON.stringify(envelope, null, 2));

    const res = await fetch(`${opts.url}/worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });

    await printResponse("adk-worker-dev /worker", res);
  });

// ─── ④ e2e: 一気通貫テスト ────────────────────────────────────────────────────

addCommonIssueOptions(
  program
    .command("e2e")
    .description(
      "GitHub Webhook → gcp-webhook → Pub/Sub → gcp-pubsub-relay → ADKワーカー を一気通貫でテストする (webhookのみ叩き、以降は自動連携を待つ)"
    )
)
  .option("--url <url>", "gcp-webhookのURL", "http://localhost:8090")
  .option("--secret <secret>", "GITHUB_WEBHOOK_SECRET", "local-dev-webhook-secret")
  .action(async (opts: CommonIssueOpts & { url: string; secret: string }) => {
    const payload = buildGithubWebhookPayload(toDummyIssueOptions(opts));
    const rawBody = JSON.stringify(payload);
    const signature = computeGithubSignature(rawBody, opts.secret);

    console.log("🚀 e2eテスト開始: GitHub Webhook → gcp-webhook → Pub/Sub → ADKワーカー");
    console.log(`📤 POST ${opts.url}/webhook`);

    const res = await fetch(`${opts.url}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-Hub-Signature-256": signature,
      },
      body: rawBody,
    });

    await printResponse("gcp-webhook /webhook", res);

    console.log(`
ℹ️  gcp-webhook が Pub/Sub へのパブリッシュに成功していれば、
   gcp-pubsub-relay が自動的にメッセージをPullし、ADKワーカーへPush形式で転送します。
   以下のログで進行状況を確認してください:
     docker compose -f docker-compose.dev.gcp.yml logs -f gcp-webhook-dev gcp-pubsub-relay adk-worker-dev
`);
  });

program.parseAsync(process.argv);
