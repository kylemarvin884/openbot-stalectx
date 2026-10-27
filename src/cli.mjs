#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { scanTranscript, VERSION } from "./scan.mjs";
import { renderJson, renderReport } from "./report.mjs";

const HELP = `stalectx ${VERSION} — find files an agent read that changed on disk since

Usage:
  stalectx scan <transcript.jsonl> [options]

Options:
  --root <dir>            resolve relative paths against this directory (default: transcript cwd)
  --json                  machine-readable output
  --fail-on=stale|none    exit 1 when stale files exist (default: stale)
  --tolerance-ms <n>      mtime tolerance in milliseconds (default: 2000)
  --ignore <glob>         ignore a path glob; repeatable
  --no-color              disable ANSI colors
  --quiet                 print only the summary line
  -h, --help              show this help
  -v, --version           print version

Exit codes:
  0  no stale context (or --fail-on=none)
  1  stale context found
  2  bad usage or unreadable transcript
`;

export async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`stalectx: ${error.message}\n`);
    return 2;
  }

  if (options.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (options.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!options.file) {
    io.stderr.write(`${HELP}\n`);
    return 2;
  }

  let report;
  try {
    report = await scanTranscript(options.file, {
      root: options.root,
      toleranceMs: options.toleranceMs,
      ignore: options.ignore,
    });
  } catch (error) {
    io.stderr.write(`stalectx: cannot read transcript ${options.file}: ${error.message}\n`);
    return 2;
  }

  const color = options.color && Boolean(io.stdout.isTTY);
  if (options.json) {
    io.stdout.write(renderJson(report));
  } else if (options.quiet) {
    const { summary } = report;
    io.stdout.write(`stale ${summary.stale} / ${summary.files} files, ${summary.risky} used after going stale\n`);
  } else {
    io.stdout.write(renderReport(report, { color }));
  }

  if (options.failOn === "none") return 0;
  return report.summary.stale > 0 ? 1 : 0;
}

export function parseArgs(argv) {
  const options = {
    file: null,
    root: undefined,
    json: false,
    quiet: false,
    color: true,
    failOn: "stale",
    toleranceMs: 2000,
    ignore: [],
    help: false,
    version: false,
  };

  const queue = [...argv];
  if (queue[0] === "scan") queue.shift();

  while (queue.length > 0) {
    const arg = queue.shift();
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-v" || arg === "--version") options.version = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--no-color") options.color = false;
    else if (arg === "--root") options.root = nextValue(queue, "--root");
    else if (arg.startsWith("--root=")) options.root = arg.slice("--root=".length);
    else if (arg === "--ignore") options.ignore.push(nextValue(queue, "--ignore"));
    else if (arg.startsWith("--ignore=")) options.ignore.push(arg.slice("--ignore=".length));
    else if (arg === "--tolerance-ms") options.toleranceMs = parseNumber(nextValue(queue, "--tolerance-ms"), "--tolerance-ms");
    else if (arg.startsWith("--tolerance-ms=")) {
      options.toleranceMs = parseNumber(arg.slice("--tolerance-ms=".length), "--tolerance-ms");
    } else if (arg === "--fail-on") options.failOn = parseFailOn(nextValue(queue, "--fail-on"));
    else if (arg.startsWith("--fail-on=")) options.failOn = parseFailOn(arg.slice("--fail-on=".length));
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else if (!options.file) options.file = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }

  return options;
}

function nextValue(queue, name) {
  if (queue.length === 0) throw new Error(`${name} needs a value`);
  return queue.shift();
}

function parseNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a non-negative number`);
  return number;
}

function parseFailOn(value) {
  if (value !== "stale" && value !== "none") throw new Error("--fail-on must be stale or none");
  return value;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href.toLowerCase() === import.meta.url.toLowerCase();
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
