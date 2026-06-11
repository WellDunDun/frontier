#!/usr/bin/env node

// Frontier companion runtime.
//
// Deterministic Node entry point that owns ALL provider / CLI mechanics for
// delegating bounded sub-tasks to the Pi and Codex harnesses, both backed by a
// local oMLX server. Agent and command prompt files never compose pi/codex CLI
// strings themselves — they only call this script.
//
// Subcommands: task | status | result | cancel | setup

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { resolveBackend } from "./lib/backend.mjs";
import {
  renderCancel,
  renderJobDetail,
  renderQueued,
  renderResult,
  renderStatusList,
  renderTaskResult
} from "./lib/render.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  preflight,
  recordJobResult,
  runHarness
} from "./lib/runner.mjs";
import { buildSetupReport, renderSetupReport } from "./lib/setup.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import {
  generateJobId,
  listJobs,
  matchJob,
  nowIso,
  readJobFile,
  sortJobsNewestFirst,
  upsertJob
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const VALID_HARNESSES = new Set(["pi", "codex"]);

function printUsage() {
  process.stdout.write(
    [
      "Frontier companion — delegate bounded tasks to local Pi / Codex harnesses.",
      "",
      "Usage:",
      '  node scripts/frontier-companion.mjs task [--harness pi|codex] [--write] [--model <m>] [--background] [--timeout-ms <n>] "<prompt>"',
      "  node scripts/frontier-companion.mjs status [jobId] [--json]",
      "  node scripts/frontier-companion.mjs result <jobId> [--json]",
      "  node scripts/frontier-companion.mjs cancel <jobId> [--json]",
      "  node scripts/frontier-companion.mjs setup [--apply] [--json]",
      "      --apply provisions BOTH harnesses (Pi provider + Codex profile);",
      "      requires the local server to be up. --apply-codex is a kept alias.",
      ""
    ].join("\n")
  );
}

function emit(value, rendered, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    process.stdout.write(rendered);
  }
}

function resolveCwd(options) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  try {
    return fs.readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function excerpt(text, limit = 200) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

// -----------------------------------------------------------------------------
// task
// -----------------------------------------------------------------------------

async function handleTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["harness", "model", "timeout-ms", "cwd", "job-id"],
    booleanOptions: ["write", "background", "json", "worker"],
    aliasMap: { m: "model" }
  });

  // Background worker re-entry: a detached child runs this with --worker.
  if (options.worker) {
    return runBackgroundWorker(options);
  }

  const harness = (options.harness ?? "pi").toLowerCase();
  if (!VALID_HARNESSES.has(harness)) {
    throw new Error(`Unknown harness "${options.harness}". Use pi or codex.`);
  }

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const write = Boolean(options.write);
  const model = options.model ?? null;
  const timeoutMs = options["timeout-ms"] ? Number(options["timeout-ms"]) : DEFAULT_TIMEOUT_MS;

  const prompt = (positionals.join(" ").trim() || readStdinIfPiped()).trim();
  if (!prompt) {
    throw new Error('Provide a prompt: task --harness pi "<prompt>" (or pipe it on stdin).');
  }

  // Structural guardrail: refuse before launching if provider config is missing
  // or the local server is down. This makes a cloud fallback impossible. The
  // resolved backend is reused for the run so config precedence is consistent.
  const backend = resolveBackend({ workspaceRoot });
  const check = await preflight({ harness, scriptPath: SCRIPT_PATH, backend });
  if (!check.ok) {
    process.stderr.write(`${check.problems.join("\n")}\n`);
    if (options.json) {
      emit({ ok: false, problems: check.problems, health: check.health }, "", true);
    }
    process.exitCode = 1;
    return;
  }

  const jobId = generateJobId(harness);
  const baseRecord = {
    id: jobId,
    harness,
    model,
    write,
    cwd,
    workspaceRoot,
    promptExcerpt: excerpt(prompt),
    timeoutMs,
    createdAt: nowIso(),
    status: "queued"
  };
  upsertJob(workspaceRoot, jobId, baseRecord);

  if (options.background) {
    const child = spawnDetachedWorker({ cwd, jobId });
    upsertJob(workspaceRoot, jobId, {
      status: "running",
      startedAt: nowIso(),
      pid: child.pid ?? null,
      prompt
    });
    // Persist the prompt so the detached worker can read it back.
    upsertJob(workspaceRoot, jobId, { prompt });
    const job = readJobFile(workspaceRoot, jobId);
    emit({ jobId, status: "running", harness }, renderQueued(job), options.json);
    return;
  }

  upsertJob(workspaceRoot, jobId, { status: "running", startedAt: nowIso(), pid: process.pid });
  const result = await runHarness({
    harness,
    model,
    write,
    prompt,
    cwd,
    workspaceRoot,
    jobId,
    timeoutMs,
    backend
  });
  recordJobResult(workspaceRoot, jobId, result);
  const job = readJobFile(workspaceRoot, jobId);

  emit(
    {
      jobId,
      status: result.failed ? "failed" : "completed",
      harness: result.harness,
      model: result.model,
      finalMessage: result.finalMessage,
      exitStatus: result.exitStatus,
      timedOut: result.timedOut
    },
    renderTaskResult(job, result),
    options.json
  );
  if (result.failed) {
    process.exitCode = 1;
  }
}

function spawnDetachedWorker({ cwd, jobId }) {
  const child = spawn(process.execPath, [SCRIPT_PATH, "task", "--worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

async function runBackgroundWorker(options) {
  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobId = options["job-id"];
  if (!jobId) {
    throw new Error("Background worker requires --job-id.");
  }
  const job = readJobFile(workspaceRoot, jobId);
  if (!job) {
    throw new Error(`No stored job ${jobId}.`);
  }

  upsertJob(workspaceRoot, jobId, { status: "running", startedAt: job.startedAt ?? nowIso(), pid: process.pid });

  try {
    const result = await runHarness({
      harness: job.harness,
      model: job.model,
      write: job.write,
      prompt: job.prompt,
      cwd: job.cwd ?? cwd,
      workspaceRoot,
      jobId,
      timeoutMs: job.timeoutMs ?? DEFAULT_TIMEOUT_MS
    });
    recordJobResult(workspaceRoot, jobId, result);
  } catch (error) {
    upsertJob(workspaceRoot, jobId, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      completedAt: nowIso(),
      pid: null
    });
  }
}

// -----------------------------------------------------------------------------
// status
// -----------------------------------------------------------------------------

function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).map(reconcileJobLiveness);
  const reference = positionals[0];

  if (reference) {
    const job = matchJob(jobs, reference);
    emit(job, renderJobDetail(job), options.json);
    return;
  }

  emit({ jobs }, renderStatusList(jobs), options.json);
}

// If a job claims to be running but its pid is gone (and no completion was
// recorded), surface it as failed so status never lies.
function reconcileJobLiveness(job) {
  if (job.status !== "running" && job.status !== "queued") {
    return job;
  }
  if (job.pid && processIsAlive(job.pid)) {
    return job;
  }
  if (job.finalMessage || job.completedAt) {
    return job;
  }
  return { ...job, status: "failed", errorMessage: job.errorMessage ?? "Process exited without recording a result." };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// -----------------------------------------------------------------------------
// result
// -----------------------------------------------------------------------------

function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).map(reconcileJobLiveness);
  const job = matchJob(jobs, positionals[0]);
  emit(job, renderResult(job), options.json);
}

// -----------------------------------------------------------------------------
// cancel
// -----------------------------------------------------------------------------

function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const job = matchJob(jobs, positionals[0]);

  if (job.pid) {
    terminateProcessTree(job.pid);
  }
  const updated = upsertJob(workspaceRoot, job.id, {
    status: "cancelled",
    pid: null,
    completedAt: nowIso(),
    errorMessage: "Cancelled by user."
  });
  emit(updated, renderCancel(updated), options.json);
}

// -----------------------------------------------------------------------------
// setup
// -----------------------------------------------------------------------------

async function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "apply", "apply-codex"]
  });

  // --apply provisions both harnesses; --apply-codex is kept as a backward-
  // compatible alias for the same provisioning flow.
  const apply = Boolean(options.apply || options["apply-codex"]);
  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  const report = await buildSetupReport({ apply, workspaceRoot });
  emit(report, renderSetupReport(report), options.json);
  if (!report.ready) {
    process.exitCode = 1;
  }
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "task":
      await handleTask(argv);
      break;
    case "status":
      handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      handleCancel(argv);
      break;
    case "setup":
      await handleSetup(argv);
      break;
    default:
      throw new Error(`Unknown subcommand "${subcommand}". Run with --help.`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
