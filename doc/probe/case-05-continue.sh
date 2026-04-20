#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

out1=$(qwen "Remember this number: 42. Only acknowledge." \
  --output-format stream-json --max-session-turns 1 2>&1)
sleep 2
out2=$(qwen -c "What number did I ask you to remember?" \
  --output-format stream-json --max-session-turns 1 2>&1)

jq -n --arg out1 "$out1" --arg out2 "$out2" \
  '{case:"05-continue",
    stdout_excerpt_first:($out1|.[0:2048]),
    stdout_excerpt_second:($out2|.[0:2048]),
    notes:"第 2 次输出应含 42"}' \
  > case-05-continue.result.json

echo "second mentions 42: $(echo "$out2" | grep -c '42' || echo 0)"
