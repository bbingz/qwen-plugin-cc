# v0.3 progress

## 2026-04-21

- Started v0.3 handoff implementation in `/Users/bing/-Code-/qwen-plugin-cc`.
- Scanned project docs, runtime, commands, probe findings, tests, and v0.3 handoff/alignment plans before edits.
- Added Phase 0 probe script scaffold: `doc/probe/case-14-result-event.sh`.
- Ran `doc/probe/case-14-result-event.sh`; qwen `result` event exposes `usage.*` only, no `stats` / `stats.models`.
- Recorded F-18 and locked Phase 2 direction to timing dead-code removal.
- Added `/qwen:ask` as a thin foreground command and covered it with `plugins/qwen/scripts/tests/smoke.test.mjs`.
- Removed unused timing history helpers from `plugins/qwen/scripts/lib/state.mjs`; `plugins/` no longer has live timing callers.
- Synced README / design spec / alignment plan / lessons / changelogs to the F-18 outcome and 8-command surface.
- Verification:
  - `node --test plugins/qwen/scripts/tests/smoke.test.mjs` → pass
  - `node --test plugins/qwen/scripts/tests/state.test.mjs` → pass
  - `node --test plugins/qwen/scripts/tests/*.test.mjs` → 226 pass, 0 fail
