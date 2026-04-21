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
        { name: "Authorization", value: "Bearer eyJhbGciOiJIUzI1NiJ9.xyz.abc" },
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

test("normalizePermissionDenials: author/authority 等合法 key 不误 redact(P1-SEC)", () => {
  const r = normalizePermissionDenials([{
    tool_name: "git",
    tool_input: {
      author: "Alice",
      author_email: "alice@example.com",
      authority_level: "admin",
      tokenizer_version: "v2",
      password_hash_algo: "argon2",  // 含 password 子串但整个 key 不是 password 相关
    },
  }]);
  const inp = r[0].tool_input;
  assert.equal(inp.author, "Alice", "author 不误伤");
  assert.equal(inp.author_email, "alice@example.com", "author_email 不误伤");
  assert.equal(inp.authority_level, "admin", "authority 不误伤");
  assert.equal(inp.tokenizer_version, "v2", "tokenizer 不误伤");
  // password_hash_algo 含 password 但 delimiter boundary 会匹配
  // (password_xxx 里的 password 前有 ^,后是 _),这算合理命中
  assert.equal(inp.password_hash_algo, "[REDACTED]");
});

test("normalizePermissionDenials: curl cmd 中间的 Bearer 能抓(v0.2 漏抓 P1-SEC)", () => {
  const r = normalizePermissionDenials([{
    tool_name: "bash",
    tool_input: {
      cmd: "curl -H 'Authorization: Bearer eyJhbGc.payload.sig' https://api.example.com",
    },
  }]);
  assert.equal(r[0].tool_input.cmd, "[REDACTED]", "cmd 应被 redact(含 Bearer)");
});

test("normalizePermissionDenials: 新 pattern sk_live/JWT/AIza 覆盖", () => {
  const cases = [
    { desc: "Stripe live", value: "sk_live_abcdefghijklmnopqrstuv" },
    { desc: "Stripe test", value: "sk_test_abcdefghijklmnopqrstuv" },
    { desc: "Google API key", value: "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz1234567" },
    { desc: "JWT", value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signaturexyz123456" },
  ];
  for (const { desc, value } of cases) {
    const r = normalizePermissionDenials([{
      tool_name: "http",
      tool_input: { body: value },
    }]);
    assert.equal(r[0].tool_input.body, "[REDACTED]", `should redact ${desc}`);
  }
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
