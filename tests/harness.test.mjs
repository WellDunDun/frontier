import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCodexConfig,
  applyPiConfig,
  buildCodexConfigBlock,
  checkOmlxHealth,
  extractPiFinalMessage
} from "../plugins/frontier/scripts/lib/harness.mjs";
import { makeTempDir, withMockedFetch, writeJson } from "./helpers.mjs";

test("extractPiFinalMessage ignores explicit non-assistant roles after assistant output", () => {
  const stdout = [
    JSON.stringify({ role: "user", content: "ignore this" }),
    JSON.stringify({ role: "assistant", content: "KEEP-ME" }),
    JSON.stringify({ role: "tool", content: "do not return this" })
  ].join("\n");

  assert.equal(extractPiFinalMessage(stdout), "KEEP-ME");
});

test("checkOmlxHealth distinguishes reachable non-healthy responses", async () => {
  await withMockedFetch(
    async (url, init) => {
      assert.equal(url, "http://frontier.test/v1/models");
      assert.equal(init.method, "GET");
      return new Response(JSON.stringify({ error: "bad key" }), { status: 401 });
    },
    async () => {
      const health = await checkOmlxHealth({ baseUrl: "http://frontier.test/v1", apiKey: "bad" });
    assert.equal(health.reachable, true);
    assert.equal(health.ok, false);
    assert.equal(health.status, 401);
    }
  );
});

test("applyPiConfig writes provider entries without inlining env-key secrets", () => {
  const root = makeTempDir();
  const modelsPath = path.join(root, ".pi", "agent", "models.json");
  writeJson(modelsPath, { providers: { other: { baseUrl: "http://example.test", models: [] } } });
  const backend = {
    flavor: "openai",
    baseUrl: "http://127.0.0.1:1234/v1",
    envKey: "MY_BACKEND_KEY",
    piProvider: "frontier-local"
  };

  const result = applyPiConfig(backend, [{ id: "qwen3-coder", contextWindow: 8192 }], modelsPath);

  assert.equal(result.applied, true);
  const config = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  assert.equal(config.providers["frontier-local"].apiKey, "$MY_BACKEND_KEY");
  assert.equal(config.providers["frontier-local"].models[0].id, "qwen3-coder");
  assert.equal(config.providers.other.baseUrl, "http://example.test");
});

test("buildCodexConfigBlock references env_key and never embeds a secret", () => {
  const block = buildCodexConfigBlock(
    {
      flavor: "openai",
      baseUrl: "http://127.0.0.1:1234/v1",
      envKey: "MY_BACKEND_KEY",
      piProvider: "frontier-local",
      codexProfile: "frontier-local",
      apiKey: "secret-value"
    },
    "qwen3-coder"
  );

  assert.match(block, /wire_api = "responses"/);
  assert.match(block, /env_key = "MY_BACKEND_KEY"/);
  assert.match(block, /model = "qwen3-coder"/);
  assert.doesNotMatch(block, /secret-value/);
});
