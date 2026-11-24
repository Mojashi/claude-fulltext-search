// Shared full-text index over Claude Code, Codex, Antigravity and Kimi sessions.
// The DB layout is shared with ai-session-index (Python), kitty and web-terminal.

export { defaultDbPath, openForReading, openForWriting } from "./store";
export { ALL_SOURCES, defaultRoots, sourceNamed, type SessionRoots, type SourceName } from "./sources";
export { dedupe, updateIndex, type UpdateResult } from "./update";
export { findByPrefix, listProjects, listSessions, projectOf, search, searchRich, status, type Hit } from "./query";
export { getSessionDetail, type SessionDetail } from "./detail";
