#!/usr/bin/env bash
# macOS 无 timeout/gtimeout,用 node 内嵌 spawn + timeout
set -uo pipefail
cd "$(dirname "$0")"

out=$(node --input-type=module -e '
  import { spawn } from "node:child_process";
  const child = spawn("qwen", [
    "Count slowly from 1 to 10000, one number per line.",
    "--output-format", "stream-json",
    "--max-session-turns", "10"
  ]);
  let stdout = "", stderr = "";
  child.stdout.on("data", d => stdout += d);
  child.stderr.on("data", d => stderr += d);
  const to = setTimeout(() => child.kill("SIGTERM"), 3000);
  child.on("exit", (code, sig) => {
    clearTimeout(to);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exit(sig === "SIGTERM" ? 143 : (code ?? 0));
  });
' 2>&1)
exit_code=$?

jq -n --arg stdout "$out" --argjson exit_code $exit_code \
  '{case:"04-timeout", stdout_excerpt:($stdout|.[0:2048]), exit_code:$exit_code,
    notes:"Node spawn + SIGTERM after 3s;exit 143 = 128+15"}' \
  > case-04-timeout.result.json

echo "exit_code: $exit_code"
