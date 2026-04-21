# qwen-plugin-cc — Working directory context

## Project type

Claude Code plugin wrapping Qwen Code CLI(独立 git 仓库)。**v0.2.1 已发布**:
- GitHub: https://github.com/bbingz/qwen-plugin-cc(public)
- Tags: v0.1.0, v0.1.1, v0.1.2, v0.2.0, v0.2.1
- 224 tests 全绿(env 已隔离,无需 env -u)
- 7 slash commands 真机验证
- 6-way review 能力成熟(Claude/Codex/Gemini/Qwen/Kimi/MiniMax 全参与)

## Key paths

- **Spec(部分过时)**:`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-design.md` v3.1 — 以 FINDINGS.md 为准
- **Plan archive**:`docs/superpowers/plans/2026-04-20-qwen-plugin-cc-implementation.md`
- **Phase 0 实测发现(MUST READ)**:`doc/probe/FINDINGS.md` — 17 条真实 qwen 行为 F-1..F-17
- **Review archives**:`doc/review-v010-*.md`(v0.1.0 4-way)+ `doc/review-v011-*.md`(v0.1.2 5-way,Kimi 无报告)+ `doc/review-v02-*.md`(v0.2.0 **6-way 含 MiniMax 首跑**)
- **Companion 核心**:`plugins/qwen/scripts/qwen-companion.mjs` + `plugins/qwen/scripts/lib/qwen.mjs`
- **bg job finalize**:`plugins/qwen/scripts/lib/job-lifecycle.mjs::refreshJobLiveness`(v0.1.2:tail-only log 读)
- **Workspace root 共享**:`lib/git.mjs::resolveWorkspaceRoot`(v0.1.2 新加 — companion + hooks 统一用)
- **Review schema validator**:`lib/review-validate.mjs`(v0.2,零依赖,支持 type/enum/required/additionalProperties/minLength/min-max/items 递归)
- **Tests**:`plugins/qwen/scripts/tests/*.test.mjs`

## Branch

- `main`(tracked to origin,已推 GitHub)
- `phase-1-setup`(archived;已 merge via 08d09ac no-ff,本地保留)

## Conventions

- **FINDINGS 权威 > spec**:spec v3.1 §3.3/§4.6 已在 v0.2 同步到实现,其余仍以 FINDINGS 为准
- **qwen.mjs 从零写**,其他 lib 是 gemini v0.5.2 血统 + 常量剥离
- **测试跑法**:`node --test plugins/qwen/scripts/tests/*.test.mjs`(glob,别用目录)
- **Commit 粒度**:每个 task 一次,不累积;安全/hotfix 单独 tag

## Gotchas(F-1..F-17 简要)

- `qwen --version` 输出**裸版本号** `0.14.5`(F-1/F-1b)
- `[API Error: NNN ...]` 无 "Status:" 字样(F-2);优先正则 `\[API Error:\s*(\d{3})\b`
- 默认模型 `qwen3.5-plus`(F-3);plugin 不硬编码
- `auto-edit` + 无 TTY = auto-deny shell tools(F-4),不 hang,有 `permissionDenials[]`
- settings.json 多无 proxy 字段(F-5)
- assistant `content[]` 跳 `thinking`,只收 `text`(F-6)
- `--session-id` / `-r` 强校验 UUID(F-7);plugin 层已在 v0.1.1 预校(`invalid_session_id`)
- `no_prior_session` = stderr `/No saved session found with ID/i`(F-8)
- auth 走 settings.json::env.BAILIAN_CODING_PLAN_API_KEY(F-9)
- state.mjs 主 API:`writeJobFile(cwd, jobId, payload)` + `upsertJob`(F-11)
- args.mjs 返 `{options, positionals}`(F-14)
- bg + auto-edit(无 unsafe)**允许**,bg + 显式 yolo + !unsafe 才 `require_interactive`(F-13)
- **F-17**:`id`(gemini)vs `jobId`(qwen)字段割裂 — v0.2 已统一 `jobId`,`loadState` 对 legacy `id` migrate-on-read

## v0.1.1 security hotfix 约束

- `buildSpawnEnv`:env 白名单继承,不再泄漏 parent 凭据。扩展用 `QWEN_PLUGIN_ENV_ALLOW="K1,K2"`
- `cancelJobPgid`:pre-kill probe + `ps -g <pgid>` verify,防 pgid 回收误杀
- `/qwen:review` 默认 `auto-edit`,加 `--unsafe` 才 yolo

## v0.1.2 hotfix 约束(5-way review 挖出的 7 P0)

- **hooks session filter**:`job.sessionId` 是 qwen UUID,**不是** CC session id;hooks 按 `job.claudeSessionId` 筛(companion 启动时从 `PARENT_SESSION_ENV` 持久化)
- **`--resume-last` 发 `-c`**:`runTask` 里 `resumeLast === true` 时 sessionId 必须 unset,否则 buildQwenArgs 优先 `--session-id` 发不出 `-c`
- **`updateState` 锁策略**:耗尽 10 次重试**抛 `StateLockTimeoutError`**,不再降级无锁;`saveState` 用 temp + rename 原子写
- **`stop-review-gate hook`**:不传 `--json`,直接按 stdout 里 `ALLOW:/BLOCK:` 扫全部行(companion `task` 从不产 JSON envelope)
- **bg spawn 错误**:`spawn` 后 `child.pid == null` 必须 async 探测 error 立即标 `failed`,不能留僵尸 running
- **cwd 归一**:companion 所有 sub-command + 两个 hook 必须用 `resolveWorkspaceRoot(process.cwd())`(在 `lib/git.mjs`),不能裸用 `process.cwd()`
- **`refreshJobLiveness` log 读**:`readLogTail` 只读末 1MB(常量 `LOG_TAIL_BYTES`)— 防 CC 主进程被大 log 阻塞

## v0.2.1 hotfix 约束(6-way review 6 P0 + 14 P1,**不要重报**)

- **PID/pgid verify 精确 basename**:`isQwenCommandLine(text)` (`/(^|\/)qwen(\s|$)/m`),3 处对齐(lib/qwen.mjs / lib/job-lifecycle.mjs / stop-review-gate-hook.mjs)。`/qwen/i` substring 在 workspace `qwen-plugin-cc` 恒真的 bug。
- **runSetup cwd 归一**:companion line 72 + 131 `resolveWorkspaceRoot(process.cwd())`,对齐 v0.1.2。
- **review secret 过滤**:`collectWorkingTreeContext` 用 git `:(exclude)<path>` pathspec 对 staged + unstaged + untracked 三路径全覆盖。
- **tool_use fallback**:`b.input ?? b.tool_input ?? null`(qwen 可能用 tool_input)。
- **validateReviewOutput.additionalProperties**:独立于 properties,allowed 源自 `properties ?? {}`。
- **upsertJob 双写 id**:`{ ...patch, id: patch.id ?? patch.jobId }` 过渡期兼容 rollback。v0.3+ 清理前保留。
- **SENSITIVE_KEY_RE word boundary**:key regex `(^|[_\- ])...([_\- ]|$)`,不误伤 author/authorization。value `Bearer` 正则支持中间匹配 + 限 10+ 字符。
- **Secret pattern 扩充**:加 sk_live/sk_test (Stripe)、AIza (Google)、JWT 三段;.env.example/sample/template/tmpl/dist 放过;云 CLI(.git-credentials/azure-credentials/gcloud/docker/terraform)已纳入。
- **cleanupSessionJobs fallback false**:无 claudeSessionId 的 legacy job 不认归属,等懒 finalize(不再跨 CC 误杀)。
- **cleanupOrphanedFiles mtime 陈旧门槛**:`ORPHAN_STALE_MS = 60_000`,新建文件(openSync→upsertJob 窗口内)不被并发 saveState 误删。
- **F-8 bg finalize 路径**:`!parsed.resultEvent` 分支先跑 detectFailure 带 stderr,未命中再 fallback incomplete_stream。
- **streamQwenOutput resolve**:`delete state.buffer` 不泄漏内部游标。
- **runCancel exit code**:0=真 cancel / 3=not_found/no_pgid / 4=已终态 no-op / 5=signal failed。
- **integration test env**:`cleanEnv()` 白名单,无需外部 `env -u` 清污。

## v0.2 改动清单(24 项全解,**不要重报**)

**correctness**:
- `reviewWithRetry` retry 轮用 `buildReviewAppendSystem(schemaText)` 塞 `--append-system-prompt`(不是 null)
- `tryLocalRepair` Step 5 string-aware 扫 bracket(跳 string 内 `{}/\\`),未闭合 string 先补 `"` 再补 brace
- companion `runQwen` 闭包读 `opts.useResumeSession` → `resumeLast: true` → `-c` 续 session
- `refreshJobLiveness` 加 `defaultVerifyPidIsQwen`(`ps -p <pid>`),PID 复用保守视为活

**security/redact**:
- `isLikelySecretFile(filename)`(lib/git.mjs)13 条 regex:`.env*/.envrc/credentials/.aws/credentials/.npmrc/.pypirc/.netrc/id_{rsa,ed25519,...}/*.{pem,key,p12,pfx,jks,keystore}/secrets*/.kdbx`。`formatUntrackedFiles` 标 skipped;`getUntrackedFilesDiff` 静默跳过
- `ENV_ALLOW_EXACT` 不含 `NODE_OPTIONS`;要透传:`QWEN_PLUGIN_ENV_ALLOW="NODE_OPTIONS"`
- `session-lifecycle-hook.terminateJob` 改调 `cancelJobPgid(job.pgid ?? job.pid)`,不再自写 `process.kill(-pid,SIGTERM)`
- `parseAssistantContent(blocks)`:text/tool_use/tool_result 分收,image 只计数不存 base64。三处 parser(`runQwenPing/streamQwenOutput/parseStreamEvents`)全 wire;返回字段 `toolUses/toolResults/imageCount`
- `detectFailure` 层 0(早于 exit 层):`stderr` 匹配 `/No saved session found/i` → `kind:"no_prior_session"`。companion 传 `streamResult.stderrTail`,`streamQwenOutput` 新收 stderr 4KB 滚窗
- `normalizePermissionDenials(list)`(lib/qwen.mjs):key 敏感(`api_key/token/secret/password/credential/auth/bearer/session_id`)→ `[REDACTED]`;value 匹配 Bearer/sk-/ghp_/github_pat_/AKIA/xox[baprs]- → `[REDACTED]`

**DX/UX**:
- `lib/review-validate.mjs`:零依赖,type/enum/required/additionalProperties/minLength/min/max/items 递归(取代 companion 里 20 行 inline stub)
- `extractStderrFromLog(logText, maxLines=20)`:bg logFile 里非 `{` 开头的尾 20 行 → `failure.detail`
- `runCancel` 用 `emit(payload, humanText, exitCode)` 分流 `--json` / 人话;已 completed job exit 0 + `"Job X is already <status>, nothing to cancel."`
- `rescue.md`:argument-hint + 4 处 `--resume` → `--resume-last`;新 "Long-running tasks" 节提示 Bash 2min 默认 timeout

**docs**:
- spec §3.3:bg+auto-edit(无 --unsafe)**允许**;只有 bg+显式 yolo+!unsafe 才 require_interactive
- spec §4.6 job schema:`logFile`(不是 logPath)+ 删 `phase` + 补 `claudeSessionId`
- plan.md 274 `- [ ]` 全打 [x]

**maintenance**:
- 删 `lib/render.mjs`(死代码,依赖不存在 timing.mjs)
- 删 `state.mjs::generateJobId`(qwen 全用 `randomUUID()`)
- 8 处 `j.jobId ?? j.id` coalesce 全删;`loadState` migrate-on-read 处理 legacy `id` 字段
- `readJsonl` 坏行计数后 stderr warn;`runTaskResumeCandidate` catch 也 stderr warn
- 新单测:`qwen-args.test.mjs` 18 / `qwen-prompts.test.mjs` 7 / `qwen-session-lifecycle-hook.test.mjs` 3 / `qwen-secret-denylist.test.mjs` 4 / `qwen-permission-denials.test.mjs` 9 / `qwen-review-validate.test.mjs` 13

**测试:`node --test plugins/qwen/scripts/tests/*.test.mjs` → 190 pass / 0 fail(clean env;`QWEN_COMPANION_SESSION_ID` 若被泄漏需 `env -u` 清)**
