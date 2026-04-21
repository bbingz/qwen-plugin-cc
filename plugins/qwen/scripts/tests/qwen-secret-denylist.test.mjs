import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { isLikelySecretFile, collectReviewContext } from "../lib/git.mjs";

test("isLikelySecretFile: 典型 secret 文件名匹配", () => {
  const hits = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.example",       // 保守拒:让用户主动改名/git-add
    ".envrc",
    "credentials",
    "credentials.json",
    "credentials.yaml",
    ".aws/credentials",
    "foo/bar/.env",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "id_rsa",
    "id_ed25519",
    "server_rsa",
    "deploy_ed25519",
    "server.pem",
    "server.key",
    "certs/cert.p12",
    "keystore.jks",
    "secret.json",
    "secrets.yaml",
    ".secret",
    ".secrets",
    "vault.kdbx",
    "old.kdb",
  ];
  for (const f of hits) {
    assert.equal(isLikelySecretFile(f), true, `expected true: ${f}`);
  }
});

test("isLikelySecretFile: 普通文件不误判", () => {
  const misses = [
    "src/app.ts",
    "README.md",
    "config.json",          // 不是 credentials.*
    "package.json",
    "env.ts",               // 无前导 .
    "envelope.md",          // 前缀相同但不是 .env
    "keymap.ts",            // 不是 .key
    "public.pub",           // 公钥不拦(保守拒私钥系列)
  ];
  for (const f of misses) {
    assert.equal(isLikelySecretFile(f), false, `expected false: ${f}`);
  }
});

test("isLikelySecretFile: 非 string 输入安全", () => {
  assert.equal(isLikelySecretFile(null), false);
  assert.equal(isLikelySecretFile(undefined), false);
  assert.equal(isLikelySecretFile(""), false);
  assert.equal(isLikelySecretFile(123), false);
});

test("collectReviewContext: untracked .env 被标 skipped 且内容不出现", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-secret-test-"));
  try {
    // 初始化 git + commit 一个占位让 working-tree 模式生效
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
    spawnSync("git", ["add", "README.md"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

    const envContent = "API_KEY=super-secret-xxx-do-not-leak";
    fs.writeFileSync(path.join(dir, ".env"), envContent);
    fs.writeFileSync(path.join(dir, "notes.md"), "normal new file content\n");

    const ctx = collectReviewContext(dir, { scope: "working-tree" });

    assert.ok(ctx.content.includes("notes.md"), "正常 untracked 文件仍在");
    assert.ok(ctx.content.includes("normal new file content"), "正常内容仍在");
    assert.ok(!ctx.content.includes(envContent), "secret 内容不得出现");
    assert.ok(ctx.content.includes("likely secret file"), "有 skipped 标注");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectReviewContext: staged .env 也被 exclude,内容不得出现", () => {
  // v0.2.1 P0-3:Claude review 指出 isLikelySecretFile 只守 untracked,
  // 用户 `git add .env` 后 staged diff 会把 .env 内容原样送 qwen。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-staged-secret-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
    spawnSync("git", ["add", "README.md"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

    const envSecret = "DATABASE_PASSWORD=prod-leaked-pwd-12345";
    fs.writeFileSync(path.join(dir, ".env"), envSecret);
    fs.writeFileSync(path.join(dir, "code.ts"), "export const x = 1;\n");
    spawnSync("git", ["add", ".env", "code.ts"], { cwd: dir });

    const ctx = collectReviewContext(dir, { scope: "staged" });

    assert.ok(ctx.content.includes("code.ts"), "正常 staged 文件仍在 diff 里");
    assert.ok(ctx.content.includes("export const x"), "正常 staged 内容仍在");
    assert.ok(!ctx.content.includes(envSecret), "staged secret 内容不得出现");
    assert.ok(ctx.content.includes("skipped 1 likely-secret file"), "有 staged skip 标注");
    assert.ok(ctx.content.includes("- .env"), "skip 列表含 .env");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectReviewContext: unstaged 修改 credentials.json 也被 exclude", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-unstaged-secret-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "credentials.json"), '{"key":"old"}\n');
    fs.writeFileSync(path.join(dir, "app.ts"), "const y = 2;\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

    // 修改两者,让 unstaged diff 非空
    const leaked = '{"key":"prod-abcdefg-leaked"}';
    fs.writeFileSync(path.join(dir, "credentials.json"), leaked);
    fs.writeFileSync(path.join(dir, "app.ts"), "const y = 99;\n");

    const ctx = collectReviewContext(dir, { scope: "unstaged" });

    assert.ok(ctx.content.includes("app.ts"), "正常 unstaged 文件仍在");
    assert.ok(!ctx.content.includes("prod-abcdefg-leaked"), "secret 不得出现");
    assert.ok(ctx.content.includes("skipped 1 likely-secret file"), "有 unstaged skip 标注");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
