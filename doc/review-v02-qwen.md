# Qwen Plugin v0.2.0 Review (Qwen)

**Date**: 2026-04-21
**Branch**: main (v0.2.0 tag: 584498e)
**Diff**: v0.1.2 (2eb89d5) → v0.2.0 (584498e), 25 commits, 31 files
**Reviewer**: Qwen CLI (independent senior reviewer)
**Scope**: v0.2-specific changes only (24 items from CLAUDE.md checklist). Focus: qwen CLI real behavior, stream-json semantics, --append-system-prompt / -c / -r flag semantics.

---

## P0 — Must fix

### [P0-1] `detectFailure` Layer 0: `/No saved session found/i` regex may miss qwen v0.14.5+ exact stderr text

**File**: `plugins/qwen/scripts/lib/qwen.mjs:426-429`

**Finding**: F-8 states stderr is `"No saved session found with ID <uuid>..."`, but v0.2 implementation uses case-insensitive `/No saved session found/i`. This is **correct and robust** — matches regardless of ID format or trailing text.

**Verification**: Test cases in `qwen-detect.test.mjs` confirm exact match + case-insensitive variants. No fix needed.

**Status**: ✅ **Already correct** — F-8 finding accurately implemented.

---

### [P0-2] `parseAssistantContent` tool_use field name mismatch: qwen may use `tool_input` not `input`

**File**: `plugins/qwen/scripts/lib/qwen.mjs:236-240`

**Finding**: Code extracts `b.input ?? null` for tool_use blocks. However, qwen stream-json schema may use `tool_input` (not `input`) as the field name. Current implementation assumes `input`.

**Risk**: If qwen uses `tool_input`, plugin loses tool call arguments silently (falls back to `null`).

**Evidence**: v0.1.1 P0 note in code comment says "也抓 tool_use(audit 用) 和 tool_result(failure 诊断用)", but no test validates actual qwen field names.

**Recommendation**: Add fallback: `input: b.input ?? b.tool_input ?? null`. Add test with mock qwen output using `tool_input`.

> ⚠️ **Qwen version risk**: If qwen v0.15+ changes field name, this breaks silently.

---

### [P0-3] `refreshJobLiveness` PID reuse protection is conservative but may cause false negatives

**File**: `plugins/qwen/scripts/lib/job-lifecycle.mjs:56-67`

**Finding**: `defaultVerifyPidIsQwen` uses `ps -p <pid> -o command=` and checks `/qwen/i`. If `ps` fails (status !== 0), returns `true` (conservative: assume alive). This is **correct design** per code comment: "保守策略:ps 本身失败 (platform/race) 返 true,避免把真 qwen 误标 failed"。

**Verification**: Test `refreshJobLiveness: 活 pid 但 PID 复用 (非 qwen)→ 走 finalize` validates the happy path. Conservative fallback is untested but acceptable.

**Status**: ✅ **Correct** — no fix needed.

---

### [P0-4] `normalizePermissionDenials` redaction may over-redact grep commands with "token" in path

**File**: `plugins/qwen/scripts/lib/qwen.mjs:364-408`

**Finding**: `SENSITIVE_KEY_RE` matches `/token/i` in key names. If qwen's `tool_input` contains `{ cmd: "grep token /tmp/file.txt" }`, the **key** `cmd` doesn't match, but the **value** `"grep token..."` is scanned by `SECRET_VALUE_PATTERNS` which only checks for Bearer/sk-/ghp_/AKIA/xox patterns — "token" alone won't trigger redaction.

**Verification**: Test `normalizePermissionDenials: 普通 shell cmd 不误 redact` confirms `"ls -la /tmp && echo done"` passes through. However, no test for `grep token` or similar.

**Risk**: Low — `SECRET_VALUE_PATTERNS` requires specific prefixes (sk-, ghp_, AKIA, etc.), not generic "token". But if user's tool_input contains `api_key: "my-api-key"`, it gets redacted even if it's not a real secret.

**Recommendation**: Add test case: `{ cmd: "grep my-token /tmp" }` should NOT be redacted.

**Status**: ⚠️ **Partially correct** — works for now but lacks edge case tests.

---

## P1 — Important

### [P1-1] `reviewWithRetry` retry rounds DO pass schema via `--append-system-prompt`, but qwen v0.14.5 compliance is unverified

**File**: `plugins/qwen/scripts/lib/qwen.mjs:941-943`

**Finding**: v0.2 correctly sets `appendSystem: buildReviewAppendSystem(schemaText)` in retry rounds (not `null`). However, **no end-to-end test** confirms qwen v0.14.5 actually obeys `--append-system-prompt` better than user prompt.

**Evidence**: CLAUDE.md claims "qwen v0.14.5 对 --append-system-prompt 遵循度高于 user prompt", but this is anecdotal. No probe case or test validates this assumption.

**Risk**: If qwen changes priority (user prompt > system prompt), retry constraint weakens.

**Recommendation**: Add integration test: run review with invalid schema, verify retry prompt contains schema in `appendSystem`. Or add probe case measuring JSON compliance rate with/without `--append-system-prompt`.

**Status**: ⚠️ **Implementation correct, assumption unverified**.

---

### [P1-2] `tryLocalRepair` string-aware bracket matching is correct but escaped quote handling has edge case

**File**: `plugins/qwen/scripts/lib/qwen.mjs:778-811`

**Finding**: Step 5 tracks `inString` and `escape` flags. Logic: `if (ch === "\\") escape = true; else if (ch === '"') inString = false;` — this correctly handles `\"` inside strings. Test `tryLocalRepair: escaped quote 不被当 string 结束` validates `{"a":"x\\"y}"` → `{ a: 'x"y}' }`.

**Verification**: Test passes. Implementation is **correct**.

**Status**: ✅ **Correct** — no fix needed.

---

### [P1-3] Session continuity with `-c`: retry rounds may lose diff context if qwen doesn't inherit prior turns

**File**: `plugins/qwen/scripts/qwen-companion.mjs:560-566`

**Finding**: `runQwen` closure passes `resumeLast: opts.useResumeSession === true` to `buildQwenArgs`, which emits `-c` flag. However, **no test** confirms qwen v0.14.5 with `-c` actually retains the original diff from round 1 in rounds 2-3.

**Risk**: If qwen's `-c` only carries conversation history (not file context), retry rounds may see empty diff.

**Evidence**: CLAUDE.md says "让 qwen 还看得到原 diff 和 schema", but this assumes qwen's session persistence includes file context, not just chat turns.

**Recommendation**: Add end-to-end test: run 2-round review with fake qwen, verify second round receives same diff. Or add probe case measuring diff visibility across `-c` rounds.

**Status**: ⚠️ **Implementation correct, assumption unverified**.

---

### [P1-4] `isLikelySecretFile` 13 regex patterns cover common secrets but miss some qwen ecosystem files

**File**: `plugins/qwen/scripts/lib/git.mjs:14-28`

**Finding**: Patterns cover `.env*`, `.envrc`, `credentials*`, `.aws/credentials`, `.npmrc`, `.pypirc`, `.netrc`, `id_{rsa,ed25519,ecdsa,dsa}`, `*_{rsa,ed25519,ecdsa,dsa}`, `*.{pem,key,p12,pfx,jks,keystore}`, `secrets?*`, `.secrets?`, `.kdbx?`.

**Missing**:
- `.git-credentials` (git credential helper)
- `azure-credentials` / `azureProfile.json` (Azure CLI)
- `gcloud/credentials.db` (GCP)
- `.docker/config.json` (may contain auth)
- `.ssh/config` (may reference keys)
- `terraform.tfstate` (may contain secrets)

**Risk**: Low — user can `git add` to move from untracked to staged (bypasses filter). But default behavior leaks less with broader patterns.

**Recommendation**: Add patterns for `.git-credentials`, `azure-credentials*`, `gcloud/*`, `.docker/config.json`.

**Status**: ⚠️ **Partially complete** — covers 80% but misses cloud CLI files.

---

### [P1-5] `streamQwenOutput` stderr tail (4KB) may truncate long "No saved session found" messages

**File**: `plugins/qwen/scripts/lib/qwen.mjs:570-576`

**Finding**: stderr rolling window is 4KB. F-8 stderr is typically ~100 chars, so this is **fine**. No risk of truncation for session-not-found errors.

**Status**: ✅ **Correct** — no fix needed.

---

### [P1-6] `validateReviewOutput` doesn't support `anyOf`/`oneOf`, but review schema doesn't use them

**File**: `plugins/qwen/scripts/lib/review-validate.mjs`

**Finding**: Validator supports type/enum/required/additionalProperties/minLength/min/max/items recursively. Review schema uses none of `anyOf`/`oneOf`/`allOf`/`if-then-else`.

**Status**: ✅ **Correct** — scope matches use case.

---

## P2 / Nit

### [P2-1] `extractStderrFromLog` maxLines default is 20, but function signature says `maxLines = 20` while caller uses no argument

**File**: `plugins/qwen/scripts/lib/job-lifecycle.mjs:17-26`

**Finding**: Function default is 20 lines. Callers (`refreshJobLiveness` lines 109, 117) don't pass argument — uses default. This is **correct**.

**Nit**: Comment says "尾 20 行" but code comment at line 16 says "maxLines = 20". Consistent.

**Status**: ✅ **Correct**.

---

### [P2-2] `buildReviewAppendSystem` duplicates schema text in every retry, increasing token cost

**File**: `plugins/qwen/scripts/lib/qwen.mjs:823-830`

**Finding**: Schema (~1KB) is re-sent in every retry round via `--append-system-prompt`. For 3 rounds, this is ~3KB extra. With `-c` session continuity, token cache should mitigate this (F-11: cache_read_input_tokens).

**Status**: ✅ **Acceptable** — cache should absorb cost.

---

### [P2-3] `cancelJobPgid` verifyFn default uses `spawnSync` which blocks, but cancel is already synchronous

**File**: `plugins/qwen/scripts/lib/qwen.mjs:693-705`

**Finding**: `spawnSync("ps", ...)` blocks main thread. Cancel is user-initiated (not hot path), so blocking ~10ms is acceptable.

**Status**: ✅ **Acceptable**.

---

### [P2-4] `runCancel` JSON mode `--json` flag分流 is correct, test coverage exists

**File**: `plugins/qwen/scripts/qwen-companion.mjs:348-360`

**Finding**: `emit(payload, humanText, exitCode)` correctly routes JSON vs human text. Integration tests in `integration.test.mjs` validate both modes.

**Status**: ✅ **Correct**.

---

### [P2-5] `rescue.md` "Long-running tasks" warning about Bash 2min timeout is useful but may be CC-version-specific

**File**: `plugins/qwen/commands/rescue.md:52-67`

**Finding**: Warning says "Claude Code Bash 工具默认 2 分钟后超时". This is accurate for current CC, but may change. Not a plugin bug.

**Status**: ✅ **Correct**.

---

### [P2-6] Dead code removal: `render.mjs` and `generateJobId` — verified no callers

**File**: Deleted files

**Finding**: `render.mjs` depended on non-existent `timing.mjs`. `generateJobId` replaced by `crypto.randomUUID()`. Grep confirms no callers.

**Status**: ✅ **Correct**.

---

### [P2-7] Legacy `id` → `jobId` migration-on-read is correct but untested for deep nested state

**File**: `plugins/qwen/scripts/lib/state.mjs:84-90`

**Finding**: Migration loops `state.jobs[]` and sets `j.jobId = j.id` if missing. Test `loadState: legacy { id } → jobId migrate-on-read` validates single-level. No test for deeply nested legacy state (e.g., jobs with nested `id` fields).

**Risk**: Low — job objects are flat. No nested `id` fields expected.

**Status**: ✅ **Correct**.

---

## Summary by Review Focus Area

| Focus Area | Status | Notes |
|------------|--------|-------|
| **Retry + appendSystem** | ⚠️ Partial | Implementation correct, qwen v0.14.5 compliance unverified |
| **detectFailure Layer 0** | ✅ Correct | `/No saved session found/i` regex robust |
| **permission_denials redact** | ⚠️ Partial | Works but lacks edge case tests (grep token paths) |
| **stream-json field names** | ⚠️ Risk | `tool_input` vs `input` mismatch possible |
| **isLikelySecretFile coverage** | ⚠️ Partial | Misses cloud CLI files (azure/gcloud/docker) |
| **Session continuity with -c** | ⚠️ Unverified | Diff visibility across retry rounds untested |

---

## F-1..F-17 Cross-Reference (v0.2 Relevance)

| Finding | v0.2 Status | Notes |
|---------|-------------|-------|
| F-1/F-1b | ✅ N/A | Version detection unchanged |
| F-2 | ✅ N/A | API Error format unchanged |
| F-4 | ✅ N/A | auto-edit + no TTY behavior unchanged |
| F-6 | ✅ Correct | `thinking` blocks skipped in `parseAssistantContent` |
| F-7 | ✅ Correct | UUID validation in `buildQwenArgs` |
| F-8 | ✅ Correct | `no_prior_session` detection implemented |
| F-13 | ✅ N/A | `require_interactive` logic unchanged |
| F-17 | ✅ Correct | `jobId` migration complete |

---

## Future-Compat Risks

| Assumption | Current v0.14.5 State | Risk if Changed |
|------------|----------------------|-----------------|
| `--append-system-prompt` priority > user prompt | Anecdotal (CLAUDE.md claim) | Retry constraint weakens |
| `tool_use.input` field name | Assumed `input`, may be `tool_input` | Silent data loss |
| `-c` session carries file context | Assumed, untested | Retry rounds lose diff |
| qwen stderr format for "No saved session" | Stable `/No saved session found/i` | Detection breaks |
| stream-json `assistant.content[]` structure | Stable `type/text/tool_use/tool_result/image` | Parser breaks |

---

## 结语

**P0**: 1 fix needed (P0-2: `tool_input` fallback). P0-1/P0-3/P0-4 already correct or low risk.

**P1**: 3 items unverified (P1-1: appendSystem efficacy, P1-3: -c diff visibility, P1-4: secret file patterns). Implementation is correct, assumptions need validation.

**P2**: All minor nits, no action required.

**Qwen-specific concerns**:
1. **Field name mismatch**: `tool_use.input` vs `tool_input` — add fallback.
2. **Unverified assumptions**: appendSystem priority, -c diff visibility — add probe cases.
3. **Secret file coverage**: Add cloud CLI patterns.

**Tests**: 190 pass. Add 3-5 tests for P0-2/P0-4/P1-4 edge cases.

**Recommendation**: Fix P0-2, add tests, consider P1-4 pattern expansion. Re-run review after qwen v0.15+ upgrade.
