// Relevance: how well a session answers a query.
//
// セッションの関連度 = 一番よく当たった発言の点
//                    × 当たった発言が多いほど上げる
//                    × 依頼文（summary）にも語があれば上げる
//                    × 作業ディレクトリ名に語があれば上げる
//                    × 古いほど少し下げる
//                    × サブエージェントの会話なら下げる（それ単体では再開できない）
// 発言の点 = 語ごとの「出現回数（対数）× 単語として当たったか」の和
//          × 語どうしが近くにまとまっているか（そのまま並んでいれば最大）
//          × 短く的を絞った発言か
//          × 誰の発言か（ユーザー > アシスタント > ツール出力）
//
// Every candidate already contains every term (search ANDs them), so there is
// no rarity weighting between terms: what separates candidates is how, where
// and by whom the terms were said.

const ASCII_WORD = /[A-Za-z0-9_]/;
const DAY_MS = 86_400_000;

/** Where each term occurs in `lower`, at most `cap` positions per term. */
function occurrences(lower: string, term: string, cap = 20): number[] {
  const at: number[] = [];
  for (let i = lower.indexOf(term); i >= 0 && at.length < cap; i = lower.indexOf(term, i + term.length)) at.push(i);
  return at;
}

/** An ASCII term counts as a word when it is not glued into a longer identifier. Other scripts have no boundaries to check. */
function asWord(lower: string, term: string, at: number[]): number {
  const edgesAreWordChars = ASCII_WORD.test(term[0]!) || ASCII_WORD.test(term.at(-1)!);
  if (!edgesAreWordChars) return 1;
  const whole = at.some((i) => !ASCII_WORD.test(lower[i - 1] ?? " ") && !ASCII_WORD.test(lower[i + term.length] ?? " "));
  return whole ? 1 : 0.6;
}

/** The narrowest stretch of text holding one occurrence of every term. */
function narrowestWindow(positions: number[][], terms: string[]): number {
  let best = Infinity;
  for (const anchor of positions[0]!) {
    let lo = anchor;
    let hi = anchor + terms[0]!.length;
    for (let k = 1; k < positions.length; k++) {
      const nearest = positions[k]!.reduce((a, b) => (Math.abs(b - anchor) < Math.abs(a - anchor) ? b : a));
      lo = Math.min(lo, nearest);
      hi = Math.max(hi, nearest + terms[k]!.length);
    }
    best = Math.min(best, hi - lo);
  }
  return best;
}

function closeTogether(lower: string, terms: string[], positions: number[][]): number {
  if (terms.length < 2) return 1;
  if (lower.includes(terms.join(" "))) return 1.8;
  const span = narrowestWindow(positions, terms);
  return span <= 40 ? 1.5 : span <= 120 ? 1.2 : 1;
}

const focused = (length: number) => 1 / (1 + 0.25 * Math.log(1 + length / 150));

const SPEAKER: Record<string, number> = { user: 1.4, assistant: 1 };
const bySpeaker = (role: string) => SPEAKER[role] ?? 0.7;

/** How well one message matches. `terms` are lowercased. 0 when a term is missing. */
export function messageScore(text: string, role: string, terms: string[]): number {
  const lower = text.toLowerCase();
  const positions = terms.map((t) => occurrences(lower, t));
  if (positions.some((p) => p.length === 0)) return 0;
  const said = terms.reduce((sum, t, k) => sum + (1 + Math.log(positions[k]!.length)) * asWord(lower, t, positions[k]!), 0);
  return said * closeTogether(lower, terms, positions) * focused(text.length) * bySpeaker(role);
}

export interface SessionEvidence {
  /** score of its best message */
  best: number;
  /** messages that matched */
  hits: number;
  summary: string;
  cwd: string;
  /** when its best message was said */
  ts: string;
  /** transcript path; a subagent's lives under its parent session's subagents/ */
  path: string;
}

const manyHits = (hits: number) => 1 + 0.25 * Math.log(Math.max(1, hits));

function inSummary(summary: string, terms: string[]): number {
  const lower = summary.toLowerCase();
  return 1 + (0.8 * terms.filter((t) => lower.includes(t)).length) / terms.length;
}

const inDirectory = (cwd: string, terms: string[]) => (terms.some((t) => cwd.toLowerCase().includes(t)) ? 1.2 : 1);

function recent(ts: string, now: number): number {
  const at = Date.parse(ts);
  if (Number.isNaN(at)) return 0.5;
  return 1 / Math.sqrt(1 + Math.max(0, now - at) / DAY_MS / 120);
}

const resumable = (path: string) => (path.includes("/subagents/") ? 0.5 : 1);

export function sessionScore(s: SessionEvidence, terms: string[], now = Date.now()): number {
  return s.best * manyHits(s.hits) * inSummary(s.summary, terms) * inDirectory(s.cwd, terms) * recent(s.ts, now) * resumable(s.path);
}
