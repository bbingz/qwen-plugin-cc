import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = new URL("../../../../", import.meta.url).pathname;

test("ask command file exists and routes to qwen-companion task", () => {
  const askPath = path.join(ROOT, "plugins/qwen/commands/ask.md");
  assert.ok(fs.existsSync(askPath), "ask.md must exist");
  const content = fs.readFileSync(askPath, "utf8");
  assert.match(
    content,
    /^---[\s\S]*description:[\s\S]*argument-hint:[\s\S]*allowed-tools:[\s\S]*---/,
    "frontmatter required"
  );
  assert.match(content, /qwen-companion\.mjs"\s+task\b/, "must route to task subcommand");
});
