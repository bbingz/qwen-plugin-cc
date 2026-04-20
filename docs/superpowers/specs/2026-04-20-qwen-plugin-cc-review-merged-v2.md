# Spec v2 三方 Review 汇总 — 第二轮

**来源**:`review-claude-v2.md` + Gemini `a757c7008` + Codex `abf9ff7c3`
**评审对象**:v2 design @ commit `5d46417`
**日期**:2026-04-20

---

## 结构性问题(头部)

v2 对 v1 三方建议的采纳**方向正确但有两类新漏洞**:

**类型 A — 采纳了形式漏了精神**(Codex 最狠)
- §5.3 retry 改成"新开 session 不贴 diff",实际**拿不到上一轮原始输出**,qwen 会产出"格式合法但内容失真/臆造"的 JSON——比 Claude 担心的"retry 饿死"更严重,是方向性错误。

**类型 B — 新建议和既有逻辑未整合**(Claude + Gemini 发现)
- foreground 默认 `auto-edit` 能不能跑通是**未验证假设**(qwen 对非 edit 工具仍 prompt,Claude Bash 无 TTY 可能 hang)
- `child.unref()` 无条件执行,foreground stdout 会截断
- SIGTERM 后立刻退出 companion,`fs.renameSync` 可能未完成 → job.json 变 orphan(Gemini 实战坑)

---

## 三方对照矩阵(不含第一轮已覆盖项)

| # | 议题 | Claude v2 | Codex v2 | Gemini v2 | 合并判决 |
|---|---|---|---|---|---|
| **1** | **§5.3 retry 方向错** | B-4 P1(retry 饿死) | **P0** 采了壳漏了精神;retry 拿不到原文会臆造 | Phase 3 2.5 天不够 | **P0 架构级**:retry 必须**携带上一轮原始 raw + schema + 修复指令**;或先做本地 JSON 修复尝试;新开 session 策略错 |
| **2** | §1.3 vs §5.3 retry 次数 off-by-one | A-1 P0 | P2 | — | **P1**:统一"最多 3 次尝试(首次 + 2 次 retry)" |
| **3** | foreground `auto-edit` 死锁假设 | **A-2 P0** | — | 2b P0 部分反驳(auto-edit 是安全底线不可退) | **未证实;Phase 0 探针必做**:qwen `auto-edit` 无 TTY 遇 `run_shell_command` 行为(hang/deny/auto);结果决定是否退回"foreground 也要 --unsafe" |
| **4** | `child.unref()` 无条件(P0) | **B-1 P0** | — | — | **P0**:改 `if (background) child.unref()`;foreground 用 Promise 等 exit |
| **5** | SIGTERM 后不等 500ms 退出 | — | — | **1b P1**(实战坑) | **P1**:SIGTERM 后等 `child.on('exit')` 或 timeout 500ms 再退 companion;否则 job.json rename 未完成 → orphan |
| **6** | §4.4 边解析边判错的 foreground stdout 顺序 | B-3 P1 | — | — | **P1**:foreground 读 result 再判(不边解析);background 才边解析边 SIGTERM |
| **7** | §4.3 buildSpawnEnv 四键内部不一致静默漏报 | — | **P1** | 2a P1(Node undici Linux 大小写敏感 + Go qwen 优先大写) | **P0**:四键全量收集 → 去重比对 → env 内部不一致单独报 `proxy_env_mismatch` warning;之后再决策是否注入 settings.proxy |
| **8** | §5.1 classifyApiError 不解析状态码 | B-2 P1(正则边界) | **P1**(`(Status: NNN)` 信号浪费) | 2c P1(DashScope 108 余额 / sensitive 内容拦截) | **P0**:`classifyApiError` 先提取 `Status: NNN` → 用状态码精确分类;未能提取时才关键词兜底;正则加 `\b` 边界;加 `insufficient.*balance|sensitive` 子类 |
| **9** | §4.6 job.json 新字段 schema 兼容 | B-8 P2 | **P1**(gemini status/result/job-control 读写未声明) | — | **P1**:spec 明确 state/job-control/status/result 模块 schema-open;Phase 2 开工首步 grep reader 确认新字段不挂旧路径 |
| **10** | §5.5 cancel 非 ESRCH 错误后状态悬空 | — | **P1** | — | **P1**:新增 kind `cancel_failed`;throw 后 companion 标 `failed + kind=cancel_failed + message`,而不是让 job 悬停 |
| **11** | §5.2 `proxy_required` 触发过宽 | A-3 P2(合并) | **P1**(会误伤 401/额度) | — | **P1**:`proxy_required` 仅在底层判为 `network_error` 且 settings.proxy 存在时派生;合并/弱化 `proxy_conflict` / `proxy_required` 叙述 |
| **12** | Gemini 自救引导:rescue.md 预埋 --unsafe 提示 | — | — | **3a P0** | **P1**:`commands/rescue.md` 示例加"若 `require_interactive`,加 `--unsafe` 重跑" |
| **13** | setup 探测 qwen 侧阻塞 hook 警告 | — | — | **3b P0** | **P1**:setup JSON 的 `qwenHooks[]` 若含 `PreToolUse` 类型,setup 渲染要高亮 Warning |
| **14** | job-control 搬迁显式依赖注入 | B-8 关联 | 第一轮采纳已提 | **1a P1**:Phase 2 必须解耦 `resolveWorkspaceRoot`/`readStdin` | **P1**:Phase 2 第一件事是解耦依赖清单,不是"scan GEMINI 字面量"这么轻描淡写 |
| **15** | Phase 3 工时 | B-6 Phase 2 要 3 天 | — | **1c**:gemini 实做了 4.5 天;建议 qwen Phase 3 +1.5 | **合并**:Phase 2 从 2.5 → 3 天;Phase 3 从 2.5 → 4 天;总工时 9 → **11 天**,spike buffer 另算 |
| **16** | spike buffer 触发条件不可执行 | B-7 P2 | **P2**(N≥20 样本、失败率 >10% 才触发) | — | **P2**:条件改为"Phase 3 做完前 20 次真实 review 的 schema_violation 失败率 > 10% → 触发 1 天 spike,作者拍板延后 Phase 4" |
| **17** | T14 判据精确化 | B-9 P2(T16) | — | **1d P2**(>200KB + 三条验证) | **P2**:采纳 Gemini 的具体化判据 |
| **18** | T5/T8 polling 频率 | B-5 P2 | — | — | **P2**:T5 改"100ms × 5 次内看到 running";T8 不变 |

---

## P0 清单(v3 必改)

1. **§5.3 retry 方向**:retry 必须携带上一轮原始 raw 输出 + 完整 schema + 修复指令;或先尝试本地 JSON 修复(缺括号/多 fence 等常见病)。**不** 另开 session 把 diff 丢掉。
2. **§4.2 `child.unref()` 分支**:`if (background) child.unref()`;foreground 走 Promise 等子进程 exit。
3. **§4.3 proxy env 内部不一致**:四键全量收集 + 比对,env 内部冲突独立报 `proxy_env_mismatch`,再决定是否注入。
4. **§5.1 `classifyApiError` 加状态码提取**:先 `Status: NNN` 精确分类,关键词只做 fallback;补 `insufficient_balance`(108) / `content_sensitive`(内容安全)子类;正则加 `\b` 边界。
5. **Phase 0 探针新 case**:`qwen --approval-mode auto-edit` + 无 TTY + 遇 shell_command 调用的行为(决定 §3.3 foreground 策略)。

## P1 清单(v3 合并)

6. §1.3 / §5.3 retry 次数口径统一
7. §4.4 foreground 不边解析,background 才边解析
8. §4.4/§5.5 SIGTERM 后等 exit(或 500ms timeout)再退 companion
9. §4.6 job.json schema 兼容声明 + Phase 2 grep reader
10. §5.5 新增 `cancel_failed` kind + 状态迁移
11. §5.2 `proxy_required` 仅从 `network_error` 派生
12. §3.4 rescue.md 预埋 `--unsafe` 引导
13. §4.5 setup 对阻塞型 qwen hooks 告警
14. §7 Phase 2 → 3 天;Phase 3 → 4 天;总 11 天(spike 另算)
15. Phase 2 首日显式做依赖解耦清单(resolveWorkspaceRoot / readStdin 等),不是"scan 字面量"

## P2 清单

16. §9-11 spike 触发条件精确化(N≥20、失败率阈值、作者拍板)
17. T14/T5/T8/T16 判据细化
18. `proxy_conflict` / `proxy_required` 在 §5.2 合并或分层

---

## 决策请求

规模比第一轮小,但更关键(有 5 条 P0 新漏洞):

**推荐**:P0 + P1 全采,P2 同步采。产出 **spec v3**,总工时调到 11 天 + 可能 1 天 spike buffer。

Foreground 默认策略(第 3 项):仍保留 `auto-edit`,但写入 Phase 0 探针必做,探针结果决定最终姿态(v3 里带"若 Phase 0 确认 hang 则改对称方案"的可回退说明)。

你 go 就 v3;想讨论哪条细节就挑号。
