import fs from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { parseStreamEvents, detectFailure, normalizePermissionDenials } from "./qwen.mjs";
import { writeJobFile, upsertJob } from "./state.mjs";

// P0-7: refreshJobLiveness 被 /qwen:status list、/qwen:result、SessionEnd hook 同步调用。
// 长 bg job 的 stream-json log 可能 >100MB,全量 readFileSync 会冻住 CC 主进程。
// 按 1MB 尾部读(result event 总是最后一条 JSONL 行),足以让 detectFailure 拿到 resultEvent。
const LOG_TAIL_BYTES = 1 * 1024 * 1024;

/**
 * 从 log tail 抽 stderr 尾(非 JSONL 行)。bg spawn 把 stdout/stderr 都定向
 * 同一 logFile(`stdio = [ignore, fd, fd]`),stream-json 行以 `{` 开头,
 * stderr / node 崩溃栈则不是。用这个区分抽 detail。
 */
export function extractStderrFromLog(logText, maxLines = 20) {
  if (!logText) return "";
  const nonJson = [];
  for (const line of logText.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("{")) continue;
    nonJson.push(line);
  }
  return nonJson.slice(-maxLines).join("\n");
}

function readLogTail(logPath, maxBytes = LOG_TAIL_BYTES) {
  let fd;
  try {
    const { size } = fs.statSync(logPath);
    fd = fs.openSync(logPath, "r");
    if (size <= maxBytes) {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      return buf.toString("utf8");
    }
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    // 首行可能被截半,去掉
    const text = buf.toString("utf8");
    const firstNl = text.indexOf("\n");
    return firstNl >= 0 ? text.slice(firstNl + 1) : text;
  } catch {
    return "";
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * 默认 pid 归属验证:`ps -p <pid>` 检查 command 是否 qwen,防 PID 复用假活。
 * 保守策略:ps 本身失败(platform/race)返 true,避免把真 qwen 误标 failed。
 */
function defaultVerifyPidIsQwen(pid) {
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    if (r.status !== 0) return true; // ps 查不到:保守保留 running
    return /qwen/i.test(r.stdout);
  } catch {
    return true; // platform 不支持 ps:保守保留 running
  }
}

/**
 * pid 探活 + 被动 finalize(bg job)。
 *
 * bg child 把 stream-json 写到 logFile;child 死后读 log 解析出 result/sessionId/failure,
 * writeJobFile 落完整负载。没 log 才降级为 orphan。
 *
 * v0.2 correctness:对齐 cancelJobPgid 的保护。`process.kill(pid, 0)` 成功
 * 不等于 job 还活着 —— OS 会把 pid 复用给无关进程。额外用 `ps -p <pid>`
 * 验证 command 含 "qwen",不含则视为 pid 复用,走 finalize。
 *
 * 被 status / result / SessionEnd hook 共用。
 *
 * @param {object} options
 * @param {(pid: number) => boolean} [options.verifyFn] 自定义 pid 归属验证(测试用)
 */
export function refreshJobLiveness(cwd, job, { verifyFn } = {}) {
  if (job.status !== "running" || !job.pid) return job;

  let alive;
  try {
    process.kill(job.pid, 0); // 探测,不发信号
    const verifier = verifyFn ?? defaultVerifyPidIsQwen;
    alive = verifier(job.pid);
  } catch (e) {
    if (e.code !== "ESRCH") return job; // 非 ESRCH(EPERM 等):保守原样返
    alive = false;
  }

  if (alive) return job;

  {
    // bg job 有 log file → 解析(tail-only,防大 log 阻塞)
    if (job.logFile && fs.existsSync(job.logFile)) {
      const logText = readLogTail(job.logFile);
      const parsed = parseStreamEvents(logText);
      // 真实 exitCode 未知(child 已退出,ESRCH 探不到)。detectFailure 无法走 Layer 1。
      // 安全策略:有 resultEvent 才走 detectFailure;没有视为 incomplete_stream。
      // 防 crash(exit!=0)但留下部分 assistantTexts 被误判 completed。
      let failure;
      if (!parsed.resultEvent) {
        // Claude v0.1.0 P0-4:把 log 尾里的非 JSONL 行当 stderr,填到 failure.detail
        // 诊断 crash 栈 / node traceback / qwen error 输出。
        const stderrTail = extractStderrFromLog(logText);
        failure = {
          failed: true,
          kind: "incomplete_stream",
          message: "child exited without result event (crash or truncated)",
          detail: stderrTail || null,
        };
      } else {
        failure = detectFailure({
          exitCode: 0,
          resultEvent: parsed.resultEvent,
          assistantTexts: parsed.assistantTexts,
          stderr: extractStderrFromLog(logText),
        });
      }
      const updated = {
        ...job,
        status: failure.failed ? "failed" : "completed",
        finishedAt: new Date().toISOString(),
        sessionId: parsed.sessionId,
        result: parsed.resultEvent?.result || null,
        permissionDenials: normalizePermissionDenials(parsed.resultEvent?.permission_denials),
        failure: failure.failed ? failure : null,
      };
      writeJobFile(cwd, job.jobId, updated);
      upsertJob(cwd, updated);
      return updated;
    }

    // 无 log → 真 orphan
    const updated = {
      ...job,
      status: "failed",
      failure: { kind: "orphan", message: "process not found at status check" },
      finishedAt: new Date().toISOString(),
    };
    upsertJob(cwd, updated);
    return updated;
  }
}
