// What to run when a session is picked, per agent.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as readline from "readline";
import type { SourceName } from "../session-index";

export const CONFIG_PATH = join(homedir(), ".config", "claude-search", "config.json");

export const DEFAULT_EXEC: Record<SourceName, string> = {
  claude: "claude --resume {sessionId}",
  codex: "codex resume {sessionId}",
  agy: "agy --conversation {sessionId}",
  kimi: "kimi --session {sessionId}",
};

/** Config keys per agent (exec / execCodex predate the others and stay as they were). */
const KEY: Record<SourceName, keyof Config> = { claude: "exec", codex: "execCodex", agy: "execAgy", kimi: "execKimi" };

const LABEL: Record<SourceName, string> = { claude: "Claude Code", codex: "Codex", agy: "Antigravity", kimi: "Kimi Code" };

export interface Config {
  exec?: string;
  execCodex?: string;
  execAgy?: string;
  execKimi?: string;
}

export function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(config: Config) {
  mkdirSync(join(CONFIG_PATH, ".."), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export const execTemplateFor = (config: Config, source: SourceName): string => config[KEY[source]] || DEFAULT_EXEC[source];

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

/** Interactive setup. `first`: no config yet, so Enter means "use the default". */
export async function setup({ first }: { first: boolean }): Promise<Config> {
  const config = first ? {} : loadConfig();
  process.stderr.write(`\n=== claude-search: ${first ? "initial setup" : "setup"} ===\n`);
  process.stderr.write(`Config: ${CONFIG_PATH}\nCommand to run when a session is selected. Placeholders: {sessionId}, {cwd}, {project}\n`);
  for (const source of Object.keys(KEY) as SourceName[]) {
    const key = KEY[source];
    process.stderr.write(`\n${LABEL[source]}: ${config[key] || `(default) ${DEFAULT_EXEC[source]}`}\n`);
    const answer = await ask(first ? "exec template (Enter for default): " : "exec template (Enter to keep, 'reset' for default): ");
    if (answer.toLowerCase() === "reset") delete config[key];
    else if (answer) config[key] = answer;
  }
  saveConfig(config);
  process.stderr.write(`\nSaved to ${CONFIG_PATH}\n\n`);
  return config;
}

export async function ensureConfig(): Promise<Config> {
  return existsSync(CONFIG_PATH) ? loadConfig() : setup({ first: true });
}
