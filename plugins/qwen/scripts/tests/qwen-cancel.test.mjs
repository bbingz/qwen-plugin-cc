import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelJobPgid } from "../lib/qwen.mjs";

test("cancelJobPgid: 三级信号按顺序发", async () => {
  const calls = [];
  const killFn = (pid, sig) => { calls.push({ pid, sig }); };
  const r = await cancelJobPgid(12345, { sleepMs: 1, killFn });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map(c => c.sig), ["SIGINT", "SIGTERM", "SIGKILL"]);
  assert.ok(calls.every(c => c.pid === -12345));
});

test("cancelJobPgid: ESRCH 吞掉,后续不发", async () => {
  const calls = [];
  const killFn = (pid, sig) => {
    calls.push({ pid, sig });
    if (sig === "SIGINT") { const e = new Error("no proc"); e.code = "ESRCH"; throw e; }
  };
  const r = await cancelJobPgid(12345, { sleepMs: 1, killFn });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1); // SIGINT 后 ESRCH 直接返回
});

test("cancelJobPgid: 非 ESRCH 错 → cancel_failed", async () => {
  const killFn = (pid, sig) => {
    if (sig === "SIGTERM") { const e = new Error("perm denied"); e.code = "EPERM"; throw e; }
  };
  const r = await cancelJobPgid(12345, { sleepMs: 1, killFn });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "cancel_failed");
  assert.match(r.message, /perm denied|EPERM|SIGTERM/);
});
