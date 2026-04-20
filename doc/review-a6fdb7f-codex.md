# Review of `a6fdb7f`

## P0

1. **`state.mjs::upsertJob` 仍然按 `id` 键控，但本次修复路径写入的是 `jobId`-only 记录，多个 qwen job 仍会互相覆盖并触发错误清理。**  
   证据：`plugins/qwen/scripts/qwen-companion.mjs:211-236` 组装并写入的 `jobMeta` 只有 `jobId`，没有 `id`；`plugins/qwen/scripts/lib/state.mjs:189-201` 的 `upsertJob()` 仍用 `j.id === jobPatch.id` 定位记录。对第二个 qwen job 来说，`jobPatch.id` 仍是 `undefined`，会命中第一个同样没有 `id` 的 qwen 记录并覆盖它。随后 `plugins/qwen/scripts/lib/state.mjs:158-167` 的 `cleanupOrphanedFiles()` 只会保留最新一条 `jobId` 对应的 `jobs/<id>.json|log`，旧 job 文件会再次被当作 orphan 删除。B-3 的 `j.jobId ?? j.id` 修补了文件名匹配，但没有修补 state 主索引。

2. **后台任务的 finalize 现在只挂在 `status` 上，`/qwen:result` 和 SessionEnd 都不会触发它，导致已结束的后台任务仍可能没有结果文件，甚至在会话结束时被直接删掉。**  
   证据：`plugins/qwen/scripts/qwen-companion.mjs:238-242` 的 background 分支在 `upsertJob()` 后立即 `process.exit(0)`，这里不会 `writeJobFile()`；真正把 log 解析成最终 payload 并落 `jobs/<id>.json` 的逻辑只在 `runStatus()` 里的 `refreshJobLiveness()`，见 `plugins/qwen/scripts/qwen-companion.mjs:361-390`。但 `runResult()` 只会“读 job file；没有就回退到 state.json”，不会做 liveness refresh，见 `plugins/qwen/scripts/qwen-companion.mjs:443-455`。同时 `plugins/qwen/scripts/session-lifecycle-hook.mjs:65-86` 会在 SessionEnd 把当前 session 的 job 从 state 里整体移除；`plugins/qwen/scripts/lib/state.mjs:93-99,158-167` 会在 `saveState()` 时顺带删掉这些 job 的文件。结果是：用户如果没有先跑 `/qwen:status <jobId>`，`/qwen:result <jobId>` 仍拿不到最终结果；如果直接结束 session，这个后台 job 的状态和 log 还会被清掉。

3. **`refreshJobLiveness()` 把后台进程的真实退出码硬编码成 `0`，会把“非零退出但留下部分输出”的后台失败误判成成功。**  
   证据：`plugins/qwen/scripts/qwen-companion.mjs:373-388` 在 ESRCH finalize 路径中调用 `detectFailure({ exitCode: 0, ... })`；`plugins/qwen/scripts/lib/qwen.mjs:288-311` 的 `detectFailure()` 只有在 `exitCode !== 0` 时才会走第 1 层 `kind: "exit"`。一旦真实子进程是非零退出，但 log 里已经有 `assistantTexts` 或 `resultEvent.result`，这里就会绕过 exit 判错并落成 `status: "completed"`。

## P1

1. **`stop-review-gate-hook` 读取的是未经 refresh 的原始 state，lazy finalize 下会把已结束的后台任务继续当成 running。**  
   证据：`plugins/qwen/scripts/stop-review-gate-hook.mjs:156-160` 直接对 `listJobs(workspaceRoot)` 做 `find((job) => job.status === "queued" || job.status === "running")`；它没有任何与 `plugins/qwen/scripts/qwen-companion.mjs:361-390` 类似的 liveness/finalize 逻辑。由于本次提交把后台 finalize 挪到了 `status` 调用里，stop hook 在用户未先跑 `/qwen:status` 时会持续看到陈旧的 `running` 记录。

2. **`stop-review-gate-hook` 仍然用 `runningJob.id` 生成提示语，但 qwen 任务记录用的是 `jobId`。**  
   证据：提示文案在 `plugins/qwen/scripts/stop-review-gate-hook.mjs:159` 使用的是 ``${runningJob.id}``；而 qwen companion 写 job 和查 job 都使用 `jobId`，见 `plugins/qwen/scripts/qwen-companion.mjs:211-218,313-316,405-408`。实际效果会是提示里出现 `Qwen task undefined is still running`，并给出 `/qwen:cancel undefined` 这样的错误指令。

## P2

1. **设计文档还在描述旧的 background streaming 架构，和本次提交后的实现不一致。**  
   证据：`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-design.md:252-256` 仍写的是 background 分支“边解析 stream-json 边判错… `child.unref(); companion 退出;/qwen:status 看后续`”。当前实现实际上是在 `plugins/qwen/scripts/qwen-companion.mjs:220-242` 里把 stdout/stderr 直接重定向到 log file，然后在 `runStatus()` 里被动 finalize。

2. **`doc/probe/FINDINGS.md` 仍保留已经被本提交删除的 dead-code 结论。**  
   证据：`doc/probe/FINDINGS.md:71-86` 的 F-12 仍写着 `job-control.mjs` 按 `callQwenStreaming` 契约消费，且“当前 `qwen.mjs` 有占位 throw 的 export”。但本提交已经删除 `plugins/qwen/scripts/lib/job-control.mjs` 中对 `callQwenStreaming` 的 import 和 `runStreamingWorker` 相关逻辑，也删除了 `plugins/qwen/scripts/lib/qwen.mjs` 中的 placeholder export。

## Verification

1. Ran `git log --oneline -5 && git show a6fdb7f --stat`.
2. Ran `git show a6fdb7f -- plugins/qwen/scripts/lib/state.mjs plugins/qwen/scripts/qwen-companion.mjs`.
3. Read current `plugins/qwen/scripts/lib/job-control.mjs`, `plugins/qwen/scripts/session-lifecycle-hook.mjs`, `plugins/qwen/scripts/stop-review-gate-hook.mjs`, plus supporting code in `plugins/qwen/scripts/lib/qwen.mjs`, `plugins/qwen/scripts/lib/state.mjs`, and the two docs above.
4. Ran `node --test plugins/qwen/scripts/tests/*.test.mjs 2>&1 | tail -20` and observed `84` passing tests, `0` failures.

## Remaining Risk

1. The shipped test suite is green, but the reviewed code paths above are mostly cross-command lifecycle paths (`task --background` -> `status` / `result` / `SessionEnd` / `Stop`); the current test run does not exercise those end-to-end transitions.
