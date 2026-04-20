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

**Note on background jobs**: bg jobs are lazily finalized. A bg job's stream-json is written
to a log file during execution; `/qwen:status` (and `/qwen:result`) triggers the log parse
+ state update when the child pid is no longer alive. If you never call status/result, the
bg job record will stay at `status: running` in state, but the log file on disk has the
full output.
