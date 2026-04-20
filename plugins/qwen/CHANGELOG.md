# Changelog

## 0.1.0 (unreleased)

- **Phase 3 完成**(9 tasks + 13 新测试 + 5 次 review 抽样 0% schema_violation;累计 76 tests 全绿)
  - `schemas/review-output.schema.json` 字节复制 codex(verdict enum: approve / needs-attention)
  - `prompts/{stop-review-gate, adversarial-review}.md` 从 codex 改字样
  - qwen.mjs 新增:`tryLocalRepair`(fence/prose/bracket/尾逗号修复)、`buildInitialReviewPrompt`、`buildReviewRetryPrompt`(携原 raw + ajv 错误 + final marker)、`reviewWithRetry`(3 轮:parse → tryLocalRepair → retry with context)
  - companion 新增 `review` / `adversarial-review` 子命令(集成 git diff + reviewWithRetry + 简易 validator)
  - commands: `/qwen:review` + `/qwen:adversarial-review`
  - 新发现 F-15:`collectReviewContext(cwd, opts)` 两参数,返字段 `content`(不是 diff)
  - Spike buffer:跳过(5/5 样本全过,稳定性验证通过)
- **Phase 2 完成**(18 code tasks + 46 unit tests + 2 真机 smoke;累计 63 tests 全绿)
  - `scripts/lib/{git,state,render,prompts,job-control}.mjs`:从 gemini v0.5.2 血统字节拷贝 + `state`/`render`/`prompts`/`job-control` 做常量剥离(GEMINI→QWEN)
  - qwen.mjs 新增导出:`classifyApiError`(F-2 qwen 格式 `[API Error: NNN]` 优先 + DashScope 特化 + `\b` 边界)、`detectFailure`(五层 + `empty_output` 保护)、`parseStreamEvents`(F-6 跳 thinking)、`buildQwenArgs`(`--unsafe` gate + `require_interactive`)、`spawnQwenProcess`(detached + fg/bg unref 分支)、`streamQwenOutput`(bg 命中 API Error 即 SIGTERM + 等 exit/500ms)、`cancelJobPgid`(SIGINT→TERM→KILL + ESRCH 吞 + `cancel_failed`)
  - companion 新增子命令:`task` / `task-resume-candidate` / `cancel`
  - skills: `qwen-cli-runtime`、`qwen-prompting`(+ 3 references)、`qwen-result-handling`
  - agent: `qwen-rescue.md`(subagent_type=qwen:qwen-rescue,薄转发器)
  - command: `/qwen:rescue` + 自救引导
  - Phase 2 新发现:F-11(gemini state API 三参数)、F-12(callGeminiStreaming 签名)、F-13(bg+auto-edit 允许)、F-14(args.mjs `positionals`/`valueOptions`)
- **Phase 1 完成**(11 code tasks + 17 unit tests 全绿)
  - marketplace.json + plugin.json manifest
  - `scripts/lib/{args,process,qwen}.mjs`(args/process 字节拷自 gemini v0.5.2;qwen.mjs 新写)
  - qwen.mjs 导出:`getQwenAvailability`(F-1 `--version`)、`buildSpawnEnv`(proxy 四键 + 冲突检测 + NO_PROXY merge)、`readQwenSettings`、`parseAuthStatusText`(4 种 mode + fallback)、`detectInstallers`、`runQwenPing`(F-6 跳 thinking)、`QWEN_BIN`、`CompanionError`
  - `scripts/qwen-companion.mjs`:setup 子命令 dispatcher(JSON + 文本两模式)
  - `commands/setup.md`:/qwen:setup 命令 frontmatter
- Phase 1 发现 F-1b:`qwen --version` 输出裸版本号 `0.14.5`(见 `doc/probe/FINDINGS.md`)
