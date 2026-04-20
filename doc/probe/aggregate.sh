#!/usr/bin/env bash
# 聚合所有 case-*.result.json 到 probe-results.json
set -uo pipefail
cd "$(dirname "$0")"

qwen_ver=$(qwen --version 2>&1 | head -1)

jq -n \
  --arg captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg qwen_version "$qwen_ver" \
  '{captured_at:$captured_at, qwen_version:$qwen_version, cases:[]}' > probe-results.json

for f in case-*.result.json; do
  [[ ! -f "$f" ]] && continue
  jq --slurpfile c "$f" '.cases += $c' probe-results.json > probe-results.json.tmp
  mv probe-results.json.tmp probe-results.json
done

count=$(jq '.cases|length' probe-results.json)
echo "Aggregated $count cases into probe-results.json"
