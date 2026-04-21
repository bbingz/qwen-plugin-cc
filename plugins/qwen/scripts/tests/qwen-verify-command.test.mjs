import { test } from "node:test";
import assert from "node:assert/strict";
import { isQwenCommandLine } from "../lib/qwen.mjs";

test("isQwenCommandLine: 绝对路径 qwen binary + args 匹配", () => {
  assert.equal(isQwenCommandLine("/opt/homebrew/bin/qwen --output-format stream-json"), true);
  assert.equal(isQwenCommandLine("/usr/local/bin/qwen -c"), true);
});

test("isQwenCommandLine: node+qwen 脚本执行(shebang 后)匹配", () => {
  // Qwen CLI 是 node 脚本,kernel exec node 后 argv 是 `/node /qwen`
  assert.equal(isQwenCommandLine("/opt/homebrew/bin/node /opt/homebrew/bin/qwen --foo"), true);
});

test("isQwenCommandLine: qwen 行尾无参数也匹配", () => {
  assert.equal(isQwenCommandLine("/usr/local/bin/qwen"), true);
});

test("isQwenCommandLine: workspace 路径 qwen-plugin-cc 不误匹配", () => {
  // 核心 bug:v0.2 用 /qwen/i substring 在这些场景恒真。修复后必须拒。
  assert.equal(isQwenCommandLine("node /Users/bing/-Code-/qwen-plugin-cc/foo.mjs"), false);
  assert.equal(isQwenCommandLine("vim /Users/bing/-Code-/qwen-plugin-cc/lib/qwen.mjs"), false);
  assert.equal(isQwenCommandLine("/bin/cat /path/to/qwen-plugin-cc/README.md"), false);
});

test("isQwenCommandLine: 参数里含 qwen 字符串不匹配(qwen 前不是 / 或开头)", () => {
  assert.equal(isQwenCommandLine("grep qwen /tmp/file.txt"), false);
  assert.equal(isQwenCommandLine("echo 'looking for qwen'"), false);
});

test("isQwenCommandLine: qwen 是文件名后缀/前缀不匹配", () => {
  assert.equal(isQwenCommandLine("/bin/myqwen --run"), false);       // 前缀 my
  assert.equal(isQwenCommandLine("/bin/qwenplus --run"), false);     // 后缀 plus
  assert.equal(isQwenCommandLine("/bin/qwen_alt --run"), false);     // 后缀 _alt
});

test("isQwenCommandLine: ps -g 多行输出(每行一个进程)逐行匹配", () => {
  const psOut = [
    "/opt/homebrew/bin/node /opt/homebrew/bin/qwen --foo",
    "/bin/cat /tmp/log",
  ].join("\n");
  assert.equal(isQwenCommandLine(psOut), true);
});

test("isQwenCommandLine: 多行全非 qwen → false", () => {
  const psOut = [
    "/bin/cat /tmp/log",
    "/usr/bin/grep qwen /etc",
    "vim /path/qwen-plugin-cc/x",
  ].join("\n");
  assert.equal(isQwenCommandLine(psOut), false);
});

test("isQwenCommandLine: 异常输入安全", () => {
  assert.equal(isQwenCommandLine(null), false);
  assert.equal(isQwenCommandLine(undefined), false);
  assert.equal(isQwenCommandLine(""), false);
  assert.equal(isQwenCommandLine(42), false);
});

test("isQwenCommandLine: qwen 后跟 tab / newline 也算空白", () => {
  assert.equal(isQwenCommandLine("/bin/qwen\t--foo"), true);
  assert.equal(isQwenCommandLine("/bin/qwen\n"), true);
});
