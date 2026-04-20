import { test } from "node:test";
import assert from "node:assert/strict";
import * as git from "../lib/git.mjs";

test("git.mjs: 模块可加载 + 导出关键函数", () => {
  // 验证至少导出 3 个常用函数
  const keys = Object.keys(git);
  console.log("git.mjs exports:", keys);
  assert.ok(keys.length >= 3, `Expected >= 3 exports, got ${keys.length}`);
});

test("git.mjs: ensureGitRepository 不 throw", () => {
  if (typeof git.ensureGitRepository !== "function") {
    console.log("ensureGitRepository not exported — skipping");
    return;
  }
  assert.doesNotThrow(() => git.ensureGitRepository(process.cwd()));
});

test("git.mjs: getRepoRoot 返回有效路径", () => {
  if (typeof git.getRepoRoot !== "function") {
    console.log("getRepoRoot not exported — skipping");
    return;
  }
  const root = git.getRepoRoot(process.cwd());
  console.log("repo root:", root);
  assert.ok(root);
});

test("git.mjs: getCurrentBranch 基本调用不崩", () => {
  if (typeof git.getCurrentBranch !== "function") {
    console.log("getCurrentBranch not exported — skipping");
    return;
  }
  const branch = git.getCurrentBranch(process.cwd());
  console.log("current branch:", branch);
  assert.ok(branch);
});

test("git.mjs: collectReviewContext 可调用", () => {
  if (typeof git.collectReviewContext !== "function") {
    console.log("collectReviewContext not exported — skipping");
    return;
  }
  const ctx = git.collectReviewContext(process.cwd());
  console.log("review context:", ctx);
  assert.ok(ctx);
});
