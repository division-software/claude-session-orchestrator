#!/bin/sh
# Restart the orchestrator when /health fails 3 times in a row (20 s apart): a hung process, a broken
# database, or a cloud link down for 5+ minutes. Safe for sessions: the unit uses KillMode=process and
# tmux runs in its own scope, so a restart only replaces the node process.
# Usage (systemd user timer, see orchestrator-health.timer): healthcheck.sh [unit] [port]
unit=${1:-session-orchestrator} port=${2:-8787}
for i in 1 2 3; do
  curl -fsS -m 10 "http://127.0.0.1:$port/health" >/dev/null 2>&1 && exit 0
  [ $i -lt 3 ] && sleep 20
done
echo "health check failed 3 times; restarting $unit"
exec systemctl --user restart "$unit"
