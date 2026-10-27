import test from "node:test";
import assert from "node:assert/strict";
import { parseTranscript, normalizeToolName, classifyTool } from "../src/parse.mjs";

const line = (obj) => JSON.stringify(obj);

test("parses Claude Code tool_use blocks with timestamps and cwd", () => {
  const text = [
    line({
      type: "user",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "C:/work/shop",
      sessionId: "s1",
      message: { role: "user", content: "hi" },
    }),
    line({
      type: "assistant",
      timestamp: "2026-01-01T00:00:10.000Z",
      cwd: "C:/work/shop",
      sessionId: "s1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/a.ts" } }],
      },
    }),
    line({
      type: "assistant",
      timestamp: "2026-01-01T00:00:20.000Z",
      cwd: "C:/work/shop",
      sessionId: "s1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }],
      },
    }),
  ].join("\n");

  const parsed = parseTranscript(text, { file: "session.jsonl" });
  assert.equal(parsed.format, "claude-code");
  assert.equal(parsed.cwd, "C:/work/shop");
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[0].kind, "read");
  assert.equal(parsed.events[0].path, "src/a.ts");
  assert.equal(parsed.events[0].at, "2026-01-01T00:00:10.000Z");
  assert.equal(parsed.events[0].line, 2);
  assert.equal(parsed.events[1].kind, "command");
  assert.equal(parsed.events[1].command, "npm test");
});

test("parses OpenAI-style tool_calls with JSON string arguments", () => {
  const text = line({
    role: "assistant",
    timestamp: "2026-01-01T00:01:00.000Z",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: '{"file_path":"src/b.ts"}' },
      },
    ],
  });

  const parsed = parseTranscript(text);
  assert.equal(parsed.format, "openai");
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].kind, "read");
  assert.equal(parsed.events[0].path, "src/b.ts");
});

test("parses generic top-level tool events and editor view commands", () => {
  const text = [
    line({ tool: "str_replace_editor", input: { command: "view", path: "src/c.ts" }, timestamp: 1767225600 }),
    line({ tool: "str_replace_editor", input: { command: "str_replace", path: "src/c.ts" }, timestamp: 1767225660 }),
  ].join("\n");

  const parsed = parseTranscript(text);
  assert.equal(parsed.format, "generic");
  assert.equal(parsed.events[0].kind, "read");
  assert.equal(parsed.events[1].kind, "write");
  assert.equal(parsed.events[0].at, "2026-01-01T00:00:00.000Z");
});

test("accepts MCP-prefixed tool names", () => {
  assert.equal(normalizeToolName("mcp__filesystem__read_file"), "readfile");
  assert.equal(classifyTool("mcp__filesystem__read_file", {}), "read");
  assert.equal(classifyTool("mcp__filesystem__write_file", {}), "write");
});

test("skips malformed lines with a warning instead of failing", () => {
  const text = ["{not json", line({ tool: "Read", input: { path: "a.ts" }, timestamp: "2026-01-01T00:00:00Z" })].join("\n");
  const parsed = parseTranscript(text);
  assert.equal(parsed.events.length, 1);
  assert.match(parsed.warnings[0], /line 1/);
});

test("handles missing timestamps without crashing", () => {
  const parsed = parseTranscript(line({ tool: "Read", input: { path: "a.ts" } }));
  assert.equal(parsed.events[0].at, null);
});
