import {
  listJobs,
  sortJobsNewestFirst
} from "./state.mjs";

export const SESSION_ID_ENV = "FRONTIER_COMPANION_SESSION_ID";

export function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

export function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

export function isActiveJob(job) {
  return job.status === "queued" || job.status === "running";
}

export function isFinishedJob(job) {
  return !isActiveJob(job);
}

export function loadJobsNewestFirst(workspaceRoot, options = {}) {
  const reconcile = options.reconcile ?? ((job) => job);
  return sortJobsNewestFirst(listJobs(workspaceRoot)).map(reconcile);
}

export function matchJobReference(jobs, reference, options = {}) {
  const filtered = jobs.filter(options.predicate ?? (() => true));
  const normalized = String(reference ?? "").trim();

  if (!normalized) {
    return options.defaultJob ?? filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === normalized);
  if (exact) {
    return exact;
  }

  const prefixed = filtered.filter((job) => String(job.id).startsWith(normalized));
  if (prefixed.length === 1) {
    return prefixed[0];
  }
  if (prefixed.length > 1) {
    throw new Error(`Job reference "${normalized}" is ambiguous. Use a longer job id.`);
  }

  if (options.allowMissing) {
    return null;
  }
  throw new Error(`No job found for "${normalized}". Run status to list known jobs.`);
}

export function resolveStatusJob(workspaceRoot, reference, options = {}) {
  const jobs = loadJobsNewestFirst(workspaceRoot, options);
  return matchJobReference(jobs, reference);
}

export function resolveResultJob(workspaceRoot, reference, options = {}) {
  const allJobs = loadJobsNewestFirst(workspaceRoot, options);
  const scopedJobs = reference ? allJobs : filterJobsForCurrentSession(allJobs, options);
  const selected = matchJobReference(scopedJobs, reference, {
    predicate: isFinishedJob,
    allowMissing: true
  });

  if (selected) {
    return selected;
  }

  const active = matchJobReference(scopedJobs, reference, {
    predicate: isActiveJob,
    allowMissing: true
  });
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check status ${active.id} and retry once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run status to inspect active jobs.`);
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No finished Frontier jobs found for this session yet.");
  }
  throw new Error("No finished Frontier jobs found for this repository yet.");
}

export function resolveCancelableJob(workspaceRoot, reference, options = {}) {
  const allJobs = loadJobsNewestFirst(workspaceRoot, options);
  const activeJobs = allJobs.filter(isActiveJob);

  if (reference) {
    return matchJobReference(activeJobs, reference);
  }

  const scopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);
  if (scopedActiveJobs.length === 1) {
    return scopedActiveJobs[0];
  }
  if (scopedActiveJobs.length > 1) {
    throw new Error("Multiple Frontier jobs are active. Pass a job id to cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Frontier jobs to cancel for this session.");
  }
  throw new Error("No active Frontier jobs to cancel.");
}
