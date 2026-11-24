// A whole session, read fresh from its file for viewers (not from the index,
// which keeps only truncated text).

import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { projectOf } from "./query";
import { agyCwdOf, cleanUserContent, codex, kimiTs, type SessionRoots } from "./sources";
import { cpLength, cpSlice, isRecord, pyStrip, str } from "./text";

export type Part =
  | { type: "text" | "thinking"; text: string }
  | { type: "tool_use"; name: string; input: string }
  | { type: "tool_result"; text: string; isError: boolean };

export interface Entry {
  role: string;
  ts: unknown;
  /** 1-based line in the session file */
  line: number;
  isMeta: boolean;
  parts: Part[];
}

export interface SessionDetail {
  id: string;
  source: string;
  project: string;
  cwd: string;
  entries: Entry[];
}

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

function trunc(s: string, limit = 3000): string {
  if (!s) return s;
  s = s.replace(ANSI, "");
  const len = cpLength(s);
  return len > limit ? `${cpSlice(s, limit)}\n… [${len - limit} chars truncated]` : s;
}

const hasText = (v: unknown): v is string => typeof v === "string" && pyStrip(v) !== "";

/** JSON lines of a file with their 1-based line numbers. */
function* records(path: string): Generator<[number, Record<string, unknown>]> {
  const lines = readFileSync(path, "utf-8").split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!pyStrip(lines[i]!)) continue;
    try {
      const d = JSON.parse(lines[i]!);
      if (isRecord(d)) yield [i + 1, d];
    } catch {
      // partial or corrupt line
    }
  }
}

/** A tool result belongs to the assistant turn that called the tool. */
function attachToolResult(entries: Entry[], part: Part, fallback: Omit<Entry, "parts">) {
  const last = entries.at(-1);
  if (last && last.role === "assistant") last.parts.push(part);
  else entries.push({ ...fallback, parts: [part] });
}

const argsText = (args: unknown) => (typeof args === "string" ? args : JSON.stringify(args || {}));

// MARK: per-source readers

function claudeEntries(path: string, cwd: { value: string }): Entry[] {
  const entries: Entry[] = [];
  for (const [line, d] of records(path)) {
    if (!cwd.value && typeof d.cwd === "string") cwd.value = d.cwd;
    if (d.type !== "user" && d.type !== "assistant") continue;
    const content = isRecord(d.message) ? d.message.content : undefined;
    const parts: Part[] = [];
    if (typeof content === "string") {
      if (hasText(content)) parts.push({ type: "text", text: trunc(content) });
    } else if (Array.isArray(content)) {
      for (const c of content) {
        if (!isRecord(c)) continue;
        if (c.type === "text" && hasText(c.text)) parts.push({ type: "text", text: trunc(c.text) });
        else if (c.type === "thinking" && c.thinking) parts.push({ type: "thinking", text: trunc(str(c.thinking)) });
        else if (c.type === "tool_use")
          parts.push({ type: "tool_use", name: str(c.name) || "tool", input: trunc(JSON.stringify(c.input ?? {})) });
        else if (c.type === "tool_result") parts.push({ type: "tool_result", text: trunc(toolResultText(c.content)), isError: Boolean(c.is_error) });
        else if (c.type === "image") parts.push({ type: "text", text: "[image]" });
      }
    }
    if (parts.length) entries.push({ role: d.type, ts: d.timestamp, line, isMeta: Boolean(d.isMeta), parts });
  }
  return entries;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((x) => (isRecord(x) && x.type === "text" ? str(x.text) : isRecord(x) && x.type === "image" ? "[image]" : ""))
    .join("\n");
}

function agyEntries(path: string, cwd: { value: string }): Entry[] {
  const entries: Entry[] = [];
  for (const [line, d] of records(path)) {
    const base = { ts: d.created_at, line, isMeta: false };
    if (d.type === "USER_INPUT") {
      const text = cleanUserContent(str(d.content));
      if (text) entries.push({ ...base, role: "user", parts: [{ type: "text", text }] });
    } else if (d.type === "PLANNER_RESPONSE") {
      const parts: Part[] = [];
      if (hasText(d.content)) parts.push({ type: "text", text: trunc(pyStrip(d.content)) });
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        if (!isRecord(tc)) continue;
        parts.push({ type: "tool_use", name: str(tc.name) || "tool", input: trunc(argsText(tc.args)) });
        if (!cwd.value) cwd.value = agyCwdOf(tc.args);
      }
      if (parts.length) entries.push({ ...base, role: "assistant", parts });
    } else if (d.source === "MODEL" && typeof d.content === "string") {
      const text = pyStrip(d.content);
      if (text) attachToolResult(entries, { type: "tool_result", text: trunc(text), isError: d.status === "ERROR" }, { ...base, role: "assistant" });
    }
  }
  return entries;
}

function kimiEntries(path: string): Entry[] {
  const entries: Entry[] = [];
  for (const [line, ev] of records(path)) {
    if (ev.type !== "agent.message.appended" || !isRecord(ev.message) || !isRecord(ev.message.message)) continue;
    const m = ev.message.message;
    const meta = isRecord(ev.message.meta) ? ev.message.meta : {};
    const ts = meta.createdAt || kimiTs(ev.time);
    const content = (Array.isArray(m.content) ? m.content : []).filter(isRecord);
    const parts: Part[] = [];
    if (m.role === "user") {
      for (const c of content) if (c.type === "text" && hasText(c.text)) parts.push({ type: "text", text: trunc(c.text) });
    } else if (m.role === "assistant") {
      for (const c of content) {
        if (c.type === "think" && hasText(c.think)) parts.push({ type: "thinking", text: trunc(c.think) });
        else if (c.type === "text" && hasText(c.text)) parts.push({ type: "text", text: trunc(c.text) });
      }
      for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        if (isRecord(tc) && tc.name) parts.push({ type: "tool_use", name: str(tc.name), input: trunc(argsText(tc.arguments)) });
      }
    } else if (m.role === "tool") {
      const texts = content.filter((c) => c.type === "text" && c.text).map((c) => str(c.text)).join("\n");
      if (pyStrip(texts)) {
        const isError = Boolean(meta.isError) || content.some((c) => c.isError);
        attachToolResult(entries, { type: "tool_result", text: trunc(texts), isError }, { role: "assistant", ts, line, isMeta: false });
      }
      continue;
    }
    if (parts.length) entries.push({ role: str(m.role), ts, line, isMeta: false, parts });
  }
  return entries;
}

function codexEntries(path: string, cwd: { value: string }): Entry[] {
  return codex.read(path, 0).map((m) => {
    cwd.value = m.cwd || cwd.value;
    return { role: m.role, ts: m.ts, line: m.line + 1, isMeta: false, parts: [{ type: "text", text: trunc(m.text) }] };
  });
}

// MARK: lookup

function resolvePath(db: Database | null, roots: SessionRoots, source: string, id: string, project: string) {
  const row = db
    ?.query(`SELECT path, cwd, source FROM sessions WHERE session = ?${source ? " AND source = ?" : ""} LIMIT 1`)
    .get(...(source ? [id, source] : [id])) as { path: string; cwd: string; source: string } | null | undefined;
  if (row?.path && existsSync(row.path)) return { path: row.path, cwd: row.cwd ?? "", source: row.source || source };

  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
  const found = (path: string) => (existsSync(path) ? { path, cwd: "", source } : null);
  if (source === "claude" && project) return found(join(roots.claude, project.replace(/[^a-zA-Z0-9._-]/g, ""), `${safeId}.jsonl`));
  if (source === "agy") return found(join(roots.agy, safeId, ".system_generated", "logs", "transcript.jsonl"));
  if (source === "kimi") {
    let workspaces: string[] = [];
    try {
      workspaces = readdirSync(roots.kimi);
    } catch {}
    for (const ws of workspaces) {
      const hit = found(join(roots.kimi, ws, safeId, "agents", "main", "wire.jsonl"));
      if (hit) return hit;
    }
  }
  return null;
}

/** Every message of a session, or null when its file cannot be found. */
export function getSessionDetail(
  db: Database | null,
  roots: SessionRoots,
  { source, id, project = "" }: { source: string; id: string; project?: string },
): SessionDetail | null {
  const resolved = resolvePath(db, roots, source, id, project);
  if (!resolved) return null;
  const cwd = { value: resolved.cwd };
  const read = {
    claude: () => claudeEntries(resolved.path, cwd),
    agy: () => agyEntries(resolved.path, cwd),
    kimi: () => kimiEntries(resolved.path),
    codex: () => codexEntries(resolved.path, cwd),
  }[resolved.source];
  const entries = read ? read() : [];
  return {
    id,
    source: resolved.source,
    project: project || projectOf(resolved.source, cwd.value, resolved.path),
    cwd: cwd.value,
    entries,
  };
}
