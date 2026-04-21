import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, splitRawArgumentString } from "../lib/args.mjs";

test("parseArgs: positional only", () => {
  const r = parseArgs(["hi", "there"]);
  assert.deepEqual(r.positionals, ["hi", "there"]);
  assert.deepEqual(r.options, {});
});

test("parseArgs: boolean long option", () => {
  const r = parseArgs(["--json", "job-1"], { booleanOptions: ["json"] });
  assert.equal(r.options.json, true);
  assert.deepEqual(r.positionals, ["job-1"]);
});

test("parseArgs: boolean short option", () => {
  const r = parseArgs(["-c"], { booleanOptions: ["c"] });
  assert.equal(r.options.c, true);
});

test("parseArgs: value option via space", () => {
  const r = parseArgs(["--base", "main", "extra"], { valueOptions: ["base"] });
  assert.equal(r.options.base, "main");
  assert.deepEqual(r.positionals, ["extra"]);
});

test("parseArgs: value option via equals", () => {
  const r = parseArgs(["--base=main"], { valueOptions: ["base"] });
  assert.equal(r.options.base, "main");
});

test("parseArgs: boolean option with =false 关掉", () => {
  const r = parseArgs(["--json=false"], { booleanOptions: ["json"] });
  assert.equal(r.options.json, false);
});

test("parseArgs: value option 缺值 → throw", () => {
  assert.throws(
    () => parseArgs(["--base"], { valueOptions: ["base"] }),
    /Missing value for --base/,
  );
});

test("parseArgs: alias 映射", () => {
  const r = parseArgs(["-b", "main"], {
    valueOptions: ["base"],
    aliasMap: { b: "base" },
  });
  assert.equal(r.options.base, "main");
});

test("parseArgs: `--` 后一切变 positional", () => {
  const r = parseArgs(["--json", "--", "--not-a-flag", "text"], {
    booleanOptions: ["json"],
  });
  assert.equal(r.options.json, true);
  assert.deepEqual(r.positionals, ["--not-a-flag", "text"]);
});

test("parseArgs: 未声明的 long flag → positional 保留", () => {
  const r = parseArgs(["--unknown", "x"]);
  assert.deepEqual(r.positionals, ["--unknown", "x"]);
});

test("parseArgs: 未声明的 short flag → positional 保留", () => {
  const r = parseArgs(["-x"]);
  assert.deepEqual(r.positionals, ["-x"]);
});

test("parseArgs: 单 `-` 视为 positional(stdin 约定)", () => {
  const r = parseArgs(["-"]);
  assert.deepEqual(r.positionals, ["-"]);
});

test("splitRawArgumentString: 基本空格分词", () => {
  assert.deepEqual(splitRawArgumentString("a b c"), ["a", "b", "c"]);
});

test("splitRawArgumentString: 双引号内空格保留", () => {
  assert.deepEqual(splitRawArgumentString(`"hello world" x`), ["hello world", "x"]);
});

test("splitRawArgumentString: 单引号同理", () => {
  assert.deepEqual(splitRawArgumentString(`'a b' c`), ["a b", "c"]);
});

test("splitRawArgumentString: 反斜杠转义", () => {
  assert.deepEqual(splitRawArgumentString(`a\\ b`), ["a b"]);
});

test("splitRawArgumentString: 空 input 返空 array", () => {
  assert.deepEqual(splitRawArgumentString(""), []);
});

test("splitRawArgumentString: 多空格合并", () => {
  assert.deepEqual(splitRawArgumentString("a   b\t\tc"), ["a", "b", "c"]);
});
