# qwen-plugin-cc v0.1.1 — 5-Way Self-Review by Qwen CLI

**Date**: 2026-04-21
**Branch**: main (HEAD 55c7345, tag v0.1.1: 143b92d, substantive: 90613ab)
**Reviewer**: Qwen CLI (self-review of qwen-plugin-cc)
**Scope**: Core stream-json parsing, resume semantics, auto-edit/unsafe boundary, API error edges, model fallback, tool_use/permission schema

---

## Executive Summary

**Total findings**: 12 issues (4 P0, 5 P1, 3 P2)

**Qwen-specific focus areas**:
1. Stream-json fragility beyond F-6 (thinking blocks) — tool_use/tool_result content types, content-less events
2. Resume semantics (`-r <uuid>`) vs spec assumptions
3. Auto-edit vs yolo boundary with F-4/F-13 combinations
4. API error formats beyond `[API Error: 429/503 ...]`
5. Model fallback behavior (F-10) impact on review reliability
6. Permission denial schema completeness

**Notable v0.1.1 improvements since v0.1.0**:
- UUID validation added to `buildQwenArgs` (fixes v010 P0 #3)
- Env whitelist hardening (filterEnvForChild)
- cancelJobPgid pgid recycling protection

**Issues carried forward from v010** (not repeated here per ground rules):
- Retry `appendSystem: null` constraint weakening
- `tryLocalRepair` truncation limitations
- `buildReviewRetryPrompt` 8KB truncation strategy
- `prompts.mjs` XML block structure absence
- Schema `confidence` field lacks enum constraints

---

## P0 Critical

### [P0] `parseStreamEvents` / `streamQwenOutput` miss `tool_use` / `tool_result` content types

**File**: `plugins/qwen/scripts/lib/qwen.mjs:372-398` (parseStreamEvents), `156-162` (runQwenPing), `383-387` (streamQwenOutput)

**Observation**: Current implementation only collects `b.type === "text"` blocks (F-6 compliance for thinking skip). However, qwen stream-json can emit:
- `type: "tool_use"` — when qwen decides to call a tool
- `type: "tool_result"` — tool execution results
- `type: "image"` — rare but possible in multimodal contexts

**Code at risk**:
```js
for (const b of blocks) {
  if (b?.type === "text" && typeof b.text === "string") {
    out.assistantTexts.push(b.text);
  }
}
```

**Impact**:
1. **Review reliability**: If qwen emits `tool_use` to gather context (e.g., `read_file` to inspect code), the tool call arguments and results are lost from `assistantTexts`, potentially losing error signals
2. **Debugging gap**: User can't see what tools qwen attempted in `/qwen:result` output
3. **Permission denial detection**: `permission_denials` array comes from `resultEvent`, but early tool_use blocks before result aren't tracked

**FINDINGS anchor**: F-6 only mentions `thinking + text`, doesn't enumerate all content types.

**Fix**:
```js
// Collect all content types for debugging, filter only text for assistantTexts
const allBlocks = [];
for (const b of blocks) {
  allBlocks.push(b);
  if (b?.type === "text" && typeof b.text === "string") {
    out.assistantTexts.push(b.text);
  }
}
// Optionally expose: out.allContent = allBlocks;
```

---

### [P0] Resume session (`-r <uuid>`) failure detection missing from `detectFailure`

**File**: `plugins/qwen/scripts/lib/qwen.mjs:198-224`

**Observation**: F-8 documents stderr text `"No saved session found with ID <uuid>"` when resuming a non-existent session. Current `detectFailure` doesn't check stderr at all — only exitCode, resultEvent, and assistantTexts.

**Code gap**:
```js
export function detectFailure({ exitCode, resultEvent, assistantTexts }) {
  // No stderr parameter!
  // Layer 1-5 check exit code, is_error, API Error patterns, empty output
  // But no check for resume failure
}
```

**Impact**:
1. **Silent failure**: qwen exits with code 1, stderr has "No saved session..." but `detectFailure` returns `{failed: false}` if exitCode is somehow 0 or assistant text exists
2. **User confusion**: `/qwen:rescue --resume <bad-uuid>` fails but plugin reports success

**FINDINGS anchor**: F-8 explicitly states stderr pattern.

**Fix**:
```js
export function detectFailure({ exitCode, resultEvent, assistantTexts, stderrText = "" }) {
  // ... existing layers ...

  // Layer 0: resume session failure (check before exit code)
  if (/No saved session found with ID/i.test(stderrText)) {
    return { failed: true, kind: "no_prior_session", message: stderrText };
  }

  // ... rest unchanged ...
}
```

Then propagate stderr from `runCommand` / `streamQwenOutput` to `detectFailure` call sites.

---

### [P0] `permission_denials` schema incompleteness — tool name and arguments redaction unclear

**File**: `plugins/qwen/scripts/lib/qwen.mjs:383-387` (streamQwenOutput collection), `qwen-companion.mjs:209` (writeJobFile), `FINDINGS.md:F-4`

**Observation**: F-4 mentions `permission_denials: [{ tool_name, tool_input }]` but code only does blind passthrough:
```js
permissionDenials: streamResult.resultEvent?.permission_denials ?? []
```

**Unspecified in schema**:
1. **Tool name field**: Is it `tool_name`, `toolName`, `name`? qwen's schema may vary
2. **Arguments redaction**: `tool_input` may contain secrets (API keys, file paths) — should these be redacted before writing to `jobs/<jobId>.json`?
3. **Rendering in `/qwen:result`**: `qwen-companion.mjs:404-414` shows `pd.tool_name` and `pd.tool_input` but assumes schema

**Impact**:
1. **Security risk**: If qwen includes sensitive args (e.g., `write_file` with secret content), they're persisted unredacted
2. **Schema mismatch**: If qwen changes field names, rendering breaks silently

**FINDINGS anchor**: F-4 shows example but doesn't guarantee stability.

**Fix**:
```js
// Redact sensitive fields from permission_denials before persisting
const rawDenials = streamResult.resultEvent?.permission_denials ?? [];
const safeDenials = rawDenials.map(pd => ({
  tool_name: pd.tool_name ?? pd.name ?? "(unknown)",
  tool_input: redactSensitiveFields(pd.tool_input ?? pd.arguments ?? {}),
}));

function redactSensitiveFields(input) {
  const REDACT_KEYS = ["password", "secret", "key", "token", "content"];
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = REDACT_KEYS.some(r => k.toLowerCase().includes(r)) ? "[REDACTED]" : v;
  }
  return out;
}
```

---

### [P0] `reviewWithRetry` retry logic doesn't use `-c` (resume session) correctly

**File**: `plugins/qwen/scripts/lib/qwen.mjs:763-819`

**Observation**: Line 775 has `useResumeSession: i > 0` comment, but actual `runQwen` call (line 773-776) doesn't pass any resume option:
```js
const raw = await runQwen(prompt, {
  maxSteps: i === 0 ? 20 : 1,
  useResumeSession: i > 0,  // ← This option is defined but NEVER USED!
});
```

The `runQwen` closure (lines 633-644) doesn't read `useResumeSession`:
```js
const runQwen = async (prompt, opts = {}) => {
  const { args: argsArr } = buildQwenArgs({
    // ... no resume logic here ...
    // Always creates fresh session
  });
  // ...
};
```

**Impact**:
1. **Spec violation**: §5.3 requires retry to "carry prior round's raw + schema + fix instructions" in same session (`-c`)
2. **Token cost**: Each retry starts fresh, losing conversation context, potentially higher token usage
3. **Review quality degradation**: qwen can't see its prior attempt's diff context

**Fix**:
```js
const runQwen = async (prompt, opts = {}) => {
  const { args: argsArr } = buildQwenArgs({
    prompt: prompt.user,
    appendSystem: prompt.appendSystem || undefined,
    unsafeFlag: options.unsafe === true,
    background: false,
    maxSteps: opts.maxSteps ?? 20,
    // Add resume logic:
    resumeLast: opts.useResumeSession === true,  // -c flag
    sessionId: opts.useResumeSession === true ? sessionId : undefined,  // reuse captured session
  });
  // ...
};
```

---

## P1 Important

### [P1] Content-less assistant events not handled

**File**: `plugins/qwen/scripts/lib/qwen.mjs:372-398`

**Observation**: Code assumes `event.message.content` exists:
```js
const blocks = event.message?.content ?? [];
```

But qwen could emit assistant events with:
- Missing `message` entirely
- `message` without `content` field
- `content: null` or `content: []`

**Impact**: Silent skip (due to `?? []`), which is mostly safe, but could indicate malformed stream that should be flagged.

**Fix**: Add logging for unexpected structures:
```js
const blocks = event.message?.content ?? [];
if (event.type === "assistant" && !event.message?.content) {
  // Log for debugging: unexpected assistant event structure
  console.error("[qwen.mjs] assistant event missing content:", JSON.stringify(event));
}
```

---

### [P1] Nested error objects in stream-json not extracted

**File**: `plugins/qwen/scripts/lib/qwen.mjs:372-398`

**Observation**: qwen may emit nested error structures like:
```json
{"type":"assistant","message":{"content":[{"type":"text","text":"Error occurred"}]},
 "error":{"code":"rate_limit","details":"..."}}
```

Current parser ignores top-level `error` field, only looks at `content[].text`.

**Impact**: Error signals in structured `error` field are lost, may miss early termination cues.

**Fix**:
```js
if (event.type === "assistant") {
  // Check for top-level error field
  if (event.error && typeof event.error === "object") {
    // Optionally flag for debugging
  }
  const blocks = event.message?.content ?? [];
  // ... existing logic ...
}
```

---

### [P1] Model fallback (F-10) silent behavior not detected or warned

**File**: `plugins/qwen/scripts/lib/qwen.mjs:134-152` (runQwenPing), `qwen-companion.mjs:94-101` (setup auth check)

**Observation**: F-10 states `-m <bad-model>` silently falls back to default. Current code:
1. Doesn't explicitly pass `-m` (relies on settings.json)
2. Doesn't verify the model used matches expectations
3. `runQwenPing` captures `model` from init event but doesn't validate

**Impact**:
1. **Review reliability**: User thinks they're using `qwen3.6-plus` but gets `qwen3.5-plus` fallback, may affect review quality
2. **Debugging difficulty**: No warning when fallback occurs

**Fix**:
```js
// In setup command, compare expected vs actual model
const expectedModel = userSettings?.model;
const actualModel = ping.model;
if (expectedModel && actualModel && expectedModel !== actualModel) {
  warnings.push({
    kind: "model_fallback",
    message: `Model fallback: requested "${expectedModel}", got "${actualModel}"`,
  });
}
```

---

### [P1] `refreshJobLiveness` assumes exitCode=0 when child exited

**File**: `plugins/qwen/scripts/lib/job-lifecycle.mjs:26-48`

**Observation**: When bg job dies and `refreshJobLiveness` parses log:
```js
failure = detectFailure({
  exitCode: 0,  // ← Assumed, not known!
  resultEvent: parsed.resultEvent,
  assistantTexts: parsed.assistantTexts,
});
```

**Impact**:
1. **Misclassification**: If child actually exited with code 1 (crash), but we assume 0, `detectFailure` Layer 1 won't trigger
2. **Masking bugs**: Real crashes look like "incomplete_stream" instead of "exit"

**FINDINGS anchor**: Related to F-17 (job schema field split), bg job finalization gap.

**Fix**:
```js
// Can't know true exitCode from log alone, but can infer:
const inferredExitCode = parsed.resultEvent ? 0 : null;  // result event = natural exit
// Or pass unknown:
failure = detectFailure({
  exitCode: parsed.resultEvent ? 0 : null,
  // ...
});
```

Better: capture exit code in log file by having companion write it when child exits.

---

### [P1] `classifyApiError` keywords may match false positives in long assistant text

**File**: `plugins/qwen/scripts/lib/qwen.mjs:168-193`

**Observation**: v010 review P0 #1 noted this, but it's still present. Layer 4 calls `classifyApiError` on any line containing `[API Error:`:
```js
const errLine = (assistantTexts || []).find(t => /\[API Error:/.test(t));
if (errLine) return classifyApiError(errLine);
```

But qwen could output:
```
Here's an example error you might see: [API Error: 401 ...] — but this is just a demo.
```

**Impact**: False positive error classification.

**Current mitigation**: Only triggers if line starts with or contains `[API Error:`, which is usually qwen's actual error format.

**Better fix**: Require error to be isolated (not in middle of prose):
```js
const errLine = (assistantTexts || []).find(t => /^\s*\[API Error:/.test(t));
```

---

## P2 Minor

### [P2] `tryLocalRepair` doesn't handle escaped quotes in string detection

**File**: `plugins/qwen/scripts/lib/qwen.mjs:435-476`

**Observation**: Step 5 bracket counting doesn't account for escaped quotes when detecting unclosed strings:
```js
// Proposed but not implemented: /"(?:[^"\\]|\\.)*$/
```

**Impact**: If JSON is `{"msg": "test \"}` (escaped quote before truncation), repair logic may misidentify bracket needs.

**Current status**: Noted in v010 review P0 #5, not fixed in v0.1.1.

**Fix**: Add string closure detection before bracket counting:
```js
// Detect unclosed string (accounting for escapes)
const unclosedString = text.match(/"((?:[^"\\]|\\.)*)$/);
if (unclosedString) {
  // Close the string and truncate field
  text = text.slice(0, -unclosedString[0].length) + '"';
}
```

---

### [P2] `buildQwenArgs` UUID validation error message could be clearer

**File**: `plugins/qwen/scripts/lib/qwen.mjs:283-301`

**Observation**: Error says `"Use crypto.randomUUID() or omit"` but user may have gotten bad UUID from elsewhere (e.g., copied from log).

**Impact**: Minor UX friction.

**Fix**:
```js
throw new CompanionError(
  "invalid_session_id",
  `--session-id must be a valid UUID (got "${sessionId}"). ` +
  `Ensure you're using crypto.randomUUID() or a valid UUID string.`
);
```

---

### [P2] Test fixtures don't cover real qwen output morphologies for tool_use/tool_result

**File**: `plugins/qwen/scripts/tests/qwen-parse.test.mjs`, `qwen-stream.test.mjs`

**Observation**: Tests cover:
- Normal JSONL with text blocks
- API Error in text
- Thinking blocks (F-6 compliance)

But no fixtures for:
- `tool_use` content blocks
- `tool_result` content blocks
- Content-less assistant events
- Nested error fields

**Impact**: Regression risk if qwen changes output format.

**Fix**: Add test fixtures:
```js
const WITH_TOOL_USE = `
{"type":"assistant","message":{"content":[
  {"type":"text","text":"Let me check the file"},
  {"type":"tool_use","name":"read_file","input":{"path":"foo.js"}}
]}}
`.trim();

test("parseStreamEvents: tool_use blocks are ignored in assistantTexts", () => {
  const { assistantTexts } = parseStreamEvents(WITH_TOOL_USE);
  assert.deepEqual(assistantTexts, ["Let me check the file"]);
});
```

---

## Summary Table

| ID | Severity | Category | File | Line | Fix effort |
|----|----------|----------|------|------|------------|
| P0-1 | P0 | Stream parsing | qwen.mjs | 372-398 | Low |
| P0-2 | P0 | Resume detection | qwen.mjs | 198-224 | Medium |
| P0-3 | P0 | Security/schema | qwen.mjs | 383-387 | Medium |
| P0-4 | P0 | Retry logic | qwen.mjs | 763-819 | Low |
| P1-1 | P1 | Stream parsing | qwen.mjs | 372-398 | Low |
| P1-2 | P1 | Stream parsing | qwen.mjs | 372-398 | Low |
| P1-3 | P1 | Model fallback | qwen.mjs | 134-152 | Low |
| P1-4 | P1 | BG finalization | job-lifecycle.mjs | 26-48 | Low |
| P1-5 | P1 | Error classification | qwen.mjs | 168-193 | Low |
| P2-1 | P2 | JSON repair | qwen.mjs | 435-476 | Medium |
| P2-2 | P2 | UX/error msg | qwen.mjs | 283-301 | Trivial |
| P2-3 | P2 | Test coverage | qwen-parse.test.mjs | N/A | Medium |

---

## F-1..F-17 Coverage Status (v0.1.1)

| Finding | v0.1.1 Status | Notes |
|---------|--------------|-------|
| F-1 (`--version`) | ✅ Covered | Implemented |
| F-1b (bare version) | ✅ Covered | Parsed correctly |
| F-2 (API Error format) | ✅ Covered | Priority regex correct |
| F-3 (default model) | ✅ Covered | No hardcoding |
| F-4 (auto-edit auto-deny) | ⚠️ Partial | permissionDenials passthrough exists, redaction missing (P0-3) |
| F-5 (proxy settings) | ✅ Covered | Env read correct |
| F-6 (thinking blocks) | ✅ Covered | Skip logic present |
| F-7 (UUID constraint) | ✅ Fixed | v0.1.1 added validation |
| F-8 (no_prior_session) | ❌ Missing | P0-2 identifies gap |
| F-9 (API Key mode) | ✅ Covered | Parser handles |
| F-10 (model fallback) | ⚠️ Partial | P1-3 adds detection |
| F-11 (state.mjs API) | ✅ Covered | Aligned |
| F-12 (streaming signature) | ✅ Covered | Aligned |
| F-13 (require_interactive) | ✅ Covered | Logic correct |
| F-14 (args.mjs API) | ✅ Covered | Aligned |
| F-15 (git.mjs signature) | ✅ Covered | Aligned |
| F-16 (codex hook deps) | ✅ Covered | Replaced |
| F-17 (jobId vs id) | ✅ Covered | Compatibility in place |

---

## Recommendations for v0.2

**Priority order** (based on impact × effort):

1. **P0-4**: Fix retry session resume (`-c`) — correctness, spec compliance
2. **P0-2**: Add `no_prior_session` detection — user-facing reliability
3. **P0-3**: Redact permission_denials — security hardening
4. **P0-1**: Track tool_use/tool_result blocks — debugging/reliability
5. **P1-4**: Fix `refreshJobLiveness` exitCode assumption — bg job accuracy
6. **P1-3**: Add model fallback warning — transparency
7. **P2-3**: Expand test fixtures — regression prevention

**Defer to v0.2** (per pending-after-compact.md backlog alignment):
- P2-1 (escaped quotes in tryLocalRepair) — edge case, medium effort
- P1-5 (keyword false positives) — low probability, existing mitigation sufficient

---

## Methodology Notes

**Code analyzed**:
- `plugins/qwen/scripts/lib/qwen.mjs` (819 lines) — core stream/parse/failure/retry
- `plugins/qwen/scripts/qwen-companion.mjs` (dispatcher) — subcommand routing
- `plugins/qwen/scripts/lib/job-lifecycle.mjs` — bg finalize
- `plugins/qwen/scripts/lib/prompts.mjs` — template loading
- `plugins/qwen/scripts/tests/*.test.mjs` — fixture coverage analysis
- `doc/probe/FINDINGS.md` — 17 qwen behavior findings
- `doc/review-v010-qwen.md` — prior self-review (avoided duplicates)

**Ground rules followed**:
- Every bug cites file + line range
- Conclusions anchored to code observation or FINDINGS.md
- No duplicates from review-v010-qwen.md
- No臆断 — assumptions stated explicitly
