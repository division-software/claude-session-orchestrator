# Session Orchestrator (self-hosted)

The same tools and `manage-sessions` skill as the hosted plugin, but the MCP server runs **on your own machine** (`npx -y claude-session-orchestrator stdio`). No hosted service, no sign-in. It works in Claude Code, Codex and Cursor, which all read this plugin format.

## Setup

1. One time, on the machine that runs your sessions (Node 24+, tmux, git):
   ```sh
   npx claude-session-orchestrator init       # config, tokens and this machine in ~/.config/session-orchestrator
   npx claude-session-orchestrator hooks local local   # status hooks, so the server knows when a session waits for you
   npx claude-session-orchestrator serve      # keep running (systemd/launchd) so the hooks have somewhere to report
   ```
2. Install the plugin:
   ```
   /plugin marketplace add division-software/claude-session-orchestrator
   /plugin install session-orchestrator-local@session-orchestrator
   ```
3. Ask: "Start a new project called side quest" or "How are my projects doing?"

Without the plugin, `npx claude-session-orchestrator install claude` (or `codex`, `cursor`, `print`) registers the same server and skill directly.

## License

MIT
