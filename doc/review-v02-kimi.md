# Qwen Plugin v0.2.0 Review (Kimi)

_Reviewer: Kimi — 2026-04-21_
_Scope: tag v0.1.2 (2eb89d5) → v0.2.0 (584498e), 25 commits, 31 files_

## P0 — Must fix

### runCancel 异步信号调用缺失 await，导致取消逻辑完全失效
- **文件**: `/Users/bing/-Code-/qwen-plugin-cc/plugins/qwen/scripts/qwen-companion.mjs`
- **行号**: 约 `338-392`（diff 中 `async function runCancel(rawArgs)` 函数体）
- **证据**:
  ```diff
  async function runCancel(rawArgs) {
    ...
    const r = cancelJobPgid(target, { sleepMs: 500 });
    if (r.ok) {
      ...
    } else {
      ...
    }
  }
  ```
  `cancelJobPgid` 为 `async` 函数（返回 `Promise<{ok, kind, message}>`），但 `runCancel` 内未加 `await`，`r` 实际为 Promise 对象。后续 `if (r.ok)` 永远 truthy，`r.kind` / `r.message` 均为 `undefined`，导致：
  1.  cancel 失败时错误分类丢失；
  2.  JSON / human 输出均携带 `kind: undefined`，破坏下游契约。
- **修复建议**: 改为 `const r = await cancelJobPgid(target, { sleepMs: 500 });`，并确保 `emit` 前所有异步路径已 settled。

---

## P1 — Important

### stop-review-gate-hook.mjs 未同步 PID 复用防护，可能误报 running job
- **文件**: `/Users/bing/-Code-/qwen-plugin-cc/plugins/qwen/scripts/stop-review-gate-hook.mjs`
- **行号**: 约 `153-157`
- **证据**:
  ```diff
    const runningJob = jobs.find((j) => {
      if (j.status !== "running" || !j.pid) return false;
      try { process.kill(j.pid, 0); return true; }
      catch { return false; } // ESRCH = 已死,skip
    });
  ```
  v0.2 在 `job-lifecycle.mjs` 引入了 `defaultVerifyPidIsQwen`（`ps -p <pid> -o command=`）以防止 PID 复用假活，但 stop-review-gate-hook 仍使用裸 `process.kill(pid, 0)`。若一个已完成的 job 的 PID 被 OS 复用给无关进程，gate hook 会误判为 running，向用户输出错误的阻拦提示。
- **修复建议**: 复用 `refreshJobLiveness` 的逻辑或引入同样的 `ps` 归属校验，保持跨文件行为一致。

---

### review-validate.mjs 不支持 `$ref` / 复合关键字，schema 演进存在静默失效风险
- **文件**: `/Users/bing/-Code-/qwen-plugin-cc/plugins/qwen/scripts/lib/review-validate.mjs`
- **行号**: 全文（新文件）
- **证据**:
  ```javascript
  // 覆盖 review-output.schema.json 实际用到的关键字:
  // type / enum / required / additionalProperties / minLength / minimum /
  // maximum / properties / items(object+array 的递归)。
  ```
  实现中 `validateNode` 仅处理上述关键字。若未来 `review-output.schema.json` 引入 `$ref`、`allOf`、`oneOf`、`pattern` 等，校验器会**静默跳过**相关约束，导致无效 JSON 被误判为合法。当前测试（`qwen-review-validate.test.mjs`）也未覆盖“schema 含未支持关键字时至少应抛警告/失败”的防御性路径。
- **修复建议**: 在 `validateNode` 入口增加未知关键字白名单检测，遇到未实现关键字（如 `$ref`）时 throw 或 stderr warn，避免“假装通过”。

---

### cancel 真机信号路径测试覆盖为零，--json 分流只在“job 不存在”时验证
- **文件**: `/Users/bing/-Code-/qwen-plugin-cc/plugins/qwen/scripts/tests/integration.test.mjs`
- **行号**: 约 `71-98`
- **证据**:
  ```
  test("integration: cancel 不存在 job 默认打 human text + exit 3", ...
  test("integration: cancel --json 不存在 job 打 JSON envelope", ...
  ```
  integration 测试仅覆盖 `not_found` 分支。`running` → `cancelJobPgid` → `ok` / `cancel_failed` 两条核心路径（含 `--json` vs human 分流、exit code 0/5 区分）**完全没有**端到端测试。结合前述 P0 的 `await` 缺失，说明该路径在 v0.2 期间未被执行过。
- **修复建议**: 补充 integration 测试：mock 一个 running job（写 state + jobs/<id>.json），验证 cancel 成功与失败时的 human/JSON 双模输出及 exit code。

---

### streamQwenOutput 新增 stderrTail 收集零单元测试覆盖
- **文件**: `/Users/bing/-Code-/qwen-plugin-cc/plugins/qwen/scripts/tests/qwen-stream.test.mjs`
- **行号**: 全文
- **证据**:
  ```
  test("streamQwenOutput: 正常输出,assistantTexts 收集", ...
  test("streamQwenOutput: bg 模式命中 API Error 早退", ...
  test("streamQwenOutput: fg 模式不早退,读完全部", ...
  test("streamQwenOutput: onAssistantText 回调(stdout 透传用)", ...
  ```
  `qwen-stream.test.mjs` 四项测试均未断言 `streamResult.stderrTail`。v0.2 核心功能“F-8 no_prior_session 依赖 stderr 识别”建立在 `child.stderr.on('data', ...)` 之上，但无测试验证：
  1.  stderr 数据是否正确流入 `state.stderrTail`；
  2.  4096 截断窗是否生效；
  3.  `child.stderr` 为 null 时（stdio ignore）是否安全。
- **修复建议**: 向 mock child 注入 `stderr: EventEmitter` 并发射 chunk，断言 `streamResult.stderrTail` 内容；测试截断逻辑。

---

### qwen.mjs 多处 JSDoc / 返回结构未同步新字段，注释漂移
- **文件**: `/Users/bing/-Code-/qwen-plugin-cc/plugins/qwen/scripts/lib/qwen.mjs`
- **行号**: `runQwenPing`（约 `242` 附近）、`streamQwenOutput`（约 `553` 附近）、`parseStreamEvents`（约 `633` 附近）
- **证据**:
  ```diff
    const out = {
      ...
      assistantTexts: [],
  +    toolUses: [],
  +    toolResults: [],
  +    imageCount: 0,
      resultEvent: null,
    };
  ```
  代码已为上述三个函数追加 `toolUses` / `toolResults` / `imageCount`，但：
  - `runQwenPing` 的 JSDoc 仍只字未提新字段；
  - `streamQwenOutput` 的 JSDoc 未更新返回 shape；
  - `parseStreamEvents` 无 JSDoc，但调用者依赖其字段。
  下游（如 `job-lifecycle.mjs`）通过 `parsed.resultEvent` / `parsed.assistantTexts` 消费，虽不报错，但新增字段对 IDE 提示和后续维护者不可见。
- **修复建议**: 为三个函数补全 `@returns` 类型定义，明确列出 `toolUses` 等字段。

---

### tryLocalRepair string-aware 扫描不验证 bracket 配对，降低修复成功率
- **文件**: `/Users/bing/-Code-/qwen-plugin-cc/plugins/qwen/scripts/lib/qwen.mjs`
- **行号**: 约 `805-825`（Step 5）
- **证据**:
  ```javascript
  else if (ch === "{" || ch === "[") stack.push(ch);
  else if (ch === "}" || ch === "]") stack.pop();
  ```
  遇到闭合 bracket 时直接 `pop`，不检查栈顶是否与当前字符匹配。若 qwen 截断在 `}]` 这类嵌套结构，`}` 会错误地 pop 掉 `[`，导致后续补齐方向相反。虽然最终 `JSON.parse` 会兜底返回 null，但本可修复的 truncation 场景被浪费。
- **修复建议**: pop 前校验 `stack.at(-1)` 与当前闭合字符是否配对；不匹配时可提前 break 或做容错处理。

---

## P2 / Nit

### buildReviewAppendSystem 新导出缺 JSDoc
- **文件**: `/Users/bing/-Code-/qwen-plugin-cc/plugins/qwen/scripts/lib/qwen.mjs`
- **行号**: 约 `813-820`
- **证据**:
  ```diff
  +export function buildReviewAppendSystem(schemaText) {
  +  return `You are a code reviewer...`;
  +}
  ```
  作为 v0.2 新 export API，无参数类型、返回值、用途说明。与 `buildReviewPrompt` / `buildRepairPrompt` 相比文档不对称。
- **修复建议**: 补一段 JSDoc，说明参数为 schema 文本字符串，返回 system prompt 字符串。

---

### readTimingHistory 直接写 stderr，与模块其余部分日志风格不一致
- **文件**: `/Users/bing/-Code-/qwen-plugin-cc/plugins/qwen/scripts/lib/state.mjs`
- **行号**: 约 `349-361`
- **证据**:
  ```diff
  +  if (corrupted > 0) {
  +    try { process.stderr.write(`[timing] ${corrupted} corrupted line(s) skipped in ${file}\n`); } catch {}
  +  }
  ```
  `state.mjs` 其余函数均保持静默（无日志输出），唯独 `readTimingHistory` 在发现 corrupted line 时直接 `process.stderr.write`。虽然加了 try/catch，但在 library 层突兀写 stderr 可能污染调用方（如 companion 的 JSON 输出或测试捕获的 stderr）。
- **修复建议**: 改为返回 `{lines, corruptedCount}`，由调用方决定是否输出；或统一使用与 companion 相同的日志策略。

---

### cleanupSessionJobs 串行 await terminateJob，session 结束延迟随 job 数线性增长
- **文件**: `/Users/bing/-Code-/qwen-plugin-cc/plugins/qwen/scripts/session-lifecycle-hook.mjs`
- **行号**: 约 `75-78`
- **证据**:
  ```diff
    for (const job of sessionJobs) {
      try { refreshJobLiveness(workspaceRoot, job); } catch { /* ignore */ }
  +   await terminateJob(job);
    }
  ```
  `terminateJob` 内部 `cancelJobPgid` 含 `sleepMs: 500` 及信号阶梯等待，串行执行导致 N 个 job 时 session end 最坏延迟达 N×(500ms+)。SessionEnd hook 对响应时间敏感。
- **修复建议**: 若 sessionJobs 通常 ≤1 可保持现状；否则改为 `Promise.all(sessionJobs.map(...))` 并行清理。

---

### extractStderrFromLog 的 JSONL 判别过于简化，可能误判
- **文件**: `/Users/bing/-Code-/qwen-plugin-cc/plugins/qwen/scripts/lib/job-lifecycle.mjs`
- **行号**: 约 `19-29`
- **证据**:
  ```javascript
  const nonJson = [];
  for (const line of logText.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("{")) continue;
    nonJson.push(line);
  }
  ```
  以 `{` 开头即判定为 JSONL 而跳过。若 stderr 输出恰好以 `{` 开头（如 stack trace 包含对象字面量 `{ type: 'Error' }`），会被错误过滤；反之若 qwen 某次输出 pretty-printed JSON（缩进空格开头），则不会被跳过。当前 qwen stream-json 为 compact 格式，风险低，但注释声称“非 JSONL 行当 stderr”并不严谨。
- **修复建议**: 尝试 `JSON.parse(t)` 作为判别标准（加 try/catch），而非仅看首字符。

---

### rescue.md 对 --resume-last 转发语义可更明确
- **文件**: `/Users/bing/-Code-/qwen-plugin-cc/plugins/qwen/commands/rescue.md`
- **行号**: 约 `44`
- **证据**:
  ```diff
  - Leave `--resume`/`--fresh` in forwarded request; subagent handles routing.
  + Leave `--resume-last`/`--fresh` in forwarded request; subagent handles routing.
  ```
  文档提到“保留给 forwarded request”，但未说明 companion 会将其翻译为 qwen CLI 的 `-c`（resume last session）。维护者可能误以为 `--resume-last` 是 qwen 原生 flag。
- **修复建议**: 加半句注释，如“companion 会将其映射为 `qwen -c`（resume last session）”。

---

## 结语

v0.2.0 在 schema 校验、权限归一化、session 续传、PID 复用防护等方面有扎实的增量，但 **qwen-companion.mjs 的 `runCancel` 缺失 `await` 是硬 bug**，会导致取消语义完全走样，必须立即修复。与此同时，stop-review-gate-hook 未同步新的 PID 复用校验、review-validate 对未支持关键字的静默跳过、以及 stderr/stream 新路径的测试缺口，构成了 v0.2 在“跨文件一致性”和“测试覆盖深度”上的主要技术债。建议 v0.2.1 优先堵住 P0，并为 gate hook / cancel 路径补全集成测试。

(session: 28857cbf-e913-4ca9-a649-14f9e464096f · model: kimi-code/kimi-for-coding · thinkBlocks: 1)
