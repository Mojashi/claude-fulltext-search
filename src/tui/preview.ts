// A session laid out for the preview pane: every message as wrapped rows, the
// messages that match marked in the gutter, and where to start reading.

import type { Entry, Part, SessionDetail } from "../session-index/detail";
import { isRecord } from "../session-index/text";
import { highlight, printable, span, wrap, type Row, type Span, type Style } from "./styled";
import { THEME } from "./theme";

export interface PreviewDoc {
  rows: Row[];
  /** first row of each matching message */
  matches: number[];
  /** first row of the message the hit came from */
  focus: number;
}

const entryText = (e: Entry) =>
  e.parts.map((p) => (p.type === "tool_use" ? `${p.name} ${p.input}` : p.text)).join("\n");

/** How many rows a part may take: the matching message is shown in full, the rest briefly. */
function rowsFor(p: Part, role: string, matching: boolean): number {
  if (p.type === "tool_use" || p.type === "thinking") return matching ? 6 : 1;
  if (p.type === "tool_result") return matching ? 8 : 1;
  return matching ? 80 : role === "user" ? 10 : 6;
}

/** The argument that says what a tool call did (its command, file, pattern...), else all of them briefly. */
const TELLING_ARGS = ["command", "file_path", "path", "pattern", "query", "url", "description", "prompt", "skill"];
function toolInput(input: string): string {
  let args: unknown;
  try {
    args = JSON.parse(input);
  } catch {
    return input; // cut short by the reader, or not JSON
  }
  if (!isRecord(args)) return input;
  const telling = TELLING_ARGS.find((k) => typeof args[k] === "string");
  if (telling) return String(args[telling]);
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ");
}

/** Claude files tool results under the user: a message holding nothing else is the tool speaking. */
function speaker(e: Entry): string {
  if (e.isMeta) return "system";
  if (e.parts.every((p) => p.type === "tool_result")) return "tool";
  return e.role;
}

function partSpans(p: Part, terms: string[]): Span[] {
  const hl = (text: string, style: Style) => highlight(printable(text), terms, style, THEME.match);
  switch (p.type) {
    case "text":
      return hl(p.text, "");
    case "thinking":
      return [span("thinking ", THEME.label), ...hl(p.text, THEME.quiet)];
    case "tool_use":
      return [span(`⚙ ${p.name} `, THEME.tool), ...hl(toolInput(p.input), THEME.quiet)];
    case "tool_result":
      return [span(p.isError ? "✗ " : "↳ ", p.isError ? THEME.error : THEME.quiet), ...hl(p.text, p.isError ? THEME.error : THEME.quiet)];
  }
}

export const timeOf = (ts: unknown) => {
  const d = new Date(String(ts ?? ""));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
};

export function previewDoc(detail: SessionDetail, { width, terms, ts }: { width: number; terms: string[]; ts: string }): PreviewDoc {
  const lowered = terms.map((t) => t.toLowerCase());
  const matchesAll = (e: Entry) => {
    if (!lowered.length) return false;
    const text = entryText(e).toLowerCase();
    return lowered.every((t) => text.includes(t));
  };
  const rows: Row[] = [];
  const matches: number[] = [];
  let focus = -1;
  const inner = Math.max(10, width - 4);

  for (const e of detail.entries) {
    const matching = matchesAll(e);
    const gutter = span(matching ? "▌" : " ", THEME.gutter);
    const start = rows.length;
    if (matching) matches.push(start);
    if (focus < 0 && ts && String(e.ts ?? "") === ts) focus = start;

    const who = speaker(e);
    rows.push([gutter, span(" ● ", THEME.role(who)), span(who, THEME.role(who) + ";1"), span(`  ${timeOf(e.ts)}`, THEME.quiet)]);
    for (const p of e.isMeta ? e.parts.slice(0, 1) : e.parts) {
      const { rows: body, cut } = wrap(partSpans(p, terms), inner, e.isMeta ? 1 : rowsFor(p, e.role, matching));
      for (const r of body) rows.push([gutter, span("   "), ...r]);
      // A one-row glimpse of a tool needs no mark that it was cut; longer text does.
      if (cut && (matching || p.type === "text")) rows.push([gutter, span("   …", THEME.quiet)]);
    }
    rows.push([]);
  }
  if (focus < 0) focus = matches[0] ?? Math.max(0, rows.length - 1);
  return { rows, matches, focus };
}
