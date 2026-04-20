# qwen-plugin-cc v0.1.0 Independent Review — Focus: Race/Lifecycle/Security

> Reviewer: Codex (independent) | Date: 2026-04-21 | Branch: main HEAD 08d09ac

## P0 Issues

### P0-1: cancel pgid kill race — wrong process group may be SIGKILLed
`plugins/qwen/scripts/qwen-companion.mjs:318-339` loads a persisted `job.pgid` from `state.json` and immediately calls `cancelJobPgid`, while `plugins/qwen/scripts/lib/qwen.mjs:517-528` blindly sends `SIGINT`, then `SIGTERM`, then `SIGKILL` to `-pgid`. Because the plugin records `pgid = child.pid` for detached background jobs (`plugins/qwen/scripts/qwen-companion.mjs:233-242`) but never re-validates that the process group still belongs to the original qwen child before cancelling, a finished job can leave behind a stale pgid in state. Reproduction path: start a background task, let it exit without a status refresh updating the job record, wait for the OS to recycle that numeric process-group id to an unrelated process group, then run `cancel <jobId>`; the cancel path will signal the recycled group and can escalate all the way to `SIGKILL`.

## P1 Issues

### P1-1: PID liveness false-positive after OS PID recycling
`plugins/qwen/scripts/lib/job-lifecycle.mjs:15-22` treats `process.kill(job.pid, 0)` success as proof that the tracked job is still alive and returns early. That check only proves that some process currently owns the numeric PID; after PID recycling it can falsely keep a dead qwen job in `running` state and skip finalization/log parsing.

### P1-2: reviewWithRetry --session-id + -c session continuity unverified
`plugins/qwen/scripts/lib/qwen.mjs:343-346` makes `--session-id`, `-c`, and `-r` mutually exclusive, and `plugins/qwen/scripts/lib/qwen.mjs:675-679` tells retry attempts to `useResumeSession`. But the actual review runner in `plugins/qwen/scripts/qwen-companion.mjs:516-530` captures `streamResult.sessionId` and then never uses either that `sessionId` or `opts.useResumeSession` when rebuilding args for retries. The implementation therefore relies on intended session reuse semantics without an exercised, verified continuity path; whether retries are actually in the original review session is unproven.

## P2 Issues

### P2-1: buildSpawnEnv leaks full parent env (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
`plugins/qwen/scripts/lib/qwen.mjs:65-108` starts by cloning the entire parent environment with `const env = { ...process.env };` and then edits only proxy-related keys. That means every spawned qwen subprocess inherits the full ambient environment of the Claude Code process, including unrelated provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and other sensitive tokens that were not intentionally part of qwen execution.

### P2-2: Silent catch blocks swallow errors
There are multiple empty or effectively silent catch blocks in control-path code, including `plugins/qwen/scripts/lib/job-lifecycle.mjs:26`, `plugins/qwen/scripts/lib/qwen.mjs:441-443`, `plugins/qwen/scripts/lib/state.mjs:81-88`, `plugins/qwen/scripts/lib/state.mjs:168-178`, `plugins/qwen/scripts/lib/state.mjs:222-224`, and `plugins/qwen/scripts/session-lifecycle-hook.mjs:15-21` plus `plugins/qwen/scripts/session-lifecycle-hook.mjs:82-83`. These sites suppress file-read, parse, unlink, and process-signal failures that would otherwise help distinguish benign races from real state corruption or failed cleanup, making lifecycle bugs materially harder to detect and diagnose.

## Summary

| ID | Severity | File | Issue |
|----|----------|------|-------|
| P0-1 | P0 | `plugins/qwen/scripts/qwen-companion.mjs`, `plugins/qwen/scripts/lib/qwen.mjs` | Cancel uses stale persisted `pgid` and can signal a recycled unrelated process group up to `SIGKILL`. |
| P1-1 | P1 | `plugins/qwen/scripts/lib/job-lifecycle.mjs` | PID liveness uses `process.kill(pid, 0)` and can false-positive after PID recycling. |
| P1-2 | P1 | `plugins/qwen/scripts/lib/qwen.mjs`, `plugins/qwen/scripts/qwen-companion.mjs` | Review retry continuity is assumed but not actually threaded through `sessionId` or resume flags. |
| P2-1 | P2 | `plugins/qwen/scripts/lib/qwen.mjs` | Spawn env inherits the full parent environment, including unrelated secret-bearing variables. |
| P2-2 | P2 | `plugins/qwen/scripts/lib/job-lifecycle.mjs`, `plugins/qwen/scripts/lib/qwen.mjs`, `plugins/qwen/scripts/lib/state.mjs`, `plugins/qwen/scripts/session-lifecycle-hook.mjs` | Silent catch blocks suppress actionable lifecycle and I/O failures. |
