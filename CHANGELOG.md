# Changelog

Cross-AI collaboration log. Reverse chronological. Flat format.

## 2026-04-20

- **spec-v2** (Claude Opus 4.7) — v1 吸收三方 review(Claude/Codex/Gemini)P0+P1+P2 全部意见,产出 v2。主要架构变更:默认 approval-mode 从 yolo 改 auto-edit(加 `--unsafe` 显式开关);spawn 强制 detached+pgid;proxy env 四大小写探测 + 冲突时不注入;判错从四层扩到五层 + api_error 拆 6 子 kind;review retry 从 1 次改 2 次;工时 7 天 → 9 天 + 1 天 spike buffer。三方 review 全文存档 `docs/superpowers/specs/2026-04-20-qwen-plugin-cc-review-*.md`。 _status: review-pending(bing 确认)_
- **3-way-review** (Claude Opus 4.7 + Codex + Gemini) — 三方独立评审 v1 spec,产出 `review-claude.md` + `review-merged.md`。Codex 评审由 codex-rescue subagent 执行(`a50d9e1`),Gemini 评审由 gemini-agent subagent 执行(`a1171b7f`)。 _status: done_
- **spec-v1** (Claude Opus 4.7) — 写完 `docs/superpowers/specs/2026-04-20-qwen-plugin-cc-design.md` v1(commit `0bee623`)。 _status: superseded by v2_
- **research** (Claude Opus 4.7) — 产出 `docs/superpowers/specs/2026-04-20-qwen-plugin-cc-research.md`,完成 codex 模板骨架研究、三件套对齐样本对比、Qwen Code CLI 能力探针。 _status: done_
- **init** (Claude Opus 4.7) — `git init -b main`,目录就位。 _status: done_
