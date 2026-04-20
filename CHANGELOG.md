# Changelog

Cross-AI collaboration log. Reverse chronological. Flat format.

## 2026-04-20

- **spec-v3** (Claude Opus 4.7) — v2 吸收第二轮三方 review(Claude/Codex/Gemini)P0+P1+P2 全部意见,产出 v3。核心架构变更:§5.3 retry 方向重写(携带原 raw + schema + ajv 错误,不新开 session 丢 diff;先尝试本地 JSON repair);§4.2 `child.unref()` 分支化(仅 background);§4.3 proxy env 内部不一致单独报 `proxy_env_mismatch`;§5.1 `classifyApiError` 状态码优先 + DashScope 特化(108/sensitive);§4.4 fg/bg 解析分野 + SIGTERM 等 exit 防 orphan;§5.5 加 `cancel_failed` kind;Phase 0 新探针 case 11(`auto-edit` 无 TTY 行为);工时 9 → 11 天。第二轮 review 全文存档 `review-claude-v2.md` + `review-merged-v2.md`。 _status: review-pending(bing 确认)_
- **3-way-review-round-2** (Claude Opus 4.7 + Codex + Gemini) — v2 再走三方独立评审,三家各自挖到 v2 新引入的问题。Codex 发现 retry 方向性错误(P0)、proxy env 内部不一致静默漏报(P1)、classifyApiError 不解析状态码(P1)、cancel 非 ESRCH 错状态悬空(P1)。Gemini 发现 SIGTERM 后不等 500ms 导致 job.json rename 未完成(P1 实战)、DashScope 108/sensitive 错误漏分类(P1)、job-control 依赖解耦必做(P1)、Phase 3 工时必须加到 4 天(P1 实测 4.5 天)。Claude 发现 foreground `auto-edit` 对非 edit 工具行为未验证(P0)、`child.unref()` 无条件截断 fg stdout(P0)、边解析边判错 + fg stdout 顺序冲突(P1)。 _status: done_
- **spec-v2** (Claude Opus 4.7) — v1 吸收三方 review(Claude/Codex/Gemini)P0+P1+P2 全部意见,产出 v2。主要架构变更:默认 approval-mode 从 yolo 改 auto-edit(加 `--unsafe` 显式开关);spawn 强制 detached+pgid;proxy env 四大小写探测 + 冲突时不注入;判错从四层扩到五层 + api_error 拆 6 子 kind;review retry 从 1 次改 2 次;工时 7 天 → 9 天 + 1 天 spike buffer。三方 review 全文存档 `docs/superpowers/specs/2026-04-20-qwen-plugin-cc-review-*.md`。 _status: review-pending(bing 确认)_
- **3-way-review** (Claude Opus 4.7 + Codex + Gemini) — 三方独立评审 v1 spec,产出 `review-claude.md` + `review-merged.md`。Codex 评审由 codex-rescue subagent 执行(`a50d9e1`),Gemini 评审由 gemini-agent subagent 执行(`a1171b7f`)。 _status: done_
- **spec-v1** (Claude Opus 4.7) — 写完 `docs/superpowers/specs/2026-04-20-qwen-plugin-cc-design.md` v1(commit `0bee623`)。 _status: superseded by v2_
- **research** (Claude Opus 4.7) — 产出 `docs/superpowers/specs/2026-04-20-qwen-plugin-cc-research.md`,完成 codex 模板骨架研究、三件套对齐样本对比、Qwen Code CLI 能力探针。 _status: done_
- **init** (Claude Opus 4.7) — `git init -b main`,目录就位。 _status: done_
