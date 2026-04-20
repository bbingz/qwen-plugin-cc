---
name: qwen-result-handling
description: Internal guidance for presenting Qwen helper output back to the user
user-invocable: false
---

# Qwen Result Handling

When the helper returns Qwen output:

- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first, ordered by severity.
- Use file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries: if Qwen marked something as inference / uncertain / follow-up, keep that distinction.
- Preserve output sections when prompt asked for them (observed facts, inferences, open questions, touched files, next steps).
- If there are no findings, say so explicitly and keep residual-risk note brief.
- If Qwen made edits, say so explicitly and list touched files when helper provides them.

## For `qwen:qwen-rescue`

- Do not turn a failed or incomplete Qwen run into a Claude-side implementation attempt. Report the failure and stop.
- If Qwen was never successfully invoked, do not generate a substitute answer at all.

## **CRITICAL**:review 输出后 STOP

After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues they want fixed before touching a single file. Auto-applying fixes from a review is **strictly forbidden**, even if the fix is obvious.

## Permission denials 渲染(v3.1 F-4)

If the helper's job payload contains `permissionDenials[]` with entries, highlight them:
- "Qwen wanted to call these tools but was denied in auto-edit mode: [list]"
- Suggest: "Rerun with `--unsafe` if you want Qwen to actually perform these."

## Error handling

- If helper reports malformed output or failed run, include the most actionable stderr/error lines and stop.
- If helper reports setup/authentication required, direct user to `/qwen:setup` and do not improvise alternate auth flows.
- If helper returns `require_interactive` kind, tell user: "Background rescue with yolo needs `--unsafe`. Add `--unsafe` or rerun with `--wait`."
- If helper returns `proxy_env_mismatch` or `proxy_conflict` warnings, surface them prominently (not buried).
