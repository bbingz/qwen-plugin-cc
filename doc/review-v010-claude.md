# Review of qwen-plugin-cc v0.1.0 — Claude perspective (UX/DX + 默认行为合理性 + 维护性 + real-world gap)

**Scope**: branch `main`, HEAD `08d09ac`, v0.1.0 tag `5295c0b`
**Focus**(跟 Codex/Gemini/Qwen 错开):不挖 race/drift/qwen 行为假设,挖"用户真用起来会不会踩坑"。

---

## P0 (ship-blocking or user-visible breakage)

### P0-1 review 子命令默认跑 yolo,无 --unsafe 门禁
`plugins/qwen/scripts/qwen-companion.mjs:515` — `runReview` 里 `buildQwenArgs({ unsafeFlag: true, background: false, ... })` 硬编 `unsafeFlag: true`。rescue 有 `bg+yolo` 的 `require_interactive` 门禁,但 review 无条件 yolo。用户跑 `/qwen:review` 时 qwen 可以执行任意 shell / write 工具(review 默认"纯读"的假设不成立 — qwen 可能决定要 `cat some/file.bin` 或更糟)。应该改默认 `auto-edit`,加 `--unsafe` 才切 yolo;或者加 `allowed-tools` 白名单(只允许 read/grep/glob 系)。

### P0-2 review 的 validate 不是真 ajv,enum/required 之外一切放过
`plugins/qwen/scripts/qwen-companion.mjs:498-511` — validate 只查 `required` + `verdict enum`。review-output.schema.json 里 `findings[].severity`(enum: info/low/medium/high/critical)、`confidence`(number 0-1)、`line_start`(integer)全不校验。qwen 返 `severity: "oh no"` 或 `confidence: "high"` 都算 pass。最坏:用户看到 severity 错类把 critical 当 low 忽略了。commit 里自己写了注释 `(v0.2 可升级为真 ajv;当前避免外部依赖)`,是知道的技术债,但没进 lessons.md 也没进 TODO tracker。

### P0-3 cancel 对 completed 的 job 返 exit 0 + ok:false,output rule 冲突
`qwen-companion.mjs:325-328` — `job.status !== "running"` 时 exit 0 + 打 `{ok:false, reason:"job is completed, not running"}`。但 `commands/cancel.md` 里只处理 `kind: cancel_failed`,这种 "already done" 分支没告诉 Claude 怎么渲染。用户取消一个已完成的 job 会看到 Claude 原样粘贴 JSON,体验别扭。应该 exit 0 + 打 human text("Job already completed, nothing to cancel") 或 exit 4 标明新 kind。

### P0-4 bg + no TTY 的 API key 失败完全隐身
`qwen-companion.mjs::runTask` bg 分支 spawn 后立即 exit 0,不检查 child 是否在启动瞬间就因为 `API key missing` / `settings.json 损坏` 死掉。用户会看到 "Job queued: <uuid>",然后 `/qwen:status` 永远显示 running 或 orphan,log file 有 qwen 的 stderr error 但 refreshJobLiveness 只看 stream-json 事件 — stderr-only 错误消息不会变成 `resultEvent`,导致 `incomplete_stream failed`(修了 a6fdb7f 后的那条路径),但 error message 不给用户看。修:refreshJobLiveness 的 incomplete_stream 分支里,把 log file 前 N 行(stderr 内容)放进 failure.detail。

---

## P1 (ship-acceptable but actively worsens DX)

### P1-1 `/qwen:rescue` 默认前台 + 无 timeout = Claude 会话挂死
`commands/rescue.md:21` — 默认 foreground。qwen 长时间任务(10+ min)会让 Claude 的 Bash tool 卡住(默认 2min timeout,会被 kill)。但命令 doc 没告诉用户要加 `--background --unsafe` 跑长任务。用户踩这个坑后不知道怎么恢复。修:`commands/rescue.md` 加一节 "When to use background" + 用户可见的 "如果 prompt 预计 >2min,请用 `--background --unsafe`"。

### P1-2 `/qwen:status` 列表模式和单 job 模式输出格式冲突
`qwen-companion.mjs:380-388` — 列表默认 markdown table,单 job 默认 JSON。`commands/status.md` 要 Claude 对列表渲染 table 但对单 job 打 JSON verbatim。状态信息(比如 permissionDenials 在列表里根本不可见,只在 JSON 里)。用户先跑 status list 看不到 permissionDenials,然后看不到 "Re-run with --unsafe" 提示。修:列表 markdown 加一个 ⚠ 列标注 "deniedN"。

### P1-3 `permissionDenials` 在 `runResult` markdown 模式才提示 --unsafe;JSON 模式无提示
`qwen-companion.mjs:443-451`:markdown 分支有 `提示:加 --unsafe 重跑`。但 `commands/result.md` 让 Claude 对 JSON 输出透传 verbatim — 用户看到 permissionDenials 数组但没 action hint。修:schema 或 commands/result.md 里让 Claude 在检测到非空 permissionDenials 主动 emit 提示(result.md 已有 "If you see this block, advise..." 语句,但 markdown 和 JSON 行为不一致)。

### P1-4 task-resume-candidate 只看 24 小时窗口 + 只看最新一个 task,对并发/多 worktree 用户不友好
`qwen-companion.mjs:291-299` — `jobs.find(j => j.kind === "task")` 拿数组第一条,没排序。如果用户先跑 task A 后跑 task B,state.json 顺序可能让 A 被当 latest。24h 窗口硬编,没 config 开关。修:按 `finishedAt ?? startedAt` desc 排序取头,常数抽到顶部。

### P1-5 setup --enable-review-gate 持久化到 state.json,但 state.json 是 per-workspace
用户在 workspace A 开 review-gate,切到 workspace B 没开。可能不是 bug(workspace-local 设计意图),但 doc 没说。`commands/setup.md` 没告诉用户这个 scope。修:setup.md 明确 "review-gate 是 workspace-local 设置"。

### P1-6 skills/qwen-cli-runtime 和 qwen-prompting 对 agent 暴露太多 internal API
我没检查过,但 `skills/qwen-cli-runtime/SKILL.md` 如果描述"如何直接调 companion subcommand",等于让 agent 绕过 slash command 做不受控事情。应检查。

### P1-7 没有 plugin 卸载/state 清理指引
用户想 uninstall qwen plugin,state 目录(`$TMPDIR/qwen-companion/<slug>-<hash>/` 或 `$CLAUDE_PLUGIN_DATA/state/<slug>/`)会留。README 没说怎么清。累积很多 job log 最终占磁盘。修:README 加一节 "Uninstall" 说明 state 路径和手动清理。

---

## P2 (maintenance / polish)

### P2-1 CHANGELOG 两份(root + plugins/qwen/)歧义
`CHANGELOG.md` 和 `plugins/qwen/CHANGELOG.md`。对外发布时用户看哪个?我倾向只留一份(root 是 cross-AI log,plugins/qwen/ 是 npm-style plugin CHANGELOG)。但两份没互链,新用户看不到 plugin 级别的 CHANGELOG。

### P2-2 state.mjs 里仍有 `generateJobId` export 没人用(检测:tests 外)
3-way 清理时只删了 job-control.mjs 里的 dead code,state.mjs 里 gemini 血统的 `generateJobId("gt-...")`  不再被调用(qwen 全用 crypto.randomUUID)。可删。

### P2-3 README Status: "v0.1 complete" 可以换成 "v0.1.0 released"
`README.md:5` — 现在已 tag,可以更新状态。

### P2-4 plan.md 里 Phase 5 Task 5.4 标 pending,实际已 done
`docs/superpowers/plans/2026-04-20-qwen-plugin-cc-implementation.md` 里 Task 5.4 完成状态没同步。或者干脆标 plan 为 archived。

### P2-5 `doc/` 和 `docs/` 两个目录歧义
`doc/probe/` + `doc/review-*.md` 用小写单数,`docs/superpowers/` 用复数。统一一下。

---

## Real-world scenario gaps(未必 bug,v0.2 scope)

1. **两个 Claude Code session 共享 workspace**:state.json 并发写,updateState 有 atomic 保护吗?(Codex focus 之一)
2. **Claude Code 跨 session 的 bg job 所有权**:session A 起 bg job,session A 关闭,session B 打开看 state — 应该能看到/finalize 吗?SessionEnd hook 当前不 kill,会怎样?
3. **本地 marketplace 更新 workflow**:用户改插件代码,install mode 是 copy,需手动 `claude plugins update qwen@qwen-plugin`。README 没说。
4. **Claude 自己跑 bg job(not 人)时的 expectation**:subagent 通过 `/qwen:rescue --background` 发任务然后 wait 轮询 status,但 plugin 文档没描述这个 pattern。

---

## Top concern

**P0-1 review 子命令无门禁跑 yolo**:qwen 在 review 时可以执行任何 shell 命令,没有 --unsafe 开关控制。这是安全边界问题,应在 v0.1.1 hotfix 而非 v0.2 处理。
