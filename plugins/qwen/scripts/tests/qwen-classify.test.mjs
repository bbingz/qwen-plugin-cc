import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyApiError } from "../lib/qwen.mjs";

// v3.1 F-2 实测:qwen 真实格式是 [API Error: NNN ...],无 "Status:" 字样
test("classifyApiError: qwen 实际 401 格式(F-2 实测)", () => {
  const r = classifyApiError("[API Error: 401 invalid access token or token expired]");
  assert.equal(r.kind, "not_authenticated");
  assert.equal(r.status, 401);
});

test("classifyApiError: [API Error: 403 ...] → not_authenticated", () => {
  const r = classifyApiError("[API Error: 403 forbidden]");
  assert.equal(r.kind, "not_authenticated");
});

test("classifyApiError: [API Error: 429 ...] → rate_limited", () => {
  const r = classifyApiError("[API Error: 429 too many requests]");
  assert.equal(r.kind, "rate_limited");
});

test("classifyApiError: [API Error: 400 ...] → invalid_request", () => {
  const r = classifyApiError("[API Error: 400 bad request]");
  assert.equal(r.kind, "invalid_request");
});

test("classifyApiError: [API Error: 503 ...] → server_error", () => {
  const r = classifyApiError("[API Error: 503 service unavailable]");
  assert.equal(r.kind, "server_error");
  assert.equal(r.status, 503);
});

test("classifyApiError: DashScope 108 → insufficient_balance", () => {
  const r = classifyApiError("[API Error: error code 108 insufficient balance]");
  assert.equal(r.kind, "insufficient_balance");
});

test("classifyApiError: sensitive → content_sensitive", () => {
  const r = classifyApiError("[API Error: content sensitive, moderation failed]");
  assert.equal(r.kind, "content_sensitive");
});

test("classifyApiError: 关键词 rate limit 无状态码 → rate_limited", () => {
  const r = classifyApiError("[API Error: Request was throttled due to rate limiting]");
  assert.equal(r.kind, "rate_limited");
});

test("classifyApiError: 关键词兜底 network", () => {
  const r = classifyApiError("[API Error: connection timeout]");
  assert.equal(r.kind, "network_error");
});

test("classifyApiError: 完全未命中 → api_error_unknown", () => {
  const r = classifyApiError("[API Error: something completely unexpected]");
  assert.equal(r.kind, "api_error_unknown");
});

test("classifyApiError: fallback (Status: 401) 格式(非 qwen 格式)", () => {
  const r = classifyApiError("[API Error: Connection refused (Status: 401)]");
  assert.equal(r.kind, "not_authenticated");
  assert.equal(r.status, 401);
});

test("classifyApiError 边界:503ms 不被误当 5xx(\\b 边界)", () => {
  const r = classifyApiError("[API Error: timeout after 503ms]");
  // 关键词 "timeout" 命中 network_error,不是 server_error
  assert.equal(r.kind, "network_error");
});
