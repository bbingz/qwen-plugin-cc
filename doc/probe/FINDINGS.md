# Phase 0 关键发现 — Spec v3 需要的 patch

**日期**: 2026-04-20
**qwen 版本**: 0.14.5
**本机场景**: Alibaba Cloud Coding Plan via API Key env

本文档汇总 Phase 0 跑 13 个探针 case 过程中与 spec v3 假设**不一致**的实测行为,以及对应需要打的 patch。按影响严重度排列。

---

## P0 — spec 写错或假设不成立

### F-1. qwen 版本探测:`-V` 无效,必须 `--version`

- spec §4.5 / plan Task 1.4 的 `getQwenAvailability` 调用 `qwen -V` → 实测返 `"Unknown argument: V"`
- 真命令:`qwen --version` 或 `qwen -v`
- **影响**:plan Task 1.4 的 `getQwenAvailability` 实现必须用 `--version` 替代 `-V`

### F-12. `callGeminiStreaming` 签名(job-control 消费接口)

Task 2.4 实装时记录。gemini 版 `callGeminiStreaming` 签名:

```js
export function callGeminiStreaming({
  prompt, model, approvalMode = "plan", cwd,
  timeout = DEFAULT_TIMEOUT_MS, extraArgs = [],
  resumeSessionId = null, onEvent = () => {}
})
```

同步返回,对象含异步 `resultPromise`。`onEvent` 回调供 job-control 流式处理 stream-json 事件。

**影响**:Task 2.8/2.9 实装 `callQwenStreaming` 必须对齐此签名(job-control.mjs 已经按这个契约调用)。当前 `qwen.mjs` 有占位 throw 的 export。

### F-11. gemini state.mjs API 签名与 codex 不同

Task 2.3 实装时发现:
- `writeJobFile(workspaceRoot, jobId, payload)` — 三参数,不是 `(cwd, obj)`
- `readJobFile(jobFilePath)` — 单参数接文件路径,要先 `resolveJobFile(cwd, jobId)` 拿路径
- `listJobs(cwd)` — 从 `state.json::jobs[]` 读,不扫描 `jobs/` 目录
- `upsertJob(cwd, jobData)` — 写入 state.json 的主路径;`writeJobFile` 只写 jobs/<id>.json 单文件
- 导出 22 个符号含 `loadState / saveState / updateState / appendTimingHistory / readTimingHistory / getConfig / setConfig` 等

**影响**:plan Phase 2 的 runTask / runStatus / runResult / runCancel 要按 gemini 实际 API 写,不是 plan 里的 codex-风签名。具体:
- runTask 写 job:先 `upsertJob(cwd, {...jobMeta})` + 可选 `writeJobFile(cwd, jobId, payload)` 存单 job
- runStatus 列 job:`listJobs(cwd)` 返 `state.json::jobs[]`
- runResult 读:`readJobFile(resolveJobFile(cwd, jobId))`

### F-1b. `qwen --version` 输出**裸版本号**,不含 "qwen, version" 前缀

- Phase 1 Task 1.4 实装时发现:`qwen --version` 输出就是 `0.14.5`(单行裸版本)
- 不是 `qwen, version 0.14.5` 这种格式
- **影响**:
  - setup JSON `version` 字段值会是 `"0.14.5"`(不含 "qwen, version"),不影响用户体验
  - Task 1.4 单元测试正则从 `/qwen, version/` 调整为 `/\d+\.\d+\.\d+/`(semver 匹配)
- **注**:Phase 0 截图里看到的 "qwen, version 0.14.5" 是 qwen 交互 TUI 的 `/status` 命令输出,不是 `qwen --version`

### F-2. API Error 格式是 `[API Error: NNN ...]` 不是 `(Status: NNN)`

- spec §5.1 `classifyApiError` 状态码优先路径用 `\bStatus:\s*(\d{3})\b`
- 实测 qwen 实际格式:`[API Error: 401 invalid access token or token expired]`
- **Status 关键字不存在!**
- **影响**:`classifyApiError` 必须**第一优先**用 `\[API Error:\s*(\d{3})\b` 提取状态码,`(Status: NNN)` 作为二级 fallback
- plan Task 2.5 的单元测试要改掉 `"(Status: 401)"` 输入,用真实格式 `"[API Error: 401 ..."`

### F-3. Default 模型是 `qwen3.5-plus` 不是 `qwen3.6-plus`

- spec §1.1 / §1.4 / §2.4 到处写 `qwen3.6-plus`
- `~/.qwen/settings.json::model.name` 实测 `qwen3.5-plus`
- `qwen3.6-plus` 存在但 `description: "Currently available to Pro subscribers only."`
- **影响**:
  - spec 所有 `qwen3.6-plus` 字面量换成 `qwen3.5-plus`(或改用"由 settings 决定,默认 qwen3.5-plus")
  - lessons.md 里写清

### F-4. `--approval-mode auto-edit` 无 TTY 是 **auto-deny**,不是 hang

- spec §9-1 / case 11 决策点
- 实测:遇 `run_shell_command` 时:
  - `exit 0`
  - `is_error: false`
  - `permission_denials: [{ tool_name: "run_shell_command", tool_input: {...} }]`
  - `result` 字段自然说明 "I don't have permission to run shell commands"
- **决策**:保留 spec §3.3 默认 `auto-edit`(不改对称 `--unsafe`)
- **新增字段**:job.json 透传 `permissionDenials` from resultEvent;`/qwen:result` 渲染时高亮提示"加 `--unsafe` 重跑"
- 见 `doc/probe/case-11-decision.md`

### F-5. `~/.qwen/settings.json::proxy` 不存在;qwen 直接从 env 读 proxy

- spec §4.3 假设"qwen 交互模式读 settings.proxy,headless 不读"
- 实测:本机 `settings.json` 里根本没 `proxy` 字段(是 `null`)
- 清所有 proxy env 后 qwen headless 仍跑通(因为网络直连阿里云国内端点不需要代理)
- **影响**:
  - `buildSpawnEnv` 的 settings.proxy 注入路径仍保留作防御(对真有代理需求的用户有用),但不是 spec §4.3 开头描述的"必须"修复
  - spec §4.3 开头那段"qwen headless 漏报代理"不再是事实
  - plan Task 1.5 的 `buildSpawnEnv` 测试仍有效(mock settings 注入一个 proxy 值测冲突逻辑)

---

## P1 — spec 未覆盖但真实存在

### F-6. Assistant 事件有 `thinking` 块,不只是 `text`

- spec §4.4 消费 assistant 事件只处理 `b.type === "text"`
- 实测:qwen 默认在 `text` 块前先吐一个 `thinking` 块(`b.type === "thinking"`,含 `thinking` 字段而非 `text`)
- **影响**:
  - `parseStreamEvents` / `streamQwenOutput` 要主动**忽略** thinking 块(不要让它混入 assistantTexts 被当成真输出)
  - plan Task 2.7 / 2.9 测试要加:stream 里有 thinking + text 时,assistantTexts 只收 text

### F-7. `--session-id` / `-r` 必须是合法 UUID

- spec § plan 没说清
- 实测:
  - `probe-xxx-xxx` 这类自定义字符串 → `Invalid --session-id: "...". Must be a valid UUID`
  - 全 0 `00000000-0000-0000-0000-000000000000` → 同样 `Invalid`
- **影响**:companion 生成 jobId 或 sessionId 时**必须用 `crypto.randomUUID()`**;不能用 `job-NNNN` 这种 slug
- spec §4.6 job.json 的 `jobId` 格式要指定为 UUID

### F-8. `no_prior_session` 的 stderr 文本

- 实测:`qwen -r <合法但不存在的 UUID> ...` → stderr: `"No saved session found with ID <uuid>. Run qwen --resume without an ID to choose from existing sessions."`
- exit_code: 1
- **影响**:`detectFailure` / spec §5.2 的 `no_prior_session` kind 触发条件正则:`/No saved session found with ID/i`

### F-9. 本机 auth 是 API Key(env)不是 OAuth

- spec §4.5 假设 auth 走 `qwen auth coding-plan` OAuth + `~/.qwen/oauth_creds.json`
- 实测:本机实际走 `settings.json::env.BAILIAN_CODING_PLAN_API_KEY`(API Key mode),`oauth_creds.json` 过期报错是另一条路径
- **影响**:
  - `parseAuthStatusText` 要识别 API Key mode
  - `/qwen:setup` 的"未认证"提示应分情境:若检测到 `settings.env.*KEY` 存在但 ping 失败 → "API key 失效,请重新 `qwen auth coding-plan` 或在 settings 里换 key";若无 key → 指引重新 auth

### F-10. `-m <不存在模型>` 静默 fallback

- spec 假设 bad model → `invalid_request` kind
- 实测:`qwen -m qwen-fake-model` → 静默 fallback 到 default,正常跑通(exit 0,结果正常)
- **影响**:spec §5.2 的 `invalid_request` kind 触发条件不能靠"bad model";留作文档标注即可,companion 不主动检测

---

## P2 — 次要行为观察

### F-11. cache_read_input_tokens 体现缓存生效

- 本机 repeat ping 第 2 次看到 `cache_read_input_tokens: 14917 / total: 15209`
- 说明 coding-plan 有 prompt 缓存机制
- **影响**:review retry 若复用 session `-c`,第二轮 token 成本很低;§5.3 retry 策略这一点有利好

### F-12. `--openai-base-url` 被 coding-plan settings 覆盖

- 无法用 httpstat.us mock 状态码(case 12 失败)
- **影响**:多状态码测试走单元测试 mock 字符串路径即可(plan Task 2.5);不强求 probe 活样本

---

## 对 plan 的修订(在 Phase 1 开工前必做)

1. **plan Task 1.3**(qwen.mjs 骨架):`QWEN_BIN` 版本探测命令改用 `--version`
2. **plan Task 1.4**(`getQwenAvailability`):`binaryAvailable(bin, ["--version"])`
3. **plan Task 1.7**(`parseAuthStatusText`):加 API Key mode 识别分支
4. **plan Task 2.5**(`classifyApiError`):
   - 优先正则改成 `\[API Error:\s*(\d{3})\b`(而不是 `Status: NNN`)
   - `(Status: NNN)` 作二级 fallback
   - 单元测试输入改用真实 `[API Error: 401 invalid access token or token expired]`
5. **plan Task 2.7**(`parseStreamEvents`):跳过 `thinking` 块,只收 `text`
6. **plan Task 2.9**(`streamQwenOutput`):同上
7. **plan Task 2.11**(`runTask`):job.json 加字段 `permissionDenials` 透传自 resultEvent
8. **plan Task 4.2**(`runResult`):渲染 `permissionDenials` 高亮提示
9. **jobId 生成**:plan 里提到 `generateJobId()` 的任何地方,确保用 `crypto.randomUUID()`

这些修订作为 Phase 0 → Phase 1 交接的一部分,写进 plan 前言或单独 patch commit。
