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

test("tryLocalRepair: string 内含 } 不误算 bracket(缺尾 })", () => {
  // "x}" 里的 } 不应抵消对 { 的闭合;repair 应补一个 }。
  const r = tryLocalRepair('{"a":"x}"');
  assert.deepEqual(r, { a: "x}" });
});

test("tryLocalRepair: string 内含 { 不被当作新 object", () => {
  const r = tryLocalRepair('{"a":"{not-json","b":2');
  assert.deepEqual(r, { a: "{not-json", b: 2 });
});

test("tryLocalRepair: 末尾 string truncation → 补 \" + 闭合", () => {
  // qwen timeout 常吐这种尾断;当前代码只会补 },修不了。
  const r = tryLocalRepair('{"summary":"very long text got cut');
  assert.deepEqual(r, { summary: "very long text got cut" });
});

test("tryLocalRepair: truncation 嵌套 object 中", () => {
  const r = tryLocalRepair('{"a":1,"b":{"msg":"cut mid');
  assert.deepEqual(r, { a: 1, b: { msg: "cut mid" } });
});

test("tryLocalRepair: 尾断在 key: 冒号后(v0.2.1 P1-COR-1)", () => {
  // qwen timeout 常见场景:key 写完冒号了但 value 还没开始吐
  const r = tryLocalRepair('{"a":1,"b":');
  assert.deepEqual(r, { a: 1 });
});

test("tryLocalRepair: 尾断在嵌套 object 的 key: 后", () => {
  const r = tryLocalRepair('{"x":[1],"y":{"z":');
  assert.deepEqual(r, { x: [1] });
});

test("tryLocalRepair: 尾断在 opening `{` 后的 key:", () => {
  // `{"a":1,"nested":{"k":`  砍 ,"nested":{"k":  后 `{"a":1` 补闭合
  const r = tryLocalRepair('{"a":1,"nested":{"k":');
  assert.deepEqual(r, { a: 1 });
});

test("tryLocalRepair: escaped quote 不被当 string 结束", () => {
  // "x\"y" 内的 \" 是转义,不结束 string;后续 } 也不应误算。
  const r = tryLocalRepair('{"a":"x\\"y}"');
  assert.deepEqual(r, { a: 'x"y}' });
});
