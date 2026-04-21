import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStreamEvents, parseAssistantContent } from "../lib/qwen.mjs";

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

test("parseAssistantContent: text/tool_use/tool_result/image 分别收", () => {
  const blocks = [
    { type: "text", text: "calling tool" },
    { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
    { type: "tool_result", tool_use_id: "t1", content: "file1\nfile2", is_error: false },
    { type: "image", source: { type: "base64", data: "iVBORw0K..." } },
    { type: "thinking", thinking: "internal" },  // F-6 跳过
    { type: "text", text: "done" },
  ];
  const r = parseAssistantContent(blocks);
  assert.deepEqual(r.texts, ["calling tool", "done"]);
  assert.equal(r.toolUses.length, 1);
  assert.deepEqual(r.toolUses[0], { id: "t1", name: "bash", input: { cmd: "ls" } });
  assert.equal(r.toolResults.length, 1);
  assert.deepEqual(r.toolResults[0], { tool_use_id: "t1", content: "file1\nfile2", is_error: false });
  assert.equal(r.imageCount, 1);
});

test("parseAssistantContent: non-array / non-object / null blocks 安全", () => {
  assert.deepEqual(parseAssistantContent(null), { texts: [], toolUses: [], toolResults: [], imageCount: 0 });
  assert.deepEqual(parseAssistantContent(undefined), { texts: [], toolUses: [], toolResults: [], imageCount: 0 });
  assert.deepEqual(parseAssistantContent("string"), { texts: [], toolUses: [], toolResults: [], imageCount: 0 });
  const r = parseAssistantContent([null, undefined, "bad", { type: "text", text: "ok" }]);
  assert.deepEqual(r.texts, ["ok"]);
});

test("parseAssistantContent: tool_use fallback tool_input → input(Qwen/MiniMax P0)", () => {
  const blocks = [
    { type: "tool_use", id: "t1", name: "bash", tool_input: { cmd: "ls" } },
  ];
  const r = parseAssistantContent(blocks);
  assert.equal(r.toolUses.length, 1);
  assert.deepEqual(r.toolUses[0].input, { cmd: "ls" });
});

test("parseAssistantContent: tool_use input 优先于 tool_input(两者并存时)", () => {
  const blocks = [
    { type: "tool_use", id: "t1", name: "bash", input: { real: 1 }, tool_input: { bogus: 2 } },
  ];
  const r = parseAssistantContent(blocks);
  assert.deepEqual(r.toolUses[0].input, { real: 1 });
});

test("parseAssistantContent: tool_result is_error 正确捕获", () => {
  const blocks = [
    { type: "tool_result", tool_use_id: "t1", content: "oops", is_error: true },
  ];
  const r = parseAssistantContent(blocks);
  assert.equal(r.toolResults[0].is_error, true);
});

test("parseStreamEvents: tool_use/tool_result 聚合到顶层字段", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "/etc/hosts" } },
    ]}}),
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_result", tool_use_id: "t1", content: "127.0.0.1 localhost", is_error: false },
      { type: "text", text: "file read" },
    ]}}),
  ].join("\n");
  const r = parseStreamEvents(stream);
  assert.equal(r.toolUses.length, 1);
  assert.equal(r.toolUses[0].name, "read_file");
  assert.equal(r.toolResults.length, 1);
  assert.equal(r.toolResults[0].is_error, false);
  assert.deepEqual(r.assistantTexts, ["file read"]);
});
