// Tests for v0.1.2 hotfix — 5-way review 抓出的 7 P0.
// P0-1 stop-review parse / P0-2 resume-last args / P0-3 claudeSessionId filter
// P0-4 state lock timeout throw / P0-6 resolveWorkspaceRoot / P0-7 log tail

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import { buildQwenArgs } from "../lib/qwen.mjs";
import {
  parseStopReviewOutput,
  filterJobsForCurrentSession,
} from "../stop-review-gate-hook.mjs";
import { resolveWorkspaceRoot } from "../lib/git.mjs";
import {
  updateState,
  StateLockTimeoutError,
  resolveStateFile,
  ensureStateDir,
  resolveJobsDir,
} from "../lib/state.mjs";

// ── P0-1: parseStopReviewOutput 扫全部行 ──

test("P0-1: parseStopReviewOutput 首行 ALLOW → ok", () => {
  const r = parseStopReviewOutput("ALLOW: nothing blocking");
  assert.equal(r.ok, true);
});

test("P0-1: parseStopReviewOutput 首行 BLOCK → ok:false", () => {
  const r = parseStopReviewOutput("BLOCK: tests failing");
  assert.equal(r.ok, false);
  assert.match(r.reason, /tests failing/);
});

test("P0-1: parseStopReviewOutput qwen preamble + ALLOW 后置 → ok(扫所有行)", () => {
  const text = "Let me think about this...\nOkay, analyzing.\nALLOW: all looks good";
  const r = parseStopReviewOutput(text);
  assert.equal(r.ok, true);
});

test("P0-1: parseStopReviewOutput 无 ALLOW/BLOCK → ok:false unexpected", () => {
  const r = parseStopReviewOutput("some unrelated output");
  assert.equal(r.ok, false);
  assert.match(r.reason, /unexpected/);
});

test("P0-1: parseStopReviewOutput 空串 → ok:false no output", () => {
  const r = parseStopReviewOutput("");
  assert.equal(r.ok, false);
  assert.match(r.reason, /no final output/);
});

// ── P0-2: --resume-last 时 sessionId 必须 unset,让 buildQwenArgs 发 -c ──

test("P0-2: resumeLast=true + sessionId=undefined → args 含 -c,不含 --session-id", () => {
  const { args } = buildQwenArgs({
    prompt: "p",
    resumeLast: true,
    sessionId: undefined,
  });
  assert.ok(args.includes("-c"), "expected -c in args: " + args.join(" "));
  assert.ok(!args.includes("--session-id"), "should not contain --session-id");
});

test("P0-2: resumeLast=true + sessionId=<uuid> → sessionId 优先(老行为保留)", () => {
  const uuid = "11111111-2222-3333-4444-555555555555";
  const { args } = buildQwenArgs({
    prompt: "p",
    resumeLast: true,
    sessionId: uuid,
  });
  assert.ok(args.includes("--session-id"));
  assert.ok(!args.includes("-c"));
});

// ── P0-3: filterJobsForCurrentSession 按 claudeSessionId ──

test("P0-3: filter 按 claudeSessionId 命中本 session 的 job", () => {
  const jobs = [
    { jobId: "a", claudeSessionId: "cc-1", status: "running" },
    { jobId: "b", claudeSessionId: "cc-2", status: "running" },
    { jobId: "c", claudeSessionId: "cc-1", status: "completed" },
  ];
  const r = filterJobsForCurrentSession(jobs, { session_id: "cc-1" });
  const ids = r.map(j => j.jobId);
  assert.deepEqual(ids.sort(), ["a", "c"]);
});

test("P0-3: 历史 job 无 claudeSessionId → fallback 包括(兼容老记录)", () => {
  const jobs = [
    { jobId: "old", status: "running" },                     // 无 claudeSessionId
    { jobId: "new-match", claudeSessionId: "cc-1", status: "running" },
    { jobId: "new-miss", claudeSessionId: "cc-2", status: "running" },
  ];
  const r = filterJobsForCurrentSession(jobs, { session_id: "cc-1" });
  const ids = r.map(j => j.jobId).sort();
  assert.deepEqual(ids, ["new-match", "old"]);
});

test("P0-3: 无 sessionId 输入 + env 无泄漏 → 全量返回(老 fallback)", () => {
  // v0.2.1:filterJobsForCurrentSession 会 fallback 到 process.env[SESSION_ID_ENV]。
  // 测试期间 shell 里可能设了 QWEN_COMPANION_SESSION_ID,显式 unset 保证 fallback
  // 语义测到。
  const prev = process.env.QWEN_COMPANION_SESSION_ID;
  delete process.env.QWEN_COMPANION_SESSION_ID;
  try {
    const jobs = [{ jobId: "x", claudeSessionId: "cc-1", status: "running" }];
    const r = filterJobsForCurrentSession(jobs, {});
    assert.equal(r.length, 1);
  } finally {
    if (prev !== undefined) process.env.QWEN_COMPANION_SESSION_ID = prev;
  }
});

// ── P0-4: updateState 耗尽重试 → StateLockTimeoutError(不再走无锁 fallback) ──

test("P0-4: updateState lock timeout 抛 StateLockTimeoutError", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-p04-"));
  try {
    process.env.CLAUDE_PLUGIN_DATA = tmpRoot;
    ensureStateDir(tmpRoot);
    const lockFile = resolveStateFile(tmpRoot) + ".lock";
    // 手动占着 lock 且 fresh(mtimeMs 不过期 30s)
    fs.writeFileSync(lockFile, "");
    const now = Date.now();
    fs.utimesSync(lockFile, now / 1000, now / 1000);

    assert.throws(
      () => updateState(tmpRoot, (s) => { s.config = s.config || {}; s.config.x = 1; }),
      (err) => err instanceof StateLockTimeoutError && err.code === "ESTATELOCK"
    );
    // state.json 不该被无锁 fallback 写脏
    const stateFile = resolveStateFile(tmpRoot);
    if (fs.existsSync(stateFile)) {
      const raw = fs.readFileSync(stateFile, "utf8");
      assert.doesNotMatch(raw, /"x":\s*1/, "无锁 fallback 不应写入 config.x");
    }
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("P0-4: saveState 原子写(tmp + rename),中断后 state.json 保留原样", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-p04b-"));
  try {
    process.env.CLAUDE_PLUGIN_DATA = tmpRoot;
    updateState(tmpRoot, (s) => { s.config = { first: true }; });
    const stateFile = resolveStateFile(tmpRoot);
    const raw = fs.readFileSync(stateFile, "utf8");
    assert.match(raw, /"first":\s*true/);
    // 验证没有 .tmp 残留
    const dir = path.dirname(stateFile);
    const leftovers = fs.readdirSync(dir).filter(f => f.includes(".tmp."));
    assert.deepEqual(leftovers, [], "expected no .tmp residue");
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── P0-6: resolveWorkspaceRoot 在子目录返 repo root ──

test("P0-6: resolveWorkspaceRoot 在 repo 子目录返 repo root", () => {
  const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const subDir = path.join(repoRoot, "plugins", "qwen", "scripts");
  assert.ok(fs.existsSync(subDir));
  const r = resolveWorkspaceRoot(subDir);
  assert.equal(r, repoRoot);
});

test("P0-6: resolveWorkspaceRoot 非 git 目录 → 返 cwd fallback", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-p06-"));
  try {
    const r = resolveWorkspaceRoot(tmpRoot);
    // macOS tmp 下可能有 /var → /private/var symlink,realpath 归一
    assert.equal(fs.realpathSync(r), fs.realpathSync(tmpRoot));
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── P0-7: refreshJobLiveness readLogTail(通过 end-to-end:真假 pid + 大 log) ──

test("P0-7: refreshJobLiveness 大 log(>1MB)只读尾部,result event 命中", async () => {
  const { refreshJobLiveness } = await import("../lib/job-lifecycle.mjs");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-p07-"));
  try {
    process.env.CLAUDE_PLUGIN_DATA = tmpRoot;
    const cwd = tmpRoot;
    ensureStateDir(cwd);
    const jobsDir = resolveJobsDir(cwd);
    const jobId = "p07-test";
    const logFile = path.join(jobsDir, `${jobId}.log`);
    // 造 2MB 填充 + 1 行合法 result event 在末尾
    const filler = "noise line no json prefix\n".repeat(80_000); // ~2MB
    const resultEvent = JSON.stringify({ type: "result", result: "tail-ok", is_error: false, permission_denials: [] });
    fs.writeFileSync(logFile, filler + resultEvent + "\n");
    const { size } = fs.statSync(logFile);
    assert.ok(size > 1.5 * 1024 * 1024, `expected > 1.5MB, got ${size}`);

    const job = {
      jobId,
      status: "running",
      pid: 999_999, // 假 pid → process.kill 抛 ESRCH → 走 log parse
      logFile,
      cwd,
    };
    const updated = refreshJobLiveness(cwd, job);
    assert.equal(updated.status, "completed");
    assert.equal(updated.result, "tail-ok");
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── P0-5: bg spawn 失败 → 写 failed 记录(smoke via companion) ──

test("P0-5: bg spawn 不存在的 bin → failed 而非 running", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-p05-"));
  const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const companion = path.join(repoRoot, "plugins/qwen/scripts/qwen-companion.mjs");
  try {
    const r = execSync(
      `node "${companion}" task --background --unsafe "hello"`,
      {
        encoding: "utf8",
        cwd: tmpRoot,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_DATA: tmpRoot,
          QWEN_CLI_BIN: "/definitely/does/not/exist/qwen-xyz",
        },
      },
    );
    // 不存在的 bin 会失败,可能 exit 5 被 execSync 抛;捕进 catch
    assert.fail("expected non-zero exit, got: " + r);
  } catch (e) {
    const stdout = (e.stdout || "").toString();
    assert.match(stdout, /spawn_failed/, "expected spawn_failed in stdout: " + stdout);
    // state 里该 job status 应为 failed 而非 running
    const statePath = path.join(tmpRoot, "state", fs.readdirSync(path.join(tmpRoot, "state"))[0], "state.json");
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const job = state.jobs[0];
      assert.equal(job?.status, "failed");
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
