import { test } from "node:test";
import assert from "node:assert/strict";
import { tryLocalRepair } from "../lib/qwen.mjs";

test("tryLocalRepair: 纯 JSON → 直接 parse", () => {
  const r = tryLocalRepair('{"ok":true}');
  assert.deepEqual(r, { ok: true });
});

test("tryLocalRepair: 去 ```json fence", () => {
  const r = tryLocalRepair('```json\n{"ok":true}\n```');
  assert.deepEqual(r, { ok: true });
});

test("tryLocalRepair: 去 ``` 纯 fence", () => {
  const r = tryLocalRepair('```\n{"ok":true}\n```');
  assert.deepEqual(r, { ok: true });
});

test("tryLocalRepair: 去前置 prose", () => {
  const r = tryLocalRepair('Here is my review:\n\n{"ok":true}');
  assert.deepEqual(r, { ok: true });
});

test("tryLocalRepair: 去后置 prose", () => {
  const r = tryLocalRepair('{"ok":true}\n\nLet me know if you need more.');
  assert.deepEqual(r, { ok: true });
});

test("tryLocalRepair: 多层嵌套尾部大括号缺失(补 1 个)", () => {
  const r = tryLocalRepair('{"a":{"b":{"c":1}');
  assert.deepEqual(r, { a: { b: { c: 1 } } });
});

test("tryLocalRepair: 完全无法修 → null", () => {
  assert.equal(tryLocalRepair("totally garbled { incomplete "), null);
  assert.equal(tryLocalRepair(""), null);
});

test("tryLocalRepair: 数组也 OK", () => {
  const r = tryLocalRepair('[{"a":1},{"b":2}]');
  assert.deepEqual(r, [{ a: 1 }, { b: 2 }]);
});

test("tryLocalRepair: 带尾逗号 — 修掉", () => {
  const r = tryLocalRepair('{"a":1,"b":2,}');
  assert.deepEqual(r, { a: 1, b: 2 });
});
