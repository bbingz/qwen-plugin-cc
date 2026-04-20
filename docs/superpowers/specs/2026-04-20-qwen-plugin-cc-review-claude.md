# Spec v1 独立评审 — Claude Opus 4.7

**评审对象**:`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-design.md` @ `0bee623`
**评审者**:Claude Opus 4.7(作者自审 → 独立视角复审)
**日期**:2026-04-20

---

## 结构性问题(头部)

**无架构级分歧**。v1 在自审阶段已经修掉最严重的"lib 血统混血"(codex tracked-jobs/workspace/fs 和 gemini job-control 不兼容)。下面都是二级别的打磨建议。

---

## 按节评审

### §1 目标与范围 — 看过,无问题

`1.3 不做`的边界写得够明确。`1.4 成功标准`的 T-list 必过项与 §6.5 对齐。

### §2.2 仓库布局 — 1 处建议

> `└── lib/ # 整套 gemini 血统(8 文件,无 tracked-jobs/workspace/fs...)`

**建议补一行**:在 lib/ 注释后加 `# 字节基线 gemini v0.5.2 @ 2026-04-20,Phase 2 开工前可改抄最新 kimi`,避免后续开工时来回翻 §7 Phase 2。

### §2.3 改写分类表 — 2 处建议

**问题 1**:表里"重写"那行写 `qwen.mjs(对应 gemini 的 gemini.mjs / codex 的 codex.mjs)`,但 gemini.mjs 才 11K,codex.mjs 有 32.4K——两者不是同尺寸。应注明"**参照 gemini.mjs 尺寸,约 11–15K**",避免工时估算按 codex 的 32K 去估。

**问题 2**:表里没提 `scripts/lib/prompts.mjs`(codex 0.4K,gemini 0.4K)要不要动。应在"轻度改写"加入 `prompts.mjs`(改模板路径常量)。

### §2.4 命名对齐 — 看过,无问题

表格完整。

### §3 组件职责 — 1 处建议

**§3.3 Agent**:

> `默认加 --approval-mode yolo(保证 background 不卡)`

这是给 **background** rescue 的默认。foreground rescue 呢?foreground 用户可以交互,yolo 未必是最佳默认。建议明确:

- **background**:强制 yolo(否则一定卡)
- **foreground**:默认 `auto-edit`,用户可 `--approval-mode` 显式覆盖

否则一个 foreground rescue 跑 yolo 改了一堆文件,对 Claude Code 主线来说是"静默副作用",风险高。

### §4.2 Spawn 参数装配 — 1 处严重漏写

```js
spawn("qwen", args, { env, cwd });
```

**缺 `detached: true`**。§5.5 说 cancel 用 pgid 信号,但 Node 的 `spawn` 默认**不新建 process group**,qwen 子进程会和 companion 共享 pgid,`process.kill(-pgid, SIGINT)` 会连 companion 自己一起杀。必须:

```js
spawn("qwen", args, { env, cwd, detached: true, stdio: [...] });
childProcess.unref();  // 可选,让 companion 能先退
```

并在 job.json 里同时记 `pid` 和 `pgid`。这点不补 Phase 4 的 cancel 会翻车。

### §4.3 Proxy 注入 — 1 处边界未覆盖

当前逻辑:`user env 已有 HTTP_PROXY` 则不覆盖。但**未处理** `settings.proxy` 与 user env `HTTP_PROXY` **值不一致**的情况(§5.2 表里 `proxy_required` kind 提到了这个场景,但 §4.3 代码没对应的分支)。建议:

```js
if (proxy && env.HTTP_PROXY && env.HTTP_PROXY !== proxy) {
  warnings.push({ kind: "proxy_mismatch", settings: proxy, env: env.HTTP_PROXY });
}
```

把 warnings 透传到 setup JSON,让用户看到冲突。

### §4.4 Stream-json 消费 — 看过,无问题

### §4.5 Authentication 探活 — 1 处细节

setup 流程里 `qwen auth status` 是**文本解析**(§4.5 源文:`解析文本 → authMethod`)。但截图里那段文本是带颜色码、带图标的人类格式,parser 容易在 qwen 版本迭代时碎。建议加一行:

> 若 `qwen auth status` 解析失败,fallback 为"`authMethod: unknown`,但 ping 探活通过即视为 authenticated"。

让文本 parser 碎了不连带整个 setup 挂。

### §5.1 四层判错 — 1 处函数签名歧义

```js
function detectFailure(result, assistantTexts) {
  if (result.exitCode !== 0) ...
  if (result.event?.is_error === true) ...
```

`result` 对象同时塞了 `exitCode`(来自 ChildProcess 退出)和 `event`(来自 stream-json 的 result 事件),**来源不同、时机不同**。建议拆两个参数或用明确命名:

```js
function detectFailure({ exitCode, resultEvent, assistantTexts }) { ... }
```

避免实现时错把 `resultEvent.exitCode`(不存在)当 process exitCode。

### §5.2 错误分类表 — 1 处补充

遗漏了 **`quota_exceeded`**(Coding Plan 包月额度跑完)。qwen 会回什么尚未实测,Phase 0 探针要加一条"模拟额度用尽"(如果有办法),或留 `api_error` 里做子判(`/quota|rate limit/i`)。

### §5.3 Review JSON retry — 1 处风险

第二次 retry 的 prompt 把第一次的原 prompt **加长**了(追加了强化指令),若第一次 prompt 已经很大(有大 diff),第二次可能**超 max-session-turns 或 context**。建议:retry 时不追加到原 prompt,而是**新开一次 session**,只喂强化后的指令 + 原 diff 的 hash(不重复贴 diff)。

或者更简单:retry 时 `--max-session-turns` 设成 1,强制一步到位,禁止 qwen 去读文件/搜索。

### §5.4 / §5.5 状态机与 cancel — 2 处

**§5.4**:`orphan` kind(pid 不活但 status=running)没有在 §5.2 错误分类表里列。要补。

**§5.5**:已在 §4.2 反馈 `detached: true`,这里关联就够。另外"每步 try/catch ESRCH"的写法在 Node 里应是 `try { process.kill(...) } catch (e) { if (e.code !== 'ESRCH') throw }`,spec 里可以不写代码,但要说清"仅吞 ESRCH,其他错误要冒上去"。

### §6.5 T-checklist — 1 处竞态

**T5 的竞态**:`/qwen:rescue --background` 刚起就 `/qwen:status`,companion 可能还没 fsync 完 job.json。T5 的通过判据应改为 **500ms 内 polling 到 job 出现 in state**,而不是"立刻看到"。

**T8 的竞态同理**:cancel 刚起的 job,pgid 可能还没分配。T8 应允许"最多 2 秒延迟"。

### §7 阶段工时 — 1 处偏乐观

**Phase 1 估 1 天偏乐观**。setup 要:

- `getQwenAvailability`(简单)
- `qwen auth status` 文本解析 + fallback(中)
- `buildSpawnEnv` proxy 注入 + mismatch 检测(中)
- ping 四层判错(中-重)
- `detectInstallers` npm/brew/curl(简单)
- JSON 输出 + markdown 渲染(简单)
- kimi 的对等 Phase 1 实际花了多久?看 `kimi-plugin-cc/CHANGELOG.md` 应能校验。

**建议 Phase 1 = 1.5 天**,总工时 7.5 天。

**Phase 3 = 2 天也偏乐观**,review 要处理 retry、schema 校验、`--append-system-prompt` 塞 schema 的 token 预算、prompt 模板加载。**建议 Phase 3 = 2.5 天**。

### §8 开工前 must-have — 看过,无问题

### §9 开放问题 — 2 处补充

**补 6**:**`--approval-mode yolo` 在 background rescue 的安全后果**。yolo 意味着子进程可以任意 `write_file`、`run_shell_command`,background 下用户没机会干预。缓解:

1. job.json 记录 yolo 模式下 qwen 修改的文件列表(解析 stream-json 里的 tool_use 事件)
2. `/qwen:result` 里显式列出被动 yolo 改过哪些文件
3. Phase 0 探针验证 qwen 的 tool_use 事件结构能拿到目标路径

**补 7**:**Qwen CLI 自带的 `qwen hooks` 子命令**可能和 Claude Code 的 `hooks.json` 机制互相不知情。若用户在 qwen 侧配了 `PreToolUse` hook,rescue 任务跑 yolo 时可能被拦;setup 里应报告 `qwen hooks list` 的结果,让用户知情。

### §10 参考 — 看过,无问题

### 附录 A 三方 review 策略 — 看过,无问题

---

## 优先级总览

| 优先级 | 条目 | 影响 |
|---|---|---|
| P0(必改) | §4.2 `detached: true` 缺失 | cancel 翻车 |
| P0 | §5.1 函数签名歧义 | 实现阶段易写错 |
| P1 | §3.3 foreground rescue 不应默认 yolo | 安全副作用 |
| P1 | §4.3 proxy mismatch 分支 | 用户误配不可见 |
| P1 | §5.3 retry 超 token | 大 diff 场景 review 会崩 |
| P1 | §9 补 6 yolo 安全 | background rescue 静默改仓 |
| P2 | §2.3 prompts.mjs 归类;§2.3 qwen.mjs 尺寸;§4.5 auth parser fallback;§5.2 quota_exceeded;§5.4 orphan kind;§6.5 T5/T8 竞态;§7 工时 +1 天;§9 补 7 qwen hooks | 打磨 |
| P3 | §2.2 注释增强 | 可读性 |

**P0 两条不改不能开工**;P1 四条最好在 v2 之前定掉;P2 可以 spec v2 合并、也可以 plan 阶段处理。

---

## 结论

v1 骨架对齐做得好,混血问题自审已修。真正要补的只有 `detached: true` 和 foreground rescue 的 approval 默认——前者是实现陷阱,后者是安全姿态。其他都是打磨。等 Codex 和 Gemini 的评审回来,汇总合并到 v2。
