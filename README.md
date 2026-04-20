# qwen-plugin-cc

Use Qwen Code CLI from Claude Code to review code, delegate tasks, and debug.

**Status**: in development(Phase 2 complete, Phase 3 pending)— see [CHANGELOG.md](./CHANGELOG.md).

## Install(after v0.1 released)

```bash
claude plugins add /path/to/qwen-plugin-cc/plugins/qwen
```

## Prerequisites

- [qwen-code](https://github.com/QwenLM/qwen-code) CLI v0.14.5+
- Authenticated:`qwen auth coding-plan` (Alibaba Cloud) or `--auth-type openai` with API key
- Recommended:`chatRecording: true` in `~/.qwen/settings.json`(for `--resume` to work)

## Commands(v0.1 scope)

| Command | Status | Purpose |
|---|---|---|
| `/qwen:setup` | ✅ Phase 1 | Verify installation + auth + proxy + hooks |
| `/qwen:rescue` | ✅ Phase 2 | Delegate a task to Qwen(`--background --unsafe` for yolo bg) |
| `/qwen:review` | 🔜 Phase 3 | Code review against git diff |
| `/qwen:adversarial-review` | 🔜 Phase 3 | Design-level challenge review |
| `/qwen:status` | 🔜 Phase 4 | List / inspect jobs |
| `/qwen:result` | 🔜 Phase 4 | Show stored output |
| `/qwen:cancel` | 🔜 Phase 4 | Cancel running job(companion `cancel` done;斜杠命令 Phase 4) |

## Background rescue requires `--unsafe` for write/shell tools

Qwen's `auto-edit` default (Phase 0 F-4 verified) auto-denies shell/write tools when no TTY. For background rescue where you want qwen to actually write files or run shell, add `--unsafe`:

```
/qwen:rescue --background --unsafe "find all N+1 queries and fix the worst one"
```

Without `--unsafe`, the task will still run but `permissionDenials[]` will be non-empty in `/qwen:result`.

## Design docs

- Research:`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-research.md`
- Design(v3.1):`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-design.md`
- Plan:`docs/superpowers/plans/2026-04-20-qwen-plugin-cc-implementation.md`
- Phase 0 探针 + 14 条实测发现:`doc/probe/FINDINGS.md`
- Phase-by-phase 进度:[CHANGELOG.md](./CHANGELOG.md) + [plugins/qwen/CHANGELOG.md](./plugins/qwen/CHANGELOG.md)

## License

MIT
