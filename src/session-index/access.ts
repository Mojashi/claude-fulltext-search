// How a client reaches the index: through the daemon when one is serving,
// otherwise by opening the DB itself.
//
// デーモンが動いていれば HTTP で聞く。いなければ自分で DB を開き、
// 必要なら読む前に差分を取り込む。どちらでも同じ問い合わせができる。

import type { Database } from "bun:sqlite";
import { getSessionDetail, type SessionDetail } from "./detail";
import { listProjects, listSessions, searchRich, status, type Filter, type IndexStatus, type ProjectSummary, type SearchResult, type SessionRow } from "./query";
import { defaultRoots, type SessionRoots } from "./sources";
import { defaultDbPath, openForWriting } from "./store";
import { updateIndex, type UpdateResult } from "./update";

export interface SearchOptions extends Filter {
  limit?: number;
}

export interface ListOptions extends Filter {
  limit?: number;
  offset?: number;
}

/** What every client can ask of the index, wherever it lives. */
export interface IndexAccess {
  readonly via: "daemon" | "local";
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  sessions(opts?: ListOptions): Promise<SessionRow[]>;
  projects(source?: string): Promise<ProjectSummary[]>;
  session(ref: { source: string; id: string; project?: string }): Promise<SessionDetail | null>;
  status(source?: string): Promise<IndexStatus>;
  close(): void;
}

export const DEFAULT_PORT = 8095;

/** AI_SESSION_INDEX_URL overrides where the daemon is looked for, as web-terminal does. */
export const daemonUrl = (): string =>
  (process.env.AI_SESSION_INDEX_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/+$/, "");

/**
 * The daemon if it answers, else the local DB.
 * `refresh`: bring the local DB up to date before reading (ignored with a daemon, which keeps it current).
 */
export async function openIndex({
  refresh,
  onProgress,
}: {
  refresh: boolean;
  onProgress?: (msg: string) => void;
}): Promise<IndexAccess> {
  const daemon = await DaemonIndex.reach(daemonUrl());
  if (daemon) return daemon;
  return LocalIndex.open(defaultDbPath(), defaultRoots(), { refresh, onProgress });
}

// MARK: daemon

class DaemonIndex implements IndexAccess {
  readonly via = "daemon";
  private constructor(private readonly base: string) {}

  /** null when nothing answers /health quickly: the caller then reads the DB itself. */
  static async reach(base: string): Promise<DaemonIndex | null> {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) });
      return res.ok ? new DaemonIndex(base) : null;
    } catch {
      return null;
    }
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T | null> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const res = await fetch(`${this.base}${path}?${qs}`, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`index daemon ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  async search(q: string, o: SearchOptions = {}) {
    return (await this.get<{ results: SearchResult[] }>("/search", { q, ...o }))?.results ?? [];
  }
  async sessions(o: ListOptions = {}) {
    return (await this.get<{ sessions: SessionRow[] }>("/sessions", { ...o }))?.sessions ?? [];
  }
  async projects(source?: string) {
    return (await this.get<{ projects: ProjectSummary[] }>("/projects", { source }))?.projects ?? [];
  }
  async session(ref: { source: string; id: string; project?: string }) {
    return this.get<SessionDetail>("/session", ref);
  }
  async status(source?: string) {
    const st = await this.get<IndexStatus>("/status", { source });
    if (!st) throw new Error("index daemon has no /status");
    return st;
  }
  close() {}
}

// MARK: local

class LocalIndex implements IndexAccess {
  readonly via = "local";
  private constructor(
    private readonly db: Database,
    private readonly roots: SessionRoots,
  ) {}

  static open(
    dbPath: string,
    roots: SessionRoots,
    { refresh, onProgress }: { refresh: boolean; onProgress?: (msg: string) => void },
  ): LocalIndex {
    const db = openForWriting(dbPath);
    if (refresh) {
      const r: UpdateResult = updateIndex(db, dbPath, {
        roots,
        onProgress: (done, total) => onProgress?.(`${done}/${total} files`),
      });
      if (r.left > 0) onProgress?.(`stopped with ${r.left} files left (low disk space?)`);
    }
    return new LocalIndex(db, roots);
  }

  async search(q: string, o: SearchOptions = {}) {
    return searchRich(this.db, q, o);
  }
  async sessions(o: ListOptions = {}) {
    return listSessions(this.db, o);
  }
  async projects(source = "") {
    return listProjects(this.db, source);
  }
  async session(ref: { source: string; id: string; project?: string }) {
    return getSessionDetail(this.db, this.roots, ref);
  }
  async status(source = "") {
    return status(this.db, source);
  }
  close() {
    this.db.close();
  }
}
