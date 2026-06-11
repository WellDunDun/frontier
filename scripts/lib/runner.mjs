import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveBackend } from "./backend.mjs";
import {
  buildCodexArgs,
  buildPiArgs,
  buildPiPrompt,
  checkOmlxHealth,
  codexProfilePresent,
  extractPiFinalMessage,
  fetchOmlxActiveModel,
  fetchOmlxModels,
  piOmlxDefaultModel,
  piOmlxProviderPresent,
  readCodexLastMessage,
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

// Verify provider configuration AND server health before launching. This makes a
// silent cloud fallback structurally impossible: codex without its profile, or
// pi without its provider, refuses up front. The backend descriptor supplies the
// provider/profile names and base URL so nothing here is hardcoded.
export async function preflight({ harness, scriptPath, backend }) {
  const resolved = backend ?? (await resolveBackend());
  const problems = [];

  // The codex harness needs the backend to serve /v1/responses. When it does not
  // (codexSupported === false, e.g. vanilla ollama without a responses shim),
  // refuse up front with an actionable message. The pi harness is unaffected.
  if (harness === "codex" && resolved.codexSupported === false) {
    problems.push(
      `The "${resolved.flavor}" backend at ${resolved.baseUrl} does not serve ` +
        `/v1/responses, which the codex harness requires. Use the pi harness ` +
        `instead (--harness pi), or point Frontier at a backend that exposes the ` +
        `OpenAI Responses API.`
    );
  }

  if (harness === "pi" && !piOmlxProviderPresent(resolved)) {
    problems.push(
      `Pi has no "${resolved.piProvider}" provider in ~/.pi/agent/models.json. ` +
        `Run: ${setupHint(scriptPath)}`
    );
  }
  if (harness === "codex" && resolved.codexSupported !== false && !codexProfilePresent(resolved)) {
    problems.push(
      `Codex has no "${resolved.codexProfile}" profile + ${resolved.piProvider} provider ` +
        `in ~/.codex/config.toml. Run: ${setupHint(scriptPath)}`
    );
  }

  const health = await checkOmlxHealth(resolved);
  if (!health.ok) {
    problems.push(
      health.reachable
        ? `Local server at ${resolved.baseUrl} responded with ${health.detail}. Check backend auth/configuration.`
        : `Local server at ${resolved.baseUrl} is not reachable (${health.detail}). Start it with: omlx start`
    );
  }

  // Keep pi's provider entry in step with what the server actually serves, so
  // whichever model is selected in the backend GUI resolves in pi.
  if (harness === "pi" && health.ok && piOmlxProviderPresent(resolved)) {
    syncPiOmlxModels(resolved, await fetchOmlxModels(resolved));
  }

  if (harness === "pi" && piOmlxProviderPresent(resolved) && !piOmlxDefaultModel(resolved)) {
    problems.push(
      `Pi's "${resolved.piProvider}" provider lists no models in ~/.pi/agent/models.json, ` +
        `so the run cannot be pinned to a local model. Run: ${setupHint(scriptPath)}`
    );
  }

  return { ok: problems.length === 0, problems, health, backend: resolved };
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
  timeoutMs,
  backend
}) {
  const resolved = backend ?? (await resolveBackend({ workspaceRoot }));
  if (harness === "pi") {
    return runPi({ model, write, prompt, cwd, timeoutMs, backend: resolved });
  }
  if (harness === "codex") {
    return runCodex({ model, write, prompt, cwd, workspaceRoot, jobId, timeoutMs, backend: resolved });
  }
  throw new Error(`Unknown harness "${harness}". Use pi or codex.`);
}

// Pi's provider (apiKey: "$OMLX_API_KEY") and codex's profile
// (env_key = "OMLX_API_KEY") both authenticate via the backend's env key. The
// server's interactive tool launcher exports it, but the companion runs the
// harnesses directly, so inject the key from the resolved backend ourselves.
function harnessEnv(backend) {
  const env = { ...process.env };
  if (backend?.envKey && backend?.apiKey && !env[backend.envKey]) {
    env[backend.envKey] = backend.apiKey;
  }
  return env;
}

function spawnAndCapture(command, args, { cwd, timeoutMs, backend }) {
  return new Promise((resolve) => {
    // stdin is ignored (not an open pipe): codex and pi both probe stdin and
    // will block "Reading additional input from stdin..." if it stays open and
    // empty. The prompt is always passed as a CLI argument, never on stdin.
    const child = spawn(command, args, {
      cwd,
      env: harnessEnv(backend),
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

async function runPi({ model, write, prompt, cwd, timeoutMs, backend }) {
  const piPrompt = buildPiPrompt({ prompt, write });
  // A bare --provider does not stop pi from resolving its user-level default
  // model (which may live on a cloud provider); the model must always be
  // pinned. Prefer the model currently selected in the backend GUI, then fall
  // back to pi's provider entry (preflight guarantees it lists a model).
  const resolvedModel = model ?? (await fetchOmlxActiveModel(backend)) ?? piOmlxDefaultModel(backend);
  const args = buildPiArgs({
    provider: backend.piProvider,
    model: resolvedModel,
    write,
    prompt: piPrompt
  });

  const result = await spawnAndCapture("pi", args, { cwd, timeoutMs, backend });
  const finalMessage = extractPiFinalMessage(result.stdout);

  // Verify the run actually stayed on the backend's provider. The JSON event
  // stream tags assistant messages with the serving provider; any other value
  // means a silent fallback happened and the result must be refused.
  const providerSeen = result.stdout.match(/"provider"\s*:\s*"([^"]+)"/);
  if (result.status === 0 && providerSeen && providerSeen[1] !== backend.piProvider) {
    return normalizeResult({
      harness: "pi",
      model: resolvedModel ?? null,
      write,
      status: 1,
      finalMessage:
        `Refused: pi ran on provider "${providerSeen[1]}" instead of ` +
        `"${backend.piProvider}". The result was discarded to prevent a ` +
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

async function runCodex({ model, write, prompt, cwd, workspaceRoot, jobId, timeoutMs, backend }) {
  const jobsDir = resolveJobsDir(workspaceRoot);
  fs.mkdirSync(jobsDir, { recursive: true });
  const lastMessageFile = path.join(jobsDir, `${jobId}.last-message.md`);

  // Follow the model selected in the backend GUI; the profile's baked-in model
  // is only the fallback when the status endpoint is unavailable.
  const resolvedModel = model ?? (await fetchOmlxActiveModel(backend));
  const args = buildCodexArgs({
    write,
    lastMessageFile,
    prompt,
    model: resolvedModel,
    profile: backend.codexProfile
  });
  const result = await spawnAndCapture("codex", args, { cwd, timeoutMs, backend });
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
