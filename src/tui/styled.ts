// Styled text measured in terminal cells: spans of text with an SGR style,
// laid out into rows of an exact width. Japanese and emoji take two cells.

/** SGR parameters, e.g. "1;36". Empty for the default style. */
export type Style = string;
export interface Span {
  text: string;
  style?: Style;
}
export type Row = Span[];

export const span = (text: string, style: Style = ""): Span => ({ text, style });

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** The characters of `s` as the terminal draws them (grapheme clusters). */
export function graphemes(s: string): string[] {
  if (PRINTABLE_ASCII.test(s)) return s.split("");
  return Array.from(segmenter.segment(s), (g) => g.segment);
}

export const cells = (s: string): number => (PRINTABLE_ASCII.test(s) ? s.length : Bun.stringWidth(s));

export const rowCells = (row: Row): number => row.reduce((n, s) => n + cells(s.text), 0);

/** Control characters would move the cursor or change modes: they are shown as spaces. */
export const printable = (s: string): string => s.replace(/[\x00-\x08\x0b-\x1f\x7f\x9b]/g, " ").replace(/\t/g, "  ");

/** `row` cut or padded to exactly `width` cells. A cut is marked with an ellipsis. */
export function fit(row: Row, width: number, padStyle: Style = ""): Row {
  const out: Row = [];
  let used = 0;
  const total = rowCells(row);
  const budget = total > width ? width - 1 : width;
  for (const s of row) {
    if (used >= budget) break;
    const w = cells(s.text);
    if (used + w <= budget) {
      out.push(s);
      used += w;
      continue;
    }
    let text = "";
    for (const g of graphemes(s.text)) {
      const gw = cells(g);
      if (used + gw > budget) break;
      text += g;
      used += gw;
    }
    out.push({ text, style: s.style });
    break;
  }
  if (total > width) {
    out.push(span("…", "2"));
    used++;
  }
  if (used < width) out.push(span(" ".repeat(width - used), padStyle));
  return out;
}

/** Words to lay out: runs of non-space ASCII stay together, other characters break anywhere. */
function tokens(text: string): string[] {
  return text.match(/[\x21-\x7e]+| +|[^\x20-\x7e]/gu) ?? [];
}

/**
 * Lay `spans` out into rows of at most `width` cells, breaking between words
 * where it can. Newlines start a new row. Stops after `maxRows` rows, and
 * reports whether anything was left out.
 */
export function wrap(spans: Span[], width: number, maxRows = Infinity): { rows: Row[]; cut: boolean } {
  const rows: Row[] = [];
  let row: Row = [];
  let used = 0;
  const newRow = () => {
    rows.push(row);
    row = [];
    used = 0;
    return rows.length < maxRows;
  };
  const put = (text: string, style: Style | undefined, w: number) => {
    const last = row.at(-1);
    if (last && last.style === style) last.text += text;
    else row.push({ text, style });
    used += w;
  };
  for (const s of spans) {
    const lines = s.text.split("\n");
    for (let li = 0; li < lines.length; li++) {
      if (li > 0 && !newRow()) return { rows, cut: true };
      for (const tok of tokens(lines[li]!)) {
        const w = cells(tok);
        if (used + w <= width) {
          put(tok, s.style, w);
          continue;
        }
        if (tok.startsWith(" ")) {
          if (!newRow()) return { rows, cut: true };
          continue;
        }
        if (w <= width && used > 0) {
          if (!newRow()) return { rows, cut: true };
          put(tok, s.style, w);
          continue;
        }
        for (const g of graphemes(tok)) {
          const gw = cells(g);
          if (used + gw > width && !newRow()) return { rows, cut: true };
          put(g, s.style, gw);
        }
      }
    }
  }
  if (row.length || rows.length === 0) rows.push(row);
  return { rows, cut: false };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` in `style`, with every occurrence of the terms in `hl`. */
export function highlight(text: string, terms: string[], style: Style, hl: Style): Span[] {
  if (!terms.length) return [span(text, style)];
  const re = new RegExp([...terms].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"), "giu");
  const out: Span[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push(span(text.slice(at, m.index), style));
    out.push(span(m[0], hl));
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(span(text.slice(at), style));
  return out;
}

/** A row as terminal output. `base` (e.g. a selection background) applies under every span. */
export function paint(row: Row, base: Style = ""): string {
  let out = "";
  for (const s of row) {
    const sgr = [base, s.style].filter(Boolean).join(";");
    out += `\x1b[0${sgr ? ";" + sgr : ""}m${s.text}`;
  }
  return out + "\x1b[0m";
}
