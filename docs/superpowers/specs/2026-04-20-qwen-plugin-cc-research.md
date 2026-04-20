---
name: qwen-plugin-cc research report
description: Pre-spec research for building a Claude Code plugin that wraps Qwen Code CLI, aligned with the official `openai-codex` Claude Code plugin template.
type: spec-pre
date: 2026-04-20
author: bing + Claude Code (Opus 4.7)
status: draft — ready to feed into writing-plans skill
---

# qwen-plugin-cc 开发准备报告

## 0. TL;DR（给下一轮 spec 的一页结论）

- **模板是唯一的**：`openai-codex/codex` v1.0.4（已安装在 `~/.claude/plugins/cache/openai-codex/codex/1.0.4/`）。gemini/kimi/minimax 三件套都是按它"字节对齐"拷出来再改，qwen 要继续沿用同一骨架。
- **qwen CLI 能力基本齐活**：已安装 `qwen 0.14.5`，原生支持 one-shot 非交互模式、`--output-format stream-json`、`-c/-r/--session-id`、`--auth-type` 多路认证、`--approval-mode`、MCP、Hooks、Channel、sandbox，功能面甚至比 kimi 宽。
- **最大风险在认证与错误码**：qwen 把 API Error 塞进 assistant text 但仍 `is_error:false`、`exit 0`。探活必须解析 stream-json，不能只看 exit code；这点与 kimi 一致，复用 `hasAssistantTextBlock` 思路即可，但要加 "`[API Error:` 前缀视为失败" 的补丁。
- **认证路径**：OAuth 已官方停用（2026-04-15），主路径是 `qwen auth coding-plan`（阿里云百炼 Coding Plan）或 `--auth-type openai` + API key。本机当前 token 已过期（401）。
- **MVP 建议**：v0.1 复刻 codex 的 7 条命令（`setup/review/adversarial-review/rescue/status/result/cancel`），后续 v0.2 再加 `ask`（gemini/kimi/minimax 都加了 ask，符合"对话型 CLI"形态）。

---

## 1. 模板对齐：openai-codex Claude Code 插件

### 1.1 官方 codex 插件的完整骨架

```
plugins/codex/
├── .claude-plugin/plugin.json            # name/version/description/author
├── CHANGELOG.md
├── LICENSE / NOTICE
├── agents/
│   └── codex-rescue.md                   # 唯一 agent，subagent_type=codex:codex-rescue
├── commands/                              # 7 个斜杠命令
│   ├── setup.md
│   ├── review.md
│   ├── adversarial-review.md
│   ├── rescue.md
│   ├── status.md
│   ├── result.md
│   └── cancel.md
├── skills/                                # 3 个 user-invocable:false 的内部 skill
│   ├── codex-cli-runtime/SKILL.md        # 运行时合约
│   ├── gpt-5-4-prompting/                # prompt 诀窍 + references/*
│   │   ├── SKILL.md
│   │   └── references/{prompt-blocks,codex-prompt-recipes,codex-prompt-antipatterns}.md
│   └── codex-result-handling/SKILL.md    # 输出呈现规则
├── hooks/hooks.json                       # SessionStart / SessionEnd / Stop
├── prompts/
│   ├── stop-review-gate.md
│   └── adversarial-review.md
├── schemas/review-output.schema.json
└── scripts/
    ├── codex-companion.mjs               # 主 dispatcher
    ├── session-lifecycle-hook.mjs
    ├── stop-review-gate-hook.mjs
    ├── app-server-broker.mjs             # Codex 独有：包 Codex MCP app-server
    └── lib/
        ├── app-server.mjs                # Codex 独有
        ├── app-server-protocol.d.ts      # Codex 独有
        ├── broker-endpoint.mjs           # Codex 独有
        ├── broker-lifecycle.mjs          # Codex 独有
        ├── args.mjs
        ├── codex.mjs
        ├── fs.mjs
        ├── git.mjs
        ├── job-control.mjs
        ├── process.mjs
        ├── prompts.mjs
        ├── render.mjs
        ├── state.mjs
        ├── tracked-jobs.mjs
        └── workspace.mjs
```

### 1.2 三件套对 codex 模板的偏差

| 项目 | 命令数 | 特有 | 状态 |
|---|---|---|---|
| **codex (模板)** | 7 | `app-server-broker`（包 Codex MCP app-server）、`prompts.mjs`、`tracked-jobs.mjs`、`workspace.mjs` | 官方 v1.0.4 |
| **gemini-plugin-cc** | **8**（多 `ask.md`） | `prompts.mjs`、无 app-server（直 spawn CLI） | v0.5.2 已实装 |
| **kimi-plugin-cc** | 1（只 setup）| 精简到 `lib/{args,git,kimi,process,render,state}.mjs`，无 `prompts/job-control/tracked-jobs/workspace` | v0.1.0 Phase 1（只落地了 setup） |
| **minimax-plugin-cc** | 8（比 codex 多 `ask`） | 规划了 `prompts.mjs`、单独 `prompts/` 目录 | 仅 spec v4，未落盘代码 |

**结论**：codex 是"完全体 + Codex app-server 额外负担"；gemini 是"完全体 + ask"；kimi 是"Phase 1 精简体"；minimax 是"规划中的完全体 + ask"。**qwen 应以 codex 为字节级对齐目标，ask 命令列为 v0.2**（保留 gemini/minimax 路径）。

---

## 2. Qwen Code CLI 能力清单（本机实测 + 官方源）

> 本机版本：`qwen 0.14.5`，路径 `/opt/homebrew/bin/qwen`。
> 官方仓库：<https://github.com/QwenLM/qwen-code>

### 2.1 基础形态

```
Usage: qwen [options] [command]
Qwen Code - Launch an interactive CLI, use -p/--prompt for non-interactive mode

Commands:
  qwen [query..]          默认一次性执行（位置参数 prompt）
  qwen mcp                管理 MCP servers
  qwen extensions         管理扩展
  qwen auth               认证（qwen-oauth / coding-plan / status）
  qwen hooks              管理 qwen 自身 hooks
  qwen channel            管理消息通道（Telegram、Discord）
```

### 2.2 与插件化相关的关键开关

| 开关 | 作用 | 对标 kimi/codex |
|---|---|---|
| `qwen "prompt"` / `-p "prompt"` | one-shot 非交互 | 对应 codex `exec`、kimi `-p` |
| `-i/--prompt-interactive` | 进入交互模式 | 无需 |
| `-o/--output-format text\|json\|stream-json` | 输出格式 | **与 kimi 一致**，stream-json 事件结构近乎相同 |
| `--input-format text\|stream-json` | 输入格式 | kimi 无 |
| `-c/--continue` | 恢复最近 session | 对应 codex `--resume-last`、kimi 暂无 |
| `-r/--resume [id]` | 按 ID 恢复 | codex 有 |
| `--session-id` | 指定 session id | codex 有 |
| `--max-session-turns` | 单次最大步数 | kimi `--max-steps-per-turn` 近似 |
| `--approval-mode plan\|default\|auto-edit\|yolo` | 权限模式 | codex `--approval-policy` 近似 |
| `-y/--yolo` | 等效 yolo | 慎用 |
| `-s/--sandbox` + `--sandbox-image` | 沙箱 | codex 有 |
| `--auth-type openai\|anthropic\|qwen-oauth\|gemini\|vertex-ai` | 认证类型 | 独特，qwen 是多路混合网关 |
| `--openai-api-key` / `--openai-base-url` | OpenAI 兼容走第三方模型 | 独特 |
| `-m/--model` | 指定模型 | 都有 |
| `--system-prompt` / `--append-system-prompt` | 覆盖/追加系统提示 | kimi/codex 无 |
| `--chat-recording` | 关掉则 `-c/-r` 失效 | 关键：决定会话恢复可用性 |
| `--channel VSCode\|ACP\|SDK\|CI` | 运行通道（影响事件流） | 独特 |
| `--allowed-tools` / `--exclude-tools` / `--core-tools` | 工具白/黑名单 | 都有 |
| `--include-directories` / `--add-dir` | 追加工作目录 | codex 有 |
| `--acp` | ACP mode（Agent Client Protocol） | 独特；可能给 `rescue` 一条 stream 兼容路径 |
| `--experimental-lsp` | LSP 代码智能 | 不用 |

### 2.3 stream-json 事件结构（本机抓取）

一次 `qwen -p "ping" --output-format stream-json --max-session-turns 1`：

```jsonl
{"type":"system","subtype":"init","uuid":"...","session_id":"...","cwd":"...","tools":[...],"mcp_servers":[],"model":"qwen3.6-plus","permission_mode":"yolo","slash_commands":[...],"qwen_code_version":"0.14.5","agents":[...]}
{"type":"assistant","uuid":"...","session_id":"...","parent_tool_use_id":null,"message":{"id":"...","type":"message","role":"assistant","model":"qwen3.6-plus","content":[{"type":"text","text":"[API Error: 401 invalid access token or token expired]"}],"stop_reason":null,"usage":{...}}}
{"type":"result","subtype":"success","uuid":"...","session_id":"...","is_error":false,"duration_ms":4040,"num_turns":1,"result":"[API Error: 401 invalid access token or token expired]","usage":{...},"permission_denials":[]}
```

**重要发现**：
1. 结构与 kimi 高度相似（`type=system/init` + `type=assistant` + `type=result`），可直接复用 `hasAssistantTextBlock` 的解析器，只需把 `event.role` 改为 `event.message?.role`。
2. **API 错误不影响 exit code 与 `is_error` 字段**——`is_error:false` 但 assistant text 是 `[API Error: ...]`，`result` 字段也抄进去了。这是 qwen 独有坑，必须：
   - 认证探活：检测 assistant text 里是否以 `[API Error:` 开头。
   - `result` 字段用 `result.is_error || /^\[API Error:/.test(result.result)` 双重判定。
3. `session_id` 直接在 stream-json 事件里拿到，不需要像 kimi 那样从 stderr regex 抓。
4. `mcp_servers` 空数组时说明用户没接 MCP，与 kimi 一致。

### 2.4 认证矩阵（现状）

| 方式 | 命令 | 状态 |
|---|---|---|
| OAuth | `qwen auth qwen-oauth` | **官方已于 2026-04-15 停用**（见 GitHub README） |
| 阿里云 Coding Plan | `qwen auth coding-plan` | **当前推荐**，本机已配置但 token 过期（401） |
| API Key | `--openai-api-key` / `--openai-base-url` 或 settings.json | 适合 CI/headless |
| Anthropic/Gemini/Vertex | `--auth-type anthropic/gemini/vertex-ai` | 用自家 key 打到 Qwen 兼容网关 |

配置落盘位置：`~/.qwen/{settings.json, oauth_creds.json, projects/, skills/}`（与 `~/.claude/` 布局几乎一致）。

探活命令（建议）：

```bash
qwen auth status           # 结构化文本，不足以证明 token 未过期
qwen -p "ping" --output-format stream-json --max-session-turns 1
# 解析 assistant.message.content[].text；非 [API Error:...] 且 result.is_error=false 才算通过
```

### 2.5 已识别的 UX 异常 / 坑

1. **`-p` 已标 deprecated**——官方推荐用位置参数 `qwen "prompt"`；但 `-p` 目前仍可用，companion 里两种都支持，向上兼容。
2. **`--chat-recording` 默认值取决于 settings**——如果用户关闭了 chat recording，`--continue`/`--resume` 无效，`rescue --resume` 会哑火。companion 在 `setup` 里最好检测并提示。
3. **`permission_mode: "yolo"`** 出现在 init 事件——本机 `settings.json` 已经给 qwen 自动批准；给用户的安全提示要写清楚。
4. **`slash_commands`** 在 qwen 自身也有（`/btw /bug /compress /context /init /qc-helper /review /summary`）。我们给 Claude Code 侧的 `/qwen:review` 不冲突，但要在 docs 里解释"别把 Claude 斜杠命令和 qwen 内部斜杠命令弄混"。
5. **`channel`** 子命令名和 `--channel` 开关同名——别让 companion 误解析。
6. **Homebrew 版可能滞后**：`brew install qwen-code` 装的是 0.14.5；官方 README 可能推 npm 版（@qwen-code/qwen-code@latest）。插件 setup 的安装器要至少支持 `npm`、`brew`、`curl shell`（三路）。

---

## 3. 插件开发拆分建议

### 3.1 复制 vs 改写（参考 minimax spec 的表格法）

| 类别 | 文件 | 说明 |
|---|---|---|
| **字节对齐复制** | `scripts/lib/{args,git,process,fs,workspace}.mjs`、`schemas/review-output.schema.json`、`hooks/hooks.json`、`prompts/*` | 纯工具；只要把 codex 字样保留即可。schema 与 prompts 的字样 codex 里也是偏通用的，不含 Codex 独有术语。 |
| **轻度改写**（改路径常量 + 名称） | `scripts/lib/{state,render,tracked-jobs,prompts}.mjs`、`scripts/lib/job-control.mjs`、`scripts/session-lifecycle-hook.mjs`、`scripts/stop-review-gate-hook.mjs` | 把 `codex_companion_session_id` env、`.codex/` 目录、字面量 "Codex" → "Qwen"。 |
| **重写**（CLI 差异） | `scripts/lib/qwen.mjs`（对应 codex.mjs） | 走 qwen 位置参数 + stream-json；认证探活自行处理 API Error 字符串；session 复用逻辑基于 `--continue/--resume`。 |
| **删除 / 替换** | `scripts/lib/{app-server,app-server-protocol.d.ts,broker-endpoint,broker-lifecycle}.mjs`、`scripts/app-server-broker.mjs` | Codex 的 MCP app-server 包壳在 qwen 用不上，直接 `child_process.spawn` 就够。 |
| **新写**（对应命令与 skill） | 7 个 `commands/*.md`、1 个 `agents/qwen-rescue.md`、3 个 `skills/`（`qwen-cli-runtime`、`qwen-prompting`、`qwen-result-handling`） | 字样全换 qwen；prompting skill 里换掉 GPT-5.4 的特有建议，改成 qwen3.6 的（见 §3.3）。 |

### 3.2 命令清单 v0.1（对齐 codex 7 条）

| 命令 | 与 codex 的差异点 | 关键开关 |
|---|---|---|
| `/qwen:setup` | 多一份 auth-type 下拉；安装器候选：npm/brew/curl | `--enable-review-gate` / `--disable-review-gate` |
| `/qwen:review` | 子命令用 `qwen "{prompt}"` + stream-json；无 `--resume`；用 `review-output.schema.json`（同 codex） | `--wait\|--background`、`--base`、`--scope auto\|working-tree\|branch` |
| `/qwen:adversarial-review` | 同上，prompt 文本带挑战框架 | + focus text |
| `/qwen:rescue` | 走 agent `qwen-rescue`，接 `--resume/--fresh`；qwen 原生支持 `-c`，比 kimi 好做 | `--background/--wait`、`--resume/--fresh`、`--model`、`--effort`（qwen 无 effort，映射到 `--approval-mode` 或忽略） |
| `/qwen:status` | 渲染 markdown 表；job 元数据结构照抄 codex | `[job-id]` `--wait` `--timeout-ms` `--all` |
| `/qwen:result` | 同 codex | `[job-id]` |
| `/qwen:cancel` | 用 `SIGINT` 中断 child；qwen 不像 codex 有 app-server 的中断 API | `[job-id]` |

### 3.3 prompting skill 的差异（v0.2 可继续打磨）

Codex 的 `gpt-5-4-prompting` 是"给 GPT-5.4 的 prompt 诀窍"，建议改为 `qwen-prompting`，内容保留 XML 标签式骨架（qwen3.6 对 XML prompt 很友好），但删掉 codex 专属的 `<completeness_contract>` 细节，加入：
- qwen3.6 的 **中英混写表现稳定**，中文 prompt 也能拿到结构化输出；对比 Codex 建议全英文。
- qwen3.6 自带 `--system-prompt`，可以把 review schema 直接塞 system 而不靠 user prompt。
- qwen 的 `mcp_servers` 为空时，`file_read`/`shell` 之类的 Claude 侧工具不会透传过去——prompting skill 要说清楚"review 模式下不要让 qwen 去摸文件"。

### 3.4 hook 的两个用途（沿用 codex/minimax 方案）

- `session-lifecycle-hook.mjs`：SessionStart/SessionEnd 时写 state 目录，供 `--resume-last` 找会话。
- `stop-review-gate-hook.mjs`：可选的 Stop-hook review（`--enable-review-gate`）。qwen 流式输出足够稳定，review-gate 可按 codex 原样做。

---

## 4. 开发阶段建议

> 对齐 minimax spec 的阶段划分方式，更接近 codex 的完成度。

### Phase 0 · 探针验证（半天）

- ✅ 已完成：本机 `qwen --help`、`qwen auth status`、`qwen -p "ping" --output-format stream-json` 抓样本。
- 待做：
  - 把 `[API Error:...]` 错误做一组断言样本（token 过期、模型不存在、超时各一条）存到 `doc/probe/probe-results.json`。
  - 抓一次 `qwen -p "explain this diff" --output-format stream-json` 在真有 diff 场景下的事件流，验证 `message.content` 的 `tool_use` / `tool_result` 块结构是否与 kimi 一致。
  - 测 `--continue`：跑两次带 `--session-id=foo` 的 prompt，看第二次能否恢复。

### Phase 1 · Setup（1 天）

完全照 kimi Phase 1 的做法：只实现 `commands/setup.md` + `scripts/qwen-companion.mjs setup`。产物：
- `getQwenAvailability` → `qwen -V`
- `getQwenAuthStatus` → 运行 ping，解析 stream-json
- `detectInstallers` → npm / brew / curl
- JSON 输出：`{installed, version, authenticated, authDetail, authMethod (coding-plan/openai/...), model, chat_recording_enabled, installers}`

### Phase 2 · Rescue + Skills（2 天）

- 写 `agents/qwen-rescue.md`、`skills/qwen-cli-runtime`、`skills/qwen-prompting`、`skills/qwen-result-handling`。
- `scripts/qwen-companion.mjs task` 支持 foreground + background + `--resume-last`。
- `scripts/lib/tracked-jobs.mjs` 字节复制自 codex，`state.mjs` 改 env/路径常量。

### Phase 3 · Review 系 + schemas/prompts（2 天）

- `scripts/qwen-companion.mjs review` / `adversarial-review`。
- `schemas/review-output.schema.json` 字节复制 codex。
- `prompts/{stop-review-gate,adversarial-review}.md` 轻度改字。

### Phase 4 · status/result/cancel + hooks（1 天）

- 全部照抄 codex。`cancel` 用 `terminateProcessTree`；qwen 子进程无 MCP app-server 可关，所以比 codex 简单。

### Phase 5 · ask（v0.2，可选）

- 对齐 gemini/minimax 的 `ask.md`。qwen 位置参数跑 text 输出即可。

---

## 5. 开发前 must-have 清单

- [ ] 重登 `qwen auth coding-plan` 让本机 token 有效，避免探针阶段全是 401。
- [ ] 确认 `~/.qwen/settings.json` 里 `chatRecording` 开启（否则 rescue 的 `--resume-last` 不可用）。
- [ ] 拷一份 codex 插件到 `plugins/qwen/` 的 scaffold（只保留目录骨架 + 空文件），作为后续改写的基线。
- [ ] 写 `lessons.md` 开头框架，记录"qwen is_error 字段不可信"这一类关键差异。
- [ ] 仓库初始化：`marketplace.json`（抄 kimi 版）、`CLAUDE.md`、`CHANGELOG.md`、`.gitignore`。

---

## 6. 参考来源（Sources）

- [QwenLM/qwen-code — GitHub 主仓](https://github.com/QwenLM/qwen-code)
- [qwen-code README](https://github.com/QwenLM/qwen-code/blob/main/README.md)
- [Qwen Code Configuration docs](https://www.zdoc.app/en/QwenLM/qwen-code/blob/main/docs/cli/configuration.md)
- [Qwen Code Troubleshooting](https://qwenlm.github.io/qwen-code-docs/en/users/support/troubleshooting/)
- [Qwen Code CLI Install Guide 2026](https://a2a-mcp.org/blog/qwen-cli-install)
- [Qwen Code CLI — TrueFoundry 接入文档](https://www.truefoundry.com/docs/ai-gateway/qwen-cli)
- [Qwen Code CLI: A Guide With Examples — DataCamp](https://www.datacamp.com/tutorial/qwen-code)
- 本机参考：`~/.claude/plugins/cache/openai-codex/codex/1.0.4/`（模板）
- 姊妹仓库：`/Users/bing/-Code-/{gemini,kimi,minimax}-plugin-cc/`（三件套对齐样本）
