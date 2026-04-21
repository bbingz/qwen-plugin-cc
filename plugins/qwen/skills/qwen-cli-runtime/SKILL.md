---
name: qwen-cli-runtime
description: Internal helper contract for calling the qwen-companion runtime from Claude Code
user-invocable: false
---

# Qwen Runtime

Use this skill only inside the `qwen:qwen-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" task "<raw arguments>"`

## Execution rules

- The rescue subagent is a **forwarder**, not an orchestrator. Its only job is to invoke `task` once and return stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct `qwen` CLI strings, or other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `qwen:qwen-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.

## Default behavior

- `--model` left unset unless user explicitly specifies.
- `--approval-mode` default is `auto-edit`(v3.1 / Phase 0 case-11 实测:无 TTY 时 auto-deny shell tools,不 hang).
- `--unsafe` switches approval to `yolo`. **Required if you want qwen to run shell/write in background** (否则 qwen auto-deny,`permissionDenials` 非空)。
- `--effort` is a pass-through but the companion drops it (qwen has no equivalent).

## Command selection

- Use exactly one `task` invocation per rescue.
- If the forwarded request includes `--background` or `--wait`, strip it from the task text (it's an execution control).
- If the forwarded request includes `--model`, pass through.
- If the forwarded request includes `--resume-last`, pass it through to `task` as-is (companion CLI uses `--resume-last`, not `--resume`).
- If the forwarded request includes `--fresh`, strip it and do NOT add `--resume-last`.
- If the forwarded request includes `--unsafe`, pass through.

## Safety rules

- Default to `auto-edit` unless user explicitly asks `--unsafe`.
- Preserve user's task text as-is after stripping routing flags.
- Do not inspect repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work.
- Return stdout of `task` command exactly as-is.
- If Bash call fails or qwen cannot be invoked, return nothing.
