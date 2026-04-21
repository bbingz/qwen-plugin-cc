import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cleanupSessionJobs, filterJobsOwnedBySession } from "../session-lifecycle-hook.mjs";

test("filterJobsOwnedBySession: claudeSessionId 匹配的 running 才收", () => {
  const jobs = [
    { jobId: "a", claudeSessionId: "cc-1", status: "running" },
    { jobId: "b", claudeSessionId: "cc-2", status: "running" },
    { jobId: "c", claudeSessionId: "cc-1", status: "completed" },
    { jobId: "d", claudeSessionId: "cc-1", status: "queued" },
  ];
  const r = filterJobsOwnedBySession(jobs, "cc-1");
  assert.deepEqual(r.map((j) => j.jobId).sort(), ["a", "d"]);
});

test("filterJobsOwnedBySession: 无 claudeSessionId 的 legacy job → 不收(P1-SEC-4 改 false)", () => {
  // v0.2 前 fallback=true 会把无字段的 job 归当前 session → 跨 CC 误杀。
  // v0.2.1 改 false:无字段 = 不属于任何 session,不清理,等懒 finalize。
  const jobs = [
    { jobId: "legacy", status: "running" },  // 无 claudeSessionId
    { jobId: "current", claudeSessionId: "cc-1", status: "running" },
  ];
  const r = filterJobsOwnedBySession(jobs, "cc-1");
  assert.deepEqual(r.map((j) => j.jobId), ["current"]);
});

test("filterJobsOwnedBySession: 异常输入", () => {
  assert.deepEqual(filterJobsOwnedBySession(null, "x"), []);
  assert.deepEqual(filterJobsOwnedBySession([null, undefined], "x"), []);
  assert.deepEqual(filterJobsOwnedBySession([], "x"), []);
});

test("cleanupSessionJobs: cwd 缺失不炸", async () => {
  await assert.doesNotReject(() => cleanupSessionJobs(null, "sid"));
  await assert.doesNotReject(() => cleanupSessionJobs("", "sid"));
});

test("cleanupSessionJobs: sessionId 缺失不炸", async () => {
  await assert.doesNotReject(() => cleanupSessionJobs("/tmp/fake-cwd", null));
  await assert.doesNotReject(() => cleanupSessionJobs("/tmp/fake-cwd", ""));
});

test("cleanupSessionJobs: 无 state 文件 silently return(无异常)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-hook-"));
  const oldEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tmp;
  try {
    await assert.doesNotReject(() => cleanupSessionJobs(tmp, "cc-session-xyz"));
  } finally {
    if (oldEnv == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = oldEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
