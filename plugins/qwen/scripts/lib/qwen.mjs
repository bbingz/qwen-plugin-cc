// plugins/qwen/scripts/lib/qwen.mjs
// Qwen CLI wrapper — spawn / auth / stream-json / proxy injection / failure detection.
// 对应 gemini.mjs,但从零写(spec §2.3 "重写")。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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
  const env = { ...process.env };
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
      const blocks = event.message?.content ?? [];
      for (const b of blocks) {
        // F-6: 只收 text,跳过 thinking 块
        if (b?.type === "text" && typeof b.text === "string") {
          out.assistantTexts.push(b.text);
        }
      }
    } else if (event.type === "result") {
      out.resultEvent = event;
    }
  }

  return out;
}
