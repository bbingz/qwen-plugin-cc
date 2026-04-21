import fs from "node:fs";
import path from "node:path";

import { runCommand, runCommandChecked } from "./process.mjs";

// ── Constants ───────────────────────────────────────────

const MAX_UNTRACKED_BYTES = 24 * 1024; // 24KB per untracked file
const BINARY_EXTENSIONS = /\.(png|jpg|jpeg|gif|ico|webp|bmp|woff|woff2|ttf|eot|otf|pdf|zip|gz|tar|bz2|7z|rar|bin|exe|dll|so|dylib|o|a|pyc|class|wasm|mp3|mp4|wav|avi|mov|mkv)$/i;

// ── Helpers ─────────────────────────────────────────────

function git(cwd, args) {
  return runCommand("git", args, { cwd });
}

function gitChecked(cwd, args) {
  return runCommandChecked("git", args, { cwd });
}

function formatSection(title, body) {
  const content = body.trim() ? body.trim() : "(none)";
  return `## ${title}\n\n${content}\n`;
}

// ── Repository basics ───────────────────────────────────

/**
 * Verify we are inside a git repository.
 */
export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (result.status !== 0) {
    throw new Error("Not a git repository. Run this command inside a git repo.");
  }
}

/**
 * Get the repository root.
 */
export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

/**
 * Resolve workspace root: repo root if inside git repo, else cwd fallback.
 * Shared by hooks + companion so state dir is consistent across sub-directories.
 */
export function resolveWorkspaceRoot(cwd) {
  try {
    ensureGitRepository(cwd);
    return getRepoRoot(cwd) || cwd;
  } catch {
    return cwd;
  }
}

/**
 * Get current branch name.
 */
export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

/**
 * Detect the default base branch.
 * Tries: origin/HEAD symref → origin/main → origin/master → local main → local master.
 * Throws if none found instead of silently guessing.
 */
export function detectBaseBranch(cwd) {
  // Try symbolic-ref first
  const symRef = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symRef.status === 0 && symRef.stdout.trim()) {
    return symRef.stdout.trim().replace("refs/remotes/origin/", "");
  }

  // Try remote branches
  for (const branch of ["main", "master"]) {
    const result = git(cwd, ["rev-parse", "--verify", `origin/${branch}`]);
    if (result.status === 0) return branch;
  }

  // Try local branches
  for (const branch of ["main", "master", "trunk", "develop"]) {
    const result = git(cwd, ["rev-parse", "--verify", branch]);
    if (result.status === 0) return branch;
  }

  throw new Error(
    "Cannot detect base branch. Use --base <branch> to specify it explicitly."
  );
}

// ── Working tree state ──────────────────────────────────

/**
 * Get structured working tree state: file lists for staged, unstaged, untracked.
 * Uses non-throwing git() to handle repos without commits gracefully.
 */
export function getWorkingTreeState(cwd) {
  const stagedResult = git(cwd, ["diff", "--cached", "--name-only"]);
  const staged = stagedResult.status === 0
    ? stagedResult.stdout.trim().split("\n").filter(Boolean)
    : [];

  const unstagedResult = git(cwd, ["diff", "--name-only"]);
  const unstaged = unstagedResult.status === 0
    ? unstagedResult.stdout.trim().split("\n").filter(Boolean)
    : [];

  const untrackedResult = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const untracked = untrackedResult.status === 0
    ? untrackedResult.stdout.trim().split("\n").filter(Boolean)
    : [];

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
  };
}

// ── Diff collection (legacy API, still used by getDiff) ─

/**
 * Collect git diff based on scope.
 *
 * Scopes:
 * - "working-tree" — staged + unstaged + untracked changes
 * - "staged" — staged changes only
 * - "unstaged" — unstaged changes only (tracked files)
 * - "branch" — current branch vs base
 * - "auto" (default) — local modifications first (staged+unstaged+untracked),
 *   then branch diff, so we never miss what the user is actively editing
 */
export function getDiff({ base, scope = "auto", cwd }) {
  if (scope === "staged") {
    return git(cwd, ["diff", "--cached"]).stdout || "";
  }

  if (scope === "unstaged") {
    return git(cwd, ["diff"]).stdout || "";
  }

  if (scope === "working-tree") {
    return getWorkingTreeDiff(cwd);
  }

  if (scope === "branch") {
    const resolvedBase = base || detectBaseBranch(cwd);
    return git(cwd, ["diff", `${resolvedBase}...HEAD`]).stdout || "";
  }

  // auto: prefer local modifications (what the user is editing right now),
  // then fall back to committed branch diff
  const local = getLocalModifications(cwd);
  if (local.trim()) return local;

  const resolvedBase = base || detectBaseBranch(cwd);
  const branch = git(cwd, ["diff", `${resolvedBase}...HEAD`]).stdout || "";
  if (branch.trim()) return branch;

  return "";
}

/**
 * Get all local modifications: staged + unstaged + untracked file contents.
 */
function getLocalModifications(cwd) {
  const parts = [];

  const staged = git(cwd, ["diff", "--cached"]).stdout || "";
  if (staged.trim()) parts.push(staged);

  const unstaged = git(cwd, ["diff"]).stdout || "";
  if (unstaged.trim()) parts.push(unstaged);

  const untracked = getUntrackedFilesDiff(cwd);
  if (untracked.trim()) parts.push(untracked);

  return parts.join("\n");
}

/**
 * Get working tree diff including staged + unstaged + untracked.
 */
function getWorkingTreeDiff(cwd) {
  const parts = [];

  const staged = git(cwd, ["diff", "--cached"]).stdout || "";
  if (staged.trim()) parts.push(staged);

  const unstaged = git(cwd, ["diff"]).stdout || "";
  if (unstaged.trim()) parts.push(unstaged);

  const untracked = getUntrackedFilesDiff(cwd);
  if (untracked.trim()) parts.push(untracked);

  return parts.join("\n");
}

// ── Structured review context (Codex-aligned) ───────────

/**
 * Collect structured review context with separated sections.
 * Returns { mode, summary, content } matching Codex's collectReviewContext pattern.
 */
export function collectReviewContext(cwd, { base, scope = "auto" } = {}) {
  const repoRoot = getRepoRoot(cwd);
  const state = getWorkingTreeState(repoRoot);
  const currentBranch = getCurrentBranch(repoRoot);

  // Determine review mode
  let mode;
  if (scope === "staged" || scope === "unstaged" || scope === "working-tree") {
    mode = "working-tree";
  } else if (scope === "branch") {
    mode = "branch";
  } else {
    // auto
    mode = state.isDirty ? "working-tree" : "branch";
  }

  let details;
  if (mode === "working-tree") {
    details = collectWorkingTreeContext(repoRoot, state, scope);
  } else {
    const resolvedBase = base || detectBaseBranch(repoRoot);
    details = collectBranchContext(repoRoot, resolvedBase);
  }

  return {
    repoRoot,
    branch: currentBranch,
    mode,
    ...details,
  };
}

function collectWorkingTreeContext(cwd, state, scope) {
  const status = gitChecked(cwd, ["status", "--short"]).stdout.trim();
  const parts = [formatSection("Git Status", status)];

  if (scope !== "unstaged") {
    const stagedDiff = git(cwd, ["diff", "--cached", "--no-ext-diff"]).stdout || "";
    parts.push(formatSection("Staged Diff", stagedDiff));
  }

  if (scope !== "staged") {
    const unstagedDiff = git(cwd, ["diff", "--no-ext-diff"]).stdout || "";
    parts.push(formatSection("Unstaged Diff", unstagedDiff));
  }

  if (scope !== "staged" && scope !== "unstaged") {
    const untrackedBody = formatUntrackedFiles(cwd, state.untracked);
    parts.push(formatSection("Untracked Files", untrackedBody));
  }

  return {
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
  };
}

function collectBranchContext(cwd, baseRef) {
  const mergeBaseResult = git(cwd, ["merge-base", "HEAD", baseRef]);
  const mergeBase = mergeBaseResult.status === 0
    ? mergeBaseResult.stdout.trim()
    : baseRef;
  const commitRange = `${mergeBase}..HEAD`;
  const currentBranch = getCurrentBranch(cwd);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", commitRange]).stdout.trim();
  const diff = git(cwd, ["diff", "--no-ext-diff", commitRange]).stdout || "";

  return {
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase.slice(0, 10)}.`,
    content: [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Branch Diff", diff),
    ].join("\n"),
  };
}

function formatUntrackedFiles(cwd, files) {
  if (files.length === 0) return "(none)";

  const parts = [];
  for (const file of files) {
    if (BINARY_EXTENSIONS.test(file)) continue;

    const absPath = path.resolve(cwd, file);
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }

    if (stat.size > MAX_UNTRACKED_BYTES) {
      parts.push(`### ${file}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`);
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(absPath, "utf8");
    } catch {
      continue;
    }
    if (!content.trim()) continue;

    parts.push(`### ${file}\n\`\`\`\n${content.trimEnd()}\n\`\`\``);
  }

  return parts.join("\n\n") || "(none)";
}

// ── Legacy untracked pseudo-diff ────────────────────────

/**
 * Generate a pseudo-diff for untracked files so they appear in reviews.
 */
function getUntrackedFilesDiff(cwd) {
  const result = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const files = (result.stdout || "").trim().split("\n").filter(Boolean);
  if (files.length === 0) return "";

  const parts = [];
  for (const file of files) {
    if (BINARY_EXTENSIONS.test(file)) continue;

    const absPath = path.resolve(cwd || ".", file);
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }
    if (stat.size > MAX_UNTRACKED_BYTES) continue;

    let fileContent;
    try {
      fileContent = fs.readFileSync(absPath, "utf8");
    } catch {
      continue;
    }
    if (!fileContent.trim()) continue;

    const lines = fileContent.split("\n");
    const diffLines = lines.map((line) => `+${line}`);
    parts.push(
      `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${diffLines.join("\n")}`
    );
  }

  return parts.join("\n");
}

// ── Diff stat ───────────────────────────────────────────

/**
 * Get a short summary of changes (file list + stats).
 */
export function getDiffStat({ base, scope = "auto", cwd }) {
  if (scope === "staged") {
    return git(cwd, ["diff", "--cached", "--stat"]).stdout || "";
  }
  if (scope === "unstaged") {
    return git(cwd, ["diff", "--stat"]).stdout || "";
  }
  if (scope === "working-tree") {
    const parts = [];
    const staged = git(cwd, ["diff", "--cached", "--stat"]).stdout || "";
    if (staged.trim()) parts.push("Staged:\n" + staged);
    const unstaged = git(cwd, ["diff", "--stat"]).stdout || "";
    if (unstaged.trim()) parts.push("Unstaged:\n" + unstaged);
    return parts.join("\n") || "";
  }
  // auto and branch: compare against base
  const resolvedBase = base || detectBaseBranch(cwd);
  return git(cwd, ["diff", "--stat", `${resolvedBase}...HEAD`]).stdout || "";
}
