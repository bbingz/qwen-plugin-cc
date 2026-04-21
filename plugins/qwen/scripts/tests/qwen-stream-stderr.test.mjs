import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { streamQwenOutput } from "../lib/qwen.mjs";

// Fake child 工具:模拟 node:child_process 最少 surface
function fakeChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 99999;
  return child;
}

test("streamQwenOutput: stderr chunks 累积到 stderrTail(v0.2.1 P1-DOC-3)", async () => {
  const child = fakeChild();
  const promise = streamQwenOutput({ child, background: false });

  child.stderr.emit("data", Buffer.from("first stderr chunk\n"));
  child.stderr.emit("data", Buffer.from("second chunk\n"));
  child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", result: "ok" }) + "\n"));
  child.emit("exit", 0);

  const state = await promise;
  assert.ok(state.stderrTail.includes("first stderr chunk"));
  assert.ok(state.stderrTail.includes("second chunk"));
});

test("streamQwenOutput: stderrTail 超 4KB 滚动截断", async () => {
  const child = fakeChild();
  const promise = streamQwenOutput({ child, background: false });

  // 发送 10KB 数据,应被截到尾 4KB
  for (let i = 0; i < 10; i++) {
    child.stderr.emit("data", Buffer.from("X".repeat(1024)));
  }
  child.stderr.emit("data", Buffer.from("<END_MARKER>"));
  child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", result: "ok" }) + "\n"));
  child.emit("exit", 0);

  const state = await promise;
  assert.ok(state.stderrTail.length <= 4096, `stderrTail 应 ≤4096,实际 ${state.stderrTail.length}`);
  assert.ok(state.stderrTail.includes("<END_MARKER>"), "尾部 marker 应保留");
});

test("streamQwenOutput: state 不泄漏内部 buffer 字段(v0.2.1 P1-COR-4)", async () => {
  const child = fakeChild();
  const promise = streamQwenOutput({ child, background: false });
  child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", result: "ok" }) + "\n"));
  child.emit("exit", 0);

  const state = await promise;
  assert.ok(!("buffer" in state), "内部 buffer 游标不应出现在 resolve 的 state 里");
});

test("streamQwenOutput: 无 stderr 输出时 stderrTail 为空串", async () => {
  const child = fakeChild();
  const promise = streamQwenOutput({ child, background: false });
  child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", result: "ok" }) + "\n"));
  child.emit("exit", 0);

  const state = await promise;
  assert.equal(state.stderrTail, "");
});
