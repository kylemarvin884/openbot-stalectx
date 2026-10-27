import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanTranscript, compileIgnore, displayPath } from "../src/scan.mjs";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (seconds) => new Date(T0 + seconds * 1000).toISOString();
const line = (obj) => JSON.stringify(obj);

test("classifies fresh, changed, missing, self-edited, and external-after-self-edit", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stalectx-scan-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await write(dir, "src/fresh.ts", "a\n");
  await write(dir, "src/changed.ts", "b\n");
  await write(dir, "src/self.ts", "c\n");
  await write(dir, "src/overwritten.ts", "d\n");
  await write(dir, "src/gone.ts", "e\n");

  await setMtime(dir, "src/fresh.ts", T0);
  await setMtime(dir, "src/changed.ts", T0 + 600 * 1000);
  await setMtime(dir, "src/self.ts", T0 + 300 * 1000);
  await setMtime(dir, "src/overwritten.ts", T0 + 1200 * 1000);
  await fs.rm(path.join(dir, "src/gone.ts"));

  const transcript = path.join(dir, "session.jsonl");
  const events = [
    read("src/fresh.ts", 10),
    read("src/changed.ts", 10),
    read("src/self.ts", 10),
    read("src/overwritten.ts", 10),
    read("src/gone.ts", 10),
    { type: "assistant", timestamp: iso(300), message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/self.ts" } }] } },
    { type: "assistant", timestamp: iso(600), message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/overwritten.ts" } }] } },
  ];
  await fs.writeFile(transcript, events.map((event) => line({ ...event, cwd: dir, sessionId: "s" })).join("\n") + "\n");

  const report = await scanTranscript(transcript, { root: dir });
  const byPath = Object.fromEntries(report.files.map((file) => [file.path, file]));

  assert.equal(byPath["src/fresh.ts"].state, "fresh");
  assert.equal(byPath["src/changed.ts"].state, "changed");
  assert.equal(byPath["src/gone.ts"].state, "missing");
  assert.equal(byPath["src/self.ts"].state, "self-edited");
  assert.equal(byPath["src/overwritten.ts"].state, "changed");
  assert.equal(byPath["src/changed.ts"].deltaMs, 590 * 1000);
  assert.equal(report.summary.stale, 3);
  assert.equal(report.summary.missing, 1);
  assert.equal(report.summary.selfEdited, 1);
});

test("marks stale files used later by an edit or a command", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stalectx-use-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await write(dir, "src/a.ts", "a\n");
  await write(dir, "src/b.ts", "b\n");
  await setMtime(dir, "src/a.ts", T0 + 600 * 1000);
  await setMtime(dir, "src/b.ts", T0 + 600 * 1000);

  const transcript = path.join(dir, "session.jsonl");
  const events = [
    read("src/a.ts", 10),
    read("src/b.ts", 10),
    { type: "assistant", timestamp: iso(700), message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "node build.mjs src/a.ts" } }] } },
  ];
  await fs.writeFile(transcript, events.map((event) => line({ ...event, cwd: dir, sessionId: "s" })).join("\n") + "\n");

  const report = await scanTranscript(transcript, { root: dir });
  const byPath = Object.fromEntries(report.files.map((file) => [file.path, file]));
  assert.equal(byPath["src/a.ts"].usedLater, "command");
  assert.equal(byPath["src/b.ts"].usedLater, null);
  assert.equal(report.summary.risky, 1);
  assert.equal(report.files[0].path, "src/a.ts");
});

test("ignores glob patterns and counts only non-ignored reads", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stalectx-ignore-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await write(dir, "dist/bundle.js", "x\n");
  await write(dir, "src/app.ts", "y\n");
  await setMtime(dir, "dist/bundle.js", T0 + 600 * 1000);
  await setMtime(dir, "src/app.ts", T0);

  const transcript = path.join(dir, "session.jsonl");
  const events = [read("dist/bundle.js", 10), read("src/app.ts", 10)];
  await fs.writeFile(transcript, events.map((event) => line({ ...event, cwd: dir, sessionId: "s" })).join("\n") + "\n");

  const report = await scanTranscript(transcript, { root: dir, ignore: ["dist/**"] });
  assert.deepEqual(report.files.map((file) => file.path), ["src/app.ts"]);
  assert.equal(report.summary.reads, 1);

  const matcher = compileIgnore(["dist/**", "*.lock"]);
  assert.equal(matcher("/repo/dist/a.js", "dist/a.js"), true);
  assert.equal(matcher("/repo/package-lock.json", "package-lock.json"), false);
  assert.equal(matcher("/repo/yarn.lock", "yarn.lock"), true);
});

test("reports unknown when the transcript has no timestamp", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stalectx-unknown-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await write(dir, "src/a.ts", "a\n");
  const transcript = path.join(dir, "session.jsonl");
  await fs.writeFile(transcript, line({ tool: "Read", input: { path: "src/a.ts" } }) + "\n");

  const report = await scanTranscript(transcript, { root: dir });
  assert.equal(report.files[0].state, "unknown");
  assert.match(report.warnings.join("\n"), /no read timestamp/);
});

test("displayPath keeps paths inside root relative and normalizes separators", () => {
  const root = path.resolve(os.tmpdir(), "shop");
  const inside = displayPath(path.join(root, "src", "a.ts"), root);
  assert.equal(inside, "src/a.ts");
  const outside = path.resolve(os.tmpdir(), "other", "b.ts");
  assert.equal(displayPath(outside, root), outside.split(path.sep).join("/"));
});

function read(filePath, seconds) {
  return {
    type: "assistant",
    timestamp: iso(seconds),
    message: { role: "assistant", content: [{ type: "tool_use", id: `t-${filePath}-${seconds}`, name: "Read", input: { file_path: filePath } }] },
  };
}

async function write(dir, relative, content) {
  const target = path.join(dir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function setMtime(dir, relative, ms) {
  const when = new Date(ms);
  await fs.utimes(path.join(dir, relative), when, when);
}
