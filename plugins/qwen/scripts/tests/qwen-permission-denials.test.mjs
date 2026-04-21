import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePermissionDenials } from "../lib/qwen.mjs";

test("normalizePermissionDenials: 非 array 返空", () => {
  assert.deepEqual(normalizePermissionDenials(null), []);
  assert.deepEqual(normalizePermissionDenials(undefined), []);
  assert.deepEqual(normalizePermissionDenials("str"), []);
  assert.deepEqual(normalizePermissionDenials({}), []);
});

test("normalizePermissionDenials: 丢非 object 条目", () => {
  const r = normalizePermissionDenials([null, "bad", 42, { tool_name: "bash" }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].tool_name, "bash");
});

test("normalizePermissionDenials: 缺 tool_name 标 unknown", () => {
  const r = normalizePermissionDenials([{ tool_input: { cmd: "ls" } }]);
  assert.equal(r[0].tool_name, "unknown");
});

test("normalizePermissionDenials: key 含敏感字眼 → [REDACTED]", () => {
  const r = normalizePermissionDenials([{
    tool_name: "http",
    tool_input: {
      url: "https://api.example.com",
      api_key: "super-secret-xxxxx",
      Authorization: "Bearer foo",
      normal: "visible",
    },
  }]);
  const inp = r[0].tool_input;
  assert.equal(inp.api_key, "[REDACTED]");
  assert.equal(inp.Authorization, "[REDACTED]");
  assert.equal(inp.normal, "visible");
  assert.equal(inp.url, "https://api.example.com");
});

test("normalizePermissionDenials: 各家 secret pattern 在 value 里被 redact", () => {
  const cases = [
    { desc: "OpenAI sk-", value: "sk-abcdefghijklmnopqrstuv" },
    { desc: "GitHub ghp_", value: "ghp_abcdefghijklmnopqrstuvwxyz01" },
    { desc: "GitHub fine-grained", value: "github_pat_abcdefghijklmnop_qrstuv" },
    { desc: "AWS AKIA", value: "AKIAIOSFODNN7EXAMPLE" },
    { desc: "Slack xoxb", value: "xoxb-1234-5678-abcdefghij" },
    { desc: "Bearer", value: "Bearer eyJhbGciOiJIUzI1NiJ9.abc" },
  ];
  for (const { desc, value } of cases) {
    const r = normalizePermissionDenials([{
      tool_name: "echo",
      tool_input: { harmless_field: value },
    }]);
    assert.equal(r[0].tool_input.harmless_field, "[REDACTED]", `should redact ${desc}`);
  }
});

test("normalizePermissionDenials: 嵌套 object/array 递归 redact", () => {
  const r = normalizePermissionDenials([{
    tool_name: "http",
    tool_input: {
      headers: [
        { name: "Authorization", value: "Bearer xxx" },
        { name: "X-Custom", value: "ok" },
      ],
      body: {
        creds: { password: "secret123", user: "alice" },
        safe: 42,
      },
    },
  }]);
  const inp = r[0].tool_input;
  // headers 数组里的 object;value 含 Bearer → redact;name 普通
  assert.equal(inp.headers[0].value, "[REDACTED]");
  assert.equal(inp.headers[1].value, "ok");
  // creds.password key 命中敏感 → redact
  assert.equal(inp.body.creds.password, "[REDACTED]");
  assert.equal(inp.body.creds.user, "alice");
  assert.equal(inp.body.safe, 42);
});

test("normalizePermissionDenials: 普通 shell cmd 不误 redact", () => {
  const r = normalizePermissionDenials([{
    tool_name: "bash",
    tool_input: { cmd: "ls -la /tmp && echo done" },
  }]);
  assert.equal(r[0].tool_input.cmd, "ls -la /tmp && echo done");
});

test("normalizePermissionDenials: tool_input 缺失不炸", () => {
  const r = normalizePermissionDenials([{ tool_name: "x" }]);
  assert.equal(r[0].tool_name, "x");
  assert.equal(r[0].tool_input, null);
});
