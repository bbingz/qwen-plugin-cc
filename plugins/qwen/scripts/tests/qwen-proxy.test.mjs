import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnEnv, filterEnvForChild } from "../lib/qwen.mjs";

function withEnv(overrides, fn) {
  const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(overrides)) {
    if (v != null) process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const k of keys) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("buildSpawnEnv: settings 有 + env 全无 → 四键全写", () => {
  withEnv({}, () => {
    const { env, warnings } = buildSpawnEnv({ proxy: "http://proxy:8080" });
    assert.equal(env.HTTPS_PROXY, "http://proxy:8080");
    assert.equal(env.https_proxy, "http://proxy:8080");
    assert.equal(env.HTTP_PROXY, "http://proxy:8080");
    assert.equal(env.http_proxy, "http://proxy:8080");
    assert.deepEqual(warnings, []);
  });
});

test("buildSpawnEnv: settings 有 + env 一致 → noop,无 warning", () => {
  withEnv({ HTTPS_PROXY: "http://x:1", https_proxy: "http://x:1" }, () => {
    const { warnings } = buildSpawnEnv({ proxy: "http://x:1" });
    assert.deepEqual(warnings, []);
  });
});

test("buildSpawnEnv: settings 有 + env 不一致 → proxy_conflict,不覆盖", () => {
  withEnv({ HTTPS_PROXY: "http://a:1" }, () => {
    const { env, warnings } = buildSpawnEnv({ proxy: "http://b:2" });
    assert.equal(env.HTTPS_PROXY, "http://a:1", "原 env 不被覆盖");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].kind, "proxy_conflict");
  });
});

test("buildSpawnEnv: env 四键内部值冲突 → proxy_env_mismatch,跳过注入", () => {
  withEnv({ HTTPS_PROXY: "http://a:1", HTTP_PROXY: "http://b:2" }, () => {
    const { env, warnings } = buildSpawnEnv({ proxy: "http://c:3" });
    // 不注入 settings 的 c:3
    assert.equal(env.HTTPS_PROXY, "http://a:1");
    assert.equal(env.HTTP_PROXY, "http://b:2");
    const mismatch = warnings.find(w => w.kind === "proxy_env_mismatch");
    assert.ok(mismatch, "must warn proxy_env_mismatch");
  });
});

test("buildSpawnEnv: settings 无 → 不注入,NO_PROXY 仍 merge", () => {
  withEnv({ NO_PROXY: "foo.com" }, () => {
    const { env, warnings } = buildSpawnEnv({});
    assert.equal(env.HTTPS_PROXY, undefined);
    // NO_PROXY merge 结果:foo.com,localhost,127.0.0.1
    assert.equal(env.NO_PROXY, "foo.com,localhost,127.0.0.1");
    assert.equal(env.no_proxy, "foo.com,localhost,127.0.0.1");
    assert.deepEqual(warnings, []);
  });
});

test("buildSpawnEnv: userSettings 为 null 或缺 proxy 字段 → 不炸", () => {
  withEnv({}, () => {
    assert.doesNotThrow(() => buildSpawnEnv(null));
    assert.doesNotThrow(() => buildSpawnEnv({}));
    const { env } = buildSpawnEnv(null);
    // NO_PROXY 仍 merge
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1");
  });
});

// v0.1.1 hotfix:env 白名单(防 ANTHROPIC_API_KEY 等泄漏给 qwen child)
test("filterEnvForChild: 黑名单变量被过滤(ANTHROPIC_API_KEY / OPENAI_API_KEY etc.)", () => {
  const fake = {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    ANTHROPIC_API_KEY: "sk-ant-123",
    GEMINI_API_KEY: "g-456",
    GOOGLE_APPLICATION_CREDENTIALS: "/x.json",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    AZURE_CLIENT_SECRET: "azure",
    KIMI_API_KEY: "k",
    MOONSHOT_API_KEY: "m",
    SOME_RANDOM_SECRET: "hidden",
  };
  const out = filterEnvForChild(fake);
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.HOME, "/tmp/home");
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
  assert.equal(out.GEMINI_API_KEY, undefined);
  assert.equal(out.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(out.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(out.AZURE_CLIENT_SECRET, undefined);
  assert.equal(out.KIMI_API_KEY, undefined);
  assert.equal(out.MOONSHOT_API_KEY, undefined);
  assert.equal(out.SOME_RANDOM_SECRET, undefined);
});

test("filterEnvForChild: qwen/alibaba 家族前缀允许", () => {
  const out = filterEnvForChild({
    QWEN_FOO: "1",
    BAILIAN_CODING_PLAN_API_KEY: "bailian",
    DASHSCOPE_KEY: "d",
    ALIBABA_XYZ: "a",
    ALI_BAR: "b",
  });
  assert.equal(out.QWEN_FOO, "1");
  assert.equal(out.BAILIAN_CODING_PLAN_API_KEY, "bailian");
  assert.equal(out.DASHSCOPE_KEY, "d");
  assert.equal(out.ALIBABA_XYZ, "a");
  assert.equal(out.ALI_BAR, "b");
});

test("filterEnvForChild: 用户自定义 QWEN_PLUGIN_ENV_ALLOW 白名单扩展", () => {
  const out = filterEnvForChild({
    QWEN_PLUGIN_ENV_ALLOW: "MY_VAR,OTHER",
    MY_VAR: "hello",
    OTHER: "world",
    STILL_BLOCKED: "nope",
  });
  assert.equal(out.MY_VAR, "hello");
  assert.equal(out.OTHER, "world");
  assert.equal(out.STILL_BLOCKED, undefined);
});
