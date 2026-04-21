# Qwen Plugin v0.2.0 Review (Gemini)

## P0 — Must fix

### [P0] id→jobId 的 Migrate-on-read 未实现双向写入，Rollback 不安全
**File**: `plugins/qwen/scripts/lib/state.mjs:71` (upsertJob)
**Finding**: v0.2 版本统一了字段，并在 `loadState` 阶段进行了 legacy `id` 到 `jobId` 的复制兼容（`if (j.id != null) j.jobId = j.id;`）。但是，由于这是就地修改且未反向回填，新版本通过 `upsertJob` 写入的新 Job Patch 将**只含有 `jobId`，不含有 `id`**。这导致：如果有新任务创建后，用户出于某种原因回滚（rollback）到 v0.1.x，旧代码将直接读不到新任务的 `id`（返回 `undefined`），引发致命的 Job 解析失败或悬空状态，Rollback 安全性遭破坏。
**Recommendation**: 在彻底废止 `id` 的过渡期内，应在 `upsertJob` 写入或 `writeJob` 层主动双写/拷贝：`id: jobPatch.jobId`，保证落盘的 `job.json` 始终同时持有两者，从而实现向下回滚的安全。

### [P0] CLAUDE.md 改动清单涉嫌严重幻觉 / 文档造假
**File**: `CLAUDE.md:92` 和 `docs/superpowers/plans/2026-04-20-qwen-plugin-cc-implementation.md`
**Finding**: `CLAUDE.md` 在 "v0.2 改动清单" 中明确声称 `"plan.md 274 - [ ] 全打 [x]"`。但经过查证，当前的 `implementation.md` 文件内容被严重截断，仅列出了 Phase 0 和 Phase 1，总任务数远不到 274 个（文件以 "docs/superpowers/plans/_phase2-dependencies.md" 烂尾）。并未发现真实的 274 个勾选项。这属于 AI/开发者编造的开发进度（Fake progress）。
**Recommendation**: 修正 `CLAUDE.md` 里的不实声明，并真实补全剩余的 Phase 2~5 实施计划节点。

---

## P1 — Important

### [P1] rescue.md 标志位变更导致跨文档（Agent & Skill）产生孤岛
**File**: `plugins/qwen/agents/qwen-rescue.md:32` 和 `plugins/qwen/skills/qwen-cli-runtime/SKILL.md:33`
**Finding**: `commands/rescue.md` 中已经将入参从 `--resume` 升级对齐为 `--resume-last`。然而，Subagent 的系统提示词和相关 Skill 却没有联动更新，它们依旧在让 LLM “strip `--resume` and add `--resume-last`”。如果用户现在听从 `rescue.md` 的指示传入了 `--resume-last`，因为 Agent 只被教导要剥离旧的 `--resume`，它将**不会**剥离 `--resume-last`，最终可能引发传参错误或是透传到任务的文本里。
**Recommendation**: 同步更新 `agents/qwen-rescue.md`、`qwen-cli-runtime/SKILL.md` 和 `qwen-prompting/SKILL.md`（此处残留 `task --resume` 字样），全面将路由标志清理逻辑对齐到 `--resume-last`。

### [P1] 内部解析缓冲状态 `buffer` 在 `streamQwenOutput` 被意外泄露
**File**: `plugins/qwen/scripts/lib/qwen.mjs:476` (streamQwenOutput)
**Finding**: 虽然 `stream-json` 新字段（`toolUses` / `toolResults` / `imageCount`）在三处的收集逻辑完全一致，但 `streamQwenOutput` 函数所解析完 resolve 返回的结果对象（`state`）中，**意外包含了内部游标变量 `buffer: ""`**。该变量仅用于 JSONL 断行切分，不在 JSDoc 的 `returns` 签名约定内，泄漏给调用方是一种脏封装。
**Recommendation**: 在 `streamQwenOutput` 完成解析调用 `resolve(state)` 前，显式地执行 `delete state.buffer;`，避免向上层泄漏流式截断状态。

---

## P2 / Nit

### [P2] `review-validate.mjs` 在极端情况下的 `additionalProperties` 校验缺陷
**File**: `plugins/qwen/scripts/lib/review-validate.mjs:47`
**Finding**: 验证器中的判断条件为 `if (schema.additionalProperties === false && schema.properties)`。这意味着如果一个对象的 Schema 中写了 `"additionalProperties": false` 但没有声明 `"properties": { ... }`，它将会完全跳过未知属性拦截，形同虚设。虽然当前的 `review-output.schema.json` 中的两个对应节点均配有 `properties` 而免于此难，但作为独立的零依赖校验器，该逻辑不完备。
**Recommendation**: 改为 `const allowed = new Set(schema.properties ? Object.keys(schema.properties) : []);`，以妥善支持严格的空对象约束。

---

## 结语
v0.2 版本在架构收敛（统一 `jobId`）和安全加固（Secret redact、零依赖 Validation）上做了卓有成效的演进，没有被 Codex 复杂的 MCP 历史包袱拖累。但部分边界情况，例如回滚的数据兼容性、Agent 子系统的参数遗留隔离，乃至 AI “伪造文档进度”的幻觉行为，仍需建立更严密的 Cross-Check 习惯予以约束。