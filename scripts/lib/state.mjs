import fs from "node:fs";
import path from "node:path";

// Job state lives in a project-local `.frontier/` directory so it travels with
// the repository and is easy to inspect. Each job has a JSON record plus stdout
// and stderr log files.

const FRONTIER_DIR = ".frontier";
const JOBS_DIR = "jobs";
const MAX_JOBS = 50;

export function nowIso() {
  return new Date().toISOString();
}

export function resolveFrontierDir(workspaceRoot) {
  return path.join(workspaceRoot, FRONTIER_DIR);
}

export function resolveJobsDir(workspaceRoot) {
  return path.join(resolveFrontierDir(workspaceRoot), JOBS_DIR);
}

export function ensureJobsDir(workspaceRoot) {
  const dir = resolveJobsDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveJobFile(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.json`);
}

export function resolveJobStdoutFile(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.stdout.log`);
}

export function resolveJobStderrFile(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.stderr.log`);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function writeJobFile(workspaceRoot, jobId, payload) {
  ensureJobsDir(workspaceRoot);
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch {
    return null;
  }
}

// Merge a patch into an existing job record (or create it), bumping updatedAt.
export function upsertJob(workspaceRoot, jobId, patch) {
  const existing = readJobFile(workspaceRoot, jobId) ?? {};
  const merged = {
    createdAt: existing.createdAt ?? nowIso(),
    ...existing,
    ...patch,
    id: jobId,
    updatedAt: nowIso()
  };
  writeJobFile(workspaceRoot, jobId, merged);
  pruneOldJobs(workspaceRoot);
  return merged;
}

export function listJobs(workspaceRoot) {
  const dir = resolveJobsDir(workspaceRoot);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const jobs = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8"));
      if (record && typeof record === "object") {
        jobs.push(record);
      }
    } catch {
      // Skip unreadable job files rather than failing the whole listing.
    }
  }
  return jobs;
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) =>
    String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""))
  );
}

function pruneOldJobs(workspaceRoot) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  if (jobs.length <= MAX_JOBS) {
    return;
  }
  for (const job of jobs.slice(MAX_JOBS)) {
    for (const file of [
      resolveJobFile(workspaceRoot, job.id),
      resolveJobStdoutFile(workspaceRoot, job.id),
      resolveJobStderrFile(workspaceRoot, job.id)
    ]) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  }
}

// Resolve a job by exact id or unambiguous prefix.
export function matchJob(jobs, reference) {
  if (!reference) {
    return jobs[0] ?? null;
  }
  const exact = jobs.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }
  const prefixed = jobs.filter((job) => String(job.id).startsWith(reference));
  if (prefixed.length === 1) {
    return prefixed[0];
  }
  if (prefixed.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }
  throw new Error(`No job found for "${reference}". Run status to list known jobs.`);
}
