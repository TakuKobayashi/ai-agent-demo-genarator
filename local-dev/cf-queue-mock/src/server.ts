#!/usr/bin/env tsx
/**
 * local-dev/cf-queue-mock/src/server.ts
 *
 * 【ローカル開発専用】Cloudflare Queues の疑似サーバー
 *
 * 本番環境では Cloudflare Workers の `queue()` ハンドラが自動的に
 * Cloudflare Queues からメッセージを受け取り、ローカルGPUワーカーへ転送する
 * (cloudflare-workers/src/index.ts の `queue()` を参照)。
 *
 * `wrangler dev` は実は Queues もローカルでシミュレートできるが、
 * Workerプロセスに内包されてしまい外から個別に叩けない。
 * このモックサーバーは「Cloudflare Queues」を独立したポートを持つ
 * サービスとして切り出し、
 *   - どのメッセージがQueueに積まれたか
 *   - Queue Consumer (→ ローカルGPUワーカーへの転送) が
 *     正しく動作しているか
 * を個別に確認できるようにするためのものです。
 *
 * 本番の cloudflare-workers/src/index.ts の queue() ハンドラと
 * 全く同じ転送ロジック (Bearer認証つきHTTP POST + リトライ) を再現している。
 *
 * エンドポイント:
 *   POST /queues/:queueName/messages  - メッセージをQueueに投入 (=本番のISSUES_QUEUE.send())
 *   GET  /queues/:queueName/messages  - Queueの受信履歴を確認 (デバッグ用)
 *   GET  /health                      - ヘルスチェック
 *
 * 環境変数:
 *   PORT                  - リッスンポート (デフォルト: 8788)
 *   LOCAL_WORKER_ENDPOINT - ローカルGPUワーカーのURL (デフォルト: http://localhost:3434)
 *   LOCAL_WORKER_TOKEN    - ローカルGPUワーカーとの共有認証トークン
 *   MAX_RETRIES           - 転送失敗時の最大リトライ回数 (デフォルト: 3)
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";

// ─── 型定義 (cloudflare-workers/src/index.ts の IssueQueueMessage と同一) ────

interface IssueQueueMessage {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueAuthor: string;
  issueUrl: string;
  repoFullName: string;
  defaultBranch: string;
  triggeredAt: string;
}

interface StoredMessage {
  id: string;
  queueName: string;
  body: IssueQueueMessage;
  receivedAt: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
}

// ─── 設定 ─────────────────────────────────────────────────────────────────────

const PORT = Number(process.env["PORT"] ?? 8788);
const LOCAL_WORKER_ENDPOINT = process.env["LOCAL_WORKER_ENDPOINT"] ?? "http://localhost:3434";
const LOCAL_WORKER_TOKEN = process.env["LOCAL_WORKER_TOKEN"] ?? "";
const MAX_RETRIES = Number(process.env["MAX_RETRIES"] ?? 3);

// ─── インメモリ Queue ストレージ (デバッグ用の履歴保持のみ。実キューではない) ──

const messageLog: StoredMessage[] = [];

// ─── ユーティリティ ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Consumer ロジック (本番 queue() ハンドラと同一の転送ロジック) ────────────

async function deliverToLocalWorker(stored: StoredMessage): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    stored.attempts = attempt;
    try {
      console.log(
        `🔧 [cf-queue-mock] Issue #${stored.body.issueNumber} をローカルワーカーへ転送中 (試行 ${attempt}/${MAX_RETRIES})...`
      );

      const res = await fetch(`${LOCAL_WORKER_ENDPOINT}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${LOCAL_WORKER_TOKEN}`,
        },
        body: JSON.stringify(stored.body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`ローカルワーカーエラー: HTTP ${res.status} - ${text}`);
      }

      stored.status = "delivered";
      console.log(`✅ [cf-queue-mock] Issue #${stored.body.issueNumber} 転送完了`);
      return;
    } catch (err) {
      console.error(`❌ [cf-queue-mock] 転送失敗 (試行 ${attempt}/${MAX_RETRIES}):`, err);
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * attempt); // 簡易バックオフ
      }
    }
  }

  stored.status = "failed";
  console.error(
    `❌ [cf-queue-mock] Issue #${stored.body.issueNumber} 最大リトライ回数に到達。DLQ相当として保持します。`
  );
}

// ─── Hono アプリ ─────────────────────────────────────────────────────────────

const app = new Hono();
app.use("*", logger());

app.get("/", (c) =>
  c.json({
    status: "ok",
    service: "cf-queue-mock (ローカル開発専用)",
    localWorkerEndpoint: LOCAL_WORKER_ENDPOINT,
    queuedMessages: messageLog.length,
  })
);

app.get("/health", (c) => c.json({ status: "healthy" }));

// メッセージ投入 (本番の c.env.ISSUES_QUEUE.send() に相当)
app.post("/queues/:queueName/messages", async (c) => {
  const queueName = c.req.param("queueName");

  let body: IssueQueueMessage;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSONパースエラー" }, 400);
  }

  const stored: StoredMessage = {
    id: crypto.randomUUID(),
    queueName,
    body,
    receivedAt: new Date().toISOString(),
    status: "pending",
    attempts: 0,
  };
  messageLog.push(stored);

  console.log(`📬 [cf-queue-mock] Queue '${queueName}' にメッセージ投入: Issue #${body.issueNumber}`);

  // Consumer をバックグラウンドで起動 (実際のCloudflare Queuesの非同期配信を模倣)
  deliverToLocalWorker(stored).catch((err) =>
    console.error("[cf-queue-mock] 予期しないエラー:", err)
  );

  return c.json({ success: true, messageId: stored.id, queueName }, 202);
});

// メッセージ履歴の確認 (デバッグ用)
app.get("/queues/:queueName/messages", (c) => {
  const queueName = c.req.param("queueName");
  const messages = messageLog.filter((m) => m.queueName === queueName);
  return c.json({ queueName, count: messages.length, messages });
});

// ─── 起動 ─────────────────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════╗
║   cf-queue-mock (ローカル開発専用)             ║
╠══════════════════════════════════════════════╣
║  PORT                 : ${String(PORT).padEnd(21)}║
║  LOCAL_WORKER_ENDPOINT: ${LOCAL_WORKER_ENDPOINT.slice(0, 21).padEnd(21)}║
╚══════════════════════════════════════════════╝

このサーバーは本番の Cloudflare Queues の代わりに、
ローカルでの疎通確認用として Queue → ローカルワーカー転送を再現します。
実際のデプロイでは使用しません (wrangler の queue バインディングを使用)。
`);

serve({ fetch: app.fetch, port: PORT });
