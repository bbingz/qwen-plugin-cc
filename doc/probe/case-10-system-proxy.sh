#!/usr/bin/env bash
# case 10: 清 HTTP_PROXY* env,看 qwen 能否跑通(本机 settings 有 proxy)
set -uo pipefail
cd "$(dirname "$0")"

# 清所有 proxy env
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy

out=$(qwen "reply pong" --output-format stream-json --max-session-turns 1 2>&1)
exit_code=$?

jq -n --arg stdout "$out" --argjson exit_code $exit_code \
  '{case:"10-system-proxy", stdout_excerpt:($stdout|.[0:2048]), exit_code:$exit_code,
    notes:"unset all proxy env; 观察 settings.proxy 是否被 qwen 读到"}' \
  > case-10-system-proxy.result.json

echo "exit_code: $exit_code"
echo "$out" | grep -oE '\[API Error:[^"]+' | head -1 || echo "(no API Error — proxy 从 settings 自动读)"
