import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cleanupSessionJobs } from "../session-lifecycle-hook.mjs";

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
