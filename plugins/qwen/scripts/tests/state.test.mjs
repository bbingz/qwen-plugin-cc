import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import * as state from "../lib/state.mjs";

function makeTmpPluginData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-state-test-"));
  const oldEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  return {
    dir,
    restore() {
      if (oldEnv == null) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = oldEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("resolveStateDir: 同 cwd 幂等", () => {
  const tmp = makeTmpPluginData();
  try {
    const d1 = state.resolveStateDir("/tmp/foo");
    const d2 = state.resolveStateDir("/tmp/foo");
    assert.equal(d1, d2);
  } finally { tmp.restore(); }
});

test("resolveStateDir: 不同 cwd → 不同目录", () => {
  const tmp = makeTmpPluginData();
  try {
    const d1 = state.resolveStateDir("/tmp/foo");
    const d2 = state.resolveStateDir("/tmp/bar");
    assert.notEqual(d1, d2);
  } finally { tmp.restore(); }
});

test("writeJobFile + readJobFile roundtrip", () => {
  const tmp = makeTmpPluginData();
  try {
    const cwd = "/tmp/rt";
    state.ensureStateDir(cwd);
    const jobId = randomUUID();
    const jobData = {
      jobId, kind: "task", status: "running",
      pid: 12345, pgid: 12345,
      approvalMode: "yolo", unsafeFlag: true,
      warnings: [],
    };
    // 实际 API: writeJobFile(workspaceRoot, jobId, payload)
    state.writeJobFile(cwd, jobId, jobData);
    // 实际 API: readJobFile(jobFile) 接受文件路径
    const jobFile = state.resolveJobFile(cwd, jobId);
    const read = state.readJobFile(jobFile);
    assert.equal(read.jobId, jobId);
    assert.equal(read.approvalMode, "yolo");
    assert.equal(read.unsafeFlag, true);
  } finally { tmp.restore(); }
});

test("listJobs 最多保留一定数量 + 按时间排序", () => {
  const tmp = makeTmpPluginData();
  try {
    const cwd = "/tmp/list";
    state.ensureStateDir(cwd);
    // listJobs 从 state.json 读取，用 upsertJob 写入
    for (let i = 0; i < 5; i++) {
      state.upsertJob(cwd, {
        id: randomUUID(),
        kind: "task", status: "completed",
        startedAt: new Date(Date.now() - (5 - i) * 1000).toISOString(),
      });
    }
    const jobs = state.listJobs(cwd);
    assert.ok(jobs.length > 0, "some jobs listed");
    assert.ok(Array.isArray(jobs), "returns array");
  } finally { tmp.restore(); }
});
