// How to run this program again (the daemon's indexer, launchd).

/** A `bun build --compile` binary carries its script inside a virtual /$bunfs. */
export const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:\\~BUN\\");

/** argv prefix that re-runs claude-search, whether compiled or run as `bun index.ts`. */
export const selfCommand = (): string[] => (compiled ? [process.execPath] : [process.execPath, Bun.main]);
