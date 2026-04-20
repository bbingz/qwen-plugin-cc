#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { loadState, resolveStateFile } from "./lib/state.mjs";
import { ensureGitRepository, getRepoRoot } from "./lib/git.mjs";
import { refreshJobLiveness } from "./lib/job-lifecycle.mjs";

function terminateProcessTree(pid) {
  if (!Number.isFinite(pid)) {
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Ignore if process already gone.
    }
  }
}

export const SESSION_ID_ENV = "QWEN_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function resolveWorkspaceRoot(cwd) {
  try {
    ensureGitRepository(cwd);
    return getRepoRoot(cwd) || cwd;
  } catch {
    return cwd;
  }
}

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

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const sessionJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (sessionJobs.length === 0) {
    return;
  }

  // SessionEnd 策略(修正后):
  // - still-running bg job:先 refreshJobLiveness 读 log 落 jobs/<id>.json,再 kill process
  // - 已完成的 job:原样保留(让用户下次会话仍可 /qwen:result 查)
  // - state.json 记录保留(不 filter session jobs);否则 saveState 会触发
  //   cleanupOrphanedFiles 把刚 finalize 的文件又删了
  for (const job of sessionJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) continue;
    try { refreshJobLiveness(workspaceRoot, job); } catch { /* ignore */ }
    try { terminateProcessTree(job.pid ?? Number.NaN); } catch { /* ignore */ }
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack || error.message) : String(error)}\n`);
  process.exit(1);
});
