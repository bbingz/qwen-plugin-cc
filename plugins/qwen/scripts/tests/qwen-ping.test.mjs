import { test } from "node:test";
import assert from "node:assert/strict";
import { runQwenPing, buildSpawnEnv, readQwenSettings } from "../lib/qwen.mjs";

test("runQwenPing: 真机跑通(需已 qwen auth coding-plan)", { timeout: 40_000 }, () => {
  const { env } = buildSpawnEnv(readQwenSettings());
  const r = runQwenPing({ env });

  // 如果环境 ok,应该有 session_id、至少一条 assistant text
  // 如果 token 过期,会有 [API Error: 401]。两种都是合法观察。
  assert.equal(r.exitCode, 0);
  assert.ok(r.sessionId != null, `sessionId: ${r.sessionId}`);
  assert.ok(r.resultEvent != null, "result event present");

  // 打印观察,不强断言内容(便于排查)
  console.log("ping result:", {
    exitCode: r.exitCode,
    model: r.model,
    hasText: r.assistantTexts.length > 0,
    firstText: r.assistantTexts[0]?.slice(0, 80),
    is_error: r.resultEvent?.is_error,
  });
});
