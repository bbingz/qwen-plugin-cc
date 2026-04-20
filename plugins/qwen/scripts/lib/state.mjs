import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Constants ────────────────────────────────────────────

export const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "qwen-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

// ── Path resolution ──────────────────────────────────────

function computeWorkspaceSlug(workspaceRoot) {
  const base = path.basename(workspaceRoot);
  const slug = base.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const hash = crypto
    .createHash("sha256")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 16);
  return `${slug}-${hash}`;
}

export function stateRootDir() {
  const pluginData = process.env[PLUGIN_DATA_ENV];
  if (pluginData) {
    return path.join(pluginData, "state");
  }
  return FALLBACK_STATE_ROOT_DIR;
}

export function resolveStateDir(workspaceRoot) {
  return path.join(stateRootDir(), computeWorkspaceSlug(workspaceRoot));
}

export function resolveStateFile(workspaceRoot) {
  return path.join(resolveStateDir(workspaceRoot), STATE_FILE_NAME);
}

export function resolveJobsDir(workspaceRoot) {
  return path.join(resolveStateDir(workspaceRoot), JOBS_DIR_NAME);
}

export function ensureStateDir(workspaceRoot) {
  fs.mkdirSync(resolveJobsDir(workspaceRoot), { recursive: true });
}

export function resolveJobFile(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.json`);
}

export function resolveJobLogFile(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.log`);
}

// ── Default state ────────────────────────────────────────

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {},
    jobs: [],
  };
}

// ── State I/O ────────────────────────────────────────────

export function loadState(workspaceRoot) {
  const file = resolveStateFile(workspaceRoot);
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      if (!raw.trim()) continue; // empty file from concurrent write
      const state = JSON.parse(raw);
      if (state && typeof state === "object") return state;
    } catch {
      if (attempt < maxRetries - 1) {
        // Brief pause before retry — concurrent writer may still be flushing
        const waitUntil = Date.now() + 20;
        while (Date.now() < waitUntil) { /* spin */ }
        continue;
      }
    }
  }
  return defaultState();
}

export function saveState(workspaceRoot, state) {
  ensureStateDir(workspaceRoot);
  // Prune old jobs
  state.jobs = pruneJobs(state.jobs);
  // Remove orphaned job files
  cleanupOrphanedFiles(workspaceRoot, state.jobs);
  fs.writeFileSync(
    resolveStateFile(workspaceRoot),
    JSON.stringify(state, null, 2) + "\n"
  );
}

export function updateState(workspaceRoot, mutate) {
  ensureStateDir(workspaceRoot);
  const lockFile = resolveStateFile(workspaceRoot) + ".lock";
  const maxRetries = 10;
  const retryDelayMs = 50;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Acquire exclusive lock
      const lockFd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.closeSync(lockFd);

      try {
        const state = loadState(workspaceRoot);
        mutate(state);
        saveState(workspaceRoot, state);
        return state;
      } finally {
        removeFileIfExists(lockFile);
      }
    } catch (e) {
      if (e.code === "EEXIST") {
        // Lock held by another process, retry after delay
        const waitUntil = Date.now() + retryDelayMs * (attempt + 1);
        while (Date.now() < waitUntil) { /* spin */ }

        // Clean up stale locks (older than 30s)
        try {
          const stat = fs.statSync(lockFile);
          if (Date.now() - stat.mtimeMs > 30_000) {
            removeFileIfExists(lockFile);
          }
        } catch { /* lock already removed */ }
        continue;
      }
      throw e;
    }
  }

  // Fallback: proceed without lock after exhausting retries
  const state = loadState(workspaceRoot);
  mutate(state);
  saveState(workspaceRoot, state);
  return state;
}

function pruneJobs(jobs) {
  return jobs
    .slice()
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, MAX_JOBS);
}

function cleanupOrphanedFiles(workspaceRoot, jobs) {
  const jobIds = new Set(jobs.map((j) => j.jobId ?? j.id));
  const jobsDir = resolveJobsDir(workspaceRoot);
  try {
    for (const file of fs.readdirSync(jobsDir)) {
      const id = file.replace(/\.(json|log)$/, "");
      if (!jobIds.has(id)) {
        removeFileIfExists(path.join(jobsDir, file));
      }
    }
  } catch {
    // jobsDir may not exist yet
  }
}

function removeFileIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

// ── Job operations ───────────────────────────────────────

export function generateJobId(prefix = "gj") {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString("hex");
  return `${prefix}-${ts}-${rand}`;
}

export function upsertJob(workspaceRoot, jobPatch) {
  return updateState(workspaceRoot, (state) => {
    const now = new Date().toISOString();
    // qwen job 用 jobId,gemini 血统用 id。两边都要匹配,防止 undefined === undefined 误覆盖。
    const patchKey = jobPatch.jobId ?? jobPatch.id;
    const idx = patchKey == null
      ? -1
      : state.jobs.findIndex((j) => (j.jobId ?? j.id) === patchKey);
    if (idx >= 0) {
      state.jobs[idx] = { ...state.jobs[idx], ...jobPatch, updatedAt: now };
    } else {
      state.jobs.push({
        ...jobPatch,
        createdAt: jobPatch.createdAt || now,
        updatedAt: now,
      });
    }
  });
}

export function listJobs(workspaceRoot) {
  return loadState(workspaceRoot).jobs;
}

export function writeJobFile(workspaceRoot, jobId, payload) {
  ensureStateDir(workspaceRoot);
  const file = resolveJobFile(workspaceRoot, jobId);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
}

export function readJobFile(jobFile) {
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch {
    return null;
  }
}

export function removeJobFile(jobFile) {
  removeFileIfExists(jobFile);
}

// ── Timing history (global) ──────────────────────────────

const TIMING_FILE_NAME = "timings.ndjson";
const TIMING_LOCK_NAME = "timings.ndjson.lock";
const TIMING_LOCK_ACQUIRE_MS = 10_000;
const TIMING_MAX_BYTES = 10 * 1024 * 1024;

export function resolveTimingHistoryFile() {
  return path.join(stateRootDir(), "..", TIMING_FILE_NAME);
}

function resolveTimingLockFile() {
  return path.join(stateRootDir(), "..", TIMING_LOCK_NAME);
}

function acquireTimingLock() {
  const lockFile = resolveTimingLockFile();
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + TIMING_LOCK_ACQUIRE_MS;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.closeSync(fd);
      return lockFile;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Sleep spin
      const until = Date.now() + 25;
      while (Date.now() < until) { /* spin */ }
      // Clean stale lock (>30s old)
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > 30_000) removeFileIfExists(lockFile);
      } catch { /* gone */ }
    }
  }
  return null;
}

function releaseTimingLock() {
  removeFileIfExists(resolveTimingLockFile());
}

export function appendTimingHistory(record) {
  const file = resolveTimingHistoryFile();
  const lock = acquireTimingLock();
  if (!lock) {
    try { process.stderr.write(`[timing] lock acquire timeout; dropping record ${record?.jobId || "?"}\n`); } catch { /* ignore */ }
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // Repair: if file ends without \n (prior crash), prepend one
    let needsLeadingNewline = false;
    try {
      const st = fs.statSync(file);
      if (st.size > 0) {
        const buf = Buffer.alloc(1);
        const fd = fs.openSync(file, "r");
        try {
          fs.readSync(fd, buf, 0, 1, st.size - 1);
        } finally {
          fs.closeSync(fd);
        }
        if (buf[0] !== 0x0A /* \n */) needsLeadingNewline = true;
      }
    } catch { /* new file */ }

    const line = (needsLeadingNewline ? "\n" : "") + JSON.stringify(record) + "\n";
    fs.appendFileSync(file, line);

    // Trim if over size threshold
    try {
      const st = fs.statSync(file);
      if (st.size > TIMING_MAX_BYTES) {
        const raw = fs.readFileSync(file, "utf8");
        const lines = raw.split("\n").filter(Boolean);
        // Keep only valid JSON lines
        const valid = [];
        for (const l of lines) {
          try { JSON.parse(l); valid.push(l); } catch { /* drop */ }
        }
        const keep = valid.slice(Math.floor(valid.length / 2));
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, keep.join("\n") + "\n");
        fs.renameSync(tmp, file);
      }
    } catch (e) {
      try { process.stderr.write(`[timing] trim failed: ${e.message}\n`); } catch { /* ignore */ }
    }

    return true;
  } catch (e) {
    try { process.stderr.write(`[timing] append failed: ${e.message}\n`); } catch { /* ignore */ }
    return false;
  } finally {
    releaseTimingLock();
  }
}

export function readTimingHistory() {
  const file = resolveTimingHistoryFile();
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip corrupted line
    }
  }
  return out;
}

// ── Config operations ────────────────────────────────────

export function getConfig(workspaceRoot) {
  return loadState(workspaceRoot).config || {};
}

export function setConfig(workspaceRoot, key, value) {
  updateState(workspaceRoot, (state) => {
    state.config = state.config || {};
    state.config[key] = value;
  });
}
