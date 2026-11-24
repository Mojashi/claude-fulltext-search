import { chmodSync, mkdirSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { compiled } from "./self";

const REPO = "Mojashi/claude-fulltext-search";

export async function selfUpdate() {
  if (!compiled) throw new Error("--update replaces the installed binary; running from source, use git pull instead");
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const assetName = `claude-search-${platform}-${arch}`;

  console.log("Checking for updates...");
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!res.ok) throw new Error(`Failed to check for updates: ${res.status} ${res.statusText}`);
  const release = (await res.json()) as any;
  const tag = release.tag_name;
  const asset = release.assets?.find((a: any) => a.name === assetName);
  if (!asset) {
    throw new Error(`No binary for ${assetName} in release ${tag}. Available: ${release.assets?.map((a: any) => a.name).join(", ")}`);
  }

  console.log(`Downloading ${tag} (${assetName})...`);
  const bin = await fetch(asset.browser_download_url);
  if (!bin.ok) throw new Error(`Failed to download: ${bin.status}`);

  // In a compiled binary execPath is the binary itself and argv[0] is just "bun"
  // (e59ba05 used argv[0], which on Bun 1.3 renames the download to ./bun).
  const binPath = process.execPath;
  const tmpPath = binPath + ".tmp";
  await Bun.write(tmpPath, bin);
  chmodSync(tmpPath, 0o755);
  try {
    renameSync(tmpPath, binPath);
    console.log(`Updated to ${tag}`);
  } catch {
    // Current location not writable, install to ~/.local/bin
    const fallbackDir = join(homedir(), ".local", "bin");
    mkdirSync(fallbackDir, { recursive: true });
    const fallbackPath = join(fallbackDir, "claude-search");
    renameSync(tmpPath, fallbackPath);
    console.log(`Updated to ${tag} (installed to ${fallbackPath})`);
    if (!process.env.PATH?.includes(fallbackDir)) {
      console.log(`\nAdd ${fallbackDir} to your PATH:\n  echo 'export PATH="${fallbackDir}:$PATH"' >> ~/.zshrc`);
    }
  }
}
