#!/usr/bin/env bash
# case 13: 大 diff review,检查 silent fail / max_output_tokens
set -uo pipefail
cd "$(dirname "$0")"

DIFF=$(cat fixtures/large-diff.txt)

out=$(node --input-type=module -e '
  import { spawn } from "node:child_process";
  import fs from "node:fs";
  const diff = fs.readFileSync("fixtures/large-diff.txt", "utf8");
  const prompt = "Review this diff and output JSON {verdict, findings}.\n" + diff;
  const child = spawn("qwen", [prompt, "--output-format", "stream-json", "--max-session-turns", "1"]);
  let stdout = "", stderr = "";
  child.stdout.on("data", d => stdout += d);
  child.stderr.on("data", d => stderr += d);
  const to = setTimeout(() => child.kill("SIGTERM"), 120000);
  child.on("exit", (code, sig) => {
    clearTimeout(to);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exit(sig === "SIGTERM" ? 143 : (code ?? 0));
  });
' 2>&1)
exit_code=$?

# 提取最后一条 result 事件验 JSON 完整性
result_line=$(echo "$out" | grep '"type":"result"' | tail -1)

jq -n --arg out "$out" --arg result "$result_line" --argjson ec $exit_code \
  '{case:"13-large-diff",
    diff_size_kb: 377,
    stdout_head: ($out|.[0:1024]),
    stdout_tail: ($out|.[-2048:]),
    result_event_line: $result,
    exit_code: $ec,
    notes: "T14 基线;若 result 为完整 JSONL 行,OK;若被截断 → silent fail"}' \
  > case-13-large-diff.result.json

echo "exit_code: $exit_code"
echo "result line length: ${#result_line}"
if [ -n "$result_line" ]; then
  echo "result is valid JSON? $(echo "$result_line" | jq -e . > /dev/null 2>&1 && echo yes || echo no)"
fi
