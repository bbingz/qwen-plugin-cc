# qwen-plugin-cc 设计文档

**日期**:2026-04-20
**作者**:bing + Claude Code(Opus 4.7)
**状态**:v3,已吸收两轮三方 review(Claude + Codex + Gemini)反馈
**仓库**:`/Users/bing/-Code-/qwen-plugin-cc/`(独立仓库)
**姊妹工程**:
- 模板:`openai-codex/codex` v1.0.4(官方)
- 对齐样本:`gemini-plugin-cc` v0.5.2(已实装)、`kimi-plugin-cc` v0.1.0(Phase 1 已实装,Phase 2+ 开发中)、`minimax-plugin-cc` v0.1(spec 已定,plan 未执行)

**v3 变更摘要(对 v2)**:
- **§5.3 retry 重写**:retry 必须携带上一轮 raw + schema + 修复指令,不新开 session 丢弃 diff(Codex P0 — retry 方向错,v2 采形式漏精神)
- **§4.2 `child.unref()` 分支化**:仅 `background` 下 unref,foreground 走 Promise 等 exit(Claude P0)
- **§4.3 proxy env 内部不一致**:四键全量收集 + 比对,env 内部冲突单独报 `proxy_env_mismatch`(Codex + Gemini P0)
- **§5.1 `classifyApiError` 优先提取 `Status: NNN`**:精确分类,关键词仅兜底;加 `insufficient_balance`/`content_sensitive` 子类;正则加 `\b` 边界(三家合流 P0)
- **Phase 0 新探针**:`qwen --approval-mode auto-edit` + 无 TTY 遇 `run_shell_command` 的行为(决定 §3.3 foreground 姿态是否需要改"对称 `--unsafe`")
- **§4.4 fg/bg 解析分野**:foreground 读 result 再判;background 才边解析边 SIGTERM;SIGTERM 后等 `child.on('exit')` 或 500ms 再退 companion,防 job.json rename 未完成变 orphan(Gemini 实战)
- **§5.5 非 ESRCH 错误状态迁移**:新增 `cancel_failed` kind(Codex)
- **§5.2 `proxy_required` 收窄**:仅从 `network_error` 派生,避免误伤 401/额度错误(Codex)
- **§4.5 setup 警告阻塞型 qwen hooks**:`PreToolUse` 类 hook 高亮(Gemini)
- **§3.4 rescue.md 预埋自救引导**:看到 `require_interactive` 就加 `--unsafe`(Gemini)
- **§1.3 / §5.3 口径统一**:"最多 3 次尝试(首次 + 2 次 retry)"
- **工时 9 → 11 天**(Phase 2 2.5→3 天,Phase 3 2.5→4 天,Gemini 实战 4.5 天 gemini review 为证)
- **§9-11 spike 触发可执行化**:N≥20 真实 review,失败率 >10%,作者拍板

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
- **Review JSON 修复:最多 3 次尝试(首次 + 2 次 retry);v0.2 再扩多次自适应**
- 不接管 qwen 自身的 `qwen hooks` / `qwen channel` 子命令(各自独立生态;setup 会报告感知状态,见 §9-9)

### 1.4 成功标准

- 在已装 `qwen 0.14.5+` 并完成 `qwen auth coding-plan` 的机器上:
  `claude plugins add ./plugins/qwen` → `/qwen:setup` 报 `authenticated: true` → `/qwen:rescue --wait "hello"` 返回文本 → `/qwen:review` 对小 diff 产出符合 schema 的 JSON
- `lessons.md` ≥ 5 条 qwen/kimi/gemini/codex 差异
- §6.5 T-checklist 的 T1、T2、T4、T5、T6、T7、T8、T9、T10、T12、T14、T15、T16 通过

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
│   ├── specs/2026-04-20-qwen-plugin-cc-review-*.md  # 两轮三方 review 存档
│   └── plans/                             # writing-plans 生成
├── README.md
├── CLAUDE.md
├── CHANGELOG.md
├── lessons.md
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
│   └── qwen-rescue.md
├── skills/
│   ├── qwen-cli-runtime/SKILL.md
│   ├── qwen-prompting/
│   │   ├── SKILL.md
│   │   └── references/{qwen-prompt-recipes, qwen-prompt-antipatterns, prompt-blocks}.md
│   └── qwen-result-handling/SKILL.md
├── hooks/hooks.json
├── prompts/
│   ├── stop-review-gate.md
│   └── adversarial-review.md
├── schemas/review-output.schema.json
└── scripts/                                # 血统起点:gemini v0.5.2;Phase 2 开工前可改抄最新 kimi
    ├── qwen-companion.mjs
    ├── session-lifecycle-hook.mjs
    ├── stop-review-gate-hook.mjs
    └── lib/
        ├── args.mjs
        ├── process.mjs
        ├── git.mjs
        ├── state.mjs                       # 沿用 gemini 的 $CLAUDE_PLUGIN_DATA + $TMPDIR fallback
        ├── job-control.mjs                 # 17.4K,Phase 2 首日需做依赖解耦(见 §7 Phase 2)
        ├── render.mjs
        ├── prompts.mjs
        └── qwen.mjs                        # 从零写,参照 gemini.mjs ~11–15K 尺寸
```

**注**:gemini 不拆 tracked-jobs/workspace/fs——等价逻辑**分散在 companion / job-control / hook** 三处(例:`resolveWorkspaceRoot` 在 `gemini-companion.mjs:79-90`,两个 hook 里也各有本地实现)。我们走 gemini 血统,因此不引入 codex 的 `tracked-jobs.mjs` / `workspace.mjs` / `fs.mjs`。**Phase 2 第一件事是列依赖清单**(§7 Phase 2 详细化),而不是直接复制字节。

### 2.3 手工改写 vs 字节起点 的分界

| 类别 | 文件 | 备注 |
|---|---|---|
| **字节起点**(自 gemini) | `scripts/lib/{args,process,git}.mjs`、`schemas/review-output.schema.json`(来自 codex) | 仍需 scan 一次,确认无硬编码 `gemini` 字样 |
| **轻度改写**(常量/字样) | `scripts/lib/{state,render,prompts,job-control}.mjs`、`scripts/session-lifecycle-hook.mjs`、`scripts/stop-review-gate-hook.mjs`、`prompts/*` | `state.mjs` 沿用已有的 `$CLAUDE_PLUGIN_DATA` + `$TMPDIR` fallback,仅改 slug/env 名;`job-control.mjs` 17.4K 必须先做**依赖解耦清单**(§7 Phase 2) |
| **重写**(CLI 差异) | `scripts/lib/qwen.mjs`(对应 `gemini.mjs`,参照 ~11–15K 尺寸) | 位置参数 + stream-json + `--continue/--resume`;认证探活处理 `[API Error:`;proxy 注入(§4.3);判错五层(§5.1);fg/bg 差异化解析(§4.4) |
| **不引入** | codex 独有的 `scripts/app-server-broker.mjs`、`scripts/lib/{app-server,app-server-protocol.d.ts,broker-endpoint,broker-lifecycle,tracked-jobs,workspace,fs}.mjs` | Codex MCP app-server;gemini 把 tracked/workspace/fs 能力分散到其他文件 |
| **从零写**(对应命令与 skill) | 7 个 `commands/*.md`、1 个 `agents/qwen-rescue.md`、3 个 `skills/*/SKILL.md`、2 个 `prompts/*.md` | 全换 qwen 字样;prompting skill 换 qwen3.6 特性 |

### 2.4 命名对齐

| 要素 | codex | gemini | kimi | **qwen** |
|---|---|---|---|---|
| marketplace | `openai-codex` | `gemini-plugin` | `kimi-plugin` | `qwen-plugin` |
| owner | OpenAI | bing | bing | bing |
| plugin 名 | `codex` | `gemini` | `kimi` | `qwen` |
| source | `./plugins/codex` | `./plugins/gemini` | `./plugins/kimi` | `./plugins/qwen` |
| Session env | `CODEX_COMPANION_SESSION_ID` | `GEMINI_COMPANION_SESSION_ID` | `KIMI_COMPANION_SESSION_ID` | `QWEN_COMPANION_SESSION_ID` |
| State 根目录 | `$CLAUDE_PLUGIN_DATA` 或 `$TMPDIR/codex-companion/` | `$CLAUDE_PLUGIN_DATA` 或 `$TMPDIR/gemini-companion/` | (未涉及) | `$CLAUDE_PLUGIN_DATA` 或 `$TMPDIR/qwen-companion/` |
| Subagent | `codex:codex-rescue` | `gemini:gemini-agent` | n/a | `qwen:qwen-rescue` |
| 斜杠命令 | `/codex:*` | `/gemini:*` | `/kimi:*` | `/qwen:*` |

---

## 3. 组件职责

### 3.1 Companion 主脚本 `scripts/qwen-companion.mjs`

| 子命令 | 作用 | 关键产物 |
|---|---|---|
| `setup` | 探测安装、认证、proxy、chat_recording、qwen-hooks | JSON 状态 |
| `review` | 对 diff 做标准 review | JSON(符合 schema) |
| `adversarial-review` | review 加挑战性 prompt 框架 | 同上 |
| `task` | rescue 用;foreground/background spawn | stdout 透传 |
| `task-resume-candidate` | `/qwen:rescue` 决策"续/新" | `{available: bool}` |
| `status` | 列 job / 单 job 详情 | markdown 表 |
| `result` | 取已完成 job 的最终输出 | 存档 JSON 负载 |
| `cancel` | 终止 background 子进程 | 状态转移报告 |

### 3.2 三个 skill(均 `user-invocable: false`)

- **`qwen-cli-runtime`**:`qwen:qwen-rescue` 的内部合约(路由 flag 剥离、默认行为、`--unsafe` 语义、`--resume`/`--fresh` 映射)
- **`qwen-prompting`**:qwen3.6 的 prompt 诀窍 + `references/`(中英混写稳、`--system-prompt` 塞 schema、`mcp_servers` 空时别摸文件)
- **`qwen-result-handling`**:Claude 拿到 qwen stdout 后怎么呈现(保留 verdict/findings/next-steps、review 后 STOP、malformed 时给 stderr tail)

### 3.3 Agent `agents/qwen-rescue.md`

薄转发器:
- `subagent_type: qwen:qwen-rescue`, `tools: Bash`, `skills: [qwen-cli-runtime, qwen-prompting]`
- 一次 `Bash` 调 `qwen-companion task ...`,stdout 原样返回
- `--effort` 透传但 companion 层丢弃(§9-3)
- `--model` 默认不传
- **默认 `--approval-mode auto-edit`**;`--unsafe` 显式切 yolo
- **Background 未显式 `--unsafe`**:companion 拒启动,返回 `require_interactive`
- `--resume` → `-c` 或 `-r <id>`,`--fresh` → 不传

**决策背景**:`yolo` 等价"auto-approve all tools";background + yolo = 后台不可见放行,安全边界问题,不是便利。

**Foreground 策略开放项**:当前默认 `auto-edit`,但 qwen 对非 edit 工具(如 `run_shell_command`)仍 prompt。Claude 的 Bash 子进程无 TTY,若 qwen prompt 会 hang 还是 auto-deny 是**未知**。**Phase 0 必做探针**(§6.2 case 11):
- 若 auto-deny:当前 `auto-edit` 默认 OK
- 若 hang:改为"foreground 也要 `--unsafe`"对称方案,v3 保留可回退说明

### 3.4 命令 `commands/*.md`(7 个)

Frontmatter 对齐 codex,关键差异:
- `setup.md`:安装候选动态;未认证提示 `! qwen auth coding-plan`;报告里列 `qwen hooks list`(§4.5)
- `review.md` / `adversarial-review.md`:`--wait|--background`、`--base <ref>`、`--scope`;`AskUserQuestion` 一次选执行模式
- `rescue.md`:走 Agent 工具;`task-resume-candidate` 决策续/新;**示例区预埋自救引导**:"若收到 `require_interactive` 错误,加 `--unsafe` 参数重跑 = background yolo 模式"
- `status.md` / `result.md` / `cancel.md`:纯 Bash passthrough

### 3.5 Hooks

| Hook | 脚本 | 作用 |
|---|---|---|
| `SessionStart` | `session-lifecycle-hook.mjs` | 写 session id 到 state |
| `SessionEnd` | `session-lifecycle-hook.mjs` | 归档 |
| `Stop` | `stop-review-gate-hook.mjs` | 可选 stop-time review,默认关闭,`/qwen:setup --enable-review-gate` 打开 |

### 3.6 Schema & Prompts

- `schemas/review-output.schema.json`:字节复制 codex
- `prompts/stop-review-gate.md`、`prompts/adversarial-review.md`:轻度改字

---

## 4. 数据流

### 4.1 典型调用链(`/qwen:rescue --background --unsafe "fix flaky test"`)

```
Claude Code
  └─► /qwen:rescue
        └─► Agent(subagent_type=qwen:qwen-rescue)
              └─► Bash: node qwen-companion.mjs task --background --unsafe "fix flaky test"
                    ├─► [companion]
                    │     ├─ 读 ~/.qwen/settings.json → 取 proxy
                    │     ├─ 读 env CLAUDE_PLUGIN_DATA → state 目录
                    │     ├─ writeJob(status=running, approvalMode=yolo, unsafeFlag=true, pgid)
                    │     └─► spawn qwen (位置参数) --output-format stream-json --approval-mode yolo
                    │           └─ ChildProcess(detached, new pgid)
                    │
                    │  (background 分支)
                    │     ← 边解析 stream-json 边判错;assistant text 命中 /\[API Error:/
                    │       → 标红 + SIGTERM → 等 child.on('exit') 或 500ms → 写 failure + fsync
                    │     ← 解析 result → §5.1 五层判终
                    │     └─► child.unref(); companion 退出;/qwen:status 看后续
                    │
                    │  (foreground 分支,如果 --wait)
                    │     ← 流式透传 assistant.text 到 companion stdout
                    │     ← 等 child 自然退出(不 unref);解析 result 后再 §5.1 判终
                    │     └─► companion 退出码 = qwen 失败分类
```

### 4.2 Spawn qwen 的参数装配(`qwen.mjs` 核心)

```js
// 决定 approval-mode
let approvalMode = userApprovalMode;
if (!approvalMode) approvalMode = unsafeFlag ? "yolo" : "auto-edit";
if (background && !unsafeFlag && approvalMode === "yolo") {
  throw new CompanionError("require_interactive",
    "Background rescue with yolo requires --unsafe. Add --unsafe or switch to foreground.");
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

const { env, warnings } = buildSpawnEnv(userSettings);    // §4.3
args.push(prompt);                                         // 位置参数

const child = spawn("qwen", args, {
  env, cwd,
  detached: true,                                          // 独立 pgid
  stdio: ["ignore", "pipe", "pipe"],
});

writeJob({ jobId, pid: child.pid, pgid: child.pid,
           approvalMode, unsafeFlag, warnings, ... });

if (background) {
  child.unref();                                            // 允许 companion 退出
} else {
  await new Promise((resolve, reject) => {
    child.stdout.pipe(process.stdout);                      // foreground 透传
    child.on("exit", resolve);
    child.on("error", reject);
  });
}
```

### 4.3 Proxy 注入

```js
function buildSpawnEnv(userSettings) {
  const env = { ...process.env };
  const proxy = userSettings?.proxy;
  const warnings = [];

  // 步骤 1:四键全量收集 + 内部一致性检查
  const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
  const seen = PROXY_KEYS
    .map(k => ({ key: k, value: env[k] }))
    .filter(x => x.value);
  const uniqueValues = [...new Set(seen.map(x => x.value))];
  if (uniqueValues.length > 1) {
    warnings.push({
      kind: "proxy_env_mismatch",
      message: "env has conflicting proxy values across HTTP(S)_PROXY keys",
      detail: seen,
    });
    // env 内部就乱,不动 env(信任 env 作者);跳过注入
    return { env, warnings };
  }
  const existing = uniqueValues[0];

  // 步骤 2:settings vs env 对齐
  if (proxy) {
    if (!existing) {
      // 四键都写(避开 Linux undici 大小写敏感 / Go qwen 优先大写)
      for (const k of PROXY_KEYS) env[k] = proxy;
    } else if (existing !== proxy) {
      warnings.push({ kind: "proxy_conflict", settings: proxy, env: existing });
      // 不覆盖,让 qwen 自己的 env 继续用
    }
    // existing === proxy 时 noop
  }

  // 步骤 3:NO_PROXY merge
  const defaultBypass = ["localhost", "127.0.0.1"];
  const userBypass = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const merged = Array.from(new Set([...userBypass, ...defaultBypass])).join(",");
  env.NO_PROXY = env.no_proxy = merged;

  return { env, warnings };
}
```

`setup` 返回 `proxyInjected`、`warnings[]`。

**未处理(§9-8)**:macOS Network Preferences / Windows 系统代理不落 env,覆盖不了;Phase 0 探针确认影响面。

### 4.4 Stream-json 消费(`qwen.mjs::parseStream`)

**Foreground 与 background 分野处理**:

| 模式 | 行为 |
|---|---|
| **foreground** | 边读边透传 stdout;**不做**即时判错(避免半截错误 + 截断);读完 result 事件后整体走 §5.1 五层判终;companion exit code 反映判终结果 |
| **background** | 边解析边判错:每到一块 assistant text,检测 `/\[API Error:/`(不锚 `^`,覆盖前导空白/换行/fence);命中即:① 标记 `apiError=true`;② 对 pgid 发 SIGTERM;③ **等 `child.on('exit')` 或 500ms timeout**(防 fs.renameSync 未完成);④ 写 failure + fsync;⑤ 退解析循环 |

**事件类型**:

| 事件 | 用途 |
|---|---|
| `system.init` | 抓 `session_id` 写 job.json;记录 `model`/`tools`/`mcp_servers` |
| `assistant` | 透传 / 累积;background 下扫 API Error 子串 |
| `result` | 进 §5.1 最终判终 |

### 4.5 Authentication 探活(`setup` 子命令)

```
setup
  ├─ qwen -V                                   → installed?
  ├─ qwen auth status(parser 碎 → authMethod:"unknown" 继续)
  ├─ 读 ~/.qwen/settings.json                   → chatRecording, proxy, model
  ├─ qwen hooks list                           → qwenHooks[](§9-9)
  ├─ buildSpawnEnv()(§4.3)                    → env + warnings
  ├─ spawn qwen "ping" --output-format stream-json --max-session-turns 1
  │    ├─ §5.1 五层判终
  │    └─ 成功 → authenticated=true, model 从 init 事件拿
  └─ JSON:
     { installed, version,
       authenticated, authDetail, authMethod,
       model, configured_models,
       chatRecording, proxyInjected, warnings,  // warnings 含 proxy_env_mismatch/proxy_conflict
       qwenHooks,                               // 带 hook 类型 (PreToolUse/PostToolUse/...)
       qwenHooksBlockingWarning,                // true 若任一 hook 为 PreToolUse 类(§3.4/§9-9)
       installers: { npm, brew, shellInstaller } }
```

**原则**:`qwen auth status` 只证"已配置",不证"token 可用"——必须 ping 判终才算 authenticated。

**阻塞 hook 警告**:若 `qwen hooks list` 含 `PreToolUse` 类型(可能弹交互确认),`/qwen:setup` 输出高亮 Warning,解释:"qwen 侧的阻塞 hook 可能与 rescue yolo 模式冲突,导致 job hang 至 timeout"。

### 4.6 State 目录 + job.json schema

```
$CLAUDE_PLUGIN_DATA/state/<workspace-slug>-<sha256[:16]>/
  ├─ state.json          # { version, config: {stopReviewGate}, jobs: [...] }
  └─ jobs/
      └─ <jobId>.json    # { jobId, kind, status, phase, pid, pgid, sessionId,
                         #   approvalMode, unsafeFlag,
                         #   startedAt, finishedAt, cwd, prompt,
                         #   logPath, result, failure, warnings }
```

**Schema 兼容性声明**:`approvalMode`、`unsafeFlag`、`warnings`、`pgid` 是 qwen 插件新增字段。`state.mjs`/`job-control.mjs`/`status`/`result` 路径**是 schema-open 的**(未知字段透传不报错)。**Phase 2 首日验证**:grep gemini 血统下所有 `JSON.parse(jobFile)` 和 `jobs/` 读路径,确认无严格校验。

Workspace 指纹:`resolveWorkspaceRoot + sha256`;`MAX_JOBS=50` 滚动清理;fallback `$TMPDIR/qwen-companion/`。

---

## 5. 错误处理

### 5.1 五层判错 + 状态码优先分类

```js
function detectFailure({ exitCode, resultEvent, assistantTexts }) {
  // 层 1: 进程死
  if (exitCode !== 0 && exitCode !== null)
    return { failed: true, kind: "exit", code: exitCode };

  // 层 2: qwen 自报
  if (resultEvent?.is_error === true)
    return { failed: true, kind: "qwen_is_error" };

  // 层 3: result.result 含 [API Error:
  if (resultEvent?.result && /\[API Error:/.test(resultEvent.result))
    return classifyApiError(resultEvent.result);

  // 层 4: 任一 assistant text 含 [API Error:
  const errLine = assistantTexts.find(t => /\[API Error:/.test(t));
  if (errLine) return classifyApiError(errLine);

  // 层 5: 空输出
  if (assistantTexts.length === 0 && !resultEvent?.result)
    return { failed: true, kind: "empty_output" };

  return { failed: false };
}

function classifyApiError(msg) {
  // 优先:从 "[API Error: ... (Status: NNN)]" 提状态码
  const statusMatch = msg.match(/\bStatus:\s*(\d{3})\b/i);
  if (statusMatch) {
    const code = parseInt(statusMatch[1], 10);
    if (code === 401 || code === 403) return { failed: true, kind: "not_authenticated", status: code, message: msg };
    if (code === 429)                 return { failed: true, kind: "rate_limited",      status: code, message: msg };
    if (code === 400)                 return { failed: true, kind: "invalid_request",   status: code, message: msg };
    if (code >= 500 && code < 600)    return { failed: true, kind: "server_error",      status: code, message: msg };
  }

  // DashScope 特定错误码(qwen 后端)
  if (/\b108\b|insufficient.*balance|quota.*exceed/i.test(msg))
    return { failed: true, kind: "insufficient_balance", message: msg };
  if (/\bsensitive\b|content.*(?:filter|policy|unsafe)|moderation/i.test(msg))
    return { failed: true, kind: "content_sensitive", message: msg };

  // 关键词兜底(加 \b 边界防误伤)
  if (/\brate.?limit\b|\bthrottl/i.test(msg))      return { failed: true, kind: "rate_limited",      message: msg };
  if (/\bquota\b|\bbilling\b/i.test(msg))          return { failed: true, kind: "quota_or_billing", message: msg };
  if (/\bunauthoriz|invalid.*access.?token/i.test(msg))
                                                    return { failed: true, kind: "not_authenticated", message: msg };
  if (/\bmax.*output.*tokens\b/i.test(msg))        return { failed: true, kind: "max_output_tokens", message: msg };
  if (/\bconnection\b|\bnetwork\b|\btimeout\b|\bECONNRESET\b|\bENOTFOUND\b/i.test(msg))
                                                    return { failed: true, kind: "network_error",    message: msg };

  return { failed: true, kind: "api_error_unknown", message: msg };
}
```

**`proxy_required` 派生规则**:仅在底层判为 `network_error` 且 `settings.proxy` 存在时,companion 层把 kind 升级为 `proxy_required`(或附加 `hint: "check proxy"`)。避免把 401/额度错误误导去清代理。

### 5.2 错误分类表

| kind | 触发 | `/qwen:result` 输出 | 建议动作 |
|---|---|---|---|
| `not_installed` | `qwen -V` 失败 | "qwen not found on PATH" | `/qwen:setup` 选 npm/brew/curl |
| `not_authenticated` | classifyApiError Status 401/403 或关键词 | 建议 `! qwen auth coding-plan` | 手动重登,再 `/qwen:setup` |
| `rate_limited` | Status 429 或关键词 `rate.limit/throttle` | "qwen 限流" | 等待 / 降模型 |
| `insufficient_balance` | DashScope 108 / balance 字样 | "Coding Plan 余额不足" | 续费 / 切 API key |
| `content_sensitive` | 内容安全 / moderation | "输入/输出触发内容安全" | 改写 prompt |
| `quota_or_billing` | 关键词 `quota/billing` | "账单类问题" | 续费 |
| `invalid_request` | Status 400 或关键词 | "请求非法" | 检查 prompt / session |
| `server_error` | Status 5xx | "qwen 服务端错误" | 稍后重试 |
| `max_output_tokens` | 关键词 | "输出超限" | 缩小 prompt / 分 diff |
| `network_error` | 关键词 `connection/network/timeout` | "网络层失败" | 检查 proxy / 网络 |
| `api_error_unknown` | `[API Error:` 但未命中子分类 | 原样回显 | 根据 message |
| `qwen_is_error` | `is_error:true` | qwen stderr tail | 透传 |
| `empty_output` | 五层 5 | "qwen 静默退出" | `/qwen:rescue --fresh` |
| `no_prior_session` | `-r <id>` exit 非 0 + stderr 说 session 不存在 | "续跑目标会话不存在" | 改 `--fresh` |
| `chat_recording_disabled` | 请求 `-c/-r` 但 settings 关了 | "chat recording 关闭" | 打开或 `--fresh` |
| `proxy_env_mismatch` | §4.3 step 1 | "env 内部 HTTP(S)_PROXY 值冲突" | 对齐 env |
| `proxy_conflict` | §4.3 step 2(settings vs env) | "settings 与 env proxy 不一致" | 对齐或清 env |
| `proxy_required` | `network_error` 派生(§5.1) | 派生 warning:可能是 proxy 缺失 | 检查 proxy |
| `spawn_error` | ENOENT/EPERM | companion 错误 | 透传 |
| `timeout` | 超 `DEFAULT_TIMEOUT_MS` | "timed out after Ns" | `/qwen:cancel` |
| `cancelled` | 用户 `/qwen:cancel` 成功 | "cancelled by user at <ts>" | 无 |
| `cancel_failed` | `/qwen:cancel` 时 `process.kill` 抛非 ESRCH 错 | "cancel 信号投递失败;子进程状态未知" | 手动 `kill -9` + `/qwen:result` |
| `orphan` | pid 不活但 status=running | "job 孤立" | 无 |
| `require_interactive` | background + 未 `--unsafe` | "background yolo 需 `--unsafe`" | 加 `--unsafe` 或 foreground |
| `schema_violation` | review 3 次尝试都未通过 | "schema 校验失败" + raw × 3 的前 4KB | 换模型 / `--fresh` |

### 5.3 Review JSON 修复(3 次尝试 = 首次 + 2 次 retry)

核心原则(Codex v2 review 重点修正):**retry 携带上一轮原始 raw 输出** + 完整 schema + 修复指令。**不**新开 session 丢弃 diff;**不**指望正则本地修复能搞定所有情况(但优先尝试)。

```js
async function reviewWithRetry({ diff, schema, runQwen }) {
  const attempts = [];
  let prompt = buildInitialPrompt(diff, schema);

  for (let i = 0; i < 3; i++) {
    const raw = await runQwen(prompt, { maxSessionTurns: i === 0 ? undefined : 1 });
    attempts.push(raw);

    // Step A: 原样 parse
    let parsed = tryParse(raw);
    if (parsed && ajvValidate(parsed, schema)) return { ok: true, parsed, attempts };

    // Step B: 本地 JSON repair(去 fence / 补尾部 } / 去前言)
    parsed = tryLocalRepair(raw);
    if (parsed && ajvValidate(parsed, schema)) return { ok: true, parsed, attempts, repairedLocally: true };

    // 准备 retry prompt:携带原文 + schema + 具体错误
    if (i < 2) {
      const ajvErrors = getAjvErrors(parsed, schema).slice(0, 5);  // 前 5 条
      prompt = buildRetryPrompt({
        previousRaw: raw,
        schema,
        ajvErrors,
        attemptNumber: i + 1,
      });
    }
  }

  return { ok: false, kind: "schema_violation", attempts };
}
```

Retry prompt 模板要点:
- 贴上一次 raw(可截断到 8KB;如果 > 8KB 取头 4KB + 尾 2KB + 中段省略标记)
- 贴完整 schema(不省略)
- 贴 ajv 错误路径(人类可读)
- 指令:"Fix the JSON to match the schema. Output ONLY the corrected JSON, no prose, no code fences."
- retry 第 2 次(最后一次)prompt 末尾加:"This is your final attempt. Output the JSON now."

**session 策略**:retry 复用同一 qwen session(`-c`)时,qwen 能看到上次的 diff + 上次的 raw,prompt 只传修复指令,token 预算省;若 `chatRecording=false`,fallback 到"重贴 diff 的前 8KB + raw + schema"(会超 token 时取 §5.2 `max_output_tokens` 分类)。

### 5.4 Background job 状态机

```
queued ─► running ─► completed
                ├──► failed        (§5.1 五层任一红)
                ├──► cancelled     (cancel 全流程成功)
                ├──► cancel_failed (cancel 非 ESRCH 错)
                ├──► timeout       (companion 监护超时)
                └──► orphan        (pid 不活但曾 running)
```

Companion 独占写 `jobs/<id>.json`(atomic rename);`status` 每次读用 `process.kill(pid, 0)` 探活,不活且 running → 标 `failed + kind=orphan`。

### 5.5 Cancel 原子性

**前提**:子进程 `detached: true`(§4.2),pgid 独立。流程:

```
对 pgid 依次发 SIGINT(2s 等 exit) → SIGTERM(2s 等) → SIGKILL
每次 process.kill(-pgid, sig):
  try { ... } catch (e) {
    if (e.code === 'ESRCH') continue;      // 子进程已死,正常
    // 其他错误:state 迁移为 cancel_failed,记 message,不继续发信号
    writeJob({ status: "failed", kind: "cancel_failed", failure: e.message });
    return;
  }
成功走完三级信号 → 写 status=cancelled
```

### 5.6 失败不自动治愈

- companion 不自动重跑 rescue
- companion 不自动改配置
- review 最多 3 次尝试(§5.3),超过就 `schema_violation`
- Claude 侧对 review findings **禁止自动改代码**,必须先问用户(由 `qwen-result-handling` 强制)

---

## 6. 测试与验收

### 6.1 分层

| 层 | 工具 | 跑法 | 覆盖 |
|---|---|---|---|
| 探针 | `doc/probe/*.sh` + `probe-results.json` | Phase 0 手跑 | stream-json 真实结构、401/timeout/schema 错、auto-edit 无 TTY 行为 |
| 单元 | `node:test` | `node --test scripts/lib/*.test.mjs` | args、qwen.mjs 解析、五层判错、classifyApiError 状态码优先、proxy env 检测、state slug/hash |
| 集成 | fixture + `PATH` 前置 mock-bin | `node --test tests/integration/*.test.mjs` | companion 全子命令 |
| 端到端 | 本机 Claude Code + 真 qwen | T-checklist 手跑 | `/qwen:setup` → rescue → status → result |

### 6.2 探针必抓 case

1. 正常 ping
2. 认证过期(撤销 token)
3. 模型不存在(`-m qwen-fake`)
4. 超时(长任务 + companion 强制超时)
5. `--continue` 恢复会话
6. `--session-id abc` 指定固定 id
7. review 场景(喂 diff 要 JSON 输出)raw
8. `-r <不存在 id>`(验 `no_prior_session`)
9. 撤 token 后 ping(`classifyApiError` Status 401 分类)
10. 系统级代理场景(§9-8)
11. **新增:`qwen --approval-mode auto-edit` + 无 TTY 遇 `run_shell_command` 行为**(§3.3 决定);具体做法:把 `/dev/null` 当 stdin,让 qwen 试图跑一个 shell 命令,观察 hang / auto-deny / auto-approve 哪种
12. **新增:抓真实 `[API Error: ... (Status: NNN)]` 样本**,验证 `classifyApiError` 状态码提取路径;至少覆盖 401/429/400/5xx 四种
13. **新增:大 diff(>200KB)review 的 stream-json 碎片拼接**(Gemini 实战 1.5 天踩点)

### 6.3 关键单元测试

`scripts/lib/qwen.test.mjs`:
- 五层判错所有组合(exit/is_error/result prefix/assistant text/空输出)
- `classifyApiError` 状态码优先路径:401/403→not_authenticated / 429→rate_limited / 400→invalid_request / 500-503→server_error
- `classifyApiError` DashScope 路径:108/insufficient_balance / sensitive
- 关键词 `\b` 边界:`"status 40101"` 不被当 401;`"503ms timeout"` 不被当 5xx
- 不锚正则:`"  [API Error: 401"` / `"\n[API Error: 429"` / 带 fence 的都能命中
- Foreground 不即时判错;background 命中即 SIGTERM + 等 exit(fake child 观测)
- 多行 JSONL 空行/坏行 parser 不崩
- `detectFailure` 签名:拆参数后分支可独立测
- `reviewWithRetry` 三轮:第一轮成功;第一轮 schema_violation 第二轮成功(带原 raw);三轮都失败

`scripts/lib/qwen-proxy.test.mjs`:
- settings 有 + env 无 → 注入四大小写
- settings 有 + env 一致 → noop
- settings 有 + env 不一致 → `proxy_conflict` warning,不覆盖
- env 内部四键值不一致 → `proxy_env_mismatch` warning,跳过 settings 注入
- settings 无 + env 无 → 不注入,仅 NO_PROXY merge
- user `NO_PROXY=foo` → 最终 `foo,localhost,127.0.0.1`

`scripts/lib/state.test.mjs`:
- slug+hash 幂等
- `MAX_JOBS=50` 滚动
- 并发写 atomic rename
- pid 活探测 → orphan
- job.json 新字段(approvalMode/unsafeFlag/warnings/pgid)写入/读出对称

`scripts/lib/args.test.mjs`:
- 带引号/空格/转义/中文/shell 特殊字符的解析
- `--effort/--model/--resume/--fresh/--background/--wait/--unsafe` 识别+剥离

`scripts/lib/cancel.test.mjs`:
- pgid SIGINT→SIGTERM→SIGKILL 递进,fake `process.kill` 观测调用序
- ESRCH 吞掉,继续下一级
- 非 ESRCH 错(如 EPERM)→ `cancel_failed` 状态迁移 + message 记录

### 6.4 集成测试

`tests/fixtures/mock-bin/qwen` 按 `QWEN_MOCK_CASE` env 输出 fixture。

覆盖:
- `setup` 五态(未装 / 未认证 / chat_recording 关 / proxy_conflict / 全好)
- `task` foreground 成功 + §5.1 各 kind 失败(每 kind 一 fixture)
- `task --background` 生命周期
- `task --background`(无 `--unsafe`)→ `require_interactive`
- `cancel` running / 已死(ESRCH)/ 权限错(EPERM → cancel_failed)
- review:首轮通过 / retry 1 通过 / retry 2 通过 / 3 轮全败 `schema_violation`
- 并发 job(两 companion 同目录)
- Bash 参数转义(`$(whoami)` `'` `"` `&`)

### 6.5 T-checklist(端到端手动)

| # | 场景 | 通过判据 | 必过 |
|---|---|---|---|
| T1 | `claude plugins add ./plugins/qwen` | 命令可见 | ✓ |
| T2 | `/qwen:setup` | `authenticated:true`,ping 通,`authMethod` 正确,`warnings` 合理 | ✓ |
| T3 | `/qwen:setup --enable-review-gate` | `stopReviewGate=true` |  |
| T4 | `/qwen:rescue --wait "explain this repo"` | 30s 内返回 | ✓ |
| T5 | `/qwen:rescue --background --unsafe` + `/qwen:status` | **100ms 间隔 polling 5 次内**看到 running | ✓ |
| T5' | `/qwen:rescue --background`(无 `--unsafe`) | 立即返回 `require_interactive` | ✓ |
| T6 | `/qwen:status <id> --wait` | 转 completed | ✓ |
| T7 | `/qwen:result <id>` | 原文回显 | ✓ |
| T8 | `/qwen:cancel <id>`(2s 内发起) | 2s 容忍内转 cancelled;`ps -p <pgid>` 无残留 | ✓ |
| T9 | `/qwen:review`(有 diff) | 通过 schema(≤3 轮) | ✓ |
| T10 | `/qwen:adversarial-review` | 挑战框架 findings | ✓ |
| T11 | 撤 token 后 rescue | `not_authenticated` kind | 软 |
| T12 | settings 有 proxy、env 无 → rescue | 跑通;job.json `warnings=[]` | ✓ |
| T13 | `-r <伪 id>` | `no_prior_session` + 建议 `--fresh` | 软 |
| **T14** | diff > 200KB `/qwen:review` | ① job.json `status=completed` 且 `result` `JSON.parse` 无误;**或** ② `kind=max_output_tokens`;**严禁**:`exit 0` + assistantTexts 截断致 JSON 尾部缺失(silent fail) | ✓ |
| **T15** | 两终端同时 `/qwen:rescue --background --unsafe` | 两 job 都完成,各自 job.json schema 合法 | ✓ |
| **T16** | prompt 含 `$(whoami)` `'` `"` `&` | stream-json init 事件的 prompt 字段原样含这些字符,未被 shell 二次解释 | ✓ |

### 6.6 CI

v0.1 本机 `node --test` 通过;GitHub Actions 留 v0.2。

---

## 7. 阶段划分

### Phase 0 · 探针(0.5 天)

- §6.2 的 13 个 case 全跑,落 `probe-results.json`。
- 重点:**case 11 `auto-edit` 无 TTY 行为** 决定 §3.3 foreground 是否要改对称 `--unsafe`。
- **case 12 API Error Status 样本** 为 `classifyApiError` 正则回归基线。
- **case 13 大 diff 碎片** 为 Phase 3 retry 策略校验基线。

### Phase 1 · Setup(1.5 天)

只实现 `commands/setup.md` + `qwen-companion.mjs setup`:
- `getQwenAvailability` → `qwen -V`
- `getQwenAuthStatus` → 解析 auth status(含 fallback) + ping
- `buildSpawnEnv`(§4.3:四键比对 + 冲突检测 + NO_PROXY merge)
- `detectInstallers` → npm/brew/curl
- `qwen hooks list` + 阻塞类型识别
- JSON:含 `warnings[]` / `qwenHooksBlockingWarning`

### Phase 2 · Rescue + Skills(3 天)

**Day 1(依赖解耦 + 字节起点拷贝,0.5 天)**:
- 列出 `gemini-companion.mjs` / hooks 里所有被 `job-control.mjs` 隐式依赖的 helper(至少 `resolveWorkspaceRoot`、`readStdin`、`generateJobId`、logger 工厂)
- 决定:迁入 `qwen-companion.mjs` 等价位置 or 新建 `lib/workspace-helpers.mjs`
- grep `GEMINI` / `gemini-` / `gemini_companion` 字面量,列替换清单
- 拷贝 `args/process/git/render/prompts/state` 字节起点;`job-control.mjs` 拷贝后未启用

**Day 2–3**:
- 写 `agents/qwen-rescue.md` + 3 skill
- `qwen.mjs` 从零写:spawn(含 detached + unref 分支)、五层 detectFailure、classifyApiError 状态码优先、fg/bg 解析分野、SIGTERM 等 exit/500ms
- `task` 子命令:foreground + background + `--unsafe` + `--resume-last`
- `cancel` 子命令:pgid 信号递进 + ESRCH 吞 + cancel_failed
- 单元测试 5 个文件(§6.3)

### Phase 3 · Review 系(4 天)

- `review` / `adversarial-review` 子命令
- `schemas/review-output.schema.json` 字节复制 codex
- `prompts/*.md` 轻改
- **`reviewWithRetry` 3 轮:首次 + 2 retry;携原 raw + schema + ajv 错误;session `-c` 续跑 + fallback**(§5.3)
- `tryLocalRepair`(去 fence / 补尾 `}` / 去前言)
- 单元测试:三轮成功路径 + 本地 repair 路径 + 全败路径

> Gemini 实战数据:做 gemini-review 4.5 天(1.5 天 JSON 碎片拼接 + 1 天 prompt 迭代 + 1 天大 diff 压测)。我们分到 4 天已含 spike buffer 的压缩。

### Phase 4 · status/result/cancel + hooks(1.5 天)

- `status/result/cancel` + pgid 信号 + ESRCH
- `hooks/hooks.json` + 两 hook 脚本
- `/qwen:setup --enable-review-gate`
- orphan 迁移

### Phase 5 · 打磨 & 文档(0.5 天)

- `lessons.md`
- `CHANGELOG.md`
- README / CLAUDE.md

**合计**:**11 天**(0.5 + 1.5 + 3 + 4 + 1.5 + 0.5)。显式 spike buffer 条件见 §9-11。

---

## 8. 开工前 must-have

- [ ] 重登 `qwen auth coding-plan`,Phase 0 probe case 2/9/12 能跑
- [ ] 确认 `~/.qwen/settings.json::chatRecording` 开启
- [ ] 拷 codex 插件到 `plugins/qwen/` scaffold(空文件)作基线
- [ ] `lessons.md` 骨架,先记 "qwen is_error 不可信"、"retry 必须携 raw + schema"
- [ ] `marketplace.json` / `plugin.json` / `CLAUDE.md` / `CHANGELOG.md` / `.gitignore` 初始化

---

## 9. 开放问题 / 风险

1. **Yolo + background 安全**:禁止隐式,必须显式 `--unsafe`。foreground 默认 `auto-edit`,但**`auto-edit` 对非 edit 工具的无 TTY 行为未验证**(Phase 0 case 11)。若 hang → v3 回退为"foreground 也要 `--unsafe`"。
2. **Proxy 注入**:settings 无 → 不注入;settings 有 + env 无 → 注入四大小写;settings 有 + env 冲突 → warning 不注入;env 内部不一致 → `proxy_env_mismatch` 跳过注入。剩余风险:settings proxy 本身失效。
3. **`--effort` 语义差**:透传但 companion 丢弃,`qwen-cli-runtime` SKILL.md 显式说明。
4. **Qwen CLI 未来版本**:0.14.5 stream-json 同 kimi;Phase 0 probe 做基线;破坏性变更靠 v0.2 CI。
5. **Coding Plan token 周期**:setup 必须稳定检测 + 指引 `! qwen auth coding-plan`。
6. **Kimi 同代际对齐**:Phase 2 开写前若 kimi 完工,允许重走 §2.3 分类。
7. **`qwen auth status` 不证可用**:§4.5 强制 ping 判终。
8. **系统级代理未覆盖**:Phase 0 probe case 10 确认影响面;若常见,v0.2 加 `scutil --proxy`。
9. **Qwen hooks 互感知**:setup 读 `qwen hooks list` + 阻塞 hook 警告。
10. **gemini 血统隐式依赖**:Phase 2 Day 1 做依赖解耦清单,不是 scan 字面量那么简单。
11. **Phase 3 spike buffer 触发条件**:Phase 3 做完(进 Phase 4 前),**累计 20 次真实 review**,`schema_violation` 失败率 > 10% → 触发 1 天 spike(增加示例、调 temperature、调整 retry 文案),由 bing 拍板是否延后 Phase 4。若样本不足 20,Phase 5 前再评估。

---

## 10. 参考

- 前置调研:`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-research.md`
- 两轮三方 review:`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-review-{claude,merged,claude-v2,merged-v2}.md`
- 模板源:`~/.claude/plugins/cache/openai-codex/codex/1.0.4/`
- 姊妹样本:`/Users/bing/-Code-/{gemini,kimi,minimax}-plugin-cc/`
- Qwen CLI 上游:<https://github.com/QwenLM/qwen-code>

---

## 附录 A · 两轮 review 采纳记录

**v1 → v2**(第一轮三方 + bing 全采 P0+P1+P2):
- 默认 approval-mode 改 auto-edit + `--unsafe`
- spawn `detached:true` + pid/pgid
- proxy env 四大小写 + NO_PROXY merge
- 四层判错扩五层
- api_error 拆 6 子 kind
- retry 1 次 → 2 次(v2 口径)
- T14/T15/T16 新增
- 工时 7 → 9 天
- §9 新增置顶 yolo / auth status 不证可用 / 系统代理 / qwen hooks 感知

**v2 → v3**(第二轮三方 + bing 全采):
- **§5.3 retry 方向重写**:携带上一轮 raw + schema + ajv 错误,不新开 session 丢 diff;先 `tryLocalRepair`(Codex P0)
- **§4.2 `child.unref()` 分支化**:仅 background unref,foreground Promise 等 exit(Claude P0)
- **§4.3 proxy env 内部不一致**:四键全量收集 + `proxy_env_mismatch`(Codex + Gemini)
- **§5.1 `classifyApiError` 状态码优先 + DashScope 特化**:`Status: NNN` 精确分类,补 `insufficient_balance`/`content_sensitive`,正则 `\b` 边界
- **§4.4 fg/bg 解析分野**:foreground 不即时判错;background SIGTERM 等 exit/500ms 防 orphan(Gemini 实战)
- **§5.5 `cancel_failed` kind**:非 ESRCH 错不悬停(Codex)
- **§5.2 `proxy_required` 收窄**:仅从 `network_error` 派生(Codex)
- **§4.5 阻塞 qwen hooks 警告**(Gemini)
- **§3.4 rescue.md 自救引导**(Gemini)
- **§1.3 / §5.3 口径**:"最多 3 次尝试(首次 + 2 retry)"
- **工时 9 → 11 天**(Gemini 实战 4.5 天 gemini-review 为证)
- **§9-11 spike buffer 条件精确化**:N≥20、>10%、bing 拍板
