# Session Orchestrator (self-hosted)

The same tools and `manage-sessions` skill as the hosted plugin, but the MCP server runs **on your own machine** (`npx -y claude-session-orchestrator stdio`). No hosted service, no sign-in. It works in Claude Code, Codex and Cursor, which all read this plugin format.

> **Plugin not usable yet:** it launches the server from the npm package, which is not published. Until then, do step 1 (its `install claude` line which registers the same server and skill) and skip step 2.

## Setup

1. One time, on the machine that runs your sessions (Node 24+, tmux, git):
   ```sh
   git clone https://github.com/division-software/claude-session-orchestrator && cd claude-session-orchestrator
   npm ci && npm run build
   node dist/cli.js init                # config, tokens and this machine in ~/.config/session-orchestrator
   node dist/cli.js install claude      # or codex, cursor, print: registers the server and skill without the plugin
   node dist/cli.js hooks local local   # status hooks, so the server knows when a session waits for you
   node dist/cli.js serve               # keep running (systemd/launchd) so the hooks have somewhere to report
   ```
2. Install the plugin:
   ```
   /plugin marketplace add division-software/claude-session-orchestrator
   /plugin install session-orchestrator-local@session-orchestrator
   ```
3. Ask: "Start a new project called side quest" or "How are my projects doing?"

Without the plugin, `node dist/cli.js install claude` (or `codex`, `cursor`, `print`) registers the same server and skill directly.

## License

MIT
