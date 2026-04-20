import fs from "node:fs";
import process from "node:process";

import { parseStreamEvents, detectFailure } from "./qwen.mjs";
import { writeJobFile, upsertJob } from "./state.mjs";

/**
 * pid 探活 + 被动 finalize(bg job)。
 *
 * bg child 把 stream-json 写到 logFile;child 死后读 log 解析出 result/sessionId/failure,
 * writeJobFile 落完整负载。没 log 才降级为 orphan。
 *
 * 被 status / result / SessionEnd hook 共用。
 */
export function refreshJobLiveness(cwd, job) {
  if (job.status !== "running" || !job.pid) return job;
  try {
    process.kill(job.pid, 0); // 探测,不发信号
    return job;
  } catch (e) {
    if (e.code !== "ESRCH") return job;

    // bg job 有 log file → 解析
    if (job.logFile && fs.existsSync(job.logFile)) {
      let logText = "";
      try { logText = fs.readFileSync(job.logFile, "utf8"); } catch { /* ignore */ }
      const parsed = parseStreamEvents(logText);
      // 真实 exitCode 未知(child 已退出,ESRCH 探不到)。detectFailure 无法走 Layer 1。
      // 安全策略:有 resultEvent 才走 detectFailure;没有视为 incomplete_stream。
      // 防 crash(exit!=0)但留下部分 assistantTexts 被误判 completed。
      let failure;
      if (!parsed.resultEvent) {
        failure = { failed: true, kind: "incomplete_stream", message: "child exited without result event (crash or truncated)" };
      } else {
        failure = detectFailure({
          exitCode: 0,
          resultEvent: parsed.resultEvent,
          assistantTexts: parsed.assistantTexts,
        });
      }
      const updated = {
        ...job,
        status: failure.failed ? "failed" : "completed",
        finishedAt: new Date().toISOString(),
        sessionId: parsed.sessionId,
        result: parsed.resultEvent?.result || null,
        permissionDenials: parsed.resultEvent?.permission_denials ?? [],
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
