#!/usr/bin/env tsx
/**
 * local-worker/src/server.ts
 * 自前GPUサーバー上で常駐するHTTPサーバー
 *
 * Cloudflare Queue Consumer からのリクエストを受け取り、
 * Aider + Ollama でコード修正 → git push → PR作成 を実行する。
 *
 * 起動方法:
 *   tsx local-worker/src/server.ts
 *   または
 *   docker run --rm --env-file .env.local -p 3434:3434 adk-agent-worker:latest
 *
 * Cloudflare Tunnel のセットアップ:
 *   cloudflared tunnel --url http://localhost:3434
 *   → 発行されたURLを Cloudflare Workers の LOCAL_WORKER_ENDPOINT に設定
 *
 * 環境変数:
 *   PORT               - リッスンポート (デフォルト: 3434)
 *   LOCAL_WORKER_TOKEN - Cloudflare Workerと共有する認証トークン
 *   GITHUB_TOKEN       - GitHub PAT (DRY_RUN=true の場合は不要)
 *   AIDER_MODEL        - 使用モデル (デフォルト: qwen2.5-coder:32b)
 *   OLLAMA_API_BASE    - OllamaエンドポイントURL (デフォルト: http://localhost:11434/v1)
 *   MAX_CONCURRENT     - 同時実行数 (デフォルト: 1)
 *   DRY_RUN            - "true" の場合、実際の git clone/push/PR作成・Aider実行を
 *                        すべてスキップし、ログ出力のみで処理をシミュレートする。
 *                        ローカルでの疎通確認 (HTTP層・認証・Queueリレー) に使用する。
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Queueメッセージ型 (Cloudflare Queues / Pub/Sub 共通スキーマ) ────────────
// cloudflare-workers 側の型定義と構造は同一だが、あちら側は
// @cloudflare/workers-types (Queue/MessageBatch等のワーカー専用アンビエント型)
// に依存しているため、Node.js環境で動くこちらのパッケージでは
// 密結合を避けるためにあえて同一形状の型をこちらにも定義している。
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

// ─── 設定 ─────────────────────────────────────────────────────────────────────

const PORT = Number(process.env["PORT"] ?? 3434);
const LOCAL_WORKER_TOKEN = process.env["LOCAL_WORKER_TOKEN"] ?? "";
const GITHUB_TOKEN = process.env["GITHUB_TOKEN"] ?? "";
const AIDER_MODEL = process.env["AIDER_MODEL"] ?? "qwen2.5-coder:32b";
const OLLAMA_API_BASE = process.env["OLLAMA_API_BASE"] ?? "http://localhost:11434/v1";
const MAX_CONCURRENT = Number(process.env["MAX_CONCURRENT"] ?? 1);
const DRY_RUN = process.env["DRY_RUN"] === "true";

if (!LOCAL_WORKER_TOKEN) {
  console.error("❌ LOCAL_WORKER_TOKEN が未設定です");
  process.exit(1);
}
if (!GITHUB_TOKEN && !DRY_RUN) {
  console.error("❌ GITHUB_TOKEN が未設定です (DRY_RUN=true にすれば不要です)");
  process.exit(1);
}

// ─── 同時実行制御 ─────────────────────────────────────────────────────────────

let runningJobs = 0;

// ─── ユーティリティ ───────────────────────────────────────────────────────────

function run(cmd: string, cwd?: string): void {
  console.log(`\n▶ ${cmd}\n`);
  execSync(cmd, { stdio: "inherit", cwd, env: { ...process.env } });
}

function capture(cmd: string, cwd?: string): string {
  return execSync(cmd, { encoding: "utf-8", cwd, env: { ...process.env } }).trim();
}

function verifyBearer(authHeader: string | undefined): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  if (token.length !== LOCAL_WORKER_TOKEN.length) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(LOCAL_WORKER_TOKEN);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ─── コアパイプライン ─────────────────────────────────────────────────────────

async function runAgentPipeline(msg: IssueQueueMessage): Promise<void> {
  const {
    issueNumber,
    issueTitle,
    issueBody,
    issueAuthor,
    repoFullName,
    defaultBranch,
  } = msg;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`🚀 エージェントパイプライン開始${DRY_RUN ? " [DRY_RUN]" : ""}`);
  console.log(`   リポジトリ : ${repoFullName}`);
  console.log(`   Issue      : #${issueNumber} "${issueTitle}"`);
  console.log(`   モデル     : ${AIDER_MODEL}`);
  console.log(`   開始時刻   : ${new Date().toISOString()}`);
  console.log(`${"═".repeat(60)}\n`);

  if (DRY_RUN) {
    // ── DRY_RUN: 実際のgit操作・Aider実行を行わず、疎通確認のみ行う ──────────
    const branch = `demo/issue-${issueNumber}`;
    console.log(`🧪 [DRY_RUN] git clone をスキップ (対象: ${repoFullName})`);
    console.log(`🧪 [DRY_RUN] ブランチ作成をスキップ: ${branch}`);
    console.log(`🧪 [DRY_RUN] Aider実行をスキップ`);
    console.log(`   --model "${AIDER_MODEL}" --openai-api-base "${OLLAMA_API_BASE}"`);
    console.log(`   プロンプト:\n${buildPrompt({ issueNumber, issueTitle, issueBody, issueAuthor })}`);
    console.log(`🧪 [DRY_RUN] git push をスキップ`);
    console.log(`🧪 [DRY_RUN] gh pr create をスキップ`);
    console.log(`\n✅ [DRY_RUN] パイプライン完了 (実際の変更は行われていません): ${new Date().toISOString()}`);
    return;
  }

  // ① 一時作業ディレクトリ作成
  const workDir = mkdtempSync(join(tmpdir(), `aider-issue-${issueNumber}-`));
  const repoDir = join(workDir, "repo");

  try {
    // ② リポジトリクローン
    console.log("📥 リポジトリクローン中...");
    const cloneUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${repoFullName}.git`;
    run(`git clone --depth=1 --branch "${defaultBranch}" "${cloneUrl}" "${repoDir}"`);

    // GitHub CLI 認証
    process.env["GH_TOKEN"] = GITHUB_TOKEN;
    process.env["GITHUB_TOKEN"] = GITHUB_TOKEN;

    // ③ ブランチ作成
    const branch = `demo/issue-${issueNumber}`;
    console.log(`🌿 ブランチ作成: ${branch}`);
    run(`git checkout -b "${branch}"`, repoDir);

    // ④ Aider でコード修正
    const prompt = buildPrompt({ issueNumber, issueTitle, issueBody, issueAuthor });
    console.log("🤖 Aider エージェント実行中...");
    runAider(prompt, repoDir);

    // ⑤ 変更をコミット & プッシュ
    run("git add -A", repoDir);
    const status = capture("git status --porcelain", repoDir);

    if (!status) {
      console.warn("⚠️  変更なし。PRをスキップします。");
      return;
    }

    // Aiderが既にコミットしていない場合のみコミット
    const unpushed = capture(`git log origin/${defaultBranch}..HEAD --oneline`, repoDir);
    if (!unpushed) {
      run(
        `git commit -m "feat: AI agent implementation for issue #${issueNumber}\n\n${issueTitle.replace(/"/g, '\\"')}\n\ncloses #${issueNumber}"`,
        repoDir
      );
    }

    console.log("📤 プッシュ中...");
    run(`git push origin "${branch}"`, repoDir);

    // ⑥ PR作成
    console.log("🔀 PR作成中...");
    createPR({ repoFullName, defaultBranch, branch, issueNumber, issueTitle }, repoDir);

  } finally {
    rmSync(workDir, { recursive: true, force: true });
    console.log("🧹 作業ディレクトリ削除完了");
  }

  console.log(`\n✅ パイプライン完了: ${new Date().toISOString()}`);
}

function buildPrompt(opts: {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueAuthor: string;
}): string {
  return [
    `以下のGitHub Issueに対応するデモ実装を行ってください。`,
    ``,
    `## Issue #${opts.issueNumber}`,
    `タイトル: ${opts.issueTitle}`,
    `作成者: @${opts.issueAuthor}`,
    ``,
    `## 内容`,
    opts.issueBody || "(本文なし)",
    ``,
    `## 実装方針`,
    `- 既存のコードアーキテクチャとスタイルに従うこと`,
    `- 最小限の変更で動作するデモ実装を目指すこと`,
    `- コミットメッセージは feat: <内容> (closes #${opts.issueNumber}) の形式にすること`,
  ].join("\n");
}

function runAider(prompt: string, cwd: string): void {
  const escaped = prompt.replace(/"/g, '\\"').replace(/\n/g, "\\n");
  run(
    [
      `aider`,
      `--model "${AIDER_MODEL}"`,
      `--openai-api-base "${OLLAMA_API_BASE}"`,
      `--yes`,
      `--message "${escaped}"`,
    ].join(" "),
    cwd
  );
}

function createPR(opts: {
  repoFullName: string;
  defaultBranch: string;
  branch: string;
  issueNumber: number;
  issueTitle: string;
}, cwd: string): void {
  const title = `[AIエージェント] Issue #${opts.issueNumber}: ${opts.issueTitle}`;
  const body = [
    `## 🤖 Aider + Ollama による自動実装`,
    ``,
    `Issue #${opts.issueNumber} の要件に基づきローカルLLM (${AIDER_MODEL}) が自動実装しました。`,
    ``,
    `## 対応Issue`,
    `closes #${opts.issueNumber}`,
    ``,
    `## 実行環境`,
    `- エージェント: Aider`,
    `- モデル: \`${AIDER_MODEL}\``,
    `- 実行日時: ${new Date().toISOString()}`,
    ``,
    `## レビューポイント`,
    `- [ ] 要件の適合性`,
    `- [ ] 既存コードスタイルとの一貫性`,
    `- [ ] セキュリティ上の問題がないか`,
  ].join("\n");

  run(
    [
      `gh pr create`,
      `--repo "${opts.repoFullName}"`,
      `--base "${opts.defaultBranch}"`,
      `--head "${opts.branch}"`,
      `--title "${title.replace(/"/g, '\\"')}"`,
      `--body "${body.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`,
    ].join(" "),
    cwd
  );
  console.log(`✅ PR作成完了: ${title}`);
}

// ─── Hono HTTPサーバー ────────────────────────────────────────────────────────

const app = new Hono();
app.use("*", logger());

app.get("/", (c) =>
  c.json({
    status: "ok",
    service: "local-aider-worker",
    model: AIDER_MODEL,
    runningJobs,
    maxConcurrent: MAX_CONCURRENT,
    dryRun: DRY_RUN,
  })
);

app.get("/health", (c) =>
  c.json({
    status: "healthy",
    runningJobs,
    maxConcurrent: MAX_CONCURRENT,
    model: AIDER_MODEL,
    ollamaBase: OLLAMA_API_BASE,
    dryRun: DRY_RUN,
  })
);

// Cloudflare Queue Consumer からのリクエストを受け取るエンドポイント
app.post("/run", async (c) => {
  // 認証
  if (!verifyBearer(c.req.header("Authorization"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // 同時実行数チェック
  if (runningJobs >= MAX_CONCURRENT) {
    console.warn(`⚠️  同時実行数上限 (${MAX_CONCURRENT}) に達しています`);
    return c.json({ error: "Too many concurrent jobs. Retry later." }, 429);
  }

  let msg: IssueQueueMessage;
  try {
    msg = await c.req.json();
  } catch {
    return c.json({ error: "JSONパースエラー" }, 400);
  }

  if (!msg.issueNumber || !msg.repoFullName) {
    return c.json({ error: "issueNumber と repoFullName は必須です" }, 400);
  }

  // 即座に202を返し、バックグラウンドで処理
  runningJobs++;
  runAgentPipeline(msg)
    .catch((err) => console.error(`❌ Issue #${msg.issueNumber} パイプライン失敗:`, err))
    .finally(() => { runningJobs--; });

  return c.json(
    { accepted: true, issueNumber: msg.issueNumber, runningJobs },
    202
  );
});

// ─── 起動 ─────────────────────────────────────────────────────────────────────

console.log(`
╔════════════════════════════════════════╗
║   Local Aider Worker サーバー起動       ║
╠════════════════════════════════════════╣
║  PORT          : ${String(PORT).padEnd(22)}║
║  MODEL         : ${AIDER_MODEL.slice(0, 22).padEnd(22)}║
║  OLLAMA_BASE   : ${OLLAMA_API_BASE.slice(0, 22).padEnd(22)}║
║  MAX_CONCURRENT: ${String(MAX_CONCURRENT).padEnd(22)}║
║  DRY_RUN       : ${String(DRY_RUN).padEnd(22)}║
╚════════════════════════════════════════╝

Cloudflare Tunnel でこのサーバーを公開してください:
  cloudflared tunnel --url http://localhost:${PORT}
  → 発行されたURLを Cloudflare Workers の LOCAL_WORKER_ENDPOINT に設定
`);

serve({ fetch: app.fetch, port: PORT });
