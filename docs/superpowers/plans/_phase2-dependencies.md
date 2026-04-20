---
name: phase2-dependencies
description: job-control.mjs 迁移依赖审计清单,为 Task 2.4 拷贝做准备
type: migration-checklist
---

# Phase 2 依赖解耦清单

从 gemini 复制 `job-control.mjs` 时需要注入/替换的外部依赖。

源文件:`/Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/scripts/lib/job-control.mjs`(约 599 行 / 17.4K)

---

## Node 内置(无需处理)

| 模块 | 用法 |
|---|---|
| `node:fs` | 文件读写 |
| `node:path` | 路径拼接 |
| `node:child_process` | `spawn` / `spawnSync` 启动后台进程 |
| `node:process` | `process.env` / `process.exit` |

---

## 内部(同 lib 目录)依赖

job-control.mjs 的 import 段(第 1–19 行)引入两个同级模块:

### 1. `./gemini.mjs` → 需替换为 `./qwen.mjs`

| 符号 | gemini 定义位置 | qwen 对应 | 状态 |
|---|---|---|---|
| `callGeminiStreaming` | `lib/gemini.mjs:210` | 需要实现 `callQwenStreaming` | **待实现** |

> gemini.mjs 中 `callGeminiStreaming` 封装了对 gemini CLI 的流式调用。
> qwen.mjs 目前无此函数,Task 2.4 前需补充。

### 2. `./state.mjs` → 需整体拷入 qwen lib

从 `state.mjs` import 的全部符号(第 7–19 行):

| 符号 | state.mjs 定义行 | 功能简述 |
|---|---|---|
| `appendTimingHistory` | 270 | 追加计时记录到历史文件 |
| `ensureStateDir` | 48 | 确保 `.claude/state/` 目录存在 |
| `generateJobId` | 183 | 生成唯一 job ID(带前缀) |
| `listJobs` | 205 | 读取所有 job 记录列表 |
| `readJobFile` | 215 | 读取单个 job 详情文件 |
| `resolveJobFile` | 52 | 解析 job 文件路径 |
| `resolveJobLogFile` | 56 | 解析 job 日志文件路径 |
| `resolveStateDir` | 36 | 解析 state 目录绝对路径 |
| `updateState` | 105 | 原子更新 state.json |
| `upsertJob` | 189 | 插入或更新 job 记录 |
| `writeJobFile` | 209 | 写入 job 详情文件 |

state.mjs 是纯 fs/path 操作,**无 gemini 特有逻辑**,可直接拷贝。

---

## 外部(companion / hook 实现)依赖

以下符号在 job-control.mjs 中**被使用但未 import**,由调用方注入(函数参数传入):

| 符号 | gemini 中的实际来源 | 使用方式 | qwen 放哪 |
|---|---|---|---|
| `resolveWorkspaceRoot` | `gemini-companion.mjs:90`(本地函数) | 由 companion 调用时作参数传入 | `qwen-companion.mjs`(已有类似逻辑) |
| `companionScript` | 调用方传入字符串路径 | `runWorker(jobId, workspaceRoot, companionScript, args)` | 改为 qwen-companion 路径 |
| `workspaceRoot` | `resolveWorkspaceRoot()` 返回值 | 贯穿全文件作参数 | 由 qwen-companion 提供 |

> `readStdin` 在 gemini 中名为 `readStdinIfPiped`(gemini-companion.mjs:443),
> 在 job-control.mjs 中**未直接使用**,由 companion 层处理。

---

## 字面量替换清单(sed 批量改)

grep 结果(共 **5 处**):

| 行号 | 原文 | 替换为 |
|---|---|---|
| 6 | `import { callGeminiStreaming } from "./gemini.mjs"` | `import { callQwenStreaming } from "./qwen.mjs"` |
| 23 | `export const SESSION_ID_ENV = "GEMINI_COMPANION_SESSION_ID"` | `export const SESSION_ID_ENV = "QWEN_COMPANION_SESSION_ID"` |
| 149 | `// Extract Gemini session ID for thread resumption` | `// Extract Qwen session ID for thread resumption` |
| 176 | `* Streaming worker — calls callGeminiStreaming directly instead of CLI re-entry.` | `* Streaming worker — calls callQwenStreaming directly instead of CLI re-entry.` |
| 192 | `const result = await callGeminiStreaming({` | `const result = await callQwenStreaming({` |

- **出现总次数**: 5
- **分布**: 1 处 import 语句、1 处常量声明、1 处注释、1 处 JSDoc、1 处实际调用

可用 sed 一键完成:
```bash
sed -i '' \
  -e 's|callGeminiStreaming|callQwenStreaming|g' \
  -e 's|"./gemini.mjs"|"./qwen.mjs"|g' \
  -e 's|GEMINI_COMPANION_SESSION_ID|QWEN_COMPANION_SESSION_ID|g' \
  -e 's|Gemini session ID|Qwen session ID|g' \
  plugins/qwen/scripts/lib/job-control.mjs
```

---

## 决策

**需要引入的文件清单**:

1. `state.mjs` — 直接从 gemini 拷入 qwen lib,**无 gemini 特有内容**,纯工具函数。
2. `callQwenStreaming` — 需在 `qwen.mjs` 中新增此函数(参考 `gemini.mjs:210` 的实现,改用 `QWEN_BIN`)。

**无需引入的 codex 独有文件**:

经过符号溯源,job-control.mjs 的依赖链为:
- `state.mjs` — gemini lib 自有,非 codex 独有
- `gemini.mjs` → 替换为 `qwen.mjs`

不存在 codex 独有的 `fs.mjs` / `tracked-jobs.mjs` / `workspace.mjs` 依赖。

**Task 2.4 执行顺序建议**:
1. 先拷 `state.mjs` → `plugins/qwen/scripts/lib/state.mjs`(零改动)
2. 在 `qwen.mjs` 中实现 `callQwenStreaming`(核心工作)
3. 拷 `job-control.mjs` 并执行上述 sed 替换(5 处字面量)
4. 更新 `generateJobId` 默认前缀从 `"gj"` 改为 `"qj"`(可选,保持 state.mjs 语义一致)
