// 対話ピッカー:
//   打つたびに索引へ問い合わせて一覧を出し直す（関連度順か新しい順、エージェント・場所・発言者で絞れる）。
//   一覧で選んでいるセッションの中身を横に出し、当たった発言から読めるようにする。
//   Enter で選んだセッションを返し、Esc で何も選ばずに終わる。

import type { IndexAccess } from "../session-index/access";
import type { SessionDetail } from "../session-index/detail";
import type { Filter, SortOrder } from "../session-index/query";
import { termsOf } from "../session-index/text";
import { LineEditor } from "./line-editor";
import { fromListing, fromSearch, isSubagent, ITEM_ROWS, itemRows, place, type Item } from "./list";
import { previewDoc, timeOf, type PreviewDoc } from "./preview";
import { fit, paint, rowCells, span, type Row } from "./styled";
import { Terminal, type Key } from "./terminal";
import { THEME } from "./theme";

export interface Picked {
  source: string;
  session: string;
  cwd: string;
}

export interface PickerOptions {
  index: IndexAccess;
  query: string;
  filter: Filter;
  /** the directory "here only" narrows to */
  here: string;
  resumeCommand: (source: string, id: string) => string;
}

export function pickSession(opts: PickerOptions): Promise<Picked | null> {
  return new Promise((resolve) => new Picker(opts, resolve).start());
}

// MARK: small scheduling vocabulary

/** Run `fn` once input has been quiet for `ms`. */
function afterQuiet(ms: number, fn: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/** Only the answer to the latest question counts: answers to superseded ones are dropped. */
function latestOnly() {
  let generation = 0;
  return () => {
    const mine = ++generation;
    return () => mine === generation;
  };
}

// MARK: filters the keys cycle through

const AGENTS = ["", "claude", "codex", "agy", "kimi"] as const;
const ROLES = ["", "user", "assistant"] as const;
const next = <T,>(xs: readonly T[], x: T) => xs[(xs.indexOf(x) + 1) % xs.length]!;

const SEARCH_LIMIT = 200;
const LIST_LIMIT = 300;

// MARK: layout

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Query on top, keys at the bottom; list and preview side by side, or stacked when narrow. */
function layout(width: number, height: number) {
  const body = { y: 2, h: Math.max(3, height - 3) };
  if (width >= 100) {
    const lw = Math.min(80, Math.max(44, Math.floor(width * 0.42)));
    return {
      list: { x: 0, y: body.y, w: lw, h: body.h },
      preview: { x: lw + 1, y: body.y, w: width - lw - 1, h: body.h },
      split: "vertical" as const,
    };
  }
  const lh = Math.max(ITEM_ROWS, Math.floor(body.h * 0.45 / ITEM_ROWS) * ITEM_ROWS);
  return {
    list: { x: 0, y: body.y, w: width, h: lh },
    preview: { x: 0, y: body.y + lh + 1, w: width, h: Math.max(1, body.h - lh - 1) },
    split: "horizontal" as const,
  };
}

const inside = (b: Box, x: number, y: number) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;

const PREVIEW_HEAD = 4;

class Picker {
  private term = new Terminal();
  private editor: LineEditor;
  private sort: SortOrder = "relevance";
  private agent: (typeof AGENTS)[number];
  private role: (typeof ROLES)[number];
  private hereOnly: boolean;

  private items: Item[] = [];
  private selected = 0;
  private listTop = 0;
  private searching = false;
  private searchError = "";
  private tookMs = 0;

  private details = new Map<string, SessionDetail | null>();
  private previewError = "";
  private doc: { key: string; doc: PreviewDoc } | null = null;
  private scroll = 0;
  /** the item whose preview scroll position was set; a new item starts at its hit */
  private scrolledFor = "";

  private newSearch = latestOnly();
  private newPreview = latestOnly();
  private searchSoon = afterQuiet(100, () => void this.search());
  private previewSoon = afterQuiet(60, () => void this.loadPreview());

  constructor(
    private readonly o: PickerOptions,
    private readonly done: (p: Picked | null) => void,
  ) {
    this.editor = new LineEditor(o.query);
    this.agent = (o.filter.source ?? "") as (typeof AGENTS)[number];
    this.role = (o.filter.role ?? "") as (typeof ROLES)[number];
    this.hereOnly = Boolean(o.filter.cwd || o.filter.project);
  }

  start() {
    this.term.enter({ key: (k) => this.onKey(k), resize: () => this.draw() });
    void this.search();
  }

  private finish(p: Picked | null) {
    this.term.leave();
    this.done(p);
  }

  // MARK: questions to the index

  private get query() {
    return this.editor.text.trim();
  }

  private get filter(): Filter {
    const where = this.hereOnly ? (this.o.filter.cwd || this.o.filter.project ? { cwd: this.o.filter.cwd, project: this.o.filter.project } : { cwd: this.o.here }) : {};
    return { source: this.agent, role: this.role, ...where };
  }

  private async search() {
    const stillLatest = this.newSearch();
    this.searching = true;
    this.draw();
    const started = performance.now();
    try {
      const items = this.query
        ? (await this.o.index.search(this.query, { ...this.filter, sort: this.sort, limit: SEARCH_LIMIT })).map(fromSearch)
        : // A subagent's session cannot be resumed on its own: the listing leaves them out, search keeps them (ranked low).
          (await this.o.index.sessions({ ...this.filter, limit: LIST_LIMIT })).map(fromListing).filter((it) => !isSubagent(it));
      if (!stillLatest()) return;
      this.items = items;
      this.searchError = "";
      this.listTop = 0;
      this.select(0);
    } catch (e) {
      if (!stillLatest()) return;
      this.items = [];
      this.searchError = e instanceof Error ? e.message : String(e);
    }
    this.tookMs = performance.now() - started;
    this.searching = false;
    this.previewSoon();
    this.draw();
  }

  private get current(): Item | undefined {
    return this.items[this.selected];
  }

  private async loadPreview() {
    const it = this.current;
    if (!it) return this.draw();
    const key = `${it.source}:${it.session}`;
    if (!this.details.has(key)) {
      const stillLatest = this.newPreview();
      try {
        const detail = await this.o.index.session({ source: it.source, id: it.session, project: it.project });
        this.details.set(key, detail);
        if (this.details.size > 40) this.details.delete(this.details.keys().next().value!);
        this.previewError = "";
      } catch (e) {
        this.previewError = e instanceof Error ? e.message : String(e);
      }
      if (!stillLatest()) return;
    }
    this.draw();
  }

  // MARK: keys

  private onKey(k: Key) {
    if (k.kind === "char") return this.edit(() => this.editor.insert(k.ch));
    if (k.kind === "paste") return this.edit(() => this.editor.insert(k.text));
    if (k.kind === "mouse") return this.onMouse(k);

    const { name, ctrl, shift, alt } = k;
    if (name === "escape" || (ctrl && (name === "c" || name === "g"))) return this.finish(null);
    if (name === "enter") return this.pick();
    if ((name === "up" || name === "down") && (shift || alt)) return this.scrollPreview(name === "up" ? -3 : 3);
    if ((name === "pageup" || name === "pagedown") && (shift || alt)) return this.scrollPreview((name === "pageup" ? -1 : 1) * this.previewPage);
    if (name === "up" || (ctrl && name === "p")) return this.select(this.selected - 1);
    if (name === "down" || (ctrl && name === "n")) return this.select(this.selected + 1);
    if (name === "pageup") return this.select(this.selected - this.visibleItems);
    if (name === "pagedown") return this.select(this.selected + this.visibleItems);
    if (name === "tab") return this.jumpToMatch(shift ? -1 : 1);
    if (ctrl && name === "s") return this.refilter(() => (this.sort = next(["relevance", "recent"] as const, this.sort)));
    if (ctrl && name === "t") return this.refilter(() => (this.agent = next(AGENTS, this.agent)));
    if (ctrl && name === "r") return this.refilter(() => (this.role = next(ROLES, this.role)));
    if (ctrl && name === "o") return this.refilter(() => (this.hereOnly = !this.hereOnly));

    const e = this.editor;
    if (name === "backspace") return this.edit(() => (alt ? e.deleteWord() : e.backspace()));
    if (name === "delete" || (ctrl && name === "d")) return this.edit(() => e.delete());
    if (ctrl && name === "w") return this.edit(() => e.deleteWord());
    if (ctrl && name === "u") return this.edit(() => e.killToStart());
    if (ctrl && name === "k") return this.edit(() => e.killToEnd());
    if (name === "left" || (ctrl && name === "b")) return this.move(() => e.left());
    if (name === "right" || (ctrl && name === "f")) return this.move(() => e.right());
    if (name === "home" || (ctrl && name === "a")) return this.move(() => e.home());
    if (name === "end" || (ctrl && name === "e")) return this.move(() => e.end());
  }

  private onMouse(k: Extract<Key, { kind: "mouse" }>) {
    const { list, preview } = this.layout;
    if (inside(preview, k.x, k.y) && k.action !== "press") return this.scrollPreview(k.action === "wheel-up" ? -3 : 3);
    if (!inside(list, k.x, k.y)) return;
    if (k.action === "wheel-up") return this.select(this.selected - 1);
    if (k.action === "wheel-down") return this.select(this.selected + 1);
    const i = this.listTop + Math.floor((k.y - list.y) / ITEM_ROWS);
    if (i >= this.items.length) return;
    if (i === this.selected) return this.pick();
    this.select(i);
  }

  private edit(change: () => void) {
    const before = this.editor.text;
    change();
    if (this.editor.text !== before) this.searchSoon();
    this.draw();
  }

  private move(change: () => void) {
    change();
    this.draw();
  }

  private refilter(change: () => void) {
    change();
    void this.search();
  }

  private select(i: number) {
    const was = this.current;
    this.selected = Math.max(0, Math.min(this.items.length - 1, i));
    if (this.selected < this.listTop) this.listTop = this.selected;
    if (this.selected >= this.listTop + this.visibleItems) this.listTop = this.selected - this.visibleItems + 1;
    if (this.current !== was) this.previewSoon();
    this.draw();
  }

  private pick() {
    const it = this.current;
    if (it) this.finish({ source: it.source, session: it.session, cwd: it.cwd });
  }

  // MARK: preview scrolling

  private get previewPage() {
    return Math.max(1, this.layout.preview.h - PREVIEW_HEAD - 1);
  }

  private scrollPreview(by: number) {
    this.scroll += by;
    this.draw();
  }

  /** Scroll so the next (or previous) matching message is at the top. */
  private jumpToMatch(dir: 1 | -1) {
    const matches = this.doc?.doc.matches ?? [];
    const top = this.scroll + 1;
    const target = dir > 0 ? matches.find((m) => m > top) : matches.findLast((m) => m < top);
    if (target === undefined) return;
    this.scroll = Math.max(0, target - 1);
    this.draw();
  }

  // MARK: drawing

  private get layout() {
    return layout(this.term.size.width, this.term.size.height);
  }

  private get visibleItems() {
    return Math.max(1, Math.floor(this.layout.list.h / ITEM_ROWS));
  }

  private draw() {
    const { width, height } = this.term.size;
    const lay = this.layout;
    const screen: Row[] = Array.from({ length: height }, () => []);
    const put = (b: Box, rows: Row[], base = "") => {
      for (let i = 0; i < b.h; i++) screen[b.y + i]!.push(span(paint(fit(rows[i] ?? [], b.w), base)));
    };

    const input = this.inputRow(width);
    screen[0] = [span(paint(input.row))];
    screen[1] = [span(paint([span("─".repeat(width), THEME.faint)]))];

    if (lay.split === "vertical") {
      const listRows = this.listRows(lay.list.w);
      const previewRows = this.previewRows(lay.preview.w, lay.preview.h);
      for (let i = 0; i < lay.list.h; i++) {
        const y = lay.list.y + i;
        screen[y] = [
          span(paint(fit(listRows[i]?.row ?? [], lay.list.w), listRows[i]?.selected ? THEME.selected : "")),
          span(paint([span("│", THEME.faint)])),
          span(paint(fit(previewRows[i] ?? [], lay.preview.w))),
        ];
      }
    } else {
      const listRows = this.listRows(lay.list.w);
      for (let i = 0; i < lay.list.h; i++) {
        screen[lay.list.y + i] = [span(paint(fit(listRows[i]?.row ?? [], lay.list.w), listRows[i]?.selected ? THEME.selected : ""))];
      }
      screen[lay.list.y + lay.list.h] = [span(paint([span("─".repeat(width), THEME.faint)]))];
      put(lay.preview, this.previewRows(lay.preview.w, lay.preview.h));
    }
    screen[height - 1] = [span(paint(fit(this.footer(), width)))];

    // Rows are already painted; joining their text gives the frame.
    this.term.draw(
      screen.map((r) => r.map((s) => s.text).join("")),
      { x: input.cursorX, y: 0 },
    );
  }

  /** The query with the terminal cursor (and so the IME) placed in it, and the search state on the right. */
  private inputRow(width: number): { row: Row; cursorX: number } {
    const status = this.statusSpans();
    const room = Math.max(10, width - 3 - rowCells(status) - 2);
    const view = this.editor.view(room);
    return { row: [span(" ❯ ", THEME.accent + ";1"), ...fit([span(view.text)], room), span("  "), ...status], cursorX: 3 + view.cursorX };
  }

  private statusSpans(): Row {
    const sep = span(" · ", THEME.faint);
    const parts: Row[] = [
      [span(this.query ? (this.sort === "relevance" ? "best match" : "newest") : "latest sessions", THEME.accent)],
      [span(this.agent || "all agents", this.agent ? THEME.agent(this.agent).style : THEME.quiet)],
      ...(this.hereOnly ? [[span(`in ${this.o.filter.project || place({ cwd: this.o.filter.cwd || this.o.here, project: "" })}`, THEME.path)]] : []),
      ...(this.role ? [[span(`${this.role} said`, THEME.role(this.role))]] : []),
      [span(this.searching ? "searching…" : `${this.items.length}${this.items.length >= (this.query ? SEARCH_LIMIT : LIST_LIMIT) ? "+" : ""}`, THEME.quiet)],
    ];
    return [...parts.flatMap((p, i) => (i ? [sep, ...p] : p)), span(" ")];
  }

  private listRows(width: number): { row: Row; selected: boolean }[] {
    if (this.searchError) return [{ row: [span(" error: ", THEME.error + ";1"), span(this.searchError, THEME.error)], selected: false }];
    if (!this.items.length && !this.searching) {
      const why = this.query ? "No session says all of these words." : "No sessions here.";
      return [{ row: [], selected: false }, { row: [span(`   ${why}`, THEME.quiet)], selected: false }];
    }
    const out: { row: Row; selected: boolean }[] = [];
    for (let i = this.listTop; i < Math.min(this.items.length, this.listTop + this.visibleItems); i++) {
      const selected = i === this.selected;
      for (const row of itemRows(this.items[i]!, width, { selected })) out.push({ row, selected });
    }
    return out;
  }

  private previewRows(width: number, height: number): Row[] {
    const it = this.current;
    if (!it) return [];
    const key = `${it.source}:${it.session}`;
    const head: Row[] = [
      [span(" "), span(it.cwd || it.project, THEME.path)],
      [span(" "), span(THEME.agent(it.source).tag.trim(), THEME.agent(it.source).style), span(`  ${it.session}`, THEME.faint)],
      [span(" $ ", THEME.faint), span(this.o.resumeCommand(it.source, it.session), THEME.quiet)],
    ];
    if (!this.details.has(key)) return [...head, [], [span(this.previewError ? ` ${this.previewError}` : "  loading…", this.previewError ? THEME.error : THEME.faint)]];
    const detail = this.details.get(key);
    if (!detail) return [...head, [], [span("  The session file is gone.", THEME.quiet)]];

    const docKey = `${key}|${width}|${this.query}`;
    if (this.doc?.key !== docKey) this.doc = { key: docKey, doc: previewDoc(detail, { width, terms: termsOf(this.query), ts: it.ts }) };
    const doc = this.doc.doc;
    if (this.scrolledFor !== key) {
      this.scrolledFor = key;
      this.scroll = Math.max(0, doc.focus - 1);
    }
    const view = height - PREVIEW_HEAD;
    this.scroll = Math.max(0, Math.min(this.scroll, doc.rows.length - view));

    const first = detail.entries[0]?.ts;
    const last = detail.entries.at(-1)?.ts;
    head[1]!.push(span(`  ${timeOf(first)} → ${timeOf(last)} · ${detail.entries.length} messages`, THEME.quiet));
    const matchNo = doc.matches.filter((m) => m <= this.scroll + 1).length;
    const where = doc.matches.length ? `match ${Math.max(1, matchNo)}/${doc.matches.length}  ` : "";
    const pct = doc.rows.length > view ? `${Math.round((100 * (this.scroll + view)) / doc.rows.length)}%` : "all";
    const rule = `${where}${pct} `;
    head.push([span("─".repeat(Math.max(0, width - rule.length - 1)) + " ", THEME.faint), span(rule, THEME.quiet)]);
    return [...head, ...doc.rows.slice(this.scroll, this.scroll + view)];
  }

  private footer(): Row {
    const keys: [string, string][] = [
      ["⏎", "resume"], ["↑↓", "select"], ["⇧↑↓", "scroll"], ["tab", "next match"],
      ["^s", "sort"], ["^t", "agent"], ["^o", "here"], ["^r", "role"], ["esc", "quit"],
    ];
    const row: Row = [span(" ")];
    for (const [k, what] of keys) row.push(span(k, THEME.accent), span(` ${what}  `, THEME.faint));
    const via = `${this.o.index.via}${this.tookMs ? ` ${Math.round(this.tookMs)}ms` : ""} `;
    return [...fit(row, Math.max(0, this.term.size.width - via.length)), span(via, THEME.faint)];
  }
}
