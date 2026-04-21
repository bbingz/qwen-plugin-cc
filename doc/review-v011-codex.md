# qwen-plugin-cc v0.1.1 Independent Review — Codex

**Scope reviewed**: `55c7345` on `main` (`v0.1.1` tag `143b92d`, hotfix commit `90613ab`)

**Required context read first**:
- `doc/probe/FINDINGS.md`
- `docs/superpowers/specs/2026-04-20-qwen-plugin-cc-design.md`
- `CLAUDE.md`
- `~/.claude/projects/-Users-bing--Code--qwen-plugin-cc/memory/pending-after-compact.md`

**Exclusions applied**:
- Did not re-report bugs already fixed in `86ce8d1`, `a6fdb7f`, or `90613ab`
- Did not re-report items already deferred into the v0.2 backlog

## Summary

| Severity | Count |
|---|---:|
| P0 | 1 |
| P1 | 4 |
| P2 | 1 |
| Nit | 0 |

---

### [P0] State lock fallback can lose updates and delete fresh job artifacts

**File**: `plugins/qwen/scripts/lib/state.mjs:93-148`, `plugins/qwen/scripts/lib/state.mjs:158-170`

**Problem**: `updateState()` retries the lock only 10 times, then falls back to an unlocked read-modify-write path at lines 144-148. `saveState()` also writes `state.json` in place, and calls `cleanupOrphanedFiles()` before the write. Under legitimate contention, a second writer can therefore proceed while the first writer still holds the lock, load a stale `jobs[]` snapshot, and then overwrite newer state. Worse, because `cleanupOrphanedFiles()` derives liveness only from the stale in-memory `jobs[]`, it can delete a just-written `jobs/<id>.json` or `jobs/<id>.log` file from another process. This is real state/data loss, not just stale status.

**Repro**:
1. Process A acquires `state.json.lock` and stalls for more than ~2.75s inside `mutate()` or while doing sync I/O before `saveState()`.
2. Process B calls `upsertJob()` or `setConfig()`, exhausts the 10 retries, then executes the unlocked fallback path.
3. Process B loads the old state, saves it back, and runs `cleanupOrphanedFiles()` against the stale job set.
4. Any job file created by a concurrent finalizer path (`writeJobFile()` in `qwen-companion.mjs` or `job-lifecycle.mjs`) but not yet reflected in B's stale `jobs[]` can be removed as an "orphan".

**Fix**:
- Do not write without the lock after retry exhaustion; return an explicit lock-timeout error instead.
- Make `saveState()` atomic via temp-file + `renameSync()`.
- Keep `cleanupOrphanedFiles()` out of unlocked/stale snapshots, or only run it after a successful locked write with a fresh state reload.

---

### [P1] Claude session ownership is never persisted, so both hooks miss the jobs they are supposed to manage

**File**: `plugins/qwen/scripts/qwen-companion.mjs:212-219`, `plugins/qwen/scripts/qwen-companion.mjs:264-268`, `plugins/qwen/scripts/session-lifecycle-hook.mjs:57-95`, `plugins/qwen/scripts/stop-review-gate-hook.mjs:49-55`, `plugins/qwen/scripts/stop-review-gate-hook.mjs:157-170`

**Problem**: The hook layer uses `QWEN_COMPANION_SESSION_ID` as the current **Claude** session identifier, but task records never store that value. `runTask()` writes `jobMeta` without any Claude-session field, and later writes `sessionId` from Qwen's stream-json `event.session_id` instead. Both hooks then filter `job.sessionId === <Claude session id>`. Those namespaces are different, so the filter misses the current session's jobs:
- `SessionEnd` cleanup does not find or terminate its own running background tasks.
- `Stop` gate does not warn about a running Qwen task from the current Claude session.

`plugins/qwen/scripts/lib/qwen.mjs:16` even defines `PARENT_SESSION_ENV = "QWEN_COMPANION_SESSION_ID"`, but the companion never uses it to write a job field.

**Repro**:
1. Start a Claude session; `SessionStart` exports `QWEN_COMPANION_SESSION_ID=<claude-session-uuid>`.
2. Run `/qwen:rescue --background "..."`.
3. The new job record contains no Claude session field; once finalized, `sessionId` becomes the Qwen session UUID/job UUID instead.
4. End the Claude session or trigger the stop hook. Both hooks filter by the Claude session UUID and fail to match the job they launched.

**Fix**:
- Persist a dedicated field such as `claudeSessionId` from `process.env[SESSION_ID_ENV]` at job creation time.
- Keep Qwen's own session under a separate field (`qwenSessionId` or current `sessionId`).
- Update both hooks to filter on `claudeSessionId`, not the Qwen session ID.

---

### [P1] Stop-review gate calls `task --json`, but `task` never emits the JSON shape the hook expects

**File**: `plugins/qwen/scripts/stop-review-gate-hook.mjs:107-142`, `plugins/qwen/scripts/qwen-companion.mjs:163-279`

**Problem**: `runStopReview()` launches `node qwen-companion.mjs task --json <prompt>` and then parses `result.stdout` as JSON, expecting `payload.rawOutput`. But `runTask()` only parses the `json` flag; it never changes behavior for it. In foreground mode it streams assistant text directly to stdout via `onAssistantText`, writes no JSON envelope, and exits with `0` or `3`. The stop-review prompt itself explicitly asks for a plain-text first line of `ALLOW:` or `BLOCK:`. So a successful stop review will still reach the hook's `JSON.parse(result.stdout)` and be treated as "invalid JSON", causing a false block/fail-closed path.

**Repro**:
1. Enable `stopReviewGate`.
2. End a session where Qwen is installed/authenticated.
3. The hook runs `qwen-companion.mjs task --json ...`.
4. Qwen returns plain `ALLOW: ...` or `BLOCK: ...`.
5. `JSON.parse(result.stdout)` throws and the hook returns `decision: "block"` with the invalid-JSON error text.

**Fix**:
- Either make `task --json` return a machine-readable envelope such as `{ rawOutput, sessionId, exitCode }`, or
- stop using `task` here and call a dedicated subcommand whose contract is already structured for hook consumption.

---

### [P1] `--resume-last` is dead because `runTask()` always injects a fresh `--session-id`

**File**: `plugins/qwen/scripts/qwen-companion.mjs:175-193`, `plugins/qwen/scripts/lib/qwen.mjs:399-402`

**Problem**: `runTask()` computes `resumeLast`, but then always passes `sessionId: options["session-id"] || jobId`. `buildQwenArgs()` gives `sessionId` higher priority than `resumeLast`, so `-c` is never emitted. As a result, `/qwen:rescue --resume` does not continue the last thread; it starts a new session with a newly generated UUID.

This is not just a doc mismatch: the rescue command and agent both route `--resume` into `--resume-last`, so the user-visible "continue current Qwen thread" path is currently non-functional.

**Repro**:
1. Create a prior rescue thread.
2. Invoke `/qwen:rescue --resume "continue"`.
3. The agent forwards `--resume-last`.
4. `runTask()` still sets `sessionId = jobId`.
5. `buildQwenArgs()` emits `--session-id <new-uuid>` instead of `-c`, so Qwen starts a fresh thread.

**Fix**:
- Only supply `sessionId` when the user explicitly passed `--session-id`.
- When `resumeLast` is true, leave `sessionId` unset so `buildQwenArgs()` can emit `-c`.

---

### [P1] Background spawn failures become immortal `running` jobs with no PID and no recovery path

**File**: `plugins/qwen/scripts/lib/qwen.mjs:425-442`, `plugins/qwen/scripts/qwen-companion.mjs:223-248`, `plugins/qwen/scripts/lib/job-lifecycle.mjs:15-18`

**Problem**: `spawnQwenProcess()` returns the `ChildProcess` immediately and does not surface spawn failure synchronously. For `ENOENT` or `EACCES`, Node returns a child whose `pid` is unset and then emits an `error` event asynchronously. In background mode, `runTask()` immediately records `status: "running"`, copies `child.pid` and `child.pgid`, prints `Job queued`, and exits `0` without attaching any `error` listener. That leaves a persisted job with no real process behind it. `refreshJobLiveness()` then returns early on `!job.pid`, so `status`, `result`, and `cancel` cannot ever finalize or clean it up.

Verified: `spawn("/definitely/missing/bin")` yields `pid === undefined` before the later `ENOENT` error event fires.

**Repro**:
1. Set `QWEN_CLI_BIN` to a missing or non-executable path.
2. Run `node plugins/qwen/scripts/qwen-companion.mjs task --background "hi"`.
3. The companion stores a `running` job and exits `0`.
4. The job has no usable PID/PGID; `refreshJobLiveness()` returns it unchanged forever and `cancel` reports `no pgid recorded`.

**Fix**:
- In background mode, attach a `child.once("error", ...)` handler before persisting state.
- If `child.pid` is falsy after spawn, immediately mark the job failed and include the spawn error detail instead of queuing it.
- Optionally preflight the binary with `getQwenAvailability()` before background submission.

---

### [P2] `render.mjs` is stale dead code and cannot even be imported

**File**: `plugins/qwen/scripts/lib/render.mjs:1-2`

**Problem**: `render.mjs` imports `./timing.mjs`, but that module does not exist in this plugin. Importing the file currently throws `ERR_MODULE_NOT_FOUND` immediately. The remainder of the module is also still Gemini-specific (`/gemini:*`, `job.id`, `geminiSessionId`, "Gemini CLI Status"), so even if the missing import were fixed, the renderers do not match the current Qwen job schema.

**Repro**:
1. Run `node -e 'import("./plugins/qwen/scripts/lib/render.mjs")'` from the repo root.
2. Node fails with `ERR_MODULE_NOT_FOUND: Cannot find module .../timing.mjs`.

**Fix**:
- Delete the file if it is intentionally unused, or
- fully port it to the Qwen schema and add an import test so dead render helpers cannot rot unnoticed.

---

*Review completed 2026-04-21. Codex reviewer; independent of Claude/Gemini/Qwen review threads.*
