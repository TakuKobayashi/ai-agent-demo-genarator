#!/usr/bin/env tsx
/**
 * local-dev/gcp-pubsub-relay/src/server.ts
 *
 * 【ローカル開発専用】Pub/Sub エミュレータ → Push配信 ブリッジ
 *
 * 本番環境では Cloud Pub/Sub の Push サブスクリプションが自動的に
 * ADKワーカー (Cloud Run) の POST /worker エンドポイントへメッセージを配信する。
 *
 * しかし gcloud Pub/Sub エミュレータ (gcloud beta emulators pubsub) は
 * Pull配信のみをサポートしており、Push配信を再現できない。
 *
 * このブリッジサービスは:
 *   1. Pub/Subエミュレータのサブスクリプションを継続的にPull
 *   2. 受け取ったメッセージを本番のPub/Sub Push形式のJSON
 *      ({ message: { data: base64, messageId }, subscription }) に変換
 *   3. ADKワーカーの POST /worker へHTTP転送
 *   4. 成功したらメッセージをAck
 *
 * を行うことで、ローカルでも本番と全く同じ Push 配信フローを再現する。
 *
 * 環境変数:
 *   PORT                    - ヘルスチェック用リッスンポート (デフォルト: 8092)
 *   PUBSUB_EMULATOR_HOST    - Pub/Subエミュレータのホスト:ポート (デフォルト: localhost:8085)
 *   GCP_PROJECT             - GCPプロジェクトID (エミュレータ用の任意のID可)
 *   PUBSUB_TOPIC            - トピック名 (デフォルト: github-issues)
 *   PUBSUB_SUBSCRIPTION     - サブスクリプション名 (デフォルト: github-issues-worker-sub)
 *   ADK_WORKER_ENDPOINT     - ADKワーカーのURL (デフォルト: http://localhost:8091)
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { PubSub, type Message } from "@google-cloud/pubsub";

// ─── 設定 ─────────────────────────────────────────────────────────────────────

const PORT = Number(process.env["PORT"] ?? 8092);
const GCP_PROJECT = process.env["GCP_PROJECT"] ?? "local-dev-project";
const PUBSUB_TOPIC = process.env["PUBSUB_TOPIC"] ?? "github-issues";
const PUBSUB_SUBSCRIPTION = process.env["PUBSUB_SUBSCRIPTION"] ?? "github-issues-worker-sub";
const ADK_WORKER_ENDPOINT = process.env["ADK_WORKER_ENDPOINT"] ?? "http://localhost:8091";

// PUBSUB_EMULATOR_HOST が設定されていれば @google-cloud/pubsub は自動でエミュレータに接続する
if (!process.env["PUBSUB_EMULATOR_HOST"]) {
  console.warn(
    "⚠️  PUBSUB_EMULATOR_HOST が未設定です。デフォルトの localhost:8085 に接続を試みます。"
  );
  process.env["PUBSUB_EMULATOR_HOST"] = "localhost:8085";
}

// ─── 統計情報 (ヘルスチェック用) ──────────────────────────────────────────────

let relayedCount = 0;
let failedCount = 0;
let lastRelayedAt: string | null = null;

// ─── Pub/Sub トピック & サブスクリプションの初期化 ────────────────────────────

async function ensureTopicAndSubscription(pubsub: PubSub): Promise<void> {
  const [topics] = await pubsub.getTopics();
  const topicExists = topics.some((t) => t.name.endsWith(`/topics/${PUBSUB_TOPIC}`));
  if (!topicExists) {
    console.log(`📌 トピック作成: ${PUBSUB_TOPIC}`);
    await pubsub.createTopic(PUBSUB_TOPIC);
  }

  const topic = pubsub.topic(PUBSUB_TOPIC);
  const [subscriptions] = await topic.getSubscriptions();
  const subExists = subscriptions.some((s) =>
    s.name.endsWith(`/subscriptions/${PUBSUB_SUBSCRIPTION}`)
  );
  if (!subExists) {
    console.log(`📌 サブスクリプション作成: ${PUBSUB_SUBSCRIPTION}`);
    await topic.createSubscription(PUBSUB_SUBSCRIPTION);
  }
}

// ─── メッセージ転送 (本番のPub/Sub Push形式を再現) ────────────────────────────

async function relayMessage(message: Message): Promise<void> {
  console.log(
    `📬 [pubsub-relay] メッセージ受信: id=${message.id} (トピック: ${PUBSUB_TOPIC})`
  );

  // 本番のPub/Sub Pushサブスクリプションが送信するのと同じエンベロープ形式を再現
  const pushEnvelope = {
    message: {
      data: message.data.toString("base64"),
      messageId: message.id,
      publishTime: message.publishTime?.toISOString?.() ?? new Date().toISOString(),
      attributes: message.attributes,
    },
    subscription: `projects/${GCP_PROJECT}/subscriptions/${PUBSUB_SUBSCRIPTION}`,
  };

  try {
    const res = await fetch(`${ADK_WORKER_ENDPOINT}/worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pushEnvelope),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ADKワーカーエラー: HTTP ${res.status} - ${text}`);
    }

    console.log(`✅ [pubsub-relay] ADKワーカーへの転送完了: id=${message.id}`);
    relayedCount++;
    lastRelayedAt = new Date().toISOString();
    message.ack();
  } catch (err) {
    console.error(`❌ [pubsub-relay] 転送失敗: id=${message.id}`, err);
    failedCount++;
    // nack して再配信させる (Pub/Subの ackDeadline 経過後に再送される)
    message.nack();
  }
}

// ─── メインループ ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════╗
║   gcp-pubsub-relay (ローカル開発専用)              ║
╠══════════════════════════════════════════════════╣
║  PUBSUB_EMULATOR_HOST : ${(process.env["PUBSUB_EMULATOR_HOST"] ?? "").padEnd(24)}║
║  TOPIC                : ${PUBSUB_TOPIC.padEnd(24)}║
║  SUBSCRIPTION         : ${PUBSUB_SUBSCRIPTION.padEnd(24)}║
║  ADK_WORKER_ENDPOINT  : ${ADK_WORKER_ENDPOINT.slice(0, 24).padEnd(24)}║
╚══════════════════════════════════════════════════╝

このサービスは Pub/Sub エミュレータ (Pull配信のみ対応) から
メッセージを取り出し、本番の Push サブスクリプションと同じ形式で
ADKワーカーへ転送するブリッジです。実際のデプロイでは使用しません
(本番は Cloud Pub/Sub の Push サブスクリプションが直接配信します)。
`);

  const pubsub = new PubSub({ projectId: GCP_PROJECT });

  // トピック・サブスクリプションが存在しなければ作成 (エミュレータ用)
  let retries = 0;
  while (retries < 10) {
    try {
      await ensureTopicAndSubscription(pubsub);
      break;
    } catch (err) {
      retries++;
      console.warn(
        `⚠️  Pub/Subエミュレータへの接続待機中... (${retries}/10)`,
        err instanceof Error ? err.message : err
      );
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const subscription = pubsub.subscription(PUBSUB_SUBSCRIPTION);
  subscription.on("message", (message: Message) => {
    relayMessage(message).catch((err) =>
      console.error("[pubsub-relay] 予期しないエラー:", err)
    );
  });
  subscription.on("error", (err) => {
    console.error("[pubsub-relay] サブスクリプションエラー:", err);
  });

  console.log(`👂 [pubsub-relay] サブスクリプション '${PUBSUB_SUBSCRIPTION}' を購読中...`);

  // ─── ヘルスチェック用HTTPサーバー ───────────────────────────────────────────
  const app = new Hono();
  app.get("/", (c) =>
    c.json({
      status: "ok",
      service: "gcp-pubsub-relay (ローカル開発専用)",
      topic: PUBSUB_TOPIC,
      subscription: PUBSUB_SUBSCRIPTION,
      adkWorkerEndpoint: ADK_WORKER_ENDPOINT,
      relayedCount,
      failedCount,
      lastRelayedAt,
    })
  );
  app.get("/health", (c) => c.json({ status: "healthy", relayedCount, failedCount }));

  serve({ fetch: app.fetch, port: PORT });
  console.log(`🩺 [pubsub-relay] ヘルスチェックサーバー起動 port=${PORT}`);
}

main().catch((err) => {
  console.error("❌ [pubsub-relay] 起動エラー:", err);
  process.exit(1);
});
