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
  CompanionError,
} from "./lib/qwen.mjs";
import {
  ensureStateDir,
  upsertJob,
  writeJobFile,
} from "./lib/state.mjs";
import { runCommand } from "./lib/process.mjs";

const USAGE = `Usage: qwen-companion <subcommand> [options]

Subcommands:
  setup [--json] [--enable-review-gate] [--disable-review-gate]
  task  [--background|--wait] [--unsafe] [--resume-last] [--session-id <uuid>] <prompt>

(More subcommands arrive in Phase 2+.)`;

// setup 子命令
function runSetup(rawArgs) {
  const { options } = parseArgs(rawArgs, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });

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
  let argsBuild;
  try {
    argsBuild = buildQwenArgs({
      prompt,
      resumeLast,
      resumeId: options["session-id"] ? undefined : undefined,
      sessionId: options["session-id"] || jobId,  // 把 jobId 直接用作 session-id
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

  const cwd = process.cwd();
  ensureStateDir(cwd);

  // 写 running job
  const jobMeta = {
    jobId, kind: "task",
    status: "running",
    approvalMode, unsafeFlag,
    startedAt: new Date().toISOString(),
    cwd, prompt,
    warnings,
  };

  // Spawn
  const { child } = spawnQwenProcess({ args, env, cwd, background });
  jobMeta.pid = child.pid;
  jobMeta.pgid = child.pid; // detached 后 pid === pgid

  upsertJob(cwd, jobMeta);

  if (background) {
    // 后台:立即返 jobId,companion 退
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
  });

  const finalMeta = {
    ...jobMeta,
    status: failure.failed ? "failed" : "completed",
    finishedAt: new Date().toISOString(),
    sessionId: streamResult.sessionId,
    result: streamResult.resultEvent?.result || null,
    // v3.1 F-4: 透传 permission_denials 给 /qwen:result 高亮
    permissionDenials: streamResult.resultEvent?.permission_denials ?? [],
    failure: failure.failed ? failure : null,
  };

  // 完整 job payload 落单文件,state.json 也同步元数据
  writeJobFile(cwd, jobId, finalMeta);
  upsertJob(cwd, finalMeta);

  process.exit(failure.failed ? 3 : 0);
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
