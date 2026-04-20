import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelJobPgid } from "../lib/qwen.mjs";

// v0.1.1:verifyFn 默认会 `ps -g <pgid>` 验证 qwen 仍在 pgid 下。
// 测试注入 verifyFn=() => true 假装 pgid 归 qwen,跳过真 ps。
const mockVerifyTrue = () => true;

test("cancelJobPgid: 三级信号按顺序发", async () => {
  const calls = [];
  const killFn = (pid, sig) => { calls.push({ pid, sig }); };
  const r = await cancelJobPgid(12345, { sleepMs: 1, killFn, verifyFn: mockVerifyTrue });
  assert.equal(r.ok, true);
  // 现在加了 pre-check probe(sig 0),所以第一次 kill(-pgid, 0) 也会被记
  const sigs = calls.map(c => c.sig);
  assert.ok(sigs.includes("SIGINT") && sigs.includes("SIGTERM") && sigs.includes("SIGKILL"));
  assert.ok(calls.every(c => c.pid === -12345));
});

test("cancelJobPgid: pre-check ESRCH(pgid 已无进程)→ 直接 ok,不 ps 也不发信号", async () => {
  const calls = [];
  const killFn = (pid, sig) => {
    calls.push({ pid, sig });
    // 第一次 probe (sig=0) 就抛 ESRCH
    if (sig === 0) { const e = new Error("no proc"); e.code = "ESRCH"; throw e; }
  };
  const r = await cancelJobPgid(12345, { sleepMs: 1, killFn, verifyFn: mockVerifyTrue });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1); // 只有 probe,不升级
});

test("cancelJobPgid: 信号升级中 ESRCH → ok", async () => {
  const calls = [];
  const killFn = (pid, sig) => {
    calls.push({ pid, sig });
    if (sig === "SIGINT") { const e = new Error("no proc"); e.code = "ESRCH"; throw e; }
  };
  const r = await cancelJobPgid(12345, { sleepMs: 1, killFn, verifyFn: mockVerifyTrue });
  assert.equal(r.ok, true);
});

test("cancelJobPgid: 非 ESRCH 错 → cancel_failed", async () => {
  const killFn = (pid, sig) => {
    if (sig === "SIGTERM") { const e = new Error("perm denied"); e.code = "EPERM"; throw e; }
  };
  const r = await cancelJobPgid(12345, { sleepMs: 1, killFn, verifyFn: mockVerifyTrue });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "cancel_failed");
  assert.match(r.message, /perm denied|EPERM|SIGTERM/);
});

// v0.1.1 新增:pgid 被 OS 回收给无关进程组时,verify 失败 → 拒绝发杀信号
test("cancelJobPgid: pgid_recycled(verify 失败)→ cancel_failed,不发 SIGKILL", async () => {
  const calls = [];
  const killFn = (pid, sig) => { calls.push({ pid, sig }); };
  const r = await cancelJobPgid(12345, {
    sleepMs: 1, killFn,
    verifyFn: () => false, // pgid 下没 qwen(被回收)
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "cancel_failed");
  assert.match(r.message, /pgid_recycled/);
  // 只有 probe (sig=0),没有 SIGINT/TERM/KILL
  assert.deepEqual(calls.map(c => c.sig), [0]);
});
