# Qwen Plugin v0.2.0 Review (MiniMax)

**Date**: 2026-04-22
**Reviewer**: MiniMax (独立 senior code reviewer)
**Scope**: v0.2 diff (2eb89d5..584498e, 25 commits, 31 files, ~1619 additions)
**Focus**: intent vs 实现一致性、新增纯函数 corner case、test 假阳性、中文注释漂移、v0.1.x P0 修复验证

---

## P0 — Must fix

### [P0-1] `validateReviewOutput`: `additionalProperties: false` 无 `properties` 时失效

**File**: `plugins/qwen/scripts/lib/review-validate.mjs:74-80`

**Finding**: 当前实现只在 `schema.properties` 存在时才检查 `additionalProperties: false`。若 schema 是 `{ "type": "object", "additionalProperties": false }` (无 properties)，则任何额外属性都会被静默放过。

```javascript
if (schema.additionalProperties === false && schema.properties) {  // ❌ schema.properties 必须存在
  const allowed = new Set(Object.keys(schema.properties));
  // ...
}
```

**Repro**: schema 为 `{ "type": "object", "additionalProperties": false }` 时，输入 `{ "foo": "bar", "baz": 1 }` 通过验证。

**Impact**: review schema 扩展时若先定义 `additionalProperties: false` 再加 properties，会在空 properties 阶段出现安全漏洞。

**Recommendation**: 改为 `if (schema.additionalProperties === false)`，allowed 取自 `schema.properties ?? {}`。

---

### [P0-2] `redactInput`: `undefined` value 未递归处理

**File**: `plugins/qwen/scripts/lib/qwen.mjs:373-389`

**Finding**: `redactInput(undefined)` 直接 return undefined（line 374 的 `if (input == null)` 分支）。但若 object 中某 key 的 value 是 `undefined`，Object.entries 不会枚举它——所以这不是 bug。

真正的 corner case: **数组中的 `undefined`** 会保留：
```javascript
redactInput([undefined, null, "sk-key12345678901234567"])
// → [undefined, null, "[REDACTED]"]  ← undefined 未被 redact
```

**Repro**: `normalizePermissionDenials([{ tool_name: "x", tool_input: { items: [undefined, "sk-key12345678901234567"] } }])`

**Impact**: 低——qwen 吐 undefined 概率极低，且 undefined 不包含敏感信息。

**Recommendation**: 显式处理 undefined：
```javascript
if (input == null || input === undefined) return input;
```

---

### [P0-3] `parseAssistantContent`: `tool_use` 字段名无 fallback

**File**: `plugins/qwen/scripts/lib/qwen.mjs:234-239`

**Finding**: v0.2 新增抓 `tool_use`，但只读 `b.input`：
```javascript
input: b.input ?? null,  // ❌ 若 qwen 用 tool_input 字段名会丢数据
```

**Context**: v0.1.2 review (P0-1) 已提出此问题，v0.2 CLAUDE.md 未列为 fixed issue。

**Evidence**: 无真实 qwen output fixture 验证字段名。当前测试 `qwen-parse.test.mjs` 无 tool_use mock。

**Impact**: 若 qwen stream-json 用 `tool_input` 而非 `input`，tool_use 全部参数丢失，静默降级。

**Recommendation**: `input: b.input ?? b.tool_input ?? null`（与 tool_result 的 `content` 处理方式一致）。

---

## P1 — Important

### [P1-1] `isLikelySecretFile`: Unicode case-fold 不完整

**File**: `plugins/qwen/scripts/lib/git.mjs:32-48`

**Finding**: 正则用 `/i` 做大小写不敏感，但 JavaScript 的 `String.prototype.match()` 和 `RegExp.prototype.test()` 使用 Unicode-aware case folding (UAX #21)。这通常是正确的。

真正的风险: **Unicode 横向攻击 (Homoglyph Attack)**：
- `.eηv` (η = Greek eta) 不匹配 `/\.env/i`
- `.рythonrc` (р = Cyrillic pe) 不匹配 `/\.pyth/i`

**Impact**: 低——攻击者需要先获取文件系统写权限，且 qwen upstream 不会执行这些文件。

**Recommendation**: 如需防御，考虑使用 `String.prototype.normalize("NFD")` 去除组合字符后再匹配。

---

### [P1-2] `normalizePermissionDenials`: Bearer pattern 误报 + 漏报风险

**File**: `plugins/qwen/scripts/lib/qwen.mjs:364-365`

**Finding**: 
```javascript
/^Bearer\s+\S/i  // ❌ ^ 锚定行首
```

真实 HTTP 场景: `Authorization: Bearer eyJ...` 不匹配此正则。

**Repro**:
```javascript
redactInput({ header: "Authorization: Bearer eyJhbGc..." })
// → 输入保留，未被 redact
```

**Context**: 其他 reviewer (v0.2-qwen) 也指出此问题（其 P1-1/P0-4）。

**Impact**: 若 qwen 吐 HTTP header 格式的 token，会漏 redact。

**Recommendation**: 同时匹配行首和行中：
```javascript
/(?:^|[,\s])Bearer\s+\S/i
```

---

### [P1-3] `buildReviewAppendSystem`: 无输入校验

**File**: `plugins/qwen/scripts/lib/qwen.mjs:819-825`

**Finding**: `schemaText` 为空字符串时返回合法但无意义的 prompt：
```
You are a code reviewer. Your output must strictly match this JSON schema:

Output only the JSON document itself. No prose before or after. No markdown fences.
```

**Impact**: 低——调用方 `buildInitialReviewPrompt` 传空字符串概率极低（schema 文件必须存在）。

**Recommendation**: 若 `schemaText` 为空，抛 `TypeError("schemaText required")` 或返回更有意义的提示。

---

### [P1-4] `tryLocalRepair`: 超大 JSON 截断不在 Step 3 之前

**File**: `plugins/qwen/scripts/lib/qwen.mjs:754-776`

**Finding**: 当前在 Step 1 直接 `JSON.parse(raw)`。若 raw 是 50MB 的合法 JSON，parse 成功但后续 Step 3 的 `text.slice(firstBrace, lastBrace + 1)` 仍然处理完整 50MB。

无实际的 8KB 截断保护在 repair 路径上。

**Impact**: 低——qwen 吐 50MB JSON 概率极低（review schema 输出很小）。

**Recommendation**: 在 Step 3 之前加长度检查：
```javascript
if (text.length > 100_000) text = text.slice(0, 100_000);
```

---

### [P1-5] `extractStderrFromLog`: 混合 JSON + 非 JSON 行边界情况

**File**: `plugins/qwen/scripts/lib/job-lifecycle.mjs:17-26`

**Finding**: 当前逻辑以 `{` 开头判断 JSON 行。JSONL 行可能以空白字符开头（如 `"  {..."`）或包含嵌入式 `{`。

```javascript
if (t.startsWith("{")) continue;  // ❌ 忽略以 { 开头的行
```

**Repro**:
```
[INFO] Starting { "step": 1 } now
{"type":"result","data":"ok"}
```

第一行包含 JSON 但以 `[INFO]` 开头，被当作 stderr 保留（可能合理）。

**Impact**: 低——qwen 的 JSONL 输出以 `{` 开头是稳定的（F-6 等 FINDINGS 确认）。

**Recommendation**: 当前行为可接受，但建议加注释说明此假设依赖 qwen 输出格式稳定性。

---

## P2 / Nit

### [P2-1] `cleanupOrphanedFiles`: `j.jobId` 无 undefined 保护

**File**: `plugins/qwen/scripts/lib/state.mjs:173`

**Finding**: v0.2 删除了 `j.jobId ?? j.id` coalesce，改为 `j.jobId`。若 job 对象 jobId 字段缺失，会被加入 Set：
```javascript
const jobIds = new Set(jobs.map((j) => j.jobId));  // undefined 会被加入 Set
```

**Context**: v0.2 CLAUDE.md 称 "loadState 已对存量 legacy `id` migrate"，但若 migrate 失败（loadState 异常），job 可能仍无 jobId。

**Impact**: 低——migrate-on-read 保证主路径安全。

**Recommendation**: 加断言或兜底：
```javascript
const jobIds = new Set(jobs.map((j) => j.jobId).filter(Boolean));
```

---

### [P2-2] `readTimingHistory`: 损坏行计数后 stderr write 在 catch 内

**File**: `plugins/qwen/scripts/lib/state.mjs:358-363`

**Finding**: 
```javascript
try { process.stderr.write(`[timing] ${corrupted}...`); } catch {}
```

若 stderr 写入失败（如 EPIPE），静默忽略。这在 `timing history` 诊断场景是合理的。

**Status**: 可接受。

---

### [P2-3] `runQwenPing` 返回值未用: `toolUses`/`toolResults`/`imageCount`

**File**: `plugins/qwen/scripts/lib/qwen.mjs:283-286`

**Finding**: `runQwenPing` 返回值包含 `toolUses/toolResults/imageCount`，但当前调用方不使用这些字段：
```javascript
const ping = await runQwenPing({ env, cwd });
// ping.toolUses 未被使用
```

**Status**: 代码预留未来使用，可接受。

---

### [P2-4] `reviewWithRetry`: retry prompt 的 `previousRaw` 截断位置硬编码

**File**: `plugins/qwen/scripts/lib/qwen.mjs:854-858`

**Finding**: 截断点 4KB/2KB 硬编码，无注释说明来源。

**Status**: 低——是经验值，非 bug。

---

### [P2-5] 中文 commit message 与代码行为一致

抽检 commit message：
- `fix(review): retry 轮重塞 schema` ✅ 与实现一致
- `fix(security): permission_denials schema 归一` ✅ 与实现一致
- `fix(lifecycle): incomplete_stream 透传 stderr tail` ✅ 与实现一致

**Status**: 中文注释质量高，无漂移。

---

## v0.1.x P0 修复验证

| v0.1.2 Issue | 声称修复 | 验证结果 |
|--------------|----------|---------|
| P0-1 (session filter 用 claudeSessionId) | commit cad4fc5 | ✅ 代码确认 |
| P0-2 (resume-last 发 -c) | commit 4fbf321 | ✅ buildQwenArgs 逻辑确认 |
| P0-3 (updateState 锁 + 原子写) | commit 833c531 | ✅ 已在 v0.1.2 代码 |
| P0-4 (bg spawn child.pid == null) | commit 4fbf321 | ✅ 已在 v0.1.2 代码 |
| P0-5 (cwd 归一 resolveWorkspaceRoot) | commit 4fbf321 | ✅ 全局使用确认 |
| P0-6 (refreshJobLiveness tail-only) | commit 4fbf321 | ✅ LOG_TAIL_BYTES = 1MB |

**结论**: v0.1.2 所有 P0 已正确修复。

---

## CLAUDE.md v0.2 清单对齐检查

| Item | 实现状态 |
|------|----------|
| reviewWithRetry 重塞 schema | ✅ line 941 |
| tryLocalRepair string-aware | ✅ line 778-795 |
| refreshJobLiveness verifyPid | ✅ line 56-67 |
| isLikelySecretFile 13 patterns | ✅ git.mjs:32-48 |
| NODE_OPTIONS 出白名单 | ✅ qwen.mjs:31-32 |
| SessionEnd 走 cancelJobPgid | ✅ hook.mjs:14-22 |
| parseAssistantContent 4 types | ✅ qwen.mjs:227-252 |
| detectFailure Layer 0 | ✅ qwen.mjs:420-422 |
| normalizePermissionDenials | ✅ qwen.mjs:398-408 |
| review-validate.mjs 零依赖 | ✅ 100 行实现 |
| extractStderrFromLog | ✅ job-lifecycle.mjs:17-26 |
| runCancel JSON/human 分流 | ✅ companion.mjs:345-395 |
| rescue.md 更新 | ✅ commands/rescue.md |
| 删 render.mjs | ✅ 确认删除 |
| 删 generateJobId | ✅ 确认删除 |

---

## 结语

**P0**: 3 issues (P0-1 严重: additionalProperties 逻辑缺陷; P0-2 低: undefined 处理; P0-3 待验证: tool_use 字段名)

**P1**: 5 issues (Unicode homoglyph; Bearer pattern; schemaText 校验; 大 JSON; extractStderr 假设)

**P2**: 5 issues (nit 级别,无需紧急修复)

### MiniMax Plugin Review 工具链反馈

1. **大 diff 阅读体验**: 1619 行 diff + 31 files 在单次 git diff 输出中可读性差。建议未来用 `git diff --name-only` + 按需取单个文件 diff。

2. **Progressive Disclosure 有效**: CLAUDE.md → FINDINGS.md → 历史 review 的分层结构让审查员能快速定位 context。P0 清单明确避免重复报告。

3. **测试覆盖盲区**: 当前 190 测试覆盖主要路径，但 mock 数据缺乏真实 qwen stream-json fixture（特别是 tool_use/tool_result/image 块）。建议未来加 probe case 活样本。

4. **review-validate.mjs 价值**: 零依赖 validator 避免了 ajv 依赖风险，但实现的 `additionalProperties` 逻辑缺陷（见 P0-1）说明 minimal implementation 有边界遗漏。

5. **整体评价**: v0.2 代码质量高，security hardening (normalizePermissionDenials, isLikelySecretFile, NODE_OPTIONS removal) 到位，correctness fix (retry schema, PID reuse) 有据可查。推荐修复 P0 后发布。
