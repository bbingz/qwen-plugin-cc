# qwen-plugin-cc

Use Qwen Code CLI from Claude Code to review code, delegate tasks, and debug.

**Status**: v0.1.1 released — 7 slash commands, 97 unit + 3 integ tests, 4-way reviewed (Claude + Codex + Gemini + Qwen). See [CHANGELOG.md](./CHANGELOG.md).

## Install

### From GitHub (recommended)

```bash
claude plugins marketplace add https://github.com/bbingz/qwen-plugin-cc
claude plugins install qwen@qwen-plugin
```

Restart Claude Code, then run `/qwen:setup` to verify.

### From local clone (for development)

```bash
git clone https://github.com/bbingz/qwen-plugin-cc.git
claude plugins marketplace add /path/to/qwen-plugin-cc
claude plugins install qwen@qwen-plugin
```

### Update

```bash
claude plugins marketplace update qwen-plugin
claude plugins update qwen@qwen-plugin
```

### Uninstall

```bash
claude plugins uninstall qwen@qwen-plugin
claude plugins marketplace remove qwen-plugin
```

Job logs live under `$CLAUDE_PLUGIN_DATA/state/<workspace-slug>/jobs/` (Claude Code sets this; fallback `$TMPDIR/qwen-companion/`). Safe to delete manually if stale.

## Prerequisites

- [qwen-code](https://github.com/QwenLM/qwen-code) CLI v0.14.5+
- Authenticated:`qwen auth coding-plan` (Alibaba Cloud) or `--auth-type openai` with API key
- Recommended:`chatRecording: true` in `~/.qwen/settings.json`(for `--resume` to work)

## Commands(v0.1 scope)

| Command | Status | Purpose |
|---|---|---|
| [`/qwen:setup`](plugins/qwen/commands/setup.md) | ✅ Phase 1 | Verify installation + auth + proxy + hooks |
| [`/qwen:rescue`](plugins/qwen/commands/rescue.md) | ✅ Phase 2 | Delegate a task to Qwen(`--background --unsafe` for yolo bg) |
| [`/qwen:review`](plugins/qwen/commands/review.md) | ✅ Phase 3 | Code review against git diff |
| [`/qwen:adversarial-review`](plugins/qwen/commands/adversarial-review.md) | ✅ Phase 3 | Design-level challenge review |
| [`/qwen:status`](plugins/qwen/commands/status.md) | ✅ Phase 4 | List / inspect jobs, detect orphans |
| [`/qwen:result`](plugins/qwen/commands/result.md) | ✅ Phase 4 | Show stored output with permissionDenials highlight |
| [`/qwen:cancel`](plugins/qwen/commands/cancel.md) | ✅ Phase 4 | Cancel running job |

## Background rescue requires `--unsafe` for write/shell tools

Qwen's `auto-edit` default (Phase 0 F-4 verified) auto-denies shell/write tools when no TTY. For background rescue where you want qwen to actually write files or run shell, add `--unsafe`:

```
/qwen:rescue --background --unsafe "find all N+1 queries and fix the worst one"
```

Without `--unsafe`, the task will still run but `permissionDenials[]` will be non-empty in `/qwen:result`.

## Architecture

The plugin follows the openai-codex plugin template skeleton:

- **`plugins/qwen/`** — plugin manifest (`marketplace.json`, `plugin.json`), commands, hooks, prompts, schemas
- **`plugins/qwen/scripts/`** — Node.js companion runtime
  - `scripts/lib/{args,process}.mjs` — byte-copied from gemini v0.5.2 (CLI arg parsing, process helpers)
  - `scripts/lib/{git,state,render,prompts,job-control}.mjs` — gemini v0.5.2 bloodline, constants stripped (GEMINI→QWEN), 6-class dependency rewrite (see F-16)
  - `scripts/lib/qwen.mjs` — written from scratch; 18 exported functions including `classifyApiError`, `detectFailure` (5-layer), `parseStreamEvents`, `buildQwenArgs`, `spawnQwenProcess`, `streamQwenOutput`, `cancelJobPgid`, `tryLocalRepair`, `reviewWithRetry`
  - `scripts/qwen-companion.mjs` — CLI dispatcher for all subcommands

16 real-world behavioral differences from gemini: see [`doc/probe/FINDINGS.md`](doc/probe/FINDINGS.md).

## Testing

```bash
node --test plugins/qwen/scripts/tests/*.test.mjs
# 84+ unit tests + 3 integration tests + real-machine smoke
```

Note: use glob pattern `*.test.mjs`, not directory path (node --test has issues with directory scanning).

## Contributing / Development

Before contributing, read these docs in order:

1. **Design spec v3.1**: `docs/superpowers/specs/2026-04-20-qwen-plugin-cc-design.md`
2. **16 real-world findings**: `doc/probe/FINDINGS.md`
3. **Lessons learned**: [`lessons.md`](./lessons.md) (10 key findings + startup checklist for next agent-plugin-cc)
4. **Phase-by-phase evolution**: [`plugins/qwen/CHANGELOG.md`](./plugins/qwen/CHANGELOG.md)

## Design docs

- Research:`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-research.md`
- Design(v3.1):`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-design.md`
- Plan:`docs/superpowers/plans/2026-04-20-qwen-plugin-cc-implementation.md`
- Phase 0 探针 + 16 条实测发现:`doc/probe/FINDINGS.md`
- Phase-by-phase 进度:[CHANGELOG.md](./CHANGELOG.md) + [plugins/qwen/CHANGELOG.md](./plugins/qwen/CHANGELOG.md)

## License

MIT
