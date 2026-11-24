// claude-search: find a past agent session by what was said in it, and resume it.
//
// 対話モード: 絞り込み条件を決め、インデックスを最新にして（デーモンがいればその HTTP 経由、
// いなければ手元の DB を直接）、fzf で検索しながら選ばせ、選んだセッションをそのエージェントで再開する。

import { spawnSync } from "child_process";
import { existsSync, realpathSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { parseArgs } from "util";
import { dedupe, defaultDbPath, defaultRoots, openForWriting, updateIndex, type SourceName } from "../session-index";
import { DEFAULT_PORT, openIndex, type IndexAccess } from "../session-index/access";
import type { Filter } from "../session-index/query";
import { serve } from "../session-index/server";
import { ensureConfig, execTemplateFor, setup, type Config } from "./config";
import { ensureFzf, pickSession } from "./fzf";
import { installDaemon, uninstallDaemon } from "./launchd";
import { renderPreview, searchLine, sessionLine, type PickedLine } from "./render";
import { selfCommand } from "./self";
import { selfUpdate } from "./self-update";

const VERSION = "1.0.0";
const SOURCES: readonly SourceName[] = ["claude", "codex", "agy", "kimi"];

const HELP = `Usage: claude-search [query] [options]
       claude-search <command> [options]

Search Claude Code, Codex, Antigravity and Kimi Code sessions and resume one.
Words are ANDed substrings (Japanese works); "quote" a phrase.

Options:
  -p, --project <path>   Only sessions under this directory (or whose project contains this text)
  -r, --role <role>      Only messages by this role (user|assistant|tool)
  -s, --source <agent>   claude|codex|agy|kimi|all (default: all)
  -e, --exec <template>  Command to run on selection. Placeholders: {sessionId}, {cwd}, {project}
  --list-projects        List projects
  --setup                Configure the command run per agent
  --update               Self-update to the latest release
  -v, --version          Show version
  -h, --help             Show this help

Commands:
  search <query> [--json] [--limit N]   Print matches (one per session)
  status [--json]                       Index size per agent
  index [--budget SEC] [--json]         Bring the index up to date once
  dedupe                                Remove duplicated message rows
  serve [--port ${DEFAULT_PORT}] [--interval 60]     Run the index daemon (HTTP API + periodic indexing)
  daemon install|uninstall              Keep 'serve' running via launchd (macOS)

The index is shared at ${defaultDbPath()} (AI_SESSION_INDEX_DB overrides).
When the daemon answers on ${DEFAULT_PORT} (AI_SESSION_INDEX_URL overrides), it is used; otherwise the DB is read directly.`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    project: { type: "string", short: "p" },
    role: { type: "string", short: "r" },
    source: { type: "string", short: "s" },
    exec: { type: "string", short: "e" },
    "list-projects": { type: "boolean" },
    setup: { type: "boolean" },
    "clear-cache": { type: "boolean" },
    update: { type: "boolean" },
    version: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    limit: { type: "string" },
    budget: { type: "string" },
    host: { type: "string" },
    port: { type: "string" },
    interval: { type: "string" },
    // hidden: what fzf passes back to __lines / __preview
    query: { type: "string" },
    cwd: { type: "string" },
    "project-name": { type: "string" },
    id: { type: "string" },
    ts: { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

const str = (k: keyof typeof values): string => (typeof values[k] === "string" ? (values[k] as string) : "");

function intOption(k: keyof typeof values, dflt: number): number {
  const raw = str(k);
  if (!raw) return dflt;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) fail(`--${k} must be a number`);
  return n;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// MARK: filters

/** Search filters from the command line. Hidden commands get them already resolved. */
function filterFromFlags(): Filter {
  const source = str("source") === "all" ? "" : str("source");
  if (source && !SOURCES.includes(source as SourceName)) fail(`--source must be one of ${SOURCES.join(", ")} or all`);
  const role = str("role");
  if (role && !["user", "assistant", "tool"].includes(role)) fail("--role must be user, assistant or tool");
  return { source, role, ...projectFilter(str("project")), ...(str("cwd") && { cwd: str("cwd") }), ...(str("project-name") && { project: str("project-name") }) };
}

/** An existing directory filters by cwd (subdirectories included); anything else by project name. */
function projectFilter(p: string): Filter {
  if (!p) return {};
  const path = resolve(p.replace(/^~(?=\/|$)/, homedir()));
  return existsSync(path) ? { cwd: realpathSync(path) } : { project: p };
}

/** The same filters as flags for the hidden commands fzf runs. */
const forwardFlags = (f: Filter) => ({ source: f.source, role: f.role, cwd: f.cwd, "project-name": f.project });

// MARK: commands

async function withIndex<T>(refresh: boolean, use: (index: IndexAccess) => Promise<T>): Promise<T> {
  const index = await openIndex({
    refresh,
    onProgress: (msg) => process.stderr.write(`\rIndexing... ${msg} `),
  });
  try {
    return await use(index);
  } finally {
    index.close();
  }
}

const LIST_LIMIT = 300;

/** fzf reload: the matches for the query, or the latest sessions when it is empty. */
async function printLines(filter: Filter, query: string) {
  try {
    await withIndex(false, async (index) => {
      const lines = query.trim()
        ? (await index.search(query, { ...filter, limit: LIST_LIMIT })).map(searchLine)
        : (await index.sessions({ ...filter, limit: LIST_LIMIT })).map(sessionLine);
      if (lines.length) process.stdout.write(lines.join("\n") + "\n");
    });
  } catch (e) {
    // fzf shows stdout only; an error has to be a line to be seen at all.
    console.log(`\x1b[31merror\x1b[0m\t${String(e instanceof Error ? e.message : e).replace(/\s+/g, " ")}`);
  }
}

async function printPreview(config: Config) {
  const source = str("source") as SourceName;
  await withIndex(false, async (index) => {
    const detail = await index.session({ source, id: str("id"), project: str("project-name") });
    if (!detail) return console.log("Session file not found.");
    const resume = execTemplateFor(config, source).replace(/\{sessionId\}/g, detail.id);
    console.log(renderPreview(detail, resume, { ts: str("ts"), query: str("query") }));
  });
}

async function interactive(query: string, filter: Filter) {
  const [config, fzf] = await Promise.all([ensureConfig(), ensureFzf()]);
  await withIndex(true, async (index) => {
    const st = await index.status(filter.source);
    process.stderr.write(`\r${st.messages} messages in ${st.sessions} sessions (${index.via})\x1b[K\n`);
  });
  const picked = pickSession(fzf, { query, flags: forwardFlags(filter) });
  if (picked) resume(picked, config);
}

function resume(picked: PickedLine, config: Config) {
  if (picked.cwd && existsSync(picked.cwd)) process.chdir(picked.cwd);
  const cmd = (str("exec") || execTemplateFor(config, picked.source))
    .replace(/\{sessionId\}/g, picked.session)
    .replace(/\{cwd\}/g, picked.cwd || process.cwd())
    .replace(/\{project\}/g, picked.cwd || "");
  const r = spawnSync(process.env.SHELL || "sh", ["-i", "-c", cmd], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

/** One indexing pass into the local DB. Always local: this is what the daemon itself runs. */
function indexOnce() {
  const dbPath = defaultDbPath();
  const db = openForWriting(dbPath);
  try {
    const r = updateIndex(db, dbPath, {
      roots: defaultRoots(),
      budgetMs: intOption("budget", 0) * 1000,
      onProgress: values.json ? undefined : (done, total) => process.stderr.write(`\r${done}/${total} files`),
    });
    console.log(values.json ? JSON.stringify(r) : `\rindexed ${r.done} files, ${r.left} left`);
  } finally {
    db.close();
  }
}

function dedupeIndex() {
  const db = openForWriting(defaultDbPath());
  try {
    console.log(`removed ${dedupe(db)} duplicate message rows`);
  } finally {
    db.close();
  }
}

async function printStatus(filter: Filter) {
  await withIndex(false, async (index) => {
    const st = await index.status(filter.source);
    if (values.json) return console.log(JSON.stringify({ ...st, via: index.via }));
    console.log(`${st.messages} messages in ${st.sessions} sessions (${index.via}, ${defaultDbPath()})`);
    for (const [src, v] of Object.entries(st.by_source).sort()) {
      console.log(`  ${src.padEnd(8)} ${String(v.sessions).padStart(6)} sessions ${String(v.messages).padStart(9)} messages`);
    }
  });
}

async function printSearch(query: string, filter: Filter) {
  await withIndex(false, async (index) => {
    const results = await index.search(query, { ...filter, limit: intOption("limit", 20) });
    if (values.json) return console.log(JSON.stringify(results));
    for (const r of results) {
      console.log(`${r.source.padEnd(6)} ${r.session.slice(0, 8)} ${r.role.padEnd(9)} ${r.cwd}\n    ${r.snippet.replace(/[\x02\x03]/g, "")}`);
    }
  });
}

async function listProjects(filter: Filter) {
  await withIndex(true, async (index) => {
    process.stderr.write("\r\x1b[K");
    const projects = await index.projects(filter.source);
    if (!projects.length) return console.log("No projects found.");
    for (const p of projects) console.log(`  ${p.cwd || p.project}  (${p.count} sessions)`);
  });
}

function clearLegacyCache() {
  const legacy = join(homedir(), ".cache", "claude-search", "index.json");
  if (existsSync(legacy)) {
    unlinkSync(legacy);
    console.log(`Removed the old cache ${legacy}.`);
  } else {
    console.log("No old cache to remove.");
  }
  console.log(`The shared index at ${defaultDbPath()} is kept: other tools read it too.`);
}

async function main() {
  if (values.version) return console.log(`claude-search v${VERSION}`);
  if (values.help) return console.log(HELP);
  if (values.setup) return void (await setup({ first: false }));
  if (values.update) return selfUpdate();
  if (values["clear-cache"]) return clearLegacyCache();

  const filter = filterFromFlags();
  if (values["list-projects"]) return listProjects(filter);

  const [command, ...rest] = positionals;
  switch (command) {
    case "__lines":
      return printLines(filter, str("query"));
    case "__preview":
      return printPreview(await ensureConfig());
    case "index":
      return indexOnce();
    case "status":
      return printStatus(filter);
    case "dedupe":
      return dedupeIndex();
    case "search":
      return printSearch(str("query") || rest.join(" "), filter);
    case "serve":
      return void serve({
        host: str("host") || "127.0.0.1",
        port: intOption("port", DEFAULT_PORT),
        intervalSec: intOption("interval", 60),
        dbPath: defaultDbPath(),
        roots: defaultRoots(),
        indexCommand: [...selfCommand(), "index", "--json"],
      });
    case "daemon":
      if (rest[0] === "install") {
        return installDaemon([
          ...(str("port") ? [`--port=${str("port")}`] : []),
          ...(str("interval") ? [`--interval=${str("interval")}`] : []),
        ]);
      }
      if (rest[0] === "uninstall") return uninstallDaemon();
      return fail("usage: claude-search daemon install|uninstall");
    default:
      return interactive(positionals.join(" "), filter);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
