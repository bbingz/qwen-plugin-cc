# Spec v2 独立复审 — Claude Opus 4.7

**评审对象**:`2026-04-20-qwen-plugin-cc-design.md` v2 @ commit `5d46417`
**评审者**:Claude Opus 4.7(第二轮,v2 聚焦)
**日期**:2026-04-20
**范围**:不重复第一轮意见;检查 v2 新引入的问题 + 第一轮采纳准确性。

---

## 结构性问题(头部)

**v2 吸收方向正确,但两处采纳引入了新矛盾**。看下面 §1.3 和 §5.3 的 off-by-one、以及 §3.3 foreground 默认导致的 UX 破口。

---

## 第一轮采纳准确性

### 采纳 OK(看过无问题)

- §4.2 `detached: true` + `child.unref()` + pid/pgid 记录 ✓
- §4.3 四大小写 + NO_PROXY merge ✓
- §5.1 五层 + 不锚定正则 + `detectFailure` 签名 ✓
- §5.2 `api_error` 拆 6 子 kind ✓
- §6.5 新增 T5'/T14/T15/T16 ✓
- §7 工时 7 → 9 天 ✓
- §9 新增风险 1(yolo+bg 置顶)、7、8、9、10、11 ✓

### 采纳有瑕疵

**A-1. §1.3 vs §5.3 的 retry 次数对不上(P0)**

- §1.3 写:`v0.1 固定 2 次强化 prompt retry`
- §5.3 表格:`第 1 次 + retry 1 + retry 2` 共 **3 次尝试**

"2 次 retry" 其实就是"3 次尝试"(retry 意味着重做,首次不算 retry)。但 §1.3 的行文读起来像"最多 2 次尝试"。**修**:§1.3 改为 `首次 + 2 次 retry,共最多 3 次尝试`;或者把 §5.3 改为"retry 1"和"retry 2"合并成"最多 1 次 retry 加 1 次 final retry",文本要一致。否则实现阶段会出现"我以为是 2 次结果码了 3 次"的笑话。

**A-2. §3.3 采纳了 Codex 架构级建议,但 foreground 默认 `auto-edit` 破坏 rescue 的 fire-and-forget 语义(P1)**

原话:
> 默认 `--approval-mode auto-edit`(不再默认 yolo)

问题:`auto-edit` 允许自动批准 edit 工具,但 `run_shell_command` 仍会交互确认。而 `/qwen:rescue` 的语义是"Claude 发起 → qwen 独立跑 → 原样回结果"——foreground 模式下 qwen 每次要跑 shell 都要弹问,Claude 侧的 Bash 调用拿到的是一个"卡住等输入"的子进程,整个 rescue **会挂死**。

实际只有两个一致的姿态:
- **foreground 也默认 yolo**(放弃安全姿态,接受"fire-and-forget 就是 yolo")
- **foreground 也必须 `--unsafe`**(和 background 一致,用户必须显式)

当前 v2 的中间态("foreground auto-edit, background require `--unsafe`")**既不安全也不可用**——foreground 会因 shell 确认死锁,但用户不会预期。

**建议修**:§3.3 改为"foreground 和 background 对称:都是 `auto-edit` 默认,`--unsafe` 显式 yolo";同时 `auto-edit` 模式下的 shell 调用怎么处理——companion 要在 stream-json 看到 tool_use.name === "run_shell_command" + permission 请求事件时,**直接拒绝并标 job failed + kind=require_interactive**。让用户看到明确的"qwen 想跑 shell,foreground rescue 不自动批准,请加 `--unsafe`"。

这个修正让 rescue 的语义统一,safety 姿态一致,实现也干净。

### 没采纳 / 漏改

**A-3. Claude 第一轮 P1 "§4.3 proxy_mismatch warnings" 已采纳但命名漂移(P2)**

第一轮建议:`warnings.push({ kind: "proxy_mismatch", ... })`
v2 §4.3:`warnings.push({ kind: "proxy_conflict", ... })`

命名改了没问题,但 §5.2 错误表里同时出现 `proxy_conflict` 和 `proxy_required`,触发条件几乎一样(Codex 那轮提的),现在两个 kind 都保留了,文档读起来混。建议合并成一个 `proxy_conflict`,`proxy_required` 去掉(或者反过来)。

---

## v2 新引入的问题

### B-1. §4.2 `child.unref()` 和 foreground 模式冲突(P0)

```js
child.unref();  // 允许 companion 先退(background 模式)
```

这行代码无条件执行,但 foreground 模式下 companion **必须等子进程结束**才能把 stdout 透传给 Claude。`unref()` 后 Node event loop 不会因为子进程存活而继续跑,companion 主进程可能提前退出,foreground stdout 截断。

**修**:`if (background) child.unref()`,或用显式 Promise 等待。

### B-2. §5.1 `classifyApiError` 的正则兜底不稳(P1)

```js
if (/401|unauthorized|invalid.*token/i.test(msg)) return { ..., kind: "not_authenticated" };
```

`/401/` 这种纯数字匹配会误伤——qwen 返回 `[API Error: Server responded with status 40101]` 会被当成 401 unauthorized。类似地 `/5\d\d/` 会匹配到消息里的任意三位数(如 timeout 值 `503ms`)。

**修**:正则加边界 anchor,比如 `/\b401\b|\bunauthorized\b|invalid.*access.?token/i`;`/\bstatus\s*5\d\d\b|\b5\d\d\s*(?:error|server)/i`。Phase 0 探针抓真实错误串做回归。

### B-3. §4.4 "边解析边判错" + stdout 透传的顺序(P1)

foreground 模式下,assistant text 正在**透传到 Claude stdout**,命中 `[API Error:` 后要 SIGTERM 子进程。但这条错误 text 已经打到 stdout 了,Claude 看到半截正文 + 错误 + 终止。

要么:
- foreground 不要"边解析边判错",等 result 再判;
- 要么:命中后 stdout 补一行 `[companion: API error detected, aborting qwen subprocess]` 让用户看到终止原因。

**修**:§4.4 区分 foreground / background 行为,foreground 读 result 再判,background 才边解析边 SIGTERM。

### B-4. §5.3 retry "不重贴 diff,改贴 diff 的 SHA + 摘要"(P1)

问题:qwen 光看 SHA + 摘要没法 review,它需要看到 diff。

**修**:retry 不重贴 diff 是为了省 token,但不能让 qwen 饿死。正确做法:**第一次的 diff 仍然贴,但是 system prompt 位置只保留 schema 要求;retry 时用 `-c` 续上次 session**(前提 chatRecording=true),qwen 能看到上次的 diff,只收新 prompt。条件不满足时 fallback 到"重贴 diff + 截断 schema 文本"。

### B-5. §6.5 T5 通过判据模糊(P2)

> 500ms 内 polling 到 job 为 `running`

没说 polling 频率和容忍次数。建议改:"**每 100ms polling 一次**,5 次内看到 running"(允许 500ms 内的初始化 race)。

### B-6. §7 Phase 2 工时 2.5 天可能仍乐观(P1)

Phase 2 要做:
- 3 个 skill + 1 agent + rescue.md 命令
- `task` 子命令 foreground + background + `--unsafe` + `--resume-last`
- `spawn detached + pgid + unref`(B-1 修完)
- `detectFailure` 五层 + `classifyApiError` 7 子类 + 正则边界加固(B-2)
- 边解析边判错(按 B-3 区分 fg/bg)
- `job-control.mjs` 17.4K 复制 + 常量剥离(scan 所有 `GEMINI` 字面量)
- 单元测试 5 个文件

2.5 天按熟练度算偏紧。建议提到 3 天,总 9.5 天(+ spike = 10.5 天上限)。

### B-7. §9-11 "spike buffer 触发条件"不明(P2)

> 若 2 次 retry 在真实 diff 上 schema_violation 高于 10%

**10% 怎么测?**Phase 3 只有 2.5 天,没时间跑 100 个 review 测命中率。要么改成定性:"若 Phase 3 做完前 3 个 review 都命中 schema_violation,立刻触发 spike";要么删掉 10% 的量化约束。

### B-8. §4.6 job.json 新增 `approvalMode/unsafeFlag/warnings/pgid` 字段(P2)

gemini 版 `job-control.mjs` 读 job.json 时有固定 schema 假设,塞新字段可能被旧 reader 忽略(正常)或崩(若有 `strict` 校验)。建议 Phase 2 复制后第一件事是:grep `jobs/` / `job.json` 相关 reader,确认新字段不会挂掉现有路径。

### B-9. §6.5 T16 Bash 参数转义通过判据(P2)

> prompt 含 shell 特殊字符 `$(whoami)` `'` `"` `&`
> 字符原样透传给 qwen,不被 shell 展开

可操作性不够:**测什么样才能证明没被 shell 展开?**建议判据:`qwen -p "$(whoami) should not be evaluated"` → qwen 的 stream-json init 事件里 prompt 字段原样含 `$(whoami)` 字符串。

---

## 优先级总览

| P | 条目 | 影响 |
|---|---|---|
| **P0** | A-1 retry 次数 off-by-one | 实现歧义 |
| **P0** | A-2 foreground `auto-edit` 会死锁 | rescue 核心姿态坏 |
| **P0** | B-1 `child.unref()` 漏分 fg/bg 判断 | foreground stdout 截断 |
| **P1** | B-2 classifyApiError 正则边界 | 误分类 |
| **P1** | B-3 边解析边判错 + foreground stdout 顺序 | UX 半截输出 |
| **P1** | B-4 retry 不贴 diff 的实际可行性 | retry 会饿死 |
| **P1** | B-6 Phase 2 工时 2.5 天仍乐观 | 进度压不住 |
| **P2** | A-3 proxy_conflict / proxy_required 合并 | 文档一致性 |
| **P2** | B-5 / B-7 / B-8 / B-9 定义更明确 | 细节 |

---

## 结论

v2 落地 v1 的三方反馈基本成功,**但 A-2(foreground auto-edit 死锁)和 B-1(unref 无条件)是新的 P0 漏洞**——这两个都是"把建议复制进来,但没考虑和既有逻辑的互动"。建议 v3 聚焦修这三个 P0 + 几个 P1,不再大改。

Phase 2 工时也要再加半天(2.5 → 3),因为 v2 的新 detailing(边解析边判错 fg/bg 区分、classifyApiError 正则加固、job.json schema 迁移)都要落地。

等 Codex 和 Gemini 回来看有没有独立看法再合并 v3。
