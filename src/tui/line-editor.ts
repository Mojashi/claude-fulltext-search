// The query being typed, with a cursor and the usual readline keys.

import { cells, graphemes } from "./styled";

export class LineEditor {
  private chars: string[];
  private at: number;

  constructor(text = "") {
    this.chars = graphemes(text);
    this.at = this.chars.length;
  }

  get text() {
    return this.chars.join("");
  }

  /** What fits in `room` cells with the cursor in view: the head is dropped (and marked) when it does not fit. */
  view(room: number): { text: string; cursorX: number } {
    let from = 0;
    const before = () => cells((from ? "…" : "") + this.chars.slice(from, this.at).join(""));
    while (from < this.at && before() > room - 1) from++;
    return { text: (from ? "…" : "") + this.chars.slice(from).join(""), cursorX: before() };
  }

  insert(s: string) {
    const add = graphemes(s.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, ""));
    this.chars.splice(this.at, 0, ...add);
    this.at += add.length;
  }

  backspace() {
    if (this.at > 0) this.chars.splice(--this.at, 1);
  }
  delete() {
    this.chars.splice(this.at, 1);
  }
  left() {
    this.at = Math.max(0, this.at - 1);
  }
  right() {
    this.at = Math.min(this.chars.length, this.at + 1);
  }
  home() {
    this.at = 0;
  }
  end() {
    this.at = this.chars.length;
  }
  killToStart() {
    this.chars.splice(0, this.at);
    this.at = 0;
  }
  killToEnd() {
    this.chars.splice(this.at);
  }
  /** Delete back to the start of the previous word. */
  deleteWord() {
    let i = this.at;
    while (i > 0 && this.chars[i - 1] === " ") i--;
    while (i > 0 && this.chars[i - 1] !== " ") i--;
    this.chars.splice(i, this.at - i);
    this.at = i;
  }
}
