// Reading the index: full-text search, session / project listings, status.

import type { Database } from "bun:sqlite";
import { homedir } from "os";
import { basename, dirname } from "path";
import { cpLength, isoToMs, makeSnippet, termsOf } from "./text";

/** A message that matched, with the session it belongs to. One per session. */
export interface Hit {
  session: string;
  source: string;
  cwd: string;
  role: string;
  ts: string;
  text: string;
  summary: string;
  msg_count: number;
  /** matching messages in this session */
  hits: number;
  ending: string;
  path: string;
}

export interface Filter {
  source?: string;
  /** substring of the session's cwd */
  cwd?: string;
  /** project name (Claude's project dir name, or a cwd substring) */
  project?: string;
  /** only messages by this role (search only; listings are per session) */
  role?: string;
}

// MARK: projects

export function formatProjectName(rawPath: string): string {
  if (!rawPath) return "default";
  const home = homedir();
  let rel = rawPath;
  if (home && rel.startsWith(home)) rel = rel.slice(home.length).replace(/^\/+/, "");
  return rel || basename(rawPath) || "default";
}

/** Claude groups sessions by its own project directory; others by cwd. */
export function projectOf(source: string, cwd: string, path = ""): string {
  if (source === "claude" && path) {
    const parent = basename(dirname(path));
    if (parent) return parent;
  }
  return formatProjectName(cwd);
}

// MARK: search

/** Messages newer than this many rows back are scanned when no term is long enough for FTS. */
const RECENT_SCAN_ROWS = 150_000;

const quoteFts = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** FTS5 trigram query matching any text that contains `term`. */
function trigramMatch(term: string): string {
  const cps = Array.from(term);
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= cps.length; i++) grams.add(cps.slice(i, i + 3).join(""));
  return [...grams].map(quoteFts).join(" AND ");
}

const likeArg = (term: string) => "%" + term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_") + "%";

/** SQL conditions for a Filter on the sessions table aliased as `s`. */
function filterSql(f: Filter, sessionAlias: string, messageAlias = sessionAlias): [string, unknown[]] {
  let sql = "";
  const args: unknown[] = [];
  if (f.source) {
    sql += ` AND ${messageAlias}.source = ?`;
    args.push(f.source);
  }
  if (f.role && messageAlias !== sessionAlias) {
    sql += ` AND ${messageAlias}.role = ?`;
    args.push(f.role);
  }
  if (f.cwd) {
    sql += ` AND ${sessionAlias}.cwd LIKE ?`;
    args.push(`%${f.cwd}%`);
  }
  if (f.project) {
    sql += ` AND (${sessionAlias}.cwd LIKE ? OR ${sessionAlias}.path LIKE ?)`;
    args.push(`%${f.project}%`, `%/${f.project}/%`);
  }
  return [sql, args];
}

const HIT_COLUMNS = `m.session, m.source, COALESCE(s.cwd,'') AS cwd, m.role, m.ts, m.text,
  COALESCE(s.summary,'') AS summary, COALESCE(s.msg_count,0) AS msg_count, 1 AS hits,
  COALESCE(s.ending,'') AS ending, COALESCE(s.path,'') AS path`;

/**
 * Sessions containing every term of `query`, most recently active first.
 * Terms of 3+ characters go through the trigram index; every term is then
 * confirmed with LIKE. With no terms, the most recent sessions are listed.
 */
export function search(db: Database, query: string, { limit = 200, ...filter }: Filter & { limit?: number } = {}): Hit[] {
  query = query.trim();
  if (!query && !filter.cwd && !filter.project) return [];
  const terms = termsOf(query);
  if (terms.length === 0) return recentSessions(db, filter, limit);

  const indexable = terms.filter((t) => cpLength(t) >= 3);
  let sql: string;
  const args: unknown[] = [];
  if (indexable.length === 0) {
    const floor = db
      .query("SELECT ts FROM messages WHERE ts != '' ORDER BY ts DESC LIMIT 1 OFFSET ?")
      .get(RECENT_SCAN_ROWS) as { ts: string } | null;
    sql = `SELECT ${HIT_COLUMNS} FROM messages m LEFT JOIN sessions s ON s.session = m.session WHERE m.ts > ?`;
    args.push(floor?.ts ?? "");
  } else {
    sql = `SELECT ${HIT_COLUMNS} FROM messages_fts f JOIN messages m ON m.id = f.rowid
           LEFT JOIN sessions s ON s.session = m.session WHERE messages_fts MATCH ?`;
    args.push(indexable.map(trigramMatch).join(" AND "));
  }
  for (const t of terms) {
    sql += " AND m.text LIKE ? ESCAPE '\\'";
    args.push(likeArg(t));
  }
  const [fsql, fargs] = filterSql(filter, "s", "m");
  sql += fsql + " ORDER BY m.ts DESC LIMIT ?";
  args.push(...fargs, Math.max(limit * 40, 2000));

  return onePerSession(db.query(sql).all(...(args as any[])) as Hit[], limit);
}

/** The newest hit of each session, counting how many hits each session had. */
function onePerSession(rows: Hit[], limit: number): Hit[] {
  const best = new Map<string, Hit>();
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.session, (counts.get(r.session) ?? 0) + 1);
    if (!best.has(r.session)) {
      best.set(r.session, r);
      if (best.size >= limit) break;
    }
  }
  return [...best.values()].map((h) => ({ ...h, hits: counts.get(h.session)! }));
}

function recentSessions(db: Database, filter: Filter, limit: number): Hit[] {
  const [fsql, fargs] = filterSql(filter, "sessions");
  const rows = db
    .query(
      `SELECT session, source, cwd, summary, msg_count, ending, last_ts, path FROM sessions
       WHERE 1=1${fsql} ORDER BY last_ts DESC LIMIT ?`,
    )
    .all(...(fargs as any[]), limit) as any[];
  const latestOf = db.query("SELECT role, ts, text FROM messages WHERE session = ? ORDER BY ts DESC LIMIT 1");
  return rows.map((r) => {
    const latest = latestOf.get(r.session) as { role: string; ts: string; text: string } | null;
    return {
      session: r.session,
      source: r.source ?? "",
      cwd: r.cwd ?? "",
      role: latest?.role ?? "",
      ts: latest?.ts || r.last_ts || "",
      text: latest?.text ?? "",
      summary: r.summary ?? "",
      msg_count: r.msg_count ?? 0,
      hits: 1,
      ending: r.ending ?? "",
      path: r.path ?? "",
    };
  });
}

/** A search hit as the HTTP API returns it: with project, snippet and epoch ms. */
export interface SearchResult extends Hit {
  id: string;
  project: string;
  /** text around the first matched term, terms wrapped in \x02..\x03 */
  snippet: string;
  mtime: number;
  modified: number;
}

export function searchRich(db: Database, query: string, opts: Filter & { limit?: number } = {}): SearchResult[] {
  const terms = termsOf(query.trim());
  return search(db, query, opts).map((h) => {
    const ms = isoToMs(h.ts);
    return {
      id: h.session,
      ...h,
      project: projectOf(h.source, h.cwd, h.path),
      snippet: makeSnippet(h.text, terms),
      mtime: ms,
      modified: ms,
    };
  });
}

// MARK: listings

export interface SessionRow {
  id: string;
  session: string;
  source: string;
  project: string;
  cwd: string;
  summary: string;
  modified: number;
  mtime: number;
  first_ts: string;
  last_ts: string;
  msg_count: number;
  ending: string;
  path: string;
}

export function listSessions(
  db: Database,
  { limit = 30, offset = 0, ...filter }: Filter & { limit?: number; offset?: number } = {},
): SessionRow[] {
  const [fsql, fargs] = filterSql(filter, "sessions");
  const rows = db
    .query(
      `SELECT session, source, cwd, path, first_ts, last_ts, msg_count, summary, ending FROM sessions
       WHERE 1=1${fsql} ORDER BY last_ts DESC LIMIT ? OFFSET ?`,
    )
    .all(...(fargs as any[]), limit, offset) as any[];
  return rows.map((r) => {
    const ms = isoToMs(r.last_ts || r.first_ts || "");
    return {
      id: r.session,
      session: r.session,
      source: r.source ?? "",
      project: projectOf(r.source ?? "", r.cwd ?? "", r.path ?? ""),
      cwd: r.cwd ?? "",
      summary: r.summary ?? "",
      modified: ms,
      mtime: ms,
      first_ts: r.first_ts ?? "",
      last_ts: r.last_ts ?? "",
      msg_count: r.msg_count ?? 0,
      ending: r.ending ?? "",
      path: r.path ?? "",
    };
  });
}

export interface ProjectSummary {
  project: string;
  cwd: string;
  count: number;
  mtime: number;
}

/** Projects with their session counts, most recently active first. */
export function listProjects(db: Database, source = ""): ProjectSummary[] {
  const rows = (
    source
      ? db.query("SELECT source, cwd, path, last_ts FROM sessions WHERE source = ?").all(source)
      : db.query("SELECT source, cwd, path, last_ts FROM sessions").all()
  ) as any[];
  const agg = new Map<string, ProjectSummary>();
  for (const r of rows) {
    const project = projectOf(r.source ?? "", r.cwd ?? "", r.path ?? "");
    const ms = isoToMs(r.last_ts ?? "");
    const cur = agg.get(project);
    if (!cur) {
      agg.set(project, { project, cwd: r.cwd ?? "", count: 1, mtime: ms });
    } else {
      cur.count++;
      if (ms > cur.mtime) {
        cur.mtime = ms;
        if (r.cwd) cur.cwd = r.cwd;
      }
    }
  }
  return [...agg.values()].sort((a, b) => b.mtime - a.mtime);
}

export interface PrefixMatch {
  id: string;
  source: string;
  project: string;
  cwd: string;
  summary: string;
  modified: number;
}

/** The most recent session whose id starts with `prefix`. */
export function findByPrefix(db: Database, prefix: string, source = ""): PrefixMatch | null {
  const safe = prefix.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) return null;
  const r = db
    .query(
      `SELECT session, source, cwd, path, summary, last_ts FROM sessions
       WHERE (session LIKE ? OR session LIKE ?)${source ? " AND source = ?" : ""}
       ORDER BY last_ts DESC LIMIT 1`,
    )
    .get(...([`${safe}%`, `session_${safe}%`, ...(source ? [source] : [])] as any[])) as any;
  if (!r) return null;
  return {
    id: r.session,
    source: r.source ?? "",
    project: projectOf(r.source ?? "", r.cwd ?? "", r.path ?? ""),
    cwd: r.cwd ?? "",
    summary: r.summary ?? "",
    modified: isoToMs(r.last_ts ?? ""),
  };
}

export interface IndexStatus {
  sessions: number;
  messages: number;
  by_source: Record<string, { sessions: number; messages: number }>;
}

export function status(db: Database, source = ""): IndexStatus {
  const bySource: IndexStatus["by_source"] = {};
  for (const r of db
    .query("SELECT source, COUNT(*) AS s, COALESCE(SUM(msg_count), 0) AS m FROM sessions GROUP BY source")
    .all() as any[]) {
    bySource[r.source || "unknown"] = { sessions: r.s, messages: r.m };
  }
  const picked = source ? [bySource[source] ?? { sessions: 0, messages: 0 }] : Object.values(bySource);
  return {
    sessions: picked.reduce((n, v) => n + v.sessions, 0),
    messages: picked.reduce((n, v) => n + v.messages, 0),
    by_source: bySource,
  };
}
