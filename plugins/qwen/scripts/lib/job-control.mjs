// Shared constants + pure helpers for job lifecycle coordination.
//
// 这个文件在 gemini v0.5.2 血统里是 600 行的 streaming worker / job lifecycle orchestrator,
// qwen 架构把 spawn/stream/status 散到 companion + state + job-lifecycle,本文件只剩两个
// 被 hooks 共用的小工具。保留名字是为了稳定 import 路径。
//
// 历史版本删除原因:
// - runStreamingWorker / runStreamingJobInBackground:依赖未实装的 callQwenStreaming stub
//   (commit a6fdb7f 删除)
// - createJob / runJobInBackground / runWorker / cancelJob / waitForJob /
//   buildStatusSnapshot / buildSingleJobSnapshot / resolveResultJob /
//   resolveCancelableJob / resolveResumeCandidate / readStoredJobResult:
//   qwen-companion.mjs 自行 spawn + 管理 lifecycle,这些 gemini 入口从未被调用
//   (3-way review 2026-04-21 确认全部 dead,commit XXXXXXX 删除)

export const SESSION_ID_ENV = "QWEN_COMPANION_SESSION_ID";

export function sortJobsNewestFirst(jobs) {
  return jobs
    .slice()
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
