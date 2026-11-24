// Incremental indexing.
//
// 各エージェントのセッションファイルを見つけ、前回から変わったものだけを新しい順に、
// 前回読み終えた行の続きから読んで、メッセージを追記し、セッションの要約を更新する。
// 時間の予算を使い切るか、ディスクの空きが少なくなったら、そこで止める（続きは次回）。

import type { Database } from "bun:sqlite";
import { statfsSync, statSync } from "fs";
import { dirname } from "path";
import { ALL_SOURCES, type IndexedMessage, type SessionFile, type SessionRoots, type SessionSource } from "./sources";
import { collapseWhitespace, cpSlice, isBoilerplate } from "./text";

export interface UpdateOptions {
  roots: SessionRoots;
  sources?: readonly SessionSource[];
  /** Stop after this long; the rest is picked up next time. 0 = no limit. */
  budgetMs?: number;
  /** Stop when the DB's disk has less free space than this. Default 3 GiB. */
  minFreeBytes?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface UpdateResult {
  done: number;
  left: number;
}

export function updateIndex(db: Database, dbPath: string, opts: UpdateOptions): UpdateResult {
  const sources = opts.sources ?? ALL_SOURCES;
  const queue = newestFirst(changedSince(db, sources.flatMap((s) => s.discover(opts.roots))));
  const shouldStop = stopWhenAny(timeBudget(opts.budgetMs ?? 0), diskNearlyFull(dirname(dbPath), opts.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES));

  let done = 0;
  for (const file of queue) {
    if (shouldStop(done)) break;
    const messages = readNewMessages(sources, file);
    if (!messages) continue;
    if (record(db, file, messages)) done++;
    if (done % 500 === 0) opts.onProgress?.(done, queue.length);
  }
  return { done, left: queue.length - done };
}

// MARK: what to read

/** A session file whose size or mtime moved since it was last indexed. */
interface ChangedFile extends SessionFile {
  size: number;
  /** seconds, as Python's st_mtime — the files table is shared with ai-session-index */
  mtime: number;
  /** first line not yet indexed */
  fromLine: number;
}

function changedSince(db: Database, files: SessionFile[]): ChangedFile[] {
  const known = new Map<string, { size: number; mtime: number; msg_count: number }>();
  for (const row of db.query("SELECT path, size, mtime, msg_count FROM files").all() as any[]) {
    known.set(row.path, row);
  }
  const changed: ChangedFile[] = [];
  for (const f of files) {
    let st;
    try {
      st = statSync(f.path);
    } catch {
      continue; // vanished between discovery and stat
    }
    const mtime = st.mtimeMs / 1000;
    const prev = known.get(f.path);
    if (prev && prev.size === st.size && Math.abs(prev.mtime - mtime) < 0.001) continue;
    changed.push({ ...f, size: st.size, mtime, fromLine: prev?.msg_count ?? 0 });
  }
  return changed;
}

/** Newest first, so recent sessions are searchable right away on a fresh build. */
const newestFirst = (files: ChangedFile[]) => [...files].sort((a, b) => b.mtime - a.mtime);

function readNewMessages(sources: readonly SessionSource[], file: ChangedFile): IndexedMessage[] | null {
  const source = sources.find((s) => s.name === file.source)!;
  try {
    return source.read(file.path, file.fromLine);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code) return null; // I/O error: retry on the next run
    throw e;
  }
}

// MARK: when to stop

type StopCondition = (done: number) => boolean;

const stopWhenAny =
  (...conds: StopCondition[]): StopCondition =>
  (done) =>
    conds.some((c) => c(done));

function timeBudget(ms: number): StopCondition {
  const started = performance.now();
  return () => ms > 0 && performance.now() - started > ms;
}

const DEFAULT_MIN_FREE_BYTES = 3 * 1024 ** 3;

/** Checked every 200 files: statfs is cheap but not free. */
function diskNearlyFull(dir: string, minFreeBytes: number): StopCondition {
  return (done) => {
    if (done % 200 !== 0) return false;
    try {
      const st = statfsSync(dir);
      return st.bavail * st.bsize < minFreeBytes;
    } catch {
      return false;
    }
  };
}

// MARK: what to write

const DELIBERATE_STOP = ["<turn_aborted>", "[Request interrupted by user"];

/** How the session's last turn ended, judged from its last message. */
function endingOf(last: IndexedMessage | undefined): "error" | "stopped" | "cut" | "" {
  if (!last) return "";
  if (last.isError) return "error";
  if (DELIBERATE_STOP.some((m) => last.text.includes(m))) return "stopped";
  if (last.role === "user" && !isBoilerplate(last.text)) return "cut";
  return "";
}

/** The first thing the user actually typed. */
function summaryOf(messages: IndexedMessage[]): string {
  const first = messages.find((m) => m.role === "user" && !isBoilerplate(m.text));
  return first ? cpSlice(collapseWhitespace(first.text), 200) : "";
}

/** Store what was read. False when another writer got to this file first. */
function record(db: Database, file: ChangedFile, messages: IndexedMessage[]): boolean {
  const insertMessage = db.prepare("INSERT INTO messages(session, source, role, ts, text) VALUES (?,?,?,?,?)");
  const timestamps = messages.map((m) => m.ts).filter(Boolean);
  const cwd = messages.reduce((acc, m) => m.cwd || acc, "");
  const last = messages.at(-1);

  return db.transaction(() => {
    // Another writer (a CLI run while no daemon is up) may have taken this file
    // since we planned; inserting our copy would duplicate its messages.
    const now = db.query("SELECT msg_count FROM files WHERE path = ?").get(file.path) as { msg_count: number } | null;
    if ((now?.msg_count ?? 0) !== file.fromLine) return false;
    for (const m of messages) insertMessage.run(file.session, file.source, m.role, m.ts, m.text);
    db.query(
      `INSERT INTO sessions(session, source, cwd, path, first_ts, last_ts, msg_count, summary, ending)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session) DO UPDATE SET
         cwd=COALESCE(NULLIF(excluded.cwd,''), sessions.cwd),
         last_ts=COALESCE(NULLIF(excluded.last_ts,''), sessions.last_ts),
         msg_count=COALESCE(sessions.msg_count,0) + excluded.msg_count,
         summary=COALESCE(NULLIF(sessions.summary,''), excluded.summary),
         ending=CASE WHEN excluded.path = sessions.path THEN excluded.ending
                     ELSE sessions.ending END`,
    ).run(
      file.session, file.source, cwd, file.path,
      timestamps[0] ?? "", timestamps.at(-1) ?? "",
      messages.length, summaryOf(messages), endingOf(last),
    );
    db.query("INSERT OR REPLACE INTO files(path, size, mtime, msg_count) VALUES (?,?,?,?)").run(
      file.path, file.size, file.mtime, last ? last.line + 1 : file.fromLine,
    );
    return true;
  }).immediate();
}

/**
 * Drop duplicate message rows (same session, ts and text) that racing writers
 * left behind, and recount each session's messages. Returns how many rows went.
 */
export function dedupe(db: Database): number {
  const count = () => (db.query("SELECT count(*) AS n FROM messages").get() as { n: number }).n;
  const before = count();
  db.transaction(() => {
    db.exec("DELETE FROM messages WHERE id NOT IN (SELECT min(id) FROM messages GROUP BY session, ts, text)");
    db.exec("UPDATE sessions SET msg_count = (SELECT count(*) FROM messages m WHERE m.session = sessions.session)");
  }).immediate();
  return before - count();
}
