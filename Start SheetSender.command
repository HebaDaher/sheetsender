#!/bin/bash
# ============================================================
#  SheetSender — double-click this file to start it on your Mac.
#  Keep this window open: messages are sent while it is running.
#  To stop SheetSender, close this window (or press Ctrl+C).
# ============================================================
cd "$(dirname "$0")" || exit 1
APP_DIR="$(pwd)"
DATA="$HOME/Library/Application Support/SheetSender"
mkdir -p "$DATA"
export DATA_DIR="$DATA/data"
export ENV_FILE="$DATA/settings.env"
PORT=3000

echo ""
echo "  SheetSender is starting…"
echo ""

# ---- 1. Node.js (downloaded once into this folder, nothing installed system-wide) ----
need_node() {
  command -v "$1" >/dev/null 2>&1 || return 0
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?1:0)'
}
NODE="node"
if need_node node; then
  NODE="$DATA/runtime/node/bin/node"
  if need_node "$NODE"; then
    ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && ARCH="x64"
    echo "  Downloading Node.js (one time only)…"
    BASE="https://nodejs.org/dist/latest-v22.x"
    SUMS=$(curl -fsSL "$BASE/SHASUMS256.txt") || { echo "  Could not reach nodejs.org — check your internet and try again."; read -r; exit 1; }
    FILE=$(echo "$SUMS" | grep -o "node-v22[^ ]*-darwin-$ARCH.tar.gz" | head -1)
    SUM=$(echo "$SUMS" | grep " $FILE\$" | cut -d' ' -f1)
    TMP=$(mktemp -d)
    curl -fsSL "$BASE/$FILE" -o "$TMP/node.tgz" || { echo "  Download failed."; read -r; exit 1; }
    if [ "$(shasum -a 256 "$TMP/node.tgz" | cut -d' ' -f1)" != "$SUM" ]; then echo "  Download check failed (file damaged). Try again."; read -r; exit 1; fi
    mkdir -p "$DATA/runtime" && rm -rf "$DATA/runtime/node"
    tar -xzf "$TMP/node.tgz" -C "$TMP" && mv "$TMP"/node-v22*-darwin-"$ARCH" "$DATA/runtime/node"
    rm -rf "$TMP"
    echo "  Node.js ready."
  fi
fi

# ---- 2. First start: create your private settings file ----
if [ ! -f "$ENV_FILE" ]; then
  echo "  First start — let's set your dashboard password."
  echo "  (At least 10 characters. Nothing is shown while you type — that's normal.)"
  while true; do
    read -r -s -p "  Choose a password: " PW1; echo ""
    read -r -s -p "  Type it again:     " PW2; echo ""
    if [ "${#PW1}" -lt 10 ]; then echo "  Too short — use at least 10 characters."; continue; fi
    if [ "$PW1" != "$PW2" ]; then echo "  They don't match — try again."; continue; fi
    break
  done
  {
    echo "# SheetSender private settings — never share this file."
    echo "BASE_URL=http://localhost:$PORT"
    echo "PORT=$PORT"
    echo "HOST=127.0.0.1"
    echo "ADMIN_PASSWORD=$PW1"
    "$NODE" scripts/gen-secrets.js | grep '='
    echo "GOOGLE_CLIENT_ID="
    echo "GOOGLE_CLIENT_SECRET="
    echo "MICROSOFT_CLIENT_ID="
    echo "MICROSOFT_CLIENT_SECRET="
    echo "META_APP_SECRET="
    echo "POLL_SECONDS=60"
    echo "GMAIL_DAILY_LIMIT=400"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  unset PW1 PW2
  echo "  Saved. Your settings are in: $ENV_FILE"
fi

# ---- 3. Start the dashboard and the background sender (restart automatically if they stop) ----
keep_running() { while true; do "$NODE" --no-warnings "$1" >> "$DATA/$2.log" 2>&1; echo "  ($2 restarted)"; sleep 3; done; }
keep_running server.js web & WEB=$!
keep_running worker.js worker & WORKER=$!
trap 'echo ""; echo "  Stopping SheetSender…"; pkill -P $WEB 2>/dev/null; pkill -P $WORKER 2>/dev/null; kill $WEB $WORKER 2>/dev/null; exit 0' INT TERM HUP EXIT
# Stop the Mac from falling asleep while SheetSender runs (the screen can still turn off).
caffeinate -i -w $$ &

sleep 2
open "http://localhost:$PORT"
echo ""
echo "  ✅ SheetSender is running:  http://localhost:$PORT"
echo "     Keep this window open. Close it to stop sending."
echo "     Logs: $DATA"
echo ""
wait
