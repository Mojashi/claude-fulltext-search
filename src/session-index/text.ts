// Text helpers that reproduce Python's string semantics, so that the TS indexer
// writes exactly the same rows as ai-session-index (core.py) into the shared DB.

// Characters Python's str.isspace() treats as whitespace (str.split() / strip()).
const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_WS_RUN = new RegExp(`[${PY_WS}]+`, "g");
const PY_WS_LEAD = new RegExp(`^[${PY_WS}]+`);
const PY_WS_TRAIL = new RegExp(`[${PY_WS}]+$`);

export const pyStrip = (s: string): string => s.replace(PY_WS_LEAD, "").replace(PY_WS_TRAIL, "");
export const pyLstrip = (s: string): string => s.replace(PY_WS_LEAD, "");

/** `' '.join(s.split())` */
export const collapseWhitespace = (s: string): string => pyStrip(s).replace(PY_WS_RUN, " ");

/** Number of code points (Python len). */
export function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** First n code points (Python s[:n]). */
export function cpSlice(s: string, n: number): string {
  if (s.length <= n) return s;
  let count = 0;
  let end = 0;
  for (const ch of s) {
    if (count === n) break;
    end += ch.length;
    count++;
  }
  return s.slice(0, end);
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Python `x or ''` for values that are expected to be strings. */
export const str = (v: unknown): string => (typeof v === "string" ? v : v ? String(v) : "");

/** Message content in any of the agents' shapes, flattened to plain text. */
export function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (isRecord(content)) {
    for (const key of ["text", "content", "input", "output"]) {
      if (key in content) return flatten(content[key]);
    }
    return "";
  }
  if (Array.isArray(content)) return content.map(flatten).filter(Boolean).join("\n");
  if (content === null || content === undefined || typeof content === "boolean") return "";
  return String(content);
}

const BOILERPLATE = [
  "<recommended_plugins", "<environment_context", "<permissions", "<user_instructions",
  "# AGENTS.md", "<system-reminder", "Caveat: The messages below", "<command-name>",
  "<local-command", "<ide_", "Analyze this codebase", "[Recent context]",
  "Caveat:", "<command-message>", "DO NOT respond to these messages",
];

/** Harness-injected text that is not something the user actually typed. */
export function isBoilerplate(text: string): boolean {
  const head = cpSlice(pyLstrip(text), 400);
  return BOILERPLATE.some((marker) => head.includes(marker));
}

/** Python shlex.split (POSIX mode). Throws on an unclosed quote or trailing escape. */
export function shlexSplit(input: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else token += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\") {
        if (i + 1 >= input.length) throw new Error("No closing quotation");
        const next = input[++i]!;
        token += next === '"' || next === "\\" ? next : "\\" + next;
      } else token += ch;
    } else if (" \t\r\n".includes(ch)) {
      if (inToken) tokens.push(token);
      token = "";
      inToken = false;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
    } else if (ch === "\\") {
      if (i + 1 >= input.length) throw new Error("No escaped character");
      token += input[++i];
      inToken = true;
    } else {
      token += ch;
      inToken = true;
    }
  }
  if (quote) throw new Error("No closing quotation");
  if (inToken) tokens.push(token);
  return tokens;
}

/** Search terms of a query: shell-like quoting, falling back to plain whitespace split. */
export function termsOf(query: string): string[] {
  let terms: string[];
  try {
    terms = shlexSplit(query);
  } catch {
    terms = collapseWhitespace(query.replaceAll('"', " ")).split(" ");
  }
  return terms.filter(Boolean);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A window of text around the first matched term, terms wrapped in \x02..\x03. */
export function makeSnippet(text: string, terms: string[], maxLen = 200): string {
  if (!text) return "";
  const clean = collapseWhitespace(text);
  if (terms.length === 0) return cpSlice(clean, maxLen);
  const low = clean.toLowerCase();
  let firstPos = -1;
  let firstTerm = "";
  for (const t of terms) {
    const idx = low.indexOf(t.toLowerCase());
    if (idx >= 0 && (firstPos < 0 || idx < firstPos)) {
      firstPos = idx;
      firstTerm = t;
    }
  }
  if (firstPos < 0) return cpSlice(clean, maxLen);
  const start = Math.max(0, firstPos - 60);
  const end = Math.min(clean.length, firstPos + firstTerm.length + 120);
  const window = clean.slice(start, end);
  const pattern = new RegExp(
    [...terms].sort((a, b) => cpLength(b) - cpLength(a)).map(escapeRegExp).join("|"),
    "giu",
  );
  const highlighted = window.replace(pattern, (m) => `\x02${m}\x03`);
  return `${start > 0 ? "…" : ""}${highlighted}${end < clean.length ? "…" : ""}`;
}

/** ISO timestamp → epoch ms, 0 when absent or unparseable. */
export function isoToMs(ts: string): number {
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : Math.trunc(ms);
}
