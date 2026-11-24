import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  findByPrefix, getSessionDetail, listProjects, listSessions, openForWriting,
  search, searchRich, status, updateIndex, type SessionRoots,
} from ".";
import { shlexSplit, termsOf } from "./text";

const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r) + "\n").join("");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "session-index-"));
  const roots: SessionRoots = {
    claude: join(dir, "claude"), codex: join(dir, "codex"), agy: join(dir, "agy"), kimi: join(dir, "kimi"),
  };
  const dbPath = join(dir, "index.db");
  const db = openForWriting(dbPath);
  return { dir, roots, dbPath, db, update: () => updateIndex(db, dbPath, { roots, minFreeBytes: 0 }) };
}

describe("session index", () => {
  test("indexes Claude sessions and finds them by Japanese substring, prefix and HTTP-shaped results", () => {
    const f = fixture();
    const proj = join(f.roots.claude, "-Users-test-myproj");
    mkdirSync(proj, { recursive: true });
    const fp = join(proj, "abcd1234-5678.jsonl");
    writeFileSync(fp, jsonl(
      { type: "user", cwd: "/Users/test/myproj", timestamp: "2026-11-22T09:00:00Z", message: { role: "user", content: "セッション検索の切り出しテスト" } },
      { type: "assistant", cwd: "/Users/test/myproj", timestamp: "2026-11-22T09:00:05Z", message: { role: "assistant", content: "strip layout works great" } },
    ));

    expect(f.update()).toEqual({ done: 1, left: 0 });
    expect(search(f.db, "セッション 検索").map((h) => h.session)).toEqual(["abcd1234-5678"]);
    expect(findByPrefix(f.db, "abcd1234", "claude")?.id).toBe("abcd1234-5678");
    expect(listSessions(f.db, { source: "claude" }).map((s) => [s.id, s.summary, s.ending])).toEqual([
      ["abcd1234-5678", "セッション検索の切り出しテスト", ""],
    ]);
    expect(listProjects(f.db)[0]).toMatchObject({ project: "-Users-test-myproj", count: 1 });
    expect(searchRich(f.db, "strip", { source: "claude" })[0]!.snippet).toContain("\x02strip\x03");
    expect(getSessionDetail(f.db, f.roots, { source: "claude", id: "abcd1234-5678" })!.entries).toHaveLength(2);

    // Nothing changed → nothing re-read.
    expect(f.update()).toEqual({ done: 0, left: 0 });

    // Appended lines are read from where the last run stopped, not re-inserted.
    appendFileSync(fp, jsonl({ type: "user", timestamp: "2026-11-22T09:01:00Z", message: { role: "user", content: "続きの質問" } }));
    expect(f.update()).toEqual({ done: 1, left: 0 });
    expect(status(f.db)).toMatchObject({ sessions: 1, messages: 3 });
    expect(listSessions(f.db)[0]).toMatchObject({ ending: "cut", last_ts: "2026-11-22T09:01:00Z" });
  });

  test("short terms fall back to a LIKE scan; every term must match", () => {
    const f = fixture();
    const proj = join(f.roots.claude, "p");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "s1.jsonl"), jsonl({ timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "go vet ./..." } }));
    writeFileSync(join(proj, "s2.jsonl"), jsonl({ timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "go build" } }));
    f.update();
    expect(search(f.db, "go").map((h) => h.session).sort()).toEqual(["s1", "s2"]);
    expect(search(f.db, "go vet").map((h) => h.session)).toEqual(["s1"]);
  });

  test("reads Codex, Antigravity and Kimi sessions", () => {
    const f = fixture();
    const sid = "019a0000-0000-7000-8000-000000000001";
    mkdirSync(join(f.roots.codex, "2026", "11", "24"), { recursive: true });
    writeFileSync(join(f.roots.codex, "2026", "11", "24", `rollout-2026-11-24T00-00-00-${sid}.jsonl`), jsonl(
      { type: "session_meta", timestamp: "2026-11-24T00:00:00Z", payload: { id: sid, cwd: "/w/codexproj" } },
      { type: "response_item", timestamp: "2026-11-24T00:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codexで検索" }] } },
      { type: "response_item", timestamp: "2026-11-24T00:00:02Z", payload: { type: "function_call", name: "shell" } },
    ));

    const agyLog = join(f.roots.agy, "agy-1", ".system_generated", "logs");
    mkdirSync(agyLog, { recursive: true });
    writeFileSync(join(agyLog, "transcript.jsonl"), jsonl(
      { type: "USER_INPUT", created_at: "2026-11-24T01:00:00Z", content: "<USER_REQUEST>agyで検索</USER_REQUEST>" },
      { type: "PLANNER_RESPONSE", created_at: "2026-11-24T01:00:01Z", content: "ok", tool_calls: [{ name: "run", args: { Cwd: "/w/agyproj" } }] },
      { type: "RUN_COMMAND", source: "MODEL", created_at: "2026-11-24T01:00:02Z", content: "boom", status: "ERROR" },
    ));

    const kimiSession = join(f.roots.kimi, "ws1", "kimi-1");
    mkdirSync(join(kimiSession, "agents", "main"), { recursive: true });
    writeFileSync(join(kimiSession, "state.json"), JSON.stringify({ cwd: "/w/kimiproj" }));
    writeFileSync(join(kimiSession, "agents", "main", "wire.jsonl"), jsonl(
      { type: "agent.message.appended", time: 1763946000000, message: { message: { role: "user", content: [{ type: "text", text: "kimiで検索" }] } } },
      { type: "agent.message.appended", time: 1763946001000, message: { message: { role: "assistant", content: [{ type: "text", text: "trying" }], toolCalls: [{ name: "Bash" }] } } },
      { type: "agent.turn.ended", outcome: "failed" },
    ));

    expect(f.update()).toEqual({ done: 3, left: 0 });
    const bySource = Object.fromEntries(listSessions(f.db).map((s) => [s.source, s]));
    expect(bySource.codex).toMatchObject({ id: sid, cwd: "/w/codexproj", msg_count: 1, ending: "cut" });
    expect(bySource.agy).toMatchObject({ id: "agy-1", cwd: "/w/agyproj", msg_count: 3, ending: "error", summary: "agyで検索" });
    expect(bySource.kimi).toMatchObject({ id: "kimi-1", cwd: "/w/kimiproj", msg_count: 2, ending: "error", last_ts: "2025-11-24T01:00:01.000Z" });
    expect(search(f.db, "で検索").map((h) => h.source).sort()).toEqual(["agy", "codex", "kimi"]);
    expect(search(f.db, "[Bash]")[0]!.text).toBe("trying [Bash]");

    const agyDetail = getSessionDetail(f.db, f.roots, { source: "agy", id: "agy-1" })!;
    expect(agyDetail.entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(agyDetail.entries[1]!.parts.map((p) => p.type)).toEqual(["text", "tool_use", "tool_result"]);
  });
});

describe("query terms", () => {
  test("follow Python shlex.split", () => {
    expect(shlexSplit(`a "b c" 'd e' f\\ g`)).toEqual(["a", "b c", "d e", "f g"]);
    expect(shlexSplit(`x"y z"w`)).toEqual(["xy zw"]);
    expect(shlexSplit(`"a\\"b" "c\\d"`)).toEqual(['a"b', "c\\d"]);
    expect(() => shlexSplit(`"open`)).toThrow();
  });
  test("fall back to whitespace split on unbalanced quotes", () => {
    expect(termsOf(`"open quote`)).toEqual(["open", "quote"]);
    expect(termsOf(`foo ""`)).toEqual(["foo"]);
  });
});

describe("daemon", () => {
  test("serves the ai-session-index HTTP API, and clients use it when it answers", async () => {
    const { serve } = await import("./server");
    const { openIndex } = await import("./access");
    const f = fixture();
    const proj = join(f.roots.claude, "-Users-test-myproj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "abcd1234-5678.jsonl"), jsonl(
      { type: "user", cwd: "/Users/test/myproj", timestamp: "2026-11-22T09:00:00Z", message: { role: "user", content: "セッション検索の切り出しテスト" } },
      { type: "assistant", cwd: "/Users/test/myproj", timestamp: "2026-11-22T09:00:05Z", message: { role: "assistant", content: "strip layout works great" } },
    ));
    f.update();

    const server = serve({
      host: "127.0.0.1", port: 0, dbPath: f.dbPath, roots: f.roots, intervalSec: 3600,
      indexCommand: ["echo", '{"done":0,"left":0}'],
    });
    const base = `http://127.0.0.1:${server.port}`;
    const get = async (p: string) => (await fetch(base + p)).json() as Promise<any>;
    try {
      expect((await get("/health")).ok).toBe(true);
      expect((await get("/sessions?source=claude")).sessions.map((s: any) => s.id)).toEqual(["abcd1234-5678"]);
      expect((await get("/search?q=strip&source=claude")).results[0].snippet).toContain("\x02strip\x03");
      expect((await get("/search?q=strip&role=user")).results).toEqual([]);
      expect((await get("/session?source=claude&id=abcd1234-5678")).entries).toHaveLength(2);
      expect((await get("/prefix?prefix=abcd")).session.id).toBe("abcd1234-5678");
      expect(await get("/status")).toMatchObject({ sessions: 1, messages: 2, state: "idle" });
      expect((await fetch(base + "/nope")).status).toBe(404);

      process.env.AI_SESSION_INDEX_URL = base;
      const viaDaemon = await openIndex({ refresh: false });
      expect(viaDaemon.via).toBe("daemon");
      expect((await viaDaemon.search("セッション")).map((r) => r.id)).toEqual(["abcd1234-5678"]);
    } finally {
      server.stop(true);
    }

    // Nothing answering → the DB is opened directly.
    process.env.AI_SESSION_INDEX_URL = base;
    process.env.AI_SESSION_INDEX_DB = f.dbPath;
    const local = await openIndex({ refresh: false });
    expect(local.via).toBe("local");
    expect((await local.search("セッション")).map((r) => r.id)).toEqual(["abcd1234-5678"]);
    local.close();
    delete process.env.AI_SESSION_INDEX_URL;
    delete process.env.AI_SESSION_INDEX_DB;
  });
});
