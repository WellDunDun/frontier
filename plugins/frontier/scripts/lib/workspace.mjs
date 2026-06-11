import { spawnSync } from "node:child_process";
import path from "node:path";

// Resolve the workspace root for a directory. Prefer the enclosing git repo
// top-level so job state is stable regardless of which subdirectory invoked
// the companion. Falls back to the directory itself when not in a repo.
export function resolveWorkspaceRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status === 0) {
    const top = String(result.stdout ?? "").trim();
    if (top) {
      return top;
    }
  }
  return path.resolve(cwd);
}
