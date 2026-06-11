import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveJobsDir, upsertJob } from "../plugins/frontier/scripts/lib/state.mjs";
import { SESSION_ID_ENV } from "../plugins/frontier/scripts/lib/job-control.mjs";
import { COMPANION, makeTempDir, run, waitFor, writeExecutable, writeJson } from "./helpers.mjs";

function withPluginData(pluginData, callback) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test("result without a job id returns the latest finished job for the current session", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginData,
    [SESSION_ID_ENV]: "session-a"
  };

  withPluginData(pluginData, () => {
    upsertJob(workspace, "pi-other", {
      status: "completed",
      harness: "pi",
      sessionId: "session-b",
      finalMessage: "OTHER-SESSION",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    upsertJob(workspace, "pi-current-old", {
      status: "completed",
      harness: "pi",
      sessionId: "session-a",
      finalMessage: "CURRENT-OLD",
      createdAt: "2026-01-02T00:00:00.000Z"
    });
    upsertJob(workspace, "pi-current-new", {
      status: "completed",
      harness: "pi",
      sessionId: "session-a",
      finalMessage: "CURRENT-NEW",
      createdAt: "2026-01-03T00:00:00.000Z"
    });
  });

  const result = run(process.execPath, [COMPANION, "result", "--cwd", workspace], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "CURRENT-NEW\n");
});

test("cancel without a job id cancels the only active job for the current session", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginData,
    [SESSION_ID_ENV]: "session-a"
  };

  withPluginData(pluginData, () => {
    upsertJob(workspace, "pi-other-active", {
      status: "running",
      harness: "pi",
      sessionId: "session-b",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    upsertJob(workspace, "pi-current-active", {
      status: "running",
      harness: "pi",
      sessionId: "session-a",
      createdAt: "2026-01-02T00:00:00.000Z"
    });
  });

  const cancel = run(process.execPath, [COMPANION, "cancel", "--cwd", workspace], { env });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, /Cancelled job pi-current-active/);

  const result = run(process.execPath, [COMPANION, "status", "pi-current-active", "--cwd", workspace], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Status:\s+cancelled/);
});

test("cancel without a job id refuses multiple active jobs in the current session", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginData,
    [SESSION_ID_ENV]: "session-a"
  };

  withPluginData(pluginData, () => {
    upsertJob(workspace, "pi-current-a", {
      status: "running",
      harness: "pi",
      sessionId: "session-a",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    upsertJob(workspace, "pi-current-b", {
      status: "queued",
      harness: "pi",
      sessionId: "session-a",
      createdAt: "2026-01-02T00:00:00.000Z"
    });
  });

  const cancel = run(process.execPath, [COMPANION, "cancel", "--cwd", workspace], { env });
  assert.notEqual(cancel.status, 0);
  assert.match(cancel.stderr, /Multiple Frontier jobs are active/);
});

test("background pi tasks persist the prompt before the detached worker starts", async () => {
  const workspace = makeTempDir();
  const home = makeTempDir();
  const bin = makeTempDir();
  const pluginData = makeTempDir();
  const argsFile = path.join(workspace, "fake-pi-args.json");
  const preload = path.join(workspace, "mock-fetch.mjs");
  fs.writeFileSync(
    preload,
    `globalThis.fetch = async (input) => {\n  const url = String(input);\n  if (url === "http://frontier.test/v1/models") {\n    return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), { status: 200 });\n  }\n  if (url === "http://frontier.test/v1/responses") {\n    return new Response(JSON.stringify({ error: "missing body" }), { status: 400 });\n  }\n  return new Response(JSON.stringify({ error: "not found" }), { status: 404 });\n};\n`,
    "utf8"
  );
  writeJson(path.join(workspace, "frontier.config.json"), {
    flavor: "openai",
    baseUrl: "http://frontier.test/v1",
    defaultModel: "test-model",
    piProvider: "frontier-local"
  });
  writeJson(path.join(home, ".pi", "agent", "models.json"), {
    providers: {
      "frontier-local": {
        baseUrl: "http://frontier.test/v1",
        apiKey: "frontier-local",
        models: [{ id: "test-model", contextWindow: 8192 }]
      }
    }
  });
  writeExecutable(
    path.join(bin, "pi"),
    `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nfs.writeFileSync(process.env.FRONTIER_FAKE_PI_ARGS, JSON.stringify(args));\nconst prompt = args[args.indexOf("-p") + 1] || "";\nconsole.log(JSON.stringify({ role: "assistant", content: prompt }));\n`
  );

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: pluginData,
    FRONTIER_FAKE_PI_ARGS: argsFile,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--import=${preload}`
  };
  const started = run(
    process.execPath,
    [COMPANION, "task", "--cwd", workspace, "--harness", "pi", "--background", "BACKGROUND-PROMPT"],
    { cwd: workspace, env }
  );

  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /Started pi task in the background/);

  const job = await waitFor(() => {
    const jobsDir = resolveJobsDir(workspace, env);
    if (!fs.existsSync(jobsDir)) {
      return null;
    }
    for (const entry of fs.readdirSync(jobsDir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const record = JSON.parse(fs.readFileSync(path.join(jobsDir, entry), "utf8"));
      if (record.status === "completed") {
        return record;
      }
    }
    return null;
  });

  assert.match(job.finalMessage, /BACKGROUND-PROMPT/);
  assert.equal(fs.existsSync(path.join(workspace, ".frontier")), false);
  const fakeArgs = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  assert.equal(fakeArgs.includes("-p"), true);
});
