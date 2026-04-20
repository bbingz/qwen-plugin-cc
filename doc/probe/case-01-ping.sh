#!/usr/bin/env bash
# Case 01: 正常 ping,基线
set -uo pipefail
cd "$(dirname "$0")"

out=$(qwen "reply with exactly: pong" \
  --output-format stream-json --max-session-turns 1 2>&1)
exit_code=$?

jq -n \
  --arg cmd 'qwen "reply with exactly: pong" --output-format stream-json --max-session-turns 1' \
  --arg stdout "$out" \
  --argjson exit_code $exit_code \
  '{case:"01-ping", cmd:$cmd, stdout_excerpt:($stdout|.[0:2048]), exit_code:$exit_code}' \
  > case-01-ping.result.json

echo "exit_code: $exit_code"
