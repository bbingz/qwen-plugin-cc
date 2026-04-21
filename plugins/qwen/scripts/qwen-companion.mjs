#!/usr/bin/env node
// plugins/qwen/scripts/qwen-companion.mjs
// Dispatcher;Phase 1 只实现 setup。
import process from "node:process";
import { randomUUID } from "node:crypto";
import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  getQwenAvailability,
  buildSpawnEnv,
  readQwenSettings,
  parseAuthStatusText,
  detectInstallers,
  runQwenPing,
  QWEN_BIN,
  buildQwenArgs,
  spawnQwenProcess,
  streamQwenOutput,
  detectFailure,
  normalizePermissionDenials,
  parseStreamEvents,
  CompanionError,
  cancelJobPgid,
  reviewWithRetry,
  PARENT_SESSION_ENV,
} from "./lib/qwen.mjs";
import {
  ensureStateDir,
  upsertJob,
  writeJobFile,
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  loadState,
  saveState,
} from "./lib/state.mjs";
import { runCommand } from "./lib/process.mjs";
import {
  ensureGitRepository,
  collectReviewContext,
  resolveWorkspaceRoot,
} from "./lib/git.mjs";
import { refreshJobLiveness } from "./lib/job-lifecycle.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: qwen-companion <subcommand> [options]

Subcommands:
  setup [--json] [--enable-review-gate] [--disable-review-gate]
                                       Check qwen installation & auth; persist gate config
  task  [--background|--wait] [--unsafe] [--resume-last] [--session-id <uuid>] <prompt>
  task-resume-candidate [--json]    Check if a resumable task exists in this repo
  cancel <jobId> [--json]           Cancel a running background task
  status [<jobId>] [--json] [--all]    List jobs or show single job (with orphan detection)
  result <jobId> [--json]              Show stored job payload (result + permissionDenials)
  review              [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]
  adversarial-review  [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]

(More subcommands arrive in Phase 2+.)`;

// setup 子命令
function runSetup(rawArgs) {
  const { options } = parseArgs(rawArgs, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });

  // v3.1:--enable-review-gate / --disable-review-gate 持久化到 state.json
  if (options["enable-review-gate"] || options["disable-review-gate"]) {
    try {
      const cwd = process.cwd();
      ensureStateDir(cwd);
      const state = loadState(cwd) || {};
      state.config = state.config || {};
      state.config.stopReviewGate = options["enable-review-gate"] === true;
      saveState(cwd, state);
    } catch (e) {
      // 若 state 写失败,不阻塞 setup 主流程,只打警告到 stderr
      process.stderr.write(`warning: failed to persist review-gate state: ${e.message}\n`);
    }
  }

  const availability = getQwenAvailability();
  const installers = detectInstallers();
  const userSettings = readQwenSettings();
  const { env, warnings } = buildSpawnEnv(userSettings);

  // 解析 qwen auth status 文本(fallback 到 unknown)
  let authParsed = { authMethod: "unknown", model: null, configured: false };
  if (availability.available) {
    const authTextRes = runCommand(QWEN_BIN, ["auth", "status"], { env, timeout: 5000 });
    if (authTextRes.status === 0 && authTextRes.stdout) {
      authParsed = parseAuthStatusText(authTextRes.stdout);
    }
  }

  // Ping 探活(Phase 1 内只关心 authenticated,不做五层判错 — Phase 2 补)
  let authenticated = false;
  let authDetail = "not checked (qwen not installed)";
  let sessionModel = null;
  if (availability.available) {
    const ping = runQwenPing({ env });
    // 粗判:有 assistant text 且不以 [API Error: 开头 → 认为通过
    const text = ping.assistantTexts.join("\n");
    if (text && !/\[API Error:/.test(text)) {
      authenticated = true;
      authDetail = "ping succeeded";
      sessionModel = ping.model;
    } else if (/\[API Error:/.test(text)) {
      authDetail = `ping returned API Error: ${text.slice(0, 200)}`;
    } else {
      authDetail = `ping produced no assistant text; stderr: ${ping.stderrTail || "(empty)"}`;
    }
  }

  const status = {
    installed: availability.available,
    version: availability.available ? availability.detail : null,
    authenticated,
    authDetail,
    authMethod: authParsed.authMethod,
    model: sessionModel || authParsed.model || userSettings?.model || null,
    chatRecording: userSettings?.chatRecording !== false, // 默认 true
    proxyInjected: warnings.length === 0 && userSettings?.proxy != null,
    warnings,
    installers,
  };

  // v3.1: 补 stopReviewGate 字段
  const setupState = loadState(process.cwd());
  status.stopReviewGate = setupState?.config?.stopReviewGate === true;

  if (options.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  } else {
    process.stdout.write(formatSetupText(status) + "\n");
  }
  process.exit(0);
}

function formatSetupText(s) {
  const lines = [];
  lines.push(`installed:     ${s.installed ? `yes (${s.version})` : "no"}`);
  lines.push(`authenticated: ${s.authenticated ? "yes" : `no (${s.authDetail})`}`);
  lines.push(`authMethod:    ${s.authMethod}`);
  lines.push(`model:         ${s.model || "(not set)"}`);
  lines.push(`chatRecording: ${s.chatRecording ? "on" : "off"}`);
  lines.push(`proxyInjected: ${s.proxyInjected ? "yes" : "no"}`);
  if (s.warnings.length) {
    lines.push("warnings:");
    for (const w of s.warnings) {
      lines.push(`  - [${w.kind}] ${w.message || JSON.stringify(w)}`);
    }
  }
  if (!s.installed) {
    lines.push("");
    lines.push("installers:");
    lines.push(`  npm:  ${s.installers.npm ? "yes" : "no"}`);
    lines.push(`  brew: ${s.installers.brew ? "yes" : "no"}`);
    lines.push(`  curl: ${s.installers.shellInstaller ? "yes" : "no"}`);
  }
  return lines.join("\n");
}

// task 子命令 — §4.1-4.2
async function runTask(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleanOptions: ["background", "wait", "unsafe", "resume-last", "fresh", "json"],
    valueOptions: ["model", "effort", "session-id"],
  });

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    process.stderr.write("task: prompt required\n");
    process.exit(2);
  }

  // --wait 覆盖 --background
  const background = options.background && !options.wait;
  const unsafeFlag = options.unsafe === true;
  const resumeLast = options["resume-last"] === true;

  // v3.1 F-7: jobId 用 UUID(qwen 会拿这个作 --session-id,强校验 UUID)
  const jobId = randomUUID();

  // 构造 qwen args
  // P0-2: resume-last 时 sessionId 必须 unset,否则 buildQwenArgs 优先选 --session-id 永不发 -c
  let argsBuild;
  try {
    argsBuild = buildQwenArgs({
      prompt,
      resumeLast,
      sessionId: resumeLast ? undefined : (options["session-id"] || jobId),
      unsafeFlag,
      background,
    });
  } catch (e) {
    if (e instanceof CompanionError && e.kind === "require_interactive") {
      const payload = { ok: false, kind: e.kind, message: e.message };
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      process.exit(4);
    }
    throw e;
  }
  const { args, approvalMode } = argsBuild;

  // env
  const userSettings = readQwenSettings();
  const { env, warnings } = buildSpawnEnv(userSettings);

  // P0-6: 统一 resolve 到 repo root,让 task/status/result 从任意子目录都一致
  const cwd = resolveWorkspaceRoot(process.cwd());
  ensureStateDir(cwd);

  // P0-3: 持久化 Claude 侧 session id,让 hooks 能按本会话精准筛 job
  const claudeSessionId = process.env[PARENT_SESSION_ENV] || null;

  // 写 running job
  const jobMeta = {
    jobId, kind: "task",
    status: "running",
    approvalMode, unsafeFlag,
    startedAt: new Date().toISOString(),
    cwd, prompt,
    warnings,
    claudeSessionId,
  };

  // bg 模式:spawn 前把 stdout/stderr 直接写到 log file(OS fd),
  // parent exit 不影响 child 写 log。fg 模式走默认 pipe(companion 读 stream)。
  let logFile = null;
  let logFd = null;
  let stdio;
  if (background) {
    logFile = resolveJobLogFile(cwd, jobId);
    logFd = fs.openSync(logFile, "w");
    stdio = ["ignore", logFd, logFd];
    jobMeta.logFile = logFile;
  }

  // Spawn
  const { child } = spawnQwenProcess({ args, env, cwd, background, stdio });
  // spawn 后 child 已 dup 该 fd,parent 立刻关自己的副本防泄漏。
  if (logFd != null) {
    try { fs.closeSync(logFd); } catch { /* ignore */ }
  }

  // P0-5: bg 模式 ENOENT / EACCES 时 child.pid 为 undefined;若不检,僵尸 running job 永远无法恢复。
  // 同步探测:listen error event 并立即等 1 tick 看 pid 是否产生。
  if (child.pid == null) {
    const spawnFailure = await new Promise((resolve) => {
      let settled = false;
      child.once("error", (err) => { if (!settled) { settled = true; resolve(err); } });
      // nextTick fallback:如果没触发 error 也没 pid(极罕见),给个空
      setImmediate(() => { if (!settled) { settled = true; resolve(new Error("spawn failed with no pid and no error event")); } });
    });
    const failedMeta = {
      ...jobMeta,
      status: "failed",
      finishedAt: new Date().toISOString(),
      failure: { kind: "spawn_failed", code: spawnFailure?.code || null, message: spawnFailure?.message || "spawn failed" },
    };
    writeJobFile(cwd, jobId, failedMeta);
    upsertJob(cwd, failedMeta);
    process.stdout.write(JSON.stringify({ ok: false, kind: "spawn_failed", jobId, message: failedMeta.failure.message }, null, 2) + "\n");
    process.exit(5);
  }

  jobMeta.pid = child.pid;
  jobMeta.pgid = child.pid; // detached 后 pid === pgid

  upsertJob(cwd, jobMeta);

  if (background) {
    // 后台:立即返 jobId,companion 退。child stdio 已由 OS 直接写 log file。
    process.stdout.write(`Job queued: ${jobId}\n`);
    process.stdout.write(`Check with: /qwen:status ${jobId}\n`);
    process.exit(0);
  }

  // 前台:透传 stdout + 等 exit + 判终
  const streamResult = await streamQwenOutput({
    child, background: false,
    onAssistantText: (t) => process.stdout.write(t + "\n"),
  });

  const exitCode = child.exitCode;
  const failure = detectFailure({
    exitCode,
    resultEvent: streamResult.resultEvent,
    assistantTexts: streamResult.assistantTexts,
    stderr: streamResult.stderrTail,
  });

  const finalMeta = {
    ...jobMeta,
    status: failure.failed ? "failed" : "completed",
    finishedAt: new Date().toISOString(),
    sessionId: streamResult.sessionId,
    result: streamResult.resultEvent?.result || null,
    // v3.1 F-4: 透传 permission_denials 给 /qwen:result 高亮(schema 归一 + redact,Qwen v0.1.1 P0)
    permissionDenials: normalizePermissionDenials(streamResult.resultEvent?.permission_denials),
    failure: failure.failed ? failure : null,
  };

  // 完整 job payload 落单文件,state.json 也同步元数据
  writeJobFile(cwd, jobId, finalMeta);
  upsertJob(cwd, finalMeta);

  process.exit(failure.failed ? 3 : 0);
}

// task-resume-candidate 子命令 — 供 /qwen:rescue 决策"续/新"
function runTaskResumeCandidate(rawArgs) {
  const { options } = parseArgs(rawArgs, { booleanOptions: ["json"] });
  const cwd = resolveWorkspaceRoot(process.cwd());

  let available = false;
  let latestJobId = null;
  try {
    const jobs = listJobs(cwd) || [];
    const task = jobs.find(j => j.kind === "task");
    if (task) {
      const ts = task.finishedAt || task.startedAt;
      const age = Date.now() - new Date(ts).getTime();
      if (age < 24 * 3600 * 1000 && !Number.isNaN(age)) {
        available = true;
        latestJobId = task.jobId ?? task.id;
      }
    }
  } catch { /* 空 state 也算不可用 */ }

  const payload = { available, latestJobId };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  process.exit(0);
}

// cancel 子命令 — §5.5
async function runCancel(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, { booleanOptions: ["json"] });
  const jobId = positionals[0];
  const cwd = resolveWorkspaceRoot(process.cwd());
  const jsonMode = options.json === true;

  const emit = (payload, humanText, exitCode) => {
    if (jsonMode) process.stdout.write(JSON.stringify({ ...payload, jobId }, null, 2) + "\n");
    else process.stdout.write(humanText + "\n");
    process.exit(exitCode);
  };

  if (!jobId) {
    process.stderr.write("cancel: jobId required\n");
    process.exit(2);
  }

  // 从 state.json 找 job
  const jobs = listJobs(cwd) || [];
  const job = jobs.find(j => (j.jobId ?? j.id) === jobId);
  if (!job) {
    emit({ ok: false, reason: "not_found" }, `Job ${jobId} not found.`, 3);
  }
  if (job.status !== "running") {
    // Claude v0.1.0 P0-3:已 completed/cancelled/failed/queued 的 job,cancel 是 no-op,
    // 默认打人类可读文本(exit 0),--json 保留 envelope 供脚本消费。
    emit(
      { ok: false, reason: `job is ${job.status}, not running` },
      `Job ${jobId} is already ${job.status}, nothing to cancel.`,
      0,
    );
  }
  if (!job.pgid) {
    emit({ ok: false, reason: "no pgid recorded" }, `Job ${jobId} has no pgid recorded (cannot cancel).`, 3);
  }

  // 发信号
  const r = await cancelJobPgid(job.pgid, { sleepMs: 2000 });

  if (r.ok) {
    const updated = { ...job, status: "cancelled", finishedAt: new Date().toISOString() };
    upsertJob(cwd, updated);
    emit({ ok: true }, `Cancelled ${jobId}`, 0);
  } else {
    const updated = {
      ...job,
      status: "failed",
      failure: { kind: r.kind, message: r.message },
      finishedAt: new Date().toISOString(),
    };
    upsertJob(cwd, updated);
    emit(
      { ok: false, kind: r.kind, message: r.message },
      `Failed to cancel ${jobId}: ${r.kind} — ${r.message}`,
      5,
    );
  }
}

// status 子命令 — §4.6 / §5.4 含 orphan 探测
async function runStatus(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleanOptions: ["wait", "all", "json"],
    valueOptions: ["timeout-ms"],
  });
  const cwd = resolveWorkspaceRoot(process.cwd());
  const jobId = positionals[0];

  if (jobId) {
    const jobs = listJobs(cwd) || [];
    const job = jobs.find(j => (j.jobId ?? j.id) === jobId);
    if (!job) {
      process.stdout.write(JSON.stringify({ error: "job not found", jobId }, null, 2) + "\n");
      process.exit(3);
    }
    const refreshed = refreshJobLiveness(cwd, job);
    process.stdout.write(JSON.stringify(refreshed, null, 2) + "\n");
    process.exit(0);
  }

  // 列表模式
  const jobs = (listJobs(cwd) || []).map((j) => refreshJobLiveness(cwd, j));
  if (options.json) {
    process.stdout.write(JSON.stringify(jobs, null, 2) + "\n");
  } else {
    const lines = ["| jobId | kind | status | startedAt | prompt |", "|---|---|---|---|---|"];
    for (const j of jobs) {
      const p = (j.prompt || "").slice(0, 40).replace(/\|/g, "/");
      lines.push(`| ${j.jobId} | ${j.kind || ""} | ${j.status} | ${j.startedAt || ""} | ${p} |`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  }
  process.exit(0);
}

// result 子命令 — 显示单 job 的完整负载
async function runResult(rawArgs) {
  const { positionals, options } = parseArgs(rawArgs, { booleanOptions: ["json"] });
  const jobId = positionals[0];
  if (!jobId) {
    process.stderr.write("result: jobId required\n");
    process.exit(2);
  }

  const cwd = resolveWorkspaceRoot(process.cwd());

  // 优先从 jobs/<id>.json 单文件读(完整 payload 含 result、permissionDenials 等)
  // fallback 到 state.json jobs 数组 + 被动 finalize(bg job 未被 status 刷过时)
  let job = null;
  try {
    const jobFilePath = resolveJobFile(cwd, jobId);
    if (fs.existsSync(jobFilePath)) {
      job = JSON.parse(fs.readFileSync(jobFilePath, "utf8"));
    }
  } catch { /* ignore */ }
  if (!job) {
    const jobs = listJobs(cwd) || [];
    const raw = jobs.find(j => (j.jobId ?? j.id) === jobId);
    if (raw) {
      // 如果 bg job 还是 running 且 pid 死了,refreshJobLiveness 会读 log + writeJobFile,
      // 然后我们再从 jobs/<id>.json 重读完整 payload
      const refreshed = refreshJobLiveness(cwd, raw);
      const jobFilePath = resolveJobFile(cwd, jobId);
      if (fs.existsSync(jobFilePath)) {
        try { job = JSON.parse(fs.readFileSync(jobFilePath, "utf8")); } catch { /* ignore */ }
      }
      job = job || refreshed;
    }
  }

  if (!job) {
    process.stdout.write(JSON.stringify({ error: "job not found", jobId }, null, 2) + "\n");
    process.exit(3);
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(job, null, 2) + "\n");
  } else {
    process.stdout.write(`Job: ${job.jobId}\n`);
    process.stdout.write(`Status: ${job.status}\n`);
    process.stdout.write(`Kind: ${job.kind || "(unknown)"}\n`);
    if (job.sessionId) process.stdout.write(`Session: ${job.sessionId}\n`);
    if (job.startedAt) process.stdout.write(`Started: ${job.startedAt}\n`);
    if (job.finishedAt) process.stdout.write(`Finished: ${job.finishedAt}\n`);
    if (job.result) process.stdout.write(`\n--- Result ---\n${job.result}\n`);

    // v3.1 F-4: permissionDenials 高亮
    if (job.permissionDenials && job.permissionDenials.length > 0) {
      process.stdout.write(`\n--- Permission Denials (${job.permissionDenials.length}) ---\n`);
      process.stdout.write(`Qwen 想调用但被 auto-deny 的工具:\n`);
      for (const pd of job.permissionDenials) {
        const input = JSON.stringify(pd.tool_input || {}).slice(0, 120);
        process.stdout.write(`  - ${pd.tool_name}: ${input}\n`);
      }
      process.stdout.write(`\n提示:加 --unsafe 重跑让 qwen 实际执行这些工具。\n`);
    }

    if (job.failure) {
      process.stdout.write(`\n--- Failure ---\n`);
      process.stdout.write(JSON.stringify(job.failure, null, 2) + "\n");
    }
  }
  process.exit(0);
}

// review / adversarial-review 子命令
async function runReview(rawArgs, { adversarial = false } = {}) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleanOptions: ["wait", "background", "json", "unsafe"],
    valueOptions: ["base", "scope"],
  });

  const cwd = resolveWorkspaceRoot(process.cwd());
  ensureGitRepository(cwd);

  // 收集 diff — 注意实际签名: collectReviewContext(cwd, { base, scope })
  let ctx;
  try {
    ctx = collectReviewContext(cwd, {
      base: options.base,
      scope: options.scope || "auto",
    });
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, kind: "git_error", message: e.message }, null, 2) + "\n");
    process.exit(3);
  }

  // collectReviewContext 返回 { content, summary, mode, ... }，不是 { diff }
  const diff = ctx.content || "";
  if (!diff.trim()) {
    process.stdout.write(JSON.stringify({ ok: false, reason: "no_diff", mode: ctx.mode }, null, 2) + "\n");
    process.exit(0);
  }

  // 读 schema
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.resolve(scriptsDir, "..", "schemas", "review-output.schema.json");
  const schemaText = fs.readFileSync(schemaPath, "utf8");
  const schema = JSON.parse(schemaText);

  // 简易验证:required + 基础 enum
  // (v0.2 可升级为真 ajv;当前避免外部依赖)
  const validate = (data, s) => {
    if (typeof data !== "object" || data === null) {
      return [{ message: "not object", instancePath: "/" }];
    }
    const errors = [];
    for (const req of s.required ?? []) {
      if (!(req in data)) errors.push({ message: `required: ${req}`, instancePath: `/${req}` });
    }
    if (s.properties?.verdict?.enum && data.verdict &&
        !s.properties.verdict.enum.includes(data.verdict)) {
      errors.push({ message: `verdict '${data.verdict}' not in enum`, instancePath: "/verdict" });
    }
    return errors.length ? errors : null;
  };

  // 构造 runQwen 闭包
  const userSettings = readQwenSettings();
  const { env } = buildSpawnEnv(userSettings);

  const runQwen = async (prompt, opts = {}) => {
    // Codex v0.1.0 P1-2:retry 轮 (useResumeSession=true) 走 `-c` 续上一轮 session,
    // 让 qwen 还看得到原 diff 和 schema,retry 约束力 + 一致性更强。
    const { args: argsArr } = buildQwenArgs({
      prompt: prompt.user,
      appendSystem: prompt.appendSystem || undefined,
      resumeLast: opts.useResumeSession === true,
      // v0.1.1 hotfix:review 默认 auto-edit(无 TTY 会 auto-deny shell/write,符合"只读 diff 吐 JSON"的语义)
      // 仅当用户显式 --unsafe 时切 yolo(罕见:需要 qwen 跑 shell 查额外信息时)
      unsafeFlag: options.unsafe === true,
      background: false,
      maxSteps: opts.maxSteps ?? 20,
    });

    const { child } = spawnQwenProcess({ args: argsArr, env, cwd, background: false });
    const streamResult = await streamQwenOutput({ child, background: false });

    // raw 优先 result.result(完整响应),fallback assistant texts join
    return streamResult.resultEvent?.result || streamResult.assistantTexts.join("\n");
  };

  const reviewResult = await reviewWithRetry({
    diff, schemaText, schema, validate, runQwen, adversarial,
  });

  if (reviewResult.ok) {
    process.stdout.write(JSON.stringify(reviewResult.parsed, null, 2) + "\n");
    process.exit(0);
  } else {
    const payload = {
      ok: false,
      kind: reviewResult.kind,
      attempts_summary: reviewResult.attempts.map((a, i) => ({
        attempt: i + 1,
        raw_head: (a || "").slice(0, 4000),
      })),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    process.exit(6);
  }
}

// Dispatcher
const UNPACK_SAFE_SUBCOMMANDS = new Set(["setup"]);

function shouldUnpackBlob(sub, rest) {
  if (rest.length !== 1) return false;
  if (!UNPACK_SAFE_SUBCOMMANDS.has(sub)) return false;
  if (!rest[0].includes(" ")) return false;
  const tokens = splitRawArgumentString(rest[0]);
  return tokens.length > 0 && tokens.every((t) => t.startsWith("-"));
}

async function main() {
  const argv = process.argv.slice(2);
  let [sub, ...rest] = argv;

  if (shouldUnpackBlob(sub, rest)) {
    rest = splitRawArgumentString(rest[0]);
  }

  switch (sub) {
    case "setup":
      return runSetup(rest);
    case "task":
      return await runTask(rest);
    case "task-resume-candidate":
      return runTaskResumeCandidate(rest);
    case "cancel":
      return await runCancel(rest);
    case "status":
      return await runStatus(rest);
    case "result":
      return await runResult(rest);
    case "review":
      return await runReview(rest, { adversarial: false });
    case "adversarial-review":
      return await runReview(rest, { adversarial: true });
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      process.exit(0);
      break;
    default:
      process.stderr.write(`Unknown subcommand: ${sub}\n${USAGE}\n`);
      process.exit(1);
  }
}

main();
