// plugins/qwen/scripts/lib/qwen.mjs
// Qwen CLI wrapper — spawn / auth / stream-json / proxy injection / failure detection.
// 对应 gemini.mjs,但从零写(spec §2.3 "重写")。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { binaryAvailable, runCommand } from "./process.mjs";

// ── 常量 ──────────────────────────────────────────────────────

export const QWEN_BIN = process.env.QWEN_CLI_BIN || "qwen";
export const DEFAULT_TIMEOUT_MS = 300_000;
export const AUTH_CHECK_TIMEOUT_MS = 30_000;
export const PARENT_SESSION_ENV = "QWEN_COMPANION_SESSION_ID";
export const QWEN_SETTINGS_PATH = path.join(os.homedir(), ".qwen", "settings.json");
export const QWEN_CREDS_PATH = path.join(os.homedir(), ".qwen", "oauth_creds.json");

// Proxy env keys — 四键全量(§4.3)
export const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
export const NO_PROXY_DEFAULTS = ["localhost", "127.0.0.1"];

// ── Env whitelist(v0.1.1 hotfix:防 parent env 全量泄漏给 qwen child) ──
// 固定允许的 key
const ENV_ALLOW_EXACT = new Set([
  // 基础
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "LC_MESSAGES", "LC_NUMERIC", "LC_TIME", "TMPDIR", "TZ", "PWD", "LOGNAME",
  // Node(NODE_OPTIONS 可注入 --require/--import 预加载 JS,攻击面大:
  // 移出默认白名单,用户需要自己 QWEN_PLUGIN_ENV_ALLOW="NODE_OPTIONS" 放行)
  "NODE_PATH", "NODE_EXTRA_CA_CERTS",
  // Proxy 四键 + NO_PROXY(buildSpawnEnv 会单独处理,但也允许直接透传)
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy",
  // Claude Code 插件数据目录(state.mjs 依赖)
  "CLAUDE_PLUGIN_DATA",
  // qwen 用于 openai-compat 模式(罕见)
  "OPENAI_BASE_URL", "OPENAI_API_KEY",
]);
// 前缀允许(qwen / Alibaba / DashScope 家族)
const ENV_ALLOW_PREFIXES = [
  "QWEN_", "BAILIAN_", "DASHSCOPE_", "ALIBABA_", "ALI_",
  "NPM_CONFIG_", "NPM_TOKEN", // npm 有时在 qwen extensions 里 resolve 包
];
// 用户自定义扩展白名单:QWEN_PLUGIN_ENV_ALLOW="KEY1,KEY2,..."
const USER_ALLOW_ENV_VAR = "QWEN_PLUGIN_ENV_ALLOW";

export function filterEnvForChild(parentEnv = process.env) {
  const userAllow = new Set(
    String(parentEnv[USER_ALLOW_ENV_VAR] ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean)
  );
  const out = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v == null) continue;
    if (ENV_ALLOW_EXACT.has(k) || userAllow.has(k)) { out[k] = v; continue; }
    if (ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p))) { out[k] = v; continue; }
  }
  return out;
}

// ── CompanionError ───────────────────────────────────────────

export class CompanionError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

// ── Availability ─────────────────────────────────────────────

/**
 * 探测 qwen CLI 可用性。
 * v3.1 F-1 实测:qwen -V 返回 "Unknown argument: V",必须用 --version。
 *
 * @param {string} [bin] 可选覆盖二进制路径(测试用)
 * @returns {{ available: boolean, detail: string }}
 */
export function getQwenAvailability(bin = QWEN_BIN) {
  return binaryAvailable(bin, ["--version"]);
}

// ── Proxy 注入(§4.3,v3.1 防御层) ────────────────────────────

/**
 * v3.1 F-5 实测:多数 qwen 用户 settings.json 无 proxy 字段,
 * 此函数作为防御层:若 settings 确有 proxy,按四键全量注入 + 冲突检测。
 *
 * 步骤:
 * 1. 四键全量收集 env 值,检查内部一致性
 * 2. 若 env 内部不一致 → proxy_env_mismatch warning,跳过 settings 注入
 * 3. 否则,若 settings.proxy 存在:
 *    - env 无 → 注入四大小写
 *    - env 有且一致 → noop
 *    - env 有且冲突 → proxy_conflict warning,不覆盖
 * 4. NO_PROXY 合并(而非覆盖)默认 bypass
 *
 * @param {{ proxy?: string } | null} userSettings
 * @returns {{ env: NodeJS.ProcessEnv, warnings: Array<{kind:string, [k:string]:any}> }}
 */
export function buildSpawnEnv(userSettings) {
  // v0.1.1 hotfix:不再全量继承 process.env,只继承白名单,防 ANTHROPIC_API_KEY / OPENAI_API_KEY
  // 等 parent 的凭据变量泄漏给 qwen child。用户需额外 passthrough 某个 key,通过
  // QWEN_PLUGIN_ENV_ALLOW="K1,K2" 声明。
  const env = filterEnvForChild(process.env);
  const proxy = userSettings?.proxy;
  const warnings = [];

  // 步骤 1:四键全量收集
  const seen = PROXY_KEYS
    .map((k) => ({ key: k, value: env[k] }))
    .filter((x) => x.value);
  const uniqueValues = [...new Set(seen.map((x) => x.value))];

  if (uniqueValues.length > 1) {
    warnings.push({
      kind: "proxy_env_mismatch",
      message: "env has conflicting proxy values across HTTP(S)_PROXY keys",
      detail: seen,
    });
    // 跳过 settings 注入,交 env 作者自己解决
  } else {
    const existing = uniqueValues[0];

    // 步骤 2:settings vs env 对齐
    if (proxy) {
      if (!existing) {
        // 四键都写(Linux undici 大小写敏感 + Go qwen 优先大写,double-write 最稳)
        for (const k of PROXY_KEYS) env[k] = proxy;
      } else if (existing !== proxy) {
        warnings.push({ kind: "proxy_conflict", settings: proxy, env: existing });
        // 不覆盖
      }
      // existing === proxy → noop
    }
  }

  // 步骤 3:NO_PROXY merge
  const userBypass = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = Array.from(new Set([...userBypass, ...NO_PROXY_DEFAULTS])).join(",");
  env.NO_PROXY = merged;
  env.no_proxy = merged;

  return { env, warnings };
}

// ── Settings ─────────────────────────────────────────────────────

/**
 * 读 ~/.qwen/settings.json。不存在或坏 JSON 返 null。
 * @param {string} [filePath] 默认 QWEN_SETTINGS_PATH
 * @returns {object | null}
 */
export function readQwenSettings(filePath = QWEN_SETTINGS_PATH) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Auth status parser(解析 `qwen auth status` 输出)──────────

/**
 * 把 qwen auth status 的人类文本解析为结构化对象。
 * v3.1 F-9: 要能识别三种 mode — coding-plan / qwen-oauth / openai(API Key)。
 * 碎了 → authMethod: "unknown",不 throw。
 */
export function parseAuthStatusText(text) {
  const result = { authMethod: "unknown", model: null, configured: false };
  if (!text || typeof text !== "string") return result;

  // 识别 auth 方法
  if (/Alibaba Cloud Coding Plan|coding.?plan/i.test(text)) {
    result.authMethod = "coding-plan";
  } else if (/Qwen OAuth|qwen-oauth/i.test(text)) {
    result.authMethod = "qwen-oauth";
  } else if (/OpenAI.?compatible|openai api.?key/i.test(text)) {
    result.authMethod = "openai";
  } else if (/Anthropic/i.test(text)) {
    result.authMethod = "anthropic";
  }

  // 抓 model
  const modelMatch = text.match(/Current Model:\s*([^\s\n]+)/i);
  if (modelMatch) result.model = modelMatch[1];

  // 是否 configured
  if (/key configured|OAuth token valid|authenticated/i.test(text)) {
    result.configured = true;
  }

  return result;
}

// ── Installer detection ──────────────────────────────────────

/**
 * 探测可用的 qwen 安装途径(spec §1.2)。
 */
export function detectInstallers() {
  return {
    npm: binaryAvailable("npm", ["--version"]).available,
    brew: binaryAvailable("brew", ["--version"]).available,
    shellInstaller: binaryAvailable("sh", ["-c", "command -v curl"]).available,
  };
}

// ── Ping(探活) ─────────────────────────────────────────────

/**
 * 解析 qwen stream-json 里一条 assistant 消息的 content[]。
 *
 * Qwen v0.1.1 P0:以前只收 text,跳过其他。现在也抓 tool_use(audit 用)
 * 和 tool_result(failure 诊断用);image 只计数防 base64 塞爆 log。
 * thinking 仍按 F-6 跳过。
 *
 * @param {Array<object>} blocks — event.message.content
 * @returns {{ texts: string[], toolUses: object[], toolResults: object[], imageCount: number }}
 */
export function parseAssistantContent(blocks) {
  const out = { texts: [], toolUses: [], toolResults: [], imageCount: 0 };
  if (!Array.isArray(blocks)) return out;
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") {
      out.texts.push(b.text);
    } else if (b.type === "tool_use") {
      out.toolUses.push({
        id: b.id ?? null,
        name: b.name ?? null,
        input: b.input ?? null,
      });
    } else if (b.type === "tool_result") {
      out.toolResults.push({
        tool_use_id: b.tool_use_id ?? null,
        // content 可能是 string 或 blocks array;保留原样,下游自己判
        content: b.content ?? null,
        is_error: Boolean(b.is_error),
      });
    } else if (b.type === "image") {
      out.imageCount += 1;
    }
    // thinking / 其它未知 type:F-6 跳过
  }
  return out;
}

/**
 * 跑一次 qwen "ping" 的 stream-json,抓 init + assistant + result 事件。
 * 不做判错(判错在 §5.1 detectFailure 统一),只返原料。
 *
 * v3.1 F-6: 跳过 thinking 块,只收 type==="text" 的 content。
 *
 * @returns {{
 *   exitCode: number | null,
 *   sessionId: string | null,
 *   model: string | null,
 *   mcpServers: string[],
 *   assistantTexts: string[],
 *   resultEvent: object | null,
 *   stderrTail: string,
 * }}
 */
export function runQwenPing({ env, cwd, bin = QWEN_BIN } = {}) {
  const result = runCommand(
    bin,
    ["ping", "--output-format", "stream-json", "--max-session-turns", "1"],
    { cwd, env: env ?? process.env, timeout: AUTH_CHECK_TIMEOUT_MS }
  );

  const out = {
    exitCode: result.status,
    sessionId: null,
    model: null,
    mcpServers: [],
    assistantTexts: [],
    toolUses: [],
    toolResults: [],
    imageCount: 0,
    resultEvent: null,
    stderrTail: (result.stderr || "").slice(-500),
  };

  if (result.error) return out;

  for (const raw of (result.stdout || "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }

    if (event.type === "system" && event.subtype === "init") {
      out.sessionId = event.session_id ?? null;
      out.model = event.model ?? null;
      out.mcpServers = Array.isArray(event.mcp_servers) ? event.mcp_servers : [];
    } else if (event.type === "assistant") {
      const parsed = parseAssistantContent(event.message?.content ?? []);
      out.assistantTexts.push(...parsed.texts);
      out.toolUses.push(...parsed.toolUses);
      out.toolResults.push(...parsed.toolResults);
      out.imageCount += parsed.imageCount;
    } else if (event.type === "result") {
      out.resultEvent = event;
    }
  }

  return out;
}

// ── classifyApiError(§5.1 v3.1) ────────────────────────────

/**
 * 把 [API Error: ...] 文本分类为具体 kind。
 *
 * 优先级:
 * 1. qwen 格式 [API Error: NNN ...] 提取状态码(F-2 实测)
 * 2. fallback 到 (Status: NNN) 格式兼容其他 provider
 * 3. DashScope 特化 (108 / content sensitive)
 * 4. 关键词兜底(带 \b 边界防误伤)
 * 5. 完全未命中 → api_error_unknown
 */
export function classifyApiError(msg) {
  const m = String(msg ?? "");

  // 1. 状态码优先(v3.1 F-2):qwen 格式 [API Error: NNN ...] 优先;
  //    (Status: NNN) 作兼容其他 provider 的 fallback
  let statusMatch = m.match(/\[API Error:\s*(\d{3})\b/i);
  if (!statusMatch) statusMatch = m.match(/\bStatus:\s*(\d{3})\b/i);
  if (statusMatch) {
    const code = parseInt(statusMatch[1], 10);
    if (code === 401 || code === 403) return { failed: true, kind: "not_authenticated", status: code, message: m };
    if (code === 429)                 return { failed: true, kind: "rate_limited",      status: code, message: m };
    if (code === 400)                 return { failed: true, kind: "invalid_request",   status: code, message: m };
    if (code >= 500 && code < 600)    return { failed: true, kind: "server_error",      status: code, message: m };
  }

  // 2. DashScope 特定(qwen 后端)
  if (/\berror code 108\b|\binsufficient.?balance\b|\bquota.?exceed/i.test(m))
    return { failed: true, kind: "insufficient_balance", message: m };
  if (/\bcontent.?sensitive\b|\bsensitive\b|\bmoderation\b|\bcontent.?(?:filter|policy|unsafe)/i.test(m))
    return { failed: true, kind: "content_sensitive", message: m };

  // 3. 关键词兜底(带 \b 边界防误伤)
  if (/\brate.?limit\b|\bthrottl/i.test(m))               return { failed: true, kind: "rate_limited", message: m };
  if (/\bquota\b|\bbilling\b/i.test(m))                   return { failed: true, kind: "quota_or_billing", message: m };
  if (/\bunauthoriz|\binvalid.*access.?token\b/i.test(m)) return { failed: true, kind: "not_authenticated", message: m };
  if (/\bmax.*output.*tokens\b/i.test(m))                 return { failed: true, kind: "max_output_tokens", message: m };
  if (/\bconnection\b|\bnetwork\b|\btimeout\b|\bECONNRESET\b|\bENOTFOUND\b/i.test(m))
                                                          return { failed: true, kind: "network_error", message: m };

  return { failed: true, kind: "api_error_unknown", message: m };
}

// ── permission_denials 归一化 + redact(Qwen v0.1.1 P0) ─────

const SENSITIVE_KEY_RE = /(api[_-]?key|apikey|token|secret|password|passwd|pwd|credential|auth|bearer|session_id)/i;
const SECRET_VALUE_PATTERNS = [
  /^Bearer\s+\S/i,
  /\bsk-[A-Za-z0-9_-]{20,}/,          // OpenAI
  /\bghp_[A-Za-z0-9]{20,}/,           // GitHub classic PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,   // GitHub fine-grained PAT
  /\bAKIA[0-9A-Z]{16}\b/,             // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,   // Slack
];

function redactInput(input) {
  if (input == null) return input;
  if (typeof input === "string") {
    for (const re of SECRET_VALUE_PATTERNS) if (re.test(input)) return "[REDACTED]";
    return input;
  }
  if (Array.isArray(input)) return input.map(redactInput);
  if (typeof input === "object") {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (SENSITIVE_KEY_RE.test(k)) { out[k] = "[REDACTED]"; continue; }
      out[k] = redactInput(v);
    }
    return out;
  }
  return input;
}

/**
 * 归一化 qwen stream-json 透传的 permission_denials:
 * - 丢非 object 条目
 * - tool_name 必须是 string(缺则 "unknown")
 * - tool_input 走 redactInput:key 含敏感字眼 → [REDACTED];
 *   string 值匹配常见 secret pattern(Bearer/sk-/ghp_/AKIA/xox) → [REDACTED]
 */
export function normalizePermissionDenials(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const tool_name = typeof entry.tool_name === "string" ? entry.tool_name : "unknown";
    const tool_input = redactInput(entry.tool_input ?? null);
    out.push({ tool_name, tool_input });
  }
  return out;
}

// ── detectFailure 五层(§5.1 v3.1) ──────────────────────────

/**
 * 六层判错。qwen "exit 0 + is_error:false 但 assistant text 含 [API Error:" 场景完整翻译。
 *
 * @param {{ exitCode: number | null, resultEvent: object | null, assistantTexts: string[], stderr?: string }} input
 */
export function detectFailure({ exitCode, resultEvent, assistantTexts, stderr }) {
  // 层 0:F-8 session 找不到(`-c`/`-r` 指向不存在的 session)。qwen 同时 exit!=0,
  // 但层 1 只返泛 "exit" kind 看不出原因;stderr 匹配则优先给精确分类。
  if (typeof stderr === "string" && /No saved session found/i.test(stderr)) {
    return { failed: true, kind: "no_prior_session" };
  }

  // 层 1:进程非 0 退出(null = 未退出,交给 timeout 层处理)
  if (exitCode !== 0 && exitCode !== null)
    return { failed: true, kind: "exit", code: exitCode };

  // 层 2:qwen 自报 is_error
  if (resultEvent?.is_error === true)
    return { failed: true, kind: "qwen_is_error" };

  // 层 3:result 字段含 [API Error:
  if (resultEvent?.result && /\[API Error:/.test(resultEvent.result))
    return classifyApiError(resultEvent.result);

  // 层 4:任一 assistant text 含 [API Error:(不锚 ^)
  const errLine = (assistantTexts || []).find(t => /\[API Error:/.test(t));
  if (errLine) return classifyApiError(errLine);

  // 层 5:空输出保护
  const hasText = (assistantTexts || []).length > 0;
  const hasResult = resultEvent?.result != null && resultEvent.result !== "";
  if (!hasText && !hasResult && exitCode === 0)
    return { failed: true, kind: "empty_output" };

  return { failed: false };
}

// ── 参数装配(§4.2) ──────────────────────────────────────────

/**
 * 按 spec §4.2 装配 qwen CLI 参数。
 * 决定 approvalMode 的落点:
 * - 用户显式 userApprovalMode → 尊重
 * - 否则 unsafeFlag ? "yolo" : "auto-edit"
 * - background + !unsafeFlag + yolo 结果 → 抛 CompanionError("require_interactive")
 *
 * v3.1 / Phase 0 case-11-decision:维持默认 auto-edit(auto-deny shell tools 无 TTY)。
 */
// v0.1.1: F-7 qwen 强校验 --session-id / -r 为 UUID,plugin 层提前拦截报清晰错误
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildQwenArgs({
  prompt,
  sessionId, resumeLast, resumeId,
  approvalMode: userApprovalMode,
  unsafeFlag, background,
  maxSteps = 20,
  appendSystem,
  appendDirs,
}) {
  let approvalMode = userApprovalMode;
  if (!approvalMode) approvalMode = unsafeFlag ? "yolo" : "auto-edit";
  if (background && !unsafeFlag && approvalMode === "yolo") {
    throw new CompanionError(
      "require_interactive",
      "Background rescue with yolo requires --unsafe. Add --unsafe or switch to foreground."
    );
  }

  if (sessionId != null && !UUID_RE.test(sessionId)) {
    throw new CompanionError(
      "invalid_session_id",
      `--session-id must be a UUID (got "${sessionId}"). Use crypto.randomUUID() or omit.`
    );
  }
  if (resumeId != null && !UUID_RE.test(resumeId)) {
    throw new CompanionError(
      "invalid_session_id",
      `-r resume-id must be a UUID (got "${resumeId}").`
    );
  }

  const args = [];
  if (sessionId)        args.push("--session-id", sessionId);
  else if (resumeLast)  args.push("-c");
  else if (resumeId)    args.push("-r", resumeId);

  args.push("--output-format", "stream-json");
  args.push("--approval-mode", approvalMode);
  args.push("--max-session-turns", String(maxSteps));
  if (appendSystem) args.push("--append-system-prompt", appendSystem);
  if (appendDirs && appendDirs.length) args.push("--include-directories", appendDirs.join(","));

  args.push(prompt); // 位置参数

  return { args, approvalMode };
}

/**
 * 按 spec §4.2 spawn qwen 子进程。
 * - detached: true(独立 pgid,cancel 靠 pgid 信号)
 * - background: child.unref()(companion 可退);foreground: 调用方 await exit
 *
 * 不做 stream 边解析边判错(那是 streamQwenOutput 的事,Task 2.9)。
 *
 * @param {{ args, env, cwd, background, bin, stdio }} opts
 * @returns {{ child }} — 同步返 child handle(不 await)
 */
export function spawnQwenProcess({
  args, env, cwd,
  background = false,
  bin = QWEN_BIN,
  stdio = ["ignore", "pipe", "pipe"],
}) {
  const child = spawn(bin, args, {
    env, cwd,
    detached: true,   // v3.1 / Claude P0: 独立 pgid
    stdio,
  });

  // v3.1 / Claude P0: 仅 background 下 unref,foreground 需 companion 等 exit
  if (background) {
    child.unref();
  }

  return { child };
}

// ── streamQwenOutput:流式边读边判错(bg 模式,§4.4) ────────

/**
 * 从 child.stdout 流式读 JSONL。
 *
 * Foreground:不即时判错(避免半截错误输出),读完再让 detectFailure 走。
 * Background:命中 [API Error: 立即 SIGTERM + 等 child exit 或 500ms 后 resolve。
 *
 * v3.1 / Claude+Gemini P1: SIGTERM 后等 exit,防 job.json fs.renameSync 未完成变 orphan。
 *
 * @param {{ child, background, onAssistantText?, onResultEvent? }} opts
 * @returns {Promise<{ sessionId, model, mcpServers, assistantTexts, resultEvent, apiErrorEarly }>}
 */
export async function streamQwenOutput({ child, background, onAssistantText, onResultEvent } = {}) {
  const state = {
    sessionId: null, model: null, mcpServers: [],
    assistantTexts: [], toolUses: [], toolResults: [], imageCount: 0,
    resultEvent: null,
    apiErrorEarly: false,
    stderrTail: "",
    buffer: "",
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(state); } };

    child.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    child.on("exit", () => finish());

    // 收 stderr 尾(4KB 窗),detectFailure 用来识别 F-8 no_prior_session。
    child.stderr?.on?.("data", (chunk) => {
      state.stderrTail += chunk.toString("utf8");
      if (state.stderrTail.length > 4096) {
        state.stderrTail = state.stderrTail.slice(-4096);
      }
    });

    child.stdout.on("data", (chunk) => {
      state.buffer += chunk.toString("utf8");
      let idx;
      while ((idx = state.buffer.indexOf("\n")) >= 0) {
        const line = state.buffer.slice(0, idx).trim();
        state.buffer = state.buffer.slice(idx + 1);
        if (!line.startsWith("{")) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }

        if (event.type === "system" && event.subtype === "init") {
          state.sessionId = event.session_id ?? state.sessionId;
          state.model = event.model ?? state.model;
          if (Array.isArray(event.mcp_servers)) state.mcpServers = event.mcp_servers;
        } else if (event.type === "assistant") {
          const parsed = parseAssistantContent(event.message?.content ?? []);
          state.toolUses.push(...parsed.toolUses);
          state.toolResults.push(...parsed.toolResults);
          state.imageCount += parsed.imageCount;
          for (const text of parsed.texts) {
            state.assistantTexts.push(text);
            if (onAssistantText) onAssistantText(text);
            // bg 命中 [API Error: → 早退
            if (background && /\[API Error:/.test(text)) {
              state.apiErrorEarly = true;
              try {
                if (child.pid) process.kill(-child.pid, "SIGTERM");
              } catch { /* ESRCH 等无声吞 */ }
              // 500ms 兜底 resolve,即便 exit 事件还没到
              setTimeout(finish, 500);
            }
          }
        } else if (event.type === "result") {
          state.resultEvent = event;
          if (onResultEvent) onResultEvent(event);
        }
      }
    });
  });
}

// ── Stream JSON 事件解析(离线版,一次性消化字符串) ────────

/**
 * 从 stream-json JSONL 提取 init / assistant / result 事件。
 * 离线版(一次性喂全文);streaming 版见 Task 2.9 streamQwenOutput。
 *
 * v3.1 F-6: 跳过 type==="thinking" 的 content 块。
 *
 * @param {string} text - 完整 stdout JSONL
 * @returns {{ sessionId, model, mcpServers, assistantTexts, resultEvent }}
 */
export function parseStreamEvents(text) {
  const out = {
    sessionId: null,
    model: null,
    mcpServers: [],
    assistantTexts: [],
    toolUses: [],
    toolResults: [],
    imageCount: 0,
    resultEvent: null,
  };

  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }

    if (event.type === "system" && event.subtype === "init") {
      out.sessionId = event.session_id ?? out.sessionId;
      out.model = event.model ?? out.model;
      if (Array.isArray(event.mcp_servers)) out.mcpServers = event.mcp_servers;
    } else if (event.type === "assistant") {
      const parsed = parseAssistantContent(event.message?.content ?? []);
      out.assistantTexts.push(...parsed.texts);
      out.toolUses.push(...parsed.toolUses);
      out.toolResults.push(...parsed.toolResults);
      out.imageCount += parsed.imageCount;
    } else if (event.type === "result") {
      out.resultEvent = event;
    }
  }

  return out;
}

// ── Cancel 三级信号(§5.5 v3.1) ──────────────────────────────

/**
 * 对 pgid 依次发 SIGINT → SIGTERM → SIGKILL。
 * 每级之间 sleepMs 等待(default 2000)。
 * ESRCH 吞掉(子进程已退,正常);其他错误返 cancel_failed。
 *
 * v3.1 / Codex P1:非 ESRCH 错不悬停 — 返 { ok:false, kind:"cancel_failed" }
 *
 * @param {number} pgid — 子进程组 id
 * @param {{ sleepMs?, killFn? }} opts — killFn 仅测试用 mock
 * @returns {Promise<{ ok: true } | { ok: false, kind: "cancel_failed", message: string }>}
 */
/**
 * 按 pgid 发信号取消 job。
 *
 * v0.1.1 hotfix(P0 race):qwen child 死透后 OS 会回收 pgid 给**无关进程组**。
 * 直接按 stale pgid 发 SIGKILL 会误杀系统上无关进程。
 *
 * 修法:
 *   1) pre-check:`killFn(-pgid, 0)` 探活,ESRCH → job 已死,直接返 ok
 *   2) optional verify:`ps -g <pgid> -o command=` 检查 pgid 下有无 qwen;
 *      没有 → 视为已被 OS 回收,拒绝发杀信号(返 cancel_failed:pgid_recycled)
 *   3) 只对 verified 活着的 qwen pgid 发 SIGINT→TERM→KILL 序列
 *
 * @param {number} pgid
 * @param {{ sleepMs?: number, killFn?: Function, verifyFn?: Function }} opts
 *   verifyFn(pgid) → boolean: true=确认 pgid 下有 qwen / false=被回收或无法验证
 *   缺省 verifyFn 通过 node:child_process spawnSync ps 实现。
 */
export async function cancelJobPgid(pgid, { sleepMs = 2000, killFn = process.kill, verifyFn } = {}) {
  // Step 1: 探活
  try {
    killFn(-pgid, 0);
  } catch (e) {
    if (e.code === "ESRCH") return { ok: true }; // 已死
    return { ok: false, kind: "cancel_failed", message: `probe: ${e.message}` };
  }

  // Step 2: verify 该 pgid 下进程确实是 qwen(防 PID 复用误杀无关进程)
  const verifier = verifyFn ?? defaultVerifyPgidIsQwen;
  if (!verifier(pgid)) {
    return { ok: false, kind: "cancel_failed", message: "pgid_recycled: process group no longer belongs to qwen" };
  }

  // Step 3: 逐级升级信号
  const signals = ["SIGINT", "SIGTERM", "SIGKILL"];
  for (const sig of signals) {
    try {
      killFn(-pgid, sig);
    } catch (e) {
      if (e.code === "ESRCH") return { ok: true };
      return { ok: false, kind: "cancel_failed", message: `${sig}: ${e.message}` };
    }
    await new Promise(r => setTimeout(r, sleepMs));
  }
  return { ok: true };
}

function defaultVerifyPgidIsQwen(pgid) {
  try {
    const r = spawnSync("ps", ["-g", String(pgid), "-o", "command="], { encoding: "utf8" });
    if (r.status !== 0) return false; // ps failed → pgid 已无进程或 platform 不支持
    return /qwen/i.test(r.stdout);
  } catch {
    return false; // 无法验证 → 保守拒
  }
}

// ── tryLocalRepair:本地 JSON 修复(§5.3) ──────────────────

/**
 * 尝试把 qwen 吐的半坏 JSON 修成合法 JSON。
 * 常见病(Phase 0 case 07 观察 + 经验):
 * - 纯 JSON(最常见) → 直接 parse
 * - ```json / ``` fence 包裹
 * - 前/后置 prose("Here is my review:" 等)
 * - 尾部大括号缺失(尾部截断)
 * - 尾逗号(严格 JSON 不允许)
 *
 * 修不动返 null,不 throw。
 */
export function tryLocalRepair(raw) {
  if (!raw || typeof raw !== "string") return null;

  // Step 1: 原样 parse
  try { return JSON.parse(raw); } catch {}

  let text = raw.trim();

  // Step 2: 去 ```json / ``` fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Step 3: 找第一个 { 或 [,最后一个 } 或 ]。尾断(truncation)时没有末尾 }/],
  // 允许 lastBrace 缺,后面 Step 5 用 string-aware 扫描从首 brace 到末尾补齐。
  const firstBrace = Math.min(
    ...["{", "["].map(c => { const i = text.indexOf(c); return i < 0 ? Infinity : i; })
  );
  if (firstBrace === Infinity) return null;
  const lastBrace = Math.max(
    ...["}", "]"].map(c => text.lastIndexOf(c))
  );
  // 有末尾闭合 brace:试原样 slice + parse;没有则留给 Step 5 补齐。
  if (lastBrace > firstBrace) {
    const sliced = text.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(sliced); } catch {}

    const noTrailing = sliced.replace(/,(\s*[}\]])/g, "$1");
    try { return JSON.parse(noTrailing); } catch {}
  }

  // Step 5: string-aware 扫描 + truncation 修复。
  // 从 firstBrace 扫到末尾,跟踪 inString/escape,正确计 bracket;若最终在 string 内
  // (qwen timeout 尾断),先补 ";然后补齐缺失的 }/]。
  const tail = text.slice(firstBrace);
  const stack = [];
  let inString = false;
  let escape = false;
  for (const ch of tail) {
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }

  let fixed = tail;
  if (inString) fixed += '"';
  // 先去尾逗号再补闭合(补完顺序反转栈)。
  fixed = fixed.replace(/,(\s*)$/, "$1");
  while (stack.length) {
    const open = stack.pop();
    fixed += open === "{" ? "}" : "]";
  }

  try { return JSON.parse(fixed); } catch {}

  // 最后兜底:补完后再去一次中段尾逗号。
  try { return JSON.parse(fixed.replace(/,(\s*[}\]])/g, "$1")); } catch {}

  return null;
}

// ── Review prompt 构造(§5.3 v3.1) ──────────────────────────

/**
 * Review appendSystem 构造(独立于 diff/adversarial,首轮 + retry 轮共用)。
 */
export function buildReviewAppendSystem(schemaText) {
  return `You are a code reviewer. Your output must strictly match this JSON schema:

${schemaText}

Output only the JSON document itself. No prose before or after. No markdown fences.`;
}

/**
 * 初次 review prompt。塞 schema 到 --append-system-prompt,
 * user prompt 只含 diff 和"output ONLY JSON"指令。
 */
export function buildInitialReviewPrompt({ diff, schemaText, adversarial = false }) {
  const framing = adversarial
    ? "Challenge this diff's implementation approach and design choices. Find risks, assumptions, and scenarios where this breaks."
    : "Review this diff for correctness, security, and style issues.";

  const user = `${framing}

<diff>
${diff}
</diff>

Output ONLY a JSON object matching the review-output schema. No prose, no code fences.`;

  return { user, appendSystem: buildReviewAppendSystem(schemaText) };
}

/**
 * Retry prompt。携带上一轮 raw + schema + ajv 错误 + 修复指令。
 * 不重贴 diff(retry 复用同一 session -c,qwen 还看得见原 diff)。
 *
 * @param {{ previousRaw: string, schemaText: string, ajvErrors: object[], attemptNumber: 1|2 }} opts
 */
export function buildReviewRetryPrompt({ previousRaw, schemaText, ajvErrors, attemptNumber }) {
  // 截断 previousRaw 到 8KB(头 4KB + 尾 2KB + 中段省略标记)
  let raw = previousRaw || "";
  if (raw.length > 8000) {
    raw = raw.slice(0, 4000) + "\n... [truncated middle] ...\n" + raw.slice(-2000);
  }

  const errSummary = (ajvErrors || []).slice(0, 5).map(e => {
    return `- ${e.instancePath || "/"}: ${e.message}`;
  }).join("\n");

  const final = attemptNumber === 2
    ? "\n\nThis is your final attempt. Output the corrected JSON now."
    : "";

  return `Your previous output was not valid JSON matching the review-output schema.

Previous raw output:
${raw}

Schema errors:
${errSummary}

Schema (authoritative):
${schemaText}

Fix the JSON to match the schema. Output ONLY the corrected JSON, no prose, no code fences.${final}`;
}

// ── reviewWithRetry(§5.3 核心) ─────────────────────────────

/**
 * Review 主路径。最多 3 次尝试(首次 + 2 retry)。
 * 每轮先 JSON.parse,失败则 tryLocalRepair;本地也修不动才真正 retry。
 * retry 时**携带上一轮 raw + schema + ajv 错误**(v3.1 Codex P0 精神)。
 *
 * @param {object} opts
 * @param {string} opts.diff
 * @param {string} opts.schemaText
 * @param {object} opts.schema
 * @param {(prompt: object, options?: object) => Promise<string>} opts.runQwen
 * @param {(data: object, schema: object) => object[] | null} opts.validate
 * @param {boolean} [opts.adversarial=false]
 */
export async function reviewWithRetry({
  diff, schemaText, schema, runQwen, validate, adversarial = false,
}) {
  const attempts = [];
  let prompt = buildInitialReviewPrompt({ diff, schemaText, adversarial });
  let previousRaw = null;

  for (let i = 0; i < 3; i++) {
    const raw = await runQwen(prompt, {
      maxSteps: i === 0 ? 20 : 1,
      useResumeSession: i > 0,  // retry 用 -c 续上一轮 session
    });
    attempts.push(raw);
    previousRaw = raw;

    // Step A: 原样 parse + validate
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (parsed) {
      const errors = validate(parsed, schema);
      if (!errors) return { ok: true, parsed, attempts };
    }

    // Step B: 本地 repair
    parsed = tryLocalRepair(raw);
    if (parsed) {
      const errors = validate(parsed, schema);
      if (!errors) return { ok: true, parsed, attempts, repairedLocally: true };
    }

    // 构造 retry prompt(若还有下一轮)
    if (i < 2) {
      const ajvErrors = parsed
        ? (validate(parsed, schema) || [])
        : [{ message: "invalid JSON", instancePath: "/" }];
      prompt = {
        user: buildReviewRetryPrompt({
          previousRaw,
          schemaText,
          ajvErrors,
          attemptNumber: i + 1,
        }),
        // Qwen v0.14.5 对 --append-system-prompt 遵循度高于 user prompt,
        // retry 轮若不重塞会降级约束力。
        appendSystem: buildReviewAppendSystem(schemaText),
      };
    }
  }

  return {
    ok: false,
    kind: "schema_violation",
    attempts,
  };
}
