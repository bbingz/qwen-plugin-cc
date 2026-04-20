#!/usr/bin/env bash
# case 11: 关键决策 case — qwen --approval-mode auto-edit + 无 TTY + 要求跑 shell_command
set -uo pipefail
cd "$(dirname "$0")"

out=$(node --input-type=module -e '
  import { spawn } from "node:child_process";
  const child = spawn("qwen", [
    "Run the shell command: echo hello-from-qwen. Do not ask me, just run it.",
    "--approval-mode", "auto-edit",
    "--output-format", "stream-json",
    "--max-session-turns", "3"
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => stdout += d);
  child.stderr.on("data", d => stderr += d);
  const to = setTimeout(() => child.kill("SIGTERM"), 30000);
  child.on("exit", (code, sig) => {
    clearTimeout(to);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exit(sig === "SIGTERM" ? 143 : (code ?? 0));
  });
' 2>&1)
exit_code=$?

# 观察是否:a) 实际跑了(有 hello-from-qwen);b) 拒绝(refused/declined);c) hang(143)
has_echo_output=$(echo "$out" | grep -c 'hello-from-qwen' || true)
has_refusal=$(echo "$out" | grep -icE '(refuse|declin|not allow|permission)' || true)
has_tool_use=$(echo "$out" | grep -c '"tool_use"' || true)
has_permission_denial=$(echo "$out" | grep -c 'permission_denials' || true)

jq -n --arg out "$out" --argjson exit_code $exit_code \
      --argjson echo "$has_echo_output" \
      --argjson refuse "$has_refusal" \
      --argjson tool_use "$has_tool_use" \
      '{case:"11-auto-edit-notty", exit_code:$exit_code,
        stdout_excerpt:($out|.[0:6144]),
        observations: {
          has_echo_output: $echo,
          has_refusal: $refuse,
          has_tool_use_blocks: $tool_use
        },
        notes:"143=hang SIGTERM;0+echo=auto-approve;0+refuse=auto-deny"}' \
  > case-11-auto-edit-notty.result.json

echo "exit_code: $exit_code"
echo "has_echo_output: $has_echo_output"
echo "has_refusal: $has_refusal"
echo "has_tool_use_blocks: $has_tool_use"
