// Colours of the picker, in one place. 256-colour SGR codes.

import type { SourceName } from "../session-index/sources";
import type { Style } from "./styled";

const AGENT: Record<SourceName, { tag: string; style: Style }> = {
  claude: { tag: "claude", style: "38;5;209" },
  codex: { tag: "codex ", style: "38;5;141" },
  agy: { tag: "agy   ", style: "38;5;114" },
  kimi: { tag: "kimi  ", style: "38;5;81" },
};

export const THEME = {
  accent: "38;5;75",
  quiet: "38;5;245",
  faint: "38;5;240",
  label: "38;5;245;3",
  path: "38;5;110;1",
  summary: "38;5;255",
  match: "38;5;16;48;5;221",
  gutter: "38;5;221",
  tool: "38;5;179",
  error: "38;5;203",
  selected: "48;5;237",
  marker: "38;5;75",
  agent: (source: string) => AGENT[source as SourceName] ?? { tag: source.padEnd(6).slice(0, 6), style: "38;5;250" },
  role: (role: string): Style => (role === "user" ? "38;5;114" : role === "assistant" ? "38;5;179" : "38;5;245"),
  ending: { error: { mark: "✗ error", style: "38;5;203" }, cut: { mark: "… cut off", style: "38;5;221" }, stopped: { mark: "■ stopped", style: "38;5;245" } } as Record<
    string,
    { mark: string; style: Style }
  >,
};
