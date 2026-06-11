import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  buildCodexArgs,
  buildPiArgs,
  buildPiPrompt,
  checkOmlxHealth,
  codexProfilePresent,
  extractPiFinalMessage,
  fetchOmlxActiveModel,
  fetchOmlxModels,
  PI_PROVIDER_DEFAULT,
  piOmlxDefaultModel,
  piOmlxProviderPresent,
  readCodexLastMessage,
  readOmlxApiKey,
  syncPiOmlxModels
} from "./harness.mjs";
import {
  nowIso,
  resolveJobStderrFile,
  resolveJobStdoutFile,
  resolveJobsDir,
  upsertJob
} from "./state.mjs";

const DEFAULT_TIMEOUT_MS = 600000; // 10 min: local 12B model first token is slow.

// The exact next command to run when a guardrail refuses.
function setupHint(scriptPath) {
  return `node "${scriptPath}" setup`;
}

// Verify provider configuration AND oMLX health before launching. This makes a
// silent cloud fallback structurally impossible: codex without its profile, or
// pi without its provider, refuses up front.
export async function preflight({ harness, scriptPath }) {
  const problems = [];

  if (harness === "pi" && !piOmlxProviderPresent()) {
    problems.push(
      `Pi has no "${PI_PROVIDER_DEFAULT}" provider in ~/.pi/agent/models.json. ` +
        `Run: ${setupHint(scriptPath)}`
    );
  }
  if (harness === "codex" && !codexProfilePresent()) {
    problems.push(
      `Codex has no "frontier-omlx" profile + omlx provider in ~/.codex/config.toml. ` +
        `Run: ${setupHint(scriptPath)}`
    );
  }

  const health = await checkOmlxHealth();
  if (!health.reachable) {
    problems.push(
      `oMLX server at 127.0.0.1:8000 is not reachable (${health.detail}). ` +
        `Start it with: omlx start`
    );
  }

  // Keep pi's omlx provider entry in step with what the server actually
  // serves, so whichever model is selected in the oMLX GUI resolves in pi.
  if (harness === "pi" && health.reachable && piOmlxProviderPresent()) {
    syncPiOmlxModels(await fetchOmlxModels());
  }

  if (harness === "pi" && piOmlxProviderPresent() && !piOmlxDefaultModel()) {
    problems.push(
      `Pi's "${PI_PROVIDER_DEFAULT}" provider lists no models in ~/.pi/agent/models.json, ` +
        `so the run cannot be pinned to a local model. Run: ${setupHint(scriptPath)}`
    );
  }

  return { ok: problems.length === 0, problems, health };
}

// Run the selected harness to completion, returning a normalized result.
export async function runHarness({
  harness,
  model,
  write,
  prompt,
  cwd,
  workspaceRoot,
  jobId,
  timeoutMs
}) {
  if (harness === "pi") {
    return runPi({ model, write, prompt, cwd, timeoutMs });
  }
  if (harness === "codex") {
    return runCodex({ model, write, prompt, cwd, workspaceRoot, jobId, timeoutMs });
  }
  throw new Error(`Unknown harness "${harness}". Use pi or codex.`);
}

// Pi's omlx provider ("apiKey": "$OMLX_API_KEY") and codex's frontier-omlx
// profile (env_key = "OMLX_API_KEY") both authenticate via this env var.
// oMLX's interactive tool launcher exports it, but the companion runs the
// harnesses directly, so inject the key from ~/.omlx/settings.json ourselves.
function harnessEnv() {
  const env = { ...process.env };
  if (!env.OMLX_API_KEY) {
    const key = readOmlxApiKey();
    if (key) {
      env.OMLX_API_KEY = key;
    }
  }
  return env;
}

function spawnAndCapture(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    // stdin is ignored (not an open pipe): codex and pi both probe stdin and
    // will block "Reading additional input from stdin..." if it stays open and
    // empty. The prompt is always passed as a CLI argument, never on stdin.
    const child = spawn(command, args, {
      cwd,
      env: harnessEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(1000, timeoutMs ?? DEFAULT_TIMEOUT_MS));

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 1, stdout, stderr: `${stderr}${error.message}`, timedOut, spawnError: error });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        status: code == null ? (signal ? 1 : 0) : code,
        stdout,
        stderr,
        timedOut,
        signal
      });
    });
  });
}

async function runPi({ model, write, prompt, cwd, timeoutMs }) {
  const piPrompt = buildPiPrompt({ prompt, write });
  // A bare --provider does not stop pi from resolving its user-level default
  // model (which may live on a cloud provider); the model must always be
  // pinned. Prefer the model currently selected in the oMLX GUI, then fall
  // back to pi's provider entry (preflight guarantees it lists a model).
  const resolvedModel = model ?? (await fetchOmlxActiveModel()) ?? piOmlxDefaultModel();
  const args = buildPiArgs({
    provider: PI_PROVIDER_DEFAULT,
    model: resolvedModel,
    write,
    prompt: piPrompt
  });

  const result = await spawnAndCapture("pi", args, { cwd, timeoutMs });
  const finalMessage = extractPiFinalMessage(result.stdout);

  // Verify the run actually stayed on the omlx provider. The JSON event
  // stream tags assistant messages with the serving provider; any other value
  // means a silent fallback happened and the result must be refused.
  const providerSeen = result.stdout.match(/"provider"\s*:\s*"([^"]+)"/);
  if (result.status === 0 && providerSeen && providerSeen[1] !== PI_PROVIDER_DEFAULT) {
    return normalizeResult({
      harness: "pi",
      model: resolvedModel ?? null,
      write,
      status: 1,
      finalMessage:
        `Refused: pi ran on provider "${providerSeen[1]}" instead of ` +
        `"${PI_PROVIDER_DEFAULT}". The result was discarded to prevent a ` +
        `silent cloud fallback.`,
      rawStdout: result.stdout,
      rawStderr: result.stderr,
      timedOut: result.timedOut,
      command: ["pi", ...args]
    });
  }

  return normalizeResult({
    harness: "pi",
    model: resolvedModel ?? null,
    write,
    status: result.status,
    finalMessage,
    rawStdout: result.stdout,
    rawStderr: result.stderr,
    timedOut: result.timedOut,
    command: ["pi", ...args]
  });
}

async function runCodex({ model, write, prompt, cwd, workspaceRoot, jobId, timeoutMs }) {
  const jobsDir = resolveJobsDir(workspaceRoot);
  fs.mkdirSync(jobsDir, { recursive: true });
  const lastMessageFile = path.join(jobsDir, `${jobId}.last-message.md`);

  // Follow the model selected in the oMLX GUI; the profile's baked-in model
  // is only the fallback when the status endpoint is unavailable.
  const resolvedModel = model ?? (await fetchOmlxActiveModel());
  const args = buildCodexArgs({ write, lastMessageFile, prompt, model: resolvedModel });
  const result = await spawnAndCapture("codex", args, { cwd, timeoutMs });
  const finalFromFile = readCodexLastMessage(lastMessageFile);
  const finalMessage = finalFromFile || extractCodexJsonFinal(result.stdout);

  return normalizeResult({
    harness: "codex",
    model: resolvedModel ?? null,
    write,
    status: result.status,
    finalMessage,
    rawStdout: result.stdout,
    rawStderr: result.stderr,
    timedOut: result.timedOut,
    command: ["codex", ...args],
    extraFiles: { lastMessageFile }
  });
}

// codex --json emits a JSONL event stream. Best-effort scan for the final
// agent message if the --output-last-message file was not written.
function extractCodexJsonFinal(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/).filter(Boolean);
  let last = "";
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const text =
        event?.msg?.message ??
        event?.message ??
        (event?.type === "agent_message" ? event?.text : null);
      if (typeof text === "string" && text.trim()) {
        last = text.trim();
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  return last;
}

function normalizeResult(result) {
  const failed = result.status !== 0 || result.timedOut;
  return {
    ...result,
    exitStatus: result.status,
    failed,
    finalMessage: result.finalMessage ?? ""
  };
}

// Persist the full run into the job record + log files.
export function recordJobResult(workspaceRoot, jobId, result) {
  const stdoutFile = resolveJobStdoutFile(workspaceRoot, jobId);
  const stderrFile = resolveJobStderrFile(workspaceRoot, jobId);
  fs.writeFileSync(stdoutFile, result.rawStdout ?? "", "utf8");
  fs.writeFileSync(stderrFile, result.rawStderr ?? "", "utf8");

  upsertJob(workspaceRoot, jobId, {
    status: result.timedOut ? "failed" : result.failed ? "failed" : "completed",
    exitStatus: result.exitStatus,
    timedOut: Boolean(result.timedOut),
    finalMessage: result.finalMessage,
    stdoutFile,
    stderrFile,
    completedAt: nowIso(),
    pid: null
  });

  return { stdoutFile, stderrFile };
}

export { DEFAULT_TIMEOUT_MS };
