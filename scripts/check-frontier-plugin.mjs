#!/usr/bin/env node

// Functional validation for the Frontier plugin. This checks that the plugin is
// actually wired correctly, not that it matches a particular house style.

import { execFileSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

const failures = [];
const fail = (message) => failures.push(message);

const ALLOWED_AGENT_KEYS = new Set(["name", "description", "tools", "model", "color", "skills"]);
const ALLOWED_SKILLS = new Set(["frontier-orchestration"]);
const inheritedAgentBrand = ["agent", "[-_ ]?", "native"].join("");
const inheritedPackageScope = ["@agent", "-", "native"].join("");
const inheritedPlanHost = ["plan\\.", "agent", "-", "native", "\\.com"].join("");
const inheritedSourceBrand = ["build", "er(?:\\.io|io|\\s+io)?"].join("");
const FORBIDDEN_BRANDING_PATTERNS = [
  { label: "inherited agent platform branding", pattern: new RegExp(inheritedAgentBrand, "i") },
  { label: "inherited package scope", pattern: new RegExp(inheritedPackageScope, "i") },
  { label: "inherited plan host", pattern: new RegExp(inheritedPlanHost, "i") },
  { label: "inherited source repo branding", pattern: new RegExp(inheritedSourceBrand, "i") }
];

async function exists(relPath) {
  try {
    await access(path.join(repoRoot, relPath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readText(relPath) {
  return readFile(path.join(repoRoot, relPath), "utf8");
}

// Parse top-level frontmatter keys. Returns null on malformed frontmatter.
function parseFrontmatter(relPath, body) {
  if (!body.startsWith("---\n")) {
    fail(`${relPath}: missing YAML frontmatter`);
    return null;
  }
  const end = body.indexOf("\n---", 4);
  if (end === -1) {
    fail(`${relPath}: frontmatter is not closed`);
    return null;
  }
  const fields = new Map();
  for (const line of body.slice(4, end).split("\n")) {
    if (!line.trim() || /^\s/.test(line)) {
      continue; // skip blanks and nested (indented) keys
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    fields.set(match[1], match[2].replace(/^["']|["']$/g, "").trim());
  }
  for (const key of ["name", "description"]) {
    if (!fields.get(key)) {
      fail(`${relPath}: frontmatter missing ${key}`);
    }
  }
  return fields;
}

async function listFiles(relDir) {
  const out = [];
  if (!(await exists(relDir))) {
    return out;
  }
  async function walk(abs, prefix) {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absEntry = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        await walk(absEntry, rel);
      } else if (entry.isFile()) {
        out.push(path.posix.join(relDir, rel));
      }
    }
  }
  await walk(path.join(repoRoot, relDir), "");
  return out.sort();
}

async function checkAgents() {
  for (const relPath of await listFiles("agents")) {
    if (!relPath.endsWith(".md")) {
      continue;
    }
    const fields = parseFrontmatter(relPath, await readText(relPath));
    if (!fields) {
      continue;
    }
    for (const key of fields.keys()) {
      if (!ALLOWED_AGENT_KEYS.has(key)) {
        fail(`${relPath}: unexpected agent frontmatter key "${key}"`);
      }
    }
  }
}

async function checkSkills() {
  if (!(await exists("skills"))) {
    fail("skills: directory is missing");
    return;
  }
  for (const entry of await readdir(path.join(repoRoot, "skills"), { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!ALLOWED_SKILLS.has(entry.name)) {
      fail(`skills/${entry.name}: inherited non-Frontier skill must be removed`);
    }
    const relPath = `skills/${entry.name}/SKILL.md`;
    if (!(await exists(relPath))) {
      fail(`skills/${entry.name}: missing SKILL.md`);
      continue;
    }
    const fields = parseFrontmatter(relPath, await readText(relPath));
    if (fields && fields.get("name") !== entry.name) {
      fail(`${relPath}: frontmatter name "${fields.get("name")}" must match directory "${entry.name}"`);
    }
  }
}

async function checkRequiredFiles() {
  const required = [
    "scripts/frontier-companion.mjs",
    "agents/frontier-worker.md",
    "commands/delegate.md",
    "commands/status.md",
    "commands/result.md",
    "commands/cancel.md",
    "commands/setup.md",
    "skills/frontier-orchestration/SKILL.md"
  ];
  for (const relPath of required) {
    if (!(await exists(relPath))) {
      fail(`${relPath}: required file is missing`);
    }
  }
}

async function checkScriptsParse() {
  const scripts = (await listFiles("scripts")).filter((file) => file.endsWith(".mjs"));
  for (const relPath of scripts) {
    try {
      execFileSync(process.execPath, ["--check", path.join(repoRoot, relPath)], { stdio: "pipe" });
    } catch (error) {
      const detail = error.stderr ? error.stderr.toString().trim() : error.message;
      fail(`${relPath}: node --check failed: ${detail}`);
    }
  }
}

async function checkForbiddenStrings() {
  // The interactive codex approval flag must appear nowhere in the repo; codex
  // exec rejects it. The interactive oMLX launch subcommand must not appear in
  // agents, commands, or scripts (it hangs on a TUI). Build both needles from
  // fragments so this validator never trips its own rule.
  const approvalFlag = `--ask-for${"-"}approval`;
  const launchNeedle = `omlx${" "}launch`;

  const everywhere = (
    await Promise.all([
      listFiles("agents"),
      listFiles("commands"),
      listFiles("scripts"),
      listFiles("skills"),
      listFiles("docs")
    ])
  ).flat();
  everywhere.push("README.md");

  for (const relPath of everywhere) {
    if (!(await exists(relPath))) {
      continue;
    }
    const body = await readText(relPath);
    if (body.includes(approvalFlag)) {
      fail(`${relPath}: contains the forbidden interactive codex approval flag`);
    }
    for (const { label, pattern } of FORBIDDEN_BRANDING_PATTERNS) {
      if (pattern.test(body)) {
        fail(`${relPath}: contains inherited ${label} reference`);
      }
    }
  }

  for (const relPath of [
    ...(await listFiles("agents")),
    ...(await listFiles("commands")),
    ...(await listFiles("scripts"))
  ]) {
    const body = await readText(relPath);
    if (body.includes(launchNeedle)) {
      fail(`${relPath}: must not reference the interactive oMLX launch subcommand`);
    }
  }
}

async function main() {
  await checkRequiredFiles();
  await checkAgents();
  await checkSkills();
  await checkScriptsParse();
  await checkForbiddenStrings();

  if (failures.length > 0) {
    console.error("Frontier plugin check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Frontier plugin check passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
