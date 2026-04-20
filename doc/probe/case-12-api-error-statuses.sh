#!/usr/bin/env bash
# case 12: 多 Status 码样本,为 classifyApiError 状态码优先路径做基线
set -uo pipefail
cd "$(dirname "$0")"

# 12a: 用 openai mode 打到 httpstat.us/404
out_404=$(qwen "ping" \
  --openai-base-url "https://httpstat.us/404" \
  --openai-api-key "probe-fake-key" \
  --output-format stream-json --max-session-turns 1 2>&1 || true)

sleep 1

# 12b: 500
out_500=$(qwen "ping" \
  --openai-base-url "https://httpstat.us/500" \
  --openai-api-key "probe-fake-key" \
  --output-format stream-json --max-session-turns 1 2>&1 || true)

sleep 1

# 12c: 429 (rate limit)
out_429=$(qwen "ping" \
  --openai-base-url "https://httpstat.us/429" \
  --openai-api-key "probe-fake-key" \
  --output-format stream-json --max-session-turns 1 2>&1 || true)

sleep 1

# 12d: 401
out_401=$(qwen "ping" \
  --openai-base-url "https://httpstat.us/401" \
  --openai-api-key "probe-fake-key" \
  --output-format stream-json --max-session-turns 1 2>&1 || true)

jq -n \
  --arg o401 "$out_401" --arg o404 "$out_404" --arg o429 "$out_429" --arg o500 "$out_500" \
  '{case:"12-api-error-statuses",
    samples: {
      "401": ($o401|.[0:1500]),
      "404": ($o404|.[0:1500]),
      "429": ($o429|.[0:1500]),
      "500": ($o500|.[0:1500])
    },
    notes:"检查每条是否有 Status: NNN 字样"}' \
  > case-12-api-error-statuses.result.json

echo "=== 401 ==="; echo "$out_401" | grep -oE '\[API Error:[^"]{0,200}' | head -1
echo "=== 404 ==="; echo "$out_404" | grep -oE '\[API Error:[^"]{0,200}' | head -1
echo "=== 429 ==="; echo "$out_429" | grep -oE '\[API Error:[^"]{0,200}' | head -1
echo "=== 500 ==="; echo "$out_500" | grep -oE '\[API Error:[^"]{0,200}' | head -1
