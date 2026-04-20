import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewWithRetry } from "../lib/qwen.mjs";

const SCHEMA_TEXT = JSON.stringify({
  type: "object",
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "changes_requested"] },
    findings: { type: "array" },
  },
}, null, 2);

const SCHEMA_OBJ = {
  type: "object",
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "changes_requested"] },
    findings: { type: "array" },
  },
};

// 简化 validator(避免引入 ajv 依赖):required + enum
function simpleValidate(data, schema) {
  if (typeof data !== "object" || data === null) return [{ message: "not an object", instancePath: "/" }];
  const errors = [];
  for (const req of schema.required ?? []) {
    if (!(req in data)) errors.push({ message: `required: ${req}`, instancePath: `/${req}` });
  }
  if (schema.properties?.verdict?.enum && !schema.properties.verdict.enum.includes(data.verdict)) {
    errors.push({ message: `verdict not in enum`, instancePath: "/verdict" });
  }
  return errors.length ? errors : null;
}

test("reviewWithRetry: 首轮成功", async () => {
  const runQwen = async () => '{"verdict":"approve","findings":[]}';
  const r = await reviewWithRetry({
    diff: "fake",
    schemaText: SCHEMA_TEXT,
    schema: SCHEMA_OBJ,
    runQwen,
    validate: simpleValidate,
  });
  assert.equal(r.ok, true);
  assert.equal(r.parsed.verdict, "approve");
  assert.equal(r.attempts.length, 1);
});

test("reviewWithRetry: 首轮带 fence,tryLocalRepair 救(无需真 retry)", async () => {
  let callCount = 0;
  const runQwen = async () => {
    callCount++;
    return '```json\n{"verdict":"approve","findings":[]}\n```';
  };
  const r = await reviewWithRetry({
    diff: "fake",
    schemaText: SCHEMA_TEXT,
    schema: SCHEMA_OBJ,
    runQwen,
    validate: simpleValidate,
  });
  assert.equal(r.ok, true);
  assert.equal(r.repairedLocally, true, "fence 被本地修复");
  assert.equal(callCount, 1, "首轮靠本地 repair 救,不真 retry");
});

test("reviewWithRetry: retry 1 通过(首次 + 1 retry)", async () => {
  let call = 0;
  const runQwen = async () => {
    call++;
    if (call === 1) return "not json at all";
    return '{"verdict":"changes_requested","findings":[{"path":"x"}]}';
  };
  const r = await reviewWithRetry({
    diff: "fake",
    schemaText: SCHEMA_TEXT,
    schema: SCHEMA_OBJ,
    runQwen,
    validate: simpleValidate,
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts.length, 2);
});

test("reviewWithRetry: 3 轮全败 → schema_violation", async () => {
  const runQwen = async () => "absolutely not json";
  const r = await reviewWithRetry({
    diff: "fake",
    schemaText: SCHEMA_TEXT,
    schema: SCHEMA_OBJ,
    runQwen,
    validate: simpleValidate,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "schema_violation");
  assert.equal(r.attempts.length, 3);
});
