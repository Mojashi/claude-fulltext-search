// The index daemon: a local HTTP API over the shared DB, plus a periodic indexer.
// Endpoints and response shapes are those of ai-session-index, which web-terminal uses.
//
// 一定間隔でインデックスを更新しつつ、読む側には HTTP で答える。
// 更新は子プロセスで走らせるので、取り込み中も問い合わせは待たされない。

import type { Database } from "bun:sqlite";
import { getSessionDetail } from "./detail";
import { findByPrefix, listProjects, listSessions, searchRich, status } from "./query";
import type { SessionRoots } from "./sources";
import { openForWriting } from "./store";

export interface ServeOptions {
  host: string;
  port: number;
  dbPath: string;
  roots: SessionRoots;
  /** seconds between index runs */
  intervalSec: number;
  /** argv that brings the index up to date once and prints {"done","left"} as JSON */
  indexCommand: string[];
}

export function serve(opts: ServeOptions) {
  // Held open for the server's lifetime: it creates the schema, and keeps the
  // WAL's shared memory alive between index runs.
  const db = openForWriting(opts.dbPath);
  db.exec("PRAGMA cache_size=-65536");
  db.exec("PRAGMA mmap_size=268435456");
  db.exec("PRAGMA temp_store=MEMORY");

  const indexer = new PeriodicIndexer(opts.indexCommand, opts.intervalSec);
  const startedAt = Date.now();
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch: (req) => route(req, { db, roots: opts.roots, indexer, dbPath: opts.dbPath, startedAt }),
  });
  indexer.start();

  const stop = () => {
    indexer.stop();
    server.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.stderr.write(`[claude-search] index daemon on http://${opts.host}:${server.port} (db=${opts.dbPath}, interval=${opts.intervalSec}s)\n`);
  return server;
}

// MARK: indexer

class PeriodicIndexer {
  state: "idle" | "indexing" = "idle";
  lastUpdate: number | null = null;
  lastDone = 0;
  lastLeft = 0;
  lastDurationMs = 0;
  error: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly command: string[],
    private readonly intervalSec: number,
  ) {}

  start() {
    // A short delay so the HTTP side is answering before the first heavy run.
    this.schedule(2_000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Run now instead of waiting for the next tick (no-op while one is running). */
  trigger() {
    if (this.state === "idle") this.schedule(0);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runOnce(), ms);
  }

  private async runOnce() {
    if (this.state === "indexing") return;
    this.state = "indexing";
    this.error = null;
    const t0 = performance.now();
    try {
      const proc = Bun.spawn(this.command, { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new Error(`index exited ${code}: ${err.trim().slice(-300)}`);
      const { done, left } = JSON.parse(out) as { done: number; left: number };
      this.lastDone = done;
      this.lastLeft = left;
      this.lastUpdate = Date.now();
      this.lastDurationMs = Math.round(performance.now() - t0);
      if (done > 0) process.stderr.write(`[indexer] indexed ${done} files (${left} left) in ${this.lastDurationMs}ms\n`);
    } catch (e) {
      this.error = String(e instanceof Error ? e.message : e);
      process.stderr.write(`[indexer] error: ${this.error}\n`);
    } finally {
      this.state = "idle";
      this.schedule(Math.max(10, this.intervalSec) * 1000);
    }
  }

  toJSON() {
    return {
      state: this.state,
      last_update: this.lastUpdate,
      last_done: this.lastDone,
      last_left: this.lastLeft,
      last_duration_ms: this.lastDurationMs,
      error: this.error,
    };
  }
}

// MARK: routes

interface Ctx {
  db: Database;
  roots: SessionRoots;
  indexer: PeriodicIndexer;
  dbPath: string;
  startedAt: number;
}

const json = (payload: unknown, statusCode = 200) =>
  new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

function intParam(qs: URLSearchParams, key: string, dflt: number, lo: number, hi: number): number {
  const raw = qs.get(key);
  if (!raw) return dflt;
  const v = Number.parseInt(raw, 10);
  return Number.isNaN(v) ? dflt : Math.max(lo, Math.min(hi, v));
}

function route(req: Request, ctx: Ctx): Response {
  const url = new URL(req.url);
  const qs = url.searchParams;
  const p = (k: string) => qs.get(k) ?? "";
  const uptime_s = Math.floor((Date.now() - ctx.startedAt) / 1000);

  try {
    if (req.method === "POST") {
      if (url.pathname !== "/reindex") return json({ error: "not found" }, 404);
      ctx.indexer.trigger();
      return json({ ok: true, state: ctx.indexer.state });
    }
    switch (url.pathname) {
      case "/health":
        return json({ ok: true, db_path: ctx.dbPath, uptime_s });
      case "/status":
        return json({ ...status(ctx.db, p("source")), db_path: ctx.dbPath, ...ctx.indexer.toJSON(), uptime_s });
      case "/sessions":
        return json({
          sessions: listSessions(ctx.db, {
            source: p("source"), project: p("project"), cwd: p("cwd"),
            limit: intParam(qs, "limit", 30, 1, 500), offset: intParam(qs, "offset", 0, 0, 100_000),
          }),
        });
      case "/projects":
        return json({ projects: listProjects(ctx.db, p("source")) });
      case "/search":
        return json({
          results: searchRich(ctx.db, p("q"), {
            source: p("source"), project: p("project"), cwd: p("cwd"), role: p("role"),
            limit: intParam(qs, "limit", 200, 1, 500),
          }),
        });
      case "/session": {
        if (!p("id")) return json({ error: "missing id" }, 400);
        const detail = getSessionDetail(ctx.db, ctx.roots, { source: p("source"), id: p("id"), project: p("project") });
        return detail ? json(detail) : json({ error: "not found" }, 404);
      }
      case "/prefix":
        return json({ session: p("prefix") ? findByPrefix(ctx.db, p("prefix"), p("source")) : null });
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
}
