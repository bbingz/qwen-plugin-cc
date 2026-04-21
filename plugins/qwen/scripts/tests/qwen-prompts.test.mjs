import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadPromptTemplate, interpolateTemplate } from "../lib/prompts.mjs";

test("loadPromptTemplate: 读 prompts/<name>.md", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-prompts-"));
  try {
    fs.mkdirSync(path.join(root, "prompts"));
    fs.writeFileSync(path.join(root, "prompts", "hello.md"), "Hi {{NAME}}\n");
    const tpl = loadPromptTemplate(root, "hello");
    assert.equal(tpl.trim(), "Hi {{NAME}}");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("loadPromptTemplate: 不存在的模板 throw", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-prompts-"));
  try {
    assert.throws(() => loadPromptTemplate(root, "nope"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("interpolateTemplate: 替换 {{VAR}} 占位符", () => {
  const out = interpolateTemplate("Hi {{NAME}}, welcome to {{PROJECT}}", {
    NAME: "Alice",
    PROJECT: "qwen",
  });
  assert.equal(out, "Hi Alice, welcome to qwen");
});

test("interpolateTemplate: 缺失变量 → 替换为空串", () => {
  const out = interpolateTemplate("Hi {{NAME}}!", {});
  assert.equal(out, "Hi !");
});

test("interpolateTemplate: 只替换 uppercase + underscore 模式", () => {
  // {{lowercase}} 不匹配正则 [A-Z_],原样保留
  const out = interpolateTemplate("Keep {{lowercase}} but replace {{UPPER}}", {
    UPPER: "X",
    lowercase: "y",  // 无效,因 regex 只捕获 uppercase
  });
  assert.equal(out, "Keep {{lowercase}} but replace X");
});

test("interpolateTemplate: 同变量出现多次都替换", () => {
  const out = interpolateTemplate("{{X}} and {{X}} again", { X: "ok" });
  assert.equal(out, "ok and ok again");
});

test("interpolateTemplate: 变量值含特殊字符不解析", () => {
  const out = interpolateTemplate("V={{X}}", { X: "$100 & <html>" });
  assert.equal(out, "V=$100 & <html>");
});
