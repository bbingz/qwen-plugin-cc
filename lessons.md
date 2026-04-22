# qwen-plugin-cc Lessons Learned

给下一个 agent-plugin-cc(按 bing 四件套系列,下一个可能是 doubao / tongyi / 其他)启动时的参考。本文档精简 FINDINGS.md 的 16 条到核心 10 条。

## Qwen CLI 独有发现(P0)

1. **`exit 0 + is_error:false` 不等于成功**
   qwen 把 `[API Error: NNN ...]` 塞进 assistant text 并返 `exit 0 + is_error:false`。**所有 detect failure 必须走五层**(exit / is_error / result prefix / assistant text / empty_output),不能只看 exit code。
   (F-2 + 五层设计)

2. **API Error 格式无 "Status:" 字样**
   qwen 真实格式:`[API Error: 401 invalid access token]`。`classifyApiError` 首选 `\[API Error:\s*(\d{3})\b`,`(Status: NNN)` 作其他 provider 兼容 fallback。
   (F-2)

3. **版本探测用 `--version` 不是 `-V`**
   `qwen -V` 返 `Unknown argument: V`。输出是**裸版本号** `0.14.5`(非 `qwen, version X`)。
   (F-1 + F-1b)

4. **`auto-edit` 无 TTY 是 auto-deny,不是 hang**
   Phase 0 case 11 实测:qwen `auto-edit` 遇 shell 工具 + stdin=/dev/null → exit 0 + is_error:false + `permission_denials[]` 非空。**不 hang**。所以 foreground rescue 默认 `auto-edit` 安全可用;只在用户希望实际执行 shell/write 时加 `--unsafe` 切 yolo。
   (F-4 + F-13 + case-11-decision.md)

5. **session-id / resume 强校验 UUID**
   `--session-id` / `-r` 接非 UUID 字符串会报 `Invalid --resume`。jobId 必须 `crypto.randomUUID()`,不能用 `job-NNNN` slug。
   (F-7)

## Spec / 实施 经验(P1)

6. **"字节复制"是误导**
   任何跨仓库源码都带隐式依赖(env 名、路径常量、本地 helper)。Phase 2 Day 1 **必做依赖解耦清单**(`docs/superpowers/plans/_phase2-dependencies.md` 模板);先审计后拷贝。
   (Gemini v2 review 强调;Phase 2 Task 2.1 证实)

7. **Retry 必须携原 raw,不要另开 session 丢 diff**
   第一版设计把 retry 写成"新开 session 不重贴 diff",qwen 看不到上次输出会臆造合法但失真的 JSON。正确做法:**同 session `-c` 续跑 + 携带上轮 raw + schema + ajv 错误 + 修复指令**。本地 JSON repair 优先试(fence / prose / bracket / 尾逗号),实在修不动才真 retry。
   (Codex v2 review P0;Phase 3 Task 3.6 实装证实 5/5 review 全绿)

8. **fg/bg 解析分野 + SIGTERM 等 exit**
   foreground:不即时判错(避免半截错误输出),读完 result 再让 detectFailure 判。
   background:命中 `[API Error:` 立即 SIGTERM,**等 child exit 或 500ms 超时再 resolve**(防 fs.renameSync 未完成变 orphan)。
   (Gemini v2 review 实战经验;Phase 2 Task 2.9 实装)

## 三方 review 流程经验(P2)

9. **每 spec 版本都要 3-way review,至少两轮**
   v1→review→v2→review→v3 是标准节奏。每轮用 Codex/Gemini subagent 并行 + Claude 自审,汇总 P0/P1/P2。v2 吸收反馈后新引入的 bug 比 v1 原始 bug 更隐蔽(Phase 3 前的第二轮发现了 retry 方向错这种关键问题)。

10. **subagent-driven:纯 cp/markdown task 跳过正式 review**
    Phase 1 Task 1.1 严格走 spec+quality reviewer,reviewer 提的 issue 都不成立(JSON 缩进、中英混合都是原 plan 规定)。之后节奏:**代码 + 测试 task 走完整 TDD + 可选 reviewer;纯 cp + 改字样 + markdown task 只 implementer + self-check**,快且不损质量。

11. **先 probe schema,再决定保留还是删除血统代码**
    gemini 血统里残留的 timing scaffolding 不能因为“看起来以后可能会用”就继续挂着。先跑真实 probe 看 `result` event schema;如果只有 `usage.*` 而没有 `stats` / `stats.models`,就删 dead code,不要维持半成品接口误导后续 agent。

---

## 给下个 agent-plugin-cc 的启动清单

按顺序跑完能少走 70% 弯路:

1. **Phase 0 探针 10+ case**:新 CLI 的 `--version` 响应 / 认证文件位置 / 错误格式 / 是否有 thinking-like 块 / auto-edit 无 TTY 行为 / session id 强制性 / proxy env 的读取顺序。Phase 0 0.5 天,省 Phase 2+ 两天 debugging。

2. **三方 review spec 至少两轮**:第二轮往往发现第一轮采纳的细节仍有偏差(本项目 Codex 第二轮发现 retry 方向错)。

3. **依赖解耦清单先写再拷**:gemini 血统的 `job-control.mjs` 17.4K 有 5 处字面量 + 2 个外部符号(`callGeminiStreaming` + 10 个 state 符号),sed 解决不了全部。Phase 2 Day 1 做 `_phaseN-dependencies.md` 模板。

4. **Hook 从 codex 拷时做好重写准备**(F-16):codex 独有的 app-server / broker-lifecycle / tracked-jobs / workspace / fs 在 gemini 血统里合并到 state + job-control,要替换或内联。预留 0.5 天。

5. **第一个真机 review 抽 5 次**:别等 Phase 4 才测 JSON 稳定性。Phase 3 完工前跑 5 次看 schema_violation 率,超 20% 立触发 prompt spike。本项目 qwen3.5-plus 0% 失败率,不触发。

6. **UI 手测必须用户亲自做**:Claude Code 插件 API 不能 Bash 调,`claude plugins add` / `/plugin:cmd` 要用户在真 UI 里跑。T-checklist 放 Phase 5 末尾汇总。

7. **Branch 策略**:每 phase 一个 feature branch,完成 merge 回 main。但单人项目可接受单一 long-lived branch(本项目 phase-1-setup 实际含了 Phase 1-5,55+ commits)。
