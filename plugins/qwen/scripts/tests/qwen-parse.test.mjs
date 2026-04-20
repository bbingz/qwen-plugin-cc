import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStreamEvents } from "../lib/qwen.mjs";

const NORMAL_JSONL = `
{"type":"system","subtype":"init","session_id":"abc","model":"qwen3.5-plus","mcp_servers":[]}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"pong"}]}}
{"type":"result","is_error":false,"result":"pong","duration_ms":120,"num_turns":1}
`.trim();

const API_ERROR_JSONL = `
{"type":"system","subtype":"init","session_id":"xyz","model":"qwen3.5-plus"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"[API Error: 401 token expired]"}]}}
{"type":"result","is_error":false,"result":"[API Error: 401 token expired]"}
`.trim();

// v3.1 F-6: thinking 块必须跳过
const WITH_THINKING_JSONL = `
{"type":"system","subtype":"init","session_id":"tk1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"User wants X"},{"type":"text","text":"answer"}]}}
`.trim();

test("parseStreamEvents: 正常输出提取 init/assistant/result", () => {
  const { sessionId, model, mcpServers, assistantTexts, resultEvent } = parseStreamEvents(NORMAL_JSONL);
  assert.equal(sessionId, "abc");
  assert.equal(model, "qwen3.5-plus");
  assert.deepEqual(mcpServers, []);
  assert.deepEqual(assistantTexts, ["pong"]);
  assert.equal(resultEvent.is_error, false);
});

test("parseStreamEvents: API Error 文本被收集到 assistantTexts", () => {
  const { assistantTexts } = parseStreamEvents(API_ERROR_JSONL);
  assert.ok(assistantTexts.some(t => /\[API Error:/.test(t)));
});

test("parseStreamEvents: 空行/坏行不崩", () => {
  const stream = `
{"type":"system","subtype":"init","session_id":"abc"}

not json at all
{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}
`.trim();
  const r = parseStreamEvents(stream);
  assert.equal(r.sessionId, "abc");
  assert.deepEqual(r.assistantTexts, ["ok"]);
});

test("parseStreamEvents: F-6 thinking 块被跳过,只收 text", () => {
  const { assistantTexts } = parseStreamEvents(WITH_THINKING_JSONL);
  assert.deepEqual(assistantTexts, ["answer"], "thinking 被过滤,只留 text");
});
