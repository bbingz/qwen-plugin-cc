# qwen-plugin-cc 设计文档

**日期**:2026-04-20
**作者**:bing + Claude Code(Opus 4.7)
**状态**:v2,已吸收三方 review(Claude + Codex + Gemini)反馈
**仓库**:`/Users/bing/-Code-/qwen-plugin-cc/`(独立仓库)
**姊妹工程**:
- 模板:`openai-codex/codex` v1.0.4(官方)
- 对齐样本:`gemini-plugin-cc` v0.5.2(已实装)、`kimi-plugin-cc` v0.1.0(Phase 1 已实装,Phase 2+ 开发中)、`minimax-plugin-cc` v0.1(spec 已定,plan 未执行)

**v2 变更摘要**:对比 v1,主要修改:
- **默认 approval-mode 从 yolo → auto-edit**;yolo 仅在 `--unsafe` 显式开启时切换(Codex 架构级 + Claude P1)
- **spawn 必须 `detached: true`**,记录 pid+pgid(否则 cancel 会连带杀 companion)
- **proxy 注入**:四大小写 env 都探测,冲突时不注入返 warning,NO_PROXY 做 merge
- **判错**:从四层扩为**五层**(加"空输出"保护),`api_error` 拆成 6 个子 kind(rate_limited / quota_or_billing / invalid_request / server_error / network_error / max_output_tokens),补 `no_prior_session` / `empty_output` / `orphan`
- **stream 判错**:正则去 `^` 锚,改**边解析边判错**,一命中即 SIGTERM
- **review retry**:从 1 次改 2 次,retry 不重贴 diff
- **T-checklist**:T5/T8 加延迟容忍,新增 T14 超大 diff / T15 并发 job / T16 Bash 参数转义
- **工时**:7 天 → **9 天**(三方平均),另留 spike buffer
- **开放问题**:置顶 yolo+background 安全;补 auth status 不证可用 / 系统代理 / qwen hooks 互感知

---

## 1. 目标与范围

### 1.1 做什么

把 `openai-codex` Claude Code 插件的形态对齐移植到 `qwen-plugin-cc`,底层 CLI 由 `codex` 换成 **QwenLM/qwen-code**(阿里云 Qwen Code,Coding Plan / OAuth / API Key 三路认证)。Claude Code 里用户能用 `/qwen:setup`、`/qwen:rescue`、`/qwen:review` 等命令调用 qwen3.6-plus 等模型,用法和 `/codex:*` 一一对应。

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
- **v0.1 固定 2 次强化 prompt retry**(对齐三方 review;v0.2 再扩多次自适应)
- 不接管 qwen 自身的 `qwen hooks` / `qwen channel` 子命令(各自独立生态;setup 会报告感知状态,见 §9-9)

### 1.4 成功标准

- 在已装 `qwen 0.14.5+` 并完成 `qwen auth coding-plan` 的机器上:
  `claude plugins add ./plugins/qwen` → `/qwen:setup` 报 `authenticated: true` → `/qwen:rescue --wait "hello"` 返回文本 → `/qwen:review` 对小 diff 产出符合 schema 的 JSON
- `lessons.md` ≥ 5 条 qwen/kimi/gemini/codex 差异
- §6.5 T-checklist 的 T1、T2、T4、T5、T6、T7、T8、T9、T10、T12、T16 通过

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
│   ├── specs/2026-04-20-qwen-plugin-cc-review-*.md  # 三方 review 存档
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
└── scripts/                               # 血统起点:gemini v0.5.2 @ 2026-04-20,Phase 2 开工前可改抄最新 kimi
    ├── qwen-companion.mjs                   # 主 dispatcher
    ├── session-lifecycle-hook.mjs           # gemini 起点 + 改 env/路径
    ├── stop-review-gate-hook.mjs            # gemini 起点 + 改 env/路径
    └── lib/
        ├── args.mjs                        # 以 gemini 为起点(字节可复制)
        ├── process.mjs                     # 以 gemini 为起点
        ├── git.mjs                         # 以 gemini 为起点
        ├── state.mjs                       # 以 gemini 为起点(已支持 $CLAUDE_PLUGIN_DATA,仅改 slug/常量名)
        ├── job-control.mjs                 # 以 gemini 17.4K 版为起点 + 常量剥离(原位依赖 workspace/hook 里的等价逻辑)
        ├── render.mjs                      # 改 Qwen 字样
        ├── prompts.mjs                     # 模板加载,轻改
        └── qwen.mjs                        # 从零写:qwen CLI spawn、认证、stream-json 解析、proxy 注入(参照 gemini.mjs ~11K 尺寸)
```

**注**:codex 模板把 job/tracked/workspace/fs 拆成 4 个文件,gemini **不拆**——等价逻辑**分散在 companion / job-control / hook** 三处(例:`resolveWorkspaceRoot` 在 `gemini-companion.mjs:79-90`,两个 hook 里也各有本地实现,stdin 读取亦然)。我们走 gemini 血统,因此不引入 codex 的 `tracked-jobs.mjs` / `workspace.mjs` / `fs.mjs`,但实现时要留意"不是一个文件做完,而是三处协作"。

### 2.3 手工改写 vs 字节起点 的分界

| 类别 | 文件 | 备注 |
|---|---|---|
| **字节起点**(自 gemini;实际实现需做常量/路径剥离后再复制) | `scripts/lib/{args,process,git}.mjs`、`schemas/review-output.schema.json`(来自 codex) | 最接近"纯复制";仍需 scan 一次,确认无硬编码 `gemini` 字样 |
| **轻度改写**(常量/字样) | `scripts/lib/{state,render,prompts,job-control}.mjs`、`scripts/session-lifecycle-hook.mjs`、`scripts/stop-review-gate-hook.mjs`、`prompts/*` | `state.mjs` 沿用 gemini 已有的 `$CLAUDE_PLUGIN_DATA` + `$TMPDIR` fallback,仅改 slug 目录名为 `qwen-companion`、env 名 `QWEN_COMPANION_*`。`job-control.mjs`(17.4K)必须人为 scan,替换 `GEMINI_*` env、`gemini-companion` 字面量、Gemini 长轮询相关超时常量(见 §9-10) |
| **重写**(CLI 差异) | `scripts/lib/qwen.mjs`(对应 gemini 的 `gemini.mjs`,**参照 ~11–15K 尺寸**,不照 codex 32K) | 位置参数 + stream-json + `--continue/--resume`;认证探活处理 `[API Error:` 子串;proxy 注入(§4.3);边解析边判错(§4.4) |
| **不引入** | codex 独有的 `scripts/app-server-broker.mjs`、`scripts/lib/{app-server,app-server-protocol.d.ts,broker-endpoint,broker-lifecycle,tracked-jobs,workspace,fs}.mjs` | Codex MCP app-server 包壳;gemini 把 tracked/workspace/fs 能力分散到其他文件(见 §2.2 注) |
| **从零写**(对应命令与 skill) | 7 个 `commands/*.md`、1 个 `agents/qwen-rescue.md`、3 个 `skills/*/SKILL.md`、2 个 `prompts/*.md` | 全换 qwen 字样;prompting skill 换 qwen3.6 特性 |

### 2.4 命名对齐

| 要素 | codex(官方) | gemini(bing) | kimi(bing) | **qwen** |
|---|---|---|---|---|
| marketplace | `openai-codex` | `gemini-plugin` | `kimi-plugin` | `qwen-plugin` |
| owner | OpenAI | bing | bing | bing |
| plugin 名 | `codex` | `gemini` | `kimi` | `qwen` |
| source | `./plugins/codex` | `./plugins/gemini` | `./plugins/kimi` | `./plugins/qwen` |
| Session env | `CODEX_COMPANION_SESSION_ID` | `GEMINI_COMPANION_SESSION_ID` | `KIMI_COMPANION_SESSION_ID` | `QWEN_COMPANION_SESSION_ID` |
| State 根目录 | `$CLAUDE_PLUGIN_DATA` 或 `$TMPDIR/codex-companion/` | `$CLAUDE_PLUGIN_DATA` 或 `$TMPDIR/gemini-companion/` | (未涉及) | `$CLAUDE_PLUGIN_DATA` 或 `$TMPDIR/qwen-companion/` |
| Subagent | `codex:codex-rescue` | `gemini:gemini-agent` | n/a | `qwen:qwen-rescue`(沿用 codex `-rescue` 语义,qwen 未来若加 ask 命令不混淆) |
| 斜杠命令 | `/codex:*` | `/gemini:*` | `/kimi:*` | `/qwen:*` |

---

## 3. 组件职责

### 3.1 Companion 主脚本 `scripts/qwen-companion.mjs`

单一 Node 入口,dispatcher 按子命令分发:

| 子命令 | 作用 | 关键产物 |
|---|---|---|
| `setup` | 探测安装、认证、proxy、chat_recording、qwen-hooks | JSON 状态 |
| `review` | 对工作区/分支 diff 做标准 review | JSON(符合 schema) |
| `adversarial-review` | review 加挑战性 prompt 框架 | 同上 |
| `task` | rescue 用;foreground/background spawn | stdout 透传 |
| `task-resume-candidate` | `/qwen:rescue` 决策"续/新" | `{available: bool}` |
| `status` | 列 job / 单 job 详情 | markdown 表 |
| `result` | 取已完成 job 的最终输出 | 存档 JSON 负载 |
| `cancel` | 终止 background 子进程 | 状态转移报告 |

### 3.2 三个 skill(均 `user-invocable: false`)

- **`qwen-cli-runtime`**:`qwen:qwen-rescue` 的内部合约。规定"只调 `task` 一次、剥离路由 flag、默认加什么、`--resume`/`--fresh` 映射、`--unsafe` 语义"。等同 codex `codex-cli-runtime`。
- **`qwen-prompting`**:qwen3.6 的 prompt 诀窍 + `references/`。与 codex `gpt-5-4-prompting` 同构,内容改写为 qwen3.6 特性(中英混写稳、`--system-prompt` 塞 schema、`mcp_servers` 空时不让它摸文件)。
- **`qwen-result-handling`**:Claude 拿到 qwen stdout 后怎么呈现:保留 verdict/findings/next-steps 结构、review 后 STOP、malformed 时给 stderr tail。以 codex 版为起点后改字。

### 3.3 Agent `agents/qwen-rescue.md`

薄转发器:
- `subagent_type: qwen:qwen-rescue`, `tools: Bash`, `skills: [qwen-cli-runtime, qwen-prompting]`
- 一次 `Bash` 调 `qwen-companion task ...`,stdout 原样返回
- `--effort` 透传但 companion 层丢弃(语义差;skill 里明确说明,见 §9-3)
- `--model` 默认不传
- **默认 `--approval-mode auto-edit`**(不再默认 yolo;见 §3.3-决策)
- **`--unsafe` 标志**:仅当用户显式传递时,companion 将 approval-mode 切换为 `yolo`
- **Background + 未显式 unsafe**:companion 拒绝启动,返回 `require_interactive` 提示用户显式 `--unsafe` 或改 foreground
- `--resume` → qwen `-c` 或 `-r <session-id>`,`--fresh` → 不传

**决策背景(§3.3 新增)**:qwen 的 `--approval-mode yolo` 等价"auto-approve all tools"。若 background rescue 默认 yolo,等同于用户不可见地给子进程放行所有工具调用——这是安全边界问题,不是便利问题。代价:所有 background rescue 必须先手动选择 `--unsafe`(UX 轻微恶化,安全显著改善)。

### 3.4 命令 `commands/*.md`(7 个)

Frontmatter 对齐 codex,关键差异:
- `setup.md`:安装候选动态(npm / brew / curl shell);未认证提示 `! qwen auth coding-plan`;setup 报告里列 `qwen hooks list` 结果(§9-9)。
- `review.md` / `adversarial-review.md`:`--wait|--background`、`--base <ref>`、`--scope auto|working-tree|branch`;大小估算靠 git 侧逻辑;`AskUserQuestion` 一次选执行模式。
- `rescue.md`:走 Agent 工具启动子代理;`task-resume-candidate` 决定是否先问"续/新";说明 `--unsafe` 语义。
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

### 4.1 典型调用链(`/qwen:rescue --background --unsafe "fix flaky test"`)

```
Claude Code
  └─► /qwen:rescue 命令 (commands/rescue.md)
        └─► Agent(subagent_type=qwen:qwen-rescue)
              └─► Bash: node qwen-companion.mjs task --background --unsafe "fix flaky test"
                    ├─► [companion 进程]
                    │     ├─ 读 ~/.qwen/settings.json → 取 proxy
                    │     ├─ 读 env CLAUDE_PLUGIN_DATA → state 目录
                    │     ├─ generateJobId, 写 jobs/<id>.json (status=running, approvalMode=yolo)
                    │     └─► spawn qwen (位置参数 prompt) --output-format stream-json --approval-mode yolo
                    │           └─ ChildProcess(detached, new pgid) ──── stream-json stdout ──┐
                    │     ← 解析 init 事件,抓 session_id 写 job.json                         │
                    │     ← 解析 assistant,累积到 job log / 透传 stdout;                    │
                    │       一旦 text 命中 /\[API Error:/ → 标红 + SIGTERM + 退出             │
                    │     ← 解析 result,判终(§5.1 五层)←────────────────────────────────┘
                    │     └─► detach 返回 "Job queued: <jobId>"
                    └─► Claude: "Qwen rescue started (UNSAFE yolo mode); check /qwen:status"
```

未传 `--unsafe` 的 background 请求会在 companion 入口处被拒绝,返回 `require_interactive`。

### 4.2 Spawn qwen 的参数装配(`qwen.mjs` 核心)

```js
// 决定 approval-mode
let approvalMode = userApprovalMode;                          // 用户显式传了就尊重
if (!approvalMode) approvalMode = unsafeFlag ? "yolo" : "auto-edit";  // 默认 auto-edit
if (background && !unsafeFlag && approvalMode === "yolo") {
  throw new CompanionError("require_interactive",
    "Background rescue with yolo requires --unsafe. Use --unsafe or switch to foreground.");
}

const args = [];
if (sessionId)       args.push("--session-id", sessionId);
else if (resumeLast) args.push("-c");
else if (resumeId)   args.push("-r", resumeId);

args.push("--output-format", "stream-json");
args.push("--approval-mode", approvalMode);
args.push("--max-session-turns", String(maxSteps));
if (appendSystem) args.push("--append-system-prompt", appendSystem);
if (appendDirs)   args.push("--include-directories", appendDirs.join(","));

const { env, warnings } = buildSpawnEnv(userSettings);  // §4.3
args.push(prompt);                                       // 位置参数;-p 已 deprecated

const child = spawn("qwen", args, {
  env, cwd,
  detached: true,                     // 关键:新建 process group,cancel 才能对 pgid 发信号
  stdio: ["ignore", "pipe", "pipe"],
});
child.unref();                        // 允许 companion 先退(background 模式)
writeJob({ jobId, pid: child.pid, pgid: child.pid, approvalMode, warnings, ... });
```

### 4.3 Proxy 注入

qwen 交互模式读 `~/.qwen/settings.json::proxy`,headless 不读,导致 `/qwen:rescue` 401。Companion 补丁:

```js
function buildSpawnEnv(userSettings) {
  const env = { ...process.env };
  const proxy = userSettings?.proxy;
  const warnings = [];
  const existing =
    env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;

  if (proxy) {
    if (!existing) {
      // 四大小写都写,免得 qwen 某次按 lowercase 读
      env.HTTPS_PROXY = env.https_proxy = env.HTTP_PROXY = env.http_proxy = proxy;
    } else if (existing !== proxy) {
      warnings.push({ kind: "proxy_conflict", settings: proxy, env: existing });
      // 不注入,不覆盖,让 qwen 自己的 env 继续用
    }
    // existing === proxy 时 noop
  }

  // NO_PROXY: merge 而非覆盖
  const defaultBypass = ["localhost", "127.0.0.1"];
  const userBypass = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const merged = Array.from(new Set([...userBypass, ...defaultBypass])).join(",");
  env.NO_PROXY = env.no_proxy = merged;

  return { env, warnings };
}
```

Setup 报告返回 `proxyInjected`、`proxyConflict`(若有),`/qwen:setup` 告知用户。

**未处理场景(§9-8)**:macOS 系统代理(Network Preferences)不落到 env,本方案覆盖不了,Phase 0 探针确认影响面。

### 4.4 Stream-json 消费(`qwen.mjs::parseStream`)

按行 JSON 解析,三类事件,**边解析边判错**:

| 事件 | 用途 |
|---|---|
| `type=system, subtype=init` | 抓 `session_id` 写 job.json;记录 `model`/`tools`/`mcp_servers` 元数据 |
| `type=assistant` | 追加到 job.log(bg)或透传 stdout(fg);**每到一块就检测 `message.content[].text` 是否**包含 `/\[API Error:/`(不锚 `^`,覆盖前导空白/换行/code fence);命中即:① 标记 `apiError=true`;② 立刻对子进程 pgid 发 `SIGTERM`;③ 退出解析循环 |
| `type=result` | 判终:§5.1 五层检测 |

**动机**:一旦 qwen API 失败,继续消费 stream 只会浪费时间和 token;background 长任务里用户傻等是 gemini 踩过的坑。

### 4.5 Authentication 探活(`setup` 子命令)

```
setup
  ├─ qwen -V                                      → installed?
  ├─ qwen auth status(解析文本,parser 碎了 → authMethod:"unknown",仍进入下一步)
  ├─ 读 ~/.qwen/settings.json                      → chatRecording, proxy, model
  ├─ qwen hooks list(§9-9)                        → qwenHooks[]
  ├─ buildSpawnEnv() + spawn qwen "ping" --output-format stream-json --max-session-turns 1
  │    ├─ 五层判错
  │    └─ 成功 → authenticated=true, model 从 init 事件拿
  └─ 汇总 JSON:
     { installed, version,
       authenticated, authDetail, authMethod,   // ping 通即可 authenticated,即便 authStatus 解析失败
       model, configured_models,
       chatRecording, proxyInjected, proxyConflict,
       qwenHooks,                               // 用户自定义的 qwen 侧 hooks
       installers: { npm, brew, shellInstaller } }
```

**原则**:`qwen auth status` 只证明"已配置",不证明"token 可用"。**必须 ping 判终**才能标 authenticated。

### 4.6 State 目录(对齐 codex)

```
$CLAUDE_PLUGIN_DATA/state/<workspace-slug>-<sha256[:16]>/
  ├─ state.json          # { version, config: {stopReviewGate}, jobs: [...] }
  └─ jobs/
      └─ <jobId>.json    # { jobId, kind, status, phase, pid, pgid, sessionId,
                         #   approvalMode, unsafeFlag, startedAt, finishedAt,
                         #   cwd, prompt, logPath, result, failure, warnings }
```

Workspace 指纹由 `resolveWorkspaceRoot + sha256` 决定(在 `companion/hook` 中各有等价实现,见 §2.2 注);`MAX_JOBS=50` 滚动清理。Fallback 同 gemini:`CLAUDE_PLUGIN_DATA` 未设 → `$TMPDIR/qwen-companion/`。

---

## 5. 错误处理

### 5.1 五层判错(qwen 独有"成功包失败")

qwen 把 API 失败塞 assistant text 且返回 `exit 0 + is_error:false`。Companion 必须翻译,**五层依次检查**:

```js
function detectFailure({ exitCode, resultEvent, assistantTexts }) {
  // 层 1: 进程死
  if (exitCode !== 0 && exitCode !== null)
    return { failed: true, kind: "exit", code: exitCode };

  // 层 2: qwen 自报
  if (resultEvent?.is_error === true)
    return { failed: true, kind: "qwen_is_error" };

  // 层 3: result.result 字段含 [API Error:(不锚定)
  if (resultEvent?.result && /\[API Error:/.test(resultEvent.result))
    return classifyApiError(resultEvent.result);

  // 层 4: 任一 assistant 文本含 [API Error:(不锚定;§4.4 已在实时流里优先捕)
  const errLine = assistantTexts.find(t => /\[API Error:/.test(t));
  if (errLine) return classifyApiError(errLine);

  // 层 5: 空输出保护(exit 0 + is_error:false + 无任何 text)
  if (assistantTexts.length === 0 && !resultEvent?.result)
    return { failed: true, kind: "empty_output" };

  return { failed: false };
}

function classifyApiError(msg) {
  // qwen 源码已区分这些子类,我们据关键词归档
  if (/rate limit|429/i.test(msg))         return { failed: true, kind: "rate_limited", message: msg };
  if (/quota|billing/i.test(msg))          return { failed: true, kind: "quota_or_billing", message: msg };
  if (/401|unauthorized|invalid.*token/i.test(msg))
                                           return { failed: true, kind: "not_authenticated", message: msg };
  if (/invalid.*request|400/i.test(msg))   return { failed: true, kind: "invalid_request", message: msg };
  if (/5\d\d|server error/i.test(msg))     return { failed: true, kind: "server_error", message: msg };
  if (/max.*output.*tokens/i.test(msg))    return { failed: true, kind: "max_output_tokens", message: msg };
  if (/connection|network|timeout/i.test(msg)) return { failed: true, kind: "network_error", message: msg };
  return { failed: true, kind: "api_error_unknown", message: msg };  // 兜底
}
```

### 5.2 错误分类表

| kind | 触发 | `/qwen:result` 输出 | 建议动作 |
|---|---|---|---|
| `not_installed` | `qwen -V` 失败 | "qwen not found on PATH" | `/qwen:setup` 选 npm/brew/curl |
| `not_authenticated` | classifyApiError 命中 401 / 或 `qwen auth status` 未登录 | 建议 `! qwen auth coding-plan` | 用户手动,再 `/qwen:setup` |
| `rate_limited` | classifyApiError `rate.limit|429` | "qwen 限流,稍后重试" | 等待 / 降模型 |
| `quota_or_billing` | classifyApiError `quota|billing` | "Coding Plan 额度/账单问题" | 切 API key 或续费 |
| `invalid_request` | classifyApiError `invalid.request|400` | "请求参数非法" | 检查 prompt / session id |
| `server_error` | classifyApiError `5xx` | "qwen 服务端错误" | 稍后重试 |
| `max_output_tokens` | classifyApiError `max.*output.*tokens` | "输出 token 超限" | 缩小 prompt / 分 diff |
| `network_error` | classifyApiError `connection/network/timeout` | "网络层失败" | 检查 proxy / 网络 |
| `api_error_unknown` | 含 `[API Error:` 但未命中子分类 | 原样回显 | 根据 message 判断 |
| `qwen_is_error` | `is_error:true` | qwen 自己的 stderr tail | 透传 |
| `empty_output` | 五层 layer 5 | "qwen 静默退出,无任何输出" | 检查 qwen 日志,`/qwen:rescue --fresh` |
| `no_prior_session` | `qwen -r <id>` exit 非 0 + stderr 报 session 不存在 | "续跑目标会话不存在" | 改 `--fresh` |
| `chat_recording_disabled` | 请求 `-c/-r` 但 settings 关了 | "chat recording 关闭" | 打开或走 `--fresh` |
| `proxy_conflict` | §4.3 settings.proxy 与 env 不一致 | "settings 与 env proxy 不一致" | 手动对齐或清 env |
| `proxy_required` | ping 失败 + `settings.proxy` 存在但 proxy_conflict 已触发 | 同上 + "companion 未注入" | 清 env 后重试 |
| `spawn_error` | ENOENT/EPERM | companion 错误 | 透传 |
| `timeout` | 子进程超 `DEFAULT_TIMEOUT_MS` | "timed out after Ns" | `/qwen:cancel` 示范 |
| `cancelled` | 用户 `/qwen:cancel` | "cancelled by user at <ts>" | 无 |
| `orphan` | pid 不活但 job.json 仍 `running` | "job 孤立,companion 已标 failed" | 无 |
| `require_interactive` | background + 未 `--unsafe` | "background 下 yolo 需要 `--unsafe`" | 加 `--unsafe` 或改 foreground |
| `schema_violation` | review 2 次 retry 都不匹配 schema | "schema 校验失败"+ raw 头 4KB × 2 | 换模型 / `--fresh` |

### 5.3 Review JSON parse 失败兜底(2 次 retry)

| 轮 | prompt 策略 | max-session-turns |
|---|---|---|
| 第 1 次 | 正常 prompt + `--append-system-prompt` 塞 schema | default |
| 第 2 次(retry 1) | **新开 session**(不续跑,避免累积上次污染);不重贴 diff,改贴 diff 的 SHA + 简短摘要;prompt 追加:`Previous output was not valid JSON. Output ONLY the JSON document matching the review-output schema. No prose, no code fences.` | 1(强制一步到位,禁止 qwen 去摸文件) |
| 第 3 次(retry 2) | 同第 2 次,prompt 追加:`Your last two outputs were invalid. Consider this your final attempt. Output ONLY the JSON document.` | 1 |
| 仍失败 | `schema_violation`,raw × 2 的前 4KB | — |

**动机**:gemini 实战中第 1 次 retry 追加到原 prompt 会超 context(大 diff 场景);qwen3.6 对"不重贴大上下文、只贴指令"的回应更稳。v0.2 再扩自适应多次。

### 5.4 Background job 状态机

```
queued ─► running ─► completed
                ├──► failed       (§5.1 五层任一红)
                ├──► cancelled    (cancel 或 SIGTERM)
                ├──► timeout      (companion 监护超时)
                └──► orphan       (pid 不活但 status 曾为 running)
```

Companion 独占写 `jobs/<id>.json`(单 writer,atomic rename);`/qwen:status` 只读。`status` 每次读时用 `process.kill(pid, 0)` 探活:不活且 `status=running` → 标 `failed + kind=orphan`。

### 5.5 Cancel 原子性

**前提**:子进程必须是 `detached: true` 起的,pgid 独立(§4.2)。对 pgid 发:`SIGINT`(2s) → `SIGTERM`(2s) → `SIGKILL`;每步 `try { process.kill(-pgid, sig) } catch (e) { if (e.code !== 'ESRCH') throw }`(仅吞 ESRCH,其他错误冒上去);最后写 `status=cancelled`。

### 5.6 失败不自动治愈

任何错误:companion 只报不自动重跑 rescue、不自动改配置、不超出 §5.3 的 2 次 retry。Claude 侧对 review findings 也禁止自动改代码,必须先问用户(由 `qwen-result-handling` 强制)。

---

## 6. 测试与验收

### 6.1 分层

| 层 | 工具 | 跑法 | 覆盖 |
|---|---|---|---|
| 探针 | `doc/probe/*.sh` + `probe-results.json` | Phase 0 手跑 | stream-json 真实结构、401/timeout/schema 错 |
| 单元 | `node:test` | `node --test scripts/lib/*.test.mjs` | args、qwen.mjs 解析、五层判错、proxy 注入、state slug/hash |
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
8. `-r <不存在 id>`(验 `no_prior_session` 触发)
9. 撤 token 后 ping(验 classifyApiError 对 401 的归档)
10. 系统级代理场景(mac 系统代理 + env 未设,验 §9-8)

每条存 `doc/probe/probe-results.json`,单元测试作为 fixture 消费。

### 6.3 关键单元测试

`scripts/lib/qwen.test.mjs`:
- **五层判错**所有组合(exit/is_error/result prefix/assistant text/空输出)
- `classifyApiError` 的 7 种子 kind 归档 + `api_error_unknown` 兜底
- 正则去 `^` 锚:`"  [API Error: 401"`、`"\n[API Error: 429"`、``` ```json\n[API Error: 500 ``` 都能命中
- **边解析边判错**:命中即 SIGTERM,不再读后续行(fake childProcess 观测 kill 调用)
- 多行 JSONL 空行/坏行 parser 不崩
- init 事件的 session_id 写到 job
- `detectFailure` 签名:拆参数后所有分支可独立测

`scripts/lib/qwen-proxy.test.mjs`:
- settings 有 + 四种 env 均无 → 注入四种大小写
- settings 有 + env `https_proxy` 已存在且一致 → noop,无 warning
- settings 有 + env `HTTP_PROXY` 已存在但值不同 → 不注入 + `proxy_conflict` warning
- settings 无 → 不注入,`NO_PROXY` 默认 bypass 仍 merge 进去
- user `NO_PROXY=foo` → 最终 `NO_PROXY=foo,localhost,127.0.0.1`

`scripts/lib/state.test.mjs`:
- slug+hash 幂等(同 cwd 二次稳定)
- `MAX_JOBS=50` 滚动删除最旧
- 并发写 atomic rename(两 Promise 同时 writeJob → 两 job 均存活,不串 data)
- pid 活探测 → orphan 状态迁移

`scripts/lib/args.test.mjs`:
- 带引号/空格/转义/中文的解析
- `--effort/--model/--resume/--fresh/--background/--wait/--unsafe` 识别+剥离

### 6.4 集成测试

`tests/fixtures/mock-bin/qwen` 按 `QWEN_MOCK_CASE` env 输出 fixture。PATH 前置 mock-bin:

```bash
PATH="$PWD/tests/fixtures/mock-bin:$PATH" \
QWEN_MOCK_CASE=api-error-401 \
node scripts/qwen-companion.mjs setup --json
```

覆盖:
- `setup` 五态(未装 / 未认证 / 认证但 chat_recording 关 / 认证但 proxy_conflict / 全好)
- `task` foreground 成功 + §5.1 各 kind 失败(每个子 kind 一个 fixture)
- `task --background` 生命周期(running → status → result)
- `task --background`(无 `--unsafe`)→ 拒绝 + `require_interactive`
- `cancel` 对 running 的状态转移;对已死子进程 ESRCH 吞掉
- review 的 JSON parse 成功 / retry 1 次通过 / retry 2 次才通过 / 3 次都失败 `schema_violation`
- **并发 job**:两个 companion 同时 writeJob 到同一 state dir,断言无串数据
- **Bash 参数转义**:prompt 含 `'"` `"double"` `$(whoami)` `&`,断言 spawn 的 argv 不被 shell 二次解释

### 6.5 T-checklist(端到端手动)

| # | 场景 | 通过判据 | 必过 |
|---|---|---|---|
| T1 | `claude plugins add ./plugins/qwen` | 命令可见 | ✓ |
| T2 | `/qwen:setup` | `authenticated:true`,ping 通且 `authMethod` 正确 | ✓ |
| T3 | `/qwen:setup --enable-review-gate` | `stopReviewGate=true` |  |
| T4 | `/qwen:rescue --wait "explain this repo"` | 30s 内返回 | ✓ |
| T5 | `/qwen:rescue --background --unsafe` + `/qwen:status` | **500ms 内** polling 到 job 为 `running` | ✓ |
| T5' | `/qwen:rescue --background`(无 unsafe) | 立即返回 `require_interactive` | ✓ |
| T6 | `/qwen:status <id> --wait` | 转 `completed` | ✓ |
| T7 | `/qwen:result <id>` | 原文回显 | ✓ |
| T8 | `/qwen:cancel <id>`(job 启动后 2s 内) | **2s 容忍内**转 `cancelled` + 整个 pgid 进程树无残留 | ✓ |
| T9 | `/qwen:review`(有 diff) | 通过 schema(可能经 retry) | ✓ |
| T10 | `/qwen:adversarial-review` | 挑战框架 findings | ✓ |
| T11 | 撤 token 后 rescue | `not_authenticated` kind | 软 |
| T12 | settings 有 proxy、env 无 → rescue | 跑通(证 proxy 注入) | ✓ |
| T13 | `--resume <伪 id>` | `no_prior_session` kind + 建议 `--fresh` | 软 |
| **T14** | 超大 diff(> 100KB)`/qwen:review` | 不 silent fail;要么通过 schema,要么 `max_output_tokens` / `schema_violation` kind 明确 | ✓ |
| **T15** | 两终端同时 `/qwen:rescue --background --unsafe` | 两 job 都跑完,各自 job.json 完整 | ✓ |
| **T16** | prompt 含 shell 特殊字符 `$(whoami)` `'` `"` `&` | 字符原样透传给 qwen,不被 shell 展开 | ✓ |

### 6.6 CI

v0.1 本机 `node --test` 通过即可;GitHub Actions 留 v0.2(需 mock qwen 的 npm 包或 secret)。

---

## 7. 阶段划分

### Phase 0 · 探针(0.5 天)

- `doc/probe/*.sh` 跑 §6.2 的 10 个 case,落地 `probe-results.json`。
- 调查 §4.3 proxy 注入是否真能解决 headless 401(重登 token 后再跑一轮)。
- 调查 §9-8 系统级代理场景影响面。
- 抓一次带真 diff 的 `qwen [prompt] --output-format stream-json` 观察 tool_use/tool_result 块结构。

### Phase 1 · Setup(1.5 天)

只实现 `commands/setup.md` + `qwen-companion.mjs setup`。产出:
- `getQwenAvailability` → `qwen -V`
- `getQwenAuthStatus` → 解析 `qwen auth status`(含 parser fallback) + ping stream-json
- `buildSpawnEnv` proxy 注入(§4.3,四大小写 + 冲突检测 + NO_PROXY merge)
- `detectInstallers` → npm / brew / curl
- `qwen hooks list` 感知
- JSON:`{ installed, version, authenticated, authDetail, authMethod, model, chatRecording, proxyInjected, proxyConflict, qwenHooks, installers }`

### Phase 2 · Rescue + Skills(2.5 天)

- 写 `agents/qwen-rescue.md`、3 个 skills。
- `qwen-companion task` 支持 foreground + background + `--resume-last` + `--unsafe`。
- **Phase 2 开写前决策**:kimi Phase 2 若已落盘,则 `qwen.mjs` 参考最新 kimi(更贴近 qwen 的 CLI 形态);否则参考 gemini。
- `job-control.mjs` 以 gemini 17.4K 版为起点 + 常量剥离;`state.mjs` 改 slug/env 常量名。
- 实现 `spawn detached + pgid`、`detectFailure` 五层、`classifyApiError`、边解析边判错。

### Phase 3 · Review 系 + schemas/prompts(2.5 天)

- `qwen-companion review` / `adversarial-review`。
- `schemas/review-output.schema.json` 字节复制 codex。
- `prompts/{stop-review-gate, adversarial-review}.md` 轻改字。
- **2 次 retry**(§5.3),新开 session 不重贴 diff。
- Spike buffer:若 retry 调不稳,Phase 5 前加 1 天做 prompt 稳定性 spike(见 §9-11)。

### Phase 4 · status/result/cancel + hooks(1.5 天)

- `status/result/cancel` + pgid 信号递进 + ESRCH 吞掉。
- `hooks/hooks.json` + 两个 hook 脚本以 codex 为起点 + 改 env。
- `/qwen:setup --enable-review-gate` 写 `state.json::config.stopReviewGate`。
- orphan 迁移实现。

### Phase 5 · 打磨 & 文档(0.5 天)

- `lessons.md` 回写差异点。
- `CHANGELOG.md` 每 phase 一条 entry。
- README / CLAUDE.md 最终版。

**合计**:**9 天**(0.5 + 1.5 + 2.5 + 2.5 + 1.5 + 0.5)。Gemini review 建议留到 10–14 天;我们显式预留的风险:Phase 3 retry 调不稳 → Phase 5 前加 1 天 spike,最多 10 天。

---

## 8. 开工前 must-have

- [ ] 重登 `qwen auth coding-plan`,验证 proxy 注入后 headless 401 消失
- [ ] 确认 `~/.qwen/settings.json::chatRecording` 开启(否则 rescue `--resume-last` 不可用)
- [ ] 拷一份 codex 插件到 `plugins/qwen/` 的 scaffold(空文件),作为改写基线
- [ ] 写 `lessons.md` 骨架,先记"qwen is_error 不可信"这一类关键差异
- [ ] `marketplace.json` / `plugin.json` / `CLAUDE.md` / `CHANGELOG.md` / `.gitignore` 初始化(抄 kimi)

---

## 9. 开放问题 / 风险

1. **Yolo + background 的安全代价(置顶)**:本方案禁止默认 yolo + 隐式 background。用户必须显式 `--unsafe` 才能后台跑全工具放行;不 unsafe 的 background 请求会被拒绝。代价:UX 轻微恶化,用户需要多打 7 字符。收益:子进程不会在用户不可见时写文件 / 跑 shell。未 unsafe 的 foreground rescue 默认 `auto-edit`,每次 tool_use 会暂停等确认。
2. **Proxy 注入对非代理用户的副作用**:settings 无 proxy → 不注入;settings 有且 env 无 → 注入四大小写;settings 与 env 冲突 → 不注入 + warning(§4.3)。剩余风险:用户 settings 的 proxy 本身已失效,注入后 headless 也 401。Phase 1 在 setup JSON 里报告 `proxyConflict` 即可由用户决策。
3. **`--effort` 的兼容语义**:透传但丢弃,`qwen-cli-runtime` SKILL.md 显式说明"qwen 无 effort 映射,flag 仅为命令行兼容"。
4. **Qwen CLI 未来版本变更**:0.14.5 的 stream-json 结构与 kimi 同构,但官方可能改字段名。Phase 0 探针写进 `probe-results.json` 做基线;破坏性变更靠 v0.2 CI 捕获。
5. **Coding Plan token 周期**:Coding Plan token 经观察有失效周期(本机出现过 401)。setup 必须稳定检测并指引 `! qwen auth coding-plan`,否则插件看起来坏了。
6. **Kimi 同代际对齐时机**:Phase 2 开工前 kimi 若未完工,走 gemini;若完工,**允许重走一次 §2.3 分类表**,把更合适的 kimi 版起点替换进来。
7. **`qwen auth status` 不证"可用"只证"已配置"**:§4.5 已强制"必须 ping 判终";setup 报告里 `authDetail` 字段写清"配置来源 vs ping 结果"两件事。
8. **系统级代理未覆盖**:macOS Network Preferences / Windows 系统代理不落到 env,§4.3 方案覆盖不了。Phase 0 探针确认影响面;若常见,v0.2 加 `scutil --proxy` 读取(macOS)。
9. **Qwen 自身 hooks 与 Claude Code 互感知**:qwen 有 `qwen hooks` 子命令,用户可配 qwen 侧的 PreToolUse/PostToolUse hooks,rescue yolo 模式下可能被拦。Phase 1 的 setup 读 `qwen hooks list` 写入 JSON,`/qwen:setup` 显示给用户。
10. **gemini 血统文件的隐式假设**:`job-control.mjs` (17.4K) 在 gemini 里可能带有 Gemini 特有的长轮询超时常量。Phase 2 在复制前必须做一次 scan(搜 `GEMINI`、`gemini-` 字面量、Gemini 相关的时长常量),全部参数化后再拷过来。
11. **Phase 3 Prompt 稳定性 spike buffer**:qwen3.6 对 JSON 输出的稳定性只在小样本上观察过;若 2 次 retry 在真实 diff 上 schema_violation 高于 10%,Phase 5 前预留 1 天做 prompt spike(增加示例、调 temperature、再评估 retry 次数)。

---

## 10. 参考

- 前置调研:`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-research.md`
- 三方 review:`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-review-claude.md` + `-review-merged.md`
- 模板源:`~/.claude/plugins/cache/openai-codex/codex/1.0.4/`
- 姊妹样本:`/Users/bing/-Code-/{gemini,kimi,minimax}-plugin-cc/`
- Qwen CLI 上游:<https://github.com/QwenLM/qwen-code>

---

## 附录 A · 三方 review 采纳记录

v2 吸收了 Claude / Codex / Gemini 三路 review 的 **P0 + P1 + P2 全部**(bing 拍板)。具体对应关系见 `-review-merged.md`。关键架构变更:

- **§3.3 / §4.2**:默认 approval-mode 从 yolo 改 auto-edit,加 `--unsafe`,禁止隐式 background + yolo(Codex 架构级 + Claude P1)
- **§4.2**:spawn `detached:true` + pid/pgid 记录(Claude P0)
- **§4.3**:proxy env 四大小写 + 冲突不注入 + NO_PROXY merge(Codex P0)
- **§4.4**:stream 边解析边 SIGTERM;正则去 `^` 锚(Gemini + Codex)
- **§5.1**:四层扩五层,`detectFailure` 签名重构(Claude + Codex)
- **§5.2**:`api_error` 拆 6 子 kind,补 `no_prior_session` / `empty_output` / `orphan`(Codex)
- **§5.3**:retry 1 次 → 2 次,新开 session 不重贴 diff(Codex + Claude)
- **§6.5**:T5/T8 竞态容忍,新增 T14/T15/T16(Gemini)
- **§7**:7 天 → 9 天(+ 1 天 spike buffer = 最多 10 天)
- **§9**:新增风险 1/7/8/9/10/11 六条
