import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readQwenSettings } from "../lib/qwen.mjs";

test("readQwenSettings: 不存在 → null", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-test-"));
  const fakePath = path.join(tmpDir, "does-not-exist.json");
  const result = readQwenSettings(fakePath);
  assert.equal(result, null);
  fs.rmSync(tmpDir, { recursive: true });
});

test("readQwenSettings: 合法 JSON → object", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-test-"));
  const p = path.join(tmpDir, "settings.json");
  fs.writeFileSync(p, JSON.stringify({ proxy: "http://x:1", chatRecording: true, model: "qwen3.5-plus" }));
  const result = readQwenSettings(p);
  assert.equal(result.proxy, "http://x:1");
  assert.equal(result.chatRecording, true);
  assert.equal(result.model, "qwen3.5-plus");
  fs.rmSync(tmpDir, { recursive: true });
});

test("readQwenSettings: 坏 JSON → null,不 throw", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-test-"));
  const p = path.join(tmpDir, "settings.json");
  fs.writeFileSync(p, "{ not valid json");
  assert.equal(readQwenSettings(p), null);
  fs.rmSync(tmpDir, { recursive: true });
});
