# Qwen Plugin v0.2.0 Review (Claude)

**Date**: 2026-04-21
**Scope**: v0.1.2 (`2eb89d5`) → v0.2.0 (`584498e`),25 commits,31 files
**Reviewer**: 独立 senior reviewer,只看代码不看 plan
**Method**: 逐文件读 diff + 交叉对 FINDINGS F-1..F-17,挖新 bug(不重复 CLAUDE.md v0.2 invariant 清单)

---

## P0 — Must fix(correctness/security)

### [P0-1] `runSetup` 两处裸用 `process.cwd()`,违反 v0.1.2 cwd 归一 hotfix → `--enable-review-gate` 在子目录跑会静默失效

**File**: `plugins/qwen/scripts/qwen-companion.mjs:72` + `:131`

**Finding**:
- Line 72(`enable-review-gate`/`disable-review-gate` 持久化分支):`const cwd = process.cwd();` 直接拿 cwd,然后 `ensureStateDir / loadState / saveState` 全走这个未归一的路径。
- Line 131(读 `stopReviewGate` 填入 status):`loadState(process.cwd())` 同样裸用。

其他 subcommand(`runTask` L213、`runTaskResumeCandidate` L317、`runCancel` L347、`runStatus` L409、`runResult` L448、`runReview` L516)**都**正确调 `resolveWorkspaceRoot(process.cwd())`。只有 `runSetup` 漏了,和 CLAUDE.md 明写的 v0.1.2 P0-6 约束("companion 所有 sub-command + 两个 hook 必须用 `resolveWorkspaceRoot(process.cwd())`,不能裸用 `process.cwd()`")直接冲突。

**Repro / evidence**:
```bash
cd /my/repo
mkdir -p sub/dir && cd sub/dir
node <path>/qwen-companion.mjs setup --enable-review-gate --json
# → 在 sub/dir 的 workspace slug 下写了 state.json/config.stopReviewGate=true
cd /my/repo
node <path>/qwen-companion.mjs setup --json
# → 读的是 /my/repo 的 workspace slug,看不到刚才的设置,stopReviewGate: false
```

hook 路径走的是 `resolveWorkspaceRoot(cwd)`(session-lifecycle-hook.mjs:52、stop-review-gate-hook.mjs:144),所以 hook 读 repo-root 的 config,而 setup 写到了 subdir slug,**stop-review-gate 永远不会被启用**。

而且 `saveState` 内会跑 `cleanupOrphanedFiles(workspaceRoot, state.jobs)`,用 subdir 下的空 jobs[] 去扫 subdir 下的 jobs/ 目录 — 如果恰好 subdir 和 repo-root 落到同一 `$CLAUDE_PLUGIN_DATA/state/<slug>/jobs/` 共享路径(它们不会:slug 由 basename+hash 决定),会清掉别人的 job。当前实现下 slug 不同所以不误删,但这是脆弱的偶然安全。

**Recommendation**:
```js
// Line 72 分支
const cwd = resolveWorkspaceRoot(process.cwd());
// Line 131
const setupState = loadState(resolveWorkspaceRoot(process.cwd()));
```
并加 import:`import { resolveWorkspaceRoot } from "./lib/git.mjs";`(file 已有其他地方在用)。

---

### [P0-2] `review` 漏过滤 staged / unstaged diff 里的 secret 文件 → `.env` 已 staged / tracked 时内容会被发给 qwen upstream

**File**: `plugins/qwen/scripts/lib/git.mjs:265-288`(`collectWorkingTreeContext`)

**Finding**: v0.2 新加的 `isLikelySecretFile` 只在**两条** untracked 文件路径上生效:
1. `formatUntrackedFiles`(Line 317):走 `collectReviewContext` 的结构化输出
2. `getUntrackedFilesDiff`(Line 362):走 legacy pseudo-diff

但 `collectWorkingTreeContext` 里的 staged diff(`git diff --cached --no-ext-diff`)和 unstaged diff(`git diff --no-ext-diff`)**完全裸透 git 输出**,没过 `isLikelySecretFile`。只要用户一次 `git add .env`,`.env` 的完整内容(含 API_KEY=...)就在 "Staged Diff" section 里原样被塞进 prompt 发给 qwen。

Commit 信息 `fix(security): review untracked 文件 secret 黑名单` 的标题已经泄露 intent 面 — 只防 untracked。真正的 threat model("review 不泄 secret 给 upstream")staged / tracked 同样危险,而且**更常见**:dev 最容易误 commit 的就是 `.env`。

**Repro / evidence**:
```bash
cd /tmp && git init test && cd test
echo "API_KEY=prod-secret-xxx" > .env
git add .env
# .env 已 staged,未 commit
node <companion> review --scope staged --json
# → ctx.content 含 "+API_KEY=prod-secret-xxx",明文发给 qwen
```

相关测试 `qwen-secret-denylist.test.mjs` 第 68-92 只覆盖 untracked 路径("collectReviewContext: untracked .env 被标 skipped"),**没有 staged case 的负测试**,所以漏洞没被 CI 发现。

**Recommendation**: 在 `collectWorkingTreeContext` 里先用 `state.staged` / `state.unstaged` 文件列表过 `isLikelySecretFile`,对命中的文件发 `git diff --cached -- <file>` 逐个挑出来替换成 skipped 标注。简化方案:
```js
function filterSecretFilesFromDiff(diffText, files) {
  // 对每个 secret file,把 diff 里的 "diff --git a/<file> ..." 到下一个 "diff --git"
  // 之间的 hunk 替换成 "diff --git a/<file> b/<file>\n(skipped: likely secret)"
  ...
}
```
或最低限度:`getWorkingTreeState` 里扫 staged/unstaged,若任一命中 `isLikelySecretFile`,整体 review 报 `ok:false, kind:"secret_in_diff", files:[...]` 拒跑,让用户自己 `git reset HEAD <file>`。

---

### [P0-3] `defaultVerifyPidIsQwen` 用 `/qwen/i` 做 substring match,workspace basename 含 "qwen" 会稳定误判 → job 永远卡 running

**File**: `plugins/qwen/scripts/lib/job-lifecycle.mjs:57-65`(同一 pattern 也在 `qwen.mjs:725-733` 的 `defaultVerifyPgidIsQwen`)

**Finding**: PID 复用保护做得好(意图对),但判 qwen 归属用的是 `/qwen/i.test(r.stdout)` — stdout 是 `ps -p <pid> -o command=` 的 full command line,含完整 argv 路径。

关键点:**本 plugin 仓库目录就叫 `qwen-plugin-cc`**,用户在这个 repo 里开发时所有进程(vim、node、bash、rg、grep、自己的 test runner……)的 command line 都包含子串 "qwen"。spawn 的 child 死后 OS 把 pid 复用给这些无关进程,`ps` 输出里**仍然**会命中 `/qwen/i`,verifier 返 `true`,`refreshJobLiveness` 把死 job 当活 job,`status`/`result` 永远拿不到 finalize。

而且 companion 本身也叫 `qwen-companion.mjs`:一个刚死 qwen 的 pid 被复用给 **另一个** companion 进程(用户再跑一次 `/qwen:status`),pid 命令行里含 "qwen-companion",误中。

这比 cancelJobPgid 版本更脆(pgid 查的是 session leader command,相对更准;但 refreshJobLiveness 查的是单 pid,命中面大)。

**Repro / evidence**:
```bash
# repo cwd: /Users/xxx/qwen-plugin-cc
# 启动一个 bg task,记 pid = 12345,跑完了死掉
# OS 把 12345 复用给 user 刚开的 `node debug-qwen.js`(名字含 qwen)
$ ps -p 12345 -o command=
node /Users/xxx/qwen-plugin-cc/debug-qwen.js
$ /qwen:status 12345  # job 状态永远卡 "running",不 finalize
```

当前测试 `refreshJobLiveness: 活 pid 但 PID 复用(非 qwen)→ 走 finalize` 传的是 `verifyFn: () => false` 手工 mock,**没有任何测试覆盖默认 verifier 的 substring false-positive 风险**。

**Recommendation**:
1. 用 `ps -p <pid> -o comm=`(小写 `comm`)取 executable basename,不是 `command=`;basename 就是 `qwen` / `node` / `bash`,不含 path。
2. 再用精确匹配:`r.stdout.trim() === "qwen"`(或 `/^qwen$/m` for multi-line)。
3. 如果担心 qwen 版本不同,存 spawn 时的 `bin` 名到 job 里,verify 时比对存值。

同样修补 `cancelJobPgid` 的 `defaultVerifyPgidIsQwen`:用 `ps -g <pgid> -o comm=`(不过 `-g` + `comm=` 在 macOS/Linux 语义一致否要验证;退路:`pgrep -g <pgid> -l qwen`)。

---

### [P0-4] `runCancel` 在 `if (!job)` 分支后控制流继续 — 看上去依赖 `process.exit` 同步性但没明确 return

**File**: `plugins/qwen/scripts/qwen-companion.mjs:364-378`

**Finding**: 重读这块代码:
```js
const job = jobs.find(j => j.jobId === jobId);
if (!job) {
  emit({ ok: false, reason: "not_found" }, `Job ${jobId} not found.`, 3);
}
if (job.status !== "running") {    // ← 如果前面 !job,这里 job 是 undefined
  emit(..., 0);
}
if (!job.pgid) { ... }
```

`emit` 最后一行是 `process.exit(exitCode)`,**node 的 `process.exit` 是同步的**,后续代码理论上不会跑。但:
1. 代码**读**起来像 fallthrough bug(没人一眼能看出 emit 内部 exit),下一个维护者很容易 refactor 把 `process.exit` 改成 return + `main()` 集中 dispatch,这时就真崩。
2. `process.exit` 在 node 官方 doc 里标 "force to exit ASAP even if there are still asynchronous operations pending" — 但并不保证当前同步代码**不执行下一行**。实测确实不会(事件循环被 exit 截断),但这是 implementation detail,不是语义保证。
3. 如果 `emit` 将来被改成 async(比如需要 flush 日志),`process.exit` 会退化成 "scheduled exit",`job.status` 读就真炸。

**Repro / evidence**: 当前不会崩(integration.test.mjs 已验证 "cancel 不存在 job 返 exit 3")。但代码的 intent 与写法不符,属于代码坏味道 + 潜在回归坑。

**Recommendation**: `emit` 末尾加 `return` 不能拦 process.exit,改 emit 不 exit,而在调用处:
```js
const emit = (payload, humanText, exitCode) => {
  if (jsonMode) process.stdout.write(JSON.stringify({ ...payload, jobId }, null, 2) + "\n");
  else process.stdout.write(humanText + "\n");
  process.exitCode = exitCode;
};

if (!job) { emit(...); return; }
if (job.status !== "running") { emit(...); return; }
if (!job.pgid) { emit(...); return; }
```
`main()` 顶层在 `runCancel` 返回后自己 `process.exit(process.exitCode ?? 0)`。这样意图清晰,审计容易。

---

## P1 — Important

### [P1-1] `redactInput` 用 substring match 命中 "auth" → "author" / "authority" / "authentic" 等合法 key 会被误 redact

**File**: `plugins/qwen/scripts/lib/qwen.mjs:363`

**Finding**:
```js
const SENSITIVE_KEY_RE = /(api[_-]?key|apikey|token|secret|password|passwd|pwd|credential|auth|bearer|session_id)/i;
```
全是 substring match,无 word boundary:
- `/auth/i` 命中 "author"、"authorization"、"authenticate"、"authority"、"authored_by"
- `/pwd/i` 命中 "backward_compat_pwd"、"pwdir"
- `/token/i` 命中 "tokenizer"、"tokenize_method"、"tokenized_path"
- `/secret/i` 命中 "secretary_contact"
- `/credential/i` 还好(词根较长)

这不是 security bug(多 redact 比漏 redact 安全),但是 **DX bug**:用户调查 permission_denial 看到一堆 `author: "[REDACTED]"` 会困惑原作者是谁,把合法字段当成"被 qwen 偷了密钥"。

而且 "Authorization: Bearer xxx" 这种典型 secret 是在 key `Authorization`(含 "auth")命中 key-side 过滤,看起来 OK;但**如果**是字符串拼接的 curl cmd(`tool_input.cmd = "curl -H 'Authorization: Bearer xxx'"`),key 是 `cmd` 不敏感,value 扫 `SECRET_VALUE_PATTERNS`,`^Bearer\s+\S` 只匹配"以 Bearer 开头"的整串,字符串中间的 Bearer 没被抓到。**漏抓**。

**Repro / evidence**:
```js
normalizePermissionDenials([{
  tool_name: "curl",
  tool_input: {
    cmd: "curl -H 'Authorization: Bearer sk_live_abc...' https://api.stripe.com",
    author_email: "alice@example.com",
  },
}])
// 结果:
//   cmd: 完整泄漏(Bearer 不在开头,sk_live_ 也不是 sk-,不命中任一 pattern)
//   author_email: "[REDACTED]" ← 误伤
```

**Recommendation**:
1. key pattern 加 word boundary(但 `_` 是 word char,所以 `\bauth\b` 不匹配 `auth_key`;需要 `(^|[_-])auth([_-]|$)` 这种):
   ```js
   const SENSITIVE_KEY_RE = /(^|[_\- ])(api[_-]?key|apikey|token|secret|password|passwd|pwd|credential|auth(?:orization)?|bearer|session[_-]?id)(?:[_\- ]|$)/i;
   ```
2. value pattern 去掉 `^` 锚:`/Bearer\s+\S{10,}/i` 匹配串中任何 Bearer header。
3. 追加 pattern:`sk_live_[A-Za-z0-9]{20,}`(Stripe)、`eyJ[A-Za-z0-9_-]{10,}\.` (JWT header)、`AIza[0-9A-Za-z_-]{35}`(Google API key)。
4. 加测试:`{ author: "Alice" }` 不应被 redact;`{ cmd: "curl -H Authorization: Bearer xxx..." }` 应被 redact。

---

### [P1-2] `isLikelySecretFile` 对 `.env.example` 一律拒,但 `.example` / 占位模板文件是**常见**开源实践 → review 会静默漏掉新加的 `.env.example`

**File**: `plugins/qwen/scripts/lib/git.mjs:15`

**Finding**: 首条 pattern `/(^|\/)\.env($|\.|\b)/i` 命中 `.env.local`、`.env.production`、`.env.example`、`.env.test`。测试 `qwen-secret-denylist.test.mjs:15` 明确把 `.env.example` 列入 hits,注释 "保守拒:让用户主动改名/git-add"。

这在开发实践上**反直觉**:`.env.example` 的典型内容是 `DATABASE_URL=postgres://user:pass@host/db`(占位,无实 secret),几乎所有 OSS repo 都 commit 它。review 这类文件本来就应该看得到 — 它是文档。现在只要 user 新建 `.env.example`,review **静默**跳过,而且 `getUntrackedFilesDiff`(L362)更是 silent,连 skipped 标记都没 — 用户根本不知道文件被屏蔽。

真实 threat 是 `.env`、`.env.local`、`.env.production`(含实 secret);`.env.example` / `.env.sample` / `.env.template` 应放过。

**Repro / evidence**: 用户 new-repo + `.env.example` 作为唯一 untracked 文件,`/qwen:review` 会拿到 empty "Untracked Files" section,不知道为什么。

**Recommendation**: pattern 改成 `/(^|\/)\.env(\.(local|production|development|test|staging)?)?$/i` + 显式排除 `.example/.sample/.template`:
```js
/(^|\/)\.env($|\.(local|production|development|test|staging|dev|prod)$)/i
```
即只拒确实可能含 live secret 的变体,放过 template 类。

---

### [P1-3] `tryLocalRepair` truncation 修复对 `{"key":` 尾断(value 未开始)场景会返回非预期结构

**File**: `plugins/qwen/scripts/lib/qwen.mjs:781-811`

**Finding**: Step 5 的 string-aware 扫描只 handle "在 string 中间被截断"和"brackets 未闭合"。但 qwen timeout 也可能在 **key: 冒号后 value 前**断,例如:
```
{"summary":"ok","findings":[{"severity":"high","title":
```
此时扫描状态:stack=`[{, [, {]`,inString=false(最后 `"` 后已关闭)。修 fix 补闭合:
```
{"summary":"ok","findings":[{"severity":"high","title":}]}
```
`JSON.parse("... : }")` 失败(`:` 后必须有 value);再 trim 尾逗号也没用(没有尾逗号)。返 null。

看起来"返 null"是合理行为(真修不动),但测试 `tryLocalRepair: 完全无法修 → null` 用的是 `"totally garbled { incomplete "`,不是这种合法前缀 + 结构化截断。用户看到的是 review "attempts all failed",debug 起来不知道是 qwen 尾断、schema 违规、还是模型拒答。

**Repro / evidence**:
```js
tryLocalRepair('{"a":1,"b":') // → null,但意图上可能想补 null / drop "b"
tryLocalRepair('{"a":[1,') // → null(尾逗号 + 不完整 array)
```

当前 step 5 前面的 `fixed.replace(/,(\s*)$/, "$1")` 只去 string 最末尾的逗号,不去 array/object 元素间的悬挂 `:`。

**Recommendation**: 加一层 "drop 尾部不完整的 key-value 对":扫描末尾,若最后一个 non-whitespace 是 `:` 或 `,` 后跟 `{`/`[` 开头,把尾段从最后一个完整元素后截掉。或者更简单:若 step 5 所有 parse 都失败,尝试从 `fixed` 尾部逐字符砍掉再 parse(最多砍 100 字符)。

不是 P0(修不动就 retry 轮 reviewWithRetry 会重跑);列 P1 是因为 qwen timeout 尾断是**高频**场景,多补一层 repair 能省一轮 retry。

---

### [P1-4] `session-lifecycle-hook.cleanupSessionJobs` fallback 逻辑:无 `claudeSessionId` 的 job 一律归属当前会话 → 跨 CC 会话并发场景会误杀别人的 job

**File**: `plugins/qwen/scripts/session-lifecycle-hook.mjs:62-67`

**Finding**:
```js
const sessionJobs = state.jobs.filter((job) => {
  const stillRunning = job.status === "queued" || job.status === "running";
  if (!stillRunning) return false;
  if (job.claudeSessionId) return job.claudeSessionId === sessionId;
  return true; // 无 claudeSessionId 的历史记录归入本 workspace fallback
});
```

fallback `return true` 语义是"无 claudeSessionId 字段的 job 视作当前 session 的"。CLAUDE.md v0.1.2 hotfix 讲 "hooks session filter 按 claudeSessionId"正是为了**区分**多 CC 会话。

真实场景:同一 repo 两个 CC 窗口同时开(A 开 task-A 带 claudeSessionId=A,B 开 task-B 但 plugin 早期 bug 没写 claudeSessionId 字段 / 或 B 还没升到 v0.1.2)。A 窗口 SessionEnd 时 hook 扫所有 running job:
- task-A: claudeSessionId=A === A ✓ kill
- task-B: claudeSessionId 字段缺失 → fallback true → **kill 别人的 job**

而且 v0.1.2 前的 companion 确实**不写** `claudeSessionId`(从 CLAUDE.md:"hooks session filter...job.claudeSessionId`(companion 启动时从 PARENT_SESSION_ENV 持久化)" 这是 v0.1.2 加的字段)。user 升级 plugin 到 v0.2 时,旧的 running job 在 state.json 里没字段,第一次 SessionEnd 会把它们全杀了。

相关 unit test `qwen-session-lifecycle-hook.test.mjs` **完全没覆盖** filter 行为 — 三个测试是 cwd 缺失、sessionId 缺失、state 文件缺失,都是 boundary,没一个测多 job + 不同 claudeSessionId 的筛选逻辑。

**Repro / evidence**: 无直接 repro(需要两 CC session),但代码流清楚。

**Recommendation**:
1. fallback 改 `return false`(无字段 = 不认,保守不杀);结合 `refreshJobLiveness` 会被 status/result 懒刷新,遗留 running 最终还是会被 finalize。
2. 或者迁移 fallback:hook 启动时扫一遍 legacy job,若无 `claudeSessionId` 直接打印 stderr 提示"legacy job <jobId> 无 session 绑定,手工清理或让它自然超时"。
3. 加测试:state 里两个 running job,只有一个匹配 session,assert 只一个被 kill。

---

### [P1-5] integration test 裸透 `env: process.env`,未隔离 `QWEN_COMPANION_SESSION_ID` / `CLAUDE_PLUGIN_DATA` → 测试行为随 shell env 变化

**File**: `plugins/qwen/scripts/tests/integration.test.mjs:14-24`

**Finding**:
```js
function runCompanion(args, { cwd = process.cwd(), env = process.env, ... } = {}) {
  ...spawn("node", [companionPath, ...args], { cwd, env });
}
```
默认 env 是 parent process.env,完整透传。CLAUDE.md 明说 "测试:`node --test ... → 190 pass / 0 fail(clean env;QWEN_COMPANION_SESSION_ID 若被泄漏需 env -u 清)`" — 承认测试**依赖 clean env**,但代码层没强制。

三个具体 test(`integration: setup --json`、`task without prompt`、`cancel 不存在 job`)里只有后两个用 `makeTmpPluginData()` 临时覆盖 `CLAUDE_PLUGIN_DATA`。第一个 setup 测试直接 `runCompanion(["setup", "--json"])` 不覆盖 env,意味着:
1. 如果开发机有 live `CLAUDE_PLUGIN_DATA` 指向真实 CC 目录,setup 会读/写用户实际状态。
2. 如果 `QWEN_COMPANION_SESSION_ID` 设置(开发者前面跑过 session-lifecycle-hook 测手动设的),filterEnvForChild 会把它透传给 qwen child(前缀 `QWEN_` 命中),可能改 qwen 行为。
3. setup 断言只看 JSON 字段存在,不校验值 — 当前"偶然通过",但不是严谨测试。

**Repro / evidence**: Node CI 跑 clean env 确实 pass;dev 机若 `export QWEN_COMPANION_SESSION_ID=xxx` 再跑,setup 会把它透传给真 qwen child,真 qwen 根据此 session 行为不同。不 crash,但不 reproducible。

**Recommendation**: `runCompanion` 默认 env 改成白名单(最小化 parent 继承):
```js
function cleanEnv() {
  const ALLOW = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "NODE_PATH"];
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => ALLOW.includes(k))
  );
}
function runCompanion(args, { cwd = process.cwd(), env = cleanEnv(), ... } = {}) { ... }
```
并在 setup 测试里注入 tmp `CLAUDE_PLUGIN_DATA`(和其他两 test 一样),确保完全隔离。

---

### [P1-6] `runCancel` 对 `job.status !== "running"` 用 exit code 0(已 completed/cancelled/failed),但 payload 含 `ok:false` → 脚本消费时无法靠 exit code 区分 "cancel 成功" 和 "已是终态"

**File**: `plugins/qwen/scripts/qwen-companion.mjs:367-374`

**Finding**:
```js
if (job.status !== "running") {
  emit(
    { ok: false, reason: `job is ${job.status}, not running` },
    `Job ${jobId} is already ${job.status}, nothing to cancel.`,
    0,  // exit 0
  );
}
```
`ok:false` + `exit 0` 对 shell scripts 消费者矛盾。一个 CI/CD 管道常见模式:`qwen-companion cancel --json <id> || echo "cancel failed"` — 用 exit code 分流。当前 "job is completed" 返 exit 0,shell 把它当成功,尽管 JSON 里 `ok:false`。

历史版本(v0.1.2 前)也是 exit 0,commit `833c531 fix(cancel): --json flag 真分流 + 已 completed job 人类可读` 新加人类可读文本时保留了 exit 0。这是刻意保留 compat,但与 JSON envelope 语义不符。

**Recommendation**: 选一边:
- 选项 A(推荐):`ok:false` 一律 exit !=0;"job is <终态>" 用 exit code `4`(区别于 5=signal fail、3=not found)。
- 选项 B:JSON payload 也 `ok:true, no_op:true, status: "<终态>"`(语义:对终态 job 的 cancel 请求本来就该 no-op)。

---

## P2 / Nit

### [P2-1] `loadState` migrate 后 legacy 对象同时留 `id` 和 `jobId` 两字段,saveState 会把两个都写回磁盘

**File**: `plugins/qwen/scripts/lib/state.mjs:85`

**Finding**: `if (j && j.jobId == null && j.id != null) j.jobId = j.id;` — 只补 `jobId`,没删 `j.id`。之后 upsertJob 触发 saveState 时,`id` 字段会一起写回,状态文件里有冗余。测试 `loadState: legacy { id } → jobId migrate-on-read` 第 78 行明确 assert "原字段保留",这是故意的。

不算 bug,只是 maintenance debt — 以后读这个字段的人会疑惑。建议注释提一句 "legacy 兼容,保留便于回滚";或 migration 时就 `delete j.id`(反正 pruneJobs 之后所有代码只读 jobId)。

---

### [P2-2] `extractStderrFromLog` 判非 JSON 行仅靠 `trim().startsWith("{")` → 可能漏/误抓

**File**: `plugins/qwen/scripts/lib/job-lifecycle.mjs:18-28`

**Finding**:
- qwen 崩溃栈行首 `"    at Socket.emit"` 以空格开头,trim 后 `at...` 不是 `{` → 被当 stderr ✓ 
- 但若 stderr 某行是 `"{some debug log}"`(非 JSONL 但碰巧首字符 `{`),会被当成 JSONL 过滤掉,丢失 debug 信息。
- 反过来若 stream-json 某行输出被截半(bg spawn 直接 fd 写 log,没 buffer),半行 stream-json 可能开头不是 `{`(被 write call 切成两半),会被误当 stderr 塞进 failure.detail,混淆诊断。

概率低。可改用更严 detect:`try { JSON.parse(line); continue; } catch { nonJson.push(line); }` — O(n) 但 log 已经 tail 1MB 了可接受。

---

### [P2-3] `review-validate.mjs` 对 `additionalProperties: false` 无 `properties` 的 schema 会错误放行

**File**: `plugins/qwen/scripts/lib/review-validate.mjs:52-58`

**Finding**:
```js
if (schema.additionalProperties === false && schema.properties) { ... }
```
如果 schema 是 `{ type: "object", additionalProperties: false }`(无 properties 声明),按 JSON Schema spec 语义**禁止任何 property**,但当前实现跳过不校。当前 review schema 不触发这种 edge case,但若未来 schema 扩展到 finding 内 sub-object 时漏字段设计,validator 静默通过。P2 for future-proofing。

---

### [P2-4] `getUntrackedFilesDiff` 静默跳过 secret vs `formatUntrackedFiles` 加 skipped 标注 → 两路径 UX 不一致

**File**: `plugins/qwen/scripts/lib/git.mjs:362`

**Finding**: `formatUntrackedFiles`(结构化 review 用)会加 `### <file>\n(skipped: likely secret file...)`;`getUntrackedFilesDiff`(legacy pseudo-diff)是 `continue;` 静默跳过。当前 review 默认走 `collectReviewContext`,用到的是前者 — 但 `getDiff({ scope: "working-tree" })` 仍调后者。user-facing 行为依路径不同,新人维护易踩坑。简单修:后者也加一行说明:
```js
if (isLikelySecretFile(file)) {
  parts.push(`# skipped untracked file ${file}: likely secret`);
  continue;
}
```

---

### [P2-5] `stop-review-gate-hook.runStopReview` 把 `input.cwd` 透传给 companion child,未归一到 workspace root

**File**: `plugins/qwen/scripts/stop-review-gate-hook.mjs:113-118`

**Finding**: hook 自身 main() 调了 `resolveWorkspaceRoot(cwd)` 拿 workspaceRoot 用于 `getConfig/listJobs`,但 `runStopReview(cwd, input)` 用的是原始 `cwd`(L143 `input.cwd || ...`)。companion child 收到后会自己 resolveWorkspaceRoot,所以**不影响正确性**,只是多一次冗余计算。低 P2。

---

### [P2-6] `buildQwenArgs` review path 在多轮 retry 之间无显式 session id → 并发两个 review 的 `-c` 会 cross-talk

**File**: `plugins/qwen/scripts/qwen-companion.mjs:553-572`

**Finding**: review 每轮 spawn 独立 qwen child,不指定 `--session-id`,qwen 自行分配 UUID。retry 用 `-c` 续的是 **qwen CLI 的 "last session"**(qwen 侧状态),不是本 review 的某个已知 session。若用户同时跑两个 `/qwen:review`(CC 支持并发 command),第二个的 retry `-c` 可能续到**第一个 review** 的最后一轮,把 diff/prompt 污染。

实际 CC 一个 session 不并发 slash command,低概率场景。但若用户 bg review 同时 fg review,就触发。

**Recommendation**: 首轮 spawn 用显式 `--session-id <uuid>`(plugin 自生),retry 轮用 `-r <uuid>` 精确续到这个 session,不再靠 `-c` 的 "last" 语义。

---

### [P2-7] `parseAssistantContent` 对 qwen 未来新 block type(除 thinking/text/tool_use/tool_result/image)静默忽略,无计数

**File**: `plugins/qwen/scripts/lib/qwen.mjs:227-253`

**Finding**: 注释说 "thinking / 其它未知 type:F-6 跳过"。未来 qwen 如果加新 type(e.g. `video`、`document`、`web_search_result`),当前 parser 静默丢数据。最低成本改进:`else { out.unknownCount = (out.unknownCount||0) + 1; }`,在 failure 诊断时能看到"qwen 产了 N 个 unknown block"。P2 observability。

---

## 结语

挖了 **4 个 P0 + 6 个 P1 + 7 个 P2**。整体 code quality 不错,v0.2 的 intent 明确、注释扎实、测试基本到位(190 pass),但这次 review 集中暴露了**两类**系统性弱点:

1. **安全边界不一致**:`isLikelySecretFile` 只盖 untracked 路径(P0-2),redact 的 key match 用 substring 导致误伤 + value match 漏抓 Authorization header(P1-1),secret file pattern 把 `.env.example` 也拒(P1-2)。单个修都不难,但说明"防止 secret 泄漏"的威胁模型没成文,每个贡献者只防自己想到的那面。

2. **cwd 归一不彻底**:P0-1 直接把 CLAUDE.md 里黑纸白字的 v0.1.2 invariant 违反了(`runSetup` 漏调 `resolveWorkspaceRoot`),PR 做 review 的时候显然 focus 在 subcommand 新增而没 audit setup 的遗留。

额外 3 个 correctness 坑(P0-3 `/qwen/i` substring + P0-4 emit 控制流 + P1-4 session filter fallback)都属于"写的时候看起来 ok、跑起来也 ok、但某个 corner case 会稳定触发"。加对应测试即可固化。

建议 **P0-1 + P0-2 立修**(一个让 setup 不 work,一个让 review 泄密),**P0-3 重要但可先写 test 固化预期再改**,**P0-4 纯 style 但值得 refactor**。**P1 合并到 v0.2.1 hotfix**。**P2 进 v0.3 backlog**。

测试覆盖没发现"假测试"(全是真断言,不靠 env 隐式依赖作为 must-have)。唯一 env 相关的软点是 P1-5 integration test 的默认 env 透传 — 测试都 pass,但不够 hermetic,clean room 重跑才稳。

没有发现与 FINDINGS F-1..F-17 矛盾的改动;v0.2 的 detectFailure 层 0(F-8)、parseAssistantContent(F-6)、UUID 校验(F-7)实现都对齐。
