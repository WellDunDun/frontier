import { spawnSync } from "node:child_process";
import process from "node:process";

// Run a command and capture its result without throwing.
export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? (result.signal ? 1 : 0),
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

// Probe whether a binary is on PATH and runnable.
export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && result.error.code === "ENOENT") {
    return { available: false, detail: "not found on PATH" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

// Terminate a detached child and its process group. Best effort: a missing
// process is treated as already gone, not an error.
export function terminateProcessTree(pid) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false };
  }

  try {
    // Negative pid targets the whole process group created by detached spawn.
    process.kill(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (groupError) {
    if (groupError?.code === "ESRCH") {
      return { attempted: true, delivered: false, method: "process-group" };
    }
    try {
      process.kill(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (singleError) {
      if (singleError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw singleError;
    }
  }
}

// Is a pid still alive? Signal 0 probes without delivering.
export function processAlive(pid) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
