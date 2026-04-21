import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFailure } from "../lib/qwen.mjs";

test("层 1:exitCode 非 0 → kind=exit", () => {
  const r = detectFailure({ exitCode: 1, resultEvent: null, assistantTexts: [] });
  assert.equal(r.failed, true);
  assert.equal(r.kind, "exit");
  assert.equal(r.code, 1);
});

test("层 1:exitCode null(超时未退)→ 视为未失败等待后续层", () => {
  const r = detectFailure({
    exitCode: null,
    resultEvent: { is_error: false, result: "ok" },
    assistantTexts: ["ok"],
  });
  assert.equal(r.failed, false);
});

test("层 2:is_error:true → qwen_is_error", () => {
  const r = detectFailure({
    exitCode: 0,
    resultEvent: { is_error: true, result: "" },
    assistantTexts: [],
  });
  assert.equal(r.kind, "qwen_is_error");
});

test("层 3:result.result 含 [API Error: 401 ...](v3.1 F-2 格式)→ not_authenticated", () => {
  const r = detectFailure({
    exitCode: 0,
    resultEvent: { is_error: false, result: "[API Error: 401 invalid access token or token expired]" },
    assistantTexts: [],
  });
  assert.equal(r.kind, "not_authenticated");
});

test("层 4:assistant text 含 [API Error: → classifyApiError 分类", () => {
  const r = detectFailure({
    exitCode: 0,
    resultEvent: { is_error: false, result: "ok" },
    assistantTexts: ["[API Error: 429 too many requests]"],
  });
  assert.equal(r.kind, "rate_limited");
});

test("层 4:不锚定 ^ — 前置换行/空格都能命中", () => {
  const r = detectFailure({
    exitCode: 0,
    resultEvent: null,
    assistantTexts: ["  \n[API Error: 401 token invalid]"],
  });
  assert.equal(r.failed, true);
});

test("层 5:exit 0 + is_error false + result 空 + 无 assistant → empty_output", () => {
  const r = detectFailure({
    exitCode: 0,
    resultEvent: { is_error: false, result: null },
    assistantTexts: [],
  });
  assert.equal(r.kind, "empty_output");
});

test("正常成功:exit 0 + is_error false + 有 text → not failed", () => {
  const r = detectFailure({
    exitCode: 0,
    resultEvent: { is_error: false, result: "pong" },
    assistantTexts: ["pong"],
  });
  assert.equal(r.failed, false);
});

test("层 0:stderr 含 /No saved session found/ → no_prior_session(优先于 exit 层)", () => {
  const r = detectFailure({
    exitCode: 1,
    resultEvent: null,
    assistantTexts: [],
    stderr: "Error: No saved session found with ID 'abc-123'\n",
  });
  assert.equal(r.failed, true);
  assert.equal(r.kind, "no_prior_session");
});

test("层 0:不区分大小写(/no saved session FOUND/i)", () => {
  const r = detectFailure({
    exitCode: 1,
    resultEvent: null,
    assistantTexts: [],
    stderr: "something:\nNO SAVED SESSION FOUND with ID 'xx'\n",
  });
  assert.equal(r.kind, "no_prior_session");
});

test("层 0:stderr 不匹配 → 走后续层(此处 exit!=0 → exit)", () => {
  const r = detectFailure({
    exitCode: 1,
    resultEvent: null,
    assistantTexts: [],
    stderr: "random stderr noise",
  });
  assert.equal(r.kind, "exit");
});

test("层 0:未传 stderr → 走后续层", () => {
  const r = detectFailure({
    exitCode: 1,
    resultEvent: null,
    assistantTexts: [],
  });
  assert.equal(r.kind, "exit");
});
