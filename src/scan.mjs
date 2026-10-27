import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTranscript } from "./parse.mjs";

export const VERSION = "0.1.0";
const DEFAULT_TOLERANCE_MS = 2000;

/**
 * Scan one transcript against the filesystem.
 *
 * @param {string} file transcript path
 * @param {{root?: string, toleranceMs?: number, ignore?: string[], now?: Date}} options
 */
export async function scanTranscript(file, options = {}) {
  const text = await fs.readFile(file, "utf8");
  return scanText(text, { ...options, file });
}

export async function scanText(text, options = {}) {
  const { file = "", toleranceMs = DEFAULT_TOLERANCE_MS, ignore = [], now = new Date() } = options;
  const parsed = parseTranscript(text, { file });
  const root = path.resolve(options.root || parsed.cwd || process.cwd());
  const isIgnored = compileIgnore(ignore);
  const warnings = [...parsed.warnings];

  const byPath = new Map();
  for (const event of parsed.events) {
    if (!event.path) continue;
    const absolute = resolveReadPath(event.path, root);
    if (!absolute) continue;
    const key = pathKey(absolute);
    let entry = byPath.get(key);
    if (!entry) {
      entry = { key, absolute, display: displayPath(absolute, root), reads: [], writes: [] };
      byPath.set(key, entry);
    }
    if (isIgnored(entry.absolute, entry.display)) continue;
    if (event.kind === "read") entry.reads.push(event);
    else if (event.kind === "write") entry.writes.push(event);
  }

  const files = [];
  let readCount = 0;
  for (const entry of byPath.values()) {
    if (entry.reads.length === 0) continue;
    readCount += entry.reads.length;

    const lastRead = entry.reads[entry.reads.length - 1];
    const writesAfter = entry.writes.filter((write) => write.index > lastRead.index);
    const lastWrite = writesAfter[writesAfter.length - 1] ?? null;

    const stat = await safeStat(entry.absolute);
    const state = classify({ stat, lastRead, lastWrite, toleranceMs });

    const usedLater = findLaterUse(entry, lastRead, parsed.events, root);
    const readMs = lastRead.at ? Date.parse(lastRead.at) : null;
    const mtimeMs = stat?.mtimeMs ?? null;

    files.push({
      path: entry.display,
      absolutePath: entry.absolute,
      state,
      reads: entry.reads.length,
      firstReadAt: entry.reads[0].at,
      lastReadAt: lastRead.at,
      lastReadLine: lastRead.line,
      lastReadTurn: lastRead.index + 1,
      mtime: mtimeMs === null ? null : new Date(mtimeMs).toISOString(),
      deltaMs: readMs !== null && mtimeMs !== null ? Math.round(mtimeMs - readMs) : null,
      size: stat?.size ?? null,
      agentWritesAfterRead: writesAfter.length,
      usedLater: state === "changed" || state === "missing" ? usedLater : null,
    });
  }

  files.sort(compareFiles);

  const summary = {
    reads: readCount,
    files: files.length,
    changed: files.filter((item) => item.state === "changed").length,
    missing: files.filter((item) => item.state === "missing").length,
    selfEdited: files.filter((item) => item.state === "self-edited").length,
    fresh: files.filter((item) => item.state === "fresh").length,
    unknown: files.filter((item) => item.state === "unknown").length,
    stale: files.filter((item) => item.state === "changed" || item.state === "missing").length,
    risky: files.filter(
      (item) => (item.state === "changed" || item.state === "missing") && item.usedLater,
    ).length,
  };

  if (summary.unknown > 0) {
    warnings.push(`${summary.unknown} file(s) have no read timestamp; staleness cannot be judged`);
  }

  return {
    version: VERSION,
    transcript: file,
    root,
    generatedAt: now.toISOString(),
    toleranceMs,
    format: parsed.format,
    summary,
    warnings,
    files,
  };
}

function classify({ stat, lastRead, lastWrite, toleranceMs }) {
  if (!stat) return "missing";
  if (!lastRead.at) return "unknown";
  const readMs = Date.parse(lastRead.at);
  if (Number.isNaN(readMs)) return "unknown";
  if (stat.mtimeMs <= readMs + toleranceMs) return "fresh";

  if (lastWrite?.at) {
    const writeMs = Date.parse(lastWrite.at);
    if (!Number.isNaN(writeMs) && stat.mtimeMs <= writeMs + toleranceMs) return "self-edited";
  }
  return "changed";
}

function findLaterUse(entry, lastRead, events, root) {
  const basename = path.basename(entry.absolute);
  let found = null;
  for (const event of events) {
    if (event.index <= lastRead.index) continue;
    if (event.kind === "write" && event.path) {
      const absolute = resolveReadPath(event.path, root);
      if (absolute && pathKey(absolute) === entry.key) found = "edit";
    } else if (event.kind === "command" && event.command) {
      if (event.command.includes(basename) || event.command.includes(entry.display)) {
        found = "command";
      }
    }
  }
  return found;
}

function compareFiles(a, b) {
  return priority(a) - priority(b) || a.path.localeCompare(b.path);
}

function priority(item) {
  const stale = item.state === "changed" || item.state === "missing";
  if (stale && item.usedLater) return 0;
  if (item.state === "changed") return 1;
  if (item.state === "missing") return 2;
  if (item.state === "unknown") return 3;
  if (item.state === "self-edited") return 4;
  return 5;
}

export function resolveReadPath(raw, root) {
  if (typeof raw !== "string") return null;
  let value = raw.trim().replace(/^["']|["']$/g, "");
  if (!value) return null;
  if (value.startsWith("file://")) {
    try {
      value = fileURLToPath(value);
    } catch {
      return null;
    }
  }
  if (value === "~") value = os.homedir();
  else if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(root, value);
}

export function pathKey(absolute) {
  const normalized = path.normalize(absolute);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function displayPath(absolute, root) {
  const relative = path.relative(root, absolute);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return absolute.split(path.sep).join("/");
}

export function compileIgnore(patterns = []) {
  const rules = patterns
    .filter((pattern) => typeof pattern === "string" && pattern.trim())
    .map((pattern) => {
      const raw = pattern.trim().replace(/\\/g, "/");
      return { raw, regex: globToRegExp(raw) };
    });
  if (rules.length === 0) return () => false;

  return (absolute, display) => {
    const target = display.replace(/\\/g, "/");
    const base = path.basename(absolute);
    return rules.some(({ raw, regex }) => {
      if (regex.test(target)) return true;
      if (!raw.includes("/") && (regex.test(base) || raw === base)) return true;
      return false;
    });
  };
}

function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`(^|/)${out}$`);
}

async function safeStat(absolute) {
  try {
    return await fs.stat(absolute);
  } catch {
    return null;
  }
}
