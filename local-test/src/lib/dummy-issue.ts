/**
 * local-test/src/lib/dummy-issue.ts
 * ローカルテストスクリプト共通: ダミーのGitHub Issue関連ペイロードを生成する
 */

import { createHmac } from "node:crypto";

// ─── 共通オプション型 ────────────────────────────────────────────────────────

export interface DummyIssueOptions {
  issueNumber: number;
  title: string;
  body: string;
  author: string;
  repo: string;
  branch: string;
}

export const DEFAULT_DUMMY_ISSUE: DummyIssueOptions = {
  issueNumber: 1,
  title: "[テスト] ダミーIssueタイトル",
  body: "これはローカルテスト用のダミーIssue本文です。\n\n- 項目A\n- 項目B",
  author: "test-user",
  repo: "your-org/your-repo",
  branch: "main",
};

// ─── ① GitHub Webhook 形式 (gcp-webhook /webhook, Cloudflare /webhook互換) ────
// GitHubが実際に送信する `issues` イベントのペイロード形式を再現する

export function buildGithubWebhookPayload(opts: DummyIssueOptions) {
  return {
    action: "opened",
    issue: {
      number: opts.issueNumber,
      title: opts.title,
      body: opts.body,
      user: { login: opts.author },
      html_url: `https://github.com/${opts.repo}/issues/${opts.issueNumber}`,
      labels: [] as Array<{ name: string }>,
    },
    repository: {
      full_name: opts.repo,
      default_branch: opts.branch,
    },
    sender: { login: opts.author },
  };
}

/** GitHub Webhookの署名 (X-Hub-Signature-256) を計算する */
export function computeGithubSignature(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

// ─── ② GitHub Actions → Cloudflare Worker /dispatch 形式 ─────────────────────

export function buildDispatchPayload(opts: DummyIssueOptions) {
  return {
    action: "opened",
    issueNumber: opts.issueNumber,
    issueTitle: opts.title,
    issueBody: opts.body,
    issueAuthor: opts.author,
    issueUrl: `https://github.com/${opts.repo}/issues/${opts.issueNumber}`,
    repoFullName: opts.repo,
    defaultBranch: opts.branch,
    triggeredAt: new Date().toISOString(),
  };
}

// ─── ③ Queue メッセージ形式 (Cloudflare Queues / Pub/Sub 共通スキーマ) ────────

export function buildQueueMessage(opts: DummyIssueOptions) {
  return {
    issueNumber: opts.issueNumber,
    issueTitle: opts.title,
    issueBody: opts.body,
    issueAuthor: opts.author,
    issueUrl: `https://github.com/${opts.repo}/issues/${opts.issueNumber}`,
    issueLabels: [] as string[],
    repoFullName: opts.repo,
    defaultBranch: opts.branch,
    triggeredAt: new Date().toISOString(),
  };
}

// ─── ④ Pub/Sub Push サブスクリプション形式 (ADKワーカー /worker) ─────────────

export function buildPubSubPushEnvelope(opts: DummyIssueOptions, gcpProject: string) {
  const queueMessage = buildQueueMessage(opts);
  const data = Buffer.from(JSON.stringify(queueMessage)).toString("base64");
  return {
    message: {
      data,
      messageId: `dummy-${Date.now()}`,
      publishTime: new Date().toISOString(),
      attributes: {
        issueNumber: String(opts.issueNumber),
        repo: opts.repo,
        source: "local-test-script",
      },
    },
    subscription: `projects/${gcpProject}/subscriptions/github-issues-worker-sub`,
  };
}

// ─── HTTPリクエスト結果の共通表示 ─────────────────────────────────────────────

export async function printResponse(label: string, res: Response): Promise<void> {
  const contentType = res.headers.get("content-type") ?? "";
  let bodyText: string;
  if (contentType.includes("application/json")) {
    bodyText = JSON.stringify(await res.json(), null, 2);
  } else {
    bodyText = await res.text();
  }

  const icon = res.ok ? "✅" : "❌";
  console.log(`\n${icon} ${label}`);
  console.log(`   HTTP ${res.status} ${res.statusText}`);
  console.log(
    bodyText
      .split("\n")
      .map((line) => `   ${line}`)
      .join("\n")
  );
}
