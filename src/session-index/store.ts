// The shared index DB. Its schema is the contract with the other readers
// (ai-session-index's Python API, kitty, web-terminal): change it only together.

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/** AI_SESSION_INDEX_DB overrides the location, as in ai-session-index. */
export function defaultDbPath(): string {
  const override = process.env.AI_SESSION_INDEX_DB;
  return override ? override.replace(/^~(?=\/|$)/, homedir()) : join(homedir(), ".cache", "ai-session-index", "index.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY, size INTEGER, mtime REAL, msg_count INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
    session TEXT PRIMARY KEY, source TEXT, cwd TEXT, path TEXT,
    first_ts TEXT, last_ts TEXT, msg_count INTEGER, summary TEXT,
    ending TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_ts DESC);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, session TEXT, source TEXT, role TEXT, ts TEXT, text TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session, ts DESC);
DROP INDEX IF EXISTS idx_messages_session;
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text, content='messages', content_rowid='id', tokenize='trigram', detail=none
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;

/** The single writer's connection: creates the schema if needed. */
export function openForWriting(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout=10000");
  db.exec(SCHEMA);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  return db;
}

/** A reader's connection. `warm` sizes caches for a long-lived server. */
export function openForReading(path: string, { warm = false } = {}): Database {
  const db = new Database(path, { readonly: true });
  db.exec("PRAGMA busy_timeout=5000");
  if (warm) {
    db.exec("PRAGMA cache_size=-65536"); // 64 MB page cache
    db.exec("PRAGMA mmap_size=268435456"); // 256 MB mmap
    db.exec("PRAGMA temp_store=MEMORY");
  }
  return db;
}
