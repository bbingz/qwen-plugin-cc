# qwen-plugin-cc — Working directory context

## Project type

Claude Code plugin wrapping Qwen Code CLI(独立 git 仓库)。**v0.1.2 已发布**:
- GitHub: https://github.com/bbingz/qwen-plugin-cc(public)
- Tags: v0.1.0, v0.1.1, v0.1.2
- 113 unit + 3 integ tests 全绿
- 7 slash commands 真机验证

## Key paths

- **Spec(部分过时)**:`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-design.md` v3.1 — 以 FINDINGS.md 为准
- **Plan archive**:`docs/superpowers/plans/2026-04-20-qwen-plugin-cc-implementation.md`
- **Phase 0 实测发现(MUST READ)**:`doc/probe/FINDINGS.md` — 17 条真实 qwen 行为 F-1..F-17
- **Review archives**:`doc/review-v010-*.md`(v0.1.0 4-way)+ `doc/review-v011-*.md`(v0.1.1 5-way,Kimi 无报告)
- **Companion 核心**:`plugins/qwen/scripts/qwen-companion.mjs` + `plugins/qwen/scripts/lib/qwen.mjs`
- **bg job finalize**:`plugins/qwen/scripts/lib/job-lifecycle.mjs::refreshJobLiveness`(v0.1.2:tail-only log 读)
- **Workspace root 共享**:`lib/git.mjs::resolveWorkspaceRoot`(v0.1.2 新加 — companion + hooks 统一用)
- **Tests**:`plugins/qwen/scripts/tests/*.test.mjs`

## Branch

- `main`(tracked to origin,已推 GitHub)
- `phase-1-setup`(archived;已 merge via 08d09ac no-ff,本地保留)

## Conventions

- **FINDINGS 权威 > spec**:spec v3.1 有章节过时(§3.3 bg auto-edit、§4.6 job schema),改代码前查 FINDINGS
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
- **F-17**:`id`(gemini)vs `jobId`(qwen)字段割裂,state.mjs 兼容 `j.jobId ?? j.id`

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

## v0.2 backlog

见 `~/.claude/projects/-Users-bing--Code--qwen-plugin-cc/memory/pending-after-compact.md`。优先级:correctness(retry appendSystem / tryLocalRepair truncation)> DX(ajv / bg stderr 透传)> docs sync(spec §3.3/§4.6)> maintenance(id→jobId 完整迁移)。
