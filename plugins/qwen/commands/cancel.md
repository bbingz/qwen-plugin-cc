---
description: Cancel an active background Qwen job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" cancel "$ARGUMENTS"`

Present the result to the user. If the output contains `kind: cancel_failed`, advise:
- "Qwen cancel failed with <error>. Run `ps -p <pgid>` to check; if process is alive, `kill -9 <pgid>` manually."
