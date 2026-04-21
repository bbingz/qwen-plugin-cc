#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { loadState, resolveStateFile } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/git.mjs";
import { refreshJobLiveness } from "./lib/job-lifecycle.mjs";
import { cancelJobPgid } from "./lib/qwen.mjs";

// Claude v0.1.1 P1-4:SessionEnd 终止 job 走 cancelJobPgid,而非裸 kill。
// cancelJobPgid 有 pre-kill probe + `ps -g <pgid>` verify,能识别 pgid 已被
// OS 回收给无关进程组的情况,避免 session 关闭时误杀。
async function terminateJob(job) {
  const target = job.pgid ?? job.pid;
  if (!Number.isFinite(target)) return;
  try {
    await cancelJobPgid(target, { sleepMs: 500 });
  } catch {
    // 保底:cancelJobPgid 不该 throw(内部已 catch),兜底忽略
  }
}

import { SESSION_ID_ENV } from "./lib/job-control.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

async function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  // P0-3: 筛 claudeSessionId(job 启动时从 SESSION_ID_ENV 持久化)。
  // 历史 job 没这字段 → 直接按 cwd slug 命中的全量 running job 都算本 workspace 的
  // (SessionEnd 关闭当前 CC 会话时一并清)。
  const sessionJobs = state.jobs.filter((job) => {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) return false;
    if (job.claudeSessionId) return job.claudeSessionId === sessionId;
    return true; // 无 claudeSessionId 的历史记录归入本 workspace fallback
  });
  if (sessionJobs.length === 0) {
    return;
  }

  // SessionEnd 策略:
  // - 本 CC session 的 running job:先 refreshJobLiveness 读 log 落 jobs/<id>.json,再 kill
  // - 已完成的 job:原样保留(下次会话仍可 /qwen:result 查)
  // sessionJobs 已筛出仅 running 且归本 session 的
  for (const job of sessionJobs) {
    try { refreshJobLiveness(workspaceRoot, job); } catch { /* ignore */ }
    await terminateJob(job);
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  await cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

// 仅作为入口脚本时运行 main(test import 不触发)
if (process.argv[1] && process.argv[1].endsWith("session-lifecycle-hook.mjs")) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack || error.message) : String(error)}\n`);
    process.exit(1);
  });
}

export { cleanupSessionJobs };
