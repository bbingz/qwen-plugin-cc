#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getQwenAvailability } from "./lib/qwen.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/job-control.mjs";
import { resolveWorkspaceRoot } from "./lib/git.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

export function filterJobsForCurrentSession(jobs, input = {}) {
  // P0-3: job.sessionId 是 qwen 的 UUID,不是 CC session id;用 claudeSessionId 字段
  // (companion.runTask 启动时从 SESSION_ID_ENV 持久化)。历史 job 无字段走 fallback。
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => {
    if (job.claudeSessionId) return job.claudeSessionId === sessionId;
    return true;
  });
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(_cwd) {
  const availability = getQwenAvailability();
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Qwen is not set up for the review gate.${detail} Run /qwen:setup.`;
}

export function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Qwen review task returned no final output. Run /qwen:review --wait manually or bypass the gate."
    };
  }

  // P0-1 : 扫全部行找首个 ALLOW:/BLOCK:,避免 qwen preamble("Let me think...")误判
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("ALLOW:")) return { ok: true, reason: null };
    if (line.startsWith("BLOCK:")) {
      const reason = line.slice("BLOCK:".length).trim() || text;
      return {
        ok: false,
        reason: `Qwen stop-time review found issues that still need fixes before ending the session: ${reason}`
      };
    }
  }

  return {
    ok: false,
    reason:
      "The stop-time Qwen review task returned an unexpected answer. Run /qwen:review --wait manually or bypass the gate."
  };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "qwen-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  // P0-1: 不再传 --json — task fg 走流式 plain text,hook 直接按 ALLOW:/BLOCK: 解析 stdout。
  const result = spawnSync(process.execPath, [scriptPath, "task", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time Qwen review task timed out after 15 minutes. Run /qwen:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Qwen review task failed: ${detail}`
        : "The stop-time Qwen review task failed. Run /qwen:review --wait manually or bypass the gate."
    };
  }

  return parseStopReviewOutput(result.stdout);
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  // 过滤"活着的" running 记录:state 可能有陈旧 running(bg lazy finalize 未触发),
  // 这里对每个疑似 running 做 process.kill(pid, 0) 探活,死了就不报。
  const runningJob = jobs.find((job) => {
    if (job.status !== "queued" && job.status !== "running") return false;
    if (!job.pid) return true; // 没 pid 字段当 running 处理
    try { process.kill(job.pid, 0); return true; }
    catch { return false; } // ESRCH = 已死,skip
  });
  const runningJobId = runningJob ? runningJob.jobId : null;
  const runningTaskNote = runningJob
    ? `Qwen task ${runningJobId} is still running. Check /qwen:status and use /qwen:cancel ${runningJobId} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

// 仅作为入口脚本时运行 main(test import 不触发)
if (process.argv[1] && process.argv[1].endsWith("stop-review-gate-hook.mjs")) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
