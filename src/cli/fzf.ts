// The interactive picker. fzf does not filter: every keystroke re-runs the
// search against the index and fzf only displays what comes back.

import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parsePicked, type PickedLine } from "./render";
import { selfShell } from "./self";

const FZF_CACHE_DIR = join(homedir(), ".cache", "claude-search");

function findFzf(): string | null {
  const which = spawnSync("which", ["fzf"], { encoding: "utf-8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const cached = join(FZF_CACHE_DIR, "fzf");
  return existsSync(cached) ? cached : null;
}

async function installFzf(): Promise<string> {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  process.stderr.write("fzf not found. Downloading...\n");
  const res = await fetch("https://api.github.com/repos/junegunn/fzf/releases/latest");
  if (!res.ok) throw new Error(`Failed to fetch fzf release: ${res.status}`);
  const release = (await res.json()) as any;
  const version = (release.tag_name as string).replace(/^v/, "");
  const name = `fzf-${version}-${platform}_${arch}.tar.gz`;
  const asset = release.assets?.find((a: any) => a.name === name);
  if (!asset) throw new Error(`No fzf binary for ${name}. Install fzf manually: https://github.com/junegunn/fzf#installation`);
  const dl = await fetch(asset.browser_download_url);
  if (!dl.ok) throw new Error(`Failed to download fzf: ${dl.status}`);
  mkdirSync(FZF_CACHE_DIR, { recursive: true });
  const tarPath = join(FZF_CACHE_DIR, "fzf.tar.gz");
  await Bun.write(tarPath, dl);
  spawnSync("tar", ["-xzf", tarPath, "-C", FZF_CACHE_DIR, "fzf"], { stdio: "inherit" });
  unlinkSync(tarPath);
  const fzfPath = join(FZF_CACHE_DIR, "fzf");
  chmodSync(fzfPath, 0o755);
  process.stderr.write(`fzf ${version} installed to ${fzfPath}\n`);
  return fzfPath;
}

export const ensureFzf = async (): Promise<string> => findFzf() ?? (await installFzf());

/** Filters forwarded to every reload, as `--name=value` flags of the hidden commands. */
export type ForwardedFlags = Record<string, string | undefined>;

const flagArgs = (flags: ForwardedFlags) =>
  Object.entries(flags)
    .filter(([, v]) => v)
    .map(([k, v]) => `--${k}=${v}`);

export function pickSession(fzfPath: string, { query, flags }: { query: string; flags: ForwardedFlags }): PickedLine | null {
  const forwarded = flagArgs(flags);
  // fzf substitutes {q} etc. already shell-quoted, so they go in unquoted.
  const reload = `reload(${selfShell("__lines", ...forwarded)} --query={q})`;
  const preview = `${selfShell("__preview", ...forwarded)} --source={3} --id={4} --ts={6} --project={7} --query={q}`;
  const result = spawnSync(
    fzfPath,
    [
      "--ansi",
      "--disabled",
      "--delimiter", "\t",
      "--with-nth", "1..2",
      "--query", query,
      "--bind", `start:${reload}`,
      "--bind", `change:${reload}`,
      "--preview", preview,
      "--preview-window", "right:60%:wrap",
      "--header", "Enter: resume | Ctrl-C: quit | words are ANDed, \"quote\" for phrases",
      "--no-hscroll",
      "--no-sort",
    ],
    { stdio: ["ignore", "pipe", "inherit"], encoding: "utf-8" },
  );
  if (result.status !== 0 || !result.stdout) return null;
  return parsePicked(result.stdout);
}
