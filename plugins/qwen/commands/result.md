---
description: Show the stored final output for a finished Qwen job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense.

Preserve all details:
- Job ID and status
- Complete result payload (verdict, summary, findings, details, artifacts, next steps)
- File paths and line numbers exactly as reported
- `permissionDenials` section if present (v3.1 F-4): If you see this block, advise the user "Re-run with --unsafe to let Qwen actually execute"
- Failure section if present
- Follow-up commands such as `/qwen:status <id>` and `/qwen:review`
