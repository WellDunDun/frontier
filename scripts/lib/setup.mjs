import {
  applyCodexConfig,
  buildCodexConfigBlock,
  CODEX_PROFILE,
  checkOmlxHealth,
  codexProfilePresent,
  paths,
  piOmlxProviderPresent,
  probeBinaries
} from "./harness.mjs";

// Build the setup diagnosis. With applyCodex=true, additively install the codex
// provider+profile (backed up first) before reporting.
export async function buildSetupReport({ applyCodex = false } = {}) {
  const binaries = probeBinaries();
  const piProvider = piOmlxProviderPresent();

  let codexApply = null;
  if (applyCodex) {
    codexApply = applyCodexConfig();
  }
  const codexProfile = codexProfilePresent();
  const health = await checkOmlxHealth();

  const ready =
    binaries.omlx.available &&
    binaries.pi.available &&
    binaries.codex.available &&
    piProvider &&
    health.reachable;

  const nextSteps = [];
  if (!binaries.omlx.available) {
    nextSteps.push("Install / expose oMLX on PATH.");
  }
  if (!binaries.pi.available) {
    nextSteps.push("Install / expose pi on PATH.");
  }
  if (!binaries.codex.available) {
    nextSteps.push("Install / expose codex on PATH.");
  }
  if (!health.reachable) {
    nextSteps.push("Start the oMLX server: `omlx start` (or `omlx serve <model>`).");
  }
  if (!piProvider) {
    nextSteps.push(`Add an "omlx" provider to ${paths.piModels}.`);
  }
  if (!codexProfile) {
    nextSteps.push(
      "Codex has no frontier-omlx profile. Apply it with: " +
        "`node scripts/frontier-companion.mjs setup --apply-codex`."
    );
  }

  return {
    ready,
    binaries,
    omlx: health,
    pi: { providerPresent: piProvider, modelsPath: paths.piModels },
    codex: {
      profile: CODEX_PROFILE,
      profilePresent: codexProfile,
      configPath: paths.codexConfig,
      apply: codexApply,
      // Always provide the additive TOML so the user can apply manually.
      proposedToml: buildCodexConfigBlock()
    },
    nextSteps
  };
}

export function renderSetupReport(report) {
  const lines = [];
  const mark = (ok) => (ok ? "ok" : "MISSING");

  lines.push(`Frontier setup — ${report.ready ? "READY" : "NOT READY"}`);
  lines.push("");
  lines.push("Binaries on PATH:");
  for (const key of ["omlx", "pi", "codex", "node"]) {
    const bin = report.binaries[key];
    lines.push(`  ${key.padEnd(6)} ${mark(bin.available)}  ${bin.detail ?? ""}`.trimEnd());
  }
  lines.push("");
  lines.push("oMLX server (127.0.0.1:8000):");
  if (report.omlx.reachable) {
    lines.push(`  reachable  (HTTP ${report.omlx.status})${report.omlx.ok ? " — healthy" : ""}`);
  } else {
    lines.push(`  unreachable — ${report.omlx.detail}`);
    lines.push("  Start it with: omlx start");
  }
  lines.push("");
  lines.push("Pi provider:");
  lines.push(`  omlx provider  ${mark(report.pi.providerPresent)}  (${report.pi.modelsPath})`);
  lines.push("");
  lines.push("Codex profile:");
  lines.push(`  frontier-omlx  ${mark(report.codex.profilePresent)}  (${report.codex.configPath})`);

  if (report.codex.apply) {
    const apply = report.codex.apply;
    if (apply.applied) {
      lines.push(`  applied additive provider+profile.`);
      if (apply.backupPath) {
        lines.push(`  backup saved to: ${apply.backupPath}`);
      }
    } else if (apply.alreadyPresent) {
      lines.push("  already present — no change made.");
    }
  } else if (!report.codex.profilePresent) {
    lines.push("");
    lines.push("To enable the codex path, append this to ~/.codex/config.toml");
    lines.push("(or run `setup --apply-codex` to do it additively with a backup):");
    lines.push("");
    for (const line of report.codex.proposedToml.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  if (report.nextSteps.length > 0) {
    lines.push("");
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`  - ${step}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
