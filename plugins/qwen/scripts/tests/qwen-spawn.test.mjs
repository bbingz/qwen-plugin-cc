import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQwenArgs, CompanionError } from "../lib/qwen.mjs";

test("buildQwenArgs: 基本参数 + prompt 位置", () => {
  const { args, approvalMode } = buildQwenArgs({ prompt: "hi", unsafeFlag: true, background: true });
  assert.equal(approvalMode, "yolo");
  assert.ok(args.includes("--output-format") && args.includes("stream-json"));
  assert.ok(args.includes("--approval-mode") && args.includes("yolo"));
  assert.equal(args[args.length - 1], "hi");
});

test("buildQwenArgs: 默认 approval = auto-edit", () => {
  const { approvalMode } = buildQwenArgs({ prompt: "hi", background: false });
  assert.equal(approvalMode, "auto-edit");
});

test("buildQwenArgs: background + !unsafe → require_interactive", () => {
  assert.throws(
    () => buildQwenArgs({ prompt: "hi", background: true, approvalMode: "yolo" }),
    (e) => e instanceof CompanionError && e.kind === "require_interactive"
  );
});

test("buildQwenArgs: background + unsafe → 可以 yolo", () => {
  const { approvalMode } = buildQwenArgs({ prompt: "hi", background: true, unsafeFlag: true });
  assert.equal(approvalMode, "yolo");
});

test("buildQwenArgs: sessionId + resumeLast 互斥(sessionId 优先)", () => {
  const { args } = buildQwenArgs({ prompt: "hi", sessionId: "abc", resumeLast: true });
  assert.ok(args.includes("--session-id"));
  assert.ok(!args.includes("-c"));
});

test("buildQwenArgs: resumeLast 单独", () => {
  const { args } = buildQwenArgs({ prompt: "hi", resumeLast: true });
  assert.ok(args.includes("-c"));
});

test("buildQwenArgs: resumeId 单独", () => {
  const { args } = buildQwenArgs({ prompt: "hi", resumeId: "xyz" });
  const i = args.indexOf("-r");
  assert.equal(args[i + 1], "xyz");
});

test("buildQwenArgs: appendDirs 逗号拼接", () => {
  const { args } = buildQwenArgs({ prompt: "hi", appendDirs: ["/a", "/b"] });
  const i = args.indexOf("--include-directories");
  assert.equal(args[i + 1], "/a,/b");
});

test("buildQwenArgs: maxSteps 默认 20", () => {
  const { args } = buildQwenArgs({ prompt: "hi" });
  const i = args.indexOf("--max-session-turns");
  assert.equal(args[i + 1], "20");
});

test("buildQwenArgs: 用户显式 approvalMode 覆盖 default", () => {
  const { approvalMode } = buildQwenArgs({ prompt: "hi", approvalMode: "plan" });
  assert.equal(approvalMode, "plan");
});
