// Terminal rendering: result lines for fzf, and the preview pane.

import type { SessionDetail } from "../session-index/detail";
import type { SearchResult, SessionRow } from "../session-index/query";
import type { SourceName } from "../session-index/sources";
import { termsOf } from "../session-index/text";

const R = "\x1b[0m";
const DIM = "\x1b[2m";
const HL = "\x1b[30;43m";

const TAG: Record<SourceName, string> = {
  claude: "\x1b[1;34mcc",
  codex: "\x1b[1;35mcx",
  agy: "\x1b[1;32mag",
  kimi: "\x1b[1;33mkm",
};

const ENDING: Record<string, string> = { error: "\x1b[31m✗", cut: "\x1b[33m…", stopped: "\x1b[2m■" };

export function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (!ts || Number.isNaN(d.getTime())) return "????-??-?? ??:??";
  return d
    .toLocaleString("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .replace("T", " ");
}

/** UUIDv7 ids (Codex) start with a timestamp, so their head is shared by sessions started together. */
const shortId = (id: string) => (/^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(id) ? id.slice(-8) : id.replace(/^session_/, "").slice(0, 8));

const shortPath = (p: string, depth = 2) => p.split("/").filter(Boolean).slice(-depth).join("/") || p;

/** Control characters other than the highlight markers would corrupt the terminal. */
const sanitize = (s: string) => s.replace(/[\x00-\x01\x04-\x1f\x7f]/g, " ");

const highlightMarkers = (s: string) => s.replaceAll("\x02", HL).replaceAll("\x03", R);

/** Fields after the visible two: source, session, cwd, ts, project. Keep in sync with PickedLine. */
function line(o: { source: string; session: string; cwd: string; ts: string; project: string; ending: string; hits?: number; text: string }) {
  const tag = TAG[o.source as SourceName] ?? o.source;
  const where = shortPath(o.cwd || o.project);
  const count = o.hits && o.hits > 1 ? ` ${DIM}×${o.hits}${R}` : "";
  const end = ENDING[o.ending] ? ` ${ENDING[o.ending]}${R}` : "";
  const head = `${tag}${R} ${DIM}${formatTimestamp(o.ts)}${R} \x1b[1;36m${where} \x1b[33m${shortId(o.session)}${R}${count}${end}`;
  return [head, o.text, o.source, o.session, o.cwd, o.ts, o.project].join("\t");
}

export const searchLine = (r: SearchResult) =>
  line({ ...r, text: highlightMarkers(sanitize(r.snippet)) });

export const sessionLine = (s: SessionRow) =>
  line({ ...s, ts: s.last_ts, text: sanitize(s.summary) || `${DIM}(no prompt)${R}` });

export interface PickedLine {
  source: SourceName;
  session: string;
  cwd: string;
}

export function parsePicked(selected: string): PickedLine | null {
  const f = selected.replace(/\n$/, "").split("\t");
  if (f.length < 7) return null;
  return { source: f[2] as SourceName, session: f[3]!, cwd: f[4]! };
}

// MARK: preview

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function highlighter(query: string): (s: string) => string {
  const terms = termsOf(query).sort((a, b) => b.length - a.length);
  if (!terms.length) return (s) => s;
  const re = new RegExp(terms.map(escapeRegExp).join("|"), "gi");
  return (s) => s.replace(re, (m) => `${HL}${m}${R}`);
}

type Entry = SessionDetail["entries"][number];

function entryText(e: Entry): string {
  return e.parts
    .map((p) => {
      if (p.type === "tool_use") return `[${p.name}] ${p.input}`;
      if (p.type === "tool_result") return `${p.isError ? "[error] " : "→ "}${p.text}`;
      if (p.type === "thinking") return `(thinking) ${p.text}`;
      return p.text;
    })
    .join("\n");
}

/** The entry a hit came from: the one at its timestamp, else the first containing every term. */
function focusIndex(entries: Entry[], ts: string, query: string): number {
  const atTs = entries.findIndex((e) => e.ts === ts);
  if (atTs >= 0) return atTs;
  const terms = termsOf(query).map((t) => t.toLowerCase());
  if (!terms.length) return entries.length - 1;
  const hit = entries.findIndex((e) => {
    const t = entryText(e).toLowerCase();
    return terms.every((term) => t.includes(term));
  });
  return hit >= 0 ? hit : entries.length - 1;
}

export function renderPreview(detail: SessionDetail, resumeCommand: string, { ts, query }: { ts: string; query: string }): string {
  const hl = highlighter(query);
  const entries = detail.entries;
  const out: string[] = [
    `\x1b[1;36m${detail.cwd || detail.project}${R}`,
    `${DIM}session: ${detail.id} (${detail.source})${R}`,
    `${DIM}resume:  ${resumeCommand}${R}`,
    "",
  ];
  const renderEntry = (e: Entry, { current, maxLines, highlight }: { current: boolean; maxLines: number; highlight: boolean }) => {
    const roleColor = e.role === "user" ? "\x1b[32m" : "\x1b[33m";
    const marker = current ? "\x1b[1;31m>>>\x1b[0m " : "    ";
    out.push(`${marker}${roleColor}${e.role.padStart(9)}${R} ${DIM}${formatTimestamp(String(e.ts ?? ""))}${R}`);
    const lines = entryText(e).split("\n").map(sanitize);
    for (const l of lines.slice(0, maxLines)) {
      const shown = l.length > 160 ? l.slice(0, 160) + "…" : l;
      out.push(`        ${highlight ? hl(shown) : shown}`);
    }
    if (lines.length > maxLines) out.push(`        ${DIM}… (${lines.length - maxLines} more lines)${R}`);
    out.push("");
  };

  if (!entries.length) return [...out, `${DIM}(no messages)${R}`].join("\n");
  const focus = focusIndex(entries, ts, query);
  const start = Math.max(0, focus - 5);
  const end = Math.min(entries.length, focus + 6);
  for (let i = start; i < end; i++) {
    renderEntry(entries[i]!, { current: i === focus, maxLines: i === focus ? 30 : 6, highlight: true });
  }

  const latestStart = Math.max(end, entries.length - 3);
  if (latestStart < entries.length) {
    out.push(`${DIM}${"─".repeat(40)}${R}`);
    if (latestStart > end) out.push(`${DIM}  … ${latestStart - end} messages omitted …${R}`);
    out.push(`${DIM}  ↓ latest in session (${entries.length} messages total)${R}`, "");
    for (let i = latestStart; i < entries.length; i++) renderEntry(entries[i]!, { current: false, maxLines: 4, highlight: false });
  }
  return out.join("\n");
}
