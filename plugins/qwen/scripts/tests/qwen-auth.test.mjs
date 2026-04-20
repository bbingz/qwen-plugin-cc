import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAuthStatusText } from "../lib/qwen.mjs";

test("parseAuthStatusText: Coding Plan 格式", () => {
  const text = `=== Authentication Status ===
✓ Authentication Method: Alibaba Cloud Coding Plan
  Region: 中国 (China) - 阿里云百炼
  Current Model: qwen3.5-plus
  Status: API key configured`;
  const result = parseAuthStatusText(text);
  assert.equal(result.authMethod, "coding-plan");
  assert.equal(result.model, "qwen3.5-plus");
  assert.equal(result.configured, true);
});

test("parseAuthStatusText: OAuth 格式", () => {
  const text = `Authentication Method: Qwen OAuth
Current Model: qwen3-coder
Status: OAuth token valid`;
  const result = parseAuthStatusText(text);
  assert.equal(result.authMethod, "qwen-oauth");
});

test("parseAuthStatusText: API Key 格式", () => {
  const text = `Authentication Method: OpenAI-compatible API Key`;
  const result = parseAuthStatusText(text);
  assert.equal(result.authMethod, "openai");
});

test("parseAuthStatusText: 完全无法识别 → unknown", () => {
  const text = "something garbled";
  const result = parseAuthStatusText(text);
  assert.equal(result.authMethod, "unknown");
});

test("parseAuthStatusText: 空输入 → unknown", () => {
  assert.equal(parseAuthStatusText("").authMethod, "unknown");
  assert.equal(parseAuthStatusText(null).authMethod, "unknown");
});
