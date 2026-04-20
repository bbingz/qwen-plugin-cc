# Qwen prompt recipes

## Recipe: code review against a diff

```
<task>
Review the following diff for correctness, security, and style issues.
Diff:
<DIFF>
</task>

<structured_output_contract>
{
  "verdict": "approve" | "changes_requested",
  "findings": [{"severity":"high"|"med"|"low","path":"...","line":0,"message":"..."}]
}
Output ONLY this JSON object. No prose, no code fences.
</structured_output_contract>

<grounding_rules>
- Base all findings on the diff text; do not speculate about unseen files.
- Cite paths/lines from diff headers verbatim.
</grounding_rules>
```

## Recipe: debugging a failing test

```
<task>
The test `tests/foo.test.mjs::bar` fails with:
<STACK_TRACE>
Source:
<SOURCE_FILE_EXCERPT>
Find and fix the root cause.
</task>

<verification_loop>
Run `node --test tests/foo.test.mjs` after the fix; iterate if red.
</verification_loop>

<action_safety>
Stay in the source file or its direct imports. Do not refactor unrelated code.
</action_safety>
```

## Recipe: adversarial review

```
<task>
Challenge the following implementation's design assumptions, not just code-level defects.
Ask: is this the right approach at all? What breaks under real-world concurrency/scale?
Implementation:
<CODE>
</task>

<structured_output_contract>
{
  "verdict": "approve" | "challenge",
  "findings": [...],
  "design_risks": [{"risk":"...", "scenario":"..."}]
}
</structured_output_contract>
```
