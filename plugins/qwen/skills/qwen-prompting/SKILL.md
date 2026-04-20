---
name: qwen-prompting
description: Internal guidance for composing Qwen Code prompts for coding, review, diagnosis, and research tasks inside the Qwen Claude Code plugin
user-invocable: false
---

# Qwen Prompting(qwen3.5-plus 为默认模型;qwen3.6 要 Pro 订阅)

Use this skill when `qwen:qwen-rescue` needs to ask Qwen for help.

Prompt Qwen like an operator. Compact, block-structured with XML tags. State the task, output contract, default behavior, and extra constraints.

## Core rules

- One clear task per Qwen run. Split unrelated asks into separate runs.
- Tell Qwen what "done" looks like. Don't assume it will infer.
- Prefer explicit output contracts over raising reasoning.
- Use XML tags consistently.

## Qwen 3.5/3.6 specifics

- **中英混写稳**:可以在 prompt 中中英混用,qwen3.5-plus 对中文 prompt 的处理稳定。
- **`--system-prompt` / `--append-system-prompt` 可塞 schema**:比塞在 user prompt 里更稳。
- **`mcp_servers` 空时不让它摸文件**:若 mcp 空数组,prompt 里明确说"只基于我给的 diff,不要读文件"。
- **`auto-edit` 对非 edit 工具是 auto-deny**(v3.1 F-4 实测):无 TTY 环境下 qwen 会生成 `permissionDenials`,不 hang;prompt 可明确"不要跑 shell 命令" 让它直接产出文本结果。

## Default prompt recipe

- `<task>`: 具体工作 + 相关仓库/失败上下文
- `<structured_output_contract>` or `<compact_output_contract>`: 精确形状/顺序/简洁要求
- `<default_follow_through_policy>`: qwen 默认做什么(而不是问用户)
- `<verification_loop>` or `<completeness_contract>`: debugging/implementation/risky fix 必须
- `<grounding_rules>` or `<citation_rules>`: review / research / 任何可能漂移到无支撑结论的任务

## When to add blocks

- Coding / debugging: `completeness_contract` + `verification_loop` + `missing_context_gating`
- Review / adversarial: `grounding_rules` + `structured_output_contract` + `dig_deeper_nudge`
- Research: `research_mode` + `citation_rules`
- Write-capable: `action_safety`(qwen 保持窄,不做无关重构)

## How to pick shape

- 用 built-in `review` / `adversarial-review` 命令:本身已有 contract。
- 用 `task`:diagnosis / planning / research / implementation,需要更细 prompt 控制。
- 用 `task --resume` 做跟进:只发 delta 指令,不重复整段 prompt,除非方向实质改变。

## Working rules

- 优先清晰合约,不是 vague nudge。
- 稳定 XML 标签名(对照 `references/prompt-blocks.md`)。
- 不要先堆 reasoning;先收紧 prompt 和 verification。
- 长任务才加 brief progress update 要求。
- 保证 claims 锚到观察证据;假设明说。

## Assembly checklist

1. `<task>` 明确 scope
2. 最小 output contract
3. 默认继续 vs 停问
4. 按需加 verification / grounding / safety
5. 删冗余指令再发

## References

- [prompt-blocks.md](references/prompt-blocks.md)
- [qwen-prompt-recipes.md](references/qwen-prompt-recipes.md)
- [qwen-prompt-antipatterns.md](references/qwen-prompt-antipatterns.md)
