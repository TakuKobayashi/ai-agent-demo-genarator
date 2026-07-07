#!/usr/bin/env tsx
/**
 * src/worker-entrypoint.ts
 * AIエージェントワーカーエントリーポイント
 *
 * Cloud Run は Pub/Sub Push サブスクリプションから POST /worker を受信し、
 * このスクリプトがエージェント処理を実行する。
 * ローカル実行時は環境変数を直接セットして tsx src/worker-entrypoint.ts で起動。
 *
 * 環境変数:
 *   AGENT_MODE          - "GEMINI_ADK" | "LOCAL_AIDER"
 *   GCP_PROJECT         - GCPプロジェクトID (GEMINI_ADK時)
 *   GEMINI_MODEL        - 使用するGeminiモデル (デフォルト: gemini-2.0-flash)
 *   AIDER_MODEL         - Aiderモデル名 (LOCAL_AIDER時)
 *   OLLAMA_API_BASE     - OllamaエンドポイントURL (LOCAL_AIDER時)
 *   GITHUB_TOKEN        - GitHub PAT または App Token
 *   GITHUB_REPO         - 対象リポジトリ (owner/repo)
 *   ISSUE_NUMBER        - Issue番号
 *   ISSUE_TITLE         - Issueタイトル
 *   ISSUE_BODY          - Issue本文
 *   ISSUE_AUTHOR        - Issue作成者
 *   DEFAULT_BRANCH      - デフォルトブランチ名 (デフォルト: main)
 *
 * Cloud Run経由 (Pub/Sub Push) の場合:
 *   POST /worker に { message: { data: base64(IssueQueueMessage) } } が届く
 *   → 環境変数に展開して処理
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import type { IssueQueueMessage } from "../gcp-webhook/src/index.js";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

type AgentMode = "GEMINI_ADK" | "LOCAL_AIDER";

interface WorkerConfig {
  agentMode: AgentMode;
  gcpProject: string;
  geminiModel: string;
  aiderModel: string;
  ollamaApiBase: string;
  githubToken: string;
  githubRepo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueAuthor: string;
  defaultBranch: string;
  dryRun: boolean;
}

// ─── ユーティリティ ───────────────────────────────────────────────────────────

function run(cmd: string, cwd?: string): void {
  console.log(`\n▶ ${cmd}\n`);
  execSync(cmd, {
    stdio: "inherit",
    cwd,
    env: { ...process.env },
  });
}

function capture(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    encoding: "utf-8",
    cwd,
    env: { ...process.env },
  }).trim();
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`環境変数 ${key} が未設定です`);
  return v;
}

// ─── Secret Manager からトークンを取得 ──────────────────────────────────────

async function resolveGithubToken(): Promise<string> {
  // 環境変数に直接セットされている場合はそちらを優先
  if (process.env["GITHUB_TOKEN"]) return process.env["GITHUB_TOKEN"];

  // Secret Manager から取得 (Cloud Run環境)
  const project = process.env["GCP_PROJECT"];
  if (!project) throw new Error("GITHUB_TOKEN または GCP_PROJECT が必要です");

  const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({
    name: `projects/${project}/secrets/GITHUB_TOKEN/versions/latest`,
  });
  const data = version.payload?.data;
  if (!data) throw new Error("GITHUB_TOKEN シークレットが空です");
  return typeof data === "string" ? data : Buffer.from(data).toString("utf-8");
}

// ─── 設定の組み立て ───────────────────────────────────────────────────────────

function buildConfig(msg?: IssueQueueMessage): WorkerConfig {
  const agentMode = (process.env["AGENT_MODE"] ?? "GEMINI_ADK") as AgentMode;
  if (agentMode !== "GEMINI_ADK" && agentMode !== "LOCAL_AIDER") {
    throw new Error(`不正な AGENT_MODE: ${agentMode}`);
  }

  // Pub/Sub メッセージ or 環境変数どちらかから取得
  return {
    agentMode,
    gcpProject: process.env["GCP_PROJECT"] ?? "",
    geminiModel: process.env["GEMINI_MODEL"] ?? "gemini-2.0-flash",
    aiderModel: process.env["AIDER_MODEL"] ?? "qwen2.5-coder:32b",
    ollamaApiBase: process.env["OLLAMA_API_BASE"] ?? "http://localhost:11434/v1",
    githubToken: process.env["GITHUB_TOKEN"] ?? "",
    githubRepo: msg?.repoFullName ?? requireEnv("GITHUB_REPO"),
    issueNumber: msg?.issueNumber ?? Number(requireEnv("ISSUE_NUMBER")),
    issueTitle: msg?.issueTitle ?? requireEnv("ISSUE_TITLE"),
    issueBody: msg?.issueBody ?? (process.env["ISSUE_BODY"] ?? ""),
    issueAuthor: msg?.issueAuthor ?? (process.env["ISSUE_AUTHOR"] ?? "unknown"),
    defaultBranch: msg?.defaultBranch ?? (process.env["DEFAULT_BRANCH"] ?? "main"),
    dryRun: process.env["DRY_RUN"] === "true",
  };
}

// ─── AIプロンプト ─────────────────────────────────────────────────────────────

function buildPrompt(cfg: WorkerConfig): string {
  return [
    `以下のGitHub Issueに対応するデモ実装を行ってください。`,
    ``,
    `## Issue #${cfg.issueNumber}`,
    `タイトル: ${cfg.issueTitle}`,
    `作成者: @${cfg.issueAuthor}`,
    ``,
    `## 内容`,
    cfg.issueBody || "(本文なし)",
    ``,
    `## 実装ガイドライン`,
    `- 既存コードのアーキテクチャとスタイルに従ってください`,
    `- 必要に応じてテストコードを追加してください`,
    `- コミットメッセージは \`feat: <内容> (closes #${cfg.issueNumber})\` の形式にしてください`,
    `- 変更は最小限にとどめ、動作するデモ実装を目指してください`,
  ].join("\n");
}

// ─── Git処理 ─────────────────────────────────────────────────────────────────

function setupRepo(cfg: WorkerConfig): { repoDir: string; workDir: string } {
  const workDir = mkdtempSync(join(tmpdir(), "adk-agent-"));
  const repoDir = join(workDir, "repo");
  const cloneUrl = `https://x-access-token:${cfg.githubToken}@github.com/${cfg.githubRepo}.git`;

  console.log(`📥 クローン中: ${cfg.githubRepo}`);
  run(`git clone --depth=1 --branch ${cfg.defaultBranch} "${cloneUrl}" "${repoDir}"`);

  // GitHub CLIの認証
  process.env["GH_TOKEN"] = cfg.githubToken;
  process.env["GITHUB_TOKEN"] = cfg.githubToken;

  return { repoDir, workDir };
}

function createBranch(cfg: WorkerConfig, repoDir: string): string {
  const branch = `demo/issue-${cfg.issueNumber}`;
  console.log(`🌿 ブランチ作成: ${branch}`);
  run(`git checkout -b "${branch}"`, repoDir);
  return branch;
}

function commitAndPush(cfg: WorkerConfig, repoDir: string, branch: string): boolean {
  // ステージング
  run("git add -A", repoDir);

  // 変更確認
  const status = capture("git status --porcelain", repoDir);
  if (!status) {
    console.warn("⚠️  変更なし - スキップ");
    return false;
  }

  // コミット (エージェントが既にコミットしている場合はスキップ)
  const unpushed = capture(`git log origin/${cfg.defaultBranch}..HEAD --oneline`, repoDir);
  if (!unpushed) {
    run(
      `git commit -m "feat: AI agent implementation for issue #${cfg.issueNumber}\\n\\n${cfg.issueTitle.replace(/"/g, '\\"')}\\n\\ncloses #${cfg.issueNumber}"`,
      repoDir
    );
  }

  run(`git push origin "${branch}"`, repoDir);
  return true;
}

function createPR(cfg: WorkerConfig, repoDir: string, branch: string): void {
  const title = `[AIエージェント] Issue #${cfg.issueNumber}: ${cfg.issueTitle}`;
  const body = [
    `## 🤖 AIエージェントによる自動実装`,
    ``,
    `Issue #${cfg.issueNumber} の要件に基づき、${cfg.agentMode} が自動でデモ実装を行いました。`,
    ``,
    `## 対応Issue`,
    `closes #${cfg.issueNumber}`,
    ``,
    `## エージェント情報`,
    `- モード: \`${cfg.agentMode}\``,
    `- モデル: \`${cfg.agentMode === "GEMINI_ADK" ? cfg.geminiModel : cfg.aiderModel}\``,
    `- 実行日時: ${new Date().toISOString()}`,
    ``,
    `## レビューポイント`,
    `- [ ] 実装の要件適合性`,
    `- [ ] 既存コードスタイルとの一貫性`,
    `- [ ] テストカバレッジ`,
    `- [ ] セキュリティ上の問題がないか`,
  ].join("\n");

  run(
    [
      `gh pr create`,
      `--repo "${cfg.githubRepo}"`,
      `--base "${cfg.defaultBranch}"`,
      `--head "${branch}"`,
      `--title "${title.replace(/"/g, '\\"')}"`,
      `--body "${body.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`,
    ].join(" "),
    repoDir
  );
  console.log(`✅ PR作成完了: ${title}`);
}

// ─── エージェント実行: Gemini ADK ────────────────────────────────────────────

async function runGeminiADK(cfg: WorkerConfig, repoDir: string): Promise<void> {
  console.log(`🤖 Gemini ADK エージェント実行 (モデル: ${cfg.geminiModel})`);

  // ADKエージェント定義を動的生成してrepoDir内に配置
  const agentScript = buildADKAgentScript(cfg);
  const agentPath = join(repoDir, ".adk_agent_runner.py");
  writeFileSync(agentPath, agentScript, "utf-8");

  // Python仮想環境でADKを実行
  const venvPython = process.env["VENV_PATH"]
    ? `${process.env["VENV_PATH"]}/bin/python`
    : "python3";

  run(`${venvPython} "${agentPath}"`, repoDir);
}

function buildADKAgentScript(cfg: WorkerConfig): string {
  const prompt = buildPrompt(cfg).replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');

  return `#!/usr/bin/env python3
"""
Gemini ADK (Agent Development Kit) を使用したコード修正エージェント
Issue: #${cfg.issueNumber}
"""
import os
import sys
import subprocess
from google.adk.agents import Agent
from google.adk.tools import FunctionTool
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai.types import Content, Part

# ─── ツール定義 ───────────────────────────────────────────────────────────────

def read_file(path: str) -> str:
    """指定したファイルの内容を読み込む"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        return f"ERROR: {e}"

def write_file(path: str, content: str) -> str:
    """ファイルに内容を書き込む"""
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return f"OK: {path} に書き込みました"
    except Exception as e:
        return f"ERROR: {e}"

def list_files(directory: str = ".") -> str:
    """ディレクトリ内のファイル一覧を取得"""
    try:
        result = subprocess.run(
            ["find", directory, "-type", "f",
             "-not", "-path", "*/.git/*",
             "-not", "-path", "*/node_modules/*",
             "-not", "-path", "*/__pycache__/*"],
            capture_output=True, text=True, timeout=10
        )
        return result.stdout or "(空)"
    except Exception as e:
        return f"ERROR: {e}"

def run_command(command: str) -> str:
    """シェルコマンドを実行して出力を返す (読み取り専用操作のみ)"""
    ALLOWED = ["cat ", "ls ", "find ", "head ", "tail ", "grep ", "wc ", "git diff", "git log", "git status"]
    if not any(command.strip().startswith(a) for a in ALLOWED):
        return f"ERROR: セキュリティ上の理由でコマンド '{command}' は実行できません"
    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True, timeout=30
        )
        return (result.stdout + result.stderr)[:5000]
    except Exception as e:
        return f"ERROR: {e}"

# ─── ADK エージェント定義 ─────────────────────────────────────────────────────

tools = [
    FunctionTool(read_file),
    FunctionTool(write_file),
    FunctionTool(list_files),
    FunctionTool(run_command),
]

agent = Agent(
    name="devops_code_agent",
    model="${cfg.geminiModel}",
    description="GitHubのIssueに基づいてコードを修正するDevOpsエージェント",
    instruction="""
あなたはDevOpsエンジニアリングのエキスパートAIエージェントです。
GitHubのIssueに基づいて、リポジトリのコードを修正・実装します。

作業手順:
1. まず list_files で既存のファイル構成を確認する
2. 関連するファイルを read_file で読み込んで内容を把握する
3. Issueの要件に基づいて適切なコード変更を実装する
4. write_file で変更を保存する
5. 変更の概要をまとめて報告する

注意:
- 既存のコードスタイル、アーキテクチャ、命名規則に従うこと
- 最小限の変更で要件を満たすこと
- 変更したファイルの一覧を最後に列挙すること
""",
    tools=tools,
)

# ─── 実行 ─────────────────────────────────────────────────────────────────────

session_service = InMemorySessionService()
runner = Runner(
    agent=agent,
    app_name="devops-ai-agent",
    session_service=session_service,
)

session = session_service.create_session(
    app_name="devops-ai-agent",
    user_id="github-issue-bot",
)

prompt_text = """${prompt}"""

print(f"\\n🤖 Gemini ADK エージェント開始")
print(f"   プロンプト文字数: {len(prompt_text)}")
print("-" * 60)

final_response = ""
for event in runner.run(
    user_id="github-issue-bot",
    session_id=session.id,
    new_message=Content(role="user", parts=[Part(text=prompt_text)]),
):
    if event.is_final_response() and event.content and event.content.parts:
        final_response = event.content.parts[0].text

print("\\n📝 エージェント応答:")
print(final_response)
print("-" * 60)
print("✅ Gemini ADK エージェント完了")
`;
}

// ─── エージェント実行: Aider + Ollama ────────────────────────────────────────

function runAider(cfg: WorkerConfig, repoDir: string): void {
  console.log(`🤖 Aider エージェント実行 (モデル: ${cfg.aiderModel})`);
  const prompt = buildPrompt(cfg).replace(/"/g, '\\"').replace(/\n/g, "\\n");

  run(
    [
      `aider`,
      `--model "${cfg.aiderModel}"`,
      `--openai-api-base "${cfg.ollamaApiBase}"`,
      `--yes`,
      `--message "${prompt}"`,
    ].join(" "),
    repoDir
  );
}

// ─── メインワーカー処理 ───────────────────────────────────────────────────────

async function processIssue(msg?: IssueQueueMessage): Promise<void> {
  const cfg = buildConfig(msg);

  console.log(`\n📋 処理開始${cfg.dryRun ? " [DRY_RUN]" : ""}`);
  console.log(`  リポジトリ : ${cfg.githubRepo}`);
  console.log(`  Issue      : #${cfg.issueNumber} "${cfg.issueTitle}"`);
  console.log(`  エージェント: ${cfg.agentMode}`);
  console.log(`  開始時刻   : ${new Date().toISOString()}`);

  if (cfg.dryRun) {
    // ── DRY_RUN: 実際のGCP認証・git操作・エージェント実行を一切行わず、
    //    HTTPリクエストの受信〜設定の組み立てまでの疎通確認のみ行う ──────────
    const branch = `demo/issue-${cfg.issueNumber}`;
    console.log(`🧪 [DRY_RUN] GitHub Token解決 (Secret Manager) をスキップ`);
    console.log(`🧪 [DRY_RUN] git clone をスキップ (対象: ${cfg.githubRepo})`);
    console.log(`🧪 [DRY_RUN] ブランチ作成をスキップ: ${branch}`);
    switch (cfg.agentMode) {
      case "GEMINI_ADK":
        console.log(`🧪 [DRY_RUN] Gemini ADK エージェント実行をスキップ (モデル: ${cfg.geminiModel})`);
        break;
      case "LOCAL_AIDER":
        console.log(`🧪 [DRY_RUN] Aider エージェント実行をスキップ (モデル: ${cfg.aiderModel})`);
        break;
    }
    console.log(`   プロンプト:\n${buildPrompt(cfg)}`);
    console.log(`🧪 [DRY_RUN] git push をスキップ`);
    console.log(`🧪 [DRY_RUN] gh pr create をスキップ`);
    console.log(`\n✅ [DRY_RUN] 処理完了 (実際の変更は行われていません): ${new Date().toISOString()}`);
    return;
  }

  // GitHub Tokenの解決 (Secret Manager or 環境変数)
  if (!cfg.githubToken) {
    cfg.githubToken = await resolveGithubToken();
  }

  const { repoDir, workDir } = setupRepo(cfg);

  try {
    const branch = createBranch(cfg, repoDir);

    // エージェント実行
    switch (cfg.agentMode) {
      case "GEMINI_ADK":
        await runGeminiADK(cfg, repoDir);
        break;
      case "LOCAL_AIDER":
        runAider(cfg, repoDir);
        break;
    }

    // コミット & プッシュ & PR作成
    const pushed = commitAndPush(cfg, repoDir, branch);
    if (pushed) {
      createPR(cfg, repoDir, branch);
    } else {
      console.warn("⚠️  変更がなかったためPRを作成しませんでした");
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    console.log("🧹 作業ディレクトリ削除完了");
  }

  console.log(`\n✅ 処理完了: ${new Date().toISOString()}`);
}

// ─── HTTPサーバー (Cloud Run Pub/Sub Push受信) ────────────────────────────────

const httpApp = new Hono();
httpApp.use("*", logger());

httpApp.get("/health", (c) =>
  c.json({
    status: "healthy",
    mode: process.env["AGENT_MODE"],
    dryRun: process.env["DRY_RUN"] === "true",
  })
);

httpApp.post("/worker", async (c) => {
  // Pub/Sub Push形式のデコード
  interface PubSubPush {
    message: { data: string; messageId: string };
    subscription: string;
  }

  let body: PubSubPush;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSONパースエラー" }, 400);
  }

  let queueMsg: IssueQueueMessage;
  try {
    const decoded = Buffer.from(body.message.data, "base64").toString("utf-8");
    queueMsg = JSON.parse(decoded);
  } catch {
    return c.json({ error: "メッセージデコードエラー" }, 400);
  }

  console.log(`📬 Pub/Subメッセージ受信: Issue #${queueMsg.issueNumber}`);

  // 非同期で処理 (Cloud RunのHTTPタイムアウトを回避するため即座に202を返す)
  // 注意: @hono/node-server (Node.js/Cloud Run) には Cloudflare Workers の
  // executionCtx.waitUntil() に相当する仕組みがないため、単純にawaitせず
  // 非同期関数を発火するだけにとどめる。
  processIssue(queueMsg).catch(console.error);

  return c.json({ accepted: true, issueNumber: queueMsg.issueNumber }, 202);
});

// ─── 起動モード判定 ───────────────────────────────────────────────────────────

const isHTTPMode = process.env["PORT"] !== undefined || process.env["HTTP_MODE"] === "true";

if (isHTTPMode) {
  // Cloud Run: HTTPサーバーとして起動
  const port = Number(process.env["PORT"] ?? 8091);
  console.log(`🚀 Worker HTTPサーバー起動 port=${port}`);
  serve({ fetch: httpApp.fetch, port });
} else {
  // ローカル / 直接実行: 環境変数からIssue情報を読み込んで即実行
  console.log("🚀 Worker 直接実行モード");
  processIssue().catch((err) => {
    console.error("❌ エラー:", err);
    process.exit(1);
  });
}
