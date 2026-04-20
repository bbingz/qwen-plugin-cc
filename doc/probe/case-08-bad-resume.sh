#!/usr/bin/env bash
# case 08: -r 用不存在但合法 UUID
set -uo pipefail
cd "$(dirname "$0")"

# 合法但随机 UUID(不存在对应 session)
FAKE_UUID=$(uuidgen | tr 'A-Z' 'a-z')

out=$(qwen -r "$FAKE_UUID" "hi" \
  --output-format stream-json --max-session-turns 1 2>&1)
exit_code=$?

jq -n --arg out "$out" --argjson exit_code $exit_code --arg uuid "$FAKE_UUID" \
  '{case:"08-bad-resume", fake_uuid:$uuid, stdout_excerpt:($out|.[0:2048]), exit_code:$exit_code,
    notes:"合法 UUID 但不存在 session 的行为"}' \
  > case-08-bad-resume.result.json

echo "exit_code: $exit_code"
echo "$out" | head -5
