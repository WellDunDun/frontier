import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { COMPANION, makeTempDir, run, waitFor, writeExecutable, writeJson } from "./helpers.mjs";

test("result and cancel require an explicit job id", () => {
  const workspace = makeTempDir();

  const result = run(process.execPath, [COMPANION, "result", "--cwd", workspace]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Provide a job id: result <job-id>/);

  const cancel = run(process.execPath, [COMPANION, "cancel", "--cwd", workspace]);
  assert.notEqual(cancel.status, 0);
  assert.match(cancel.stderr, /Provide a job id: cancel <job-id>/);
});

test("background pi tasks persist the prompt before the detached worker starts", async () => {
  const workspace = makeTempDir();
  const home = makeTempDir();
  const bin = makeTempDir();
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
      const jobsDir = path.join(workspace, ".frontier", "jobs");
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
    const fakeArgs = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    assert.equal(fakeArgs.includes("-p"), true);
});
