# claude-fulltext-search

Full-text search for [Claude Code](https://claude.ai/claude-code) chat history with fzf-powered TUI.

## Features

- Full-text search across all Claude Code conversations (including tool use / tool results)
- fzf-powered interactive fuzzy finder with conversation preview (with query highlighting)
- Filter by project path or message role
- Resume sessions directly from search results (auto `cd` to the correct directory)
- Incremental index caching for fast repeated searches
- Self-update from GitHub releases

## Requirements

- [fzf](https://github.com/junegunn/fzf)

## Install

### Download binary (recommended)

Download the latest binary for your platform from [Releases](https://github.com/Mojashi/claude-fulltext-search/releases) and put it in your PATH:

```bash
# macOS (Apple Silicon)
curl -Lo claude-search https://github.com/Mojashi/claude-fulltext-search/releases/latest/download/claude-search-darwin-arm64

# macOS (Intel)
curl -Lo claude-search https://github.com/Mojashi/claude-fulltext-search/releases/latest/download/claude-search-darwin-x64

# Linux (x64)
curl -Lo claude-search https://github.com/Mojashi/claude-fulltext-search/releases/latest/download/claude-search-linux-x64

# Linux (ARM64)
curl -Lo claude-search https://github.com/Mojashi/claude-fulltext-search/releases/latest/download/claude-search-linux-arm64

chmod +x claude-search
mv claude-search ~/.local/bin/  # or /usr/local/bin/
```

### Build from source

Requires [Bun](https://bun.sh/).

```bash
git clone https://github.com/Mojashi/claude-fulltext-search.git
cd claude-fulltext-search
bun build --compile index.ts --outfile claude-search
mv claude-search ~/.local/bin/
```

### Update

```bash
claude-search --update
```

## Usage

```bash
# Search all conversations
claude-search

# Search with initial query
claude-search "docker compose"

# Filter by project directory (resolves path, includes subdirectories)
claude-search -p .
claude-search -p ~/repos/my-project

# Filter by role
claude-search -r user
claude-search -r assistant

# List all projects
claude-search --list-projects

# Clear index cache
claude-search --clear-cache
```

### Key bindings (in fzf)

- Type to filter results
- Up/Down to navigate
- Enter to resume the selected session
- Ctrl-C to quit
- Prefix with `'` for exact match (e.g. `'mutool`)

## How it works

Claude Code stores conversation history as JSONL files in `~/.claude/projects/`. This tool:

1. Indexes all messages (text, tool use inputs, tool results) from every session
2. Caches the index incrementally — only re-reads files that changed or grew
3. Pipes the index to fzf for interactive filtering with a conversation preview panel
4. On selection, `cd`s to the original project directory and runs `claude --resume <session-id>`

## License

MIT
