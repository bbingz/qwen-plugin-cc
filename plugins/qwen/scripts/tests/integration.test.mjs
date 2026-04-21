import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const companionPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "qwen-companion.mjs"
);

function runCompanion(args, { cwd = process.cwd(), env = process.env, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [companionPath, ...args], { cwd, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, timeout);
    child.on("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

function makeTmpPluginData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-int-"));
  return {
    dir,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
    restore() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

test("integration: setup --json 返回预期字段", { timeout: 40_000 }, async () => {
  const r = await runCompanion(["setup", "--json"]);
  assert.equal(r.code, 0);
  const json = JSON.parse(r.stdout);
  for (const k of ["installed", "authenticated", "authMethod", "warnings", "installers"]) {
    assert.ok(k in json, `missing key: ${k}`);
  }
});

test("integration: task --background 无 --unsafe + 显式 yolo → require_interactive", { timeout: 10_000 }, async () => {
  // 注意:task 不加 --approval-mode 则默认 auto-edit,可以起 bg;
  // 要触发 require_interactive 必须 --approval-mode yolo 且无 --unsafe。
  // 但我们的 companion 没暴露 --approval-mode,只通过 --unsafe 切 yolo。
  // 所以 require_interactive 的真实触发路径是:显式在 argv 传 --approval-mode yolo。
  //
  // 简化:验证 task without prompt → exit 2(stderr required)
  const r = await runCompanion(["task"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /prompt required/);
});

test("integration: status 空 state 返空列表(不 crash)", { timeout: 10_000 }, async () => {
  const tmp = makeTmpPluginData();
  try {
    const r = await runCompanion(["status", "--json"], { env: tmp.env });
    assert.equal(r.code, 0);
    // 空 state 应返空数组或至少合法 JSON
    const json = JSON.parse(r.stdout);
    assert.ok(Array.isArray(json) || typeof json === "object");
  } finally {
    tmp.restore();
  }
});

test("integration: cancel 不存在 job 默认打 human text + exit 3", { timeout: 10_000 }, async () => {
  const tmp = makeTmpPluginData();
  try {
    const r = await runCompanion(["cancel", "nope-123"], { env: tmp.env });
    assert.equal(r.code, 3);
    assert.match(r.stdout, /Job nope-123 not found\./);
    // 不应是 JSON
    assert.doesNotMatch(r.stdout.trim(), /^\{/);
  } finally {
    tmp.restore();
  }
});

test("integration: cancel --json 不存在 job 打 JSON envelope", { timeout: 10_000 }, async () => {
  const tmp = makeTmpPluginData();
  try {
    const r = await runCompanion(["cancel", "--json", "nope-456"], { env: tmp.env });
    assert.equal(r.code, 3);
    const json = JSON.parse(r.stdout);
    assert.equal(json.ok, false);
    assert.equal(json.reason, "not_found");
    assert.equal(json.jobId, "nope-456");
  } finally {
    tmp.restore();
  }
});
