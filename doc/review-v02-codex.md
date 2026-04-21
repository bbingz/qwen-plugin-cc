# Qwen Plugin v0.2.0 Review (Codex)

## P0 — Must fix (correctness/security/race)

### [P0] SessionEnd 仍可能误杀已回收给其他 Qwen 进程组的 stale pgid
**File**: `plugins/qwen/scripts/session-lifecycle-hook.mjs:76`, `plugins/qwen/scripts/lib/qwen.mjs:705`
**Finding**: `cleanupSessionJobs()` 先调用 `refreshJobLiveness()`，但随后无条件对旧 `job` 继续 `terminateJob()`。如果原 job 已经结束、`refreshJobLiveness()` 刚把它 finalize 掉，而该数值 pgid 又已被 OS 回收给另一个 Qwen 进程组，那么 `cancelJobPgid()` 的校验仍会通过，因为它只检查 `ps -g <pgid>` 输出里是否含有 `/qwen/i`，并不校验这是同一个 pid / session / job。结果是 SessionEnd 会向无关的新 Qwen 进程组发送 `SIGINT`/`SIGTERM`/`SIGKILL`。
**Repro / evidence**: `session-lifecycle-hook.mjs:76-78` 丢弃了 `refreshJobLiveness()` 的返回值，始终对原始 `job` 调 `terminateJob(job)`；而 `cancelJobPgid()` 在 `qwen.mjs:705-729` 只做“当前 pgid 下是否还有某个 qwen 命令”的弱校验。只要 stale pgid 恰好被另一个 Qwen CLI 复用，这个检查就会把错误对象当成合法目标。
**Recommendation**: `refreshJobLiveness()` 后使用返回值重新判定，若状态已不再是 `running`/`queued` 就直接跳过 kill。额外把校验从“命令行含 qwen”升级为“匹配原始 pid / sessionId / jobId”，否则 pgid 复用只被缩小为“误杀其他 Qwen”，没有真正消除。
---

## P1 — Important

### [P1] `cleanupOrphanedFiles()` 仍会删掉锁外新建的 log/job 文件，后台任务可被错误打成 orphan
**File**: `plugins/qwen/scripts/lib/state.mjs:102`, `plugins/qwen/scripts/qwen-companion.mjs:235`
**Finding**: v0.2 去掉了“锁超时后无锁写 state”的路径，但 `saveState()` 仍会在持锁写 `state.json` 之前按当前 `state.jobs` 执行 `cleanupOrphanedFiles()`。与此同时，后台任务的 `.log` 文件、以及完成态的 `jobs/<id>.json` 文件，都是在拿 state 锁之前先写到磁盘，再调用 `upsertJob()`。这留下了一个仍然存在的数据竞争窗口：另一个并发 writer 只要在 `upsertJob()` 前完成一次 `saveState()`，就会把这些刚创建但尚未登记到 `state.jobs` 的文件当 orphan 删掉。
**Repro / evidence**: `qwen-companion.mjs:235-239` 先 `openSync(<jobId>.log)`，直到 `273` 才 `upsertJob(cwd, jobMeta)`；`state.mjs:102-112` 的 `saveState()` 会先跑 `cleanupOrphanedFiles()`，而 `175-183` 仅凭 `state.jobs` 中的 `jobId` 判断存废。若并发命中这个窗口，`<jobId>.log` 会被 unlink；子进程继续写向已解绑的 fd，后续 `refreshJobLiveness()` 在 `job-lifecycle.mjs:99-145` 看不到 log 文件，只能把任务标记为 `orphan` / `failed`。同样的窗口也存在于 `writeJobFile(...); upsertJob(...)` 的完成态持久化顺序。
**Recommendation**: 把“创建/更新 artifact 文件”和“把 jobId 写入 state”放进同一个受锁事务，或至少让 `cleanupOrphanedFiles()` 只清理经二次确认的陈旧文件，不要清理刚创建、尚未完成 state 注册的 `.log` / `.json`。
---

## P2 / Nit

### [P2] F-8 的 `no_prior_session` 修复没有打通后台 finalize 路径
**File**: `plugins/qwen/scripts/lib/job-lifecycle.mjs:102`, `plugins/qwen/scripts/lib/qwen.mjs:417`
**Finding**: `detectFailure()` 新增了基于 `stderr` 的 layer-0 `no_prior_session` 识别，但 `refreshJobLiveness()` 只有在 `parsed.resultEvent` 存在时才调用 `detectFailure()`；一旦没有 `resultEvent`，就直接硬编码成 `incomplete_stream`。这与 `FINDINGS.md` 的 F-8 不一致：F-8 明确指出“无 prior session”的可依赖信号就是 stderr 文本本身。
**Repro / evidence**: `job-lifecycle.mjs:106-115` 在 `!parsed.resultEvent` 时直接构造 `{ kind: "incomplete_stream" }`，`qwen.mjs:417-421` 的 `stderr` 正则根本走不到。按 F-8，`qwen -r <不存在 UUID>` 的真实行为是 stderr 输出 `No saved session found ...`；这类后台 stderr-only 失败在当前实现里不会得到 `kind: "no_prior_session"`。
**Recommendation**: 在 `!parsed.resultEvent` 分支里也先对 `extractStderrFromLog(logText)` 跑一次 `detectFailure()`，只有确实未命中任何已知错误时才退回 `incomplete_stream`。
---

## 结语
本次 diff 我确认了 1 个 P0、1 个 P1、1 个 P2。最严重的问题仍然在进程组生命周期边界：SessionEnd 新接入 `cancelJobPgid()` 后，只是把“误杀任意进程”收窄成了“仍可能误杀别的 Qwen 进程”，风险没有被彻底消掉。其次，state 锁修复只覆盖了 `state.json` 本身，没有覆盖锁外创建的 log/job artifacts，所以并发下仍可能把正常后台任务打成 orphan。最后，F-8 的 `no_prior_session` 修复只覆盖前台路径，后台 finalize 仍然会把它吞成泛化的 `incomplete_stream`。
