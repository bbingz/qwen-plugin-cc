---
description: Ask Qwen a one-shot question in the foreground
argument-hint: '[--model <model>] [what you want to ask Qwen]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

One-shot foreground ask to Qwen。轻量、前台阻塞、不 resume、不后台。

需要 resume 上次 / 后台跑 / 让 qwen 实际执行 shell/write 的场景请用 `/qwen:rescue`。

Raw user request:
`$ARGUMENTS`

## Argument rules

- Preserve `--model <model>` if provided.
- Do not support `--background`, `--wait`, `--unsafe`, `--resume-last`, `--fresh`, or `--effort` here.
- If those flags appear, stop and tell the user to use `/qwen:rescue`.
- If no prompt text remains after stripping supported flags, ask: `What do you want to ask Qwen?`

## Execution

单次 Bash,直接 stream qwen 输出给用户,不做任何加工:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" task "$ARGUMENTS"
```

## Operating rules

- 不调 `task-resume-candidate`,也不 ask user continue/fresh。`/qwen:ask` 永远是新对话。
- 不 poll status、不 fetch result、不 cancel。
- 返回 companion stdout 原样,不加前后注释。
- 如 companion 报缺 qwen / 未授权,提示 `/qwen:setup`。

## 与 `/qwen:rescue` 的分工

| 场景 | 用这个 |
|---|---|
| 问一句话、看眼输出 | `/qwen:ask` |
| 委派调研/修代码,可能 > 2 分钟 | `/qwen:rescue --background` |
| 要 qwen 真跑 shell/edit | `/qwen:rescue --unsafe` |
| 续上次 qwen 对话 | `/qwen:rescue --resume-last` |
