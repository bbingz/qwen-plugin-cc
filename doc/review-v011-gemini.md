# Review v0.1.1 — Gemini (cross-file + test-gap lens)

## Summary
The v0.1.1 release implements the core dispatcher solidly, but it suffers from severe lineage drift in presentation layers (hardcoded "Gemini CLI" strings) and significant test coverage gaps on critical boundaries like hooks and env-whitelisting. I found 2 P0s, 2 P1s, 2 P2s, and 1 Nit.

## P0 — ship-blockers

**`lib/render.mjs` is entirely hardcoded for Gemini CLI**
- **File:line refs:** `plugins/qwen/scripts/lib/render.mjs:10,24,54,92,100,110,168,171,174,176`
- **Why it matters:** Any UI rendering (status, result, or review hints) will output "Gemini CLI Status", use `/gemini:status` or `/gemini:cancel` instructions, and look for `geminiSessionId` instead of `sessionId`. This completely breaks the user experience and provides invalid command copy-paste targets for the Qwen plugin.
- **Evidence:** `lines.push("## Gemini CLI Status\n");` and `hints.push("  - Cancel: \`/gemini:cancel ${job.id}\`");`
- **Suggested fix direction:** Replace all `gemini` strings with `qwen`, update `/gemini:*` slash commands to `/qwen:*`, and change `geminiSessionId` to `sessionId` matching the new qwen architecture.

**`QWEN_PLUGIN_ENV_ALLOW` split behavior is untested for edge cases**
- **File:line refs:** `plugins/qwen/scripts/lib/qwen.mjs:44,105` and `plugins/qwen/scripts/tests/qwen-proxy.test.mjs:121`
- **Why it matters:** The security hotfix for `buildSpawnEnv` added `QWEN_PLUGIN_ENV_ALLOW="K1,K2"`. If a user adds a trailing comma or spaces (`"K1, K2"`), it might fail to whitelist environments correctly, silently dropping credentials or causing unexpected child process failures. The unit tests only check a perfectly formatted `"MY_VAR,OTHER"` string.
- **Evidence:** Missing defensive split parsing. `NO_PROXY` correctly uses `.split(",").map(s => s.trim()).filter(Boolean)`, but it's unclear if the allowlist parser uses the same defensive sanitization.
- **Suggested fix direction:** Add tests for edge cases (empty strings, spaces, trailing commas) and ensure string splitting includes `.map(s => s.trim()).filter(Boolean)`.

## P1 — high priority

**`job.id` vs `job.jobId` inconsistency persists in `lib/render.mjs`**
- **File:line refs:** `plugins/qwen/scripts/lib/render.mjs:119,133,137,151,168,171,187`
- **Why it matters:** `qwen-companion.mjs` fully embraces `jobId` for state, but the renderer is still accessing `job.id`. Since v0.1.1, `job.id` will be `undefined` for new Qwen jobs. This will result in the CLI rendering broken tables (e.g. `| undefined | task | running |`) and broken Markdown links for command hints.
- **Evidence:** `lines.push(\`| \\\`${job.id}\\\` | ${job.kindLabel} ...\`);`
- **Suggested fix direction:** Change `job.id` to `job.jobId ?? job.id` throughout `lib/render.mjs` to match the state compatibility layer seen in `state.mjs`.

**`session-lifecycle-hook.mjs` has zero test coverage**
- **File:line refs:** `plugins/qwen/scripts/tests/*`
- **Why it matters:** `session-lifecycle-hook.mjs` is critical for terminating orphaned background jobs on session end (`terminateProcessTree`). Without tests, we cannot be sure if it properly skips when `.git` is absent, or if the fallback `cwd` behavior works safely. A bug here could leave Qwen processes running forever.
- **Evidence:** `grep_search` found zero matches for `session-lifecycle-hook` inside the `tests/*.test.mjs` directory.
- **Suggested fix direction:** Create a test file mocking `process.cwd`, `.git` directory presence, and `terminateProcessTree` to ensure session cleanup behaves defensively.

## P2 — medium

**`reviewWithRetry` misses regression test for 3rd attempt success**
- **File:line refs:** `plugins/qwen/scripts/tests/qwen-review.test.mjs:68`
- **Why it matters:** The test suite verifies 1st try success, 2nd try success (`retry 1`), and all 3 tries failing. It misses the specific logic branch where the *3rd* attempt (retry 2) succeeds. This creates a blind spot where the final prompt generation or state return for `i === 2` could break without CI catching it.
- **Evidence:** Missing test case for `reviewWithRetry: retry 2 成功`.
- **Suggested fix direction:** Add a test mocking `runQwen` to fail twice and return valid JSON on the 3rd invocation.

**`tests/qwen-proxy.test.mjs` hardcodes Gemini env vars**
- **File:line refs:** `plugins/qwen/scripts/tests/qwen-proxy.test.mjs:85`
- **Why it matters:** The proxy filter tests use `GEMINI_API_KEY` to verify that un-whitelisted credentials are dropped. While technically valid as a dummy variable, this is lineage drift and causes confusion regarding what the actual qwen plugin checks.
- **Evidence:** `GEMINI_API_KEY: "g-456",` used in mock environment filtering.
- **Suggested fix direction:** Change the test variable to `BAILIAN_CODING_PLAN_API_KEY` or `OPENAI_API_KEY` to align with Qwen auth semantics.

## Nit — polish

**`cancel.md` and `status.md` parameter naming inconsistency**
- **File:line refs:** `plugins/qwen/commands/cancel.md:3`, `plugins/qwen/commands/status.md:3`
- **Why it matters:** The `argument-hint` uses `[job-id]` while the code implementation (`args.mjs` and `qwen-companion.mjs`) exclusively uses `jobId`. While harmless for execution, aligning on camelCase `jobId` reduces cognitive load.
- **Evidence:** `argument-hint: '[job-id] [--wait]...'`
- **Suggested fix direction:** Change to `[jobId]` or `<jobId>` uniformly.

## Test coverage matrix

| Code Path | Covered | Gaps & Blind Spots |
|---|---|---|
| `reviewWithRetry` failure paths | Partial | Missing test for success on final (3rd) attempt (`i === 2`). |
| `bg job incomplete_stream` | Yes | Tested properly via `qwen-job-lifecycle.test.mjs` dead pid detection. |
| `session-lifecycle-hook` on cwd | **No** | Zero tests; `.git` absence fallback & `terminateProcessTree` untested. |
| `buildSpawnEnv` whitelist edges | Partial | Custom whitelist `QWEN_PLUGIN_ENV_ALLOW` lacks edge-case tests (empty strings, spaces). |
| `cancelJobPgid` probe race | Yes | Mocked `process.kill` covers ESRCH properly across all 3 signal stages. |

## Cross-file inconsistency audit

- **`jobId` vs `id`**:
  - `lib/state.mjs`: Handles both defensively via `j.jobId ?? j.id` (Consistent).
  - `qwen-companion.mjs`: Uses `jobId` exclusively for new generation (Consistent).
  - `hooks/stop-review-gate-hook.mjs`: Uses `runningJob.jobId ?? runningJob.id` (Consistent).
  - `lib/render.mjs`: **FAIL.** Exclusively uses `job.id` which is `undefined` in v0.1.1.
- **session-id validation**:
  - `qwen.mjs` strictly enforces `UUID_RE.test(sessionId)`, correctly preventing invalid identifiers from being passed to qwen. (Consistent).
- **env allowlist (`QWEN_PLUGIN_ENV_ALLOW`)**:
  - Parsed in `qwen.mjs` and referenced in tests, but tests only verify cleanly formatted strings. (Consistent intent, gap in validation).
- **error-code regexes (`[API Error:`)**:
  - `qwen.mjs` correctly prioritizes `\[API Error:` over `\bStatus:\s*(\d{3})\b`.
  - `tests/qwen-classify.test.mjs` faithfully tests this dynamic with `[API Error: Connection refused (Status: 401)]`. (Consistent).