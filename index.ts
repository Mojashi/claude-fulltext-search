import { readdir, readFile, stat, mkdir, unlink, open, writeFile } from "fs/promises";
import { join, resolve, basename } from "path";
import { homedir } from "os";
import { existsSync, realpathSync, renameSync, readFileSync } from "fs";
import { spawnSync, execSync } from "child_process";
import { parseArgs } from "util";
import * as readline from "readline";

const VERSION = "0.7.0";
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CACHE_DIR = join(homedir(), ".cache", "claude-search");
const CONFIG_DIR = join(homedir(), ".config", "claude-search");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const SCRIPT_PATH = process.argv[1];
const REPO = "Mojashi/claude-fulltext-search";

interface Config {
  exec?: string;
}

function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function saveConfig(config: Config) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function ensureConfig(): Promise<Config> {
  if (existsSync(CONFIG_PATH)) return loadConfig();

  process.stderr.write("\n=== claude-search: initial setup ===\n\n");
  process.stderr.write("Command to run when a session is selected.\n");
  process.stderr.write("Placeholders: {sessionId}, {cwd}, {project}\n");
  process.stderr.write(`Default: claude --resume {sessionId}\n\n`);

  const answer = await prompt("exec template (Enter for default): ");
  const config: Config = {};
  if (answer.trim()) {
    config.exec = answer.trim();
  }
  await saveConfig(config);
  process.stderr.write(`Config saved to ${CONFIG_PATH} (change later with --setup)\n\n`);
  return config;
}

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

async function readJsonlTail(path: string, offset: number): Promise<string[]> {
  try {
    const fh = await open(path, "r");
    const buf = Buffer.alloc((await fh.stat()).size - offset);
    await fh.read(buf, 0, buf.length, offset);
    await fh.close();
    return buf.toString("utf-8").split("\n");
  } catch {
    return [];
  }
}

// --- cache (incremental, per-file with append support) ---

interface FileCache {
  size: number;
  cwd: string | null;
  msgCount: number; // total messages indexed so far
  entries: string[];
}

interface CacheData {
  version: 4;
  files: Record<string, FileCache>; // key: "projDirName/sessionId"
}

async function loadCache(): Promise<CacheData> {
  try {
    const data = JSON.parse(await readFile(join(CACHE_DIR, "index.json"), "utf-8"));
    if (data.version === 4) return data as CacheData;
  } catch {}
  return { version: 4, files: {} };
}

async function saveCache(cache: CacheData) {
  await mkdir(CACHE_DIR, { recursive: true });
  await Bun.write(join(CACHE_DIR, "index.json"), JSON.stringify(cache));
}

function makeEntries(messages: Message[], startIdx: number, sessionId: string, projDirName: string, projDisplay: string): string[] {
  const shortProj = shortenPath(projDisplay);
  const shortSession = sessionId.slice(0, 8);
  const entries: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const ts = formatTimestamp(msg.timestamp);
    let firstLine = msg.text.replace(/[\n\t]/g, " ").trim();
    if (firstLine.length > 200) firstLine = firstLine.slice(0, 200) + "...";
    const R = "\x1b[0m";
    entries.push(`\x1b[1;36m${shortProj} \x1b[33m${shortSession}${R}\t${firstLine}\t${msg.role}\t${ts}\t${sessionId}\t${startIdx + i}\t${projDirName}\t${projDisplay}`);
  }
  return entries;
}

// --- index ---

async function processFile(
  filePath: string,
  sessionId: string,
  projDirName: string,
  fileSize: number,
  cached: FileCache | undefined,
): Promise<FileCache> {
  // Exact match - no changes
  if (cached && cached.size === fileSize) {
    return cached;
  }

  // File grew - read only the appended portion
  if (cached && cached.size < fileSize) {
    const tailLines = await readJsonlTail(filePath, cached.size);
    const projDisplay = cached.cwd || projDirName;
    const newMessages = parseMessages(tailLines);
    const newEntries = makeEntries(newMessages, cached.msgCount, sessionId, projDirName, projDisplay);
    return {
      size: fileSize,
      cwd: cached.cwd,
      msgCount: cached.msgCount + newMessages.length,
      entries: [...cached.entries, ...newEntries],
    };
  }

  // New file or file shrunk (shouldn't happen but handle it) - full reindex
  const lines = await readJsonlLines(filePath);
  const cwd = getProjectCwd(lines);
  const projDisplay = cwd || projDirName;
  const messages = parseMessages(lines);
  const entries = makeEntries(messages, 0, sessionId, projDirName, projDisplay);
  return { size: fileSize, cwd, msgCount: messages.length, entries };
}

async function buildIndex(): Promise<string[]> {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const cache = await loadCache();
  const newFiles: Record<string, FileCache> = {};
  const allEntries: string[] = [];
  let hits = 0;
  let appends = 0;
  let full = 0;

  const projDirs = (await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  // Collect all files
  const allFiles: { key: string; filePath: string; sessionId: string; projDirName: string }[] = [];
  for (const projDir of projDirs) {
    const projPath = join(CLAUDE_PROJECTS_DIR, projDir.name);
    const files = (await readdir(projPath)).filter((f) => f.endsWith(".jsonl")).sort();
    for (const f of files) {
      const sessionId = basename(f, ".jsonl");
      allFiles.push({ key: `${projDir.name}/${sessionId}`, filePath: join(projPath, f), sessionId, projDirName: projDir.name });
    }
  }

  // Stat all files in parallel
  const stats = await Promise.all(allFiles.map((f) => stat(f.filePath)));

  // Separate: exact hits vs needs processing
  const toProcess: { file: typeof allFiles[0]; size: number; cached?: FileCache }[] = [];
  for (let i = 0; i < allFiles.length; i++) {
    const f = allFiles[i];
    const size = stats[i].size;
    const cached = cache.files[f.key];

    if (cached && cached.size === size) {
      newFiles[f.key] = cached;
      allEntries.push(...cached.entries);
      hits++;
    } else {
      toProcess.push({ file: f, size, cached });
    }
  }

  // Process changes in parallel batches
  if (toProcess.length > 0) {
    const BATCH = 50;
    for (let i = 0; i < toProcess.length; i += BATCH) {
      const batch = toProcess.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(({ file, size, cached }) =>
          processFile(file.filePath, file.sessionId, file.projDirName, size, cached).then((fc) => ({ key: file.key, fc, wasAppend: !!(cached && cached.size < size) }))
        )
      );
      for (const { key, fc, wasAppend } of results) {
        newFiles[key] = fc;
        allEntries.push(...fc.entries);
        if (wasAppend) appends++;
        else full++;
      }
    }
  }

  const changed = appends + full;
  if (changed > 0) {
    const parts = [];
    if (full > 0) parts.push(`${full} new`);
    if (appends > 0) parts.push(`${appends} appended`);
    if (hits > 0) parts.push(`${hits} cached`);
    process.stderr.write(`(${parts.join(", ")}) `);
    await saveCache({ version: 4, files: newFiles });
  } else {
    process.stderr.write("(cached) ");
  }

  return allEntries;
}

// --- preview ---

function fuzzyHighlight(text: string, token: string): string {
  // Highlight characters matched by fzf's fuzzy algorithm (in order)
  const lower = text.toLowerCase();
  const tLower = token.toLowerCase();
  const HL = "\x1b[30;43m";
  const RS = "\x1b[0m";
  let ti = 0;
  let result = "";
  for (let i = 0; i < text.length && ti < tLower.length; i++) {
    if (lower[i] === tLower[ti]) {
      result += HL + text[i] + RS;
      ti++;
    } else {
      result += text[i];
    }
  }
  // Append remaining text if token was fully matched
  if (ti === tLower.length) {
    result += text.slice(result.replace(/\x1b\[[^m]*m/g, "").length);
    return result;
  }
  // Token didn't fully match - return original
  return text;
}

function highlightText(text: string, query?: string): string {
  if (!query || !query.trim()) return text;
  const tokens = query.trim().split(/\s+/)
    .filter(t => t && !t.startsWith("!"))
    .map(t => t.replace(/^['^\.\$]+/g, "").replace(/\$$/g, ""))
    .filter(Boolean);
  if (!tokens.length) return text;

  // Try exact substring first, then fuzzy
  for (const token of tokens) {
    const idx = text.toLowerCase().indexOf(token.toLowerCase());
    if (idx !== -1) {
      const before = text.slice(0, idx);
      const match = text.slice(idx, idx + token.length);
      const after = text.slice(idx + token.length);
      text = before + "\x1b[30;43m" + match + "\x1b[0m" + after;
    } else {
      text = fuzzyHighlight(text, token);
    }
  }
  return text;
}

async function previewMessage(projDirName: string, sessionId: string, msgIndex: number, highlight?: string) {
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
      const displayed = tl.length > 120 ? tl.slice(0, 120) + "..." : tl;
      out.push(`        ${highlightText(displayed, highlight)}`);
    }
    if (textLines.length > maxLines) {
      out.push(`        ... (${textLines.length - maxLines} more lines)`);
    }
    out.push("");
  }

  // Show latest messages if context window doesn't reach the end
  const latestCount = 3;
  const latestStart = Math.max(end, messages.length - latestCount);
  if (latestStart < messages.length && end < messages.length) {
    out.push(`\x1b[2m${"─".repeat(40)}\x1b[0m`);
    if (latestStart > end) {
      out.push(`\x1b[2m  ... ${latestStart - end} messages omitted ...\x1b[0m`);
    }
    out.push(`\x1b[2m  ↓ latest in session (${messages.length} messages total)\x1b[0m`);
    out.push("");
    for (let i = latestStart; i < messages.length; i++) {
      const msg = messages[i];
      const ts = formatTimestamp(msg.timestamp);
      const roleColor = msg.role === "user" ? "\x1b[32m" : "\x1b[33m";
      out.push(`    ${roleColor}${msg.role.padStart(9)}\x1b[0m \x1b[2m${ts}\x1b[0m`);
      const textLines = msg.text.split("\n");
      for (const tl of textLines.slice(0, 4)) {
        const displayed = tl.length > 120 ? tl.slice(0, 120) + "..." : tl;
        out.push(`        ${displayed}`);
      }
      if (textLines.length > 4) {
        out.push(`        \x1b[2m... (${textLines.length - 4} more lines)\x1b[0m`);
      }
      out.push("");
    }
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
    entries = entries.filter((e) => e.split("\t")[2] === role);
  }
  return entries;
}

// --- fzf ---

function findFzf(): string | null {
  // Check PATH first
  try {
    const which = spawnSync("which", ["fzf"], { encoding: "utf-8" });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  } catch {}
  // Check local cache
  const cached = join(CACHE_DIR, "fzf");
  if (existsSync(cached)) return cached;
  return null;
}

async function installFzf(): Promise<string> {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const assetName = `fzf-{VERSION}-${platform}_${arch}.tar.gz`;

  process.stderr.write("fzf not found. Downloading...\n");

  const res = await fetch("https://api.github.com/repos/junegunn/fzf/releases/latest");
  if (!res.ok) {
    console.error(`Failed to fetch fzf release: ${res.status}`);
    process.exit(1);
  }
  const release = await res.json() as any;
  const version = (release.tag_name as string).replace(/^v/, "");
  const name = assetName.replace("{VERSION}", version);
  const asset = release.assets?.find((a: any) => a.name === name);
  if (!asset) {
    console.error(`No fzf binary found for ${name}`);
    console.error("Install fzf manually: https://github.com/junegunn/fzf#installation");
    process.exit(1);
  }

  const dlRes = await fetch(asset.browser_download_url);
  if (!dlRes.ok) {
    console.error(`Failed to download fzf: ${dlRes.status}`);
    process.exit(1);
  }

  await mkdir(CACHE_DIR, { recursive: true });
  const tarPath = join(CACHE_DIR, "fzf.tar.gz");
  await Bun.write(tarPath, dlRes);
  execSync(`tar -xzf "${tarPath}" -C "${CACHE_DIR}" fzf`);
  await unlink(tarPath);
  const fzfPath = join(CACHE_DIR, "fzf");
  execSync(`chmod +x "${fzfPath}"`);

  process.stderr.write(`fzf ${version} installed to ${fzfPath}\n`);
  return fzfPath;
}

async function ensureFzf(): Promise<string> {
  const found = findFzf();
  if (found) return found;
  return await installFzf();
}

function runFzf(fzfPath: string, entries: string[], query?: string): { sessionId: string; cwd: string } | null {
  if (!entries.length) {
    console.error("No conversations found.");
    return null;
  }

  const previewCmd = `${process.execPath} ${SCRIPT_PATH} --preview {5}:{6}:{7} --highlight "$FZF_QUERY"`;

  const fzfArgs = [
    "--ansi",
    "--delimiter", "\t",
    "--with-nth", "1..2",
    "--nth", "2",
    "--preview", previewCmd,
    "--preview-window", "right:60%:wrap",
    "--header", "Enter: resume session | Ctrl-C: quit",
    "--no-hscroll",
    "--no-sort",
    "--tac",
    "--bind", "change:refresh-preview",
  ];

  if (query) fzfArgs.push("--query", query);

  const result = spawnSync(fzfPath, fzfArgs, {
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

// --- update ---

async function selfUpdate() {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const assetName = `claude-search-${platform}-${arch}`;

  console.log("Checking for updates...");

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!res.ok) {
    console.error(`Failed to check for updates: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const release = await res.json() as any;
  const tag = release.tag_name;

  const asset = release.assets?.find((a: any) => a.name === assetName);
  if (!asset) {
    console.error(`No binary found for ${assetName} in release ${tag}`);
    console.error("Available:", release.assets?.map((a: any) => a.name).join(", "));
    process.exit(1);
  }

  console.log(`Downloading ${tag} (${assetName})...`);

  const binRes = await fetch(asset.browser_download_url);
  if (!binRes.ok) {
    console.error(`Failed to download: ${binRes.status}`);
    process.exit(1);
  }

  const binPath = process.argv[0];
  const tmpPath = binPath + ".tmp";

  await Bun.write(tmpPath, binRes);
  execSync(`chmod +x "${tmpPath}"`);

  try {
    renameSync(tmpPath, binPath);
    console.log(`Updated to ${tag}`);
  } catch {
    // Current location not writable, install to ~/.local/bin
    const fallbackDir = join(homedir(), ".local", "bin");
    await mkdir(fallbackDir, { recursive: true });
    const fallbackPath = join(fallbackDir, "claude-search");
    renameSync(tmpPath, fallbackPath);
    console.log(`Updated to ${tag} (installed to ${fallbackPath})`);
    if (!process.env.PATH?.includes(fallbackDir)) {
      console.log(`\nAdd ${fallbackDir} to your PATH:\n  echo 'export PATH="${fallbackDir}:$PATH"' >> ~/.zshrc`);
    }
  }
}

// --- main ---

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      project: { type: "string", short: "p" },
      role: { type: "string", short: "r" },
      "list-projects": { type: "boolean" },
      setup: { type: "boolean" },
      "clear-cache": { type: "boolean" },
      update: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      exec: { type: "string", short: "e" },
      preview: { type: "string" },
      highlight: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.version) {
    console.log(`claude-search v${VERSION}`);
    return;
  }

  if (values.help) {
    console.log(`Usage: claude-search [query] [options]

Options:
  -p, --project <path>   Filter by project path (exact if exists, otherwise substring)
  -r, --role <role>      Filter by role (user|assistant)
  -e, --exec <template>  Command to run on selection (default: claude --resume {sessionId})
                         Placeholders: {sessionId}, {cwd}, {project}
  --list-projects        List all projects
  --setup                Configure settings interactively
  --clear-cache          Clear the index cache
  --update               Self-update to the latest release
  -v, --version          Show version
  -h, --help             Show this help`);
    return;
  }

  if (values.setup) {
    const config = loadConfig();
    process.stderr.write(`\n=== claude-search: setup ===\n`);
    process.stderr.write(`Config: ${CONFIG_PATH}\n\n`);

    process.stderr.write(`Command to run when a session is selected.\n`);
    process.stderr.write(`Placeholders: {sessionId}, {cwd}, {project}\n`);
    process.stderr.write(`Current: ${config.exec || "(default) claude --resume {sessionId}"}\n\n`);

    const answer = await prompt("exec template (Enter to keep, 'reset' for default): ");
    if (answer.trim().toLowerCase() === "reset") {
      delete config.exec;
      await saveConfig(config);
      console.log("Reset to default.");
    } else if (answer.trim()) {
      config.exec = answer.trim();
      await saveConfig(config);
      console.log(`Set to: ${config.exec}`);
    } else {
      console.log("No changes.");
    }
    return;
  }

  if (values.preview) {
    const parts = (values.preview as string).split(":");
    const [sessionId, msgIdx, ...rest] = parts;
    const projDirName = rest.join(":");
    await previewMessage(projDirName, sessionId, parseInt(msgIdx), values.highlight as string);
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

  if (values.update) {
    await selfUpdate();
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

  const [config, fzfPath] = await Promise.all([ensureConfig(), ensureFzf()]);

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

  const selected = runFzf(fzfPath, entries, query);

  if (selected) {
    if (selected.cwd && existsSync(selected.cwd)) {
      process.chdir(selected.cwd);
    }
    const execTemplate = (values.exec as string | undefined) || config.exec;
    if (execTemplate) {
      const cmd = execTemplate
        .replace(/\{sessionId\}/g, selected.sessionId)
        .replace(/\{cwd\}/g, selected.cwd || process.cwd())
        .replace(/\{project\}/g, selected.cwd || "");
      const userShell = process.env.SHELL || "sh";
      const result = spawnSync(userShell, ["-i", "-c", cmd], { stdio: "inherit", cwd: process.cwd() });
      process.exit(result.status ?? 0);
    } else {
      console.log(`\nResuming session: ${selected.sessionId} (in ${process.cwd()})`);
      const result = spawnSync("claude", ["--resume", selected.sessionId], { stdio: "inherit", cwd: process.cwd() });
      process.exit(result.status ?? 0);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
