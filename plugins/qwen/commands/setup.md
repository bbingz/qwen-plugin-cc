---
description: Check whether the local Qwen CLI is ready, authenticated, and has proxy aligned
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), Bash(brew:*), Bash(sh:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" setup --json "$ARGUMENTS"
```

Interpret the JSON result:

### Not installed (`installed: false`)

Check `installers.*`. Build AskUserQuestion option list **dynamically**, only including options whose installer is detected. Always include `Skip for now`.

Possible options:
- `Install via npm (Recommended, official)` → runs `npm install -g @qwen-code/qwen-code@latest`
- `Install via Homebrew` → runs `brew install qwen-code`
- `Install via shell script` → runs `curl -LsSf <official install URL> | bash`
- `Skip for now`

Edge case: if all three installers are false, do NOT use AskUserQuestion. Instead say: "No installer detected. Install one of: npm, brew, or curl. Then re-run `/qwen:setup`."

After successful install, re-run `setup`.

### Installed but not authenticated (`installed: true, authenticated: false`)

Do NOT run `qwen auth coding-plan` from a tool call — it's interactive. Tell the user verbatim: "Run `! qwen auth coding-plan` in your terminal to authenticate, then re-run `/qwen:setup`."

### Warnings

If `warnings` is non-empty, print each warning prominently:
- `proxy_env_mismatch`: user env has conflicting HTTP(S)_PROXY keys — advise alignment
- `proxy_conflict`: settings.proxy and env disagree — advise user to pick one

### Blocking qwen hooks

If `qwenHooksBlockingWarning` is true (Phase 2+ 会填),高亮警告:qwen 侧 PreToolUse hook 可能拦截 rescue yolo 模式。

### All good (`installed: true, authenticated: true`)

Print the full JSON so user sees `version`, `authMethod`, `model`, etc.

### Output rules

- Present JSON faithfully; do not paraphrase fields.
- Do not auto-suggest installs when already installed and authenticated.
- Do not fetch anything external beyond the companion output.
