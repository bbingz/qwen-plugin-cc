#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

DIFF=$(cat fixtures/tiny-diff.txt)
PROMPT="Review this diff. Output ONLY a JSON object with fields verdict (approve/changes_requested), findings (array of {severity, path, line, message}). No prose, no fences.

Diff:
$DIFF"

out=$(qwen "$PROMPT" --output-format stream-json --max-session-turns 1 2>&1)
exit_code=$?

jq -n --arg out "$out" --argjson ec $exit_code \
  '{case:"07-review-raw", exit_code:$ec, stdout_excerpt:($out|.[0:4096]),
    notes:"观察 qwen 是否吐合法 JSON 还是混 fence/prose"}' \
  > case-07-review-raw.result.json

echo "exit_code: $exit_code"
