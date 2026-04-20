---
description: Show active and recent Qwen jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table (it already is in markdown format).
- Keep it compact. No extra prose outside the table.

If the user did pass a job ID:
- Present the full JSON output to the user verbatim.
- Do not summarize or condense.
