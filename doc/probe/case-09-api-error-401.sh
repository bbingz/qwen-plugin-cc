#!/usr/bin/env bash
# case 09: 撤 token 抓 401 样本
# 本机 auth 走 BAILIAN_CODING_PLAN_API_KEY (写在 settings.json 的 env 字段),
# 临时覆盖 API key 为 invalid 就能触发 401。
set -uo pipefail
cd "$(dirname "$0")"

SETTINGS="$HOME/.qwen/settings.json"
BACKUP="$HOME/.qwen/settings.json.probe-bak-09"

# 备份
cp "$SETTINGS" "$BACKUP"

# 临时改 key 为 invalid
jq '.env.BAILIAN_CODING_PLAN_API_KEY = "sk-invalid-for-probe"' "$BACKUP" > "$SETTINGS"

# 跑
out=$(qwen "ping" --output-format stream-json --max-session-turns 1 2>&1 || true)
exit_code=$?

# 立即恢复
mv "$BACKUP" "$SETTINGS"

# 提取 [API Error: ...] 原文
error_text=$(echo "$out" | grep -oE '\[API Error:[^"]+' | head -1 || echo "")

jq -n --arg out "$out" --arg err "$error_text" --argjson ec $exit_code \
  '{case:"09-api-error-401",
    full_error_text:$err,
    exit_code:$ec,
    stdout_excerpt:($out|.[0:2048]),
    notes:"临时改 BAILIAN_CODING_PLAN_API_KEY=invalid 抓 401 原文。验证 classifyApiError 能否提 Status。"}' \
  > case-09-api-error-401.result.json

# 同时作为 case 02(认证过期)的 record
cp case-09-api-error-401.result.json case-02-auth-expired.result.json

echo "exit_code: $exit_code"
echo "error_text: $error_text"
