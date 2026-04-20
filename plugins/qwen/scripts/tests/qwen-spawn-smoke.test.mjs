import { test } from "node:test";
import assert from "node:assert/strict";
import {
  spawnQwenProcess, buildQwenArgs, buildSpawnEnv, readQwenSettings,
} from "../lib/qwen.mjs";

test("spawnQwenProcess: foreground 真跑,exit 0", { timeout: 40_000 }, async () => {
  const { args } = buildQwenArgs({ prompt: "reply pong", unsafeFlag: true, maxSteps: 1 });
  const { env } = buildSpawnEnv(readQwenSettings());
  const { child } = spawnQwenProcess({ args, env, background: false });

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
    // stdout 必须消费,否则 pipe buffer 满会挂
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
  });
  assert.equal(exitCode, 0);
  assert.ok(child.pid > 0);
});
