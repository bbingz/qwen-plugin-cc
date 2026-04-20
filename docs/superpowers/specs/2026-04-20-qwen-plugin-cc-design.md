# qwen-plugin-cc 设计文档

**日期**:2026-04-20
**作者**:bing + Claude Code(Opus 4.7)
**状态**:草稿 v1,待 3-way review(Claude + Codex + Gemini)
**仓库**:`/Users/bing/-Code-/qwen-plugin-cc/`(独立仓库,git init 完毕)
**姊妹工程**:
- 模板:`openai-codex/codex` v1.0.4(官方)
- 对齐样本:`gemini-plugin-cc` v0.5.2(已实装)、`kimi-plugin-cc` v0.1.0(Phase 1 已实装,Phase 2+ 开发中)、`minimax-plugin-cc` v0.1(spec 已定 plan 未执行)

---

## 1. 目标与范围

### 1.1 做什么

把 `openai-codex` Claude Code 插件的形态**字节对齐**移植到 `qwen-plugin-cc`,底层 CLI 由 `codex` 换成 **QwenLM/qwen-code**(阿里云 Qwen Code,Coding Plan / OAuth / API Key 三路认证)。Claude Code 里用户能用 `/qwen:setup`、`/qwen:rescue`、`/qwen:review` 等命令调用 qwen3.6-plus 等模型,用法和 `/codex:*` 一一对应。

这是 agent-plugin-cc 四件套的第四件——gemini / kimi / minimax / qwen。

**底层 CLI 选型**:直接用 `qwen` CLI(Qwen Code,v0.14.5+)的 `qwen [prompt] --output-format stream-json` 非交互模式。不用 DashScope 裸 HTTPS(无 agent 运行时)。

### 1.2 交付物(v0.1)

- **7 个命令**:`setup` / `review` / `adversarial-review` / `rescue` / `status` / `result` / `cancel`(对齐 codex,不含 `ask`)
- **3 个 skill**:`qwen-cli-runtime`(内部合约)/ `qwen-prompting`(prompt 诀窍)/ `qwen-result-handling`(输出呈现)
- **1 个 agent**:`qwen-rescue.md`(`subagent_type=qwen:qwen-rescue`)
- **2 个 hook**:`session-lifecycle-hook.mjs` + `stop-review-gate-hook.mjs`
- **1 个 JSON schema**:`schemas/review-output.schema.json`(字节复制 codex)
- **独立 git 仓库**,自带 `marketplace.json`(`qwen-plugin`)
- **`lessons.md`**:qwen 相对 gemini/kimi/codex 的差异点
- **`CHANGELOG.md`**:跨 AI 协作日志(reverse-chrono,flat,含 status 字段)

### 1.3 不做(v0.1 明确排除)

- 不做 `/qwen:ask` 命令(v0.2 再加,对齐 gemini/minimax 形态)
- 不做 per-command 切模型(默认不传 `-m`,用户在 `~/.qwen/settings.json` 改)
- 不做实时事件流 UX(foreground 走 stdout 透传即可)
- 不做 Engram sidecar(无对应路径映射)
- 不做 GitHub Actions CI(v0.2)
- 不做 review JSON parse 失败的多次自适应 retry,v0.1 固定 1 次强化 prompt retry
- 不接管 qwen 自身的 `qwen hooks` / `qwen channel` 子命令(各自独立生态)

### 1.4 成功标准

- 在已装 `qwen 0.14.5+` 并完成 `qwen auth coding-plan` 的机器上:
  `claude plugins add ./plugins/qwen` → `/qwen:setup` 报 `authenticated: true` → `/qwen:rescue --wait "hello"` 返回文本 → `/qwen:review` 对小 diff 产出符合 schema 的 JSON
- `lessons.md` ≥ 5 条 qwen/kimi/gemini/codex 差异
- §6.5 T-checklist 的 T1、T2、T4、T5、T6、T7、T8、T9、T10、T12 通过

---

## 2. 仓库布局

### 2.1 根目录

```
qwen-plugin-cc/
├── .claude-plugin/marketplace.json
├── plugins/qwen/                          # 见 §2.2
├── doc/probe/                             # Phase 0 探针样本
│   └── probe-results.json
├── docs/superpowers/
│   ├── specs/2026-04-20-qwen-plugin-cc-design.md    # 本文
│   ├── specs/2026-04-20-qwen-plugin-cc-research.md  # 前置调研
│   └── plans/                             # writing-plans 生成
├── README.md
├── CLAUDE.md                              # 工作目录级指令
├── CHANGELOG.md                           # 跨 AI 协作日志
├── lessons.md                             # 迁移经验
└── .gitignore
```

### 2.2 `plugins/qwen/` 内部(与 `plugins/codex` / `plugins/gemini` 一一对照)

```
plugins/qwen/
├── .claude-plugin/plugin.json
├── CHANGELOG.md
├── commands/                               # 7 条
│   ├── setup.md
│   ├── review.md
│   ├── adversarial-review.md
│   ├── rescue.md
│   ├── status.md
│   ├── result.md
│   └── cancel.md
├── agents/
│   └── qwen-rescue.md                      # subagent_type=qwen:qwen-rescue
├── skills/                                  # 3 个,均 user-invocable:false
│   ├── qwen-cli-runtime/SKILL.md
│   ├── qwen-prompting/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── qwen-prompt-recipes.md
│   │       ├── qwen-prompt-antipatterns.md
│   │       └── prompt-blocks.md
│   └── qwen-result-handling/SKILL.md
├── hooks/hooks.json                        # SessionStart/SessionEnd/Stop
├── prompts/
│   ├── stop-review-gate.md
│   └── adversarial-review.md
├── schemas/review-output.schema.json       # 字节复制 codex
└── scripts/
    ├── qwen-companion.mjs                   # 主 dispatcher
    ├── session-lifecycle-hook.mjs           # 抄 codex + 改 env/路径
    ├── stop-review-gate-hook.mjs            # 抄 codex + 改 env/路径
    └── lib/                                # 整套 gemini 血统(8 文件,无 tracked-jobs/workspace/fs;能力内嵌在 job-control)
        ├── args.mjs                        # 纯复制
        ├── process.mjs                     # 纯复制
        ├── git.mjs                         # 纯复制
        ├── state.mjs                       # 改 env 名 + 补 $CLAUDE_PLUGIN_DATA 支持(对齐 codex 命名)
        ├── job-control.mjs                 # 字节复制 gemini 版(已内嵌 job/tracked/workspace 能力)
        ├── render.mjs                      # 改 Qwen 字样
        ├── prompts.mjs                     # 模板加载,轻改
        └── qwen.mjs                        # 从零写:qwen CLI spawn、认证、stream-json 解析、proxy 注入
```

注:codex 模板把 job/tracked/workspace/fs 拆成 4 个文件,gemini 合并为 1 个 `job-control.mjs`(17.4K)+ `state.mjs`(7K)两文件;既然 §1 选择复制 gemini 的 job-control,就整套走 gemini 血统,不再混入 codex 的 tracked-jobs/workspace/fs。

### 2.3 手工改写 vs 几乎纯复制 的分界

| 类别 | 文件 | 备注 |
|---|---|---|
| **字节复制**(自 gemini) | `scripts/lib/{args,process,git,job-control}.mjs`、`schemas/review-output.schema.json`(来自 codex) | gemini 的 job-control 已内嵌 codex 的 tracked-jobs/workspace 能力 |
| **轻度改写**(常量/字样) | `scripts/lib/{state,render,prompts}.mjs`、`scripts/session-lifecycle-hook.mjs`、`scripts/stop-review-gate-hook.mjs`、`prompts/*` | 把 `GEMINI_*` env、`gemini-companion` 字面量替换为 `QWEN_*` / `qwen-companion`;`state.mjs` 额外补 `$CLAUDE_PLUGIN_DATA` 支持(对齐 codex) |
| **重写**(CLI 差异) | `scripts/lib/qwen.mjs`(对应 gemini 的 `gemini.mjs` / codex 的 `codex.mjs`) | 位置参数 + stream-json + `--continue/--resume`;认证探活处理 `[API Error:`;proxy 注入 |
| **不引入** | codex 独有的 `scripts/app-server-broker.mjs`、`scripts/lib/{app-server,app-server-protocol.d.ts,broker-endpoint,broker-lifecycle,tracked-jobs,workspace,fs}.mjs` | Codex MCP app-server 包壳 + 已合并到 gemini job-control 的文件 |
| **从零写**(对应命令与 skill) | 7 个 `commands/*.md`、1 个 `agents/qwen-rescue.md`、3 个 `skills/*/SKILL.md`、2 个 `prompts/*.md` | 全换 qwen 字样;prompting skill 换 qwen3.6 特性 |

### 2.4 命名对齐

| 要素 | codex(官方) | gemini(bing) | kimi(bing) | **qwen** |
|---|---|---|---|---|
| marketplace | `openai-codex` | `gemini-plugin` | `kimi-plugin` | `qwen-plugin` |
| owner | OpenAI | bing | bing | bing |
| plugin 名 | `codex` | `gemini` | `kimi` | `qwen` |
| source | `./plugins/codex` | `./plugins/gemini` | `./plugins/kimi` | `./plugins/qwen` |
| Session env | `CODEX_COMPANION_SESSION_ID` | `GEMINI_COMPANION_SESSION_ID` | `KIMI_COMPANION_SESSION_ID` | `QWEN_COMPANION_SESSION_ID` |
| State 根目录 | `$CLAUDE_PLUGIN_DATA` 或 `$TMPDIR/codex-companion/` | `$TMPDIR/gemini-companion/` | (未涉及) | `$CLAUDE_PLUGIN_DATA` 或 `$TMPDIR/qwen-companion/` |
| Subagent | `codex:codex-rescue` | `gemini:gemini-agent` | n/a | `qwen:qwen-rescue`(沿用 codex `-rescue`,不用 gemini `-agent`) |
| 斜杠命令 | `/codex:*` | `/gemini:*` | `/kimi:*` | `/qwen:*` |

---

## 3. 组件职责

### 3.1 Companion 主脚本 `scripts/qwen-companion.mjs`

单一 Node 入口,dispatcher 按子命令分发:

| 子命令 | 作用 | 关键产物 |
|---|---|---|
| `setup` | 探测安装、认证、proxy、chat_recording | JSON 状态 |
| `review` | 对工作区/分支 diff 做标准 review | JSON(符合 schema) |
| `adversarial-review` | review 加挑战性 prompt 框架 | 同上 |
| `task` | rescue 用;foreground/background spawn | stdout 透传 |
| `task-resume-candidate` | `/qwen:rescue` 决策"续/新" | `{available: bool}` |
| `status` | 列 job / 单 job 详情 | markdown 表 |
| `result` | 取已完成 job 的最终输出 | 存档 JSON 负载 |
| `cancel` | 终止 background 子进程 | 状态转移报告 |

### 3.2 三个 skill(均 `user-invocable: false`)

- **`qwen-cli-runtime`**:`qwen:qwen-rescue` 的内部合约。规定"只调 `task` 一次、剥离路由 flag、默认加什么、`--resume`/`--fresh` 映射"。等同 codex `codex-cli-runtime`。
- **`qwen-prompting`**:qwen3.6 的 prompt 诀窍 + `references/`。与 codex `gpt-5-4-prompting` 同构,内容改写为 qwen3.6 特性(中英混写稳、`--system-prompt` 塞 schema、`mcp_servers` 空时不让它摸文件)。
- **`qwen-result-handling`**:Claude 拿到 qwen stdout 后怎么呈现:保留 verdict/findings/next-steps 结构、review 后 STOP、malformed 时给 stderr tail。字节复制 codex 版后改字。

### 3.3 Agent `agents/qwen-rescue.md`

薄转发器:
- `subagent_type: qwen:qwen-rescue`, `tools: Bash`, `skills: [qwen-cli-runtime, qwen-prompting]`
- 一次 `Bash` 调 `qwen-companion task ...`,stdout 原样返回
- `--effort` 透传但 companion 层丢弃
- `--model` 默认不传
- 默认加 `--approval-mode yolo`(保证 background 不卡)
- `--resume` → qwen `-c` 或 `-r <session-id>`,`--fresh` → 不传

### 3.4 命令 `commands/*.md`(7 个)

Frontmatter 对齐 codex,关键差异:
- `setup.md`:安装候选动态(npm / brew / curl shell);未认证提示 `! qwen auth coding-plan`。
- `review.md` / `adversarial-review.md`:`--wait|--background`、`--base <ref>`、`--scope auto|working-tree|branch`;大小估算靠 git 侧逻辑;`AskUserQuestion` 一次选执行模式。
- `rescue.md`:走 Agent 工具启动子代理;`task-resume-candidate` 决定是否先问"续/新"。
- `status.md` / `result.md` / `cancel.md`:纯 Bash passthrough,Claude 只做格式化。

### 3.5 Hooks

| Hook | 脚本 | 作用 |
|---|---|---|
| `SessionStart` | `session-lifecycle-hook.mjs` | 写 session id 到 state |
| `SessionEnd` | `session-lifecycle-hook.mjs` | 归档 |
| `Stop` | `stop-review-gate-hook.mjs` | 可选 stop-time review 闸门;默认关闭,`/qwen:setup --enable-review-gate` 打开 |

### 3.6 Schema & Prompts

- `schemas/review-output.schema.json`:字节复制 codex。
- `prompts/stop-review-gate.md`、`prompts/adversarial-review.md`:轻度改字。

---

## 4. 数据流

### 4.1 典型调用链(`/qwen:rescue --background "fix flaky test"`)

```
Claude Code
  └─► /qwen:rescue 命令 (commands/rescue.md)
        └─► Agent(subagent_type=qwen:qwen-rescue)
              └─► Bash: node qwen-companion.mjs task --background --approval-mode yolo "fix flaky test"
                    ├─► [companion 进程]
                    │     ├─ 读 ~/.qwen/settings.json → 取 proxy
                    │     ├─ 读 env CLAUDE_PLUGIN_DATA → state 目录
                    │     ├─ generateJobId, 写 jobs/<id>.json (status=running)
                    │     └─► spawn qwen (位置参数 prompt) --output-format stream-json
                    │           └─ ChildProcess  ──── stream-json stdout ──┐
                    │     ← 解析 init 事件,抓 session_id 写 job.json       │
                    │     ← 解析 assistant,累积到 job log / 透传 stdout   │
                    │     ← 解析 result,判终(§5.1)←─────────────────────┘
                    │     └─► detach 返回 "Job queued: <jobId>"
                    └─► Claude: "Qwen rescue started; check /qwen:status"
```

后续 `/qwen:status|result|cancel` 读 `$CLAUDE_PLUGIN_DATA/state/<slug-hash>/jobs/<jobId>.json` 或发信号给 pid。

### 4.2 Spawn qwen 的参数装配(`qwen.mjs` 核心)

```js
const args = [];
if (sessionId)      args.push("--session-id", sessionId);
else if (resumeLast) args.push("-c");
else if (resumeId)   args.push("-r", resumeId);

args.push("--output-format", "stream-json");
args.push("--approval-mode", approvalMode || "yolo");
args.push("--max-session-turns", String(maxSteps));
if (appendSystem) args.push("--append-system-prompt", appendSystem);
if (appendDirs)   args.push("--include-directories", appendDirs.join(","));

const env = buildSpawnEnv(userSettings);  // §4.3
args.push(prompt);                         // 位置参数;-p 已 deprecated

spawn("qwen", args, { env, cwd });
```

### 4.3 Proxy 注入

qwen 交互模式读 `~/.qwen/settings.json::proxy`,headless 不读,导致 `/qwen:rescue` 401。Companion 补丁:

```js
function buildSpawnEnv(userSettings) {
  const env = { ...process.env };
  const proxy = userSettings?.proxy;
  if (proxy && !env.HTTP_PROXY)  env.HTTP_PROXY  = proxy;
  if (proxy && !env.HTTPS_PROXY) env.HTTPS_PROXY = proxy;
  if (!env.NO_PROXY) env.NO_PROXY = "localhost,127.0.0.1";
  return env;
}
```

Setup 报告返回 `proxyInjected: true|false`,`/qwen:setup` 告知用户。

### 4.4 Stream-json 消费(`qwen.mjs::parseStream`)

按行 JSON 解析,三类事件:

| 事件 | 用途 |
|---|---|
| `type=system, subtype=init` | 抓 `session_id` 写 job.json;记录 `model`/`tools`/`mcp_servers` 元数据 |
| `type=assistant` | 追加到 job.log(bg)或透传 stdout(fg);检测 `message.content[].text` 以 `[API Error:` 开头 → 置 `apiError=true` |
| `type=result` | 判终:§5.1 四层检测任一红 → `status=failed + failure.kind` |

### 4.5 Authentication 探活(`setup` 子命令)

```
setup
  ├─ qwen -V                                      → installed?
  ├─ qwen auth status(解析文本)                   → authMethod
  ├─ 读 ~/.qwen/settings.json                      → chatRecording, proxy, model
  ├─ buildSpawnEnv() + spawn qwen "ping" --output-format stream-json --max-session-turns 1
  │    ├─ 四层判错
  │    └─ 成功 → authenticated=true, model 从 init 事件拿
  └─ 汇总 JSON:
     { installed, version, authenticated, authDetail, authMethod,
       model, configured_models, chatRecording, proxyInjected,
       installers: { npm, brew, shellInstaller } }
```

### 4.6 State 目录(对齐 codex)

```
$CLAUDE_PLUGIN_DATA/state/<workspace-slug>-<sha256[:16]>/
  ├─ state.json          # { version, config: {stopReviewGate}, jobs: [...] }
  └─ jobs/
      └─ <jobId>.json    # { jobId, kind, status, phase, pid, sessionId,
                         #   startedAt, finishedAt, cwd, prompt,
                         #   logPath, result, failure }
```

Workspace 指纹由 `resolveWorkspaceRoot + sha256` 决定;`MAX_JOBS=50` 滚动清理。

---

## 5. 错误处理

### 5.1 四层判错(qwen 独有"成功包失败")

qwen 把 API 失败塞 assistant text 且返回 `exit 0 + is_error:false`。Companion 必须翻译:

```js
function detectFailure(result, assistantTexts) {
  if (result.exitCode !== 0) return { failed: true, kind: "exit", code: result.exitCode };
  if (result.event?.is_error === true) return { failed: true, kind: "qwen_is_error" };
  if (/^\[API Error:/.test(result.event?.result ?? ""))
    return { failed: true, kind: "api_error", message: result.event.result };
  const errLine = assistantTexts.find(t => /^\[API Error:/.test(t));
  if (errLine) return { failed: true, kind: "api_error", message: errLine };
  return { failed: false };
}
```

### 5.2 错误分类表

| kind | 触发 | `/qwen:result` 输出 | 建议动作 |
|---|---|---|---|
| `not_installed` | `qwen -V` 失败 | "qwen not found on PATH" | `/qwen:setup` 选 npm/brew/curl |
| `not_authenticated` | ping 报 `[API Error: 401`、`qwen auth status` 未登录 | 建议 `! qwen auth coding-plan` | 用户手动,再 `/qwen:setup` |
| `proxy_required` | ping 失败 + `settings.proxy` 存在 + user env 已有冲突的 `HTTP_PROXY` 导致 companion 未覆盖(§4.3 策略) | "检测到 settings 与 env 的 proxy 不一致" | 手动对齐 env 或清 env |
| `chat_recording_disabled` | 请求 `-c/-r` 但 settings 关了 | "chat recording 关闭" | 打开或走 `--fresh` |
| `api_error` | §5.1 层 3/4 | 原样回显 `[API Error: ...]` | 401:重登;429:降模型/等;5xx:重试 |
| `qwen_is_error` | `is_error:true` | qwen 自己的 stderr tail | 透传 |
| `spawn_error` | ENOENT/EPERM | companion 错误 | 透传 |
| `timeout` | 子进程超 `DEFAULT_TIMEOUT_MS` | "timed out after Ns" | `/qwen:cancel` 示范 |
| `cancelled` | 用户 `/qwen:cancel` | "cancelled by user at <ts>" | 无 |
| `schema_violation` | review 输出不匹配 schema | "schema 校验失败"+ 两次 raw 头 4KB | 换模型或 `/qwen:rescue` 兜底 |

### 5.3 Review JSON parse 失败兜底

1. 正常 prompt + `--append-system-prompt` 塞 schema
2. parse/ajv 失败 → 一次 retry,prompt 追加:`Previous output was not valid JSON for the review-output schema. Output ONLY the JSON document, no prose, no code fences.`
3. 仍失败 → `schema_violation`,raw 两次前 4KB

v0.2 再扩多次自适应。

### 5.4 Background job 状态机

```
queued ─► running ─► completed
                ├──► failed       (§5.1 任一层红)
                ├──► cancelled    (cancel 或 SIGTERM)
                └──► timeout      (companion 监护超时)
```

Companion 独占写 `jobs/<id>.json`(单 writer,atomic rename);`/qwen:status` 只读。pid 存活探测:不活则标 `failed+kind=orphan`。

### 5.5 Cancel 原子性

对 pgid 发:`SIGINT`(2s) → `SIGTERM`(2s) → `SIGKILL`;每步 `try/catch ESRCH`;最后写 `status=cancelled`。

### 5.6 失败不自动治愈

任何错误:companion 只报不自动重跑 rescue、不自动改配置、不超出 §5.3 的 1 次 retry。Claude 侧对 review findings 也禁止自动改代码,必须先问用户(由 `qwen-result-handling` 强制)。

---

## 6. 测试与验收

### 6.1 分层

| 层 | 工具 | 跑法 | 覆盖 |
|---|---|---|---|
| 探针 | `doc/probe/*.sh` + `probe-results.json` | Phase 0 手跑 | stream-json 真实结构、401/timeout/schema 错 |
| 单元 | `node:test` | `node --test scripts/lib/*.test.mjs` | args、qwen.mjs 解析、四层判错、proxy 注入、state slug/hash |
| 集成 | fixture + `PATH` 前置 mock-bin | `node --test tests/integration/*.test.mjs` | companion 全子命令 |
| 端到端 | 本机 Claude Code + 真 qwen | T-checklist 手跑 | 贯穿 `/qwen:setup` → rescue → status → result |

### 6.2 探针必抓 case

1. 正常 ping
2. 认证过期(撤销 token)
3. 模型不存在(`-m qwen-fake`)
4. 超时(长任务 + companion 强制超时)
5. `--continue` 恢复会话
6. `--session-id abc` 指定固定 id
7. review 场景(喂 diff 要 JSON 输出)raw

每条存 `doc/probe/probe-results.json`,单元测试作为 fixture 消费。

### 6.3 关键单元测试

`scripts/lib/qwen.test.mjs`:
- 三重判错的八组合
- `[API Error: 401` 首行时 apiError=true
- 多行 JSONL 空行/坏行 parser 不崩
- init 事件的 session_id 写到 job
- proxy env 注入:settings 有 + user env 无 → 注入;user env 已有 → 不覆盖

`scripts/lib/state.test.mjs`:
- slug+hash 幂等
- `MAX_JOBS=50` 滚动
- 并发写 atomic rename

`scripts/lib/args.test.mjs`:
- 带引号/空格/转义的解析
- `--effort/--model/--resume/--fresh/--background/--wait` 识别+剥离

### 6.4 集成测试

`tests/fixtures/mock-bin/qwen` 按 `QWEN_MOCK_CASE` env 输出 fixture。PATH 前置 mock-bin:

```bash
PATH="$PWD/tests/fixtures/mock-bin:$PATH" \
QWEN_MOCK_CASE=api-error-401 \
node scripts/qwen-companion.mjs setup --json
```

覆盖:
- `setup` 四态(未装 / 未认证 / 认证但 chat_recording 关 / 全好)
- `task` foreground 成功 + §5.1 各 kind 失败
- `task --background` 生命周期(running → status → result)
- `cancel` 对 running 的状态转移
- review 的 JSON parse 成功/retry/失败 × 2

### 6.5 T-checklist(端到端手动)

| # | 场景 | 通过判据 | 必过 |
|---|---|---|---|
| T1 | `claude plugins add ./plugins/qwen` | 命令可见 | ✓ |
| T2 | `/qwen:setup` | `authenticated:true` | ✓ |
| T3 | `/qwen:setup --enable-review-gate` | `stopReviewGate=true` |  |
| T4 | `/qwen:rescue --wait "explain this repo"` | 30s 内返回 | ✓ |
| T5 | `/qwen:rescue --background` + `/qwen:status` | 看到 running | ✓ |
| T6 | `/qwen:status <id> --wait` | 转 completed | ✓ |
| T7 | `/qwen:result <id>` | 原文回显 | ✓ |
| T8 | `/qwen:cancel <id>` | cancelled + 进程没 | ✓ |
| T9 | `/qwen:review`(有 diff) | 通过 schema | ✓ |
| T10 | `/qwen:adversarial-review` | 挑战框架 findings | ✓ |
| T11 | 撤 token 后 rescue | `not_authenticated` kind | 软 |
| T12 | settings 有 proxy、env 无 → rescue | 跑通(证 proxy 注入) | ✓ |
| T13 | `--resume` 对不存在会话 | `no_prior_session` + 建议 `--fresh` | 软 |

### 6.6 CI

v0.1 本机 `node --test` 通过即可;GitHub Actions 留 v0.2(需 mock qwen 的 npm 包或 secret)。

---

## 7. 阶段划分

### Phase 0 · 探针(0.5 天)

- `doc/probe/*.sh` 跑 §6.2 的 7 个 case,落地 `probe-results.json`。
- 调查 §4.3 proxy 注入是否真能解决 headless 401(重登 token 后再跑一轮)。
- 抓一次带真 diff 的 `qwen -p "review this" --output-format stream-json` 观察 tool_use/tool_result 块结构,确认与 kimi stream-json 同构。

### Phase 1 · Setup(1 天)

完全照 kimi Phase 1:只实现 `commands/setup.md` + `qwen-companion.mjs setup`。产出:
- `getQwenAvailability` → `qwen -V`
- `getQwenAuthStatus` → 解析 `qwen auth status` + ping stream-json
- `buildSpawnEnv` proxy 注入(§4.3)
- `detectInstallers` → npm / brew / curl
- JSON:`{ installed, version, authenticated, authDetail, authMethod, model, chatRecording, proxyInjected, installers }`

### Phase 2 · Rescue + Skills(2 天)

- 写 `agents/qwen-rescue.md`、3 个 skills。
- `qwen-companion task` 支持 foreground + background + `--resume-last`。
- **Phase 2 开写前决策**:kimi Phase 2 若已落盘,则 `qwen.mjs` 参考最新 kimi(更贴近 qwen 的 CLI 形态);否则参考 gemini。
- `job-control.mjs` 字节复制 gemini 版,`state.mjs` 改 env/路径常量。

### Phase 3 · Review 系 + schemas/prompts(2 天)

- `qwen-companion review` / `adversarial-review`。
- `schemas/review-output.schema.json` 字节复制 codex。
- `prompts/{stop-review-gate, adversarial-review}.md` 轻改字。
- Review JSON parse retry(§5.3)。

### Phase 4 · status/result/cancel + hooks(1 天)

- 照抄 codex 的 status/result/cancel;qwen 无 app-server,cancel 比 codex 简单(直接 pgid 信号)。
- `hooks/hooks.json` + 两个 hook 脚本照抄 codex。
- `/qwen:setup --enable-review-gate` 写 `state.json::config.stopReviewGate`。

### Phase 5 · 打磨 & 文档(0.5 天)

- `lessons.md` 回写差异点。
- `CHANGELOG.md` 每 phase 一条 entry。
- README / CLAUDE.md 最终版。

**合计**:约 7 天。

---

## 8. 开工前 must-have

- [ ] 重登 `qwen auth coding-plan`,验证 proxy 注入后 headless 401 消失
- [ ] 确认 `~/.qwen/settings.json::chatRecording` 开启(否则 rescue `--resume-last` 不可用)
- [ ] 拷一份 codex 插件到 `plugins/qwen/` 的 scaffold(空文件),作为改写基线
- [ ] 写 `lessons.md` 骨架,先记"qwen is_error 不可信"这一类关键差异
- [ ] `marketplace.json` / `plugin.json` / `CLAUDE.md` / `CHANGELOG.md` / `.gitignore` 初始化(抄 kimi)

---

## 9. 开放问题 / 风险

1. **Proxy 注入对非代理用户的副作用**:若用户完全不走代理,`settings.proxy` 为空,companion 不注入——OK;若用户 env 已有 `HTTP_PROXY`,companion 不覆盖——OK。剩余风险:用户 settings 有 proxy 但该 proxy 已失效,companion 注入后反而让 headless 也失败。Phase 1 在 setup JSON 里报告 `proxyInjected` 即可由用户决策。
2. **Qwen CLI 未来版本变更**:0.14.5 的 stream-json 结构与 kimi 同构,但官方可能改字段名。Phase 0 探针结果写进 `doc/probe/probe-results.json` 做基线;未来破坏性变更靠 CI(v0.2)捕获。
3. **`--effort` 的兼容含义**:当前方案是透传但丢弃,用户会困惑"我传了 `--effort high` 为什么没生效"。缓解:`qwen-cli-runtime` SKILL.md 显式写"qwen 无 effort 映射,flag 保留仅为命令行兼容,不改变行为"。
4. **Coding Plan token 周期**:Coding Plan 的 token 经观察有失效周期(本机出现过 401)。setup 命令必须能稳定检测并指引 `! qwen auth coding-plan`,否则整个插件看起来坏了。
5. **Kimi 同代际对齐时机**:Phase 2 开工前 kimi 若未完工,就走 gemini;若完工,**允许重走一次 §2.3 分类表**,把更合适的 kimi 版字节复制替换进来。这是设计层面的可协商点,不在 Phase 2 定死。

---

## 10. 参考

- 前置调研:`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-research.md`
- 模板源:`~/.claude/plugins/cache/openai-codex/codex/1.0.4/`
- 姊妹样本:`/Users/bing/-Code-/{gemini,kimi,minimax}-plugin-cc/`
- Qwen CLI 上游:<https://github.com/QwenLM/qwen-code>

---

## 附录 A · 本文档的三方 review 策略

本 spec 写完即进入 **3-way review**:Claude(作者)+ Codex + Gemini。三方各自按同一份 prompt 过一遍,汇总后产出 v2。Review 关注点:

1. §2.3 改写分类是否漏了文件 / 错归类。
2. §4.3 proxy 注入在非代理、多层代理、系统级代理的行为是否稳。
3. §5.1 四层判错能否覆盖 qwen 所有已知"假成功"场景。
4. §5.3 review retry 次数是否足够 / 是否过度。
5. §7 阶段工时是否乐观。
6. §9 开放问题是否遗漏。
