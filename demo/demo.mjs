// Reproducible demo: builds a throwaway repo + a Claude Code style transcript,
// then scans it. No network, no model calls, no API key.
//
// Run: npm run demo

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanTranscript } from "../src/scan.mjs";
import { renderReport } from "../src/report.mjs";

const MINUTE = 60 * 1000;
const base = Math.floor((Date.now() - 2 * 60 * MINUTE) / 1000) * 1000;
const at = (minutes) => new Date(base + minutes * MINUTE).toISOString();

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stalectx-demo-"));
const transcriptPath = path.join(dir, "demo-session.jsonl");

try {
  await write("src/api.ts", "export const api = 1;\n");
  await write("src/checkout.ts", "export function checkout() { return 100; }\n");
  await write("src/agent-edited.ts", "export const note = 'edited by the agent';\n");
  await write("src/legacy/cart.ts", "export const legacy = true;\n");
  await write("config/pricing.json", '{\n  "freeShippingThreshold": 100\n}\n');

  // External changes: a human (or another agent) touched checkout.ts and pricing.json,
  // and deleted the legacy cart module, all after the agent read them.
  await setMtime("src/api.ts", 0);
  await setMtime("src/checkout.ts", 19);
  await setMtime("src/agent-edited.ts", 5);
  await setMtime("config/pricing.json", 26);
  await fs.rm(path.join(dir, "src/legacy/cart.ts"));

  const lines = [
    user("How does checkout pricing work?", 0),
    tool("Read", { file_path: "src/api.ts" }, 1),
    tool("Read", { file_path: "config/pricing.json" }, 1),
    tool("Read", { file_path: "src/agent-edited.ts" }, 2),
    tool("Read", { file_path: "src/checkout.ts" }, 2),
    tool("Read", { file_path: "src/legacy/cart.ts" }, 3),
    tool("Edit", { file_path: "src/agent-edited.ts", old_string: "old", new_string: "new" }, 5),
    tool("Bash", { command: "node scripts/build.mjs src/checkout.ts" }, 21),
  ];
  await fs.writeFile(
    transcriptPath,
    lines.map((line) => JSON.stringify({ ...line, cwd: dir, sessionId: "demo-session" })).join("\n") + "\n",
    "utf8",
  );

  const report = await scanTranscript(transcriptPath, { root: dir });
  process.stdout.write(renderReport(report, { color: false }));
  process.stdout.write(
    `\ndemo transcript: ${transcriptPath}\n` +
      `exit code with --fail-on=stale: ${report.summary.stale > 0 ? 1 : 0}\n`,
  );
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

async function write(relative, content) {
  const target = path.join(dir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function setMtime(relative, minutes) {
  const target = path.join(dir, relative);
  const when = new Date(base + minutes * MINUTE);
  await fs.utimes(target, when, when);
}

function tool(name, input, minutes) {
  return {
    type: "assistant",
    timestamp: at(minutes),
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: `tool-${minutes}-${name}`, name, input }],
    },
  };
}

function user(text, minutes) {
  return {
    type: "user",
    timestamp: at(minutes),
    message: { role: "user", content: text },
  };
}
