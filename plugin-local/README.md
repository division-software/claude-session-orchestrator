# Session Orchestrator (self-hosted)

The same tools and `manage-sessions` skill as the hosted plugin, but the MCP server runs **on your own machine** (`npx -y github:division-software/claude-session-orchestrator stdio`, built from GitHub on first run, then cached). No hosted service, no sign-in. It works in Claude Code, Codex and Cursor, which all read this plugin format.

## Setup

1. One time, on the machine that runs your sessions (Node 24+, tmux, git):
   ```sh
   npx -y github:division-software/claude-session-orchestrator init             # config, tokens and this machine in ~/.config/session-orchestrator
   npx -y github:division-software/claude-session-orchestrator hooks local local # status hooks, so the server knows when a session waits for you
   npx -y github:division-software/claude-session-orchestrator serve            # keep running (systemd/launchd) so the hooks have somewhere to report
   ```
2. Install the plugin:
   ```
   /plugin marketplace add division-software/claude-session-orchestrator
   /plugin install session-orchestrator-local@session-orchestrator
   ```
3. Ask: "Start a new project called side quest" or "How are my projects doing?"

Without the plugin, install from a checkout and run `node dist/cli.js install claude` (or `codex`, `cursor`, `print`); see the [main README](../README.md#with-the-cli-claude-code-codex-cursor-any-mcp-client).

## License

MIT
