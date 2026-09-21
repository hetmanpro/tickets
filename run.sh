#!/bin/bash
# Self-healing runner for monitor.js. If monitor.js crashes for any reason, this
# restarts it automatically after a short pause, and logs/notifies about the restart,
# so you don't have to babysit the Terminal window.
cd "$(dirname "$0")"

while true; do
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting monitor.js" >> monitor.log
  node monitor.js
  EXIT_CODE=$?
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] monitor.js exited (code $EXIT_CODE) — restarting in 5s" >> monitor.log
  osascript -e 'display notification "monitor.js crashed and is restarting automatically" with title "TicketSwap monitor" sound name "Sosumi"' 2>/dev/null
  sleep 5
done
