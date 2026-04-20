---
description: Run a Qwen code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Qwen review through the shared built-in reviewer.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Qwen's output verbatim to the user.

## Execution mode rules

- If arguments include `--wait`, run foreground.
- If arguments include `--background`, run Claude background task.
- Otherwise estimate review size:
  - Working-tree: `git status --short --untracked-files=all`
  - Working-tree: `git diff --shortstat --cached` + `git diff --shortstat`
  - Branch: `git diff --shortstat <base>...HEAD`
  - Recommend `Wait` only when tiny (1-2 files).
  - Otherwise recommend `Run in background`.
- Use `AskUserQuestion` exactly once with two options:
  - `Wait for results`
  - `Run in background`
  Put recommended first with `(Recommended)` suffix.

## Argument handling

- Preserve user's arguments exactly.
- Do not strip `--wait` or `--background`.
- `/qwen:review` is native-review only.
- For custom instructions or adversarial framing, use `/qwen:adversarial-review`.

## Foreground flow

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" review "$ARGUMENTS"
```

Return the stdout verbatim. Do not paraphrase, summarize, or add commentary.
**Do not fix any issues mentioned.**

## Background flow

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" review "$ARGUMENTS"`,
  description: "Qwen review",
  run_in_background: true,
})
```

Tell user: "Qwen review started in background. Check `/qwen:status` for progress."

## Error handling

- If companion returns `schema_violation`, show the attempts_summary as-is. Advise: "Qwen did not produce valid JSON after 3 attempts. Try `--scope working-tree` with smaller diff, or retry."
- If `reason: "no_diff"`, tell user: "No changes to review in this scope. Try `--scope branch` or commit some changes first."
