// Where each agent keeps its sessions, and how to read messages out of them.
//
// Every format has changed over time, so extraction is shape driven: anything
// that looks like a message with a role and some text is indexed.

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { cpSlice, flatten, isRecord, pyStrip, str } from "./text";

export type SourceName = "claude" | "codex" | "agy" | "kimi";

/** Root directories of each agent's history. Injected so tests can point elsewhere. */
export interface SessionRoots {
  claude: string;
  codex: string;
  agy: string;
  kimi: string;
}

export const defaultRoots = (): SessionRoots => ({
  claude: join(homedir(), ".claude", "projects"),
  codex: join(homedir(), ".codex", "sessions"),
  agy: join(homedir(), ".gemini", "antigravity-cli", "brain"),
  kimi: join(homedir(), ".kimi-code", "sessions"),
});

/** One JSONL file holding (part of) a session. */
export interface SessionFile {
  path: string;
  source: SourceName;
  session: string;
}

/** A message as it is indexed. `line` is the 0-based JSONL line it came from. */
export interface IndexedMessage {
  line: number;
  role: string;
  ts: string;
  text: string;
  cwd: string;
  isError: boolean;
}

export interface SessionSource {
  name: SourceName;
  /** Every session file this agent has written. */
  discover(roots: SessionRoots): SessionFile[];
  /** Messages on or after `fromLine`. Context such as cwd is still taken from earlier lines. */
  read(path: string, fromLine: number): IndexedMessage[];
}

const MAX_TEXT = 1200;

// MARK: JSONL reading

/** Parsed JSON objects of a JSONL file, with their 0-based line numbers. */
function* jsonlRecords(path: string): Generator<[number, Record<string, unknown>]> {
  // Python's text mode splits on \r\n, \r and \n; line numbers must agree with it.
  const lines = readFileSync(path, "utf-8").split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!pyStrip(line)) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(d)) yield [i, d];
  }
}

// MARK: discovery

/** Like os.walk: recurse into real directories only, yield everything else as a file. */
function* walkFiles(root: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs: string[] = [];
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) dirs.push(p);
    else if (e.isSymbolicLink() && isDirectory(p)) continue;
    else yield p;
  }
  for (const d of dirs) yield* walkFiles(d);
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

// MARK: Claude Code

export const claude: SessionSource = {
  name: "claude",
  discover: (roots) =>
    [...walkFiles(roots.claude)]
      .filter((p) => p.endsWith(".jsonl"))
      .map((path) => ({ path, source: "claude", session: basename(path).slice(0, -6) })),

  read(path, fromLine) {
    const out: IndexedMessage[] = [];
    for (const [i, d] of jsonlRecords(path)) {
      if (i < fromLine) continue;
      const msg = d.message;
      if (!isRecord(msg)) continue;
      const text = flatten(msg.content);
      if (!text) continue;
      out.push({
        line: i,
        role: str(msg.role) || str(d.type),
        ts: str(d.timestamp),
        text: cpSlice(text, MAX_TEXT),
        cwd: str(d.cwd),
        isError: Boolean(d.isApiErrorMessage),
      });
    }
    return out;
  },
};

// MARK: Codex

export const codex: SessionSource = {
  name: "codex",
  discover: (roots) =>
    [...walkFiles(roots.codex)]
      .filter((p) => p.endsWith(".jsonl"))
      .map((path) => {
        const stem = basename(path).slice(0, -6);
        return { path, source: "codex", session: stem.length > 36 ? stem.slice(-36) : stem };
      }),

  read(path, fromLine) {
    const out: IndexedMessage[] = [];
    let cwd = "";
    for (const [i, d] of jsonlRecords(path)) {
      const payload = isRecord(d.payload) ? d.payload : d;
      if (d.type === "session_meta" || "cwd" in payload) cwd = str(payload.cwd) || cwd;
      if (i < fromLine) continue;
      if (payload.type !== undefined && payload.type !== null && payload.type !== "message") continue;
      const role = str(payload.role);
      if (!role) continue;
      const text = flatten(payload.content);
      if (!text) continue;
      out.push({
        line: i,
        role,
        ts: str(d.timestamp) || str(payload.timestamp),
        text: cpSlice(text, MAX_TEXT),
        cwd,
        isError: false,
      });
    }
    return out;
  },
};

// MARK: Antigravity

/** The user's own words inside Antigravity's wrapped USER_INPUT. */
export function cleanUserContent(content: string): string {
  if (!content) return "";
  const req = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  if (req) return pyStrip(req[1]!);
  const afterSys = /<system_instructions>[\s\S]*?<\/system_instructions>\s*([\s\S]*)/.exec(content);
  if (afterSys) return pyStrip(afterSys[1]!);
  return pyStrip(content);
}

/** A working directory guessed from a tool call's arguments. */
export function agyCwdOf(args: unknown): string {
  if (!isRecord(args)) return "";
  const p = args.Cwd || args.SearchPath || args.DirectoryPath;
  return typeof p === "string" && p.startsWith("/") ? p : "";
}

export const agy: SessionSource = {
  name: "agy",
  discover: (roots) =>
    listDir(roots.agy)
      .map((name) => ({
        path: join(roots.agy, name, ".system_generated", "logs", "transcript.jsonl"),
        source: "agy" as const,
        session: name,
      }))
      .filter((f) => existsSync(f.path)),

  read(path, fromLine) {
    const out: IndexedMessage[] = [];
    let cwd = "";
    for (const [i, d] of jsonlRecords(path)) {
      const toolCalls = Array.isArray(d.tool_calls) ? d.tool_calls : null;
      if (!cwd && toolCalls) {
        for (const tc of toolCalls) {
          cwd = isRecord(tc) ? agyCwdOf(tc.args) : "";
          if (cwd) break;
        }
      }
      if (i < fromLine) continue;
      let role = "";
      let text = "";
      if (d.type === "USER_INPUT") {
        role = "user";
        text = cleanUserContent(str(d.content));
      } else if (d.type === "PLANNER_RESPONSE") {
        role = "assistant";
        const names = (toolCalls ?? []).filter(isRecord).map((tc) => str(tc.name)).filter(Boolean);
        text = pyStrip(`${str(d.content)} ${names.map((n) => `[${n}]`).join(" ")}`);
      } else if (d.source === "MODEL" && d.type !== "CONVERSATION_HISTORY") {
        role = "tool";
        text = str(d.content);
      }
      if (text) {
        out.push({ line: i, role, ts: str(d.created_at), text: cpSlice(text, MAX_TEXT), cwd, isError: d.status === "ERROR" });
      }
    }
    return out;
  },
};

// MARK: Kimi Code

/** Kimi's epoch-ms timestamps as ISO strings. */
export const kimiTs = (ms: unknown): string =>
  typeof ms === "number" ? new Date(ms).toISOString() : "";

/** sessions/<ws>/<session>/agents/<agent>/wire.jsonl → cwd recorded in <session>/state.json */
function kimiCwd(wirePath: string): string {
  try {
    const state = JSON.parse(readFileSync(join(dirname(dirname(dirname(wirePath))), "state.json"), "utf-8"));
    return isRecord(state) ? str(state.cwd) : "";
  } catch {
    return "";
  }
}

function* kimiAgentDirs(root: string): Generator<string> {
  if (basename(root) === "agents") {
    yield root;
    return;
  }
  for (const name of listDir(root)) {
    const p = join(root, name);
    if (isRealDirectory(p)) yield* kimiAgentDirs(p);
  }
}

function isRealDirectory(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

export const kimi: SessionSource = {
  name: "kimi",
  discover(roots) {
    const files: SessionFile[] = [];
    for (const agentsDir of kimiAgentDirs(roots.kimi)) {
      const session = basename(dirname(agentsDir));
      // main first, then sub-agents
      const agents = listDir(agentsDir).sort((a, b) => Number(a !== "main") - Number(b !== "main"));
      for (const agent of agents) {
        const path = join(agentsDir, agent, "wire.jsonl");
        if (existsSync(path)) files.push({ path, source: "kimi", session });
      }
    }
    return files;
  },

  read(path, fromLine) {
    const cwd = kimiCwd(path);
    const out: IndexedMessage[] = [];
    // A message is held back one step so a following failed turn can mark it as an error.
    let pending: IndexedMessage | null = null;
    for (const [i, d] of jsonlRecords(path)) {
      if (i < fromLine) continue;
      if (d.type === "agent.turn.ended") {
        if (pending && d.outcome === "failed") pending.isError = true;
        continue;
      }
      if (d.type !== "agent.message.appended" || !isRecord(d.message)) continue;
      const meta = d.message.meta;
      const msg = d.message.message;
      if (!isRecord(msg)) continue;
      let role = str(msg.role);
      if (role === "user" && isRecord(meta) && meta.source === "notify") role = "tool";
      let text = flatten(msg.content);
      const names = (Array.isArray(msg.toolCalls) ? msg.toolCalls : []).filter(isRecord).map((c) => str(c.name)).filter(Boolean);
      if (names.length) text = pyStrip(`${text} ${names.map((n) => `[${n}]`).join(" ")}`);
      if (role && text) {
        if (pending) out.push(pending);
        pending = { line: i, role, ts: kimiTs(d.time), text: cpSlice(text, MAX_TEXT), cwd, isError: false };
      }
    }
    if (pending) out.push(pending);
    return out;
  },
};

export const ALL_SOURCES: readonly SessionSource[] = [claude, codex, agy, kimi];

export const sourceNamed = (name: string): SessionSource => {
  const s = ALL_SOURCES.find((x) => x.name === name);
  if (!s) throw new Error(`unknown source: ${name}`);
  return s;
};
