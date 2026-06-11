// Human-readable rendering for the Frontier companion. The companion can emit
// either these strings or raw JSON (--json).

export function formatDuration(startIso, endIso) {
  const start = Date.parse(startIso ?? "");
  const end = Date.parse(endIso ?? "") || Date.now();
  if (!Number.isFinite(start) || end < start) {
    return "-";
  }
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

export function renderTaskResult(job, result) {
  const lines = [];
  lines.push(`Status:   ${result.failed ? "failed" : "completed"}`);
  lines.push(`Harness:  ${result.harness}`);
  lines.push(`Model:    ${result.model ?? "(provider default)"}`);
  lines.push(`Duration: ${formatDuration(job.startedAt ?? job.createdAt, job.completedAt)}`);
  lines.push(`Job:      ${job.id}`);
  lines.push("");
  if (result.timedOut) {
    lines.push("The harness timed out before completing.");
  }
  if (result.finalMessage) {
    lines.push("--- final message ---");
    lines.push(result.finalMessage);
  } else if (result.failed) {
    lines.push("--- error output ---");
    lines.push((result.rawStderr || result.rawStdout || "No output.").trim());
  } else {
    lines.push("(No final message was returned.)");
  }
  return `${lines.join("\n")}\n`;
}

export function renderQueued(job) {
  return [
    `Started ${job.harness} task in the background as ${job.id}.`,
    "",
    "Follow up with:",
    `  status ${job.id}`,
    `  result ${job.id}`,
    `  cancel ${job.id}`,
    ""
  ].join("\n");
}

export function renderStatusList(jobs) {
  if (jobs.length === 0) {
    return "No Frontier jobs recorded for this repository yet.\n";
  }
  const header = ["JOB", "HARNESS", "STATUS", "DURATION", "SUMMARY"];
  const rows = jobs.map((job) => [
    job.id,
    job.harness ?? "-",
    job.status ?? "-",
    formatDuration(job.startedAt ?? job.createdAt, job.completedAt),
    truncate(job.promptExcerpt ?? "", 48)
  ]);
  return `${renderTable(header, rows)}\n`;
}

export function renderJobDetail(job) {
  const lines = [];
  lines.push(`Job:      ${job.id}`);
  lines.push(`Harness:  ${job.harness ?? "-"}`);
  lines.push(`Model:    ${job.model ?? "(provider default)"}`);
  lines.push(`Status:   ${job.status ?? "-"}`);
  lines.push(`Write:    ${job.write ? "yes" : "no"}`);
  lines.push(`Created:  ${job.createdAt ?? "-"}`);
  lines.push(`Duration: ${formatDuration(job.startedAt ?? job.createdAt, job.completedAt)}`);
  lines.push(`Cwd:      ${job.cwd ?? "-"}`);
  if (job.promptExcerpt) {
    lines.push(`Prompt:   ${truncate(job.promptExcerpt, 120)}`);
  }
  if (job.timedOut) {
    lines.push("Note:     timed out");
  }
  if (job.errorMessage) {
    lines.push(`Error:    ${job.errorMessage}`);
  }
  if (job.finalMessage) {
    lines.push("");
    lines.push("--- final message ---");
    lines.push(job.finalMessage);
  }
  return `${lines.join("\n")}\n`;
}

export function renderResult(job) {
  if (job.finalMessage) {
    return `${job.finalMessage}\n`;
  }
  if (job.status === "running" || job.status === "queued") {
    return `Job ${job.id} is still ${job.status}. Check status ${job.id} and retry once it finishes.\n`;
  }
  return `Job ${job.id} (${job.status ?? "unknown"}) produced no final message. See log: ${job.stderrFile ?? job.stdoutFile ?? "(none)"}\n`;
}

export function renderCancel(job) {
  return `Cancelled job ${job.id} (${job.harness ?? "-"}).\n`;
}

function truncate(text, limit) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function renderTable(header, rows) {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => String(row[index] ?? "").length))
  );
  const renderRow = (cells) =>
    cells.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ");
  const lines = [renderRow(header), widths.map((width) => "-".repeat(width)).join("  ")];
  for (const row of rows) {
    lines.push(renderRow(row));
  }
  return lines.join("\n");
}
