#!/usr/bin/env bash
# case 06: --session-id 必须是 UUID(实测发现)
set -uo pipefail
cd "$(dirname "$0")"

SID=$(uuidgen | tr 'A-Z' 'a-z')

out1=$(qwen "I am using session id $SID. Acknowledge." \
  --session-id "$SID" \
  --output-format stream-json --max-session-turns 1 2>&1)
sleep 2
out2=$(qwen -r "$SID" "What is my session id?" \
  --output-format stream-json --max-session-turns 1 2>&1)

jq -n --arg sid "$SID" --arg out1 "$out1" --arg out2 "$out2" \
  '{case:"06-session-id", session_id:$sid,
    stdout_excerpt_first:($out1|.[0:2048]),
    stdout_excerpt_second:($out2|.[0:2048]),
    notes:"IMPORTANT: --session-id 必须是 UUID 格式 (实测)"}' \
  > case-06-session-id.result.json

echo "SID: $SID"
echo "second mentions SID: $(echo "$out2" | grep -o "$SID" | wc -l | tr -d ' ')"
