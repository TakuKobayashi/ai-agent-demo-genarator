#!/usr/bin/env tsx
/**
 * local-test/src/test-cloudflare-flow.ts
 *
 * 構成B (GitHub Actions → Cloudflare Workers → Cloudflare Queues → 自前GPUワーカー)
 * のローカル動作確認スクリプト。
 *
 * パイプラインの各ホップを個別に叩けるサブコマンドと、
 * 一気通貫でテストする e2e サブコマンドを提供する。
 *
 * 使用例:
 *   # ① GitHub Actions → Cloudflare Worker /dispatch
 *   tsx local-test/src/test-cloudflare-flow.ts dispatch --issue-number 42 --title "テストIssue"
 *
 *   # ② Cloudflare Queues (mock) への直接投入
 *   tsx local-test/src/test-cloudflare-flow.ts queue --issue-number 42
 *
 *   # ③ 自前GPUワーカーへの直接リクエスト (Queueをスキップ)
 *   tsx local-test/src/test-cloudflare-flow.ts worker --issue-number 42
 *
 *   # ④ 一気通貫 (dispatch → CFワーカーの queue() → ワーカー が自動連携)
 *   tsx local-test/src/test-cloudflare-flow.ts e2e --issue-number 42
 *
 * docker-compose.dev.cloudflare.yml で起動したサービスに対して送信する想定:
 *   cf-worker-dev   : http://localhost:8787  (Cloudflare Workers ローカルサーバー)
 *   cf-queue-mock   : http://localhost:8788  (Cloudflare Queues モックサーバー)
 *   local-gpu-worker: http://localhost:3434  (自前GPUサーバー HTTPサーバー)
 */

import { Command } from "commander";
import {
  DEFAULT_DUMMY_ISSUE,
  buildDispatchPayload,
  buildQueueMessage,
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
  .name("test-cloudflare-flow")
  .description(
    "構成B (GitHub Actions → Cloudflare Workers → Cloudflare Queues → 自前GPUワーカー) のローカル動作確認スクリプト"
  );

// ─── ① dispatch: GitHub Actions → Cloudflare Worker /dispatch ────────────────

addCommonIssueOptions(
  program
    .command("dispatch")
    .description("GitHub ActionsからのIssueディスパッチをシミュレートし、Cloudflare Workerの /dispatch へ送信する")
)
  .option("--url <url>", "Cloudflare WorkerのURL", "http://localhost:8787")
  .option("--token <token>", "CF_WEBHOOK_TOKEN (Bearer認証)", "local-dev-cf-webhook-token")
  .action(async (opts: CommonIssueOpts & { url: string; token: string }) => {
    const payload = buildDispatchPayload(toDummyIssueOptions(opts));

    console.log(`📤 POST ${opts.url}/dispatch`);
    console.log(JSON.stringify(payload, null, 2));

    const res = await fetch(`${opts.url}/dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify(payload),
    });

    await printResponse("Cloudflare Worker /dispatch", res);
  });

// ─── ② queue: Cloudflare Queues (mock) への直接投入 ──────────────────────────

addCommonIssueOptions(
  program
    .command("queue")
    .description("Cloudflare Queues モックサーバーに直接メッセージを投入する (dispatchをスキップして疎通確認)")
)
  .option("--url <url>", "cf-queue-mockのURL", "http://localhost:8788")
  .option("--queue-name <name>", "Queue名", "github-issues")
  .action(async (opts: CommonIssueOpts & { url: string; queueName: string }) => {
    const message = buildQueueMessage(toDummyIssueOptions(opts));

    console.log(`📤 POST ${opts.url}/queues/${opts.queueName}/messages`);
    console.log(JSON.stringify(message, null, 2));

    const res = await fetch(`${opts.url}/queues/${opts.queueName}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    await printResponse("cf-queue-mock /queues/:name/messages", res);
    console.log(
      `\nℹ️  cf-queue-mock のログ、または GET ${opts.url}/queues/${opts.queueName}/messages で配信状況を確認できます`
    );
  });

// ─── ③ worker: 自前GPUワーカーへの直接リクエスト (Queueをスキップ) ───────────

addCommonIssueOptions(
  program
    .command("worker")
    .description("自前GPUワーカー (local-worker) の /run に直接メッセージを送信する (Queueをスキップして疎通確認)")
)
  .option("--url <url>", "local-workerのURL", "http://localhost:3434")
  .option("--token <token>", "LOCAL_WORKER_TOKEN (Bearer認証)", "local-dev-worker-token")
  .action(async (opts: CommonIssueOpts & { url: string; token: string }) => {
    const message = buildQueueMessage(toDummyIssueOptions(opts));

    console.log(`📤 POST ${opts.url}/run`);
    console.log(JSON.stringify(message, null, 2));

    const res = await fetch(`${opts.url}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify(message),
    });

    await printResponse("local-worker /run", res);
  });

// ─── ④ e2e: 一気通貫テスト ────────────────────────────────────────────────────

addCommonIssueOptions(
  program
    .command("e2e")
    .description(
      "GitHub Actions → Cloudflare Worker → Queue → 自前GPUワーカー を一気通貫でテストする (dispatchのみ叩き、以降は自動連携を待つ)"
    )
)
  .option("--url <url>", "Cloudflare WorkerのURL", "http://localhost:8787")
  .option("--token <token>", "CF_WEBHOOK_TOKEN (Bearer認証)", "local-dev-cf-webhook-token")
  .action(async (opts: CommonIssueOpts & { url: string; token: string }) => {
    const payload = buildDispatchPayload(toDummyIssueOptions(opts));

    console.log("🚀 e2eテスト開始: GitHub Actions → Cloudflare Worker → Queue → GPUワーカー");
    console.log(`📤 POST ${opts.url}/dispatch`);
    console.log(JSON.stringify(payload, null, 2));

    const res = await fetch(`${opts.url}/dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify(payload),
    });

    await printResponse("Cloudflare Worker /dispatch", res);

    console.log(`
ℹ️  Cloudflare Worker が Queue へのメッセージ投入に成功していれば、
   以降は Queue Consumer が自動的に自前GPUワーカーへ転送します。
   以下のログで進行状況を確認してください:
     docker compose -f docker-compose.dev.cloudflare.yml logs -f cf-worker-dev local-gpu-worker
`);
  });

program.parseAsync(process.argv);
