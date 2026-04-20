---
description: Run a Qwen review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--unsafe] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Qwen review through the shared plugin runtime.
Position as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Return Qwen's output verbatim.
- Keep framing focused on: is this the right approach? What assumptions does it depend on? Where could the design fail under real-world conditions?

## Execution mode rules

Same as `/qwen:review`:
- `--wait` → foreground.
- `--background` → background.
- Otherwise AskUserQuestion with size-aware recommendation.

## Argument handling

- Preserve user's arguments exactly.
- Do not weaken the adversarial framing.
- Supports working-tree / branch / `--base <ref>`.
- Can take extra focus text after flags.

## Foreground

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" adversarial-review "$ARGUMENTS"
```

## Background

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "Qwen adversarial review",
  run_in_background: true,
})
```
