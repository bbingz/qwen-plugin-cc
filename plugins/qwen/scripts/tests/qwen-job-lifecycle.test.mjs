import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { refreshJobLiveness, extractStderrFromLog } from "../lib/job-lifecycle.mjs";
import { resolveJobLogFile, ensureStateDir, upsertJob, listJobs } from "../lib/state.mjs";

// 每个 test 用独立临时 cwd 隔离 state。
function withTempCwd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-lifecycle-test-"));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// 一个肯定不存在的 pid,process.kill(pid, 0) 会抛 ESRCH。
// 挑一个大数且罕见(若真碰上在用 pid 测试就挂,但碰撞概率极小)。
const DEAD_PID = 999999;

function writeStreamLog(logFile, { withResult = true, assistantText = "ok" } = {}) {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "test-session", model: "qwen3.5-plus" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: assistantText }] } }),
  ];
  if (withResult) {
    lines.push(JSON.stringify({ type: "result", result: assistantText }));
  }
  fs.writeFileSync(logFile, lines.join("\n") + "\n");
}

test("refreshJobLiveness: 活 pid + verifyFn 说是 qwen → 返原 job(不 finalize)", () => {
  // v0.2.1 P0-1:活 pid 不够,还要 verifyFn 确认是 qwen basename。
  // 用 process.pid 但 inject verifyFn=() => true 模拟"命令行是 qwen"。
  withTempCwd((cwd) => {
    const job = {
      jobId: "job-alive",
      status: "running",
      pid: process.pid,
    };
    const out = refreshJobLiveness(cwd, job, { verifyFn: () => true });
    assert.equal(out.status, "running");
    assert.equal(out, job);
  });
});

test("refreshJobLiveness: 死 pid + 有 log + 完整 stream → completed + result", () => {
  withTempCwd((cwd) => {
    ensureStateDir(cwd);
    const logFile = resolveJobLogFile(cwd, "job-done");
    writeStreamLog(logFile, { withResult: true, assistantText: "hello" });

    const job = {
      jobId: "job-done",
      status: "running",
      pid: DEAD_PID,
      logFile,
    };
    upsertJob(cwd, job); // 预先落 state 让 writeJobFile 路径完整

    const out = refreshJobLiveness(cwd, job);
    assert.equal(out.status, "completed");
    assert.equal(out.result, "hello");
    assert.equal(out.sessionId, "test-session");
    assert.equal(out.failure, null);

    // 断言:state 里已更新为 completed
    const jobs = listJobs(cwd);
    const updated = jobs.find((j) => j.jobId === "job-done");
    assert.equal(updated.status, "completed");
  });
});

test("refreshJobLiveness: 死 pid + 有 log + 无 resultEvent → incomplete_stream failed", () => {
  withTempCwd((cwd) => {
    ensureStateDir(cwd);
    const logFile = resolveJobLogFile(cwd, "job-crash");
    writeStreamLog(logFile, { withResult: false, assistantText: "partial" });

    const job = {
      jobId: "job-crash",
      status: "running",
      pid: DEAD_PID,
      logFile,
    };
    upsertJob(cwd, job);

    const out = refreshJobLiveness(cwd, job);
    assert.equal(out.status, "failed");
    assert.equal(out.failure?.kind, "incomplete_stream");
    // 有 assistantText 但无 result,result 字段应为 null
    assert.equal(out.result, null);
  });
});

test("refreshJobLiveness: 死 pid + 无 log → orphan failed", () => {
  withTempCwd((cwd) => {
    ensureStateDir(cwd);
    const job = {
      jobId: "job-orphan",
      status: "running",
      pid: DEAD_PID,
      logFile: "/nonexistent/path/to/log",
    };
    upsertJob(cwd, job);

    const out = refreshJobLiveness(cwd, job);
    assert.equal(out.status, "failed");
    assert.equal(out.failure?.kind, "orphan");
  });
});

test("refreshJobLiveness: 非 running 状态原样返回", () => {
  withTempCwd((cwd) => {
    const job = { jobId: "already-done", status: "completed", pid: DEAD_PID };
    const out = refreshJobLiveness(cwd, job);
    assert.equal(out, job);
  });
});

test("refreshJobLiveness: 无 pid 原样返回(未知来源)", () => {
  withTempCwd((cwd) => {
    const job = { jobId: "no-pid", status: "running" };
    const out = refreshJobLiveness(cwd, job);
    assert.equal(out, job);
  });
});

test("refreshJobLiveness: 活 pid 但 PID 复用(非 qwen)→ 走 finalize", () => {
  withTempCwd((cwd) => {
    ensureStateDir(cwd);
    const logFile = resolveJobLogFile(cwd, "job-reused");
    writeStreamLog(logFile, { withResult: true, assistantText: "stale" });

    const job = {
      jobId: "job-reused",
      status: "running",
      pid: process.pid, // 活着,但 verifyFn 说"不是 qwen"
      logFile,
    };
    upsertJob(cwd, job);

    const out = refreshJobLiveness(cwd, job, { verifyFn: () => false });
    assert.equal(out.status, "completed");
    assert.equal(out.result, "stale");
  });
});

test("refreshJobLiveness: 活 pid + verifyFn 说是 qwen → 保留 running", () => {
  withTempCwd((cwd) => {
    const job = {
      jobId: "job-live-verified",
      status: "running",
      pid: process.pid,
    };
    const out = refreshJobLiveness(cwd, job, { verifyFn: () => true });
    assert.equal(out.status, "running");
    assert.equal(out, job);
  });
});

test("extractStderrFromLog: 过滤 JSONL 行,保留非 JSON tail", () => {
  const log = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
    "node:internal/process/task_queues:95",
    "    at process.processTicksAndRejections",
    "Error: ENOSPC: no space left on device",
    "",  // 空行
  ].join("\n");
  const out = extractStderrFromLog(log);
  assert.ok(out.includes("Error: ENOSPC"));
  assert.ok(out.includes("node:internal"));
  assert.ok(!out.includes('"type"'));
});

test("extractStderrFromLog: maxLines 截断", () => {
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push(`line ${i}`);
  const out = extractStderrFromLog(lines.join("\n"), 5);
  const outLines = out.split("\n");
  assert.equal(outLines.length, 5);
  assert.equal(outLines[0], "line 95");
  assert.equal(outLines[4], "line 99");
});

test("refreshJobLiveness: incomplete_stream 填 failure.detail(stderr tail)", () => {
  withTempCwd((cwd) => {
    ensureStateDir(cwd);
    const logFile = resolveJobLogFile(cwd, "job-crash-detail");
    // 混合 JSONL + stderr:没有 result event
    fs.writeFileSync(logFile, [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }),
      "Error: connection reset by peer",
      "    at Socket.emit",
    ].join("\n"));

    const job = { jobId: "job-crash-detail", status: "running", pid: 999999, logFile };
    upsertJob(cwd, job);

    const out = refreshJobLiveness(cwd, job);
    assert.equal(out.status, "failed");
    assert.equal(out.failure.kind, "incomplete_stream");
    assert.ok(out.failure.detail, "detail 非空");
    assert.ok(out.failure.detail.includes("connection reset"));
  });
});
