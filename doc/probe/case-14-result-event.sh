#!/usr/bin/env bash
# Case 14: qwen CLI result event 原始 schema
# 目的:抓 stream-json 最后的 result event 结构,看是否有 stats.models
#       以及 input/output/thoughts token 字段,决定 v0.3 timing 方向。
set -uo pipefail
cd "$(dirname "$0")"

raw=$(qwen "reply with exactly: ready" \
  --output-format stream-json --max-session-turns 1 2>&1)
exit_code=$?

# 提取所有 JSON 行里 type==result 的那条
result_line=$(printf '%s\n' "$raw" | awk 'BEGIN{RS="\n"} /^\{/ {print}' | \
  jq -c 'select(.type=="result")' 2>/dev/null | head -1)

if [ -z "$result_line" ]; then
  result_line=$(printf '%s\n' "$raw" | grep -E '^\{.*"type":"result"' | head -1)
fi

keys=$(printf '%s' "$result_line" | jq -r 'paths(scalars) | map(tostring) | join(".")' 2>/dev/null | sort -u | paste -sd, -)

jq -n \
  --arg cmd 'qwen "reply with exactly: ready" --output-format stream-json --max-session-turns 1' \
  --arg raw "$raw" \
  --arg result "$result_line" \
  --arg keys "$keys" \
  --argjson exit_code "$exit_code" \
  '{case:"14-result-event",
    cmd:$cmd,
    exit_code:$exit_code,
    raw_tail:($raw|.[-2048:]),
    result_event:$result,
    scalar_key_paths:$keys}' \
  > case-14-result-event.result.json

echo "exit_code: $exit_code"
echo "--- result_event ---"
echo "$result_line"
echo "--- scalar key paths ---"
echo "$keys"
