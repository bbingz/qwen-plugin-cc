#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

out=$(qwen "ping" -m qwen-fake-model \
  --output-format stream-json --max-session-turns 1 2>&1)
exit_code=$?

jq -n --arg stdout "$out" --argjson exit_code $exit_code \
  '{case:"03-bad-model", stdout_excerpt:($stdout|.[0:2048]), exit_code:$exit_code,
    notes:"expected: classifyApiError 命中 invalid_request 或 api_error_unknown"}' \
  > case-03-bad-model.result.json

echo "exit_code: $exit_code"
echo "$out" | grep -oE '\[API Error:[^"]+' | head -1 || echo "(no API Error line)"
