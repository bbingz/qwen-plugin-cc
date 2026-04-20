# Spec v1 三方 Review 汇总

**来源**:`review-claude.md` + Gemini agent `a1171b7f3` + Codex agent `a50d9e137`
**评审对象**:`2026-04-20-qwen-plugin-cc-design.md` @ commit `0bee623`
**日期**:2026-04-20

---

## 架构级(头部 — 三方是否有分歧)

| 议题 | Claude | Gemini | Codex | 汇总判决 |
|---|---|---|---|---|
| **默认 `--approval-mode yolo`** | P1:foreground 不应默认 yolo,应 auto-edit | 未专门提 | **架构级问题**:default 不应 yolo,应仅显式开关启用 | **采纳**:默认不 yolo。rescue 需要"非交互"场景,改默认为 `--approval-mode auto-edit`;仅 `--unsafe` 或 `--yolo` 显式标志下才切 yolo。background rescue 若用户未指定 unsafe → 改回 foreground + 确认。**详见下文 A1** |
| **"字节复制"叙述过重** | 混血已修 | 反对:gemini lib 带隐式硬编码 | 具体指出 prompts 分类冲突 / state $CLAUDE_PLUGIN_DATA 已有 / job-control 能力分散 | **采纳**:全文把"字节复制"改为"以 gemini 版为起点 + 环境常量剥离"。**详见 A2** |

---

## 按节合并(P0/P1/P2 标注优先级)

### §2.3 改写分类表

| # | 来源 | 问题 | 修改 | P |
|---|---|---|---|---|
| 2.3-a | Codex | `prompts/*` 同时被归"轻度改写"和"从零写" | 改"轻度改写"(仅文案微调) | P1 |
| 2.3-b | Codex | `state.mjs 补 $CLAUDE_PLUGIN_DATA 支持` 不准(gemini 已有) | 改为"沿用 gemini 已有支持,仅改 slug/常量名" | P1 |
| 2.3-c | Codex | `job-control 已内嵌 tracked/workspace/fs 能力` 不准 | 改为"等价逻辑**分散在** companion / job-control / hook 三处" | P1 |
| 2.3-d | Gemini | `job-control.mjs` 应从"字节复制"移到"轻度改写" | 采纳 + Codex 2.3-c 一并改 | P1 |
| 2.3-e | Claude | `qwen.mjs` 尺寸参照 gemini.mjs ~11–15K,不是 codex.mjs 32K | 在分类表加尺寸备注 | P2 |
| 2.3-f | Claude | prompts.mjs 归类缺 | 2.3-a 已覆盖 | — |

### §2.2 lib 清单(上条 §2.3-d 的同步修改)

- lib/ 血统注释补一句"**Phase 2 开工前可改抄 kimi 最新版**" (Claude P2)

### §3.3 Agent 默认 approval

| # | 问题 | 修改 | P |
|---|---|---|---|
| 3.3-a | yolo 是架构级风险(Codex)+ foreground 不应默认 yolo(Claude) | **改 §3.3 + §4.2 默认**:rescue 默认 `--approval-mode auto-edit`;新增 companion 标志 `--unsafe`,仅该标志下切 yolo;foreground 用户可通过 args 显式改;background 若未显式 unsafe,**拒绝以 yolo 启动**,返回 `require_interactive` 错误引导 foreground | **P0** |

### §4.2 Spawn 参数

| # | 问题 | 修改 | P |
|---|---|---|---|
| 4.2-a | Claude:spawn 缺 `detached: true` 和 pgid 记录,cancel 会杀到 companion 自己 | 补 `{ detached: true, stdio: [...] }` + `child.unref()`;job.json 同时记 pid 和 pgid | **P0** |
| 4.2-b | Codex/Claude(3.3-a) | approvalMode 默认值改 auto-edit | P0(同 3.3-a) |

### §4.3 Proxy 注入

| # | 问题 | 修改 | P |
|---|---|---|---|
| 4.3-a | Codex:只检测大写 `HTTP_PROXY/HTTPS_PROXY`,qwen 读取顺序是 `HTTPS_PROXY/https_proxy/HTTP_PROXY/http_proxy` | 同时探测四种大小写 | **P0** |
| 4.3-b | Codex:已有任一 env 与 settings.proxy 不一致时,**不注入**而不是"继续用 env 的"(现 spec 逻辑),返回 `proxyConflict` warning | 修 `buildSpawnEnv` 逻辑 | **P0** |
| 4.3-c | Codex:`NO_PROXY/no_proxy` 应 merge 不硬写死 | 合并现有 NO_PROXY + 插入 `localhost,127.0.0.1` | P1 |
| 4.3-d | Codex:系统级代理(不在 env)未覆盖 | §9 开放问题加"未处理,待 Phase 0 探针确认" | P1 |
| 4.3-e | Claude:settings.proxy 与 user env HTTP_PROXY 不一致场景 | 4.3-b 已覆盖 | — |

### §4.5 Authentication 探活

| # | 问题 | 修改 | P |
|---|---|---|---|
| 4.5-a | Claude:`qwen auth status` 文本 parser 易在版本迭代时碎 | 加 fallback:parser 碎 → `authMethod: unknown`;ping 通即算 authenticated | P1 |
| 4.5-b | Codex(§9):`qwen auth status` 只证明"已配置",不证明"可用"。必须 ping 判终 | 4.5-a 合并 + §9 显式写 | P1 |

### §5.1 判错层数与 kind 分类

| # | 问题 | 修改 | P |
|---|---|---|---|
| 5.1-a | Codex:**缺第五层"无可见输出"保护**(exit 0 + is_error:false + assistant/result 为空 → 当前会被误判成功)。kimi 已有 guard | 加第五层:`assistantTexts.length === 0 && !result.event?.result` → `kind: empty_output` | **P0** |
| 5.1-b | Gemini:正则 `/^\[API Error:/` 的 `^` 锚太严,被前置空格/换行/code fence 绕过 | 改为 `/\[API Error:/` 不锚定 | **P0** |
| 5.1-c | Gemini:积完所有 text 再 `find`,background 长任务下用户傻等 | 改为**边解析边判错**;一旦命中 → 立刻 SIGTERM + 标红 | **P0** |
| 5.1-d | Claude:函数签名把 exitCode 和 stream-json result 事件混塞 | 签名改 `detectFailure({ exitCode, resultEvent, assistantTexts })` | P1 |

### §5.2 错误分类表

| # | 问题 | 修改 | P |
|---|---|---|---|
| 5.2-a | Codex:qwen 内部已区分 `rate_limit/authentication_failed/billing_error/invalid_request/server_error/max_output_tokens`(源码证实)。当前 `api_error` 一锅端太粗 | 把 `api_error` 拆成:`rate_limited`、`quota_or_billing`、`invalid_request`、`server_error`、`network_error`、`max_output_tokens`;原 `not_authenticated` 保留 | **P0** |
| 5.2-b | Codex:缺 `no_prior_session` (T13 要用,`qwen -r <id>` 不存在时 exit 1) | 加 kind | **P0** |
| 5.2-c | Claude:缺 `orphan`(pid 不活但 status=running) | 加 kind | P1 |
| 5.2-d | Claude:缺 `empty_output`(5.1-a 同步) | P0 | P0 |

### §5.3 Review JSON retry

| # | 问题 | 修改 | P |
|---|---|---|---|
| 5.3-a | Codex:qwen 无 codex 的原生 outputSchema 约束,固定 1 次 retry 不够 | v0.1 直接改 **2 次 retry**:第一次"JSON only",第二次"基于上次原文修复为合法 JSON" | **P0** |
| 5.3-b | Claude:retry 追加到原 prompt 会超 token(大 diff) | retry 新开一次 session,不重复贴 diff;或 `--max-session-turns 1` 强制一步到位 | **P0** |

### §6.5 T-checklist 补测

| # | 来源 | 新增 | P |
|---|---|---|---|
| 6.5-a | Claude | T5/T8 加"500ms/2s 延迟容忍"的竞态通过判据 | P1 |
| 6.5-b | Gemini | **T14 超大 diff**(检查 token 截断/payload 过大导致 silent fail) | P1 |
| 6.5-c | Gemini | **T15 并发 job**(两终端同时 rescue,验证 atomic rename) | P1 |
| 6.5-d | Gemini | **T16 Bash 参数逃逸**(prompt 含 `'` `"` `&` `$` 等) | **P0**(不测就是高危) |

### §7 阶段工时

| 评审方 | 建议 |
|---|---|
| Claude | 7.5 天(+0.5 给 Phase 1) |
| Codex | 8.5–9 天(Phase 3 最卡) |
| Gemini | 10–14 天(要留容错) |

**汇总**:**9 天**(Phase 0=0.5 / Phase 1=1.5 / Phase 2=2.5 / Phase 3=2.5 / Phase 4=1.5 / Phase 5=0.5)。Gemini 的 14 天包含可能的翻车 buffer,我们在 §9 显式写"若 Phase 3 retry 调不稳 → Phase 5 前加 1 天 spike"。

### §9 开放问题

| # | 新增/修改 | P |
|---|---|---|
| 9-a | **新增风险 6 置顶**:yolo + background = 后台自动批准全部工具。本方案 §3.3 已禁,但在开放问题里显式列出"禁用后的 UX 代价:所有 background rescue 需要先手动指定 `--unsafe`" | **P0** |
| 9-b | 新增风险 7:`qwen auth status` 只证"已配置"不证"可用",必须 ping 判终(4.5 已合并) | P1 |
| 9-c | 新增风险 8:系统级代理(不落 env)未覆盖,Phase 0 探针确认 | P1 |
| 9-d | 新增风险 9:`qwen hooks` 与 Claude Code hooks 互不感知(Claude 原提) | P2 |

### 其他节

- §1/§2.4/§4.4/§4.6/§5.4/§5.5/§5.6/§8/§10/附录 A:**三方一致无异议**。§5.4 需小补 `orphan` kind(已收)。

---

## P0 清单(不改不能开工)

1. **3.3-a / 4.2-b** 默认 approval 改 auto-edit,yolo 仅 `--unsafe` 显式开启;background 不允许隐式 yolo。
2. **4.2-a** spawn 加 `detached: true` + 记 pid/pgid。
3. **4.3-a / 4.3-b** proxy env 大小写四探 + 冲突时不注入 + `proxyConflict` warning。
4. **5.1-a** 加第五层 `empty_output` 保护。
5. **5.1-b / 5.1-c** 正则去 `^`,改边解析边判错,命中即 SIGTERM。
6. **5.2-a** api_error 拆 6 个子 kind。
7. **5.2-b / 5.2-d** 补 `no_prior_session` 和 `empty_output` kind。
8. **5.3-a / 5.3-b** retry 2 次 + retry 时不重贴 diff。
9. **6.5-d** T16 Bash 参数逃逸测试。
10. **9-a** 开放问题置顶 yolo UX 代价。

## P1 清单(v2 并入)

11. 2.3-a/b/c/d/e(§2.3 改写分类精度)
12. 4.3-c/d(NO_PROXY merge / 系统代理说明)
13. 4.5-a/b(auth 文本 parser fallback)
14. 5.1-d(detectFailure 签名)
15. 5.2-c(orphan kind)
16. 6.5-a/b/c(T5/T8 竞态 + T14/T15)
17. §7 工时改 9 天 + 显式 spike buffer
18. 9-b/c(系统代理 / auth status 不可信)

## P2 清单(plan 阶段处理也可)

19. 2.3-e(qwen.mjs 尺寸备注)
20. 2.2 lib 注释增强
21. 9-d(qwen hooks 感知)

---

## 决策请求给作者

P0 十条建议**全部采纳**(三方一致,且我同意)。P1/P2 请 **bing 决定**:

- 全部采纳 → 我直接改 spec v2
- 选择性采纳 → 告诉我哪些跳过
- 全部跳过 → 只改 P0,其他 v0.2 再说

默认推荐:**P0 + P1 全采,P2 放 plan 阶段**,这样 v2 稳但不会无限膨胀。
