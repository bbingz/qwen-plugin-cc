# qwen-plugin-cc — Working directory context

## Project type

Claude Code plugin wrapping Qwen Code CLI(独立 git 仓库,非 monorepo)。

## Key paths

- **Authoritative spec**:`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-design.md` v3.1
- **Plan(task-by-task)**:`docs/superpowers/plans/2026-04-20-qwen-plugin-cc-implementation.md`
- **Phase 0 实测发现(MUST READ)**:`doc/probe/FINDINGS.md` — 14 条与 spec 不一致的真实 qwen 行为
- **Companion 核心**:`plugins/qwen/scripts/qwen-companion.mjs` + `plugins/qwen/scripts/lib/qwen.mjs`
- **Tests**:`plugins/qwen/scripts/tests/*.test.mjs`(63 tests 全绿截至 Phase 2)

## Branch strategy

- `main`:spec 稳定节点
- `phase-1-setup`(名字已不准):当前含 Phase 1 + Phase 2 的 34 commits,未 merge 回 main
- Phase 3 仍在此 branch 上继续;完成后一次 merge(或重命名为 `phase-1-to-3`)

## Conventions

- **Spec 是权威**:spec 和代码冲突时,先确认 spec 是否过时;多数情况下改 spec(不改代码)或按 FINDINGS 记录真实行为。
- **qwen.mjs 从零写**,其他 lib 是 gemini v0.5.2 血统 + 常量剥离。
- **测试跑法**:`node --test plugins/qwen/scripts/tests/*.test.mjs`(glob,别用目录;F 已确认 node --test 对目录扫描有问题)
- **Commit before claiming done**:每个 task 完成后 commit 一次,不累积。

## Gotchas(Phase 0–2 实测)

- `qwen --version` 输出**裸版本号** `0.14.5`(F-1/F-1b);探活用 `--version`,不是 `-V`
- qwen `[API Error: NNN ...]` 无 "Status:" 字样(F-2);`classifyApiError` 优先匹配 `\[API Error:\s*(\d{3})\b`
- 默认模型 `qwen3.5-plus`(qwen3.6-plus 要 Pro)(F-3)
- `auto-edit` + 无 TTY = auto-deny shell tools(F-4);**不 hang**,有 `permissionDenials[]` 字段
- settings.json 多无 proxy 字段(F-5);buildSpawnEnv 是防御层
- assistant 事件 `content[]` 有 `thinking` 块要跳过(F-6)
- session-id / -r 强校验 UUID(F-7);jobId 用 `crypto.randomUUID()`
- `no_prior_session` 触发 = stderr `/No saved session found with ID/i`(F-8)
- auth 走 `settings.json::env.BAILIAN_CODING_PLAN_API_KEY`,不是 oauth_creds.json(F-9)
- gemini state.mjs API:`writeJobFile(cwd, jobId, payload)` 三参数;`listJobs` 从 state.json 读;主路径用 `upsertJob`(F-11)
- args.mjs 返 `{options, positionals}`(复数);配置键 `valueOptions`(F-14)
- bg + auto-edit(无 unsafe)**允许跑**,仅 bg + 显式 yolo + !unsafe 才 `require_interactive`(F-13)

## Pending

- **UI 手测**(用户做,我代不了):
  - Phase 1:T1 `claude plugins add ./plugins/qwen` / T2 `/qwen:setup`
  - Phase 2:T4 `/qwen:rescue --wait` / T5 `/qwen:rescue --background --unsafe` + `/qwen:status` / T5' 拒 require_interactive / T8 cancel / T11 撤 token 后 `not_authenticated` / T13 `--resume <伪 UUID>` 的 `no_prior_session`
- Phase 3 Review 系:9 tasks(schema + prompts + `reviewWithRetry` 3 轮 + `tryLocalRepair` + /qwen:review + /qwen:adversarial-review)
