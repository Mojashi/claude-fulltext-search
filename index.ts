import { readdir, readFile, stat, mkdir, unlink } from "fs/promises";
import { join, resolve, basename } from "path";
import { homedir } from "os";
import { existsSync, realpathSync } from "fs";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { parseArgs } from "util";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CACHE_DIR = join(homedir(), ".cache", "claude-search");
const SCRIPT_PATH = process.argv[1];

// --- helpers ---

function extractText(message: any): string {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block === "string") return block;
        if (block?.type === "text") return block.text ?? "";
        if (block?.type === "tool_use") {
          const input = block.input;
          if (typeof input === "string") return input;
          if (input && typeof input === "object") {
            return Object.values(input).filter((v: any) => typeof v === "string").join("\n");
          }
        }
        if (block?.type === "tool_result") {
          const c = block.content;
          if (typeof c === "string") return c;
          if (Array.isArray(c)) {
            return c.map((x: any) => (typeof x === "string" ? x : x?.text ?? "")).join("\n");
          }
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

function shortenPath(p: string, depth = 2): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= depth) return p;
  return parts.slice(-depth).join("/");
}

function formatTimestamp(ts: any): string {
  if (!ts) return "?";
  try {
    const d = typeof ts === "string" ? new Date(ts) : new Date(ts > 1e12 ? ts : ts * 1000);
    if (isNaN(d.getTime())) return "?";
    return d.toLocaleString("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).replace("T", " ");
  } catch {
    return "?";
  }
}

function getProjectCwd(lines: string[]): string | null {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d.type === "user" && d.cwd) return d.cwd;
    } catch {}
  }
  return null;
}

interface Message {
  role: string;
  text: string;
  timestamp: any;
}

function parseMessages(lines: string[]): Message[] {
  const messages: Message[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d.type === "user" || d.type === "assistant") {
        const text = extractText(d.message);
        if (text) {
          messages.push({ role: d.type, text, timestamp: d.timestamp });
        }
      }
    } catch {}
  }
  return messages;
}

async function readJsonlLines(path: string): Promise<string[]> {
  try {
    const content = await readFile(path, "utf-8");
    return content.split("\n");
  } catch {
    return [];
  }
}

// --- cache ---

async function getFingerprint(): Promise<string> {
  const parts: string[] = [];
  try {
    const projDirs = (await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const projDir of projDirs) {
      const projPath = join(CLAUDE_PROJECTS_DIR, projDir.name);
      const files = (await readdir(projPath)).filter((f) => f.endsWith(".jsonl")).sort();
      for (const f of files) {
        const fp = join(projPath, f);
        const st = await stat(fp);
        parts.push(`${fp}:${st.mtimeMs}:${st.size}`);
      }
    }
  } catch {}
  return createHash("md5").update(parts.join("\n")).digest("hex");
}

interface CacheData {
  fingerprint: string;
  entries: string[];
}

async function loadCache(): Promise<CacheData | null> {
  try {
    const data = JSON.parse(await readFile(join(CACHE_DIR, "index.json"), "utf-8"));
    return data as CacheData;
  } catch {
    return null;
  }
}

async function saveCache(fingerprint: string, entries: string[]) {
  await mkdir(CACHE_DIR, { recursive: true });
  await Bun.write(join(CACHE_DIR, "index.json"), JSON.stringify({ fingerprint, entries }));
}

// --- index ---

async function buildIndex(): Promise<string[]> {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const fp = await getFingerprint();
  const cached = await loadCache();
  if (cached && cached.fingerprint === fp) {
    process.stderr.write("(cached) ");
    return cached.entries;
  }

  const entries: string[] = [];
  const projDirs = (await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const projDir of projDirs) {
    const projPath = join(CLAUDE_PROJECTS_DIR, projDir.name);
    const files = (await readdir(projPath)).filter((f) => f.endsWith(".jsonl")).sort();

    for (const f of files) {
      const sessionId = basename(f, ".jsonl");
      const filePath = join(projPath, f);
      const lines = await readJsonlLines(filePath);
      const cwd = getProjectCwd(lines);
      const projDisplay = cwd || projDir.name;
      const messages = parseMessages(lines);

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const ts = formatTimestamp(msg.timestamp);
        let firstLine = msg.text.replace(/\n/g, " ").trim();
        if (firstLine.length > 200) firstLine = firstLine.slice(0, 200) + "...";

        const shortProj = shortenPath(projDisplay);
        // {1}project  {2}role  {3}timestamp  {4}text  {5}session_id  {6}msg_index  {7}proj_dir_name  {8}full_cwd
        entries.push(`${shortProj}\t${msg.role}\t${ts}\t${firstLine}\t${sessionId}\t${i}\t${projDir.name}\t${projDisplay}`);
      }
    }
  }

  await saveCache(fp, entries);
  return entries;
}

// --- preview ---

async function previewMessage(projDirName: string, sessionId: string, msgIndex: number) {
  const jsonlPath = join(CLAUDE_PROJECTS_DIR, projDirName, `${sessionId}.jsonl`);
  const lines = await readJsonlLines(jsonlPath);
  const messages = parseMessages(lines);
  const cwd = getProjectCwd(lines);
  const projDisplay = cwd || projDirName;

  const ctx = 5;
  const start = Math.max(0, msgIndex - ctx);
  const end = Math.min(messages.length, msgIndex + ctx + 1);

  const out: string[] = [];
  out.push(`\x1b[1;36m${projDisplay}\x1b[0m`);
  out.push(`\x1b[2msession: ${sessionId}\x1b[0m`);
  out.push(`\x1b[2mresume:  claude --resume ${sessionId}\x1b[0m`);
  out.push("");

  for (let i = start; i < end; i++) {
    const msg = messages[i];
    const isCurrent = i === msgIndex;
    const ts = formatTimestamp(msg.timestamp);
    const roleColor = msg.role === "user" ? "\x1b[32m" : "\x1b[33m";
    const marker = isCurrent ? "\x1b[1;31m>>>\x1b[0m " : "    ";
    out.push(`${marker}${roleColor}${msg.role.padStart(9)}\x1b[0m \x1b[2m${ts}\x1b[0m`);

    const textLines = msg.text.split("\n");
    const maxLines = isCurrent ? 30 : 6;
    for (const tl of textLines.slice(0, maxLines)) {
      out.push(`        ${tl.length > 120 ? tl.slice(0, 120) + "..." : tl}`);
    }
    if (textLines.length > maxLines) {
      out.push(`        ... (${textLines.length - maxLines} more lines)`);
    }
    out.push("");
  }

  console.log(out.join("\n"));
}

// --- filter ---

function getFullCwd(entry: string): string {
  const fields = entry.split("\t");
  return fields.length > 7 ? fields[7] : fields[0];
}

function filterEntries(entries: string[], project?: string, role?: string): string[] {
  if (project) {
    const expanded = project.replace(/^~/, homedir());
    const resolved = resolve(expanded).replace(/\/+$/, "");
    if (existsSync(resolved)) {
      const real = realpathSync(resolved);
      const prefix = real + "/";
      entries = entries.filter((e) => {
        const cwd = getFullCwd(e);
        try {
          const r = realpathSync(cwd).replace(/\/+$/, "");
          return r === real || r.startsWith(prefix);
        } catch {
          const c = cwd.replace(/\/+$/, "");
          return c === real || c.startsWith(prefix);
        }
      });
    } else {
      const lower = project.toLowerCase();
      entries = entries.filter((e) => getFullCwd(e).toLowerCase().includes(lower));
    }
  }
  if (role) {
    entries = entries.filter((e) => e.split("\t")[1] === role);
  }
  return entries;
}

// --- fzf ---

function runFzf(entries: string[], query?: string): { sessionId: string; cwd: string } | null {
  if (!entries.length) {
    console.error("No conversations found.");
    return null;
  }

  const previewCmd = `${process.execPath} ${SCRIPT_PATH} --preview {5}:{6}:{7}`;

  const fzfArgs = [
    "--ansi",
    "--delimiter", "\t",
    "--with-nth", "1..4",
    "--preview", previewCmd,
    "--preview-window", "right:60%:wrap",
    "--header", "Enter: resume session | Ctrl-C: quit",
    "--no-sort",
    "--tac",
  ];

  if (query) fzfArgs.push("--query", query);

  const result = spawnSync("fzf", fzfArgs, {
    input: entries.join("\n"),
    stdio: ["pipe", "pipe", "inherit"],
    encoding: "utf-8",
  });

  if (result.status !== 0 || !result.stdout) return null;

  const selected = result.stdout.trim();
  const parts = selected.split("\t");
  if (parts.length >= 8) return { sessionId: parts[4], cwd: parts[7] };
  if (parts.length >= 5) return { sessionId: parts[4], cwd: "" };
  return null;
}

// --- main ---

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      project: { type: "string", short: "p" },
      role: { type: "string", short: "r" },
      "list-projects": { type: "boolean" },
      "clear-cache": { type: "boolean" },
      preview: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    console.log(`Usage: claude-search [query] [options]

Options:
  -p, --project <path>   Filter by project path (exact if exists, otherwise substring)
  -r, --role <role>      Filter by role (user|assistant)
  --list-projects        List all projects
  --clear-cache          Clear the index cache
  -h, --help             Show this help`);
    return;
  }

  if (values.preview) {
    const parts = (values.preview as string).split(":");
    const [sessionId, msgIdx, ...rest] = parts;
    const projDirName = rest.join(":");
    await previewMessage(projDirName, sessionId, parseInt(msgIdx));
    return;
  }

  if (values["clear-cache"]) {
    const cacheFile = join(CACHE_DIR, "index.json");
    if (existsSync(cacheFile)) {
      await unlink(cacheFile);
      console.log("Cache cleared.");
    } else {
      console.log("No cache to clear.");
    }
    return;
  }

  if (values["list-projects"]) {
    if (!existsSync(CLAUDE_PROJECTS_DIR)) {
      console.log("No projects found.");
      return;
    }
    const seen = new Set<string>();
    const projDirs = (await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const projDir of projDirs) {
      const projPath = join(CLAUDE_PROJECTS_DIR, projDir.name);
      const jsonlFiles = (await readdir(projPath)).filter((f) => f.endsWith(".jsonl"));
      if (!jsonlFiles.length) continue;
      const lines = await readJsonlLines(join(projPath, jsonlFiles[0]));
      const cwd = getProjectCwd(lines);
      const display = cwd || projDir.name;
      if (!seen.has(display)) {
        seen.add(display);
        console.log(`  ${display}  (${jsonlFiles.length} sessions)`);
      }
    }
    return;
  }

  const query = positionals[0];
  const role = values.role as string | undefined;
  if (role && role !== "user" && role !== "assistant") {
    console.error("--role must be 'user' or 'assistant'");
    process.exit(1);
  }

  process.stderr.write("Indexing... ");
  let entries = await buildIndex();
  const total = entries.length;

  entries = filterEntries(entries, values.project as string, role);

  const suffix = entries.length !== total ? ` (filtered from ${total})` : "";
  process.stderr.write(`${entries.length} messages${suffix}\n`);

  const selected = runFzf(entries, query);

  if (selected) {
    if (selected.cwd && existsSync(selected.cwd)) {
      process.chdir(selected.cwd);
    }
    console.log(`\nResuming session: ${selected.sessionId} (in ${process.cwd()})`);
    const result = spawnSync("claude", ["--resume", selected.sessionId], { stdio: "inherit", cwd: process.cwd() });
    process.exit(result.status ?? 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
