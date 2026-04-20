---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Qwen rescue subagent
argument-hint: '[--background|--wait] [--unsafe] [--resume|--fresh] [--model <model>] [what Qwen should investigate, solve, or continue]'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `qwen:qwen-rescue` subagent via `Agent` tool (`subagent_type: "qwen:qwen-rescue"`), forwarding the raw user request as the prompt.
`qwen:qwen-rescue` is a subagent, not a skill. Do not call `Skill(qwen:qwen-rescue)`.

The final user-visible response must be Qwen's output verbatim.

Raw user request:
$ARGUMENTS

## Execution mode

- `--background` → run in background.
  - Default `--approval-mode auto-edit`: qwen auto-deny shell/write tools (v3.1 F-4);仍能跑,但不会实际执行 shell/edit。
  - **要 qwen 真实操作 shell/write 时加 `--unsafe`**:切 yolo 模式。
- `--wait` → foreground.
- Neither → default foreground.
- `--background` and `--wait` are Claude-side execution controls; do NOT forward to `task` text.
- `--model`, `--effort`, `--unsafe` are runtime flags; preserve them for forwarded `task` call.
- `--resume` → don't ask; user chose to continue.
- `--fresh` → don't ask; user chose new.
- Otherwise check resumable thread:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" task-resume-candidate --json
```

- If `available: true`, ask with AskUserQuestion:
  - `Continue current Qwen thread`
  - `Start a new Qwen thread`
- If user continues → add `--resume`. If new → add `--fresh`.
- If `available: false`, don't ask.

## Operating rules

- Subagent is a thin forwarder only. One Bash call → `node qwen-companion.mjs task ...`.
- Return companion stdout verbatim.
- Don't paraphrase, summarize, or add commentary before/after.
- Don't inspect files, monitor progress, poll `/qwen:status`, fetch `/qwen:result`, call `/qwen:cancel`, summarize output, or follow-up work.
- Leave `--effort` unset unless explicit.
- Leave model unset unless explicit.
- Leave `--resume`/`--fresh` in forwarded request; subagent handles routing.
- If companion reports missing or unauthenticated Qwen, stop and tell user `/qwen:setup`.
- If user did not supply a request, ask what Qwen should investigate or fix.

## Self-help hints

- **`require_interactive`** error → 说明你传了 `--background` + `--approval-mode yolo` 但没 `--unsafe`。加 `--unsafe` 或去掉显式 yolo(改用默认 auto-edit)。
- **`permissionDenials` 非空** in the result → qwen 被 auto-deny 了 shell/write;加 `--unsafe` 让 qwen 实际执行。
- Example:

```
/qwen:rescue --background --unsafe "find all N+1 queries in this repo and fix the worst one"
```
