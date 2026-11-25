import { describe, expect, test } from "bun:test";
import { messageScore, sessionScore } from "../session-index/rank";
import { LineEditor } from "./line-editor";
import { cells, fit, rowCells, span, wrap } from "./styled";
import { parseKeys } from "./terminal";

describe("keys", () => {
  test("arrows, modifiers, ctrl letters, paste and mouse", () => {
    expect(parseKeys("\x1b[A\x1b[1;2B\x1bOC")).toEqual([
      { kind: "key", name: "up" },
      { kind: "key", name: "down", shift: true, alt: false, ctrl: false },
      { kind: "key", name: "right" },
    ]);
    expect(parseKeys("\x13\x7f\r\t\x1b[Z")).toEqual([
      { kind: "key", name: "s", ctrl: true },
      { kind: "key", name: "backspace" },
      { kind: "key", name: "enter" },
      { kind: "key", name: "tab" },
      { kind: "key", name: "tab", shift: true },
    ]);
    expect(parseKeys("\x1b[200~a\nb\x1b[201~日")).toEqual([
      { kind: "paste", text: "a\nb" },
      { kind: "char", ch: "日" },
    ]);
    expect(parseKeys("\x1b[<64;10;5M\x1b[<0;3;4M\x1b[<0;3;4m")).toEqual([
      { kind: "mouse", action: "wheel-up", x: 9, y: 4 },
      { kind: "mouse", action: "press", x: 2, y: 3 },
    ]);
    expect(parseKeys("\x1b")).toEqual([{ kind: "key", name: "escape" }]);
  });
});

describe("styled text", () => {
  test("Japanese takes two cells; fit cuts with an ellipsis and pads exactly", () => {
    expect(cells("検索ab")).toBe(6);
    const row = fit([span("セッション検索")], 9);
    expect(rowCells(row)).toBe(9);
    expect(row.map((s) => s.text).join("")).toBe("セッショ…");
    expect(rowCells(fit([span("ab")], 5))).toBe(5);
  });

  test("wrap breaks between words, splits long ones, and stops at maxRows", () => {
    const text = (rows: ReturnType<typeof wrap>["rows"]) => rows.map((r) => r.map((s) => s.text).join(""));
    expect(text(wrap([span("hello world foo")], 11).rows)).toEqual(["hello world", "foo"]);
    expect(text(wrap([span("日本語のテキスト")], 6).rows)).toEqual(["日本語", "のテキ", "スト"]);
    expect(text(wrap([span("abcdefghij")], 4).rows)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrap([span("a\nb\nc")], 10, 2)).toMatchObject({ cut: true });
    for (const r of wrap([span("混在 mixed テキスト text")], 7).rows) expect(rowCells(r)).toBeLessThanOrEqual(7);
  });
});

describe("query line", () => {
  test("keeps the cursor in view when the query is longer than the room", () => {
    const e = new LineEditor("0123456789abcdef");
    const v = e.view(8);
    expect(v.text.startsWith("…")).toBe(true);
    expect(v.cursorX).toBeLessThanOrEqual(7);
    e.home();
    expect(e.view(8)).toEqual({ text: "0123456789abcdef", cursorX: 0 });
    e.end();
    e.deleteWord();
    expect(e.text).toBe("");
  });
});

describe("relevance", () => {
  test("a whole word beats a word glued into an identifier; phrases beat scattered words; users beat tools", () => {
    expect(messageScore("fix the strip layout", "user", ["strip"])).toBeGreaterThan(messageScore("stripped_value", "user", ["strip"]));
    expect(messageScore("the strip layout broke", "user", ["strip", "layout"])).toBeGreaterThan(
      messageScore(`strip ${"x ".repeat(100)} layout`, "user", ["strip", "layout"]),
    );
    expect(messageScore("strip layout", "user", ["strip"])).toBeGreaterThan(messageScore("strip layout", "tool", ["strip"]));
    expect(messageScore("nothing here", "user", ["strip"])).toBe(0);
  });

  test("sessions: more hits, the ask, recency raise it; a subagent lowers it", () => {
    const now = Date.parse("2026-11-25T00:00:00Z");
    const base = { best: 2, hits: 1, summary: "", cwd: "/x", ts: "2026-11-24T00:00:00Z", path: "/p/a.jsonl" };
    const score = (o: Partial<typeof base>) => sessionScore({ ...base, ...o }, ["strip"], now);
    expect(score({ hits: 10 })).toBeGreaterThan(score({}));
    expect(score({ summary: "fix strip" })).toBeGreaterThan(score({}));
    expect(score({})).toBeGreaterThan(score({ ts: "2025-11-24T00:00:00Z" }));
    expect(score({ path: "/p/a/subagents/agent-1.jsonl" })).toBeLessThan(score({}));
  });
});
