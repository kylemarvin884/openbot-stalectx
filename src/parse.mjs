// Transcript parsing. Supports Claude Code JSONL, OpenAI-style tool_calls,
// and a generic top-level { tool, input, timestamp } event.
//
// The parser is deliberately tolerant: unknown lines are skipped, not fatal.
// Every event keeps its source line number so reports can point at it.

const READ_TOOLS = new Set([
  "read",
  "readfile",
  "readfiles",
  "readtextfile",
  "view",
  "openfile",
  "fileread",
  "filesystemread",
  "filesystemreadfile",
]);

const WRITE_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "writefile",
  "strreplace",
  "strreplaceeditor",
  "applypatch",
  "applydiff",
  "createfile",
  "notebookedit",
  "deletefile",
  "removefile",
  "movefile",
  "renamefile",
]);

const COMMAND_TOOLS = new Set(["bash", "shell", "exec", "runcommand", "terminal", "powershell"]);

const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "file",
  "filename",
  "fileName",
  "target_file",
  "targetFile",
  "notebook_path",
  "notebookPath",
  "absolute_path",
  "absolutePath",
];

/**
 * @typedef {Object} TranscriptEvent
 * @property {number} index   zero-based event order
 * @property {number} line    1-based source line
 * @property {string|null} at ISO timestamp
 * @property {string} kind    "read" | "write" | "command" | "other"
 * @property {string} tool    tool name as written in the transcript
 * @property {string|null} path
 * @property {string|null} command
 */

export function parseTranscript(text, { file = "" } = {}) {
  const lines = String(text).split(/\r?\n/);
  const events = [];
  const warnings = [];
  let cwd = null;
  let format = "unknown";
  let parsedLines = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      warnings.push(`line ${i + 1}: not valid JSON, skipped`);
      continue;
    }
    if (!obj || typeof obj !== "object") continue;

    parsedLines += 1;
    const at = toIso(firstTimestamp(obj));
    if (!cwd) cwd = firstCwd(obj);

    const blocks = toolBlocks(obj);
    if (blocks.length === 0) continue;

    if (obj.sessionId && obj.message) format = format === "unknown" ? "claude-code" : format;
    else if (obj.tool_calls || obj.role) format = format === "unknown" ? "openai" : format;
    else if (typeof obj.tool === "string" || typeof obj.tool_name === "string") {
      format = format === "unknown" ? "generic" : format;
    }

    for (const block of blocks) {
      const input = asObject(block.input);
      const tool = String(block.name ?? "");
      const kind = classifyTool(tool, input);
      const event = {
        index: events.length,
        line: i + 1,
        at,
        kind,
        tool,
        path: extractPath(input),
        command: extractCommand(input),
      };
      events.push(event);
    }
  }

  return { file, format, cwd, events, warnings, lines: lines.length, parsedLines };
}

function toolBlocks(obj) {
  const blocks = [];
  const message = obj.message && typeof obj.message === "object" ? obj.message : obj;

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && part.type === "tool_use" && part.name) {
        blocks.push({ name: part.name, input: part.input });
      }
    }
  }

  const callGroups = message === obj ? [obj.tool_calls] : [message.tool_calls, obj.tool_calls];
  for (const calls of callGroups) {
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!call || typeof call !== "object") continue;
      const name = call.function?.name ?? call.name ?? call.tool;
      const input = call.function?.arguments ?? call.arguments ?? call.input;
      if (name) blocks.push({ name, input });
    }
  }

  if (typeof obj.tool === "string") {
    blocks.push({ name: obj.tool, input: obj.input ?? obj.args ?? obj.state?.input });
  }
  if (typeof obj.tool_name === "string") {
    blocks.push({ name: obj.tool_name, input: obj.tool_input ?? obj.input ?? obj.args });
  }
  if (obj.state && typeof obj.state === "object" && obj.state.tool) {
    blocks.push({ name: obj.state.tool, input: obj.state.input });
  }

  return blocks;
}

export function normalizeToolName(name) {
  return String(name)
    .toLowerCase()
    .split(/__|\.|\//)
    .pop()
    .replace(/[^a-z0-9]/g, "");
}

export function classifyTool(name, input) {
  const normalized = normalizeToolName(name);
  const command = String(input?.command ?? "").toLowerCase();
  if (READ_TOOLS.has(normalized)) return "read";
  // Claude's older editor tool reads when command is "view".
  if ((normalized === "strreplaceeditor" || normalized === "edit") && command === "view") return "read";
  if (WRITE_TOOLS.has(normalized)) return "write";
  if (COMMAND_TOOLS.has(normalized)) return "command";
  return "other";
}

export function extractPath(input) {
  if (!input || typeof input !== "object") return null;
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function extractCommand(input) {
  if (!input || typeof input !== "object") return null;
  const value = input.command ?? input.cmd ?? input.script;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function firstTimestamp(obj) {
  const candidates = [
    obj.timestamp,
    obj.ts,
    obj.time,
    obj.created_at,
    obj.createdAt,
    obj.message?.timestamp,
    obj.state?.time?.created,
  ];
  return candidates.find((value) => value !== undefined && value !== null) ?? null;
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: seconds vs milliseconds.
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function firstCwd(obj) {
  const candidates = [obj.cwd, obj.project?.cwd, obj.message?.cwd, obj.state?.cwd];
  const value = candidates.find((item) => typeof item === "string" && item.trim());
  return value ? value.trim() : null;
}
