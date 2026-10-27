import path from "node:path";

const COLOR = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  cyan: "\u001b[36m",
};

const LABEL = {
  changed: "STALE",
  missing: "GONE",
  "self-edited": "ok",
  fresh: "ok",
  unknown: "TIME?",
};

export function renderReport(report, { color = false } = {}) {
  const paint = (name, text) => (color ? `${COLOR[name]}${text}${COLOR.reset}` : text);
  const lines = [];

  const session = report.transcript ? path.basename(report.transcript) : "(inline)";
  lines.push(
    `${paint("cyan", `stalectx ${report.version}`)}  session ${session}${
      report.format && report.format !== "unknown" ? paint("dim", ` (${report.format})`) : ""
    }`,
  );
  lines.push(
    paint(
      "dim",
      `root  ${report.root}    reads ${report.summary.reads} / files ${report.summary.files}    stale ${report.summary.stale}`,
    ),
  );

  if (report.files.length > 0) lines.push("");

  for (const file of report.files) {
    const label = LABEL[file.state] ?? "?";
    const colorName =
      file.state === "changed" ? "yellow" : file.state === "missing" ? "red" : file.state === "fresh" ? "green" : "dim";
    const detail = describe(file);
    lines.push(
      `${paint(colorName, label.padEnd(6))} ${file.path.padEnd(30)}  ${paint("dim", detail)}`,
    );
  }

  lines.push("");
  lines.push(summaryLine(report, paint));

  for (const warning of report.warnings ?? []) {
    lines.push(paint("dim", `note: ${warning}`));
  }

  return `${lines.join("\n")}\n`;
}

function describe(file) {
  const read = file.lastReadAt ? `${shortIso(file.lastReadAt)} (line ${file.lastReadLine})` : "unknown";
  const prefix = `last read ${read}`;
  if (file.state === "missing") return `${prefix}   file no longer exists`;
  if (file.state === "changed") {
    const delta = humanDelta(file.deltaMs);
    const used = file.usedLater ? `   used later: ${file.usedLater}` : "";
    return `${prefix}   changed ${shortIso(file.mtime)} (${delta})${used}`;
  }
  if (file.state === "self-edited") return `${prefix}   changed by the agent itself`;
  if (file.state === "unknown") return `${prefix}   no timestamp to compare`;
  return `${prefix}   unchanged`;
}

function summaryLine(report, paint) {
  const { summary } = report;
  if (summary.stale === 0) {
    return paint("green", `no stale context: ${summary.files} files read, all still match the transcript`);
  }
  const risky = summary.risky > 0 ? `, ${summary.risky} used after going stale` : "";
  return paint("yellow", `${summary.stale} stale / ${summary.files} files${risky} -> re-read them before continuing`);
}

export function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function shortIso(iso) {
  if (!iso) return "unknown";
  return iso.replace(/\.\d{3}Z$/, "Z").replace("T", " ");
}

export function humanDelta(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "?";
  const abs = Math.abs(ms);
  const sign = ms < 0 ? "-" : "+";
  const minutes = Math.floor(abs / 60000);
  if (minutes < 1) return `${sign}${Math.round(abs / 1000)}s`;
  if (minutes < 60) return `${sign}${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${sign}${hours}h ${minutes % 60}m`;
  return `${sign}${Math.floor(hours / 24)}d ${hours % 24}h`;
}
