import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateReviewOutput } from "../lib/review-validate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, "..", "..", "schemas", "review-output.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

function ok(data) {
  const e = validateReviewOutput(data, schema);
  assert.equal(e, null, `should be valid, got errors:\n${JSON.stringify(e, null, 2)}`);
}
function bad(data, pathHint) {
  const e = validateReviewOutput(data, schema);
  assert.ok(Array.isArray(e) && e.length > 0, "should return errors");
  if (pathHint) {
    assert.ok(e.some((x) => x.instancePath.includes(pathHint)),
      `expected error at ${pathHint}, got ${e.map(x => x.instancePath).join(", ")}`);
  }
}

const VALID_MIN = {
  verdict: "approve",
  summary: "looks good",
  findings: [],
  next_steps: [],
};

test("validateReviewOutput: 最小合法(approve + 空 findings/next_steps)", () => {
  ok(VALID_MIN);
});

test("validateReviewOutput: 完整合法(含 finding + next_steps)", () => {
  ok({
    verdict: "needs-attention",
    summary: "one issue found",
    findings: [{
      severity: "high",
      title: "SQL injection",
      body: "Query is concatenated with user input.",
      file: "src/db.ts",
      line_start: 42,
      line_end: 45,
      confidence: 0.9,
      recommendation: "Use parameterized query",
    }],
    next_steps: ["fix SQL injection in src/db.ts"],
  });
});

test("validateReviewOutput: 缺 required → 报错", () => {
  bad({ verdict: "approve", summary: "x", findings: [] }, "/next_steps");
});

test("validateReviewOutput: verdict 不在 enum → 报错", () => {
  bad({ ...VALID_MIN, verdict: "maybe" }, "/verdict");
});

test("validateReviewOutput: summary 空字符串(minLength 1)→ 报错", () => {
  bad({ ...VALID_MIN, summary: "" }, "/summary");
});

test("validateReviewOutput: additional property → 报错", () => {
  bad({ ...VALID_MIN, extra: "x" }, "/extra");
});

test("validateReviewOutput: finding severity 不在 enum → 报错", () => {
  const v = {
    ...VALID_MIN,
    verdict: "needs-attention",
    findings: [{
      severity: "blocker",  // 不在 critical/high/medium/low
      title: "t", body: "b", file: "f",
      line_start: 1, line_end: 1,
      confidence: 0.5,
      recommendation: "",
    }],
  };
  bad(v, "/findings/0/severity");
});

test("validateReviewOutput: confidence > 1 → 报错", () => {
  const v = {
    ...VALID_MIN,
    findings: [{
      severity: "low",
      title: "t", body: "b", file: "f",
      line_start: 1, line_end: 1,
      confidence: 1.5,
      recommendation: "",
    }],
  };
  bad(v, "/findings/0/confidence");
});

test("validateReviewOutput: line_start 0 违反 minimum=1", () => {
  const v = {
    ...VALID_MIN,
    findings: [{
      severity: "low",
      title: "t", body: "b", file: "f",
      line_start: 0, line_end: 1,
      confidence: 0.5,
      recommendation: "",
    }],
  };
  bad(v, "/findings/0/line_start");
});

test("validateReviewOutput: finding 类型错(line_start 是 string)→ 报错", () => {
  const v = {
    ...VALID_MIN,
    findings: [{
      severity: "low",
      title: "t", body: "b", file: "f",
      line_start: "1",  // 应该是 integer
      line_end: 1,
      confidence: 0.5,
      recommendation: "",
    }],
  };
  bad(v, "/findings/0/line_start");
});

test("validateReviewOutput: next_steps 元素空字符串(minLength 1)→ 报错", () => {
  bad({ ...VALID_MIN, next_steps: [""] }, "/next_steps/0");
});

test("validateReviewOutput: 根非 object → 报错", () => {
  const e = validateReviewOutput([1, 2, 3], schema);
  assert.ok(Array.isArray(e) && e.length > 0);
});

test("validateReviewOutput: additionalProperties:false 无 properties 时仍拦截(MiniMax P0)", () => {
  const strictEmpty = { type: "object", additionalProperties: false };
  // 无 properties 的 strict schema 应拒任何字段
  const e = validateReviewOutput({ anything: 1 }, strictEmpty);
  assert.ok(Array.isArray(e) && e.length > 0, "应报错");
  assert.ok(e.some((x) => x.instancePath.includes("/anything")), "报 /anything");
  // 空对象应过
  assert.equal(validateReviewOutput({}, strictEmpty), null);
});

test("validateReviewOutput: 多个错误同时报出(不短路)", () => {
  const v = {
    verdict: "bogus",
    summary: "",
    // 缺 findings + next_steps
  };
  const e = validateReviewOutput(v, schema);
  assert.ok(e && e.length >= 3, `expect at least 3 errors, got ${e?.length}`);
});
