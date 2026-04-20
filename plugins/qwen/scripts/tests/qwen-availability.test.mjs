import { test } from "node:test";
import assert from "node:assert/strict";
import { getQwenAvailability } from "../lib/qwen.mjs";

test("getQwenAvailability: qwen binary present → available true + version", () => {
  const result = getQwenAvailability();
  // 本机应已装 qwen 0.14.5+;qwen --version 只输出版本号如 "0.14.5"
  assert.equal(result.available, true);
  assert.match(result.detail, /\d+\.\d+\.\d+/);
});

test("getQwenAvailability: 不存在 bin → available false", () => {
  const result = getQwenAvailability("/nonexistent-qwen-binary-for-test");
  assert.equal(result.available, false);
});
