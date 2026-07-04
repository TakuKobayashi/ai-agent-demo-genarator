/**
 * cloudflare-workers/src/index.ts
 * Cloudflare Workers + Hono: AIエージェントパイプライン中継 (構成B)
 *
 * エンドポイント:
 *   POST /dispatch  - GitHub Actions からのIssue情報を受け取りQueueに投入
 *   GET  /health    - ヘルスチェック
 *
 * Wrangler Secrets (wrangler secret put で設定):
 *   CF_WEBHOOK_TOKEN       - GitHub Actionsからのリクエスト認証トークン
 *   LOCAL_WORKER_TOKEN     - ローカルGPUサーバーへの認証トークン
 *
 * Wrangler Vars (wrangler.jsonc の vars で設定):
 *   LOCAL_WORKER_ENDPOINT  - Cloudflare Tunnel経由のローカルワーカーURL
 */

import { Hono } from "hono";
import { logger } from "hono/logger";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

export interface Env {
  // Secrets
  CF_WEBHOOK_TOKEN: string;
  LOCAL_WORKER_TOKEN: string;
  // Vars
  LOCAL_WORKER_ENDPOINT: string;
  // Queue バインディング
  ISSUES_QUEUE: Queue<IssueQueueMessage>;
}

// GitHub Actions から送られてくるペイロード
interface DispatchPayload {
  action: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueAuthor: string;
  issueUrl: string;
  repoFullName: string;
  defaultBranch: string;
  triggeredAt: string;
}

// Cloudflare Queue に積むメッセージ
export interface IssueQueueMessage {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueAuthor: string;
  issueUrl: string;
  repoFullName: string;
  defaultBranch: string;
  triggeredAt: string;
}

// ─── Bearer トークン認証 ──────────────────────────────────────────────────────

function verifyBearer(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  // 定数時間比較
  if (token.length !== expected.length) return false;
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ─── Hono アプリ ─────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();
app.use("*", logger());

app.get("/", (c) =>
  c.json({ status: "ok", service: "devops-ai-agent/cf-dispatcher", version: "1.0.0" })
);

app.get("/health", (c) => c.json({ status: "healthy" }));

// GitHub Actions → Cloudflare Queue への中継エンドポイント
app.post("/dispatch", async (c) => {
  // ① 認証
  if (!verifyBearer(c.req.header("Authorization"), c.env.CF_WEBHOOK_TOKEN)) {
    console.error("認証失敗: 不正なトークン");
    return c.json({ error: "Unauthorized" }, 401);
  }

  // ② パース
  let payload: DispatchPayload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "JSONパースエラー" }, 400);
  }

  if (payload.action !== "opened") {
    return c.json({ skipped: true, reason: `action=${payload.action}` }, 200);
  }

  console.log(`📩 Issue #${payload.issueNumber} 受信: "${payload.issueTitle}" in ${payload.repoFullName}`);

  // ③ Cloudflare Queues に投入
  const message: IssueQueueMessage = {
    issueNumber: payload.issueNumber,
    issueTitle: payload.issueTitle,
    issueBody: payload.issueBody ?? "",
    issueAuthor: payload.issueAuthor,
    issueUrl: payload.issueUrl,
    repoFullName: payload.repoFullName,
    defaultBranch: payload.defaultBranch ?? "main",
    triggeredAt: payload.triggeredAt ?? new Date().toISOString(),
  };

  try {
    await c.env.ISSUES_QUEUE.send(message, { contentType: "json" });
    console.log(`✅ Queue投入完了: Issue #${payload.issueNumber}`);
    return c.json({ success: true, issueNumber: payload.issueNumber, queued: true }, 202);
  } catch (err) {
    console.error("Queue投入失敗:", err);
    return c.json({ error: "Queue投入失敗" }, 500);
  }
});

// ─── Queue Consumer ───────────────────────────────────────────────────────────
// Cloudflare Queue からメッセージを受け取り、
// Cloudflare Tunnel 経由でローカルGPUサーバーに HTTP転送する

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<IssueQueueMessage>, env: Env): Promise<void> {
    console.log(`📬 Queue受信: ${batch.messages.length}件`);

    for (const msg of batch.messages) {
      const payload = msg.body;
      console.log(`🔧 Issue #${payload.issueNumber} 処理中: ${payload.issueTitle}`);

      if (!env.LOCAL_WORKER_ENDPOINT) {
        console.error("LOCAL_WORKER_ENDPOINT が未設定");
        msg.retry();
        continue;
      }

      try {
        // ローカルGPUサーバー (Cloudflare Tunnel経由) にHTTPで転送
        const res = await fetch(`${env.LOCAL_WORKER_ENDPOINT}/run`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.LOCAL_WORKER_TOKEN}`,
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`ローカルワーカーエラー: HTTP ${res.status} - ${text}`);
        }

        console.log(`✅ Issue #${payload.issueNumber} ローカルワーカーへのディスパッチ完了`);
        msg.ack();
      } catch (err) {
        console.error(`❌ Issue #${payload.issueNumber} 失敗:`, err);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, IssueQueueMessage>;
