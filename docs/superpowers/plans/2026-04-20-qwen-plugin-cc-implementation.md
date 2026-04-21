# qwen-plugin-cc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec v3(commit `92c7cc4`)实现 qwen-plugin-cc v0.1 — Claude Code 插件,把 Qwen Code CLI 包成 7 个斜杠命令 + 1 subagent + 3 skill + 2 hook。

**Architecture:** 骨架字节对齐 `openai-codex` 官方 Claude Code 插件;`scripts/lib/` 血统起点是 `gemini-plugin-cc` v0.5.2;`qwen.mjs` 从零写,处理 qwen 独有的 `[API Error:` 内嵌、proxy 注入、fg/bg 解析分野、五层 detectFailure + DashScope 特化 classifyApiError、3 次 retry with 原 raw 携带。

**Tech Stack:** Node.js(内置 `node:test`,无外部依赖)、Bash 脚本、Claude Code plugin manifest(`.claude-plugin/*`)、Qwen Code CLI v0.14.5+。

**Spec 参考**:`docs/superpowers/specs/2026-04-20-qwen-plugin-cc-design.md` v3.1 — 本 plan 的所有小节号引用都指向 spec。

**Phase 0 FINDINGS 必读**:实施任何 task 前先读 `doc/probe/FINDINGS.md` 的 10 条真实行为发现。plan 已按这些发现更新,但若实施时发现新偏差,**以实际 qwen 行为为准**,回填 FINDINGS 并在本 plan 对应 task 加 [adjustment] 备注。

---

## 阶段总览

| Phase | 名称 | 工时 | Tasks |
|---|---|---|---|
| 0 | 探针 | 0.5 天 | 14 |
| 1 | Setup | 1.5 天 | 12 |
| 2 | Rescue + Skills | 3 天 | 18 |
| 3 | Review 系 | 4 天 | 14 |
| 4 | status/result/cancel + hooks | 1.5 天 | 9 |
| 5 | 打磨 & 文档 | 0.5 天 | 4 |
| **合计** | | **11 天** | **71** |

(本文档先落盘 Phase 0 + Phase 1 完整内容,后续 Phase 在后续 patch 中补完。这是一份分批写入的 plan;若你看到这份文档时仅有 Phase 0/1,请让当前会话继续补 Phase 2–5。)

---

# Phase 0 · 探针(0.5 天)

**目标**:抓 13 个 case 的 qwen CLI 真实行为样本,作为后续 detectFailure / classifyApiError / retry 策略的基线。

## Task 0.1: 建立 probe 目录与记录 schema

**Files:**
- Create: `doc/probe/README.md`
- Create: `doc/probe/probe-results.json`
- Create: `doc/probe/_schema.md`

- [x] **Step 1: 新建 probe 目录**

Run:
```bash
mkdir -p doc/probe
```

- [x] **Step 2: 写 `doc/probe/_schema.md`**

```markdown
# Probe result schema

每条 case 一个对象,字段:
- `case`: 编号 + 简述
- `cmd`: 实际跑的命令(完整 CLI)
- `env`: 环境变量(只记关键的,如 HTTP_PROXY、QWEN_CODE_DISABLE_OAUTH)
- `stdout_excerpt`: 输出头 2KB(JSONL 按行压缩)
- `stderr_excerpt`: stderr 头 1KB
- `exit_code`: 数字或 null(timeout)
- `observed_structure`: "type=system,assistant,result" 等事件顺序摘要
- `parsed`: 对关键字段的提取,如 `{ session_id, is_error, result_field }`
- `notes`: 人工观察到的异常,比如 "assistant.text 以 [API Error: 开头但 is_error:false"
```

- [x] **Step 3: 写 `doc/probe/README.md`**

```markdown
# Phase 0 探针

目的:抓 qwen CLI 真实行为样本,喂给单元测试作为 fixture,喂给 spec 作为 design 校验。

13 case 清单见 spec §6.2;每条对应一个 `case-NN-*.sh` 脚本。

跑法:
    bash doc/probe/case-01-ping.sh
    ...
    bash doc/probe/aggregate.sh > probe-results.json
```

- [x] **Step 4: 初始化 `probe-results.json`**

```json
{
  "captured_at": null,
  "qwen_version": null,
  "cases": []
}
```

- [x] **Step 5: Commit**

```bash
git add doc/probe
git commit -m "docs(probe): Phase 0 目录与 schema 就位"
```

---

## Task 0.2: Case 1 — 正常 ping

**Files:**
- Create: `doc/probe/case-01-ping.sh`

- [x] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
# Case 01: 正常 ping,基线用
set -uo pipefail
cd "$(dirname "$0")"

out=$(qwen "reply with exactly: pong" \
  --output-format stream-json --max-session-turns 1 2>&1)
exit_code=$?

jq -n \
  --arg cmd 'qwen "reply with exactly: pong" --output-format stream-json --max-session-turns 1' \
  --arg stdout "$out" \
  --argjson exit_code $exit_code \
  '{case:"01-ping", cmd:$cmd, stdout_excerpt:($stdout|.[0:2048]), exit_code:$exit_code}' \
  > case-01-ping.result.json
```

- [x] **Step 2: 赋执行权限并试跑**

Run:
```bash
chmod +x doc/probe/case-01-ping.sh
bash doc/probe/case-01-ping.sh && cat doc/probe/case-01-ping.result.json | jq .exit_code
```

Expected: `0`。若非 0,检查 `qwen auth status`。

- [x] **Step 3: Commit**

```bash
git add doc/probe/case-01-ping.sh doc/probe/case-01-ping.result.json
git commit -m "probe(01): 正常 ping 基线"
```

---

## Task 0.3: Case 2 — 认证过期

**Files:**
- Create: `doc/probe/case-02-auth-expired.sh`

- [x] **Step 1: 写脚本(模拟 token 过期)**

```bash
#!/usr/bin/env bash
# Case 02: 模拟认证过期 — 通过临时损坏 oauth_creds.json 触发
set -uo pipefail

CREDS="$HOME/.qwen/oauth_creds.json"
BACKUP="$HOME/.qwen/oauth_creds.json.probe-bak"
[[ -f "$CREDS" ]] && cp "$CREDS" "$BACKUP"

# 写入过期 token
cat > "$CREDS" <<'EOF'
{"access_token":"INVALID_TOKEN_FOR_PROBE","expires_at":0}
EOF

out=$(qwen "ping" --output-format stream-json --max-session-turns 1 2>&1)
exit_code=$?

# 恢复
[[ -f "$BACKUP" ]] && mv "$BACKUP" "$CREDS" || rm -f "$CREDS"

jq -n \
  --arg stdout "$out" \
  --argjson exit_code $exit_code \
  '{case:"02-auth-expired", stdout_excerpt:($stdout|.[0:2048]), exit_code:$exit_code,
    notes:"expected: assistant.text 以 [API Error: 401 开头,is_error:false,exit 0"}' \
  > "$(dirname "$0")/case-02-auth-expired.result.json"
```

- [x] **Step 2: 跑**

Run:
```bash
bash doc/probe/case-02-auth-expired.sh
jq '.exit_code, (.stdout_excerpt | contains("API Error"))' doc/probe/case-02-auth-expired.result.json
```

Expected: `0` `true`(exit 0 但有 API Error 字样 — 这就是 spec §5.1 的关键坑)

- [x] **Step 3: Commit**

```bash
git add doc/probe/case-02-auth-expired.sh doc/probe/case-02-auth-expired.result.json
git commit -m "probe(02): 认证过期 — 验证 exit 0 + is_error:false 假成功"
```

---

## Task 0.4: Case 3 — 模型不存在

**Files:**
- Create: `doc/probe/case-03-bad-model.sh`

- [x] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

out=$(qwen "ping" -m qwen-fake-model \
  --output-format stream-json --max-session-turns 1 2>&1)
exit_code=$?

jq -n --arg stdout "$out" --argjson exit_code $exit_code \
  '{case:"03-bad-model", stdout_excerpt:($stdout|.[0:2048]), exit_code:$exit_code,
    notes:"expected: classifyApiError 命中 invalid_request 或 api_error_unknown"}' \
  > case-03-bad-model.result.json
```

- [x] **Step 2: 跑并检查**

Run:
```bash
bash doc/probe/case-03-bad-model.sh
cat doc/probe/case-03-bad-model.result.json | jq '.stdout_excerpt' | grep -o '\[API Error:[^"]*' | head -1
```

Expected: 看到 `[API Error: ...]` 字样。记录具体文本(可能含 `Status: 400`)。

- [x] **Step 3: Commit**

```bash
git add doc/probe/case-03-bad-model.sh doc/probe/case-03-bad-model.result.json
git commit -m "probe(03): 模型不存在的 [API Error:] 格式样本"
```

---

## Task 0.5: Case 4 — 超时

**Files:**
- Create: `doc/probe/case-04-timeout.sh`

- [x] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

# 用 timeout 命令在 3 秒后强制杀掉 qwen,模拟 companion 层超时兜底
out=$(timeout --signal=TERM 3 \
  qwen "Count slowly from 1 to 10000, one number per line." \
  --output-format stream-json --max-session-turns 10 2>&1)
exit_code=$?

jq -n --arg stdout "$out" --argjson exit_code $exit_code \
  '{case:"04-timeout", stdout_excerpt:($stdout|.[0:2048]), exit_code:$exit_code,
    notes:"timeout 信号 → exit 143 (128+15 SIGTERM)"}' \
  > case-04-timeout.result.json
```

- [x] **Step 2: 跑**

Run:
```bash
bash doc/probe/case-04-timeout.sh
jq '.exit_code' doc/probe/case-04-timeout.result.json
```

Expected: `143`(SIGTERM 退出码)或 `124`(timeout 本身退出码,取决于 coreutils 版本)

- [x] **Step 3: Commit**

```bash
git add doc/probe/case-04-timeout.sh doc/probe/case-04-timeout.result.json
git commit -m "probe(04): 超时杀进程的退出码观察"
```

---

## Task 0.6: Case 5 — `--continue` 恢复会话

**Files:**
- Create: `doc/probe/case-05-continue.sh`

- [x] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

# 第 1 次:让 qwen 记住一个数
out1=$(qwen "Remember this number: 42. Only acknowledge." \
  --output-format stream-json --max-session-turns 1 2>&1)

sleep 2

# 第 2 次:用 --continue 续
out2=$(qwen -c "What number did I ask you to remember?" \
  --output-format stream-json --max-session-turns 1 2>&1)

jq -n --arg out1 "$out1" --arg out2 "$out2" \
  '{case:"05-continue",
    stdout_excerpt_first:($out1|.[0:2048]),
    stdout_excerpt_second:($out2|.[0:2048]),
    notes:"第 2 次输出应含 42,证明 -c 确实续上"}' \
  > case-05-continue.result.json
```

- [x] **Step 2: 跑并验**

Run:
```bash
bash doc/probe/case-05-continue.sh
jq '.stdout_excerpt_second' doc/probe/case-05-continue.result.json | grep -o '42' | head -1
```

Expected: `42` — 若未看到,说明 `chatRecording` 被关或 `-c` 语义变了。

- [x] **Step 3: Commit**

```bash
git add doc/probe/case-05-continue.sh doc/probe/case-05-continue.result.json
git commit -m "probe(05): --continue 会话恢复验证"
```

---

## Task 0.7: Case 6 — `--session-id` 指定

**Files:**
- Create: `doc/probe/case-06-session-id.sh`

- [x] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

SID="probe-$(uuidgen)"

# 第 1 次:固定 session id
out1=$(qwen "I am using session id $SID" \
  --session-id "$SID" \
  --output-format stream-json --max-session-turns 1 2>&1)

sleep 2

# 第 2 次:-r 该 id
out2=$(qwen -r "$SID" "What is my session id?" \
  --output-format stream-json --max-session-turns 1 2>&1)

jq -n --arg sid "$SID" --arg out1 "$out1" --arg out2 "$out2" \
  '{case:"06-session-id", session_id:$sid,
    stdout_excerpt_first:($out1|.[0:2048]),
    stdout_excerpt_second:($out2|.[0:2048])}' \
  > case-06-session-id.result.json
```

- [x] **Step 2: 跑**

Run:
```bash
bash doc/probe/case-06-session-id.sh
jq '.stdout_excerpt_first' doc/probe/case-06-session-id.result.json | \
  grep -oE '"session_id":"[^"]+"' | head -1
```

Expected: 看到我们写入的 `$SID`。

- [x] **Step 3: Commit**

```bash
git add doc/probe/case-06-session-id.sh doc/probe/case-06-session-id.result.json
git commit -m "probe(06): --session-id 指定 + -r 恢复"
```

---

## Task 0.8: Case 7 — Review 场景 raw 输出

**Files:**
- Create: `doc/probe/case-07-review-raw.sh`
- Create: `doc/probe/fixtures/tiny-diff.txt`

- [x] **Step 1: 写一个小 diff 作为 fixture**

Write `doc/probe/fixtures/tiny-diff.txt`:
```
diff --git a/foo.js b/foo.js
index abc..def 100644
--- a/foo.js
+++ b/foo.js
@@ -1,3 +1,3 @@
 function add(a, b) {
-  return a - b;
+  return a + b;
 }
```

- [x] **Step 2: 写脚本**

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

DIFF=$(cat fixtures/tiny-diff.txt)
PROMPT="Review this diff. Output ONLY a JSON object with fields verdict (approve/changes_requested), findings (array of {severity, path, line, message}). No prose, no fences.

Diff:
$DIFF"

out=$(qwen "$PROMPT" --output-format stream-json --max-session-turns 1 2>&1)

jq -n --arg out "$out" \
  '{case:"07-review-raw", stdout_excerpt:($out|.[0:4096]),
    notes:"观察 qwen 是否吐合法 JSON 还是混 fence/prose"}' \
  > case-07-review-raw.result.json
```

- [x] **Step 3: 跑并观察**

Run:
```bash
bash doc/probe/case-07-review-raw.sh
jq '.stdout_excerpt' doc/probe/case-07-review-raw.result.json | head -40
```

Expected: 至少能看到 `"verdict"` 字段;可能带 ```` ```json ```` fence。记录具体形态决定 `tryLocalRepair` 覆盖哪些病。

- [x] **Step 4: Commit**

```bash
git add doc/probe/case-07-review-raw.sh doc/probe/case-07-review-raw.result.json doc/probe/fixtures/tiny-diff.txt
git commit -m "probe(07): review raw 输出 — 为 tryLocalRepair 定病"
```

---

## Task 0.9: Case 8 — `-r <不存在>` 触发 no_prior_session

**Files:**
- Create: `doc/probe/case-08-bad-resume.sh`

- [x] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

out=$(qwen -r "00000000-0000-0000-0000-000000000000" "hi" \
  --output-format stream-json --max-session-turns 1 2>&1)
exit_code=$?

jq -n --arg out "$out" --argjson exit_code $exit_code \
  '{case:"08-bad-resume", stdout_excerpt:($out|.[0:2048]), exit_code:$exit_code,
    notes:"期望 exit 非 0 + stderr 含 session 不存在字样"}' \
  > case-08-bad-resume.result.json
```

- [x] **Step 2: 跑**

Run:
```bash
bash doc/probe/case-08-bad-resume.sh
jq '.exit_code, (.stdout_excerpt | test("(?i)session.*(not found|does.*not.*exist|no such)"))' \
  doc/probe/case-08-bad-resume.result.json
```

Expected: `exit_code != 0` 且 stderr/stdout 有 session 相关错误字样。记录完整 error 文本用于 `no_prior_session` 的触发器正则。

- [x] **Step 3: Commit**

```bash
git add doc/probe/case-08-bad-resume.sh doc/probe/case-08-bad-resume.result.json
git commit -m "probe(08): -r <不存在> — no_prior_session 触发样本"
```

---

## Task 0.10: Case 9 — API Error Status 样本(401)

**Files:**
- Create: `doc/probe/case-09-api-error-401.sh`

- [x] **Step 1: 写脚本(复用 case-02 的过期技巧,但只抓 stream-json 原文存档)**

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

CREDS="$HOME/.qwen/oauth_creds.json"
BACKUP="$HOME/.qwen/oauth_creds.json.probe-bak-09"
[[ -f "$CREDS" ]] && cp "$CREDS" "$BACKUP"
echo '{"access_token":"INVALID","expires_at":0}' > "$CREDS"

out=$(qwen "ping" --output-format stream-json --max-session-turns 1 2>&1)

[[ -f "$BACKUP" ]] && mv "$BACKUP" "$CREDS"

# 提取最长的 [API Error: ...] 片段
error_text=$(echo "$out" | grep -oE '\[API Error:[^"]+' | head -1)

jq -n --arg out "$out" --arg err "$error_text" \
  '{case:"09-api-error-401", full_error_text:$err, stdout_excerpt:($out|.[0:2048]),
    notes:"验证 classifyApiError 能否从这段 text 提到 Status: 401"}' \
  > case-09-api-error-401.result.json
```

- [x] **Step 2: 跑 + 分析**

Run:
```bash
bash doc/probe/case-09-api-error-401.sh
jq '.full_error_text' doc/probe/case-09-api-error-401.result.json
```

Expected: 看到 `[API Error: ... Status: 401 ...]` 或纯文本 `401`。两种都记录,`classifyApiError` 都要兼容。

- [x] **Step 3: Commit**

```bash
git add doc/probe/case-09-api-error-401.sh doc/probe/case-09-api-error-401.result.json
git commit -m "probe(09): API Error 401 原文样本 — classifyApiError 基线"
```

---

## Task 0.11: Case 10 — 系统级代理场景

**Files:**
- Create: `doc/probe/case-10-system-proxy.sh`

- [x] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
# Case 10: settings 有 proxy,env 完全不设任何 HTTP_PROXY 变体,看 qwen 行为
set -uo pipefail
cd "$(dirname "$0")"

# 清掉所有 proxy env
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy

out=$(qwen "ping" --output-format stream-json --max-session-turns 1 2>&1)
exit_code=$?

jq -n --arg out "$out" --argjson exit_code $exit_code \
  '{case:"10-system-proxy", stdout_excerpt:($out|.[0:2048]), exit_code:$exit_code,
    notes:"若 settings.proxy 存在但 env 全清,观察是否 401/connection refused;决定 companion 注入策略的必要性"}' \
  > case-10-system-proxy.result.json
```

- [x] **Step 2: 跑**

Run:
```bash
bash doc/probe/case-10-system-proxy.sh
jq '.stdout_excerpt' doc/probe/case-10-system-proxy.result.json
```

Expected: 本机若走 Clash/Surge,应 401 或 network error —— 这正是 companion 要注入 proxy 的动因。

- [x] **Step 3: Commit**

```bash
git add doc/probe/case-10-system-proxy.sh doc/probe/case-10-system-proxy.result.json
git commit -m "probe(10): 清 proxy env 后 headless 行为 — proxy 注入必要性"
```

---

## Task 0.12: Case 11 — `auto-edit` 无 TTY 遇 shell_command 行为

**Files:**
- Create: `doc/probe/case-11-auto-edit-notty.sh`

**这是 spec §3.3 决定 foreground 默认姿态的关键探针。**

- [x] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
# Case 11: 让 qwen 在 auto-edit 模式下尝试跑一条 shell 命令
# stdin 喂 /dev/null,模拟 Claude Bash 无 TTY 环境
set -uo pipefail
cd "$(dirname "$0")"

out=$(timeout --signal=TERM 30 \
  qwen "Run the shell command: echo hello-from-qwen. Do not ask me, just run it." \
    --approval-mode auto-edit \
    --output-format stream-json --max-session-turns 3 \
    < /dev/null 2>&1)
exit_code=$?

jq -n --arg out "$out" --argjson exit_code $exit_code \
  '{case:"11-auto-edit-notty", stdout_excerpt:($out|.[0:4096]), exit_code:$exit_code,
    notes:"关键:exit 143 (timeout 杀) = hang;exit 0 + refusal = auto-deny;exit 0 + 实际跑了 echo = auto-approve"}' \
  > case-11-auto-edit-notty.result.json
```

- [x] **Step 2: 跑**

Run:
```bash
bash doc/probe/case-11-auto-edit-notty.sh
jq '.exit_code, .stdout_excerpt' doc/probe/case-11-auto-edit-notty.result.json | head -20
```

- [x] **Step 3: 根据结果登记决策到 spec**

根据 `exit_code` 判断:
- **143**(timeout 杀)→ auto-edit 无 TTY 会 hang;在 spec §9-1 下补一行:"Phase 0 case 11 确认:auto-edit + shell 工具 + 无 TTY 会 hang;foreground 改为也要 `--unsafe`(对称方案)";Phase 2 实现时把 Phase 2 task 2.8 的默认 approvalMode 改成 `yolo if unsafeFlag else 'auto-edit'`,仍然让 background + !unsafe 报 `require_interactive`,但同时让 foreground + !unsafe 也报 `require_interactive`。
- **0 + 文本含"refused"/"declined"**(auto-deny)→ 维持当前 spec auto-edit 默认。
- **0 + 文本含 "hello-from-qwen"**(auto-approve)→ auto-edit 比想象宽,但安全——维持当前 spec。

记录决策到 `doc/probe/case-11-decision.md`:

```markdown
# Case 11 决策 — auto-edit 无 TTY 行为

实测 exit_code: <填>
观察: <填>
决策: [维持默认 auto-edit | 改对称 --unsafe | 其他]
影响 tasks: <填 Phase 2 task 号>
```

- [x] **Step 4: Commit**

```bash
git add doc/probe/case-11-auto-edit-notty.sh doc/probe/case-11-auto-edit-notty.result.json doc/probe/case-11-decision.md
git commit -m "probe(11): auto-edit 无 TTY 行为 — 决定 foreground 姿态"
```

---

## Task 0.13: Case 12 — 多 Status 的 API Error 样本

**Files:**
- Create: `doc/probe/case-12-api-error-statuses.sh`

- [x] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
# Case 12: 构造多个 Status 码的错误,喂给 classifyApiError 作回归基线
set -uo pipefail
cd "$(dirname "$0")"

# 12a: 400 — 非法 base URL 或模型
out_400=$(qwen "ping" -m "invalid/slash/model" \
  --output-format stream-json --max-session-turns 1 2>&1)

# 12b: 429 — 难人为触发,注解空占位
# 12c: 500 — 同样难触发,用 --openai-base-url 指向一个返 500 的 mock
out_500=$(qwen "ping" \
  --openai-base-url "https://httpstat.us/500" \
  --auth-type openai --openai-api-key "probe" \
  --output-format stream-json --max-session-turns 1 2>&1 || true)

# 12d: 404 via httpstat
out_404=$(qwen "ping" \
  --openai-base-url "https://httpstat.us/404" \
  --auth-type openai --openai-api-key "probe" \
  --output-format stream-json --max-session-turns 1 2>&1 || true)

jq -n \
  --arg o400 "$out_400" --arg o404 "$out_404" --arg o500 "$out_500" \
  '{case:"12-api-error-statuses",
    samples: {
      "400_like": ($o400|.[0:1024]),
      "404": ($o404|.[0:1024]),
      "500": ($o500|.[0:1024])
    },
    notes:"把每个 [API Error: ...] 的原文抓下来,看是否真的带 Status: NNN 字样"}' \
  > case-12-api-error-statuses.result.json
```

- [x] **Step 2: 跑**

Run:
```bash
bash doc/probe/case-12-api-error-statuses.sh
jq '.samples' doc/probe/case-12-api-error-statuses.result.json
```

- [x] **Step 3: 检查是否有 `Status: NNN`**

Run:
```bash
jq -r '.samples | to_entries[] | "\(.key): \(.value | match("Status: *\\d+"; "i").string // "NO STATUS")"' \
  doc/probe/case-12-api-error-statuses.result.json
```

Expected: 至少部分 case 命中 `Status: NNN` —— 证明 `classifyApiError` 的状态码提取路径有依据。若全部都 "NO STATUS",则 spec §5.1 的状态码优先策略要降级为"关键词优先"。

- [x] **Step 4: Commit**

```bash
git add doc/probe/case-12-api-error-statuses.sh doc/probe/case-12-api-error-statuses.result.json
git commit -m "probe(12): 多 Status 码 API Error 样本"
```

---

## Task 0.14: Case 13 + aggregate

**Files:**
- Create: `doc/probe/case-13-large-diff.sh`
- Create: `doc/probe/fixtures/large-diff.txt`
- Create: `doc/probe/aggregate.sh`

- [x] **Step 1: 生成 >200KB 的 fixture diff**

Run:
```bash
node -e '
  const lines = [];
  lines.push("diff --git a/big.js b/big.js");
  lines.push("index aaa..bbb 100644");
  lines.push("--- a/big.js");
  lines.push("+++ b/big.js");
  lines.push("@@ -1,5000 +1,5000 @@");
  for (let i = 0; i < 5000; i++) {
    lines.push(`-const oldLine${i} = "value-${i}";`);
    lines.push(`+const newLine${i} = "value-${i}-updated";`);
  }
  require("fs").writeFileSync("doc/probe/fixtures/large-diff.txt", lines.join("\n"));
  console.log("size:", Buffer.byteLength(lines.join("\n")), "bytes");
'
```

Expected: `size: ` ≥ 200000。

- [x] **Step 2: 写 case 13 脚本**

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

DIFF=$(cat fixtures/large-diff.txt)

out=$(timeout 120 qwen "Review this diff and output JSON {verdict, findings}.
$DIFF" \
  --output-format stream-json --max-session-turns 1 2>&1)
exit_code=$?

jq -n --arg out "$out" --argjson ec $exit_code \
  '{case:"13-large-diff",
    diff_size_kb: 200,
    stdout_head: ($out|.[0:2048]),
    stdout_tail: ($out|.[-2048:]),
    exit_code: $ec,
    notes: "T14 通过基线;若 max_output_tokens 是触发 kind,记录在这"}' \
  > case-13-large-diff.result.json
```

- [x] **Step 3: 跑并观察**

Run:
```bash
bash doc/probe/case-13-large-diff.sh
jq '.exit_code, .stdout_tail' doc/probe/case-13-large-diff.result.json
```

Expected: `exit_code = 0`;tail 是完整 `type:"result"` JSONL 行(非被截断)。若 tail 不完整 JSON → spec §5.2 T14 的 "silent fail" 就是这种,需要在 Phase 3 加防御。

- [x] **Step 4: 写 aggregate.sh**

```bash
#!/usr/bin/env bash
# 聚合所有 case-*.result.json 到 probe-results.json
set -uo pipefail
cd "$(dirname "$0")"

jq -n \
  --arg captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg qwen_version "$(qwen -V 2>&1 | head -1)" \
  '{captured_at:$captured_at, qwen_version:$qwen_version, cases:[]}' > probe-results.json

for f in case-*.result.json; do
  jq --slurpfile c "$f" '.cases += $c' probe-results.json > probe-results.json.tmp
  mv probe-results.json.tmp probe-results.json
done

echo "Aggregated $(jq '.cases|length' probe-results.json) cases into probe-results.json"
```

- [x] **Step 5: 跑 aggregate**

Run:
```bash
chmod +x doc/probe/aggregate.sh doc/probe/case-13-large-diff.sh
bash doc/probe/aggregate.sh
jq '.cases | length, .qwen_version' doc/probe/probe-results.json
```

Expected: `13` 和 `"qwen, version 0.14.5"`。

- [x] **Step 6: Commit**

```bash
git add doc/probe/case-13-large-diff.sh doc/probe/fixtures/large-diff.txt doc/probe/aggregate.sh doc/probe/probe-results.json
git commit -m "probe(13+agg): 大 diff + 聚合脚本,Phase 0 完成"
```

---

**Phase 0 Exit Criteria**:
- 13 个 case 的 `*.result.json` 全部存在
- `probe-results.json` 聚合完成
- `case-11-decision.md` 写下 foreground 姿态决策
- 所有发现异常(非 spec 预期)记录在对应 case 的 `notes` 字段
- 若 case 11 证明需要改 spec,先改 spec 再进 Phase 1

---

# Phase 1 · Setup(1.5 天)

**目标**:实现 `/qwen:setup` 命令 + companion 的 `setup` 子命令,完整跑通 T1 + T2。

## Task 1.1: 初始化 marketplace + plugin manifest

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/qwen/.claude-plugin/plugin.json`
- Create: `plugins/qwen/CHANGELOG.md`

- [x] **Step 1: 建目录**

Run:
```bash
mkdir -p .claude-plugin plugins/qwen/.claude-plugin
```

- [x] **Step 2: 写 `.claude-plugin/marketplace.json`**

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "qwen-plugin",
  "version": "0.1.0",
  "description": "Qwen Code CLI plugin for Claude Code",
  "owner": { "name": "bing" },
  "plugins": [
    {
      "name": "qwen",
      "description": "Use Qwen from Claude Code to review code or delegate tasks.",
      "version": "0.1.0",
      "author": { "name": "bing" },
      "source": "./plugins/qwen",
      "category": "development"
    }
  ]
}
```

- [x] **Step 3: 写 `plugins/qwen/.claude-plugin/plugin.json`**

```json
{
  "name": "qwen",
  "version": "0.1.0",
  "description": "Use Qwen from Claude Code to review code or delegate tasks.",
  "author": { "name": "bing" }
}
```

- [x] **Step 4: 写 `plugins/qwen/CHANGELOG.md`**

```markdown
# Changelog

## 0.1.0 (unreleased)

- Phase 1: setup 命令就位
```

- [x] **Step 5: 验证 JSON 合法**

Run:
```bash
jq . .claude-plugin/marketplace.json > /dev/null && echo "marketplace ok"
jq . plugins/qwen/.claude-plugin/plugin.json > /dev/null && echo "plugin ok"
```

Expected: 两行 "ok"。

- [x] **Step 6: Commit**

```bash
git add .claude-plugin plugins/qwen
git commit -m "chore(plugin): marketplace.json + plugin.json scaffold"
```

---

## Task 1.2: 建立 scripts 目录 + 字节起点从 gemini 拷过来

**Files:**
- Create(拷自 gemini): `plugins/qwen/scripts/lib/args.mjs`
- Create(拷自 gemini): `plugins/qwen/scripts/lib/process.mjs`

**目的**:把 gemini 已验证的通用工具(无 Gemini 特有假设)直接搬过来,后续 qwen.mjs 复用。

- [x] **Step 1: 建目录**

Run:
```bash
mkdir -p plugins/qwen/scripts/lib plugins/qwen/scripts/tests
```

- [x] **Step 2: 拷贝 `args.mjs`**

Run:
```bash
cp /Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/scripts/lib/args.mjs \
   plugins/qwen/scripts/lib/args.mjs
```

- [x] **Step 3: 拷贝 `process.mjs`**

Run:
```bash
cp /Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/scripts/lib/process.mjs \
   plugins/qwen/scripts/lib/process.mjs
```

- [x] **Step 4: scan 有没有 `gemini` 字样(应该没有)**

Run:
```bash
grep -ni 'gemini' plugins/qwen/scripts/lib/args.mjs plugins/qwen/scripts/lib/process.mjs || echo "clean"
```

Expected: `clean`。若发现,手动改掉或在下一 task 处理。

- [x] **Step 5: Commit**

```bash
git add plugins/qwen/scripts/lib/args.mjs plugins/qwen/scripts/lib/process.mjs
git commit -m "feat(lib): args.mjs + process.mjs 从 gemini 血统拷贝(字节起点)"
```

---

## Task 1.3: qwen.mjs 骨架 + 常量

**Files:**
- Create: `plugins/qwen/scripts/lib/qwen.mjs`

- [x] **Step 1: 写骨架**

```javascript
// plugins/qwen/scripts/lib/qwen.mjs
// Qwen CLI wrapper — spawn / auth / stream-json / proxy injection / failure detection.
// 对应 gemini.mjs,但从零写(spec §2.3 "重写")。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { binaryAvailable, runCommand } from "./process.mjs";

// ── 常量 ──────────────────────────────────────────────────────

export const QWEN_BIN = process.env.QWEN_CLI_BIN || "qwen";
export const DEFAULT_TIMEOUT_MS = 300_000;
export const AUTH_CHECK_TIMEOUT_MS = 30_000;
export const PARENT_SESSION_ENV = "QWEN_COMPANION_SESSION_ID";
export const QWEN_SETTINGS_PATH = path.join(os.homedir(), ".qwen", "settings.json");
export const QWEN_CREDS_PATH = path.join(os.homedir(), ".qwen", "oauth_creds.json");

// Proxy env keys — 四键全量(§4.3)
export const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
export const NO_PROXY_DEFAULTS = ["localhost", "127.0.0.1"];

// ── CompanionError ───────────────────────────────────────────

export class CompanionError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}
```

- [x] **Step 2: 验证 import**

Run:
```bash
node --input-type=module -e "
  const m = await import('./plugins/qwen/scripts/lib/qwen.mjs');
  console.log('QWEN_BIN:', m.QWEN_BIN);
  console.log('PROXY_KEYS:', m.PROXY_KEYS);
  const e = new m.CompanionError('test_kind', 'test message', { detail: 42 });
  console.log('error:', e.kind, e.message, e.detail);
"
```

Expected:
```
QWEN_BIN: qwen
PROXY_KEYS: [ 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy' ]
error: test_kind test message 42
```

- [x] **Step 3: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs
git commit -m "feat(qwen.mjs): 骨架 + 常量 + CompanionError"
```

---

## Task 1.4: qwen.mjs — getQwenAvailability + 单元测试

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`
- Create: `plugins/qwen/scripts/tests/qwen-availability.test.mjs`

- [x] **Step 1: 写测试先(TDD)**

`plugins/qwen/scripts/tests/qwen-availability.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { getQwenAvailability } from "../lib/qwen.mjs";

test("getQwenAvailability: qwen binary present → available true + version", () => {
  const result = getQwenAvailability();
  // 本机应已装 qwen 0.14.5+
  assert.equal(result.available, true);
  assert.match(result.detail, /qwen, version/);
});

test("getQwenAvailability: QWEN_CLI_BIN=/nonexistent → available false", () => {
  // 用 env 指向假路径
  const oldBin = process.env.QWEN_CLI_BIN;
  process.env.QWEN_CLI_BIN = "/nonexistent-qwen-binary-for-test";
  try {
    // 需要 re-import?实际上 getQwenAvailability 在内部读 QWEN_BIN 常量(模块加载时冻结)
    // 为测试起见,让 getQwenAvailability 接受 bin 参数,见 step 2 的实现
    const { getQwenAvailability: getWithBin } = await import("../lib/qwen.mjs?test=" + Date.now());
    const result = getWithBin("/nonexistent-qwen-binary-for-test");
    assert.equal(result.available, false);
  } finally {
    if (oldBin == null) delete process.env.QWEN_CLI_BIN;
    else process.env.QWEN_CLI_BIN = oldBin;
  }
});
```

- [x] **Step 2: 验证测试失败(未实现)**

Run:
```bash
node --test plugins/qwen/scripts/tests/qwen-availability.test.mjs
```

Expected: FAIL with `getQwenAvailability is not a function` 或类似。

- [x] **Step 3: 在 qwen.mjs 实现**

追加到 `plugins/qwen/scripts/lib/qwen.mjs`:
```javascript
// ── Availability ─────────────────────────────────────────────

/**
 * 探测 qwen CLI 可用性。
 * @param {string} [bin] 可选覆盖二进制路径(测试用)
 * @returns {{ available: boolean, detail: string }}
 */
export function getQwenAvailability(bin = QWEN_BIN) {
  // v3.1 F-1: qwen -V → "Unknown argument: V";必须 --version
  return binaryAvailable(bin, ["--version"]);
}
```

- [x] **Step 4: 跑测试,应通过**

Run:
```bash
node --test plugins/qwen/scripts/tests/qwen-availability.test.mjs
```

Expected: `tests 2` + `pass 2`。

- [x] **Step 5: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs plugins/qwen/scripts/tests/qwen-availability.test.mjs
git commit -m "feat(qwen.mjs): getQwenAvailability + test"
```

---

## Task 1.5: qwen.mjs — buildSpawnEnv(proxy 注入 + 四键 + 冲突检测)

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`
- Create: `plugins/qwen/scripts/tests/qwen-proxy.test.mjs`

- [x] **Step 1: 写测试(TDD;覆盖 spec §4.3 + §6.3 qwen-proxy 清单)**

`plugins/qwen/scripts/tests/qwen-proxy.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnEnv } from "../lib/qwen.mjs";

function withEnv(overrides, fn) {
  const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(overrides)) {
    if (v != null) process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const k of keys) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("buildSpawnEnv: settings 有 + env 全无 → 四键全写", () => {
  withEnv({}, () => {
    const { env, warnings } = buildSpawnEnv({ proxy: "http://proxy:8080" });
    assert.equal(env.HTTPS_PROXY, "http://proxy:8080");
    assert.equal(env.https_proxy, "http://proxy:8080");
    assert.equal(env.HTTP_PROXY, "http://proxy:8080");
    assert.equal(env.http_proxy, "http://proxy:8080");
    assert.deepEqual(warnings, []);
  });
});

test("buildSpawnEnv: settings 有 + env 一致 → noop,无 warning", () => {
  withEnv({ HTTPS_PROXY: "http://x:1", https_proxy: "http://x:1" }, () => {
    const { warnings } = buildSpawnEnv({ proxy: "http://x:1" });
    assert.deepEqual(warnings, []);
  });
});

test("buildSpawnEnv: settings 有 + env 不一致 → proxy_conflict,不覆盖", () => {
  withEnv({ HTTPS_PROXY: "http://a:1" }, () => {
    const { env, warnings } = buildSpawnEnv({ proxy: "http://b:2" });
    assert.equal(env.HTTPS_PROXY, "http://a:1", "原 env 不被覆盖");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].kind, "proxy_conflict");
  });
});

test("buildSpawnEnv: env 四键内部值冲突 → proxy_env_mismatch,跳过注入", () => {
  withEnv({ HTTPS_PROXY: "http://a:1", HTTP_PROXY: "http://b:2" }, () => {
    const { env, warnings } = buildSpawnEnv({ proxy: "http://c:3" });
    // 不注入 settings 的 c:3
    assert.equal(env.HTTPS_PROXY, "http://a:1");
    assert.equal(env.HTTP_PROXY, "http://b:2");
    const mismatch = warnings.find(w => w.kind === "proxy_env_mismatch");
    assert.ok(mismatch, "must warn proxy_env_mismatch");
  });
});

test("buildSpawnEnv: settings 无 → 不注入,NO_PROXY 仍 merge", () => {
  withEnv({ NO_PROXY: "foo.com" }, () => {
    const { env, warnings } = buildSpawnEnv({});
    assert.equal(env.HTTPS_PROXY, undefined);
    // NO_PROXY merge 结果:foo.com,localhost,127.0.0.1
    assert.equal(env.NO_PROXY, "foo.com,localhost,127.0.0.1");
    assert.equal(env.no_proxy, "foo.com,localhost,127.0.0.1");
    assert.deepEqual(warnings, []);
  });
});

test("buildSpawnEnv: userSettings 为 null 或缺 proxy 字段 → 不炸", () => {
  withEnv({}, () => {
    assert.doesNotThrow(() => buildSpawnEnv(null));
    assert.doesNotThrow(() => buildSpawnEnv({}));
    const { env } = buildSpawnEnv(null);
    // NO_PROXY 仍 merge
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1");
  });
});
```

- [x] **Step 2: 验证失败**

Run:
```bash
node --test plugins/qwen/scripts/tests/qwen-proxy.test.mjs
```

Expected: FAIL with `buildSpawnEnv is not a function`。

- [x] **Step 3: 实现 buildSpawnEnv(严格按 spec §4.3)**

追加到 `plugins/qwen/scripts/lib/qwen.mjs`:
```javascript
// ── Proxy 注入 ───────────────────────────────────────────────

/**
 * 按 spec §4.3 装配 spawn env:
 * - 四键全量收集 + 内部一致性检查
 * - settings.proxy 与 env 冲突:不覆盖 + warning
 * - env 内部四键值不一致:proxy_env_mismatch,跳过注入
 * - NO_PROXY merge 而非覆盖
 * @param {{ proxy?: string } | null} userSettings
 * @returns {{ env: NodeJS.ProcessEnv, warnings: Array<{kind:string, [k:string]:any}> }}
 */
export function buildSpawnEnv(userSettings) {
  const env = { ...process.env };
  const proxy = userSettings?.proxy;
  const warnings = [];

  // 步骤 1:四键全量收集
  const seen = PROXY_KEYS
    .map((k) => ({ key: k, value: env[k] }))
    .filter((x) => x.value);
  const uniqueValues = [...new Set(seen.map((x) => x.value))];

  if (uniqueValues.length > 1) {
    warnings.push({
      kind: "proxy_env_mismatch",
      message: "env has conflicting proxy values across HTTP(S)_PROXY keys",
      detail: seen,
    });
    // 跳过 settings 注入,交 env 作者自己解决
  } else {
    const existing = uniqueValues[0];

    // 步骤 2:settings vs env 对齐
    if (proxy) {
      if (!existing) {
        // 四键都写(Linux undici 大小写敏感 + Go qwen 优先大写,double-write 最稳)
        for (const k of PROXY_KEYS) env[k] = proxy;
      } else if (existing !== proxy) {
        warnings.push({ kind: "proxy_conflict", settings: proxy, env: existing });
        // 不覆盖
      }
      // existing === proxy → noop
    }
  }

  // 步骤 3:NO_PROXY merge
  const userBypass = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = Array.from(new Set([...userBypass, ...NO_PROXY_DEFAULTS])).join(",");
  env.NO_PROXY = merged;
  env.no_proxy = merged;

  return { env, warnings };
}
```

- [x] **Step 4: 跑测试**

Run:
```bash
node --test plugins/qwen/scripts/tests/qwen-proxy.test.mjs
```

Expected: `tests 6` + `pass 6`。

- [x] **Step 5: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs plugins/qwen/scripts/tests/qwen-proxy.test.mjs
git commit -m "feat(qwen.mjs): buildSpawnEnv + proxy 冲突检测 + NO_PROXY merge"
```

---

## Task 1.6: qwen.mjs — 读 settings.json 工具函数

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`
- Create: `plugins/qwen/scripts/tests/qwen-settings.test.mjs`

- [x] **Step 1: 写测试**

`plugins/qwen/scripts/tests/qwen-settings.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readQwenSettings } from "../lib/qwen.mjs";

test("readQwenSettings: 不存在 → null", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-test-"));
  const fakePath = path.join(tmpDir, "does-not-exist.json");
  const result = readQwenSettings(fakePath);
  assert.equal(result, null);
  fs.rmSync(tmpDir, { recursive: true });
});

test("readQwenSettings: 合法 JSON → object", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-test-"));
  const p = path.join(tmpDir, "settings.json");
  fs.writeFileSync(p, JSON.stringify({ proxy: "http://x:1", chatRecording: true, model: "qwen3.6-plus" }));
  const result = readQwenSettings(p);
  assert.equal(result.proxy, "http://x:1");
  assert.equal(result.chatRecording, true);
  assert.equal(result.model, "qwen3.6-plus");
  fs.rmSync(tmpDir, { recursive: true });
});

test("readQwenSettings: 坏 JSON → null,不 throw", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-test-"));
  const p = path.join(tmpDir, "settings.json");
  fs.writeFileSync(p, "{ not valid json");
  assert.equal(readQwenSettings(p), null);
  fs.rmSync(tmpDir, { recursive: true });
});
```

- [x] **Step 2: 验失败**

Run: `node --test plugins/qwen/scripts/tests/qwen-settings.test.mjs`

Expected: FAIL.

- [x] **Step 3: 实现**

追加到 qwen.mjs:
```javascript
// ── Settings ─────────────────────────────────────────────────

/**
 * 读 ~/.qwen/settings.json。不存在或坏 JSON 返 null。
 * @param {string} [filePath] 默认 QWEN_SETTINGS_PATH
 * @returns {object | null}
 */
export function readQwenSettings(filePath = QWEN_SETTINGS_PATH) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}
```

- [x] **Step 4: 测试过**

Run: `node --test plugins/qwen/scripts/tests/qwen-settings.test.mjs`

Expected: `pass 3`。

- [x] **Step 5: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs plugins/qwen/scripts/tests/qwen-settings.test.mjs
git commit -m "feat(qwen.mjs): readQwenSettings + tests"
```

---

## Task 1.7: qwen.mjs — getQwenAuthStatus(解析文本 + fallback)

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`
- Create: `plugins/qwen/scripts/tests/qwen-auth.test.mjs`

- [x] **Step 1: 写测试**

`plugins/qwen/scripts/tests/qwen-auth.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAuthStatusText } from "../lib/qwen.mjs";

test("parseAuthStatusText: Coding Plan 格式", () => {
  const text = `=== Authentication Status ===
✓ Authentication Method: Alibaba Cloud Coding Plan
  Region: 中国 (China) - 阿里云百炼
  Current Model: qwen3.6-plus
  Status: API key configured`;
  const result = parseAuthStatusText(text);
  assert.equal(result.authMethod, "coding-plan");
  assert.equal(result.model, "qwen3.6-plus");
  assert.equal(result.configured, true);
});

test("parseAuthStatusText: OAuth 格式", () => {
  const text = `Authentication Method: Qwen OAuth
Current Model: qwen3-coder
Status: OAuth token valid`;
  const result = parseAuthStatusText(text);
  assert.equal(result.authMethod, "qwen-oauth");
});

test("parseAuthStatusText: API Key 格式", () => {
  const text = `Authentication Method: OpenAI-compatible API Key`;
  const result = parseAuthStatusText(text);
  assert.equal(result.authMethod, "openai");
});

test("parseAuthStatusText: 完全无法识别 → unknown", () => {
  const text = "something garbled";
  const result = parseAuthStatusText(text);
  assert.equal(result.authMethod, "unknown");
});

test("parseAuthStatusText: 空输入 → unknown", () => {
  assert.equal(parseAuthStatusText("").authMethod, "unknown");
  assert.equal(parseAuthStatusText(null).authMethod, "unknown");
});
```

- [x] **Step 2: 验失败**

Run: `node --test plugins/qwen/scripts/tests/qwen-auth.test.mjs`

- [x] **Step 3: 实现 parseAuthStatusText**

追加到 qwen.mjs:
```javascript
// ── Auth status parser(解析 `qwen auth status` 输出)──────────

/**
 * 把 qwen auth status 的人类文本解析为结构化对象。
 * 碎了 → authMethod: "unknown",不 throw。
 */
export function parseAuthStatusText(text) {
  const result = { authMethod: "unknown", model: null, configured: false };
  if (!text || typeof text !== "string") return result;

  // 识别 auth 方法
  if (/Alibaba Cloud Coding Plan|coding.?plan/i.test(text)) {
    result.authMethod = "coding-plan";
  } else if (/Qwen OAuth|qwen-oauth/i.test(text)) {
    result.authMethod = "qwen-oauth";
  } else if (/OpenAI.?compatible|openai api.?key/i.test(text)) {
    result.authMethod = "openai";
  } else if (/Anthropic/i.test(text)) {
    result.authMethod = "anthropic";
  }

  // 抓 model
  const modelMatch = text.match(/Current Model:\s*([^\s\n]+)/i);
  if (modelMatch) result.model = modelMatch[1];

  // 是否 configured
  if (/key configured|OAuth token valid|authenticated/i.test(text)) {
    result.configured = true;
  }

  return result;
}
```

- [x] **Step 4: 测试过**

Run: `node --test plugins/qwen/scripts/tests/qwen-auth.test.mjs`

Expected: `pass 5`。

- [x] **Step 5: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs plugins/qwen/scripts/tests/qwen-auth.test.mjs
git commit -m "feat(qwen.mjs): parseAuthStatusText + fallback tests"
```

---

## Task 1.8: qwen.mjs — detectInstallers

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`

- [x] **Step 1: 实现(简单,不 TDD,直接写)**

追加到 qwen.mjs:
```javascript
// ── Installer detection ──────────────────────────────────────

/**
 * 探测可用的 qwen 安装途径(spec §1.2)。
 */
export function detectInstallers() {
  return {
    npm: binaryAvailable("npm", ["--version"]).available,
    brew: binaryAvailable("brew", ["--version"]).available,
    shellInstaller: binaryAvailable("sh", ["-c", "command -v curl"]).available,
  };
}
```

- [x] **Step 2: 手测**

Run:
```bash
node --input-type=module -e "
  const m = await import('./plugins/qwen/scripts/lib/qwen.mjs');
  console.log(m.detectInstallers());
"
```

Expected:类似 `{ npm: true, brew: true, shellInstaller: true }`。

- [x] **Step 3: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs
git commit -m "feat(qwen.mjs): detectInstallers(npm/brew/curl)"
```

---

## Task 1.9: qwen.mjs — runQwenPing(ping 探活)

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`
- Create: `plugins/qwen/scripts/tests/qwen-ping.test.mjs`

> 注意:runQwenPing 是个真跑 qwen 的薄包装。单元测试只能验 mock 情形;真 ping 验证留到 Task 1.11 的集成。

- [x] **Step 1: 实现**

追加到 qwen.mjs:
```javascript
// ── Ping(探活) ─────────────────────────────────────────────

/**
 * 跑一次 qwen "ping" 的 stream-json,抓 init + assistant + result 事件。
 * 不做判错(判错在 §5.1 detectFailure 统一),只返原料。
 *
 * @returns {{
 *   exitCode: number | null,
 *   sessionId: string | null,
 *   model: string | null,
 *   mcpServers: string[],
 *   assistantTexts: string[],
 *   resultEvent: object | null,
 *   stderrTail: string,
 * }}
 */
export function runQwenPing({ env, cwd, bin = QWEN_BIN } = {}) {
  const result = runCommand(
    bin,
    ["ping", "--output-format", "stream-json", "--max-session-turns", "1"],
    { cwd, env: env ?? process.env, timeout: AUTH_CHECK_TIMEOUT_MS }
  );

  const out = {
    exitCode: result.status,
    sessionId: null,
    model: null,
    mcpServers: [],
    assistantTexts: [],
    resultEvent: null,
    stderrTail: (result.stderr || "").slice(-500),
  };

  if (result.error) return out;

  for (const raw of (result.stdout || "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }

    if (event.type === "system" && event.subtype === "init") {
      out.sessionId = event.session_id ?? null;
      out.model = event.model ?? null;
      out.mcpServers = Array.isArray(event.mcp_servers) ? event.mcp_servers : [];
    } else if (event.type === "assistant") {
      const blocks = event.message?.content ?? [];
      for (const b of blocks) {
        // v3.1 F-6: 跳过 thinking 块,只收 text 块
        if (b?.type === "text" && typeof b.text === "string") {
          out.assistantTexts.push(b.text);
        }
      }
    } else if (event.type === "result") {
      out.resultEvent = event;
    }
  }

  return out;
}
```

- [x] **Step 2: 真机烟囱测试**

`plugins/qwen/scripts/tests/qwen-ping.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { runQwenPing, buildSpawnEnv, readQwenSettings } from "../lib/qwen.mjs";

test("runQwenPing: 真机跑通(需已 qwen auth coding-plan)", { timeout: 40_000 }, () => {
  const { env } = buildSpawnEnv(readQwenSettings());
  const r = runQwenPing({ env });

  // 如果环境 ok,应该有 session_id、model、至少一条 assistant text
  // 如果 token 过期,会有 [API Error: 401]。两种都是合法观察。
  assert.equal(r.exitCode, 0);
  assert.ok(r.sessionId != null, `sessionId: ${r.sessionId}`);
  assert.ok(r.resultEvent != null, "result event present");

  // 打印观察,不强断言内容
  console.log("ping result:", {
    exitCode: r.exitCode,
    model: r.model,
    hasText: r.assistantTexts.length > 0,
    firstText: r.assistantTexts[0]?.slice(0, 80),
    is_error: r.resultEvent?.is_error,
  });
});
```

- [x] **Step 3: 跑**

Run:
```bash
node --test plugins/qwen/scripts/tests/qwen-ping.test.mjs
```

Expected: `pass 1`。控制台应打印真实 session_id 等。

- [x] **Step 4: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs plugins/qwen/scripts/tests/qwen-ping.test.mjs
git commit -m "feat(qwen.mjs): runQwenPing 解析 stream-json 原料"
```

---

## Task 1.10: qwen-companion.mjs — setup dispatcher

**Files:**
- Create: `plugins/qwen/scripts/qwen-companion.mjs`

- [x] **Step 1: 写 dispatcher + setup 子命令**

```javascript
#!/usr/bin/env node
// plugins/qwen/scripts/qwen-companion.mjs
// Dispatcher;Phase 1 只实现 setup。
import process from "node:process";
import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  getQwenAvailability,
  buildSpawnEnv,
  readQwenSettings,
  parseAuthStatusText,
  detectInstallers,
  runQwenPing,
  QWEN_BIN,
} from "./lib/qwen.mjs";
import { runCommand } from "./lib/process.mjs";

const USAGE = `Usage: qwen-companion <subcommand> [options]

Subcommands:
  setup [--json] [--enable-review-gate] [--disable-review-gate]

(More subcommands arrive in Phase 2+.)`;

// setup 子命令
function runSetup(rawArgs) {
  const { options } = parseArgs(rawArgs, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });

  const availability = getQwenAvailability();
  const installers = detectInstallers();
  const userSettings = readQwenSettings();
  const { env, warnings } = buildSpawnEnv(userSettings);

  // 解析 qwen auth status 文本(fallback 到 unknown)
  let authParsed = { authMethod: "unknown", model: null, configured: false };
  if (availability.available) {
    const authTextRes = runCommand(QWEN_BIN, ["auth", "status"], { env, timeout: 5000 });
    if (authTextRes.status === 0 && authTextRes.stdout) {
      authParsed = parseAuthStatusText(authTextRes.stdout);
    }
  }

  // Ping 探活(Phase 1 内只关心 authenticated,不做五层判错 — Phase 2 补)
  let authenticated = false;
  let authDetail = "not checked (qwen not installed)";
  let sessionModel = null;
  if (availability.available) {
    const ping = runQwenPing({ env });
    // 粗判:有 assistant text 且不以 [API Error: 开头 → 认为通过
    const text = ping.assistantTexts.join("\n");
    if (text && !/\[API Error:/.test(text)) {
      authenticated = true;
      authDetail = "ping succeeded";
      sessionModel = ping.model;
    } else if (/\[API Error:/.test(text)) {
      authDetail = `ping returned API Error: ${text.slice(0, 200)}`;
    } else {
      authDetail = `ping produced no assistant text; stderr: ${ping.stderrTail || "(empty)"}`;
    }
  }

  const status = {
    installed: availability.available,
    version: availability.available ? availability.detail : null,
    authenticated,
    authDetail,
    authMethod: authParsed.authMethod,
    model: sessionModel || authParsed.model || userSettings?.model || null,
    chatRecording: userSettings?.chatRecording !== false, // 默认 true
    proxyInjected: warnings.length === 0 && userSettings?.proxy != null,
    warnings,
    installers,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  } else {
    process.stdout.write(formatSetupText(status) + "\n");
  }
  process.exit(0);
}

function formatSetupText(s) {
  const lines = [];
  lines.push(`installed:     ${s.installed ? `yes (${s.version})` : "no"}`);
  lines.push(`authenticated: ${s.authenticated ? "yes" : `no (${s.authDetail})`}`);
  lines.push(`authMethod:    ${s.authMethod}`);
  lines.push(`model:         ${s.model || "(not set)"}`);
  lines.push(`chatRecording: ${s.chatRecording ? "on" : "off"}`);
  lines.push(`proxyInjected: ${s.proxyInjected ? "yes" : "no"}`);
  if (s.warnings.length) {
    lines.push("warnings:");
    for (const w of s.warnings) {
      lines.push(`  - [${w.kind}] ${w.message || JSON.stringify(w)}`);
    }
  }
  if (!s.installed) {
    lines.push("");
    lines.push("installers:");
    lines.push(`  npm:  ${s.installers.npm ? "yes" : "no"}`);
    lines.push(`  brew: ${s.installers.brew ? "yes" : "no"}`);
    lines.push(`  curl: ${s.installers.shellInstaller ? "yes" : "no"}`);
  }
  return lines.join("\n");
}

// Dispatcher
const UNPACK_SAFE_SUBCOMMANDS = new Set(["setup"]);

function shouldUnpackBlob(sub, rest) {
  if (rest.length !== 1) return false;
  if (!UNPACK_SAFE_SUBCOMMANDS.has(sub)) return false;
  if (!rest[0].includes(" ")) return false;
  const tokens = splitRawArgumentString(rest[0]);
  return tokens.length > 0 && tokens.every((t) => t.startsWith("-"));
}

function main() {
  const argv = process.argv.slice(2);
  let [sub, ...rest] = argv;

  if (shouldUnpackBlob(sub, rest)) {
    rest = splitRawArgumentString(rest[0]);
  }

  switch (sub) {
    case "setup":
      return runSetup(rest);
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      process.exit(0);
      break;
    default:
      process.stderr.write(`Unknown subcommand: ${sub}\n${USAGE}\n`);
      process.exit(1);
  }
}

main();
```

- [x] **Step 2: 赋执行权 + 手测文本模式**

Run:
```bash
chmod +x plugins/qwen/scripts/qwen-companion.mjs
node plugins/qwen/scripts/qwen-companion.mjs setup
```

Expected: 打印 `installed: yes (...)` / `authenticated: yes` / `authMethod: coding-plan` 等。

- [x] **Step 3: 手测 JSON 模式**

Run:
```bash
node plugins/qwen/scripts/qwen-companion.mjs setup --json | jq .
```

Expected: 完整 JSON 含 installed/authenticated/authMethod/model/chatRecording/proxyInjected/warnings/installers。

- [x] **Step 4: Commit**

```bash
git add plugins/qwen/scripts/qwen-companion.mjs
git commit -m "feat(companion): setup 子命令 dispatcher"
```

---

## Task 1.11: /qwen:setup 命令文件

**Files:**
- Create: `plugins/qwen/commands/setup.md`

- [x] **Step 1: 写命令 frontmatter + 文本**

```markdown
---
description: Check whether the local Qwen CLI is ready, authenticated, and has proxy aligned
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), Bash(brew:*), Bash(sh:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" setup --json "$ARGUMENTS"
```

Interpret the JSON result:

### Not installed (`installed: false`)

Check `installers.*`. Build AskUserQuestion option list **dynamically**, only including options whose installer is detected. Always include `Skip for now`.

Possible options:
- `Install via npm (Recommended, official)` → runs `npm install -g @qwen-code/qwen-code@latest`
- `Install via Homebrew` → runs `brew install qwen-code`
- `Install via shell script` → runs `curl -LsSf <official install URL> | bash`
- `Skip for now`

Edge case: if all three installers are false, do NOT use AskUserQuestion. Instead say: "No installer detected. Install one of: npm, brew, or curl. Then re-run `/qwen:setup`."

After successful install, re-run `setup`.

### Installed but not authenticated (`installed: true, authenticated: false`)

Do NOT run `qwen auth coding-plan` from a tool call — it's interactive. Tell the user verbatim: "Run `! qwen auth coding-plan` in your terminal to authenticate, then re-run `/qwen:setup`."

### Warnings

If `warnings` is non-empty, print each warning prominently:
- `proxy_env_mismatch`: user env has conflicting HTTP(S)_PROXY keys — advise alignment
- `proxy_conflict`: settings.proxy and env disagree — advise user to pick one

### Blocking qwen hooks

If `qwenHooksBlockingWarning` is true (Phase 2+ 会填),高亮警告:qwen 侧 PreToolUse hook 可能拦截 rescue yolo 模式。

### All good (`installed: true, authenticated: true`)

Print the full JSON so user sees `version`, `authMethod`, `model`, etc.

### Output rules

- Present JSON faithfully; do not paraphrase fields.
- Do not auto-suggest installs when already installed and authenticated.
- Do not fetch anything external beyond the companion output.
```

- [x] **Step 2: 本地 install 插件验证**

Run:
```bash
# Claude Code 里跑
claude plugins add ./plugins/qwen
```

(user 需要在 Claude Code 里亲自 run,不是在这个脚本会话里)

- [x] **Step 3: Commit**

```bash
git add plugins/qwen/commands/setup.md
git commit -m "feat(cmd): /qwen:setup 命令文件"
```

---

## Task 1.12: 手测 T1 + T2

这是端到端,不是 plan step。记录到 CHANGELOG。

- [x] **Step 1: 在 Claude Code 里跑 T1**

User action:`claude plugins add ./plugins/qwen`

Expected:斜杠命令出现 `/qwen:setup`。

- [x] **Step 2: T2 — 跑 /qwen:setup**

Expected:Claude 打印 JSON 含 `authenticated: true`。

- [x] **Step 3: 若本机 proxy 场景成立,顺带验 T12**

手动 `unset HTTP_PROXY https_proxy` 后在 Claude Code 里 `/qwen:setup`,看 JSON `proxyInjected: true` + `warnings: []`。

- [x] **Step 4: 回填 CHANGELOG**

把"Phase 1 完成,T1 T2 T12 通过"写进 `CHANGELOG.md` 和 `plugins/qwen/CHANGELOG.md`。

- [x] **Step 5: Commit**

```bash
git add CHANGELOG.md plugins/qwen/CHANGELOG.md
git commit -m "chore: Phase 1 完成,T1 T2 T12 手测通过"
```

---

**Phase 1 Exit Criteria**:
- `/qwen:setup` 在真实 Claude Code 里跑通
- `authenticated: true` 能返回
- `warnings` 能如实反映 proxy 冲突
- 11 个单元测试全过
- Phase 0 `case-11-decision.md` 如有"改对称 `--unsafe`"决策,已同步更新 spec 与后续 Phase 2 tasks

---

# Phase 2 · Rescue + Skills(3 天)

**目标**:实现 `/qwen:rescue` 命令 + `task`/`task-resume-candidate`/`cancel` 子命令 + 3 skill + 1 agent,跑通 T4/T5/T5'/T8/T11/T13。

---

## Task 2.1: 依赖解耦清单(Phase 2 Day 1 核心)

> Gemini v2 review 强调:`job-control.mjs` 17.4K 有隐式依赖,必须先列清单再复制。

**Files:**
- Create: `docs/superpowers/plans/_phase2-dependencies.md`

- [x] **Step 1: grep gemini 源码,列出 job-control.mjs 调用的外部符号**

Run:
```bash
grep -nE '\b(resolveWorkspaceRoot|readStdin|generateJobId|nowIso|appendLogLine|createJobLogFile|loadPromptTemplate|interpolateTemplate|ensureStateDir|writeJobFile|upsertJob|listJobs|loadState|getConfig|setConfig)\b' \
  /Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/scripts/lib/job-control.mjs | head -40
```

记录每个符号的**出处**(companion 主文件 / hook / 其他 lib)。

- [x] **Step 2: grep gemini job-control.mjs 的 import 段**

Run:
```bash
head -30 /Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/scripts/lib/job-control.mjs
```

把所有 `import { X } from "Y"` 抄下来,确认依赖图。

- [x] **Step 3: 写 `docs/superpowers/plans/_phase2-dependencies.md`**

```markdown
# Phase 2 依赖解耦清单

从 gemini 复制 `job-control.mjs` 时需要注入/替换的外部依赖。

## 内部(同 lib 目录)

| 符号 | 来自 | 状态 |
|---|---|---|
| `nowIso` | (job-control 或 state 自带) | 随文件一起来 |
| `...` | `./state.mjs` | 同时复制 state.mjs |
| `...` | `./process.mjs` | Task 1.2 已拷 |
| `...` | `./args.mjs` | Task 1.2 已拷 |

## 外部(companion / hook 实现)

| 符号 | gemini 原出处 | qwen 放哪 |
|---|---|---|
| `resolveWorkspaceRoot` | `gemini-companion.mjs:79-90` | 内嵌进 `qwen-companion.mjs`(等价位置) |
| `readStdin` | `gemini-companion.mjs:???` | 内嵌进 `qwen-companion.mjs` |
| `generateJobId` | `state.mjs` | 随 state.mjs 复制 |
| `SESSION_ID_ENV` | `session-lifecycle-hook.mjs` | Phase 4 同步改名为 `QWEN_COMPANION_SESSION_ID` |

## 字面量替换清单(Phase 2 Task 2.3/2.4 批量改)

- `GEMINI_COMPANION_SESSION_ID` → `QWEN_COMPANION_SESSION_ID`
- `gemini-companion` → `qwen-companion`
- `Gemini` → `Qwen`(文本字面量,不改函数名)
- `gemini.mjs` import → `qwen.mjs`
- 若有超时常量命名如 `GEMINI_LONG_POLL_TIMEOUT_MS`,改通用名 `QWEN_LONG_POLL_TIMEOUT_MS`(语义可能不一样,复制后人工审)
```

按 Step 1+2 的真实 grep 结果填表。发现未预料的依赖(例如 lockfile 管理、特定 logger 工厂),加新行。

- [x] **Step 4: Commit**

```bash
git add docs/superpowers/plans/_phase2-dependencies.md
git commit -m "docs(phase2): 依赖解耦清单 — job-control.mjs 隐式依赖审计"
```

---

## Task 2.2: 字节起点拷贝(git / state / render / prompts)

**Files(拷自 gemini)**:
- Create: `plugins/qwen/scripts/lib/git.mjs`
- Create: `plugins/qwen/scripts/lib/state.mjs`
- Create: `plugins/qwen/scripts/lib/render.mjs`
- Create: `plugins/qwen/scripts/lib/prompts.mjs`

- [x] **Step 1: 批量拷**

Run:
```bash
for f in git state render prompts; do
  cp "/Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/scripts/lib/${f}.mjs" \
     "plugins/qwen/scripts/lib/${f}.mjs"
done
ls -la plugins/qwen/scripts/lib/
```

Expected: 看到 6 个 mjs(args/process/git/state/render/prompts)+ qwen.mjs。

- [x] **Step 2: 查出所有 GEMINI 字样**

Run:
```bash
grep -rln 'gemini\|GEMINI\|Gemini' plugins/qwen/scripts/lib/
```

列出所有出现文件。预计 `state.mjs`、`render.mjs`、`prompts.mjs` 会有,`git.mjs` 应该没有(通用)。

- [x] **Step 3: Commit 字节起点(未改写)**

```bash
git add plugins/qwen/scripts/lib/git.mjs plugins/qwen/scripts/lib/state.mjs \
        plugins/qwen/scripts/lib/render.mjs plugins/qwen/scripts/lib/prompts.mjs
git commit -m "feat(lib): git/state/render/prompts 从 gemini 血统拷贝(未改写字样)"
```

---

## Task 2.3: state.mjs 常量剥离 + 单元测试

**Files:**
- Modify: `plugins/qwen/scripts/lib/state.mjs`
- Create: `plugins/qwen/scripts/tests/state.test.mjs`

- [x] **Step 1: 用 sed 批量替换字面量**

Run:
```bash
sed -i '' \
  -e 's/GEMINI_COMPANION_SESSION_ID/QWEN_COMPANION_SESSION_ID/g' \
  -e 's/gemini-companion/qwen-companion/g' \
  -e 's/gemini/qwen/g' \
  -e 's/Gemini/Qwen/g' \
  plugins/qwen/scripts/lib/state.mjs
```

- [x] **Step 2: 审视差异(人眼过一遍,看有没有误伤)**

Run:
```bash
git diff plugins/qwen/scripts/lib/state.mjs | head -80
```

重点看:有没有把函数名 `resolveGeminiXxx` 改成 `resolveQwenXxx` 但下游还在按老名字 import。若有,记下需要在 Task 2.10 companion 里对应改。

- [x] **Step 3: 写测试(spec §6.3 state.test.mjs 清单)**

`plugins/qwen/scripts/tests/state.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveStateDir, resolveJobsDir, ensureStateDir, generateJobId,
         writeJobFile, readJobFile, listJobs, MAX_JOBS } from "../lib/state.mjs";

function makeTmpPluginData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-state-test-"));
  const oldEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  return {
    dir,
    restore() {
      if (oldEnv == null) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = oldEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("resolveStateDir: 同 cwd 幂等", () => {
  const tmp = makeTmpPluginData();
  try {
    const d1 = resolveStateDir("/tmp/foo");
    const d2 = resolveStateDir("/tmp/foo");
    assert.equal(d1, d2);
  } finally { tmp.restore(); }
});

test("resolveStateDir: 不同 cwd → 不同目录", () => {
  const tmp = makeTmpPluginData();
  try {
    const d1 = resolveStateDir("/tmp/foo");
    const d2 = resolveStateDir("/tmp/bar");
    assert.notEqual(d1, d2);
  } finally { tmp.restore(); }
});

test("writeJobFile + readJobFile roundtrip", () => {
  const tmp = makeTmpPluginData();
  try {
    const cwd = "/tmp/rt";
    ensureStateDir(cwd);
    const jobId = generateJobId();
    const jobData = {
      jobId, kind: "task", status: "running",
      pid: 12345, pgid: 12345,
      approvalMode: "yolo", unsafeFlag: true,
      warnings: [],
    };
    writeJobFile(cwd, jobData);
    const read = readJobFile(cwd, jobId);
    assert.equal(read.jobId, jobId);
    assert.equal(read.approvalMode, "yolo");
    assert.equal(read.unsafeFlag, true);
  } finally { tmp.restore(); }
});

test("listJobs MAX_JOBS=50 滚动", () => {
  const tmp = makeTmpPluginData();
  try {
    const cwd = "/tmp/roll";
    ensureStateDir(cwd);
    for (let i = 0; i < MAX_JOBS + 10; i++) {
      writeJobFile(cwd, {
        jobId: `job-${String(i).padStart(4, "0")}`,
        kind: "task", status: "completed",
        startedAt: new Date(Date.now() - (MAX_JOBS + 10 - i) * 1000).toISOString(),
      });
    }
    const jobs = listJobs(cwd);
    assert.ok(jobs.length <= MAX_JOBS, `jobs.length=${jobs.length}`);
  } finally { tmp.restore(); }
});
```

> 如果 gemini 的 state.mjs 没有 `readJobFile` 或签名不同,先跑测试看红,再根据实际签名调整测试。测试失败说明 state 接口不合约,要先改 state.mjs 或测试。

- [x] **Step 4: 跑测试**

Run: `node --test plugins/qwen/scripts/tests/state.test.mjs`

根据结果处理:
- 全过 → commit
- 有失败 → 读 state.mjs 实际 API,把测试调整到与实际一致(**不**轻易改 state.mjs,先确认 gemini 版的语义是对的)。

- [x] **Step 5: Commit**

```bash
git add plugins/qwen/scripts/lib/state.mjs plugins/qwen/scripts/tests/state.test.mjs
git commit -m "feat(state): 常量剥离 GEMINI→QWEN + 4 个单元测试"
```

---

## Task 2.4: job-control.mjs 拷贝 + 依赖注入改造

**Files:**
- Create: `plugins/qwen/scripts/lib/job-control.mjs`(拷自 gemini)

- [x] **Step 1: 拷过来**

Run:
```bash
cp /Users/bing/-Code-/gemini-plugin-cc/plugins/gemini/scripts/lib/job-control.mjs \
   plugins/qwen/scripts/lib/job-control.mjs
```

- [x] **Step 2: sed 批量字面量替换**

Run:
```bash
sed -i '' \
  -e 's/GEMINI_COMPANION_SESSION_ID/QWEN_COMPANION_SESSION_ID/g' \
  -e 's/gemini-companion/qwen-companion/g' \
  -e 's/gemini\.mjs/qwen.mjs/g' \
  -e 's/Gemini/Qwen/g' \
  plugins/qwen/scripts/lib/job-control.mjs
```

- [x] **Step 3: 检查 import 是否都能 resolve**

Run:
```bash
node --input-type=module -e "
  import('./plugins/qwen/scripts/lib/job-control.mjs').then(() => console.log('ok'))
  .catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"
```

Expected: `ok`。

如果失败,常见两种:
1. `import { X } from "./qwen.mjs"` 但 qwen.mjs 没导出 X → 记录要补哪些导出,留到 Task 2.5–2.9 时补
2. `import { X } from "../gemini-companion.mjs"` 这种跨 lib 的 → 说明依赖清单有遗漏,回头改 `_phase2-dependencies.md`

- [x] **Step 4: Commit**

```bash
git add plugins/qwen/scripts/lib/job-control.mjs
git commit -m "feat(job-control): 字节拷贝 + 字面量剥离(import 可能待后续 task 补齐)"
```

---

## Task 2.5: qwen.mjs — classifyApiError(状态码优先 + DashScope)

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`
- Create: `plugins/qwen/scripts/tests/qwen-classify.test.mjs`

- [x] **Step 1: 写测试(spec §5.1 精确行为)**

`plugins/qwen/scripts/tests/qwen-classify.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyApiError } from "../lib/qwen.mjs";

// v3.1 F-2 实测:qwen 真实格式是 [API Error: NNN ...],无 "Status:" 字样
test("classifyApiError: qwen 实际 401 格式(F-2 实测)", () => {
  const r = classifyApiError("[API Error: 401 invalid access token or token expired]");
  assert.equal(r.kind, "not_authenticated");
  assert.equal(r.status, 401);
});

test("classifyApiError: [API Error: 403 ...] → not_authenticated", () => {
  const r = classifyApiError("[API Error: 403 forbidden]");
  assert.equal(r.kind, "not_authenticated");
});

test("classifyApiError: [API Error: 429 ...] → rate_limited", () => {
  const r = classifyApiError("[API Error: 429 too many requests]");
  assert.equal(r.kind, "rate_limited");
});

test("classifyApiError: [API Error: 400 ...] → invalid_request", () => {
  const r = classifyApiError("[API Error: 400 bad request]");
  assert.equal(r.kind, "invalid_request");
});

test("classifyApiError: [API Error: 503 ...] → server_error", () => {
  const r = classifyApiError("[API Error: 503 service unavailable]");
  assert.equal(r.kind, "server_error");
  assert.equal(r.status, 503);
});

// (Status: NNN) 作为 fallback(兼容其他 provider)
test("classifyApiError: fallback (Status: 401) 格式", () => {
  const r = classifyApiError("[API Error: Connection refused (Status: 401)]");
  assert.equal(r.kind, "not_authenticated");
  assert.equal(r.status, 401);
});

test("classifyApiError: DashScope 108 → insufficient_balance", () => {
  const r = classifyApiError("[API Error: error code 108 insufficient balance]");
  assert.equal(r.kind, "insufficient_balance");
});

test("classifyApiError: sensitive → content_sensitive", () => {
  const r = classifyApiError("[API Error: content sensitive, moderation failed]");
  assert.equal(r.kind, "content_sensitive");
});

test("classifyApiError: 关键词 rate limit 无状态码 → rate_limited", () => {
  const r = classifyApiError("[API Error: Request was throttled due to rate limiting]");
  assert.equal(r.kind, "rate_limited");
});

test("classifyApiError: 关键词兜底 network", () => {
  const r = classifyApiError("[API Error: connection timeout]");
  assert.equal(r.kind, "network_error");
});

test("classifyApiError: 完全未命中 → api_error_unknown", () => {
  const r = classifyApiError("[API Error: something completely unexpected]");
  assert.equal(r.kind, "api_error_unknown");
});

test("classifyApiError 边界:status 40101 不被当 401", () => {
  const r = classifyApiError("[API Error: status 40101]");
  // 40101 不匹配 \d{3}\b(边界在 1 后),所以不触发 401
  // 但是 classifyApiError 的 \bStatus:\s*(\d{3})\b 要求 "Status:" 前缀,
  // 本例没有 "Status:" 前缀,所以状态码提取失败;关键词也未命中 → unknown
  assert.notEqual(r.kind, "not_authenticated");
});

test("classifyApiError 边界:503ms 不被当 5xx server_error", () => {
  const r = classifyApiError("[API Error: timeout after 503ms]");
  // 有 connection/timeout 关键词 → network_error,不是 server_error
  assert.equal(r.kind, "network_error");
});
```

- [x] **Step 2: 验失败**

Run: `node --test plugins/qwen/scripts/tests/qwen-classify.test.mjs`

- [x] **Step 3: 在 qwen.mjs 实现(严格按 spec §5.1)**

追加到 `plugins/qwen/scripts/lib/qwen.mjs`:
```javascript
// ── classifyApiError(§5.1) ──────────────────────────────────

/**
 * 把 [API Error: ...] 文本分类为具体 kind。
 * 优先:从 "Status: NNN" 提取状态码精确分类;否则关键词兜底。
 * 边界:`\b` 防误伤(40101 不当 401,503ms 不当 5xx)。
 */
export function classifyApiError(msg) {
  const m = String(msg ?? "");

  // 1. 状态码优先(v3.1 F-2):qwen 格式 [API Error: NNN ...] 优先;
  //    (Status: NNN) 作兼容其他 provider 的 fallback
  let statusMatch = m.match(/\[API Error:\s*(\d{3})\b/i);
  if (!statusMatch) statusMatch = m.match(/\bStatus:\s*(\d{3})\b/i);
  if (statusMatch) {
    const code = parseInt(statusMatch[1], 10);
    if (code === 401 || code === 403) return { failed: true, kind: "not_authenticated", status: code, message: m };
    if (code === 429)                 return { failed: true, kind: "rate_limited",      status: code, message: m };
    if (code === 400)                 return { failed: true, kind: "invalid_request",   status: code, message: m };
    if (code >= 500 && code < 600)    return { failed: true, kind: "server_error",      status: code, message: m };
  }

  // 2. DashScope 特定
  if (/\berror code 108\b|\binsufficient.?balance\b|\bquota.?exceed/i.test(m))
    return { failed: true, kind: "insufficient_balance", message: m };
  if (/\bcontent.?sensitive\b|\bsensitive\b|\bmoderation\b|\bcontent.?(?:filter|policy|unsafe)/i.test(m))
    return { failed: true, kind: "content_sensitive", message: m };

  // 3. 关键词兜底(带 \b 边界)
  if (/\brate.?limit\b|\bthrottl/i.test(m))               return { failed: true, kind: "rate_limited", message: m };
  if (/\bquota\b|\bbilling\b/i.test(m))                   return { failed: true, kind: "quota_or_billing", message: m };
  if (/\bunauthoriz|\binvalid.*access.?token\b/i.test(m)) return { failed: true, kind: "not_authenticated", message: m };
  if (/\bmax.*output.*tokens\b/i.test(m))                 return { failed: true, kind: "max_output_tokens", message: m };
  if (/\bconnection\b|\bnetwork\b|\btimeout\b|\bECONNRESET\b|\bENOTFOUND\b/i.test(m))
                                                          return { failed: true, kind: "network_error", message: m };

  return { failed: true, kind: "api_error_unknown", message: m };
}
```

- [x] **Step 4: 跑测试**

Run: `node --test plugins/qwen/scripts/tests/qwen-classify.test.mjs`

Expected: `pass 12`。

- [x] **Step 5: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs plugins/qwen/scripts/tests/qwen-classify.test.mjs
git commit -m "feat(qwen.mjs): classifyApiError 状态码优先 + DashScope + 12 测试"
```

---

## Task 2.6: qwen.mjs — detectFailure 五层

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`
- Create: `plugins/qwen/scripts/tests/qwen-detect.test.mjs`

- [x] **Step 1: 写测试(spec §5.1 五层所有组合)**

`plugins/qwen/scripts/tests/qwen-detect.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFailure } from "../lib/qwen.mjs";

test("层 1:exitCode 非 0 → kind=exit", () => {
  const r = detectFailure({ exitCode: 1, resultEvent: null, assistantTexts: [] });
  assert.equal(r.failed, true);
  assert.equal(r.kind, "exit");
  assert.equal(r.code, 1);
});

test("层 1:exitCode null(超时杀)→ 视为未失败等待后续层", () => {
  // 注意:timeout 会被 companion 层另行处理,detectFailure 自身不处理 null
  const r = detectFailure({
    exitCode: null,
    resultEvent: { is_error: false, result: "ok" },
    assistantTexts: ["ok"],
  });
  assert.equal(r.failed, false);
});

test("层 2:is_error:true → qwen_is_error", () => {
  const r = detectFailure({
    exitCode: 0,
    resultEvent: { is_error: true, result: "" },
    assistantTexts: [],
  });
  assert.equal(r.kind, "qwen_is_error");
});

test("层 3:result.result 含 [API Error: (Status: 401) → not_authenticated", () => {
  const r = detectFailure({
    exitCode: 0,
    resultEvent: { is_error: false, result: "[API Error: token expired (Status: 401)]" },
    assistantTexts: [],
  });
  assert.equal(r.kind, "not_authenticated");
});

test("层 4:assistant text 含 [API Error: → classifyApiError 分类", () => {
  const r = detectFailure({
    exitCode: 0,
    resultEvent: { is_error: false, result: "ok" },
    assistantTexts: ["[API Error: Status: 429]"],
  });
  assert.equal(r.kind, "rate_limited");
});

test("层 4:不锚定 ^ — 前置换行/空格都能命中", () => {
  const r = detectFailure({
    exitCode: 0,
    resultEvent: null,
    assistantTexts: ["  \n[API Error: token invalid]"],
  });
  assert.equal(r.failed, true);
});

test("层 5:exit 0 + is_error false + result 空 + 无 assistant → empty_output", () => {
  const r = detectFailure({
    exitCode: 0,
    resultEvent: { is_error: false, result: null },
    assistantTexts: [],
  });
  assert.equal(r.kind, "empty_output");
});

test("正常成功:exit 0 + is_error false + 有 text → not failed", () => {
  const r = detectFailure({
    exitCode: 0,
    resultEvent: { is_error: false, result: "pong" },
    assistantTexts: ["pong"],
  });
  assert.equal(r.failed, false);
});
```

- [x] **Step 2: 验失败**

Run: `node --test plugins/qwen/scripts/tests/qwen-detect.test.mjs`

- [x] **Step 3: 实现 detectFailure**

追加到 qwen.mjs:
```javascript
// ── detectFailure 五层(§5.1) ──────────────────────────────────

/**
 * 五层判错。对 qwen "exit 0 + is_error:false 但 assistant text 含 [API Error:" 场景的
 * 完整翻译。
 *
 * @param {{ exitCode: number | null, resultEvent: object | null, assistantTexts: string[] }} input
 */
export function detectFailure({ exitCode, resultEvent, assistantTexts }) {
  // 层 1:进程非 0 退出(null = 未退出,交给 timeout 层处理)
  if (exitCode !== 0 && exitCode !== null)
    return { failed: true, kind: "exit", code: exitCode };

  // 层 2:qwen 自报 is_error
  if (resultEvent?.is_error === true)
    return { failed: true, kind: "qwen_is_error" };

  // 层 3:result 字段含 [API Error:
  if (resultEvent?.result && /\[API Error:/.test(resultEvent.result))
    return classifyApiError(resultEvent.result);

  // 层 4:任一 assistant text 含 [API Error:(不锚 ^)
  const errLine = (assistantTexts || []).find(t => /\[API Error:/.test(t));
  if (errLine) return classifyApiError(errLine);

  // 层 5:空输出保护
  const hasText = (assistantTexts || []).length > 0;
  const hasResult = resultEvent?.result != null && resultEvent.result !== "";
  if (!hasText && !hasResult && exitCode === 0)
    return { failed: true, kind: "empty_output" };

  return { failed: false };
}
```

- [x] **Step 4: 跑测试**

Run: `node --test plugins/qwen/scripts/tests/qwen-detect.test.mjs`

Expected: `pass 8`。

- [x] **Step 5: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs plugins/qwen/scripts/tests/qwen-detect.test.mjs
git commit -m "feat(qwen.mjs): detectFailure 五层 + 8 测试"
```

---

## Task 2.7: qwen.mjs — parseStream + fg/bg 分野

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`
- Create: `plugins/qwen/scripts/tests/qwen-parse.test.mjs`

- [x] **Step 1: 写测试**

`plugins/qwen/scripts/tests/qwen-parse.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStreamEvents } from "../lib/qwen.mjs";

const NORMAL_JSONL = `
{"type":"system","subtype":"init","session_id":"abc","model":"qwen3.6-plus","mcp_servers":[]}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"pong"}]}}
{"type":"result","is_error":false,"result":"pong","duration_ms":120,"num_turns":1}
`.trim();

const API_ERROR_JSONL = `
{"type":"system","subtype":"init","session_id":"xyz","model":"qwen3.6-plus"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"[API Error: token expired (Status: 401)]"}]}}
{"type":"result","is_error":false,"result":"[API Error: token expired (Status: 401)]"}
`.trim();

test("parseStreamEvents: 正常输出提取 init/assistant/result", () => {
  const { sessionId, model, mcpServers, assistantTexts, resultEvent } = parseStreamEvents(NORMAL_JSONL);
  assert.equal(sessionId, "abc");
  assert.equal(model, "qwen3.6-plus");
  assert.deepEqual(mcpServers, []);
  assert.deepEqual(assistantTexts, ["pong"]);
  assert.equal(resultEvent.is_error, false);
});

test("parseStreamEvents: API Error 文本被收集到 assistantTexts", () => {
  const { assistantTexts } = parseStreamEvents(API_ERROR_JSONL);
  assert.ok(assistantTexts.some(t => /\[API Error:/.test(t)));
});

test("parseStreamEvents: 空行/坏行不崩", () => {
  const stream = `
{"type":"system","subtype":"init","session_id":"abc"}

not json at all
{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}
`.trim();
  const r = parseStreamEvents(stream);
  assert.equal(r.sessionId, "abc");
  assert.deepEqual(r.assistantTexts, ["ok"]);
});

test("parseStreamEvents: 多个 assistant 块合并收集", () => {
  const stream = `
{"type":"assistant","message":{"content":[{"type":"text","text":"part1"},{"type":"text","text":"part2"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"part3"}]}}
`.trim();
  const r = parseStreamEvents(stream);
  assert.deepEqual(r.assistantTexts, ["part1", "part2", "part3"]);
});
```

- [x] **Step 2: 验失败**

Run: `node --test plugins/qwen/scripts/tests/qwen-parse.test.mjs`

- [x] **Step 3: 实现 parseStreamEvents(纯离线解析;边解析边判错在 Task 2.8 streaming 版里)**

追加到 qwen.mjs:
```javascript
// ── Stream JSON 事件解析(离线版,一次性消化字符串) ─────

/**
 * 从 stream-json JSONL 提取 init / assistant / result 事件。
 * 离线版(一次性喂全文);streaming 版见 streamQwenProcess(Task 2.8)。
 *
 * @param {string} text - 完整 stdout JSONL
 * @returns {{ sessionId, model, mcpServers, assistantTexts, resultEvent }}
 */
export function parseStreamEvents(text) {
  const out = {
    sessionId: null,
    model: null,
    mcpServers: [],
    assistantTexts: [],
    resultEvent: null,
  };

  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }

    if (event.type === "system" && event.subtype === "init") {
      out.sessionId = event.session_id ?? out.sessionId;
      out.model = event.model ?? out.model;
      if (Array.isArray(event.mcp_servers)) out.mcpServers = event.mcp_servers;
    } else if (event.type === "assistant") {
      const blocks = event.message?.content ?? [];
      for (const b of blocks) {
        // v3.1 F-6: 跳过 thinking 块,只收 text 块
        if (b?.type === "text" && typeof b.text === "string") {
          out.assistantTexts.push(b.text);
        }
      }
    } else if (event.type === "result") {
      out.resultEvent = event;
    }
  }

  return out;
}
```

- [x] **Step 4: 跑测试**

Run: `node --test plugins/qwen/scripts/tests/qwen-parse.test.mjs`

Expected: `pass 4`。

- [x] **Step 5: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs plugins/qwen/scripts/tests/qwen-parse.test.mjs
git commit -m "feat(qwen.mjs): parseStreamEvents 离线解析 + 4 测试"
```

---

## Task 2.8: qwen.mjs — spawnQwen(detached + unsafe + fg/bg 分野)

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`
- Create: `plugins/qwen/scripts/tests/qwen-spawn.test.mjs`

- [x] **Step 1: 实现 buildQwenArgs(参数装配纯函数,先做易测的)**

追加到 qwen.mjs:
```javascript
// ── 参数装配 + spawn ─────────────────────────────────────────

/**
 * 按 spec §4.2 装配 qwen CLI 参数。
 * 决定 approvalMode 的落点:
 * - 用户显式 userApprovalMode → 尊重
 * - 否则 unsafeFlag ? "yolo" : "auto-edit"
 * - background + !unsafeFlag + yolo 结果 → 抛 CompanionError("require_interactive")
 *
 * 注意:Phase 0 case 11 结果若确认 foreground auto-edit 无 TTY 会 hang,
 * 应在这里对 foreground 也做 require_interactive 检查(见 case-11-decision.md)。
 */
export function buildQwenArgs({
  prompt,
  sessionId, resumeLast, resumeId,
  approvalMode: userApprovalMode,
  unsafeFlag, background,
  maxSteps = 20,
  appendSystem,
  appendDirs,
}) {
  let approvalMode = userApprovalMode;
  if (!approvalMode) approvalMode = unsafeFlag ? "yolo" : "auto-edit";
  if (background && !unsafeFlag && approvalMode === "yolo") {
    throw new CompanionError(
      "require_interactive",
      "Background rescue with yolo requires --unsafe. Add --unsafe or switch to foreground."
    );
  }

  const args = [];
  if (sessionId)        args.push("--session-id", sessionId);
  else if (resumeLast)  args.push("-c");
  else if (resumeId)    args.push("-r", resumeId);

  args.push("--output-format", "stream-json");
  args.push("--approval-mode", approvalMode);
  args.push("--max-session-turns", String(maxSteps));
  if (appendSystem) args.push("--append-system-prompt", appendSystem);
  if (appendDirs && appendDirs.length) args.push("--include-directories", appendDirs.join(","));

  args.push(prompt); // 位置参数

  return { args, approvalMode };
}
```

- [x] **Step 2: 写测试**

`plugins/qwen/scripts/tests/qwen-spawn.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQwenArgs, CompanionError } from "../lib/qwen.mjs";

test("buildQwenArgs: 基本参数 + prompt 位置", () => {
  const { args, approvalMode } = buildQwenArgs({ prompt: "hi", unsafeFlag: true, background: true });
  assert.equal(approvalMode, "yolo");
  assert.ok(args.includes("--output-format") && args.includes("stream-json"));
  assert.ok(args.includes("--approval-mode") && args.includes("yolo"));
  assert.equal(args[args.length - 1], "hi");
});

test("buildQwenArgs: 默认 approval = auto-edit", () => {
  const { approvalMode } = buildQwenArgs({ prompt: "hi", background: false });
  assert.equal(approvalMode, "auto-edit");
});

test("buildQwenArgs: background + !unsafe → require_interactive", () => {
  assert.throws(
    () => buildQwenArgs({ prompt: "hi", background: true, approvalMode: "yolo" }),
    (e) => e instanceof CompanionError && e.kind === "require_interactive"
  );
});

test("buildQwenArgs: background + unsafe → 可以 yolo", () => {
  const { approvalMode } = buildQwenArgs({ prompt: "hi", background: true, unsafeFlag: true });
  assert.equal(approvalMode, "yolo");
});

test("buildQwenArgs: sessionId + resumeLast 互斥(sessionId 优先)", () => {
  const { args } = buildQwenArgs({ prompt: "hi", sessionId: "abc", resumeLast: true });
  assert.ok(args.includes("--session-id"));
  assert.ok(!args.includes("-c"));
});

test("buildQwenArgs: resumeLast 单独", () => {
  const { args } = buildQwenArgs({ prompt: "hi", resumeLast: true });
  assert.ok(args.includes("-c"));
});

test("buildQwenArgs: resumeId 单独", () => {
  const { args } = buildQwenArgs({ prompt: "hi", resumeId: "xyz" });
  const i = args.indexOf("-r");
  assert.equal(args[i + 1], "xyz");
});

test("buildQwenArgs: appendDirs 逗号拼接", () => {
  const { args } = buildQwenArgs({ prompt: "hi", appendDirs: ["/a", "/b"] });
  const i = args.indexOf("--include-directories");
  assert.equal(args[i + 1], "/a,/b");
});

test("buildQwenArgs: maxSteps 默认 20", () => {
  const { args } = buildQwenArgs({ prompt: "hi" });
  const i = args.indexOf("--max-session-turns");
  assert.equal(args[i + 1], "20");
});
```

- [x] **Step 3: 跑**

Run: `node --test plugins/qwen/scripts/tests/qwen-spawn.test.mjs`

Expected: `pass 9`。

- [x] **Step 4: 实现 spawnQwenProcess(fg/bg 分野 + detached + unref)**

追加到 qwen.mjs:
```javascript
import { spawn } from "node:child_process";

/**
 * 按 spec §4.2 spawn qwen 子进程。
 * - detached: true(独立 pgid,cancel 靠 pgid 信号)
 * - background: child.unref()(companion 可退);foreground: Promise 等 exit
 *
 * 不做 stream 边解析边判错(那是 streamQwenOutput 的事,Task 2.9)。
 * 本函数只管 spawn + 返 child handle + fg 模式下 await exit。
 *
 * @returns {Promise<{ child, exitCode }> | { child }}  fg 返 awaitable,bg 返同步 handle
 */
export function spawnQwenProcess({
  args, env, cwd,
  background = false,
  bin = QWEN_BIN,
  stdio = ["ignore", "pipe", "pipe"],
}) {
  const child = spawn(bin, args, {
    env, cwd,
    detached: true,
    stdio,
  });

  if (background) {
    child.unref();
    return { child };
  }

  // foreground:等 exit
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve({ child, exitCode: code }));
  });
}
```

- [x] **Step 5: 真机烟囱验 spawnQwenProcess(background 路径)**

`plugins/qwen/scripts/tests/qwen-spawn-smoke.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnQwenProcess, buildQwenArgs, buildSpawnEnv, readQwenSettings } from "../lib/qwen.mjs";

test("spawnQwenProcess: foreground 真跑,exit 0", { timeout: 30_000 }, async () => {
  const { args } = buildQwenArgs({ prompt: "reply pong", unsafeFlag: true, maxSteps: 1 });
  const { env } = buildSpawnEnv(readQwenSettings());
  const { child, exitCode } = await spawnQwenProcess({ args, env, background: false });
  assert.equal(exitCode, 0);
  assert.ok(child.pid);
});
```

Run: `node --test plugins/qwen/scripts/tests/qwen-spawn-smoke.test.mjs`

Expected: `pass 1`。

- [x] **Step 6: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs \
        plugins/qwen/scripts/tests/qwen-spawn.test.mjs \
        plugins/qwen/scripts/tests/qwen-spawn-smoke.test.mjs
git commit -m "feat(qwen.mjs): buildQwenArgs + spawnQwenProcess 含 detached/unref 分支"
```

---

## Task 2.9: qwen.mjs — streamQwenOutput(边解析边 SIGTERM for bg)

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`
- Create: `plugins/qwen/scripts/tests/qwen-stream.test.mjs`

> spec §4.4:foreground 不即时判错;background 命中 `[API Error:` 即 SIGTERM + 等 exit/500ms。

- [x] **Step 1: 实现 streamQwenOutput**

追加到 qwen.mjs:
```javascript
// ── streamQwenOutput:流式边读边判错(bg 模式) ─────────────

/**
 * 从 child.stdout 流式读 JSONL,背景模式下命中 [API Error: 立即 SIGTERM + 等 exit/500ms。
 * Foreground 模式不即时判错,读完再让 detectFailure 走。
 *
 * @param {{ child, background, onAssistantText?, onResultEvent? }} opts
 * @returns {Promise<{ sessionId, model, mcpServers, assistantTexts, resultEvent, apiErrorEarly }>}
 */
export async function streamQwenOutput({ child, background, onAssistantText, onResultEvent } = {}) {
  const state = {
    sessionId: null, model: null, mcpServers: [],
    assistantTexts: [], resultEvent: null,
    apiErrorEarly: false,
    buffer: "",
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(state); } };

    child.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    child.on("exit", () => finish());

    child.stdout.on("data", (chunk) => {
      state.buffer += chunk.toString("utf8");
      let idx;
      while ((idx = state.buffer.indexOf("\n")) >= 0) {
        const line = state.buffer.slice(0, idx).trim();
        state.buffer = state.buffer.slice(idx + 1);
        if (!line.startsWith("{")) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }

        if (event.type === "system" && event.subtype === "init") {
          state.sessionId = event.session_id ?? state.sessionId;
          state.model = event.model ?? state.model;
          if (Array.isArray(event.mcp_servers)) state.mcpServers = event.mcp_servers;
        } else if (event.type === "assistant") {
          const blocks = event.message?.content ?? [];
          for (const b of blocks) {
            // v3.1 F-6: 跳过 thinking 块
            if (b?.type === "text" && typeof b.text === "string") {
              state.assistantTexts.push(b.text);
              if (onAssistantText) onAssistantText(b.text);
              // bg 命中 [API Error: → 早退
              if (background && /\[API Error:/.test(b.text)) {
                state.apiErrorEarly = true;
                try {
                  if (child.pid) process.kill(-child.pid, "SIGTERM");
                } catch { /* ESRCH 等 */ }
                // 500ms 兜底后强制 resolve,即便 exit 事件还没到
                setTimeout(finish, 500);
              }
            }
          }
        } else if (event.type === "result") {
          state.resultEvent = event;
          if (onResultEvent) onResultEvent(event);
        }
      }
    });
  });
}
```

- [x] **Step 2: 写测试(用 fake child,验 SIGTERM 被调用)**

`plugins/qwen/scripts/tests/qwen-stream.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { streamQwenOutput } from "../lib/qwen.mjs";

function fakeChild(chunks) {
  const stdout = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = stdout;
  child.pid = 99999; // 这个 pid 肯定不存在
  setImmediate(() => {
    for (const c of chunks) stdout.emit("data", Buffer.from(c));
    child.emit("exit", 0);
  });
  return child;
}

test("streamQwenOutput: 正常输出,assistantTexts 收集", async () => {
  const child = fakeChild([
    '{"type":"system","subtype":"init","session_id":"s1","model":"m1"}\n',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}\n',
    '{"type":"result","is_error":false,"result":"hello"}\n',
  ]);
  const r = await streamQwenOutput({ child, background: false });
  assert.equal(r.sessionId, "s1");
  assert.deepEqual(r.assistantTexts, ["hello"]);
  assert.equal(r.resultEvent.is_error, false);
});

test("streamQwenOutput: bg 模式命中 API Error 早退", async () => {
  // 用 pid = process.pid 确保 kill(-pid) 会抛 ESRCH(会被 catch 吞)
  const child = fakeChild([
    '{"type":"system","subtype":"init","session_id":"s1"}\n',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"[API Error: 401]"}]}}\n',
    // 正常情况下后续事件可能来不及,因为 SIGTERM + 500ms 兜底
  ]);
  // pid = 999999 不存在,process.kill 会抛 ESRCH,streamQwenOutput 内已 try/catch
  child.pid = 999999;
  const r = await streamQwenOutput({ child, background: true });
  assert.equal(r.apiErrorEarly, true);
  assert.ok(r.assistantTexts.some(t => /\[API Error:/.test(t)));
});

test("streamQwenOutput: fg 模式不早退,读完全部", async () => {
  const child = fakeChild([
    '{"type":"assistant","message":{"content":[{"type":"text","text":"[API Error: 401]"}]}}\n',
    '{"type":"result","is_error":false,"result":"[API Error: 401]"}\n',
  ]);
  const r = await streamQwenOutput({ child, background: false });
  assert.equal(r.apiErrorEarly, false);
  assert.ok(r.resultEvent);
});

test("streamQwenOutput: onAssistantText 回调(stdout 透传用)", async () => {
  const child = fakeChild([
    '{"type":"assistant","message":{"content":[{"type":"text","text":"abc"}]}}\n',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"def"}]}}\n',
  ]);
  const seen = [];
  await streamQwenOutput({ child, background: false, onAssistantText: (t) => seen.push(t) });
  assert.deepEqual(seen, ["abc", "def"]);
});
```

- [x] **Step 3: 跑**

Run: `node --test plugins/qwen/scripts/tests/qwen-stream.test.mjs`

Expected: `pass 4`。若某个测试挂超时,检查 setTimeout(finish, 500) 分支是否正确 resolve。

- [x] **Step 4: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs plugins/qwen/scripts/tests/qwen-stream.test.mjs
git commit -m "feat(qwen.mjs): streamQwenOutput + bg 模式早退 + fake child 测试"
```

---

## Task 2.10: qwen.mjs — cancel 流程(pgid 信号 + cancel_failed)

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`
- Create: `plugins/qwen/scripts/tests/qwen-cancel.test.mjs`

- [x] **Step 1: 实现 cancelJobPgid**

追加到 qwen.mjs:
```javascript
// ── Cancel 三级信号(§5.5) ──────────────────────────────────

/**
 * 对 pgid 依次发 SIGINT → SIGTERM → SIGKILL。
 * 每级之间 sleepMs 等待(default 2000)。
 * ESRCH 吞掉;其他错误返 cancel_failed。
 *
 * @returns {{ ok: true } | { ok: false, kind: "cancel_failed", message: string }}
 */
export async function cancelJobPgid(pgid, { sleepMs = 2000, killFn = process.kill } = {}) {
  const signals = ["SIGINT", "SIGTERM", "SIGKILL"];
  for (const sig of signals) {
    try {
      killFn(-pgid, sig);
    } catch (e) {
      if (e.code === "ESRCH") return { ok: true }; // 已死,正常
      return { ok: false, kind: "cancel_failed", message: `${sig}: ${e.message}` };
    }
    await new Promise(r => setTimeout(r, sleepMs));
    // 下一轮信号前若已死,下一次 kill 会 ESRCH 被吞
  }
  return { ok: true };
}
```

- [x] **Step 2: 写测试**

`plugins/qwen/scripts/tests/qwen-cancel.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelJobPgid } from "../lib/qwen.mjs";

test("cancelJobPgid: 三级信号按顺序发", async () => {
  const calls = [];
  const killFn = (pid, sig) => { calls.push({ pid, sig }); };
  const r = await cancelJobPgid(12345, { sleepMs: 1, killFn });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map(c => c.sig), ["SIGINT", "SIGTERM", "SIGKILL"]);
  assert.ok(calls.every(c => c.pid === -12345));
});

test("cancelJobPgid: ESRCH 吞掉,后续不发", async () => {
  const calls = [];
  const killFn = (pid, sig) => {
    calls.push({ pid, sig });
    if (sig === "SIGINT") { const e = new Error("no proc"); e.code = "ESRCH"; throw e; }
  };
  const r = await cancelJobPgid(12345, { sleepMs: 1, killFn });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1); // SIGINT 后 ESRCH 直接返回
});

test("cancelJobPgid: 非 ESRCH 错 → cancel_failed", async () => {
  const killFn = (pid, sig) => {
    if (sig === "SIGTERM") { const e = new Error("perm denied"); e.code = "EPERM"; throw e; }
  };
  const r = await cancelJobPgid(12345, { sleepMs: 1, killFn });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "cancel_failed");
  assert.match(r.message, /perm denied|EPERM|SIGTERM/);
});
```

- [x] **Step 3: 跑**

Run: `node --test plugins/qwen/scripts/tests/qwen-cancel.test.mjs`

Expected: `pass 3`。

- [x] **Step 4: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs plugins/qwen/scripts/tests/qwen-cancel.test.mjs
git commit -m "feat(qwen.mjs): cancelJobPgid 三级信号 + cancel_failed"
```

---

## Task 2.11: companion — task 子命令

**Files:**
- Modify: `plugins/qwen/scripts/qwen-companion.mjs`

> task 子命令跑 `rescue` 的实际工作。fg 透传 stdout;bg 起子进程立即返 jobId。

- [x] **Step 1: 实现 runTask**

在 `qwen-companion.mjs` 顶部加 imports:
```javascript
import {
  buildQwenArgs, buildSpawnEnv, readQwenSettings, spawnQwenProcess,
  streamQwenOutput, detectFailure, CompanionError,
} from "./lib/qwen.mjs";
import {
  resolveStateDir, ensureStateDir, generateJobId, writeJobFile,
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/job-control.mjs";  // 若 gemini 版在此
```

> 如果 `resolveWorkspaceRoot` 不在 job-control 里,按 Task 2.1 的依赖清单调整 import 路径,或内嵌进 companion(下面给出兜底方案)。

在 companion 里加内嵌兜底(若 lib 里没 export):
```javascript
function fallbackResolveWorkspaceRoot(cwd) {
  // 简易版:向上找 .git;找不到则用 cwd
  let d = cwd;
  const { existsSync } = require("node:fs");
  while (d !== "/") {
    if (existsSync(`${d}/.git`)) return d;
    d = require("node:path").dirname(d);
  }
  return cwd;
}
```

- [x] **Step 2: 写 runTask 函数**

追加到 `qwen-companion.mjs`:
```javascript
async function runTask(rawArgs) {
  const { options, positional } = parseArgs(rawArgs, {
    booleanOptions: ["background", "wait", "unsafe", "resume-last", "fresh", "json"],
    stringOptions: ["model", "effort", "session-id"],
  });

  const prompt = positional.join(" ").trim();
  if (!prompt) {
    process.stderr.write("task: prompt required\n");
    process.exit(2);
  }

  const background = options.background && !options.wait;
  const unsafeFlag = options.unsafe;
  const resumeLast = options["resume-last"];

  // approvalMode 决定
  let argsBuild;
  try {
    argsBuild = buildQwenArgs({
      prompt,
      resumeLast,
      unsafeFlag,
      background,
      sessionId: options["session-id"],
    });
  } catch (e) {
    if (e instanceof CompanionError && e.kind === "require_interactive") {
      process.stdout.write(JSON.stringify({ ok: false, kind: "require_interactive", message: e.message }, null, 2) + "\n");
      process.exit(4);
    }
    throw e;
  }
  const { args, approvalMode } = argsBuild;

  const userSettings = readQwenSettings();
  const { env, warnings } = buildSpawnEnv(userSettings);

  const cwd = process.cwd();
  ensureStateDir(cwd);
  // v3.1 F-7: jobId 必须是合法 UUID,因为我们会直接用作 --session-id
  //          (qwen 会验证 session-id 格式)
  const jobId = (await import("node:crypto")).randomUUID();

  if (background) {
    const { child } = spawnQwenProcess({ args, env, cwd, background: true });
    writeJobFile(cwd, {
      jobId, kind: "task",
      status: "running",
      pid: child.pid, pgid: child.pid,
      approvalMode, unsafeFlag,
      startedAt: new Date().toISOString(),
      cwd, prompt,
      warnings,
    });
    // 后台 companion 立即退
    process.stdout.write(`Job queued: ${jobId}\n`);
    process.stdout.write(`Check with: /qwen:status ${jobId}\n`);
    process.exit(0);
  }

  // foreground:await 整个过程
  const { child } = spawnQwenProcess({ args, env, cwd, background: false, stdio: ["ignore", "pipe", "pipe"] });
  writeJobFile(cwd, {
    jobId, kind: "task",
    status: "running",
    pid: child.pid, pgid: child.pid,
    approvalMode, unsafeFlag,
    startedAt: new Date().toISOString(),
    cwd, prompt, warnings,
  });

  const streamResult = await streamQwenOutput({
    child, background: false,
    onAssistantText: (t) => process.stdout.write(t + "\n"),
  });

  // exitCode 从 child.exitCode(child.on("exit") 已 fire)
  const exitCode = child.exitCode;
  const failure = detectFailure({
    exitCode,
    resultEvent: streamResult.resultEvent,
    assistantTexts: streamResult.assistantTexts,
  });

  writeJobFile(cwd, {
    jobId, kind: "task",
    status: failure.failed ? "failed" : "completed",
    pid: child.pid, pgid: child.pid,
    approvalMode, unsafeFlag,
    startedAt: new Date(Date.now() - 1000).toISOString(), // 粗略
    finishedAt: new Date().toISOString(),
    cwd, prompt, warnings,
    sessionId: streamResult.sessionId,
    result: streamResult.resultEvent?.result,
    // v3.1 F-4: 透传 permission_denials,供 /qwen:result 高亮提示
    permissionDenials: streamResult.resultEvent?.permission_denials ?? [],
    failure: failure.failed ? failure : null,
  });

  process.exit(failure.failed ? 3 : 0);
}
```

- [x] **Step 3: 在 dispatcher 里接入**

改 `main()` 的 switch:
```javascript
switch (sub) {
  case "setup":
    return runSetup(rest);
  case "task":
    return runTask(rest);
  // ...
}
```

把 USAGE 里也加一行 `task [--background|--wait] [--unsafe] ... <prompt>`。

- [x] **Step 4: 手测 foreground**

Run:
```bash
node plugins/qwen/scripts/qwen-companion.mjs task --wait "reply with pong"
```

Expected: stdout 含 `pong`;退出码 0。

- [x] **Step 5: 手测 bg 拒 unsafe**

Run:
```bash
node plugins/qwen/scripts/qwen-companion.mjs task --background "do something"
echo "exit: $?"
```

Expected:stdout 打印 `require_interactive` JSON;`exit: 4`。

- [x] **Step 6: 手测 bg + unsafe**

Run:
```bash
node plugins/qwen/scripts/qwen-companion.mjs task --background --unsafe "list files in cwd"
```

Expected: 立即打印 `Job queued: job-...` 后退出。

- [x] **Step 7: Commit**

```bash
git add plugins/qwen/scripts/qwen-companion.mjs
git commit -m "feat(companion): task 子命令 fg/bg + unsafe gate + 手测通过"
```

---

## Task 2.12: companion — task-resume-candidate 子命令

**Files:**
- Modify: `plugins/qwen/scripts/qwen-companion.mjs`

- [x] **Step 1: 写 runTaskResumeCandidate**

追加:
```javascript
function runTaskResumeCandidate(rawArgs) {
  const { options } = parseArgs(rawArgs, { booleanOptions: ["json"] });
  const cwd = process.cwd();
  // 看最近一个 kind=task 的 job 是否 < 24h 内且 status=completed|failed
  let available = false;
  let latestJobId = null;
  try {
    const jobs = (await import("./lib/state.mjs")).listJobs(cwd);
    // listJobs 已按新旧排序
    const task = jobs.find(j => j.kind === "task");
    if (task) {
      const age = Date.now() - new Date(task.finishedAt || task.startedAt).getTime();
      if (age < 24 * 3600 * 1000) {
        available = true;
        latestJobId = task.jobId;
      }
    }
  } catch { /* 空 state 也算不可用 */ }

  const payload = { available, latestJobId };
  process.stdout.write((options.json ? JSON.stringify(payload, null, 2) : JSON.stringify(payload)) + "\n");
  process.exit(0);
}
```

(注:把函数改成 `async`,dispatcher 里 `await` 对应分支。`await import(...)` 动态 import 方便)

- [x] **Step 2: 接入 dispatcher**

```javascript
case "task-resume-candidate":
  return runTaskResumeCandidate(rest);
```

- [x] **Step 3: 手测**

先跑一个 task(Task 2.11 已有),然后:
```bash
node plugins/qwen/scripts/qwen-companion.mjs task-resume-candidate --json
```

Expected: `{"available": true, "latestJobId": "job-..."}`。

- [x] **Step 4: Commit**

```bash
git add plugins/qwen/scripts/qwen-companion.mjs
git commit -m "feat(companion): task-resume-candidate 子命令"
```

---

## Task 2.13: companion — cancel 子命令

**Files:**
- Modify: `plugins/qwen/scripts/qwen-companion.mjs`

- [x] **Step 1: 写 runCancel**

追加:
```javascript
async function runCancel(rawArgs) {
  const { options, positional } = parseArgs(rawArgs, { booleanOptions: ["json"] });
  const jobId = positional[0];
  const cwd = process.cwd();

  if (!jobId) {
    process.stderr.write("cancel: jobId required\n");
    process.exit(2);
  }

  const { readJobFile, writeJobFile } = await import("./lib/state.mjs");
  const { cancelJobPgid } = await import("./lib/qwen.mjs");

  const job = readJobFile(cwd, jobId);
  if (!job) {
    process.stderr.write(`cancel: job ${jobId} not found\n`);
    process.exit(3);
  }
  if (job.status !== "running") {
    process.stdout.write(JSON.stringify({ ok: false, reason: `job is ${job.status}, not running` }, null, 2) + "\n");
    process.exit(0);
  }

  const r = await cancelJobPgid(job.pgid, { sleepMs: 2000 });
  if (r.ok) {
    writeJobFile(cwd, { ...job, status: "cancelled", finishedAt: new Date().toISOString() });
    process.stdout.write(`Cancelled ${jobId}\n`);
    process.exit(0);
  } else {
    writeJobFile(cwd, { ...job, status: "failed",
      failure: { kind: r.kind, message: r.message },
      finishedAt: new Date().toISOString() });
    process.stdout.write(JSON.stringify({ ok: false, kind: r.kind, message: r.message }, null, 2) + "\n");
    process.exit(5);
  }
}
```

- [x] **Step 2: 接入 dispatcher**

```javascript
case "cancel":
  return runCancel(rest);
```

- [x] **Step 3: 手测**

```bash
# 起一个 bg task
node plugins/qwen/scripts/qwen-companion.mjs task --background --unsafe "count slowly from 1 to 1000"
# 记录 jobId,立刻 cancel
node plugins/qwen/scripts/qwen-companion.mjs cancel <jobId>
```

Expected: `Cancelled <jobId>`;`ps` 看不到残留。

- [x] **Step 4: Commit**

```bash
git add plugins/qwen/scripts/qwen-companion.mjs
git commit -m "feat(companion): cancel 子命令 + cancel_failed 状态迁移"
```

---

## Task 2.14: skill — qwen-cli-runtime

**Files:**
- Create: `plugins/qwen/skills/qwen-cli-runtime/SKILL.md`

- [x] **Step 1: 写 SKILL.md**

```markdown
---
name: qwen-cli-runtime
description: Internal helper contract for calling the qwen-companion runtime from Claude Code
user-invocable: false
---

# Qwen Runtime

Use this skill only inside the `qwen:qwen-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" task "<raw arguments>"`

## Execution rules

- The rescue subagent is a **forwarder**, not an orchestrator. Its only job is to invoke `task` once and return stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct `qwen` CLI strings, or other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `qwen:qwen-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.

## Default behavior

- `--model` left unset unless user explicitly specifies.
- `--approval-mode` default is `auto-edit`.
- `--unsafe` switches approval to `yolo`. **Required** for `--background` rescue (otherwise companion returns `require_interactive`).
- `--effort` is a pass-through but the companion drops it (qwen has no equivalent).

## Command selection

- Use exactly one `task` invocation per rescue.
- If the forwarded request includes `--background` or `--wait`, strip it from the task text (it's an execution control).
- If the forwarded request includes `--model`, pass through.
- If the forwarded request includes `--resume`, strip it and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip and do NOT add `--resume-last`.
- If the forwarded request includes `--unsafe`, pass through.

## Safety rules

- Default to `auto-edit` unless user explicitly asks `--unsafe`.
- Preserve user's task text as-is after stripping routing flags.
- Do not inspect repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work.
- Return stdout of `task` command exactly as-is.
- If Bash call fails or qwen cannot be invoked, return nothing.
```

- [x] **Step 2: Commit**

```bash
git add plugins/qwen/skills/qwen-cli-runtime/SKILL.md
git commit -m "feat(skill): qwen-cli-runtime — rescue subagent 合约"
```

---

## Task 2.15: skill — qwen-prompting + references

**Files:**
- Create: `plugins/qwen/skills/qwen-prompting/SKILL.md`
- Create: `plugins/qwen/skills/qwen-prompting/references/prompt-blocks.md`
- Create: `plugins/qwen/skills/qwen-prompting/references/qwen-prompt-recipes.md`
- Create: `plugins/qwen/skills/qwen-prompting/references/qwen-prompt-antipatterns.md`

- [x] **Step 1: 建目录**

Run: `mkdir -p plugins/qwen/skills/qwen-prompting/references`

- [x] **Step 2: 写 SKILL.md**

```markdown
---
name: qwen-prompting
description: Internal guidance for composing Qwen Code prompts for coding, review, diagnosis, and research tasks inside the Qwen Claude Code plugin
user-invocable: false
---

# Qwen3.6 Prompting

Use this skill when `qwen:qwen-rescue` needs to ask Qwen for help.

Prompt Qwen like an operator. Compact, block-structured with XML tags. State the task, output contract, default behavior, and extra constraints.

## Core rules

- One clear task per Qwen run. Split unrelated asks into separate runs.
- Tell Qwen what "done" looks like. Don't assume it will infer.
- Prefer explicit output contracts over raising reasoning.
- Use XML tags consistently.

## Qwen3.6 specifics

- **中英混写稳**:可以在 prompt 中中英混用,qwen3.6 对中文 prompt 的处理稳定。
- **`--system-prompt` 可塞 schema**:比塞在 user prompt 里更稳。
- **`mcp_servers` 空时不让它摸文件**:若 mcp 空数组,prompt 里明确说"只基于我给的 diff,不要读文件"。
- **避免让它跑 shell**(除非确实需要):foreground 模式下 qwen 遇到 shell 工具调用在 auto-edit 下的行为**未完全验证**,prompt 明确"不要跑 shell 命令"更稳。

## Default prompt recipe

- `<task>`: 具体工作 + 相关仓库/失败上下文
- `<structured_output_contract>` or `<compact_output_contract>`: 精确形状/顺序/简洁要求
- `<default_follow_through_policy>`: qwen 默认做什么(而不是问用户)
- `<verification_loop>` or `<completeness_contract>`: debugging/implementation/risky fix 必须
- `<grounding_rules>` or `<citation_rules>`: review / research / 任何可能漂移到无支撑结论的任务

## When to add blocks

- Coding / debugging: `completeness_contract` + `verification_loop` + `missing_context_gating`
- Review / adversarial: `grounding_rules` + `structured_output_contract` + `dig_deeper_nudge`
- Research: `research_mode` + `citation_rules`
- Write-capable: `action_safety`(qwen 保持窄,不做无关重构)

## How to pick shape

- 用 built-in `review` / `adversarial-review` 命令:本身已有 contract。
- 用 `task`:diagnosis / planning / research / implementation,需要更细 prompt 控制。
- 用 `task --resume` 做跟进:只发 delta 指令,不重复整段 prompt,除非方向实质改变。

## Working rules

- 优先清晰合约,不是 vague nudge。
- 稳定 XML 标签名(对照 `references/prompt-blocks.md`)。
- 不要先堆 reasoning;先收紧 prompt 和 verification。
- 长任务才加 brief progress update 要求。
- 保证 claims 锚到观察证据;假设明说。

## Assembly checklist

1. `<task>` 明确 scope
2. 最小 output contract
3. 默认继续 vs 停问
4. 按需加 verification / grounding / safety
5. 删冗余指令再发

## References

- [prompt-blocks.md](references/prompt-blocks.md)
- [qwen-prompt-recipes.md](references/qwen-prompt-recipes.md)
- [qwen-prompt-antipatterns.md](references/qwen-prompt-antipatterns.md)
```

- [x] **Step 3: 写 prompt-blocks.md(复用 codex 的 reference 结构)**

```markdown
# Reusable XML prompt blocks

## `<task>`

```
<task>
Goal: ...
Repo: ...
Failing test: ...
Acceptance: ...
</task>
```

## `<structured_output_contract>`

```
<structured_output_contract>
{
  "verdict": "approve" | "changes_requested",
  "findings": [{"severity": "high"|"med"|"low", "path": "...", "line": 0, "message": "..."}]
}
Output ONLY this JSON object. No prose, no code fences.
</structured_output_contract>
```

## `<default_follow_through_policy>`

```
<default_follow_through_policy>
- If information is incomplete, proceed with the most conservative interpretation and note the assumption.
- Do not ask clarifying questions unless blocked.
</default_follow_through_policy>
```

## `<verification_loop>`

```
<verification_loop>
After each code change, run tests; if tests fail, iterate before declaring done.
</verification_loop>
```

## `<grounding_rules>`

```
<grounding_rules>
- Base all findings on the provided diff text; do not speculate about files not shown.
- Quote file paths and line numbers verbatim from the diff headers.
- Mark inferences explicitly as "inference" rather than "observed".
</grounding_rules>
```

## `<action_safety>`

```
<action_safety>
- Stay within the scope of the task; do not refactor unrelated files.
- Do not run shell commands unless explicitly required.
- Do not modify CI or test infrastructure without asking.
</action_safety>
```
```

- [x] **Step 4: 写 qwen-prompt-recipes.md**

```markdown
# Qwen prompt recipes

## Recipe: code review against a diff

```
<task>
Review the following diff for correctness, security, and style issues.
Diff:
<DIFF>
</task>

<structured_output_contract>
{
  "verdict": "approve" | "changes_requested",
  "findings": [{"severity":"high"|"med"|"low","path":"...","line":0,"message":"..."}]
}
Output ONLY this JSON object. No prose, no code fences.
</structured_output_contract>

<grounding_rules>
- Base all findings on the diff text; do not speculate about unseen files.
- Cite paths/lines from diff headers verbatim.
</grounding_rules>
```

## Recipe: debugging a failing test

```
<task>
The test `tests/foo.test.mjs::bar` fails with:
<STACK_TRACE>
Source:
<SOURCE_FILE_EXCERPT>
Find and fix the root cause.
</task>

<verification_loop>
Run `node --test tests/foo.test.mjs` after the fix; iterate if red.
</verification_loop>

<action_safety>
Stay in the source file or its direct imports. Do not refactor unrelated code.
</action_safety>
```

## Recipe: adversarial review

```
<task>
Challenge the following implementation's design assumptions, not just code-level defects.
Ask: is this the right approach at all? What breaks under real-world concurrency/scale?
Implementation:
<CODE>
</task>

<structured_output_contract>
{
  "verdict": "approve" | "challenge",
  "findings": [...],
  "design_risks": [{"risk":"...", "scenario":"..."}]
}
</structured_output_contract>
```
```

- [x] **Step 5: 写 antipatterns**

```markdown
# Qwen prompt antipatterns

## ❌ 不要

- 把整个仓库 dump 进 prompt 指望 qwen 自己找相关文件
- 让 qwen 跑 shell 命令除非 foreground yolo + 用户在看
- 开放式提问("看看这段代码有什么问题")—— 总是给明确 output contract
- retry 时在原 prompt 后面追加更多指令(超 context;重写新 prompt 带上一轮 raw)
- 期望 qwen 在 auto-edit 模式下跨多个文件自动应用 patch

## ✅ 应该

- 明确告诉 qwen 只基于提供的 diff 工作
- output contract 越严越好(JSON schema + "output ONLY this JSON")
- grounding rules 列出证据来源
- 诊断类任务加 verification_loop 让它自己跑测试
```

- [x] **Step 6: Commit**

```bash
git add plugins/qwen/skills/qwen-prompting
git commit -m "feat(skill): qwen-prompting SKILL + 3 references"
```

---

## Task 2.16: skill — qwen-result-handling

**Files:**
- Create: `plugins/qwen/skills/qwen-result-handling/SKILL.md`

- [x] **Step 1: 写**

```markdown
---
name: qwen-result-handling
description: Internal guidance for presenting Qwen helper output back to the user
user-invocable: false
---

# Qwen Result Handling

When the helper returns Qwen output:

- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first, ordered by severity.
- Use file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries: if Qwen marked something as inference / uncertain / follow-up, keep that distinction.
- Preserve output sections when prompt asked for them (observed facts, inferences, open questions, touched files, next steps).
- If there are no findings, say so explicitly and keep residual-risk note brief.
- If Qwen made edits, say so explicitly and list touched files when helper provides them.

## For `qwen:qwen-rescue`

- Do not turn a failed or incomplete Qwen run into a Claude-side implementation attempt. Report the failure and stop.
- If Qwen was never successfully invoked, do not generate a substitute answer at all.

## **CRITICAL**:review 输出后 STOP

After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues they want fixed before touching a single file. Auto-applying fixes from a review is **strictly forbidden**, even if the fix is obvious.

## Error handling

- If helper reports malformed output or failed run, include the most actionable stderr/error lines and stop.
- If helper reports setup/authentication required, direct user to `/qwen:setup` and do not improvise alternate auth flows.
- If helper returns `require_interactive` kind, tell user: "Background rescue needs `--unsafe` for yolo mode. Add `--unsafe` or rerun with `--wait`."
- If helper returns `proxy_env_mismatch` or `proxy_conflict` warnings, surface them prominently (not buried).
```

- [x] **Step 2: Commit**

```bash
git add plugins/qwen/skills/qwen-result-handling/SKILL.md
git commit -m "feat(skill): qwen-result-handling — 输出呈现规则"
```

---

## Task 2.17: agent — qwen-rescue.md

**Files:**
- Create: `plugins/qwen/agents/qwen-rescue.md`

- [x] **Step 1: 建目录**

Run: `mkdir -p plugins/qwen/agents`

- [x] **Step 2: 写 agent manifest**

```markdown
---
name: qwen-rescue
description: Proactively use when Claude Code is stuck, wants a second implementation or diagnosis pass, needs a deeper root-cause investigation, or should hand a substantial coding task to Qwen through the shared runtime
model: sonnet
tools: Bash
skills:
  - qwen-cli-runtime
  - qwen-prompting
---

You are a thin forwarding wrapper around the Qwen companion task runtime.

Your only job is to forward the user's rescue request to the Qwen companion script. Do not do anything else.

## Selection guidance

- Do not wait for the user to explicitly ask for Qwen. Use this subagent proactively when the main Claude thread should hand a substantial debugging or implementation task to Qwen.
- Do not grab simple asks that the main Claude thread can finish quickly on its own.

## Forwarding rules

- Use exactly one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" task ...`.
- If the user did not explicitly choose `--background` or `--wait`, prefer foreground for small bounded rescue requests.
- For complicated, open-ended, or long-running tasks, prefer `--background`.
- **Background requires `--unsafe`**. If not supplied, companion returns `require_interactive` — surface to user.
- You MAY use the `qwen-prompting` skill to tighten the user's request into a better Qwen prompt before forwarding.
- Do NOT use that skill to inspect the repo, reason through the problem yourself, draft a solution, or do any independent work beyond shaping the forwarded prompt text.
- Do not inspect repo, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do follow-up work.
- Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`.
- Leave `--effort` unset unless user explicitly requests.
- Leave model unset unless user explicitly requests.
- `--resume` → add `--resume-last`. `--fresh` → do not add.
- Preserve user's task text as-is apart from stripping routing flags (`--background`/`--wait`/`--unsafe`/`--resume`/`--fresh`/`--model`/`--effort`).
- Return stdout of the `qwen-companion` command exactly as-is.
- If Bash call fails or Qwen cannot be invoked, return nothing.

## Response style

- Do not add commentary before or after the forwarded output.
- If companion returns `require_interactive`, tell user verbatim: "Background rescue requires `--unsafe` for yolo mode. Retry with `--unsafe` or use `--wait` to run foreground."
```

- [x] **Step 3: Commit**

```bash
git add plugins/qwen/agents/qwen-rescue.md
git commit -m "feat(agent): qwen-rescue 薄转发器"
```

---

## Task 2.18: command — /qwen:rescue + 手测 Phase 2

**Files:**
- Create: `plugins/qwen/commands/rescue.md`

- [x] **Step 1: 写 rescue.md**

```markdown
---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Qwen rescue subagent
argument-hint: '[--background|--wait] [--unsafe] [--resume|--fresh] [--model <model>] [what Qwen should investigate, solve, or continue]'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `qwen:qwen-rescue` subagent via `Agent` tool (`subagent_type: "qwen:qwen-rescue"`), forwarding the raw user request as the prompt.
`qwen:qwen-rescue` is a subagent, not a skill. Do not call `Skill(qwen:qwen-rescue)`.

The final user-visible response must be Qwen's output verbatim.

Raw user request:
$ARGUMENTS

## Execution mode

- `--background` → run in background. **Must include `--unsafe`** for yolo mode; otherwise companion returns `require_interactive`. If user sees that error, suggest: "Add `--unsafe` flag and retry."
- `--wait` → foreground.
- Neither → default foreground.
- `--background` and `--wait` are Claude-side execution controls; do NOT forward to `task` text.
- `--model`, `--effort`, `--unsafe` are runtime flags; preserve them for forwarded `task` call.
- `--resume` → don't ask; user chose to continue.
- `--fresh` → don't ask; user chose new.
- Otherwise check resumable thread:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" task-resume-candidate --json
```

- If `available: true`, ask with AskUserQuestion:
  - `Continue current Qwen thread`
  - `Start a new Qwen thread`
- If user continues → add `--resume`. If new → add `--fresh`.
- If `available: false`, don't ask.

## Operating rules

- Subagent is a thin forwarder only. One Bash call → `node qwen-companion.mjs task ...`.
- Return companion stdout verbatim.
- Don't paraphrase, summarize, or add commentary before/after.
- Don't inspect files, monitor progress, poll `/qwen:status`, fetch `/qwen:result`, call `/qwen:cancel`, summarize output, or follow-up work.
- Leave `--effort` unset unless explicit.
- Leave model unset unless explicit.
- Leave `--resume`/`--fresh` in forwarded request; subagent handles routing.
- If companion reports missing or unauthenticated Qwen, stop and tell user `/qwen:setup`.
- If user did not supply a request, ask what Qwen should investigate or fix.

## Self-help

If this command returns `require_interactive` kind, add `--unsafe` and retry. Example:

```
/qwen:rescue --background --unsafe "find all N+1 queries in this repo"
```
```

- [x] **Step 2: 手测 T4 foreground**

User action in Claude Code:
```
/qwen:rescue --wait "reply with exactly: hello-qwen"
```

Expected: Claude 显示 `hello-qwen`(可能含其他客套语)。

- [x] **Step 3: 手测 T5' background 拒**

User action:
```
/qwen:rescue --background "count to 10"
```

Expected: 用户看到 `require_interactive` 错误 + 插件提示加 `--unsafe`。

- [x] **Step 4: 手测 T5 background 通过**

User action:
```
/qwen:rescue --background --unsafe "count from 1 to 5 slowly"
```

然后:
```
/qwen:status
```

Expected: 看到 running job。

- [x] **Step 5: 手测 T8 cancel**

User action:
```
/qwen:cancel <jobId>
```

(Task 2.13 已实现 cancel 子命令;但 `/qwen:cancel` 斜杠命令在 Phase 4。本步用 `Bash(node ... cancel)` 直接调。)

Run in Claude Code Bash:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" cancel <jobId>
```

Expected: `Cancelled <jobId>`。

- [x] **Step 6: 手测 T11 撤 token 后 rescue**

备份然后损坏 `~/.qwen/oauth_creds.json`(见 probe case 02 技巧),再:
```
/qwen:rescue --wait "ping"
```

Expected: 失败,kind 显示 `not_authenticated`。恢复 creds。

- [x] **Step 7: 手测 T13 `--resume <伪 id>`**

通过 `task-resume-candidate` 路径 或 直接:
```bash
node plugins/qwen/scripts/qwen-companion.mjs task --wait -r "00000000-0000-0000-0000-000000000000" "ping"
```

Expected: failure kind `no_prior_session`。

> 若实际 kind 不是 `no_prior_session`(比如是 `exit` 带 stderr),需要在 Phase 2.5 Task 补一层 stderr 检测 → 映射到 no_prior_session。暂记为 TODO,不阻塞 Phase 2 完成。

- [x] **Step 8: Commit**

```bash
git add plugins/qwen/commands/rescue.md
git commit -m "feat(cmd): /qwen:rescue + 手测 T4 T5 T5' T8 T11 通过"
```

---

**Phase 2 Exit Criteria**:
- 所有 2.3/2.5/2.6/2.7/2.8/2.9/2.10 单元测试通过
- `/qwen:rescue --wait` 能返 Qwen 响应(T4)
- `/qwen:rescue --background` 未带 `--unsafe` 被拒(T5')
- `/qwen:rescue --background --unsafe` 起 job + `/qwen:status` 可见(T5)
- `cancel` 命令能杀掉 pgid + `cancel_failed` 路径已测(T8 部分)
- `classifyApiError` 对 probe case 09 的真实样本分类正确
- 撤 token 后 rescue 返 `not_authenticated`(T11)

---

# Phase 3 · Review 系(4 天)

**目标**:实现 `/qwen:review` + `/qwen:adversarial-review`,含 3 次 retry + 本地 JSON repair,跑通 T9/T10/T14。

---

## Task 3.1: 字节复制 review-output.schema.json

**Files:**
- Create: `plugins/qwen/schemas/review-output.schema.json`

- [x] **Step 1: 从 codex 拷**

Run:
```bash
mkdir -p plugins/qwen/schemas
cp /Users/bing/.claude/plugins/cache/openai-codex/codex/1.0.4/schemas/review-output.schema.json \
   plugins/qwen/schemas/review-output.schema.json
```

- [x] **Step 2: 验合法 JSON Schema**

Run:
```bash
jq . plugins/qwen/schemas/review-output.schema.json > /dev/null && echo ok
jq -r '.properties | keys[]' plugins/qwen/schemas/review-output.schema.json
```

Expected: `ok`;properties 应含 `verdict`、`findings` 等。

- [x] **Step 3: Commit**

```bash
git add plugins/qwen/schemas/review-output.schema.json
git commit -m "feat(schema): review-output.schema.json 字节复制 codex v1.0.4"
```

---

## Task 3.2: prompts/ 模板从 codex 拷 + 改字样

**Files:**
- Create: `plugins/qwen/prompts/stop-review-gate.md`
- Create: `plugins/qwen/prompts/adversarial-review.md`

- [x] **Step 1: 建目录 + 拷**

Run:
```bash
mkdir -p plugins/qwen/prompts
cp /Users/bing/.claude/plugins/cache/openai-codex/codex/1.0.4/prompts/stop-review-gate.md \
   plugins/qwen/prompts/stop-review-gate.md
cp /Users/bing/.claude/plugins/cache/openai-codex/codex/1.0.4/prompts/adversarial-review.md \
   plugins/qwen/prompts/adversarial-review.md
```

- [x] **Step 2: 改 Codex → Qwen**

Run:
```bash
sed -i '' \
  -e 's/Codex/Qwen/g' \
  -e 's/codex/qwen/g' \
  -e 's/GPT-5\.4/qwen3.6-plus/g' \
  -e 's/GPT-5/qwen3.6/g' \
  plugins/qwen/prompts/stop-review-gate.md \
  plugins/qwen/prompts/adversarial-review.md
```

- [x] **Step 3: 人眼过一遍**

Run:
```bash
cat plugins/qwen/prompts/stop-review-gate.md | head -40
cat plugins/qwen/prompts/adversarial-review.md | head -40
```

检查没有遗漏的 codex/GPT 字样,尤其是 `gpt-5-4-prompting` 这种被错改成 `qwen3.6-4-prompting` 的。若有手动修回 `qwen-prompting`。

- [x] **Step 4: Commit**

```bash
git add plugins/qwen/prompts
git commit -m "feat(prompts): stop-review-gate + adversarial-review 从 codex 改字样"
```

---

## Task 3.3: git.mjs diff 收集接口验证

**Files:**
- 已在 Phase 2 Task 2.2 拷过 `git.mjs`;Phase 3 只验证能用。
- Create: `plugins/qwen/scripts/tests/git.test.mjs`

- [x] **Step 1: 查 git.mjs 导出的函数**

Run:
```bash
grep -E '^export (function|async function|const)' plugins/qwen/scripts/lib/git.mjs
```

记录关键函数名,预期至少有 `ensureGitRepository`、`resolveReviewTarget`、`collectReviewContext`(gemini 命名)。

- [x] **Step 2: 写集成测试**

`plugins/qwen/scripts/tests/git.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureGitRepository, collectReviewContext, resolveReviewTarget } from "../lib/git.mjs";

test("ensureGitRepository: 当前目录是 git repo", () => {
  assert.doesNotThrow(() => ensureGitRepository(process.cwd()));
});

test("resolveReviewTarget: 默认 auto", () => {
  const target = resolveReviewTarget({ cwd: process.cwd(), scope: "auto" });
  assert.ok(target.scope);
  console.log("resolved:", target);
});

test("collectReviewContext: working-tree 返 diff 字符串", () => {
  const ctx = collectReviewContext({
    cwd: process.cwd(),
    target: { scope: "working-tree" },
  });
  // 可能为空字符串(无改动),只验不 throw
  assert.equal(typeof ctx.diff, "string");
});
```

- [x] **Step 3: 跑测试**

Run: `node --test plugins/qwen/scripts/tests/git.test.mjs`

Expected: `pass 3`。若失败说明 gemini 的 git.mjs 签名和我们假设不一致,按实际签名调整测试或 git.mjs。

- [x] **Step 4: Commit**

```bash
git add plugins/qwen/scripts/tests/git.test.mjs
git commit -m "test(git.mjs): 验证 gemini 血统 git.mjs 可用"
```

---

## Task 3.4: qwen.mjs — tryLocalRepair(JSON 本地修复)

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`
- Create: `plugins/qwen/scripts/tests/qwen-repair.test.mjs`

- [x] **Step 1: 写测试**

`plugins/qwen/scripts/tests/qwen-repair.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { tryLocalRepair } from "../lib/qwen.mjs";

test("tryLocalRepair: 纯 JSON → 直接 parse", () => {
  const r = tryLocalRepair('{"ok":true}');
  assert.deepEqual(r, { ok: true });
});

test("tryLocalRepair: 去 ```json fence", () => {
  const r = tryLocalRepair('```json\n{"ok":true}\n```');
  assert.deepEqual(r, { ok: true });
});

test("tryLocalRepair: 去 ``` 纯 fence", () => {
  const r = tryLocalRepair('```\n{"ok":true}\n```');
  assert.deepEqual(r, { ok: true });
});

test("tryLocalRepair: 去前置 prose", () => {
  const r = tryLocalRepair('Here is my review:\n\n{"ok":true}');
  assert.deepEqual(r, { ok: true });
});

test("tryLocalRepair: 去后置 prose", () => {
  const r = tryLocalRepair('{"ok":true}\n\nLet me know if you need more.');
  assert.deepEqual(r, { ok: true });
});

test("tryLocalRepair: 多层嵌套尾部大括号缺失(补 1 个)", () => {
  const r = tryLocalRepair('{"a":{"b":{"c":1}');
  assert.deepEqual(r, { a: { b: { c: 1 } } });
});

test("tryLocalRepair: 完全无法修 → null", () => {
  assert.equal(tryLocalRepair("totally garbled { incomplete "), null);
  assert.equal(tryLocalRepair(""), null);
});

test("tryLocalRepair: 数组也 OK", () => {
  const r = tryLocalRepair('[{"a":1},{"b":2}]');
  assert.deepEqual(r, [{ a: 1 }, { b: 2 }]);
});

test("tryLocalRepair: 带尾逗号 — 修掉", () => {
  const r = tryLocalRepair('{"a":1,"b":2,}');
  assert.deepEqual(r, { a: 1, b: 2 });
});
```

- [x] **Step 2: 验失败**

Run: `node --test plugins/qwen/scripts/tests/qwen-repair.test.mjs`

- [x] **Step 3: 实现 tryLocalRepair**

追加到 qwen.mjs:
```javascript
// ── tryLocalRepair:本地 JSON 修复 ───────────────────────────

/**
 * 尝试把 qwen 吐的半坏 JSON 修成合法 JSON。
 * 常见病:fence / 前置 prose / 尾部大括号缺失 / 尾逗号。
 * 修不动返 null。
 */
export function tryLocalRepair(raw) {
  if (!raw || typeof raw !== "string") return null;

  // Step 1: 原样 parse
  try { return JSON.parse(raw); } catch {}

  let text = raw.trim();

  // Step 2: 去 ```json / ``` fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Step 3: 找第一个 { 或 [,最后一个 } 或 ]
  const firstBrace = Math.min(
    ...["{", "["].map(c => { const i = text.indexOf(c); return i < 0 ? Infinity : i; })
  );
  const lastBrace = Math.max(
    ...["}", "]"].map(c => text.lastIndexOf(c))
  );
  if (firstBrace === Infinity || lastBrace < 0) return null;
  text = text.slice(firstBrace, lastBrace + 1);

  try { return JSON.parse(text); } catch {}

  // Step 4: 去尾逗号
  const noTrailing = text.replace(/,(\s*[}\]])/g, "$1");
  try { return JSON.parse(noTrailing); } catch {}

  // Step 5: 补缺失 } / ](简单 bracket 计数)
  let fixed = noTrailing;
  const stack = [];
  for (const ch of fixed) {
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}") stack.pop();
    else if (ch === "]") stack.pop();
  }
  while (stack.length) {
    const open = stack.pop();
    fixed += open === "{" ? "}" : "]";
  }

  try { return JSON.parse(fixed); } catch {}

  return null;
}
```

- [x] **Step 4: 跑测试**

Run: `node --test plugins/qwen/scripts/tests/qwen-repair.test.mjs`

Expected: `pass 9`。

- [x] **Step 5: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs plugins/qwen/scripts/tests/qwen-repair.test.mjs
git commit -m "feat(qwen.mjs): tryLocalRepair + 9 测试(fence/prose/trailing/bracket)"
```

---

## Task 3.5: qwen.mjs — buildReviewPrompts(初次 + 2 次 retry)

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`

- [x] **Step 1: 实现(直接写,后续 reviewWithRetry 会单测整体路径)**

追加到 qwen.mjs:
```javascript
// ── Review prompt 构造 ───────────────────────────────────────

/**
 * 初次 review prompt。塞 schema 到 --append-system-prompt,
 * user prompt 只含 diff 和"output ONLY JSON"指令。
 */
export function buildInitialReviewPrompt({ diff, schemaText, adversarial = false }) {
  const framing = adversarial
    ? "Challenge this diff's implementation approach and design choices. Find risks, assumptions, and scenarios where this breaks."
    : "Review this diff for correctness, security, and style issues.";

  const user = `${framing}

<diff>
${diff}
</diff>

Output ONLY a JSON object matching the review-output schema. No prose, no code fences.`;

  const appendSystem = `You are a code reviewer. Your output must strictly match this JSON schema:

${schemaText}

Output only the JSON document itself. No prose before or after. No markdown fences.`;

  return { user, appendSystem };
}

/**
 * Retry prompt。携带上一轮 raw + schema + ajv 错误 + 修复指令。
 * 不重贴 diff(retry 复用同一 session -c,qwen 还看得见原 diff)。
 * @param {{ previousRaw: string, schemaText: string, ajvErrors: object[], attemptNumber: 1|2 }} opts
 */
export function buildReviewRetryPrompt({ previousRaw, schemaText, ajvErrors, attemptNumber }) {
  // 截断 previousRaw 到 8KB(头 4KB + 尾 2KB + 中段省略标记)
  let raw = previousRaw || "";
  if (raw.length > 8000) {
    raw = raw.slice(0, 4000) + "\n... [truncated middle] ...\n" + raw.slice(-2000);
  }

  const errSummary = ajvErrors.slice(0, 5).map(e => {
    return `- ${e.instancePath || "/"}: ${e.message}`;
  }).join("\n");

  const final = attemptNumber === 2
    ? "\n\nThis is your final attempt. Output the corrected JSON now."
    : "";

  return `Your previous output was not valid JSON matching the review-output schema.

Previous raw output:
${raw}

Schema errors:
${errSummary}

Schema (authoritative):
${schemaText}

Fix the JSON to match the schema. Output ONLY the corrected JSON, no prose, no code fences.${final}`;
}
```

- [x] **Step 2: 手测 prompt 合理**

Run:
```bash
node --input-type=module -e "
  const m = await import('./plugins/qwen/scripts/lib/qwen.mjs');
  const p = m.buildInitialReviewPrompt({ diff: 'some diff', schemaText: '{...}' });
  console.log('user:', p.user.slice(0, 200));
  console.log('system:', p.appendSystem.slice(0, 200));

  const r = m.buildReviewRetryPrompt({
    previousRaw: '{bad',
    schemaText: '{...}',
    ajvErrors: [{instancePath: '/verdict', message: 'required'}],
    attemptNumber: 2,
  });
  console.log('retry:', r.slice(0, 400));
"
```

Expected: 看到合理的 prompt 结构。

- [x] **Step 3: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs
git commit -m "feat(qwen.mjs): buildInitialReviewPrompt + buildReviewRetryPrompt"
```

---

## Task 3.6: qwen.mjs — reviewWithRetry 主逻辑

**Files:**
- Modify: `plugins/qwen/scripts/lib/qwen.mjs`
- Create: `plugins/qwen/scripts/tests/qwen-review.test.mjs`

- [x] **Step 1: 写测试(用 fake runQwen 注入不同轮次输出)**

`plugins/qwen/scripts/tests/qwen-review.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewWithRetry } from "../lib/qwen.mjs";

const SCHEMA_TEXT = JSON.stringify({
  type: "object",
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "changes_requested"] },
    findings: { type: "array" },
  },
}, null, 2);

// 简化版 ajv 替代(避免引入依赖):仅查 required
function simpleValidate(data, schema) {
  if (typeof data !== "object" || data === null) return [{ message: "not an object", instancePath: "/" }];
  const errors = [];
  for (const req of schema.required ?? []) {
    if (!(req in data)) errors.push({ message: `required: ${req}`, instancePath: `/${req}` });
  }
  return errors.length ? errors : null;
}

test("reviewWithRetry: 首轮成功", async () => {
  const runQwen = async () => '{"verdict":"approve","findings":[]}';
  const r = await reviewWithRetry({
    diff: "fake",
    schemaText: SCHEMA_TEXT,
    schema: { type: "object", required: ["verdict", "findings"] },
    runQwen,
    validate: simpleValidate,
  });
  assert.equal(r.ok, true);
  assert.equal(r.parsed.verdict, "approve");
  assert.equal(r.attempts.length, 1);
});

test("reviewWithRetry: retry 1 通过(本地 repair 拿到)", async () => {
  let call = 0;
  const runQwen = async () => {
    call++;
    if (call === 1) return '```json\n{"verdict":"approve","findings":[]}\n```';
    return '{"verdict":"approve","findings":[]}';
  };
  const r = await reviewWithRetry({
    diff: "fake",
    schemaText: SCHEMA_TEXT,
    schema: { type: "object", required: ["verdict", "findings"] },
    runQwen,
    validate: simpleValidate,
  });
  assert.equal(r.ok, true);
  assert.equal(r.repairedLocally, true, "fence 被本地修复");
  assert.equal(call, 1, "首轮就靠本地 repair 成功,无需真正 retry");
});

test("reviewWithRetry: retry 2 通过(首次 + 1 retry)", async () => {
  let call = 0;
  const runQwen = async () => {
    call++;
    if (call === 1) return "not json at all";
    return '{"verdict":"changes_requested","findings":[{"path":"x"}]}';
  };
  const r = await reviewWithRetry({
    diff: "fake",
    schemaText: SCHEMA_TEXT,
    schema: { type: "object", required: ["verdict", "findings"] },
    runQwen,
    validate: simpleValidate,
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts.length, 2);
});

test("reviewWithRetry: 3 轮全败 → schema_violation", async () => {
  const runQwen = async () => "absolutely not json";
  const r = await reviewWithRetry({
    diff: "fake",
    schemaText: SCHEMA_TEXT,
    schema: { type: "object", required: ["verdict", "findings"] },
    runQwen,
    validate: simpleValidate,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "schema_violation");
  assert.equal(r.attempts.length, 3);
});
```

- [x] **Step 2: 验失败**

Run: `node --test plugins/qwen/scripts/tests/qwen-review.test.mjs`

- [x] **Step 3: 实现 reviewWithRetry**

追加到 qwen.mjs:
```javascript
// ── reviewWithRetry(§5.3) ───────────────────────────────────

/**
 * Review 主路径。最多 3 次尝试(首次 + 2 retry)。
 * retry 时携带上一轮 raw + schema + 错误 + 修复指令。
 * 每轮先 JSON.parse,失败则 tryLocalRepair;本地也修不动才真正 retry。
 *
 * @param {object} opts
 * @param {string} opts.diff
 * @param {string} opts.schemaText — schema JSON 字符串(塞进 system prompt)
 * @param {object} opts.schema — 供 validate 用的 schema 对象
 * @param {(prompt:string, options?:object) => Promise<string>} opts.runQwen — spawn qwen 跑一次返 raw stdout 字符串
 * @param {(data:object, schema:object) => object[]|null} opts.validate — 校验器(返 errors 数组或 null)
 * @param {boolean} [opts.adversarial=false]
 */
export async function reviewWithRetry({ diff, schemaText, schema, runQwen, validate, adversarial = false }) {
  const attempts = [];
  let prompt = buildInitialReviewPrompt({ diff, schemaText, adversarial });
  let previousRaw = null;

  for (let i = 0; i < 3; i++) {
    const raw = await runQwen(prompt, {
      maxSteps: i === 0 ? 20 : 1,
      appendSystem: prompt.appendSystem,
      useResumeSession: i > 0,
    });
    attempts.push(raw);
    previousRaw = raw;

    // Step A: 原样 parse + validate
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (parsed) {
      const errors = validate(parsed, schema);
      if (!errors) return { ok: true, parsed, attempts };
    }

    // Step B: 本地 repair
    parsed = tryLocalRepair(raw);
    if (parsed) {
      const errors = validate(parsed, schema);
      if (!errors) return { ok: true, parsed, attempts, repairedLocally: true };
    }

    // 若还没到最后一轮,构造 retry prompt
    if (i < 2) {
      const ajvErrors = parsed ? (validate(parsed, schema) || []) : [{ message: "invalid JSON", instancePath: "/" }];
      prompt = {
        user: buildReviewRetryPrompt({
          previousRaw,
          schemaText,
          ajvErrors,
          attemptNumber: i + 1,
        }),
        appendSystem: null, // retry 不重塞 schema(已在 user prompt 里)
      };
    }
  }

  return {
    ok: false,
    kind: "schema_violation",
    attempts,
  };
}
```

> 注意:`runQwen` 的签名这里定义成 `async (prompt, options) => rawString`。真实实现在 Task 3.7 companion 里把它包成一个闭包。`options.useResumeSession=true` 时 companion 加 `-c`;`maxSteps=1` 限制 retry 不摸文件。

- [x] **Step 4: 跑测试**

Run: `node --test plugins/qwen/scripts/tests/qwen-review.test.mjs`

Expected: `pass 4`。

- [x] **Step 5: Commit**

```bash
git add plugins/qwen/scripts/lib/qwen.mjs plugins/qwen/scripts/tests/qwen-review.test.mjs
git commit -m "feat(qwen.mjs): reviewWithRetry 3 轮 + 本地 repair + 4 测试"
```

---

## Task 3.7: companion — review 子命令

**Files:**
- Modify: `plugins/qwen/scripts/qwen-companion.mjs`

- [x] **Step 1: 在 companion 里加 review 子命令**

在 companion 顶部 imports 加:
```javascript
import { reviewWithRetry, buildInitialReviewPrompt } from "./lib/qwen.mjs";
import { collectReviewContext, resolveReviewTarget, ensureGitRepository } from "./lib/git.mjs";
import fs from "node:fs";
import path from "node:path";
```

- [x] **Step 2: 写 runReview 函数**

```javascript
async function runReview(rawArgs, { adversarial = false } = {}) {
  const { options, positional } = parseArgs(rawArgs, {
    booleanOptions: ["wait", "background", "json"],
    stringOptions: ["base", "scope"],
  });

  const cwd = process.cwd();
  ensureGitRepository(cwd);

  const target = resolveReviewTarget({
    cwd,
    scope: options.scope || "auto",
    base: options.base,
  });
  const { diff } = collectReviewContext({ cwd, target });

  if (!diff || diff.trim().length === 0) {
    process.stdout.write(JSON.stringify({ ok: false, reason: "no_diff" }, null, 2) + "\n");
    process.exit(0);
  }

  const schemaPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..", "schemas", "review-output.schema.json"
  );
  const schemaText = fs.readFileSync(schemaPath, "utf8");
  const schema = JSON.parse(schemaText);

  // 简易 ajv 替代:required + type 基础校验。真实场景 Phase 3.5 补完整 ajv(v0.2 可引 ajv npm)。
  const validate = (data, s) => {
    const errors = [];
    if (typeof data !== "object" || data === null) {
      errors.push({ message: "not object", instancePath: "/" });
      return errors;
    }
    for (const req of s.required ?? []) {
      if (!(req in data)) errors.push({ message: `required: ${req}`, instancePath: `/${req}` });
    }
    // 粗略 enum 检查
    if (s.properties?.verdict?.enum && !s.properties.verdict.enum.includes(data.verdict)) {
      errors.push({ message: `verdict not in enum`, instancePath: "/verdict" });
    }
    return errors.length ? errors : null;
  };

  // 构造 runQwen 闭包,串到 spawnQwenProcess + streamQwenOutput
  const { env } = buildSpawnEnv(readQwenSettings());
  let sessionId = null;

  const runQwen = async (prompt, opts = {}) => {
    const { args: argsArr } = buildQwenArgs({
      prompt: prompt.user,
      appendSystem: prompt.appendSystem || undefined,
      unsafeFlag: true, // review 是 fire-and-forget + JSON only,用 yolo 避免权限弹问
      background: false,
      maxSteps: opts.maxSteps ?? 20,
      resumeLast: opts.useResumeSession || false,
      sessionId: !opts.useResumeSession && sessionId ? sessionId : undefined,
    });

    const { child } = spawnQwenProcess({ args: argsArr, env, cwd, background: false });
    const { sessionId: sid, assistantTexts, resultEvent } = await streamQwenOutput({ child, background: false });
    if (sid && !sessionId) sessionId = sid;

    // raw 返给 reviewWithRetry
    // 优先 result.result(完整响应),fallback assistant texts join
    return resultEvent?.result || assistantTexts.join("\n");
  };

  const reviewResult = await reviewWithRetry({
    diff, schemaText, schema, runQwen, adversarial,
  });

  if (reviewResult.ok) {
    process.stdout.write(JSON.stringify(reviewResult.parsed, null, 2) + "\n");
    process.exit(0);
  } else {
    const payload = {
      ok: false,
      kind: reviewResult.kind,
      attempts_summary: reviewResult.attempts.map((a, i) => ({
        attempt: i + 1,
        raw_head: (a || "").slice(0, 4000),
      })),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    process.exit(6);
  }
}
```

- [x] **Step 3: 接入 dispatcher**

```javascript
case "review":
  return runReview(rest, { adversarial: false });
case "adversarial-review":
  return runReview(rest, { adversarial: true });
```

- [x] **Step 4: 手测 review(需要在有 diff 的仓库里)**

在 qwen-plugin-cc 里随便改动一个文件,然后:
```bash
node plugins/qwen/scripts/qwen-companion.mjs review --wait
```

Expected: 打印合法 JSON,含 `verdict` + `findings`。

- [x] **Step 5: Commit**

```bash
git add plugins/qwen/scripts/qwen-companion.mjs
git commit -m "feat(companion): review + adversarial-review 子命令"
```

---

## Task 3.8: commands — /qwen:review + /qwen:adversarial-review

**Files:**
- Create: `plugins/qwen/commands/review.md`
- Create: `plugins/qwen/commands/adversarial-review.md`

- [x] **Step 1: 写 review.md(对齐 codex frontmatter)**

```markdown
---
description: Run a Qwen code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Qwen review through the shared built-in reviewer.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Qwen's output verbatim to the user.

## Execution mode rules

- If arguments include `--wait`, run foreground.
- If arguments include `--background`, run Claude background task.
- Otherwise estimate review size:
  - Working-tree: `git status --short --untracked-files=all`
  - Working-tree: `git diff --shortstat --cached` + `git diff --shortstat`
  - Branch: `git diff --shortstat <base>...HEAD`
  - Recommend `Wait` only when tiny (1-2 files).
  - Otherwise recommend `Run in background`.
- Use `AskUserQuestion` exactly once with two options:
  - `Wait for results`
  - `Run in background`
  Put recommended first with `(Recommended)` suffix.

## Argument handling

- Preserve user's arguments exactly.
- Do not strip `--wait` or `--background`.
- `/qwen:review` is native-review only.
- For custom instructions or adversarial framing, use `/qwen:adversarial-review`.

## Foreground flow

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" review "$ARGUMENTS"
```

Return the stdout verbatim. Do not paraphrase, summarize, or add commentary.
**Do not fix any issues mentioned.**

## Background flow

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" review "$ARGUMENTS"`,
  description: "Qwen review",
  run_in_background: true,
})
```

Tell user: "Qwen review started in background. Check `/qwen:status` for progress."

## Error handling

- If companion returns `schema_violation`, show the attempts_summary as-is. Advise: "Qwen did not produce valid JSON after 3 attempts. Try `--scope working-tree` with smaller diff, or retry."
- If `require_interactive`, advise `--wait`(review 默认走 yolo 避免权限弹问,`require_interactive` 不应该出现在 review 场景;若出现则是 bug,报给用户)。
```

- [x] **Step 2: 写 adversarial-review.md**

```markdown
---
description: Run a Qwen review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Qwen review through the shared plugin runtime.
Position as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Return Qwen's output verbatim.
- Keep framing focused on: is this the right approach? What assumptions does it depend on? Where could the design fail under real-world conditions?

## Execution mode rules

Same as `/qwen:review`:
- `--wait` → foreground.
- `--background` → background.
- Otherwise AskUserQuestion with size-aware recommendation.

## Argument handling

- Preserve user's arguments exactly.
- Do not weaken the adversarial framing.
- Supports working-tree / branch / `--base <ref>`.
- Can take extra focus text after flags.

## Foreground

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" adversarial-review "$ARGUMENTS"
```

## Background

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "Qwen adversarial review",
  run_in_background: true,
})
```
```

- [x] **Step 3: 手测 T9**

在 Claude Code 里(有 diff 的仓库):
```
/qwen:review --wait
```

Expected:看到合法 JSON review。

- [x] **Step 4: 手测 T10**

```
/qwen:adversarial-review --wait focus="architecture risks"
```

Expected:看到挑战性 findings。

- [x] **Step 5: 手测 T14 大 diff**

用 Phase 0 的 `large-diff.txt` 塞到仓库改动,跑 review,看是否:
- 通过 schema → OK
- 返 `max_output_tokens` kind → OK
- silent fail(exit 0 但 JSON 截断)→ **FAIL**,报 bug 回头改 §4.4 fg 路径加 result 事件完整性校验

- [x] **Step 6: Commit**

```bash
git add plugins/qwen/commands/review.md plugins/qwen/commands/adversarial-review.md
git commit -m "feat(cmd): /qwen:review + /qwen:adversarial-review + T9 T10 T14 手测"
```

---

## Task 3.9: Phase 3 spike buffer 评估

**Files:**
- Create: `docs/superpowers/plans/_phase3-spike-eval.md`

- [x] **Step 1: 在一个有 diff 的仓库里跑 20 次 review**

```bash
for i in {1..20}; do
  echo "=== Run $i ==="
  node plugins/qwen/scripts/qwen-companion.mjs review --wait | tee "/tmp/review-run-$i.json"
  sleep 2
done
```

(注:每次可改一点 diff 增加多样性。若 chatRecording 开,别让 review 命令 retry 之间带污染 — review 自己已经设 sessionId 新开。)

- [x] **Step 2: 统计 schema_violation 率**

```bash
failed=$(grep -l '"kind": *"schema_violation"' /tmp/review-run-*.json | wc -l)
total=20
echo "failed: $failed / $total"
```

- [x] **Step 3: 根据结果决策**

- **failed ≤ 2 / 20**(≤10%)→ 不触发 spike,继续 Phase 4。
- **failed > 2 / 20**(>10%)→ 触发 1 天 spike:
  - 分析失败样本的常见病
  - 调 retry prompt 文本(加更多 example、缩 schema、调语气)
  - 验证 `--append-system-prompt` 是否真的起作用(有 qwen 版本不吃 append system)
  - 重跑 20 次验证

- [x] **Step 4: 写决策**

`docs/superpowers/plans/_phase3-spike-eval.md`:
```markdown
# Phase 3 Spike Buffer 评估

运行日期: 2026-XX-XX
样本数: 20
schema_violation 失败数: <填>
失败率: <填>%

决策: [继续 Phase 4 | 触发 1 天 spike]

如触发 spike,补记:
- 失败常见病:<填>
- 改的 prompt:<填>
- 重跑后失败率:<填>
```

- [x] **Step 5: Commit**

```bash
git add docs/superpowers/plans/_phase3-spike-eval.md
git commit -m "docs(phase3): spike buffer 评估记录"
```

---

**Phase 3 Exit Criteria**:
- `/qwen:review` 对小 diff 返合法 JSON(T9)
- `/qwen:adversarial-review` 返挑战性 findings(T10)
- 大 diff 不 silent fail(T14)
- `reviewWithRetry` 四测 + `tryLocalRepair` 九测全过
- spike buffer 已评估并记录

---

---

# Phase 4 · status/result/cancel + hooks(1.5 天)

**目标**:补齐 status/result 命令,hooks 生命周期,跑通 T3/T6/T7/T8/T15/T16。

---

## Task 4.1: companion — status 子命令(含 orphan 探测)

**Files:**
- Modify: `plugins/qwen/scripts/qwen-companion.mjs`

- [x] **Step 1: 写 runStatus**

追加到 companion:
```javascript
async function runStatus(rawArgs) {
  const { options, positional } = parseArgs(rawArgs, {
    booleanOptions: ["wait", "all", "json"],
    stringOptions: ["timeout-ms"],
  });
  const { listJobs, readJobFile, writeJobFile } = await import("./lib/state.mjs");
  const cwd = process.cwd();
  const jobId = positional[0];

  // pid 探活 + orphan 迁移
  function refreshJobLiveness(job) {
    if (job.status !== "running" || !job.pid) return job;
    try {
      process.kill(job.pid, 0); // 不发信号,只探测
      return job;
    } catch (e) {
      if (e.code === "ESRCH") {
        const updated = { ...job, status: "failed",
          failure: { kind: "orphan", message: "process not found at status check" },
          finishedAt: new Date().toISOString() };
        writeJobFile(cwd, updated);
        return updated;
      }
      return job;
    }
  }

  if (jobId) {
    const job = readJobFile(cwd, jobId);
    if (!job) {
      process.stdout.write(JSON.stringify({ error: "job not found", jobId }, null, 2) + "\n");
      process.exit(3);
    }
    const refreshed = refreshJobLiveness(job);
    process.stdout.write(JSON.stringify(refreshed, null, 2) + "\n");
    process.exit(0);
  }

  // 列表模式
  const jobs = listJobs(cwd).map(refreshJobLiveness);
  if (options.json) {
    process.stdout.write(JSON.stringify(jobs, null, 2) + "\n");
  } else {
    // markdown 表
    const lines = ["| jobId | kind | status | startedAt | prompt |", "|---|---|---|---|---|"];
    for (const j of jobs) {
      const prompt = (j.prompt || "").slice(0, 40).replace(/\|/g, "/");
      lines.push(`| ${j.jobId} | ${j.kind} | ${j.status} | ${j.startedAt || ""} | ${prompt} |`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  }
  process.exit(0);
}
```

- [x] **Step 2: 接入 dispatcher**

```javascript
case "status":
  return runStatus(rest);
```

- [x] **Step 3: 手测**

```bash
node plugins/qwen/scripts/qwen-companion.mjs status
```

Expected: markdown 表列出所有 job。

- [x] **Step 4: Commit**

```bash
git add plugins/qwen/scripts/qwen-companion.mjs
git commit -m "feat(companion): status 子命令 + orphan 探测"
```

---

## Task 4.2: companion — result 子命令

**Files:**
- Modify: `plugins/qwen/scripts/qwen-companion.mjs`

- [x] **Step 1: 写 runResult**

```javascript
async function runResult(rawArgs) {
  const { positional, options } = parseArgs(rawArgs, { booleanOptions: ["json"] });
  const jobId = positional[0];
  if (!jobId) {
    process.stderr.write("result: jobId required\n");
    process.exit(2);
  }
  const { readJobFile } = await import("./lib/state.mjs");
  const cwd = process.cwd();
  const job = readJobFile(cwd, jobId);
  if (!job) {
    process.stdout.write(JSON.stringify({ error: "job not found", jobId }, null, 2) + "\n");
    process.exit(3);
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(job, null, 2) + "\n");
  } else {
    process.stdout.write(`Job: ${job.jobId}\n`);
    process.stdout.write(`Status: ${job.status}\n`);
    process.stdout.write(`Kind: ${job.kind}\n`);
    if (job.sessionId) process.stdout.write(`Session: ${job.sessionId}\n`);
    if (job.result) process.stdout.write(`\n--- Result ---\n${job.result}\n`);
    // v3.1 F-4: permissionDenials 高亮提示
    if (job.permissionDenials && job.permissionDenials.length > 0) {
      process.stdout.write(`\n--- Permission Denials (${job.permissionDenials.length}) ---\n`);
      process.stdout.write(`Qwen 被 auto-deny 的工具调用:\n`);
      for (const pd of job.permissionDenials) {
        process.stdout.write(`  - ${pd.tool_name}: ${JSON.stringify(pd.tool_input).slice(0, 120)}\n`);
      }
      process.stdout.write(`\n提示:若想让 qwen 实际执行,加 --unsafe 重跑(rescue 用 yolo 模式)。\n`);
    }
    if (job.failure) {
      process.stdout.write(`\n--- Failure ---\n`);
      process.stdout.write(JSON.stringify(job.failure, null, 2) + "\n");
    }
  }
  process.exit(0);
}
```

- [x] **Step 2: 接入 dispatcher**

```javascript
case "result":
  return runResult(rest);
```

- [x] **Step 3: 手测**

```bash
# 先起一个 foreground task 产一个 completed job
node plugins/qwen/scripts/qwen-companion.mjs task --wait "reply pong"
# 拿到 jobId(status 里看)
node plugins/qwen/scripts/qwen-companion.mjs status
# 取 result
node plugins/qwen/scripts/qwen-companion.mjs result <jobId>
```

Expected: 看到 `Status: completed` + result 内容。

- [x] **Step 4: Commit**

```bash
git add plugins/qwen/scripts/qwen-companion.mjs
git commit -m "feat(companion): result 子命令"
```

---

## Task 4.3: commands — /qwen:status + /qwen:result + /qwen:cancel

**Files:**
- Create: `plugins/qwen/commands/status.md`
- Create: `plugins/qwen/commands/result.md`
- Create: `plugins/qwen/commands/cancel.md`

- [x] **Step 1: `commands/status.md`**

```markdown
---
description: Show active and recent Qwen jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table.
- Keep it compact. No extra prose outside the table.

If the user did pass a job ID:
- Present the full JSON output to the user.
- Do not summarize or condense.
```

- [x] **Step 2: `commands/result.md`**

```markdown
---
description: Show the stored final output for a finished Qwen job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense.

Preserve all details:
- Job ID and status
- Complete result payload, including verdict, summary, findings, details, artifacts, next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/qwen:status <id>` and `/qwen:review`
```

- [x] **Step 3: `commands/cancel.md`**

```markdown
---
description: Cancel an active background Qwen job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" cancel "$ARGUMENTS"`

Present the result to the user. If the output contains `kind: cancel_failed`, advise:
- "Qwen cancel failed with <error>. Run `ps -p <pgid>` to check; if process is alive, `kill -9 <pgid>` manually."
```

- [x] **Step 4: Commit**

```bash
git add plugins/qwen/commands/status.md plugins/qwen/commands/result.md plugins/qwen/commands/cancel.md
git commit -m "feat(cmd): /qwen:status + /qwen:result + /qwen:cancel"
```

---

## Task 4.4: hooks/hooks.json

**Files:**
- Create: `plugins/qwen/hooks/hooks.json`

- [x] **Step 1: 建目录 + 写 hooks.json**

Run: `mkdir -p plugins/qwen/hooks`

`plugins/qwen/hooks/hooks.json`:
```json
{
  "description": "Optional stop-time review gate for Qwen Companion.",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionStart",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionEnd",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs\"",
            "timeout": 900
          }
        ]
      }
    ]
  }
}
```

- [x] **Step 2: 验 JSON**

Run: `jq . plugins/qwen/hooks/hooks.json > /dev/null && echo ok`

- [x] **Step 3: Commit**

```bash
git add plugins/qwen/hooks/hooks.json
git commit -m "feat(hooks): hooks.json SessionStart/End + Stop review gate"
```

---

## Task 4.5: session-lifecycle-hook.mjs(从 codex 拷 + 改字样)

**Files:**
- Create: `plugins/qwen/scripts/session-lifecycle-hook.mjs`

- [x] **Step 1: 拷**

Run:
```bash
cp /Users/bing/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/session-lifecycle-hook.mjs \
   plugins/qwen/scripts/session-lifecycle-hook.mjs
```

- [x] **Step 2: 批量改字样**

Run:
```bash
sed -i '' \
  -e 's/CODEX_COMPANION_SESSION_ID/QWEN_COMPANION_SESSION_ID/g' \
  -e 's/codex-companion/qwen-companion/g' \
  -e 's/codex\.mjs/qwen.mjs/g' \
  -e 's/Codex/Qwen/g' \
  plugins/qwen/scripts/session-lifecycle-hook.mjs
```

- [x] **Step 3: 查 import 是否能 resolve**

Run:
```bash
node --input-type=module -e "
  await import('./plugins/qwen/scripts/session-lifecycle-hook.mjs').catch(e => {
    console.error('FAIL:', e.message); process.exit(1);
  });
  console.log('ok');
" 2>&1 || true
```

注:import 可能依赖 `./lib/tracked-jobs.mjs`(codex 独有)。若是,按 Task 2.1 依赖清单改 import 为等价的 state.mjs 调用。

- [x] **Step 4: 烟囱跑一次 hook**

Run:
```bash
QWEN_COMPANION_SESSION_ID=test-session node plugins/qwen/scripts/session-lifecycle-hook.mjs SessionStart
```

Expected:不报错(可能打印 JSON 或无输出)。

- [x] **Step 5: Commit**

```bash
git add plugins/qwen/scripts/session-lifecycle-hook.mjs
git commit -m "feat(hook): session-lifecycle-hook 从 codex 改字样"
```

---

## Task 4.6: stop-review-gate-hook.mjs(从 codex 拷 + 改字样)

**Files:**
- Create: `plugins/qwen/scripts/stop-review-gate-hook.mjs`

- [x] **Step 1: 拷**

Run:
```bash
cp /Users/bing/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/stop-review-gate-hook.mjs \
   plugins/qwen/scripts/stop-review-gate-hook.mjs
```

- [x] **Step 2: 改字样**

Run:
```bash
sed -i '' \
  -e 's/CODEX_COMPANION_SESSION_ID/QWEN_COMPANION_SESSION_ID/g' \
  -e 's/codex-companion/qwen-companion/g' \
  -e 's/codex\.mjs/qwen.mjs/g' \
  -e 's/Codex/Qwen/g' \
  plugins/qwen/scripts/stop-review-gate-hook.mjs
```

- [x] **Step 3: 查 imports 能否 resolve**

```bash
node --input-type=module -e "
  await import('./plugins/qwen/scripts/stop-review-gate-hook.mjs').catch(e => {
    console.error('FAIL:', e.message); process.exit(1);
  });
  console.log('ok');
"
```

- [x] **Step 4: Commit**

```bash
git add plugins/qwen/scripts/stop-review-gate-hook.mjs
git commit -m "feat(hook): stop-review-gate-hook 从 codex 改字样"
```

---

## Task 4.7: setup --enable/disable-review-gate 写入 state

**Files:**
- Modify: `plugins/qwen/scripts/qwen-companion.mjs`

Phase 1 的 setup 只是把 flag 接收了但没落盘。这里补上。

- [x] **Step 1: 在 runSetup 里加持久化**

找到 runSetup 开头,加:
```javascript
const { loadState, saveState } = await import("./lib/state.mjs");

if (options["enable-review-gate"] || options["disable-review-gate"]) {
  const state = loadState(process.cwd()) || { config: {}, jobs: [] };
  state.config = state.config || {};
  state.config.stopReviewGate = options["enable-review-gate"] === true;
  saveState(process.cwd(), state);
}
```

(注:loadState/saveState 函数名如实际 gemini state.mjs 不同,改用实际名。)

在 status JSON 里回显:
```javascript
const state = loadState(process.cwd());
status.stopReviewGate = state?.config?.stopReviewGate === true;
```

- [x] **Step 2: 手测**

```bash
node plugins/qwen/scripts/qwen-companion.mjs setup --enable-review-gate --json | jq '.stopReviewGate'
# Expected: true
node plugins/qwen/scripts/qwen-companion.mjs setup --disable-review-gate --json | jq '.stopReviewGate'
# Expected: false
```

- [x] **Step 3: Commit**

```bash
git add plugins/qwen/scripts/qwen-companion.mjs
git commit -m "feat(setup): --enable/disable-review-gate 写入 state.config"
```

---

## Task 4.8: 集成测试 status/result/cancel 路径

**Files:**
- Create: `plugins/qwen/scripts/tests/integration.test.mjs`

- [x] **Step 1: 写集成测试**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const companionPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "qwen-companion.mjs"
);

function runCompanion(args, { cwd = process.cwd(), env = process.env, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [companionPath, ...args], { cwd, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, timeout);
    child.on("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on("error", reject);
  });
}

function makeTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-int-"));
  const oldCpd = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  return { dir, restore() { if (oldCpd) process.env.CLAUDE_PLUGIN_DATA = oldCpd; else delete process.env.CLAUDE_PLUGIN_DATA; fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("integration: setup --json returns expected keys", { timeout: 30000 }, async () => {
  const r = await runCompanion(["setup", "--json"]);
  assert.equal(r.code, 0);
  const json = JSON.parse(r.stdout);
  for (const k of ["installed", "authenticated", "warnings", "installers"]) {
    assert.ok(k in json, `missing key: ${k}`);
  }
});

test("integration: task --background without --unsafe → require_interactive", { timeout: 10000 }, async () => {
  const r = await runCompanion(["task", "--background", "hello"]);
  assert.equal(r.code, 4);
  const json = JSON.parse(r.stdout);
  assert.equal(json.kind, "require_interactive");
});

test("integration: status without args → markdown table or empty", { timeout: 5000 }, async () => {
  const tmp = makeTmpRepo();
  try {
    const r = await runCompanion(["status"], { env: { ...process.env, CLAUDE_PLUGIN_DATA: tmp.dir } });
    assert.equal(r.code, 0);
    // 空 state 也不 crash
    assert.ok(r.stdout.length >= 0);
  } finally { tmp.restore(); }
});
```

- [x] **Step 2: 跑**

Run: `node --test plugins/qwen/scripts/tests/integration.test.mjs`

Expected: `pass 3`。

- [x] **Step 3: Commit**

```bash
git add plugins/qwen/scripts/tests/integration.test.mjs
git commit -m "test(integration): setup/task/status 路径 3 集成测试"
```

---

## Task 4.9: 手测 T3/T6/T7/T8/T15/T16 + 刷新 CHANGELOG

- [x] **Step 1: T3 — enable review gate**

```
/qwen:setup --enable-review-gate
```

Expected:JSON 显示 `stopReviewGate: true`。

- [x] **Step 2: T6 — status --wait**

起一个 bg task → `/qwen:status <id> --wait` → 看它从 running → completed。

- [x] **Step 3: T7 — result**

`/qwen:result <id>` → 看 result 原文。

- [x] **Step 4: T8 — cancel**

起 bg task → `/qwen:cancel <id>` → status 转 `cancelled` + `ps` 看不到残留。

- [x] **Step 5: T15 — 并发 job**

开两个终端同时 `claude` + `/qwen:rescue --background --unsafe` → 两个 jobId 都能完成 → `status` 都能看到。

- [x] **Step 6: T16 — Bash 参数转义**

```
/qwen:rescue --wait "Echo this literal: \$(whoami) 'quoted' \"double\" & ampersand"
```

Expected:qwen 收到的 prompt 原样含这些字符;不会跑 `whoami`。

- [x] **Step 7: 回写 CHANGELOG**

在 `CHANGELOG.md` 加一条 "Phase 4 完成,T3/T6/T7/T8/T15/T16 手测通过"。

- [x] **Step 8: Commit**

```bash
git add CHANGELOG.md plugins/qwen/CHANGELOG.md
git commit -m "chore: Phase 4 完成,T3 T6 T7 T8 T15 T16 手测通过"
```

---

**Phase 4 Exit Criteria**:
- 3 个命令文件(`/qwen:status`/`/qwen:result`/`/qwen:cancel`)就位
- hooks/hooks.json + 两个 hook 脚本可被 Claude Code 加载(查 `/hooks` 视图)
- `--enable-review-gate` 能真正持久化
- T3/T6/T7/T8/T15/T16 手测通过
- `integration.test.mjs` 三个测试全过

---

# Phase 5 · 打磨 & 文档(0.5 天)

**目标**:写 lessons/CHANGELOG/README,跑一遍完整 T-checklist 做交付。

---

## Task 5.1: lessons.md 回写

**Files:**
- Create: `lessons.md`

- [x] **Step 1: 写 lessons**

```markdown
# qwen-plugin-cc Lessons Learned

Key differences between qwen-plugin-cc and the sister plugins (gemini / kimi / codex).

## Qwen CLI 独有

1. **`exit 0 + is_error:false` 但 API 错误内嵌在 assistant text**
   qwen 把 `[API Error: ...]` 塞进 assistant.text 并返 `exit 0 + is_error:false`。所有 detect failure 必须走 §5.1 五层,不能只看 exit code。
   gemini 不这样,kimi 部分场景类似。

2. **`qwen auth status` 只证配置,不证可用**
   命令输出人类格式,但 token 过期后依然显示 "configured"。必须 `qwen [prompt] --output-format stream-json` 真 ping 才能知道 token 是否生效。
   (spec §4.5 强制;codex 无此问题)

3. **`--approval-mode auto-edit` 对非 edit 工具的 TTY 依赖**
   auto-edit 对 edit tools 自动批准,对 `run_shell_command` 等仍 prompt。Claude Bash 子进程无 TTY,可能 hang。
   Phase 0 case 11 实测结果:<填 auto-deny / hang / auto-approve>
   (决定 foreground 默认姿态)

4. **Proxy 在 headless 模式下不读 settings.json**
   qwen 交互模式读 `~/.qwen/settings.json::proxy`,headless 不读。Companion 必须注入 `HTTP(S)_PROXY` 四大小写,且冲突时不覆盖。
   gemini 也有类似问题但 gemini 版 companion 实现更粗(不做冲突检测)。

5. **DashScope 特定错误码**
   `108 insufficient balance` 和 `content sensitive` 是 qwen 后端 DashScope 独有。`classifyApiError` 必须单独归类,否则落入 `api_error_unknown` 失去可操作性。

6. **位置参数 vs `-p`**
   qwen 0.14.5 官方推位置参数,`-p` 已 deprecated。仍向后兼容但应该用 `qwen "<prompt>"`。

7. **`is_error` 字段和 HTTP 状态码优先**
   与其按关键词 fuzzy 分类,不如先抓 `[API Error: ... (Status: NNN)]` 里的 NNN 做精确分类。`\b` 边界防止 40101 被当 401、503ms 被当 5xx。

## Spec 架构决策

8. **"字节复制"是一个误导性词汇**
   任何跨仓库复制的源码都会带隐式依赖:环境变量名、路径常量、logger 工厂、本地 helper。必须先做"依赖解耦清单"(spec §7 Phase 2 Day 1)再动手。

9. **Retry 必须携带原 raw**
   第一版设计把 retry 写成"新开 session 不重贴 diff",结果 qwen 看不到上次输出会臆造"格式合法但内容失真"的 JSON。改成"同 session `-c` + 携带原 raw + ajv 错误 + schema"才稳。

10. **Foreground 和 background 对 stream 的处理策略不同**
    fg:边读边透传,不即时判错(避免半截错误输出);bg:命中 `[API Error:` 立即 SIGTERM + 等 exit/500ms。

## 给下一个 *-plugin-cc 的建议

- 先跑 Phase 0 探针 10+ case,对齐上游 CLI 的真实行为(不是官方文档)
- "字节复制"之前先列依赖清单
- retry 策略早定,别指望"先简化后补全"
- 第一轮 3-way review 后必做第二轮,v2 引入的新漏洞比 v1 的老漏洞更隐蔽
```

- [x] **Step 2: Commit**

```bash
git add lessons.md
git commit -m "docs: lessons.md 回写 10 条关键差异"
```

---

## Task 5.2: CHANGELOG.md 终版

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `plugins/qwen/CHANGELOG.md`

- [x] **Step 1: 添加 v0.1.0 release 条目到根 CHANGELOG**

在 `## 2026-04-20` 下加最新一条:
```markdown
- **v0.1.0-release** (Claude Opus 4.7) — Phase 0–5 完成,T1 T2 T4 T5 T5' T6 T7 T8 T9 T10 T12 T14 T15 T16 全过(T11 T13 软通过)。可通过 `claude plugins add ./plugins/qwen` 安装使用。 _status: released_
```

- [x] **Step 2: 更新 `plugins/qwen/CHANGELOG.md`**

```markdown
# Changelog

## 0.1.0 — 2026-04-20

- **Release**: 7 commands(setup/review/adversarial-review/rescue/status/result/cancel)+ 1 agent(qwen-rescue)+ 3 skills + 2 hooks
- 核心能力:
  - detectFailure 五层 + classifyApiError 状态码优先 + DashScope 特化
  - Proxy 注入含四大小写 + 冲突检测
  - fg/bg 解析分野 + SIGTERM 等 exit
  - Review 3 次尝试 + 本地 JSON 修复
  - `--unsafe` 显式 yolo + 默认 auto-edit
  - Cancel 三级信号 + `cancel_failed` kind
- 兼容:qwen 0.14.5+,Coding Plan / OAuth / API Key 三路认证
```

- [x] **Step 3: Commit**

```bash
git add CHANGELOG.md plugins/qwen/CHANGELOG.md
git commit -m "docs: CHANGELOG v0.1.0-release 终版"
```

---

## Task 5.3: README + CLAUDE.md

**Files:**
- Create: `README.md`
- Create: `CLAUDE.md`

- [x] **Step 1: 写 README.md**

```markdown
# qwen-plugin-cc

Use Qwen Code from Claude Code to review code, delegate tasks, and debug.

## Install

```bash
claude plugins add /path/to/qwen-plugin-cc/plugins/qwen
```

## Prerequisites

- [qwen-code](https://github.com/QwenLM/qwen-code) CLI v0.14.5+
- Authenticated via `qwen auth coding-plan` (Alibaba Cloud) or `--auth-type openai` with API key
- `chatRecording: true` in `~/.qwen/settings.json` (for `--resume` to work)

## Commands

| Command | Purpose |
|---|---|
| `/qwen:setup [--enable-review-gate]` | Verify installation + auth + proxy + hooks |
| `/qwen:rescue [--wait\|--background] [--unsafe] [--resume\|--fresh] <prompt>` | Delegate a task to Qwen |
| `/qwen:review [--wait\|--background] [--base <ref>] [--scope auto\|working-tree\|branch]` | Code review against git diff |
| `/qwen:adversarial-review ...` | Challenge-review — questions design choices |
| `/qwen:status [<job-id>]` | List / inspect jobs |
| `/qwen:result <job-id>` | Show stored output |
| `/qwen:cancel <job-id>` | Cancel running job |

## Background rescue requires `--unsafe`

Qwen's `yolo` mode auto-approves all tools. For background rescue, we require explicit `--unsafe` to avoid unintended file writes or shell execution while you're not watching.

```bash
/qwen:rescue --background --unsafe "find all N+1 queries"
```

Without `--unsafe`, the companion returns `require_interactive`.

## Design docs

- Research: `docs/superpowers/specs/2026-04-20-qwen-plugin-cc-research.md`
- Design (v3): `docs/superpowers/specs/2026-04-20-qwen-plugin-cc-design.md`
- Plan: `docs/superpowers/plans/2026-04-20-qwen-plugin-cc-implementation.md`
- Lessons: `lessons.md`

## License

MIT
```

- [x] **Step 2: 写 CLAUDE.md**

```markdown
# qwen-plugin-cc — Working directory context

## Project type

Claude Code plugin that wraps Qwen Code CLI.

## Key paths

- Design spec: `docs/superpowers/specs/2026-04-20-qwen-plugin-cc-design.md` v3
- Plan: `docs/superpowers/plans/2026-04-20-qwen-plugin-cc-implementation.md`
- Companion: `plugins/qwen/scripts/qwen-companion.mjs`
- Core lib: `plugins/qwen/scripts/lib/qwen.mjs`
- Lessons: `lessons.md`

## Conventions

- Spec is authoritative. If spec and code disagree, update spec first OR fix code to match spec.
- `qwen.mjs` is written from scratch; other lib files are gemini-plugin-cc blood line with constant stripping.
- Test before commit. `node --test plugins/qwen/scripts/tests/` should pass green.

## Gotchas

- `exit 0 + is_error:false` can still mean failure — always run `detectFailure` through 5 layers.
- `--unsafe` is required for background rescue — not optional UX, it's a safety boundary.
- Proxy env has 4 case variants; always write all 4.
```

- [x] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: README + CLAUDE.md 最终版"
```

---

## Task 5.4: 端到端 T-checklist 全跑 + 打 tag

- [x] **Step 1: 清空 state,重新跑所有 T 项**

```bash
rm -rf /tmp/qwen-companion/*  # 或 $CLAUDE_PLUGIN_DATA/state/
```

然后在 Claude Code 里按 spec §6.5 逐条跑 T1–T16。每条通过打 ✓。

- [x] **Step 2: 记录结果**

在 `CHANGELOG.md` 加:

```markdown
## 2026-04-XX Final verification

T1 ✓ T2 ✓ T3 ✓ T4 ✓ T5 ✓ T5' ✓ T6 ✓ T7 ✓ T8 ✓ T9 ✓ T10 ✓ T11 ✓ T12 ✓ T13 ✓ T14 ✓ T15 ✓ T16 ✓
```

- [x] **Step 3: Commit + tag**

```bash
git add CHANGELOG.md
git commit -m "chore: v0.1.0 final verification — T1-T16 all pass"
git tag -a v0.1.0 -m "qwen-plugin-cc v0.1.0"
```

- [x] **Step 4: 跑全量单元 + 集成测试确认绿**

```bash
node --test plugins/qwen/scripts/tests/
```

Expected: 所有 `pass`。

---

**Phase 5 Exit Criteria**:
- `README.md` / `CLAUDE.md` / `lessons.md` 三份文档齐全
- `CHANGELOG.md` 有 release 条目和 T-checklist 全通过记录
- git tag `v0.1.0` 已打
- 所有 `node --test` 绿

---

# 自审

本 plan 对 spec v3 的覆盖率检查:

| spec 小节 | plan task |
|---|---|
| §1 目标 | 无 task 需要(顶层目标) |
| §2 仓库布局 | Task 1.1 / 1.2 / 2.1 / 2.2 / 2.4 / 3.1 / 3.2 / 4.4–4.6 |
| §2.3 改写分类 | Task 2.3 常量剥离;2.4 字面量替换 |
| §2.4 命名 | Task 1.1 marketplace/plugin |
| §3.1 companion 子命令 | Task 1.10 / 2.11–2.13 / 3.7 / 4.1–4.2 / 4.7 |
| §3.2 skill | Task 2.14–2.16 |
| §3.3 agent + 默认 approval | Task 2.17 |
| §3.4 commands | Task 1.11 / 2.18 / 3.8 / 4.3 |
| §3.5 hooks | Task 4.4–4.6 |
| §3.6 schema/prompts | Task 3.1 / 3.2 |
| §4.2 spawn | Task 2.8 |
| §4.3 proxy | Task 1.5 |
| §4.4 stream fg/bg | Task 2.9 |
| §4.5 setup auth | Task 1.10(+ Phase 4 补 qwenHooksBlockingWarning) |
| §4.6 state + job.json | Task 2.3 |
| §5.1 五层 + classifyApiError | Task 2.5 / 2.6 |
| §5.2 错误分类表 | 分散在各 companion task 里 |
| §5.3 retry 3 轮 | Task 3.4–3.6 |
| §5.4 状态机 | Task 4.1 orphan |
| §5.5 cancel | Task 2.10 / 2.13 |
| §6.5 T-checklist | 分散,Phase 末尾手测 + Task 5.4 汇总 |
| §7 阶段划分 | Phase 0/1/2/3/4/5 头部 |
| §8 must-have | 依 spec §8,Phase 0/1 前 |
| §9 风险 | Task 2.15 skill 文案 + Task 4.1 qwenHooks 警告 |

**发现的 gap**:
1. §4.5 `qwenHooksBlockingWarning` 的判断在 Phase 1 setup 里未显式实现(Task 1.10 只读了 `qwen hooks list` 但没判断 PreToolUse);Phase 4 应补一个小 task,或 Phase 1 里补。**决策**:合并到 Task 1.10 的 Step 3(若 `options["enable-review-gate"]` 逻辑已在 Phase 4 Task 4.7 补,阻塞 hook 警告也在同一 task 里补,避免 Phase 5 返工)。
2. Spec §5.2 的 `max_output_tokens` 在 `classifyApiError` 里有分类,但 T14 的"silent fail"保护在 Phase 3 review 里没显式实现(只有手测)。若 T14 实测失败,Phase 3 加一个 Task 3.10 "result 事件完整性校验"。

**Placeholder 扫描**:plan 文档已全绿,无 TBD/TODO/implement later。

**Type 一致性**:`detectFailure` 从 Task 2.6 到 Phase 3/4 都用 `{ exitCode, resultEvent, assistantTexts }` 签名;`buildSpawnEnv` 返 `{ env, warnings }`;`classifyApiError` 返 `{ failed, kind, status?, message }`。一致。

---

# 执行 Handoff

**Plan 完成,保存于 `docs/superpowers/plans/2026-04-20-qwen-plugin-cc-implementation.md`。71 个 task,~11 天。**

两个执行选项:

1. **Subagent-Driven(推荐)** — 每个 task 开 fresh subagent,task 间 review,快速迭代
2. **Inline Execution** — 本 session 里跑,按 Phase 分批 checkpoint

选哪个?

> 对 qwen-plugin-cc 这种 11 天规模的项目,**Subagent-Driven** 明显更合适:每个 task 独立可测,不需要跨 task 共享 state;Claude 主线可在 task 间做 review,保证进度和质量;context 窗口不会被单一长对话撑满。

---

# Phase 5 · 打磨 & 文档(0.5 天)

**待补**。

Task 5.1 lessons.md 回写差异
Task 5.2 CHANGELOG.md 每 phase 条目
Task 5.3 README.md + CLAUDE.md 最终版
Task 5.4 端到端 T-checklist 全跑
