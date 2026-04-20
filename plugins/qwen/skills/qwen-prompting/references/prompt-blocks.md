# Reusable XML prompt blocks

## `<task>`

```
<task>
Goal: ...
Repo: ...
Failing test: ...
Acceptance: ...
</task>
```

## `<structured_output_contract>`

```
<structured_output_contract>
{
  "verdict": "approve" | "changes_requested",
  "findings": [{"severity": "high"|"med"|"low", "path": "...", "line": 0, "message": "..."}]
}
Output ONLY this JSON object. No prose, no code fences.
</structured_output_contract>
```

## `<default_follow_through_policy>`

```
<default_follow_through_policy>
- If information is incomplete, proceed with the most conservative interpretation and note the assumption.
- Do not ask clarifying questions unless blocked.
</default_follow_through_policy>
```

## `<verification_loop>`

```
<verification_loop>
After each code change, run tests; if tests fail, iterate before declaring done.
</verification_loop>
```

## `<grounding_rules>`

```
<grounding_rules>
- Base all findings on the provided diff text; do not speculate about files not shown.
- Quote file paths and line numbers verbatim from the diff headers.
- Mark inferences explicitly as "inference" rather than "observed".
</grounding_rules>
```

## `<action_safety>`

```
<action_safety>
- Stay within the scope of the task; do not refactor unrelated files.
- Do not run shell commands unless explicitly required.
- Do not modify CI or test infrastructure without asking.
</action_safety>
```
