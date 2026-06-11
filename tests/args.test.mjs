import test from "node:test";
import assert from "node:assert/strict";

import { normalizeArgv, parseArgs, splitRawArgumentString } from "../scripts/lib/args.mjs";

test("splitRawArgumentString preserves quoted prompt and option values", () => {
  assert.deepEqual(
    splitRawArgumentString("--harness pi --model 'qwen max' --background \"hello world\""),
    ["--harness", "pi", "--model", "qwen max", "--background", "hello world"]
  );
});

test("parseArgs handles a slash-command raw argument string", () => {
  const parsed = parseArgs(["--harness pi --model 'qwen max' --background \"hello world\""], {
    valueOptions: ["harness", "model"],
    booleanOptions: ["background"]
  });

  assert.deepEqual(parsed.options, {
    harness: "pi",
    model: "qwen max",
    background: true
  });
  assert.deepEqual(parsed.positionals, ["hello world"]);
});

test("normalizeArgv leaves already-tokenized argv unchanged", () => {
  const argv = ["--model", "qwen max", "hello world"];
  assert.equal(normalizeArgv(argv), argv);
});
