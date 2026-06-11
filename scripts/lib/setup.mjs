import { resolveBackend } from "./backend.mjs";
import {
  applyCodexConfig,
  applyPiConfig,
  buildCodexConfigBlock,
  checkOmlxHealth,
  codexProfilePresent,
  fetchOmlxActiveModel,
  fetchOmlxModels,
  paths,
  piOmlxProviderPresent,
  probeBinaries
} from "./harness.mjs";

// Build the setup diagnosis for the resolved backend. With apply=true, additively
// provision BOTH harnesses (Pi provider entry + Codex provider/profile), each
// backed up first, before reporting. Applying requires the server to be up so
// the model list and active model can be read from it (no hardcoded model ids).
export async function buildSetupReport({ apply = false, workspaceRoot } = {}) {
  const backend = await resolveBackend({ workspaceRoot });
  const binaries = probeBinaries();
  const health = await checkOmlxHealth(backend);

  // Read live server state when reachable: chat models + the active model. These
  // feed both the report and the provisioning step.
  let serverModels = [];
  let activeModel = null;
  if (health.reachable) {
    serverModels = await fetchOmlxModels(backend);
    activeModel = await fetchOmlxActiveModel(backend);
  }

  // Provisioning. Both harnesses are provisioned together when --apply is given.
  // We require the server to be up so models are populated from it; if it is
  // down we skip applying and say so.
  let piApply = null;
  let codexApply = null;
  if (apply) {
    if (!health.reachable) {
      piApply = { applied: false, alreadyPresent: false, backupPath: null, reason: "server unreachable" };
      codexApply = { applied: false, alreadyPresent: false, backupPath: null, reason: "server unreachable" };
    } else {
      piApply = applyPiConfig(backend, serverModels);
      if (backend.codexSupported === false) {
        // No /v1/responses on this backend — provisioning a codex profile would
        // only mislead. Skip it and say why; pi is still provisioned above.
        codexApply = {
          applied: false,
          alreadyPresent: false,
          backupPath: null,
          reason: "codex unsupported on this backend (no /v1/responses)"
        };
      } else {
        // Codex's profile model comes from the live server (active model preferred,
        // else the single chat model); -m overrides at run time regardless.
        const codexModel = activeModel ?? (serverModels.length === 1 ? serverModels[0].id : null);
        codexApply = applyCodexConfig(backend, codexModel);
      }
    }
  }

  const piProvider = piOmlxProviderPresent(backend);
  const codexProfile = codexProfilePresent(backend);

  const ready =
    binaries.omlx.available &&
    binaries.pi.available &&
    binaries.codex.available &&
    piProvider &&
    health.ok;

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
    nextSteps.push("Start the local server: `omlx start` (or `omlx serve <model>`).");
  } else if (!health.ok) {
    nextSteps.push(
      `The local server responded with ${health.detail}. Check backend auth/configuration before running workers.`
    );
  }
  if (!piProvider) {
    nextSteps.push(
      `Pi has no "${backend.piProvider}" provider in ${paths.piModels}. ` +
        "Provision it (server must be up) with: " +
        "`node scripts/frontier-companion.mjs setup --apply`."
    );
  }
  if (backend.codexSupported === false) {
    nextSteps.push(
      `Codex is unavailable: the "${backend.flavor}" backend at ${backend.baseUrl} does not ` +
        "serve /v1/responses. Use the pi harness (`--harness pi`). To enable codex, point " +
        "Frontier at a backend that exposes the OpenAI Responses API."
    );
  } else if (!codexProfile) {
    nextSteps.push(
      `Codex has no "${backend.codexProfile}" profile. Provision it (server must be up) with: ` +
        "`node scripts/frontier-companion.mjs setup --apply`."
    );
  }
  if (apply && !health.reachable) {
    nextSteps.push("Apply was requested but skipped: start the server, then rerun `setup --apply`.");
  }

  return {
    ready,
    backend: {
      flavor: backend.flavor,
      baseUrl: backend.baseUrl,
      envKey: backend.envKey,
      configSource: backend.configSource,
      configSourcePath: backend.configSourcePath ?? null,
      keySource: backend.keySource ?? (backend.apiKey != null ? "literal" : "none"),
      codexSupported: backend.codexSupported
    },
    binaries,
    omlx: health,
    server: {
      models: serverModels,
      activeModel
    },
    pi: {
      provider: backend.piProvider,
      providerPresent: piProvider,
      modelsPath: paths.piModels,
      apply: piApply
    },
    codex: {
      profile: backend.codexProfile,
      profilePresent: codexProfile,
      configPath: paths.codexConfig,
      supported: backend.codexSupported,
      apply: codexApply,
      // The proposed block uses the active model so a manual paste matches apply.
      proposedToml: buildCodexConfigBlock(
        backend,
        activeModel ?? (serverModels.length === 1 ? serverModels[0].id : null)
      )
    },
    nextSteps
  };
}

export function renderSetupReport(report) {
  const lines = [];
  const mark = (ok) => (ok ? "ok" : "MISSING");

  lines.push(`Frontier setup — ${report.ready ? "READY" : "NOT READY"}`);
  lines.push("");
  lines.push("Backend:");
  lines.push(`  flavor         ${report.backend.flavor}`);
  lines.push(`  baseUrl        ${report.backend.baseUrl}`);
  // configSource is "auto-detect" (the oMLX→Ollama ladder picked the flavor) or
  // the config layer that selected it ("user-config" / "workspace-config"). When
  // a config file selected it, name the exact file so the source is unambiguous.
  const ladderNote =
    report.backend.configSource === "auto-detect"
      ? "auto-detect (oMLX → Ollama ladder)"
      : report.backend.configSourcePath
        ? `${report.backend.configSource} (${report.backend.configSourcePath})`
        : report.backend.configSource;
  lines.push(`  selected via   ${ladderNote}`);
  // Key SOURCE only — the secret value is never read or printed here.
  lines.push(`  key source     ${renderKeySource(report.backend)}`);
  lines.push(`  codex support  ${report.backend.codexSupported ? "yes" : "no (no /v1/responses)"}`);
  lines.push("");
  lines.push("Binaries on PATH:");
  for (const key of ["omlx", "pi", "codex", "node"]) {
    const bin = report.binaries[key];
    lines.push(`  ${key.padEnd(6)} ${mark(bin.available)}  ${bin.detail ?? ""}`.trimEnd());
  }
  lines.push("");
  lines.push(`Local server (${report.backend.baseUrl}):`);
  if (report.omlx.reachable) {
    lines.push(`  reachable  (HTTP ${report.omlx.status})${report.omlx.ok ? " — healthy" : ""}`);
    const models = report.server.models;
    if (models.length > 0) {
      lines.push(`  models found (${models.length}):`);
      for (const m of models) {
        lines.push(`    - ${m.id}  (context ${m.contextWindow})`);
      }
    } else {
      lines.push("  models found: none (server returned no chat models)");
    }
    lines.push(`  active model: ${report.server.activeModel ?? "(none resolved)"}`);
  } else {
    lines.push(`  unreachable — ${report.omlx.detail}`);
    lines.push("  Start it with: omlx start");
  }
  lines.push("");
  lines.push("Pi provider:");
  lines.push(`  ${report.pi.provider} provider  ${mark(report.pi.providerPresent)}  (${report.pi.modelsPath})`);
  renderApply(lines, report.pi.apply);
  lines.push("");
  lines.push("Codex profile:");
  if (report.codex.supported === false) {
    lines.push(
      `  unavailable — the ${report.backend.flavor} backend does not serve /v1/responses.`
    );
    lines.push("  Use the pi harness (`--harness pi`); the codex path is disabled for this backend.");
  } else {
    lines.push(`  ${report.codex.profile}  ${mark(report.codex.profilePresent)}  (${report.codex.configPath})`);
  }
  renderApply(lines, report.codex.apply);

  if (report.codex.supported !== false && !report.codex.apply && !report.codex.profilePresent) {
    lines.push("");
    lines.push("To enable the codex path, append this to ~/.codex/config.toml");
    lines.push("(or run `setup --apply` to do it additively with a backup):");
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

// Render the key SOURCE (never the value). Describes where the harnesses get
// their auth from: an env var, a file, an inline literal, or no key at all.
function renderKeySource(backend) {
  switch (backend.keySource) {
    case "none":
      return "none (keyless backend)";
    case "env":
      return `env var${backend.envKey ? ` (${backend.envKey})` : ""}`;
    case "file":
      return `file (injected via ${backend.envKey ?? "env"})`;
    case "literal":
      return `literal (injected via ${backend.envKey ?? "env"})`;
    case "settings":
      return `${backend.envKey ?? "env"} (from backend settings)`;
    default:
      return backend.envKey ? `env var (${backend.envKey})` : "none";
  }
}

// Render the outcome of an apply attempt for a single harness.
function renderApply(lines, apply) {
  if (!apply) {
    return;
  }
  if (apply.applied) {
    lines.push("  applied additively.");
    if (apply.backupPath) {
      lines.push(`  backup saved to: ${apply.backupPath}`);
    }
  } else if (apply.alreadyPresent) {
    lines.push("  already present — no change made.");
  } else if (apply.reason) {
    lines.push(`  not applied — ${apply.reason}.`);
  }
}
