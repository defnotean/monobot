#!/usr/bin/env bash
# ─── monobot foreground launcher ─────────────────────────────────────────
# Stops the systemd 24/7 services, runs both bots attached to this terminal
# with live colored log output, and re-arms systemd when you Ctrl-C / close.
#
# Usage (local):     ./launch.sh
# Usage (over SSH):  ssh -t defnotean@<host> /home/defnotean/Desktop/Claude/monobot/launch.sh
# Usage (Windows):   launch.bat  (drives this script over SSH)

set -uo pipefail

REPO="/home/defnotean/Desktop/Claude/monobot"
ERIS_LOG="/tmp/monobot-launcher-eris.log"
IRENE_LOG="/tmp/monobot-launcher-irene.log"
ERIS_PID=""
IRENE_PID=""
TAIL_PIDS=()

# Colors
RED='\033[0;31m'; GRN='\033[0;32m'; YEL='\033[0;33m'
CYN='\033[0;36m'; MAG='\033[0;35m'; RST='\033[0m'; BLD='\033[1m'

cleanup() {
  trap '' EXIT INT TERM   # idempotent — don't recurse
  echo ""
  echo -e "${YEL}🛑 Shutting down launcher...${RST}"

  # Stop tailers first so they don't spam during bot shutdown
  for pid in "${TAIL_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done

  # Kill foreground bots (SIGTERM then SIGKILL fallback)
  if [ -n "$ERIS_PID" ] && kill -0 "$ERIS_PID" 2>/dev/null; then
    echo "  • Stopping Eris (pid=$ERIS_PID)..."
    kill -- -"$ERIS_PID" 2>/dev/null || kill "$ERIS_PID" 2>/dev/null || true
  fi
  if [ -n "$IRENE_PID" ] && kill -0 "$IRENE_PID" 2>/dev/null; then
    echo "  • Stopping Irene (pid=$IRENE_PID)..."
    kill -- -"$IRENE_PID" 2>/dev/null || kill "$IRENE_PID" 2>/dev/null || true
  fi
  sleep 2
  [ -n "$ERIS_PID" ]  && kill -9 -- -"$ERIS_PID"  2>/dev/null || true
  [ -n "$IRENE_PID" ] && kill -9 -- -"$IRENE_PID" 2>/dev/null || true

  # Free the ports if a runaway node child is still bound
  for port in 3000 3001; do
    pid=$(ss -tnlp 2>/dev/null | grep ":$port " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  sleep 1

  echo -e "${YEL}🔄 Restoring systemd 24/7 mode...${RST}"
  systemctl --user start monobot-eris.service monobot-irene.service 2>&1 | sed 's/^/  /'
  sleep 2
  echo ""
  echo -e "${GRN}✅ systemd is back in control. Bye!${RST}"
  exit 0
}
trap cleanup EXIT INT TERM

# Sanity checks
if [ ! -d "$REPO" ]; then
  echo -e "${RED}❌ Repo not found at $REPO${RST}"; exit 1
fi
if ! command -v systemctl >/dev/null; then
  echo -e "${RED}❌ systemctl missing — this launcher needs systemd${RST}"; exit 1
fi

# Stop systemd (so we don't double-run)
echo -e "${YEL}⏸️  Stopping systemd services...${RST}"
systemctl --user stop monobot-eris.service monobot-irene.service 2>&1 | sed 's/^/  /' || true
sleep 3   # let ports free up

# Each bot in its own process group so we can SIGTERM the whole tree on exit
echo -e "${YEL}▶️  Starting Eris in foreground...${RST}"
( cd "$REPO" && exec setsid npm run start:eris >"$ERIS_LOG" 2>&1 ) &
ERIS_PID=$!

echo -e "${YEL}▶️  Starting Irene in foreground...${RST}"
( cd "$REPO" && exec setsid npm run start:irene >"$IRENE_LOG" 2>&1 ) &
IRENE_PID=$!

sleep 3

# Sanity: did either die immediately?
if ! kill -0 "$ERIS_PID" 2>/dev/null; then
  echo -e "${RED}❌ Eris failed to start. Last log lines:${RST}"; tail -20 "$ERIS_LOG"
  exit 1
fi
if ! kill -0 "$IRENE_PID" 2>/dev/null; then
  echo -e "${RED}❌ Irene failed to start. Last log lines:${RST}"; tail -20 "$IRENE_LOG"
  exit 1
fi

echo ""
echo -e "${GRN}${BLD}✨ Both bots launched${RST} — Eris pid=$ERIS_PID, Irene pid=$IRENE_PID"
echo -e "${BLD}📜 Tailing logs. Ctrl-C exits this launcher and re-arms systemd 24/7 mode.${RST}"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""

# Tail with colored prefixes
( tail -F "$ERIS_LOG"  2>/dev/null | sed -u "s/^/$(printf '%b' "${CYN}[ERIS ]${RST}") /" ) &
TAIL_PIDS+=($!)
( tail -F "$IRENE_LOG" 2>/dev/null | sed -u "s/^/$(printf '%b' "${MAG}[IRENE]${RST}") /" ) &
TAIL_PIDS+=($!)

# Wait for either bot to die naturally (then trigger cleanup via EXIT trap)
wait "$ERIS_PID" "$IRENE_PID"
