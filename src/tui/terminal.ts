// The terminal as a full-screen app sees it: keys and mouse in, whole frames out.
// Entering takes over the screen (alternate buffer, raw input, mouse); leaving
// gives it back exactly as it was, also when the process is interrupted.

export type Key =
  | { kind: "char"; ch: string }
  | { kind: "paste"; text: string }
  | { kind: "key"; name: KeyName; ctrl?: boolean; shift?: boolean; alt?: boolean }
  | { kind: "mouse"; action: "press" | "wheel-up" | "wheel-down"; x: number; y: number };

export type KeyName =
  | "up" | "down" | "left" | "right" | "home" | "end" | "pageup" | "pagedown"
  | "enter" | "escape" | "tab" | "backspace" | "delete"
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "k" | "l" | "n" | "o" | "p" | "r" | "s" | "t" | "u" | "w" | "y";

const ARROWS: Record<string, KeyName> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const TILDE: Record<string, KeyName> = { "1": "home", "7": "home", "4": "end", "8": "end", "3": "delete", "5": "pageup", "6": "pagedown" };
const CTRL_LETTERS = "abcdefghklnoprstuwy";

/** xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4). */
const modifiers = (m: number) => ({ shift: Boolean((m - 1) & 1), alt: Boolean((m - 1) & 2), ctrl: Boolean((m - 1) & 4) });

/** Decode one chunk of raw input into keys. */
export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < data.length) {
    const rest = data.slice(i);
    let m: RegExpMatchArray | null;
    if (rest.startsWith("\x1b[200~")) {
      const end = rest.indexOf("\x1b[201~");
      const text = end < 0 ? rest.slice(6) : rest.slice(6, end);
      keys.push({ kind: "paste", text });
      i += end < 0 ? rest.length : end + 6;
    } else if ((m = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/))) {
      const b = Number(m[1]);
      const at = { x: Number(m[2]) - 1, y: Number(m[3]) - 1 };
      if (b === 64) keys.push({ kind: "mouse", action: "wheel-up", ...at });
      else if (b === 65) keys.push({ kind: "mouse", action: "wheel-down", ...at });
      else if (b === 0 && m[4] === "M") keys.push({ kind: "mouse", action: "press", ...at });
      i += m[0].length;
    } else if ((m = rest.match(/^\x1b\[(?:1;(\d+))?([ABCDHF])/)) || (m = rest.match(/^\x1bO()([ABCDHF])/))) {
      keys.push({ kind: "key", name: ARROWS[m[2]!]!, ...(m[1] ? modifiers(Number(m[1])) : {}) });
      i += m[0].length;
    } else if ((m = rest.match(/^\x1b\[(\d+)(?:;(\d+))?~/))) {
      const name = TILDE[m[1]!];
      if (name) keys.push({ kind: "key", name, ...(m[2] ? modifiers(Number(m[2])) : {}) });
      i += m[0].length;
    } else if (rest.startsWith("\x1b[Z")) {
      keys.push({ kind: "key", name: "tab", shift: true });
      i += 3;
    } else if ((m = rest.match(/^\x1b\[[0-9;?]*[ -\/]*[@-~]/))) {
      i += m[0].length; // a sequence we do not use
    } else if (rest === "\x1b" || rest.startsWith("\x1b\x1b")) {
      keys.push({ kind: "key", name: "escape" });
      i += 1;
    } else if (rest.startsWith("\x1b\x7f") || rest.startsWith("\x1b\b")) {
      keys.push({ kind: "key", name: "backspace", alt: true });
      i += 2;
    } else if (rest[0] === "\x1b") {
      i += 1; // alt+char: not used
      const ch = Array.from(rest.slice(1))[0];
      if (ch) i += ch.length;
    } else {
      const ch = Array.from(rest)[0]!;
      i += ch.length;
      const code = ch.charCodeAt(0);
      if (ch === "\r" || ch === "\n") keys.push({ kind: "key", name: "enter" });
      else if (ch === "\t") keys.push({ kind: "key", name: "tab" });
      else if (ch === "\x7f" || ch === "\b") keys.push({ kind: "key", name: "backspace" });
      else if (code >= 1 && code <= 26) {
        const letter = String.fromCharCode(code + 96);
        if (CTRL_LETTERS.includes(letter)) keys.push({ kind: "key", name: letter as KeyName, ctrl: true });
      } else if (code >= 0x20) keys.push({ kind: "char", ch });
    }
  }
  return keys;
}

const ENTER = "\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?25l";
const LEAVE = "\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l";

export class Terminal {
  private onData?: (d: Buffer) => void;
  private onResize?: () => void;
  private active = false;

  get size() {
    return { width: process.stdout.columns || 80, height: process.stdout.rows || 24 };
  }

  enter(handlers: { key: (k: Key) => void; resize: () => void }) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("the picker needs a terminal (stdin and stdout must be a TTY)");
    this.active = true;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    this.onData = (d) => parseKeys(d.toString("utf-8")).forEach(handlers.key);
    this.onResize = handlers.resize;
    process.stdin.on("data", this.onData);
    process.stdout.on("resize", this.onResize);
    process.on("exit", this.restore);
    process.stdout.write(ENTER);
  }

  /** Draw a whole frame: one string per screen row, and where the text cursor goes. */
  draw(rows: string[], cursor: { x: number; y: number } | null) {
    const out =
      "\x1b[?2026h\x1b[H" +
      rows.map((r) => r + "\x1b[K").join("\r\n") +
      "\x1b[J" +
      (cursor ? `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h` : "\x1b[?25l") +
      "\x1b[?2026l";
    process.stdout.write(out);
  }

  leave() {
    if (this.onData) process.stdin.off("data", this.onData);
    if (this.onResize) process.stdout.off("resize", this.onResize);
    process.off("exit", this.restore);
    this.restore();
    process.stdin.pause();
  }

  private restore = () => {
    if (!this.active) return;
    this.active = false;
    process.stdout.write(LEAVE);
    process.stdin.setRawMode(false);
  };
}
