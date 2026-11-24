// Keeping the index daemon running on macOS, via a per-user LaunchAgent.

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { selfCommand } from "./self";

export const LABEL = "io.github.mojashi.claude-search";
const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const logPath = () => join(homedir(), "Library", "Logs", "claude-search-daemon.log");

const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function plist(args: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${args.map((a) => `		<string>${xml(a)}</string>`).join("\n")}
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${xml(logPath())}</string>
	<key>StandardErrorPath</key>
	<string>${xml(logPath())}</string>
</dict>
</plist>
`;
}

function launchctl(...args: string[]) {
  return spawnSync("launchctl", args, { encoding: "utf-8" });
}

const domain = () => `gui/${process.getuid!()}`;

/** Write the LaunchAgent for `serve` with this binary, and (re)start it. */
export function installDaemon(serveArgs: string[]) {
  if (process.platform !== "darwin") throw new Error("daemon install is macOS only; run `claude-search serve` under your init system instead");
  const path = plistPath();
  mkdirSync(join(path, ".."), { recursive: true });
  mkdirSync(join(logPath(), ".."), { recursive: true });
  if (existsSync(path)) launchctl("bootout", `${domain()}/${LABEL}`);
  writeFileSync(path, plist([...selfCommand(), "serve", ...serveArgs]));
  const r = launchctl("bootstrap", domain(), path);
  if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim()}`);
  console.log(`Installed ${path}\nLogs: ${logPath()}`);
}

export function uninstallDaemon() {
  const path = plistPath();
  if (!existsSync(path)) {
    console.log("No daemon installed.");
    return;
  }
  launchctl("bootout", `${domain()}/${LABEL}`);
  unlinkSync(path);
  console.log(`Removed ${path}`);
}
