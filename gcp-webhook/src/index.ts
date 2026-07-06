/**
 * gcp-webhook/src/index.ts
 * Cloud Run + Hono: GitHub Webhookレシーバー
 *
 * フロー:
 *   GitHub (Issue Opened) → POST /webhook
 *     → 署名検証 (HMAC-SHA256)
 *     → Pub/Sub パブリッシュ
 *     → 200 OK
 *
 * 環境変数:
 *   GCP_PROJECT           - GCPプロジェクトID
 *   PUBSUB_TOPIC          - Pub/Subトピック名
 *   PORT                  - リッスンポート (デフォルト: 8080)
 *
 * Secret Manager (最新バージョンを自動取得):
 *   GITHUB_WEBHOOK_SECRET - GitHub Webhookシークレット
 */

import { serve } from "@hono/node-server";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { PubSub } from "@google-cloud/pubsub";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { logger } from "hono/logger";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

interface GitHubIssuePayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    html_url: string;
    labels: Array<{ name: string }>;
  };
  repository: {
    full_name: string;
    default_branch: string;
  };
  sender: { login: string };
}

export interface IssueQueueMessage {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueAuthor: string;
  issueUrl: string;
  issueLabels: string[];
  repoFullName: string;
  defaultBranch: string;
  triggeredAt: string;
}

// ─── Secret Manager キャッシュ ────────────────────────────────────────────────

const secretClient = new SecretManagerServiceClient();
const secretCache = new Map<string, { value: string; expiresAt: number }>();
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000; // 5分

async function getSecret(name: string): Promise<string> {
  const cached = secretCache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const project = process.env["GCP_PROJECT"];
  if (!project) throw new Error("GCP_PROJECT が未設定です");

  const [version] = await secretClient.accessSecretVersion({
    name: `projects/${project}/secrets/${name}/versions/latest`,
  });
  const data = version.payload?.data;
  if (!data) throw new Error(`シークレット '${name}' が空です`);

  const value = typeof data === "string" ? data : Buffer.from(data).toString("utf-8");
  secretCache.set(name, { value, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
  return value;
}

// ─── Webhook 署名検証 ─────────────────────────────────────────────────────────

function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Hono アプリ ─────────────────────────────────────────────────────────────

const app = new Hono();
app.use("*", logger());

app.get("/", (c) =>
  c.json({ status: "ok", service: "devops-ai-agent/webhook-receiver", version: "1.0.0" })
);

app.get("/health", (c) => c.json({ status: "healthy" }));

app.post("/webhook", async (c) => {
  // ① イベントタイプ確認
  const event = c.req.header("X-GitHub-Event");
  if (event !== "issues") {
    return c.json({ skipped: true, reason: `event=${event}` }, 200);
  }

  // ② 生のボディを取得 (署名検証のため文字列で)
  const rawBody = await c.req.text();

  // ③ 署名検証
  const sig = c.req.header("X-Hub-Signature-256");
  if (!sig) {
    console.error("署名ヘッダーがありません");
    return c.json({ error: "署名が必要です" }, 401);
  }

  let webhookSecret: string;
  try {
    webhookSecret = await getSecret("GITHUB_WEBHOOK_SECRET");
  } catch (err) {
    console.error("GITHUB_WEBHOOK_SECRET の取得に失敗:", err);
    return c.json({ error: "内部エラー" }, 500);
  }

  if (!verifySignature(rawBody, sig, webhookSecret)) {
    console.error("署名検証失敗");
    return c.json({ error: "署名が無効です" }, 401);
  }

  // ④ ペイロードパース
  let payload: GitHubIssuePayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "JSONパースエラー" }, 400);
  }

  // ⑤ opened アクションのみ処理
  if (payload.action !== "opened") {
    return c.json({ skipped: true, reason: `action=${payload.action}` }, 200);
  }

  const { issue, repository } = payload;
  console.log(`📩 Issue #${issue.number} 受信: "${issue.title}" in ${repository.full_name}`);

  // ⑥ Pub/Sub にパブリッシュ
  const topic = process.env["PUBSUB_TOPIC"];
  if (!topic) {
    console.error("PUBSUB_TOPIC が未設定です");
    return c.json({ error: "内部エラー" }, 500);
  }

  const message: IssueQueueMessage = {
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: issue.body ?? "",
    issueAuthor: issue.user.login,
    issueUrl: issue.html_url,
    issueLabels: issue.labels.map((l) => l.name),
    repoFullName: repository.full_name,
    defaultBranch: repository.default_branch,
    triggeredAt: new Date().toISOString(),
  };

  try {
    const pubsub = new PubSub({ projectId: process.env["GCP_PROJECT"] });
    const messageId = await pubsub.topic(topic).publishMessage({
      json: message,
      attributes: {
        issueNumber: String(issue.number),
        repo: repository.full_name,
        source: "github-webhook",
      },
    });

    console.log(`✅ Pub/Sub パブリッシュ完了: messageId=${messageId}`);
    return c.json({ success: true, messageId, issueNumber: issue.number });
  } catch (err) {
    console.error("Pub/Sub パブリッシュ失敗:", err);
    return c.json({ error: "キュー投入失敗" }, 500);
  }
});

// ─── サーバー起動 ─────────────────────────────────────────────────────────────

const port = Number(process.env["PORT"] ?? 8787);
console.log(`🚀 Webhookレシーバー起動 port=${port}`);
serve({ fetch: app.fetch, port });

export default app;
