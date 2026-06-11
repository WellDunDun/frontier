import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveBackend } from "../scripts/lib/backend.mjs";
import { makeTempDir, withMockedFetch, writeJson } from "./helpers.mjs";

function testPaths(root) {
  return {
    userConfig: path.join(root, "home", ".frontier", "config.json"),
    omlxSettings: path.join(root, "home", ".omlx", "settings.json")
  };
}

test("resolveBackend rejects malformed workspace config instead of falling through", async () => {
  const workspace = makeTempDir();
  fs.writeFileSync(path.join(workspace, "frontier.config.json"), "{ nope\n", "utf8");

  await assert.rejects(
    () => resolveBackend({ workspaceRoot: workspace, paths: testPaths(workspace), env: {} }),
    /not valid JSON/
  );
});

test("resolveBackend rejects unknown configured flavors", async () => {
  const workspace = makeTempDir();
  writeJson(path.join(workspace, "frontier.config.json"), { flavor: "not-real" });

  await assert.rejects(
    () => resolveBackend({ workspaceRoot: workspace, paths: testPaths(workspace), env: {} }),
    /unknown flavor/
  );
});

test("workspace openai config wins and preserves env-key auth contract", async () => {
  const workspace = makeTempDir();
  await withMockedFetch(
    async (url, init) => {
      assert.equal(url, "http://frontier.test/v1/responses");
      assert.equal(init.method, "POST");
      return new Response(JSON.stringify({ error: "missing body" }), { status: 400 });
    },
    async () => {
    const paths = testPaths(workspace);
    writeJson(paths.userConfig, { flavor: "ollama", baseUrl: "http://127.0.0.1:11434/v1" });
    writeJson(path.join(workspace, "frontier.config.json"), {
      flavor: "openai",
      baseUrl: "http://frontier.test/v1",
      apiKey: { env: "TEST_FRONTIER_KEY" },
      defaultModel: "qwen3-coder",
      piProvider: "frontier-test",
      codexProfile: "frontier-test"
    });

    const backend = await resolveBackend({
      workspaceRoot: workspace,
      paths,
      env: { TEST_FRONTIER_KEY: "secret-value" }
    });

    assert.equal(backend.flavor, "openai");
    assert.equal(backend.baseUrl, "http://frontier.test/v1");
    assert.equal(backend.envKey, "TEST_FRONTIER_KEY");
    assert.equal(backend.apiKey, "secret-value");
    assert.equal(backend.keySource, "env");
    assert.equal(backend.configSource, "workspace-config");
    assert.equal(backend.piProvider, "frontier-test");
    assert.equal(backend.codexProfile, "frontier-test");
    assert.equal(backend.codexSupported, true);
    }
  );
});
