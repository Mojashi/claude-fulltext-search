// The result list: one session per item, three rows each —
// who and where, what was asked, and the words that matched.

import type { SearchResult, SessionRow } from "../session-index/query";
import { fit, printable, span, type Row } from "./styled";
import { THEME } from "./theme";

export interface Item {
  source: string;
  session: string;
  cwd: string;
  project: string;
  path: string;
  /** when the matched message was said, or when the session was last active */
  ts: string;
  lastTs: string;
  summary: string;
  /** the matched text with terms in \x02..\x03, or null for a plain listing */
  snippet: string | null;
  hits: number;
  msgCount: number;
  ending: string;
}

export const ITEM_ROWS = 3;

export const fromSearch = (r: SearchResult): Item => ({
  source: r.source, session: r.session, cwd: r.cwd, project: r.project, path: r.path,
  ts: r.ts, lastTs: r.last_ts, summary: r.summary, snippet: r.snippet, hits: r.hits, msgCount: r.msg_count, ending: r.ending,
});

export const fromListing = (s: SessionRow): Item => ({
  source: s.source, session: s.session, cwd: s.cwd, project: s.project, path: s.path,
  ts: s.last_ts, lastTs: s.last_ts, summary: s.summary, snippet: null, hits: 0, msgCount: s.msg_count, ending: s.ending,
});

export function ago(ts: string, now = Date.now()): string {
  const at = Date.parse(ts);
  if (Number.isNaN(at)) return "";
  const min = Math.max(0, (now - at) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${Math.floor(min)}m ago`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}h ago`;
  if (min < 60 * 24 * 14) return `${Math.floor(min / 60 / 24)}d ago`;
  const d = new Date(at);
  return d.getFullYear() === new Date(now).getFullYear()
    ? d.toLocaleDateString("en-US", { month: "short", day: "2-digit" })
    : d.toISOString().slice(0, 10);
}

/** Where a session ran, as the last two directories of its cwd. */
export const place = (it: Pick<Item, "cwd" | "project">) => {
  const p = it.cwd || it.project;
  return p.split("/").filter(Boolean).slice(-2).join("/") || p;
};

/** UUIDv7 ids (Codex) start with a timestamp, so their head is shared by sessions started together. */
export const shortId = (id: string) => (/^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(id) ? id.slice(-8) : id.replace(/^session_/, "").slice(0, 8));

export const isSubagent = (it: Pick<Item, "path">) => it.path.includes("/subagents/");

/** A session that spoke minutes ago and "ended mid-turn" is most likely still working. */
const stillRunning = (it: Item) => it.ending === "cut" && Date.now() - Date.parse(it.lastTs) < 15 * 60_000;

/** A snippet's text with its \x02..\x03 marked terms highlighted. */
const snippetSpans = (snippet: string) =>
  snippet
    .split(/(\x02[^\x03]*\x03)/)
    .filter(Boolean)
    .map((part) => (part.startsWith("\x02") ? span(printable(part.slice(1, -1)), THEME.match) : span(printable(part), THEME.quiet)));

/** The three rows of an item, each exactly `width` cells. */
export function itemRows(it: Item, width: number, { selected }: { selected: boolean }): Row[] {
  const agent = THEME.agent(it.source);
  const marker = span(selected ? "▌" : " ", THEME.marker);
  const id = shortId(it.session);
  const ending = stillRunning(it) ? undefined : THEME.ending[it.ending];
  const right: Row = [
    ...(it.hits > 1 ? [span(`×${it.hits} `, THEME.quiet)] : []),
    ...(ending ? [span(`${ending.mark} `, ending.style)] : []),
    span(id, THEME.faint),
  ];
  const rightW = right.reduce((n, s) => n + s.text.length, 0) + 1;
  const left: Row = [
    marker,
    span(` ${agent.tag} `, agent.style + ";1"),
    span(ago(it.ts).padEnd(8), THEME.quiet),
    span(place(it), THEME.path),
    ...(isSubagent(it) ? [span(" subagent", THEME.faint)] : []),
  ];
  const head = [...fit(left, Math.max(10, width - rightW)), span(" "), ...right];

  const ask = printable(it.summary.replace(/\s+/g, " ").trim());
  const second: Row = [marker, span("   "), ask ? span(ask, THEME.summary) : span("(no prompt)", THEME.faint)];
  const third: Row = [
    marker,
    span("   "),
    ...(it.snippet !== null
      ? snippetSpans(it.snippet)
      : [span(`${it.msgCount} messages`, THEME.faint)]),
  ];
  return [fit(head, width), fit(second, width), fit(third, width)];
}
