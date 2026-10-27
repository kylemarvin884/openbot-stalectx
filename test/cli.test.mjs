import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (seconds) => new Date(T0 + seconds * 1000).toISOString();

test("scan exits 1 and prints STALE for a changed file", async (t) => {
  const fixture = await makeFixture(t);
  const result = run(["scan", fixture.transcript, "--root", fixture.dir, "--no-color"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /STALE/);
  assert.match(result.stdout, /src\/changed\.ts/);
  assert.match(result.stdout, /1 stale \/ 1 files/);
});

test("--json returns a stable machine-readable shape", async (t) => {
  const fixture = await makeFixture(t);
  const result = run(["scan", fixture.transcript, "--root", fixture.dir, "--json"]);

  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.version, "0.1.0");
  assert.equal(report.files[0].path, "src/changed.ts");
  assert.equal(report.files[0].state, "changed");
  assert.equal(report.summary.stale, 1);
  assert.equal(typeof report.files[0].lastReadAt, "string");
});

test("--fail-on=none keeps the report but exits 0", async (t) => {
  const fixture = await makeFixture(t);
  const result = run(["scan", fixture.transcript, "--root", fixture.dir, "--fail-on=none"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /STALE/);
});

test("a clean transcript exits 0", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stalectx-cli-clean-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "src.ts"), "ok\n");
  const when = new Date(T0);
  await fs.utimes(path.join(dir, "src.ts"), when, when);

  const transcript = path.join(dir, "session.jsonl");
  await fs.writeFile(
    transcript,
    JSON.stringify({
      type: "assistant",
      timestamp: iso(10),
      cwd: dir,
      sessionId: "s",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "src.ts" } }] },
    }) + "\n",
  );

  const result = run(["scan", transcript, "--root", dir, "--no-color"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no stale context/);
});

test("bad usage exits 2", () => {
  assert.equal(run(["scan"]).status, 2);
  assert.equal(run(["scan", "x.jsonl", "--nope"]).status, 2);
  assert.equal(run(["scan", "x.jsonl", "--fail-on=maybe"]).status, 2);
  const missing = run(["scan", path.join(os.tmpdir(), "does-not-exist-stalectx.jsonl")]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read transcript/);
});

test("--help exits 0", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

function makeFixture(t) {
  return (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stalectx-cli-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.mkdir(path.join(dir, "src"));
    await fs.writeFile(path.join(dir, "src/changed.ts"), "new\n");
    const when = new Date(T0 + 600 * 1000);
    await fs.utimes(path.join(dir, "src/changed.ts"), when, when);

    const transcript = path.join(dir, "session.jsonl");
    await fs.writeFile(
      transcript,
      JSON.stringify({
        type: "assistant",
        timestamp: iso(10),
        cwd: dir,
        sessionId: "s",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Read", input: { file_path: "src/changed.ts" } }],
        },
      }) + "\n",
    );
    return { dir, transcript };
  })();
}

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}
