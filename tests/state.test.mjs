import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  listJobs,
  readJobFile,
  resolveFrontierDir,
  resolveJobFile,
  resolveJobsDir,
  upsertJob
} from "../scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

test("resolveFrontierDir stores workspace state under CLAUDE_PLUGIN_DATA", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const dir = resolveFrontierDir(workspace, { CLAUDE_PLUGIN_DATA: pluginData });

  assert.equal(path.dirname(dir), path.join(pluginData, "state"));
  assert.match(path.basename(dir), /^frontier-test-.+-[a-f0-9]{16}$/);
  assert.equal(dir.startsWith(workspace), false);
});

test("job records are written to plugin data instead of the workspace", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;

  try {
    upsertJob(workspace, "pi-test", { status: "queued", harness: "pi" });

    const jobFile = resolveJobFile(workspace, "pi-test");
    assert.equal(jobFile.startsWith(path.join(pluginData, "state")), true);
    assert.equal(fs.existsSync(jobFile), true);
    assert.deepEqual(listJobs(workspace).map((job) => job.id), ["pi-test"]);
    assert.equal(readJobFile(workspace, "pi-test").status, "queued");
    assert.equal(fs.existsSync(path.join(workspace, ".frontier")), false);
    assert.equal(resolveJobsDir(workspace).startsWith(path.join(pluginData, "state")), true);
  } finally {
    if (previousPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }
});
