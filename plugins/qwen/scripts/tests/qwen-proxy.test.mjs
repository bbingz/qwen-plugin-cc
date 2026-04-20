import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnEnv } from "../lib/qwen.mjs";

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
