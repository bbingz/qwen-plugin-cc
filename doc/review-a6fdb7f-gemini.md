# Code Review for a6fdb7f (qwen-plugin-cc)

## P0: 全局一致性 (Critical)
1. **`upsertJob` 覆写漏洞 (由 `jobId` vs `id` 引起)**
   - **File:** `state.mjs:156` / `qwen-companion.mjs:220`
   - **分析:** `qwen-companion.mjs` 中构建的 `jobMeta` 只含有 `jobId` 没有 `id`。当调用 `upsertJob(cwd, jobMeta)` 时，`state.mjs` 内部做 `findIndex((j) => j.id === jobPatch.id)`，此时 `jobPatch.id` 为 `undefined`。如果这是第二次插入，`findIndex` 会匹配到第一个同样缺少 `id`（即 `undefined === undefined`）的 job，导致**旧的 job 永远被新的 job 覆盖**！这意味着 `state.json` 的 jobs 数组里永远只能存一个由 companion 发起的任务，且旧任务的 log 会被 `cleanupOrphanedFiles` 误当 orphan 删掉。
2. **Job File I/O 的 Key 混乱**
   - **File:** 全局 (`qwen-companion.mjs` vs `job-control.mjs`)
   - **分析:**
     - `qwen-companion.mjs` (新入口) 读写全面使用 `jobId`（如 `j.jobId === jobId`，`resolveJobFile(cwd, jobId)`）。
     - `job-control.mjs` (老入口) 全面使用 `id`（如 `createJob` 产出 `id`，`runJobInBackground` 用 `job.id`）。
     - `state.mjs::upsertJob` 强制依据 `id` 匹配。
     这种不一致不仅触发 P0.1 的覆写 bug，还会导致老工具读不到新 companion 跑的任务，新 companion 也无法正常 cancel/status 旧任务。
3. **`job-control.mjs` 死代码残留**
   - **File:** `plugins/qwen/scripts/lib/job-control.mjs`
   - **分析:** 删掉 `runStreaming...` 之后，由于 `qwen-companion.mjs` 完全没有 import `job-control.mjs`，且自行实现了所有 process spawn 和 state 写盘，以下 export 均成为 dead code，可安全删除：
     `runJobInBackground`, `runWorker`, `createJob`, `cancelJob`, `waitForJob`, `buildStatusSnapshot`, `buildSingleJobSnapshot`, `resolveResultJob`, `resolveCancelableJob`, `resolveResumeCandidate`, `readStoredJobResult`。
4. **后台任务 Finalize 链路的假死 (Lazy 机制)**
   - **分析:** 如果用户关掉终端且再也不执行 `/qwen:status`，该后台任务在 `state.json` 里将永远显示为 `running`。这是 acceptable 的（典型的 Lazy Evaluation 懒计算设计），但不适合没有周期性轮询（polling）的 UI。如果 Claude Code 只是单次触发命令，没有后续轮询机制，该 job 的结果就永远无法回填。
5. **`refreshJobLiveness` 假成功 (False Success) 漏洞**
   - **File:** `qwen-companion.mjs:355`
   - **分析:** 当命中 `ESRCH` 分支时，进程已死，此时你传入了 `exitCode: 0` 给 `detectFailure`。假设真实子进程是 OOM crash (exitCode 137)，只打印了部分 `assistantTexts` 就死了，没有打出 `resultEvent`。此时传 `0` 绕过了 Layer 1 非零报错，且因为 `hasText` 为真，Layer 5 (`!hasText && !hasResult`) 也不会拦截。最终 `detectFailure` 会返回 `{ failed: false }`。
   - **修正建议:** 对于 `ESRCH` 且无明确 exit code 的情况，**必须强校验** `parsed.resultEvent` 是否存在，不存在即视为 `failed (incomplete_stream)`。

## P1: 维护性 (Maintainability)
- **`job-control.mjs` Dead Code 列表:**
  - `runJobInBackground` / `runWorker`: 被 companion 的 `spawnQwenProcess` 替代。
  - `createJob` / `cancelJob`: companion 内部直接 `cancelJobPgid` 和构造 object。
  - `buildStatusSnapshot` / `resolve...`: companion 内部直接 filter array。
- **文档补充 (`commands/status.md` 等):**
  - 后台 Finalize 的 Lazy 机制对用户不可见，建议在 doc 中补丁：
    `> **Note**: Background jobs are lazily finalized. If a job runs in the background, its final log is parsed and status updated ONLY when you invoke \`/qwen:status\` or \`/qwen:result\`.`
- **Spec v3.1 修正:**
  - §4.4 / §4.6 应该明确写入 "bg job 依赖 status command 进行 lazy state reconciliation"。
- **FINDINGS 补充:**
  - F-11/F-16 没有覆盖此事。强烈建议新增 **F-17 Data Model Inconsistency**，记录 `id` vs `jobId` 字段割裂导致的持久化覆盖和游离文件 bug。

## P2: 测试 (Testing)
- **Background Finalize 新路径无覆盖**
  - **File:** `plugins/qwen/scripts/tests/integration.test.mjs` (或对应的新测例文件)
  - **Test Name:** "status command lazily finalizes dead background job via log parsing"
  - **Steps:**
    1. mock 环境下写入 fake log: `jobs/test-uuid.log` 包含 valid stream-json (init, assistant, result)。
    2. mock 写 `state.json` 包含 job: `{ jobId: "test-uuid", status: "running", pid: 99999, logFile: "jobs/test-uuid.log" }`。
    3. run `qwen-companion status test-uuid` (通过 `runStatus(["test-uuid"])`)。
    4. assert output 中状态变为 `completed`。
    5. assert `state.json` 中该 job 被成功更新为 `completed` 并包含 `result` 字段。
  - **What to mock:**
    - `process.kill(99999, 0)` mock 为 throw error `{ code: "ESRCH" }`。
    - mock 隔离的 `CWD` / `fs` 目录避免污染。