# claude-fulltext-search

Full-text search for [Claude Code](https://claude.ai/claude-code) chat history with fzf-powered TUI.

![demo](https://github.com/user-attachments/assets/placeholder.gif)

## Features

- Full-text search across all Claude Code conversations (including tool use / tool results)
- fzf-powered interactive fuzzy finder with conversation preview
- Filter by project path or message role
- Resume sessions directly from search results (auto `cd` to the correct directory)
- Index caching for fast repeated searches

## Requirements

- [Bun](https://bun.sh/) (for building from source)
- [fzf](https://github.com/junegunn/fzf)

## Install

```bash
# Clone and build
git clone https://github.com/Mojashi/claude-fulltext-search.git
cd claude-fulltext-search
bun build --compile index.ts --outfile claude-search

# Put it in your PATH
cp claude-search ~/.local/bin/
# or
sudo cp claude-search /usr/local/bin/
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

## How it works

Claude Code stores conversation history as JSONL files in `~/.claude/projects/`. This tool:

1. Indexes all messages (text, tool use inputs, tool results) from every session
2. Caches the index for fast subsequent searches (auto-invalidates when files change)
3. Pipes the index to fzf for interactive filtering with a conversation preview panel
4. On selection, `cd`s to the original project directory and runs `claude --resume <session-id>`

## License

MIT
