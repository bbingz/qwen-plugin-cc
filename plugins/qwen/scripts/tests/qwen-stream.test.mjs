import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { streamQwenOutput } from "../lib/qwen.mjs";

function fakeChild(chunks) {
  const stdout = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = stdout;
  child.pid = 999999; // 肯定不存在的 pid,process.kill 会 ESRCH(已被吞)
  setImmediate(() => {
    for (const c of chunks) stdout.emit("data", Buffer.from(c));
    child.emit("exit", 0);
  });
  return child;
}

test("streamQwenOutput: 正常输出,assistantTexts 收集", async () => {
  const child = fakeChild([
    '{"type":"system","subtype":"init","session_id":"s1","model":"m1"}\n',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}\n',
    '{"type":"result","is_error":false,"result":"hello"}\n',
  ]);
  const r = await streamQwenOutput({ child, background: false });
  assert.equal(r.sessionId, "s1");
  assert.deepEqual(r.assistantTexts, ["hello"]);
  assert.equal(r.resultEvent.is_error, false);
});

test("streamQwenOutput: bg 模式命中 API Error 早退", { timeout: 3000 }, async () => {
  const child = fakeChild([
    '{"type":"system","subtype":"init","session_id":"s1"}\n',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"[API Error: 401]"}]}}\n',
  ]);
  child.pid = 999999; // process.kill(-pid, SIGTERM) 会 ESRCH,try/catch 吞
  const r = await streamQwenOutput({ child, background: true });
  assert.equal(r.apiErrorEarly, true);
  assert.ok(r.assistantTexts.some(t => /\[API Error:/.test(t)));
});

test("streamQwenOutput: fg 模式不早退,读完全部", async () => {
  const child = fakeChild([
    '{"type":"assistant","message":{"content":[{"type":"text","text":"[API Error: 401]"}]}}\n',
    '{"type":"result","is_error":false,"result":"[API Error: 401]"}\n',
  ]);
  const r = await streamQwenOutput({ child, background: false });
  assert.equal(r.apiErrorEarly, false);
  assert.ok(r.resultEvent);
});

test("streamQwenOutput: onAssistantText 回调(stdout 透传用)", async () => {
  const child = fakeChild([
    '{"type":"assistant","message":{"content":[{"type":"text","text":"abc"}]}}\n',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"def"}]}}\n',
  ]);
  const seen = [];
  await streamQwenOutput({ child, background: false, onAssistantText: (t) => seen.push(t) });
  assert.deepEqual(seen, ["abc", "def"]);
});
