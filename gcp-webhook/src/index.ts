/**
 * gcp-webhook/src/index.ts
 * Cloud Run + Hono: GitHub Webhookレシーバー
 *
 * フロー:
 *   GitHub App (Issue Opened) → POST /webhook
 *     → 署名検証 (HMAC-SHA256。GitHub Appのwebhook secretを使用)
 *     → 許可リポジトリチェック (ALLOWED_REPOS)
 *     → Pub/Sub パブリッシュ (installation.id を含める)
 *     → 200 OK
 *
 * このWebhookは GitHub App 経由での利用を前提にしている。
 * GitHub App は Any account にインストール可能な設定にできるため、
 * 第三者が自分のリポジトリにインストールするだけで、
 * GCPのアカウントやプロジェクトを一切作らずにこのシステムを使える。
 * (実際のgit操作用トークンは、ここで受け取る installation.id を使って
 *  ワーカー側がその場で短命なインストールトークンを発行するため、
 *  リポジトリ管理者からPAT等を受け取る必要がない)
 *
 * 環境変数:
 *   GCP_PROJECT           - GCPプロジェクトID
 *   PUBSUB_TOPIC          - Pub/Subトピック名
 *   PORT                  - リッスンポート (デフォルト: 8090)
 *   ALLOWED_REPOS         - 処理を許可するリポジトリのカンマ区切りリスト
 *                            (例: "owner/repo1,owner/repo2")。
 *                            未設定または空文字の場合は全リポジトリを許可する
 *                            (GitHub Appを Any account にインストール可能にしている場合、
 *                             想定外の第三者からの利用でCloud Run/Gemini APIの
 *                             実行コストが発生するのを防ぐために設定を推奨)
 *
 * Secret Manager (最新バージョンを自動取得):
 *   GITHUB_WEBHOOK_SECRET - GitHub App の Webhook secret
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
  // GitHub App経由のWebhookには、どのインストール(=どのアカウント/リポジトリへの
  // インストールか)からのイベントかを示す installation.id が含まれる。
  // このIDを使って、ワーカー側がそのリポジトリ専用の短命なアクセストークンを
  // 都度発行する (PATを使わないための鍵となるフィールド)。
  installation?: { id: number };
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
  // GitHub App のインストールID。ワーカー側でインストールトークンを
  // 発行する際に必要 (undefinedの場合は従来型の静的GITHUB_TOKEN方式にフォールバックする)
  installationId?: number;
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

/**
 * GITHUB_WEBHOOK_SECRET を解決する。
 * ローカル開発時は環境変数を優先し、実GCP認証なしでの動作確認を可能にする
 * (src/worker-entrypoint.ts の resolveGithubToken() と同じパターン)。
 * 本番 (Cloud Run) では環境変数を設定しないため、自動的にSecret Managerから取得される。
 */
async function resolveWebhookSecret(): Promise<string> {
  if (process.env["GITHUB_WEBHOOK_SECRET"]) {
    return process.env["GITHUB_WEBHOOK_SECRET"];
  }
  return getSecret("GITHUB_WEBHOOK_SECRET");
}

// ─── 許可リポジトリチェック ───────────────────────────────────────────────────

/**
 * ALLOWED_REPOS 環境変数に基づき、そのリポジトリからのイベントを
 * 処理してよいか判定する。
 * ALLOWED_REPOS が未設定/空文字の場合は全リポジトリを許可する
 * (GitHub Appのインストール先を限定している場合や、動作確認中は
 *  設定しなくても構わないが、Any accountにインストール可能にしたまま
 *  本番運用する場合は必ず設定すること)。
 */
function isRepoAllowed(repoFullName: string): boolean {
  const allowList = process.env["ALLOWED_REPOS"];
  if (!allowList || allowList.trim() === "") return true;

  const allowed = allowList
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return allowed.includes(repoFullName);
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
    webhookSecret = await resolveWebhookSecret();
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

  const { issue, repository, installation } = payload;

  // ⑤.5 許可リポジトリチェック (第三者が勝手にAppをインストールした場合の
  //     Cloud Run/Gemini APIの実行コスト濫用を防ぐ)
  if (!isRepoAllowed(repository.full_name)) {
    console.warn(`⛔ 許可されていないリポジトリからのリクエストを拒否: ${repository.full_name}`);
    return c.json(
      { skipped: true, reason: `repository '${repository.full_name}' is not in ALLOWED_REPOS` },
      200
    );
  }

  console.log(`📩 Issue #${issue.number} 受信: "${issue.title}" in ${repository.full_name}`);
  if (installation?.id) {
    console.log(`   installation.id = ${installation.id}`);
  } else {
    console.warn(
      `⚠️  installation.id がペイロードに含まれていません。GitHub App経由のWebhookか確認してください (静的GITHUB_TOKEN方式にフォールバックします)`
    );
  }

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
    installationId: installation?.id,
  };

  try {
    const pubsub = new PubSub({ projectId: process.env["GCP_PROJECT"] });
    const messageId = await pubsub.topic(topic).publishMessage({
      json: message,
      attributes: {
        issueNumber: String(issue.number),
        repo: repository.full_name,
        source: "github-webhook",
        ...(installation?.id ? { installationId: String(installation.id) } : {}),
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

const port = Number(process.env["PORT"] ?? 8090);
console.log(`🚀 Webhookレシーバー起動 port=${port}`);
serve({ fetch: app.fetch, port });

export default app;
