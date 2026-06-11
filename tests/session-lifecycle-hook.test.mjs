import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { SESSION_ID_ENV } from "../scripts/lib/job-control.mjs";
import { ROOT, makeTempDir, run } from "./helpers.mjs";

const HOOK = path.join(ROOT, "scripts", "session-lifecycle-hook.mjs");

test("SessionStart hook exports the Frontier companion session id", () => {
  const dir = makeTempDir();
  const envFile = path.join(dir, "claude.env");
  const result = run(process.execPath, [HOOK, "SessionStart"], {
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile
    },
    input: JSON.stringify({ session_id: "session-with-'quote" })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    "export " + SESSION_ID_ENV + "='session-with-'\"'\"'quote'\n"
  );
});
