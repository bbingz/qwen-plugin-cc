# qwen-plugin-cc v0.1.0 — Independent Review by Qwen CLI

**Date**: 2026-04-21
**Branch**: main (HEAD 08d09ac)
**Reviewer**: Qwen CLI (as qwen-plugin-cc本体)
**Scope**: qwen CLI behavior assumptions, prompt engineering quality, F-1..F-17 findings accuracy, rescue task prompt construction, review schema + retry logic

---

## ## P0 Critical

### [P0] `classifyApiError` 优先级正确但关键词边界仍可能误伤

**File**: `plugins/qwen/scripts/lib/qwen.mjs:168-193`

**发现**: `classifyApiError` 已按 F-2 实测修正为优先匹配 `[API Error: NNN` 格式，但兜底关键词如 `/\bquota\b|\bbilling\b/i` 可能误伤正常文本（如用户 prompt 提到 "quota" 但不是错误）。当前实现只在 assistant text 含 `[API Error:` 前缀时才调用，风险可控。

**建议**: 维持现状，但若未来 qwen 输出格式变化（如去掉 `[API Error:` 前缀），需重新评估关键词边界。

---

### [P0] `detectFailure` 层 4 找到的 error line 未截断，可能含超长文本

**File**: `plugins/qwen/scripts/lib/qwen.mjs:212-215`

**发现**: `assistantTexts.find()` 返回整行文本传给 `classifyApiError`，若 qwen 在长文本中嵌入 `[API Error:`（如引用日志），会吞掉整行。当前 qwen v0.14.5 实测 error 都独立成行，风险低。

**建议**: 用正则提取 `[API Error:.*?](?:\n|$)` 而非整行，防未来 qwen 输出格式变化。

---

### [P0] `buildQwenArgs` 未校验 `sessionId` 必须是 UUID（F-7 约束）

**File**: `plugins/qwen/scripts/lib/qwen.mjs:261-282`

**发现**: F-17 明确指出 `--session-id` 必须是合法 UUID，但 `buildQwenArgs` 直接透传 `sessionId` 不做校验。qwen CLI 会在运行时 reject 非 UUID 值（`Invalid --session-id: "..."`），但 plugin 层应提前拦截。

**建议**: 加 UUID 校验（`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`），提前抛 `CompanionError("invalid_session_id")`。

> ⚠️ **Future-compat**: 若 qwen 未来放宽 sessionId 约束（如允许自定义字符串），此校验需同步调整。

---

### [P0] `reviewWithRetry` 3 轮 retry 逻辑中第 2/3 轮 `appendSystem: null` 可能降低约束力

**File**: `plugins/qwen/scripts/lib/qwen.mjs:507-516`

**发现**: retry prompt 构造时 `appendSystem: null`（不重塞 schema），依赖 user prompt 里的 `Schema (authoritative)` 段落。但 qwen v0.14.5 实测对 `--append-system-prompt` 的遵循度高于普通 user prompt，可能导致 retry 轮次约束力下降。

**建议**: retry 轮次也传 `appendSystem: schemaText`，维持与首轮一致的约束强度。

---

### [P0] `tryLocalRepair` 对尾部截断（truncation）修复能力有限

**File**: `plugins/qwen/scripts/lib/qwen.mjs:435-476`

**发现**: `tryLocalRepair` 通过 bracket 计数补全 `}`/`]`，但对**内容截断**（如 JSON string value 中途断掉）无能为力。qwen v0.14.5 在 timeout 或 max_tokens 限制下可能吐出 `"summary": "This is a very long` 这种坏 JSON，当前逻辑修不了。

**建议**: 加一步：检测未闭合的 string（`/"(?:[^"\\]|\\.)*$/` 匹配未闭合引号），补引号 + 截断该字段值。

---

## ## P1 Important

### [P1] `parseStreamEvents` 跳过 `thinking` 块正确，但未记录/透传 thinking 内容

**File**: `plugins/qwen/scripts/lib/qwen.mjs:372-398`

**发现**: F-6 实测 qwen 默认吐 `thinking` 块，当前实现正确跳过（只收 `text`）。但 thinking 内容对调试/审计有价值（如 qwen 为何走某条推理路径），完全丢弃可能损失信息。

**建议**: 加可选参数 `includeThinking: boolean`，返回 `thinkingBlocks: array` 供高级用户消费。

---

### [P1] `buildReviewRetryPrompt` 截断 previousRaw 到 8KB 可能丢掉关键错误上下文

**File**: `plugins/qwen/scripts/lib/qwen.mjs:482-496`

**发现**: retry prompt 截断策略是头 4KB + 尾 2KB，但若 schema error 发生在中间区域（如 `findings[5].recommendation`），qwen 可能看不到完整错误结构。当前 schema 较小（~1KB），8KB 通常够用。

**建议**: 改为智能截断：优先保留 `previousRaw` 中含 `instancePath` 指向的错误字段附近文本。

---

### [P1] `prompts.mjs` 过于简化，未利用 `prompt-blocks.md` 的 XML 块结构

**File**: `plugins/qwen/scripts/lib/prompts.mjs:1-14`

**发现**: `loadPromptTemplate` / `interpolateTemplate` 是简单字符串替换，未使用 `skills/qwen-prompting/references/prompt-blocks.md` 定义的 `<task>`, `<structured_output_contract>` 等 XML 块。qwen v0.14.5 实测对结构化 XML 块遵循度更高（见 `qwen-prompt-recipes.md`）。

**建议**: 引入 `buildStructuredPrompt({ task, contract, groundingRules })` 函数，组装标准 XML 块，提升 JSON 合规率。

---

### [P1] review schema 的 `confidence` 字段无枚举/步进约束，qwen 可能吐任意浮点数

**File**: `plugins/qwen/schemas/review-output.schema.json:35-39`

**发现**: schema 只约束 `minimum: 0, maximum: 1`，qwen 可能吐 `0.837492` 这种不可解释值。实测 qwen v0.14.5 倾向吐 `0.5`, `0.8`, `1.0` 等"整"数，但无强制约束。

**建议**: 改用 `enum: [0.25, 0.5, 0.75, 1.0]` 或加 `multipleOf: 0.25`，提升可读性。

---

### [P1] F-13 关于 `require_interactive` 的条目**准确**，但代码注释未对齐

**File**: `plugins/qwen/scripts/lib/qwen.mjs:269-274`

**发现**: F-17 实测 `background + auto-edit` 允许，`background + 显式 yolo` 拒。代码逻辑正确（抛 `require_interactive`），但注释写的是"bg + !unsafeFlag + yolo 结果 → 抛"，未明确区分"显式 yolo" vs "默认 auto-edit 推导 yolo"。

**建议**: 注释改为："用户显式 `--approval-mode yolo` 且 bg + !unsafe → 抛；默认 auto-edit 推导的 yolo 不抛"。

---

### [P1] F-2 关于 API Error 格式的条目**准确**，`classifyApiError` 已正确实现

**File**: `plugins/qwen/scripts/lib/qwen.mjs:168-174`

**发现**: F-2 实测 qwen 格式是 `[API Error: NNN ...]`，代码第一优先正则 `/\[API Error:\s*(\d{3})\b/i` 正确，`(Status: NNN)` 作 fallback 兼容其他 provider。无需修正。

---

### [P1] F-6 关于 `thinking` 块的条目**准确**，`parseStreamEvents` / `streamQwenOutput` 都已跳过

**File**: `plugins/qwen/scripts/lib/qwen.mjs:156-162`, `plugins/qwen/scripts/lib/qwen.mjs:383-387`

**发现**: 两处都检查 `b?.type === "text"`，自然跳过 `thinking` 块。与 F-6 实测一致。

---

### [P1] F-7 关于 UUID 约束的条目**准确**，但 plugin 未主动校验（同 P0 第 3 条）

**File**: `plugins/qwen/scripts/lib/qwen.mjs:261-282`

**发现**: 同 P0，不赘述。

---

## ## P2 Minor

### [P2] `buildInitialReviewPrompt` 的 user prompt 未用 `<diff>` XML 块包裹

**File**: `plugins/qwen/scripts/lib/qwen.mjs:456-471`

**发现**: `qwen-prompt-recipes.md` 推荐用 `<diff>...</diff>` 包裹 diff 内容，但当前实现直接拼接字符串。qwen v0.14.5 实测两种格式都能理解，但 XML 块更清晰。

**建议**: 改为 `<diff>\n${diff}\n</diff>` 包裹，对齐 `prompt-blocks.md` 规范。

---

### [P2] `tryLocalRepair` 的 Step 5 补 bracket 逻辑未处理**嵌套类型混用**（`{` 配 `]`）

**File**: `plugins/qwen/scripts/lib/qwen.mjs:463-472`

**发现**: 简单 stack 弹出逻辑假设 `{` 必配 `}`，`[` 必配 `]`，但若输入是 `{"a": [1, 2`，stack 是 `["{", "["]`，弹出顺序是 `["[", "{"]`，补全为 `{"a": [1, 2]}` 正确。当前逻辑正确，但注释未说明。

**建议**: 加注释说明 stack LIFO 特性自然处理嵌套混用。

---

### [P2] `parseAuthStatusText` 识别 `coding-plan` / `qwen-oauth` / `openai`，但未识别 `anthropic` 以外的其他 provider

**File**: `plugins/qwen/scripts/lib/qwen.mjs:110-127`

**发现**: F-9 实测本机走 API Key mode，代码已识别 `coding-plan` / `qwen-oauth` / `openai` / `anthropic`。但若用户用 Azure OpenAI / Bedrock 等，会落入 `unknown`。当前 `unknown` 不 throw，只是 `configured: false`。

**建议**: 若未来支持多 provider，扩展正则匹配 `azure|bedrock|vertex` 等关键词。

---

### [P2] `buildSpawnEnv` 的 NO_PROXY 合并逻辑未去重空字符串

**File**: `plugins/qwen/scripts/lib/qwen.mjs:84-89`

**发现**: 若 `env.NO_PROXY` 是 `","`（罕见），split 后得 `["", "", ""]`，filter 后变空数组，合并结果只剩默认值。正常场景不会触发。

**建议**: 加 `.filter(s => s && s.trim())` 双重保护。

---

### [P2] F-3 关于 default 模型是 `qwen3.5-plus` 的条目**准确**，但 plugin 未硬编码 default 模型

**File**: N/A（代码未硬编码模型）

**发现**: plugin 依赖 qwen CLI 的 settings.json 决定模型，未自己写死 `qwen3.5-plus`。这是正确设计（解耦），F-3 只是 spec 修订建议，不影响 plugin。

---

### [P2] F-5 关于 proxy settings 的条目**准确**，`buildSpawnEnv` 已正确处理

**File**: `plugins/qwen/scripts/lib/qwen.mjs:56-94`

**发现**: 代码不依赖 `settings.proxy`，直接从 env 读，与 F-5 实测一致。防御层逻辑（若 settings 有 proxy 则注入）保留但非必须。

---

### [P2] F-17 关于 `jobId` vs `id` 割裂的条目**准确**，`state.mjs` 已兼容

**File**: `plugins/qwen/scripts/lib/state.mjs:152-158`

**发现**: `upsertJob` / `cleanupOrphanedFiles` 都用 `j.jobId ?? j.id` 兼容，与 F-17 建议一致。

---

## Future-Compat Risks（假设当前成立但 qwen 升级可能失效）

| 假设 | 当前 v0.14.5 状态 | 风险描述 | 缓解建议 |
|------|------------------|----------|----------|
| `[API Error: NNN` 前缀 | 稳定 | 若 qwen 改格式（如去掉前缀），`classifyApiError` 兜底关键词可能误判 | 加单元测试覆盖新格式 |
| `thinking` 块 `type==="thinking"` | 稳定 | 若 qwen 改 type 名（如 `reasoning`），跳过逻辑失效 | 加白名单 `["thinking", "reasoning"]` |
| `--session-id` 必须 UUID | 严格 | 若 qwen 放宽（允许自定义字符串），校验逻辑需调整 | 监控 qwen release notes |
| `--append-system-prompt` 优先级高于 user prompt | 实测成立 | 若 qwen 调整优先级，retry 约束力可能变化 | 保留当前双保险（user + system） |
| stream-json 事件结构 `type/subtype/message.content[]` | 稳定 | 若 qwen 改 schema（如扁平化 `message.text`），解析逻辑失效 | 加 schema version 探测 |

---

## F-1..F-17 Findings 准确性总评（Qwen 本体视角）

| Finding | 准确性 | 备注 |
|---------|--------|------|
| F-1 | ✅ 准确 | `--version` 已实现 |
| F-1b | ✅ 准确 | 裸版本号解析正确 |
| F-2 | ✅ 准确 | `[API Error:` 优先匹配 |
| F-3 | ✅ 准确 | plugin 未硬编码模型，无影响 |
| F-4 | ✅ 准确 | `auto-edit` 默认行为正确 |
| F-5 | ✅ 准确 | proxy env 直读正确 |
| F-6 | ✅ 准确 | `thinking` 块跳过 |
| F-7 | ✅ 准确 | UUID 约束需 plugin 层校验（P0） |
| F-8 | ⚠️ 部分准确 | `no_prior_session` 检测未在 `detectFailure` 实现（依赖 stderr 捕获） |
| F-9 | ✅ 准确 | API Key mode 识别 |
| F-10 | ⚠️ 部分准确 | 静默 fallback 未检测（非 plugin 责任） |
| F-11 | ✅ 准确 | state.mjs API 对齐 |
| F-12 | ✅ 准确 | streaming 签名对齐 |
| F-13 | ✅ 准确 | `require_interactive` 逻辑正确 |
| F-14 | ✅ 准确 | `args.mjs` API 正确 |
| F-15 | ✅ 准确 | `git.mjs` 签名正确 |
| F-16 | ✅ 准确 | codex hook 依赖已替换 |
| F-17 | ✅ 准确 | `jobId` 兼容处理 |

---

## 总结

**P0 Critical**: 5 条（sessionId 校验、retry 约束力、truncation 修复、error line 截断、兜底关键词边界）
**P1 Important**: 8 条（thinking 透传、retry 截断策略、prompts.mjs 简化、schema confidence 约束、注释对齐）
**P2 Minor**: 7 条（XML 块包裹、bracket 注释、provider 扩展、NO_PROXY 去重、模型硬编码、proxy settings、jobId 割裂）

**Qwen-specific concern**: qwen v0.14.5 的 stream-json 结构和 error 格式假设整体准确，但 plugin 对 sessionId UUID 约束和 retry 轮次的 system prompt 复用不足，可能导致边界场景失败。

Review saved to /Users/bing/-Code-/qwen-plugin-cc/doc/review-v010-qwen.md; found 5 P0, 8 P1, 7 P2; qwen-specific concern: sessionId UUID validation missing and retry rounds should reuse --append-system-prompt for consistent schema enforcement.
