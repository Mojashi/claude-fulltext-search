// How to run this program again (fzf reload/preview, the daemon's indexer, launchd).

/** A `bun build --compile` binary carries its script inside a virtual /$bunfs. */
export const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:\\~BUN\\");

/** argv prefix that re-runs claude-search, whether compiled or run as `bun index.ts`. */
export const selfCommand = (): string[] => (compiled ? [process.execPath] : [process.execPath, Bun.main]);

/** POSIX shell quoting, for commands fzf hands to `sh -c`. */
export const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export const selfShell = (...args: string[]): string => [...selfCommand(), ...args].map(shQuote).join(" ");
