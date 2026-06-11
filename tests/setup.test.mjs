import test from "node:test";
import assert from "node:assert/strict";

import {
  renderSetupReport,
  requiredSetupBinaries,
  serverStartHint
} from "../scripts/lib/setup.mjs";

test("requiredSetupBinaries only requires omlx for the omlx backend", () => {
  assert.deepEqual(
    requiredSetupBinaries({ flavor: "openai", codexSupported: true }),
    ["node", "pi", "codex"]
  );
  assert.deepEqual(
    requiredSetupBinaries({ flavor: "ollama", codexSupported: false }),
    ["node", "pi"]
  );
  assert.deepEqual(
    requiredSetupBinaries({ flavor: "omlx", codexSupported: true }),
    ["node", "pi", "codex", "omlx"]
  );
});

test("serverStartHint is backend-specific", () => {
  assert.match(serverStartHint({ flavor: "omlx" }), /oMLX server/);
  assert.match(serverStartHint({ flavor: "ollama" }), /Start Ollama/);
  assert.match(
    serverStartHint({ flavor: "openai", baseUrl: "https://models.example/v1" }),
    /https:\/\/models\.example\/v1/
  );
});

test("renderSetupReport does not require omlx for openai backends", () => {
  const output = renderSetupReport({
    ready: false,
    backend: {
      flavor: "openai",
      baseUrl: "https://models.example/v1",
      envKey: "FRONTIER_TEST_KEY",
      configSource: "workspace-config",
      configSourcePath: "/repo/frontier.config.json",
      keySource: "env",
      codexSupported: true
    },
    binaries: {
      node: { available: true, detail: "v22.0.0" },
      pi: { available: true, detail: "1.0.0" },
      codex: { available: false, detail: "not found on PATH" },
      omlx: { available: false, detail: "not found on PATH" }
    },
    omlx: { reachable: false, ok: false, detail: "fetch failed" },
    server: { models: [], activeModel: null },
    pi: {
      provider: "frontier-local",
      providerPresent: true,
      modelsPath: "/tmp/models.json",
      apply: null
    },
    codex: {
      profile: "frontier-local",
      profilePresent: false,
      configPath: "/tmp/config.toml",
      supported: true,
      apply: null,
      proposedToml: "[profiles.frontier-local]"
    },
    nextSteps: []
  });

  assert.match(output, /Required binaries on PATH:/);
  assert.doesNotMatch(output, /omlx\s+MISSING/);
  assert.doesNotMatch(output, /omlx start/);
  assert.match(output, /Backend endpoint \(https:\/\/models\.example\/v1\):/);
});
