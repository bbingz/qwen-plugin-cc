# Claude 5-way review(v0.1.1 / HEAD `55c7345`)

视角:security / correctness / resource lifecycle / error handling / edge cases。
已剔除前两轮已修项与 v0.2 backlog 已知 defer 项。

---

## P0(会让 plugin 错结果 / 崩 / 有安全漏洞)

### P0-1. SessionEnd + stop-review-gate hooks 的 `session_id` filter 永远不匹配

**File**:
- `plugins/qwen/scripts/session-lifecycle-hook.mjs:69`
- `plugins/qwen/scripts/stop-review-gate-hook.mjs:49-55`, `157`

**问题**:两个 hook 都按 `job.sessionId === sessionId` 筛选"本 CC session 的 job",但:
- `job.sessionId` 是 **qwen CLI 给的 session UUID**(来自 stream-json init event,`qwen.mjs:484` / `541`)。
- hook 里的 `sessionId` 是 **Claude Code session id**(`input.session_id` 或 `SESSION_ID_ENV`)。

两者根本不是一个东西,`filter` **永远返回空列表**。

**后果**(两条核心功能半失效):
1. SessionEnd 不会 cleanup 任何 bg job → 用户关 CC 后 bg qwen 仍在跑,且 `refreshJobLiveness` 不会被 hook 调起(`cleanupSessionJobs` 提前 return 了)。
2. stop-review-gate `runningTaskNote` 常为 null → 用户退 session 时不会看到"还有 running job"的警告。

**复现**:
```bash
/qwen:rescue --background --unsafe "some task"
# → 产生 job,jobMeta.sessionId = <qwen-uuid>
# 退出 Claude Code(触发 SessionEnd)
# → cleanupSessionJobs 里 sessionJobs.length === 0,立刻 return
# qwen child 继续跑(孤儿)
```

**修法**(两个思路):
- (A)让 `runTask` 在 spawn 前把 CC session 存入 jobMeta(新字段 `ccSessionId`,从 `process.env[SESSION_ID_ENV]` 读),hook 用这个字段 filter。
- (B)fallback:没匹配到时按 **cwd / workspaceRoot** 筛(所有这个 workspace 的 running job 都归当前 session)。

建议 (A)+(B) 组合:有 ccSessionId 用它,否则 fallback cwd。

---

### P0-2. `runTask` / `runStatus` / `runResult` / `runCancel` 用 `process.cwd()`,不 resolve repo root

**File**:`plugins/qwen/scripts/qwen-companion.mjs:208`, `311`, `361`, `400`

**问题**:`review`/`adversarial-review` 路径走 `ensureGitRepository(cwd)` + `collectReviewContext` 里 `getRepoRoot`,但 `task`/`status`/`result`/`cancel` 直接 `const cwd = process.cwd()`,没 resolve repo root。

state 目录用 `computeWorkspaceSlug(workspaceRoot)` 生成,不同 cwd 对应不同 slug。

**后果**:
```bash
cd /repo
/qwen:rescue --background "task"   # state 写到 slug("/repo")
cd /repo/src
/qwen:status                        # state 读 slug("/repo/src") → 看不到刚起的 job!
```

**修法**:在每个 sub-command 开头统一加:
```js
const cwd = (() => {
  try { ensureGitRepository(process.cwd()); return getRepoRoot(process.cwd()) || process.cwd(); }
  catch { return process.cwd(); }
})();
```
或抽一个 `resolveWorkspaceRoot(process.cwd())` 工具(hooks 里已有相同逻辑,可 share)。

---

### P0-3. `refreshJobLiveness` 全量 `readFileSync` log,无 size cap

**File**:`plugins/qwen/scripts/lib/job-lifecycle.mjs:26`

**问题**:
```js
try { logText = fs.readFileSync(job.logFile, "utf8"); } catch { /* ignore */ }
const parsed = parseStreamEvents(logText);
```
长 bg job 的 stream-json 可能数 MB(一个 review 任务 200+ turn,每个 turn 有 assistant text + thinking blocks)。这里同步全量读 + 同步 parse,被:
- `/qwen:status`(list 模式对**每个** running job 都调)
- `/qwen:result`
- SessionEnd hook

调用。会**阻塞 Claude Code 主进程**(hook 是 sync child)、**阻塞 companion**(status list)。

**后果**:列 10 个 100MB log 的 job,CC 主进程冻住数秒。

**修法**:
- 只读尾部(比如 1MB tail)— stream-json 的 result event 是**最后一行**,不必全读。
- 或按行反向扫描找 result event,没找到再 fallback 全读。
- 简单版:`size > 10MB` 就 cap,加 `failure: { kind:"log_too_large" }`。

---

### P0-4. `runCancel` / `runStatus` find 用 `j.jobId`,未 fallback `j.id`

**File**:
- `qwen-companion.mjs:320`(cancel)
- `qwen-companion.mjs:366`(status single)
- `qwen-companion.mjs:291`(task-resume-candidate)

**问题**:`state.mjs` 的 `upsertJob`(`189-207`)和 `cleanupOrphanedFiles`(`159`)都已兼容 `j.jobId ?? j.id`(F-17 修法),但 **caller 没对齐**:
```js
const job = jobs.find(j => j.jobId === jobId);   // 遗留 id 记录匹配不到
```

**后果**:state.json 里若有历史 `{id: "xxx"}` 记录(从更早 bloodline 迁移来的 / 用户自己编辑过的),用户无法 cancel、status、result 它们,却会被 `cleanupOrphanedFiles` 当孤儿误删对应的 `jobs/xxx.json` + log。

**修法**:全局替换 `j.jobId === jobId` → `(j.jobId ?? j.id) === jobId`(共 3 处);同时 `runTaskResumeCandidate` 第 297 行 `latestJobId = task.jobId` 改 `task.jobId ?? task.id`。

---

## P1(正确性/体验/安全风险,不崩但结果错)

### P1-1. `collectReviewContext` 把 untracked 文件 raw content 塞进 review prompt(secret leak)

**File**:`plugins/qwen/scripts/lib/git.mjs:274-306`

**问题**:untracked 文本文件(≤24KB)全量附到 review prompt 送给 qwen server。`BINARY_EXTENSIONS` 只排二进制。

**复现**:
```bash
echo "API_KEY=sk-ant-..." > .env.local      # untracked
/qwen:review
# → .env.local 内容作为 prompt 上传到 Alibaba Cloud / OpenAI upstream
```

**修法**:至少 skip 常见 secret 文件名:
```js
const SECRET_FILE_PATTERNS = /^(\.env|\.env\.|secrets?\.|credentials?\.|.*\.pem|.*\.key|.*_rsa|id_[dre][sc]a).*$/i;
if (SECRET_FILE_PATTERNS.test(path.basename(file))) {
  parts.push(`### ${file}\n(skipped: looks like a secret file)`);
  continue;
}
```
进阶:用 `git check-ignore` 尊重 `.gitignore`,但该函数已只读 untracked(排除了 ignored)。真正需要的是**敏感文件名 denylist**。

---

### P1-2. SessionEnd `terminateProcessTree` 无 pid 回收 verify

**File**:`plugins/qwen/scripts/session-lifecycle-hook.mjs:10-23`

**问题**:
```js
try { process.kill(-pid, "SIGTERM"); }
catch { try { process.kill(pid, "SIGTERM"); } catch { ... } }
```
直接按 `job.pid`/`-pid` 发 SIGTERM,无 `ps -g` verify。v0.1.1 `cancelJobPgid` 已修同类 race,但**这条路径被漏了**。v0.2 backlog 中 "PID liveness PID 复用同类问题" 提到 finalize,但没提 SessionEnd 的直接 kill 路径。

**后果**:CC session 退出时,若 pid 已被回收给无关进程组,会**误杀系统上任意进程**。

**修法**:抽 `cancelJobPgid` 的 pre-probe + verify 逻辑成工具函数,两处共享。或最起码:用 cancelJobPgid 统一取消逻辑,不再走 `terminateProcessTree` 直接 kill。

---

### P1-3. `buildSpawnEnv` 允许 `NODE_OPTIONS` 透传给 qwen child

**File**:`plugins/qwen/scripts/lib/qwen.mjs:31`

**问题**:`ENV_ALLOW_EXACT` 里含 `NODE_OPTIONS`。若 parent(Claude Code)继承了 `NODE_OPTIONS="--require=/path/to/telemetry.js"` 之类,qwen child(Node 程序)启动时会 require 那个 module。虽然 parent 可信,但:
- 用户系统级 `NODE_OPTIONS` 也会被继承(比如 debug inspector `--inspect=0.0.0.0:9229`)
- 意外把无关 telemetry 注入到 qwen 进程
- 扩大攻击面(若 parent 被某 extension / setup 污染)

**修法**:默认 **不允许** `NODE_OPTIONS`,若用户有合理理由,走 `QWEN_PLUGIN_ENV_ALLOW="NODE_OPTIONS"` 显式放行。

---

### P1-4. `runTask` 的 `resumeId` 死三元

**File**:`plugins/qwen/scripts/qwen-companion.mjs:189`

```js
resumeId: options["session-id"] ? undefined : undefined,
```

两个分支都 `undefined` — ternary 是死代码。该位显然想根据某个 flag 决定 resumeId。语义缺失:`--session-id <uuid>` 既可能是"新建用这个 id",也可能是"resume 这个 id"。目前实装把 `--session-id` 当 **创建**(line 190 传给 `sessionId`),所以 resumeId 永远 undefined,逻辑没错但**死代码留着会误导后续维护者**。

**修法**:删掉 `resumeId: undefined` 行,或加注释 `// resume via --resume-last only; --session-id is for creation`。

---

### P1-5. `runCancel` 声明 `--json` 但不读取

**File**:`plugins/qwen/scripts/qwen-companion.mjs:309`

```js
const { options, positionals } = parseArgs(rawArgs, { booleanOptions: ["json"] });
// ... 后面 options.json 从没被用;不管 --json 有没有,成功走 plain text,失败走 JSON
```

**后果**:
- 用户传 `/qwen:cancel xxx --json` 期待 structured 输出,成功时得到 `Cancelled xxx` 纯文本。
- 失败路径永远 JSON,和 `/qwen:status`/`/qwen:result` 的 `--json` 语义不对齐。

**修法**:根据 `options.json` 分别输出 `{ ok:true, jobId }` vs `Cancelled <id>`。

---

### P1-6. `rescue.md` 指令让 caller 加 `--resume`,companion 不识别

**File**:`plugins/qwen/commands/rescue.md:35` vs `qwen-companion.mjs:165`

rescue.md 指示 "add `--resume`",但 `runTask` 只识别 `--resume-last`。依赖 subagent(`agents/qwen-rescue.md:32`)翻译 `--resume → --resume-last`,链路 fragile。

**后果**:若 subagent prompt 被裁剪 / Claude 理解偏差 / 以后直接从 slash command 调 task 绕过 agent,`--resume` 会被 companion 当成 positional,拼进 prompt 文本。

**修法**:rescue.md 直接让 caller 加 `--resume-last`(和 companion 对齐);删掉 agent.md 翻译层,少一个间接。

---

## P2(次要)

### P2-1. 缺 unit test:`args.mjs` / `prompts.mjs` / `render.mjs` / 两个 hook

**File**:`plugins/qwen/scripts/tests/`

97 tests 覆盖了 qwen.mjs / state.mjs / git.mjs,但 **args.mjs**(byte-copy 血统也应 smoke)、**prompts.mjs interpolateTemplate**、**render.mjs**、**session-lifecycle-hook**、**stop-review-gate-hook** 都 0 测试。P0-1 这种 hook-level bug 本来该被测试抓到。

**修法**:至少给每个 hook 加 1 个 smoke test(stdin → spawn hook → 检查 stdout/stderr)。

---

### P2-2. `reviewWithRetry` 第 798 行冗余 validate

**File**:`plugins/qwen/scripts/lib/qwen.mjs:798`

```js
const ajvErrors = parsed
  ? (validate(parsed, schema) || [])
  : [{ message: "invalid JSON", instancePath: "/" }];
```
进入这个分支时,parsed 刚被 Step A/B 验过(且 errors 非空)。这里又 validate 一次,第 3 次同一 object。无害但浪费 CPU,且让 reader 困惑。

**修法**:在 Step A/B 保存 errors,这里直接用:
```js
let attemptErrors = null;
// Step A: 原样 parse + validate
// ... const errors = validate(parsed, schema); attemptErrors = errors; ...
// Step B: tryLocalRepair + validate
// ... attemptErrors = errors; ...

if (i < 2) {
  const ajvErrors = attemptErrors || [{ message: "invalid JSON", ... }];
  ...
}
```

---

### P2-3. `updateState` spin lock 阻塞 event loop

**File**:`plugins/qwen/scripts/lib/state.mjs:84-85`, `126-129`

```js
const waitUntil = Date.now() + 20;
while (Date.now() < waitUntil) { /* spin */ }
```

`session-lifecycle-hook` 是 CC 主进程的 sync child。该 hook 持锁写 state 时(尤其 multi-jobs cleanup 场景),锁冲突会 spin 50-500ms+,**冻住 CC 主进程响应**。

**修法**:hook 内用 `Atomics.wait`(worker thread 才支持)或直接 `child_process.spawnSync("sleep", [0.05])` 让出 CPU。更根本的:换 `proper-lockfile` 或类似 async lock,不过 v0.1 避免外部依赖。最简单:spin 改 `setImmediate`-based polling 在非 hook 路径。

---

### P2-4. `classifyApiError` `\b` 边界对非英文 error 文本失效

**File**:`plugins/qwen/scripts/lib/qwen.mjs:305-316`

qwen 中文 locale 下可能返 `"额度不足"` / `"内容违规"` 之类 localized error message。`/\bquota\b/` 不会匹配中文(因为 `\b` 是 ASCII word boundary)。结果统统落 `api_error_unknown`,用户看不到合适的 kind 提示。

**修法**:并行加中文关键词:
```js
if (/额度不足|余额不足|quota|billing/i.test(m)) return { kind: "quota_or_billing", ... };
if (/内容违规|敏感内容|违规|sensitive|moderation/i.test(m)) return { kind: "content_sensitive", ... };
```

---

## Nit

### Nit-1. `tryLocalRepair` bracket balance 把字符串里的 `{` `}` 算进 stack

**File**:`plugins/qwen/scripts/lib/qwen.mjs:672-682`

对 `{"a": "has } inside"}` 这种(合法但尾截断变 `{"a": "has } insi`),Step 5 balance 会把字符串里的 `}` 误当闭括号,stack 计算错,补的 `}` 不对位。

和 v0.2 backlog "tryLocalRepair content truncation" 相关,但那条是 "未闭合 string",这条是 "字符串里有 bracket"。归为同一类 defer,不新增 P。

---

### Nit-2. `shouldUnpackBlob` 白名单只有 `setup`,`task` 类 blob prompt 不 unpack

**File**:`plugins/qwen/scripts/qwen-companion.mjs:559`

若上层给 `task "--background --unsafe find bugs"` 这样的 single-arg blob(少见,CC slash 通常拆好),`task` 不在 `UNPACK_SAFE_SUBCOMMANDS`,flag 会被当 prompt 文本 → qwen 收到 `--background --unsafe find bugs` 作为 prompt。

实际 CC 调用走 argv 拆好,理论上不会走到 blob 路径,但如果用户手动 `node qwen-companion.mjs task "--background ..."` 会中招。**P2 UX,但可能也是 attack surface**。

---

## 小结

**P0 4 条全是核心功能漏洞,建议 v0.1.2 hotfix**:
- Session filter 对不上 id → hook 半失效(影响最大)
- cwd 不 resolve repo root → 跨目录用户体验直接碎
- log 无 size cap → 长任务后 status/result 阻塞
- `j.jobId` 未 fallback `j.id` → 3 个 caller 路径遗留兼容漏洞

**P1 6 条**:secret leak(security)、SessionEnd pid verify、NODE_OPTIONS 透传、死三元、--json 未用、rescue.md 对齐。

**P2/Nit 若干**:测试盲区、冗余 validate、spin lock、中文 error、bracket balance、blob unpack。

Reviewer:Claude(Opus 4.7)/ 2026-04-21
