#!/bin/bash
# Shop Follow-ups — sets up the WhatsApp Sender on THIS Mac for one workspace.
# Used from the app (WhatsApp tab → "Set up a Mac"), which shows the exact line to paste in Terminal:
#   curl -fsSL https://hebadaher.github.io/sheetsender/mac/install.sh | bash -s -- '<app link>' '<secret>'
# Safe to run again (it updates the helper and switches this Mac to the workspace of the new line).
set -u
URL="${1:-}"; TOKEN="${2:-}"
BASE="https://hebadaher.github.io/sheetsender/mac"
DATA="$HOME/.shop-followups"; VENV="$DATA/venv"; APP="$DATA/app"
LABEL="com.shopfollowups.whatsapp"; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
say()  { printf "\n\033[1;32m==> %s\033[0m\n" "$1"; }
fail() { printf "\n\033[1;31m%s\033[0m\n\n" "$1"; exit 1; }

[ "$(uname)" = "Darwin" ] || fail "This is for a Mac."
echo "$URL" | grep -qE '^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$' || fail "The line was not copied completely. Copy it again from the app (WhatsApp tab → Set up a Mac)."
echo "$TOKEN" | grep -qE '^[0-9a-f]{64}$' || fail "The line was not copied completely. Copy it again from the app (WhatsApp tab → Set up a Mac)."
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
  open "https://www.python.org/downloads/macos/"
  fail "Python 3.9 or newer is needed. Install it from the page that just opened (Download → open the file → Continue…), then paste the same line again."
fi

say "Step 1 of 4: installing the WhatsApp Sender (first time 2-3 minutes)"
mkdir -p "$DATA" "$APP" "$HOME/Library/LaunchAgents"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV" || fail "Could not create the Python environment."
"$VENV/bin/python" -m pip install --quiet --upgrade pip playwright || fail "Could not install Playwright. Check the internet connection and paste the line again."
"$VENV/bin/python" -m playwright install chromium || fail "Could not download the browser. Paste the line again."
for f in whatsapp_sender.py whatsapp_helper.py; do
  curl -fsSL "$BASE/$f" -o "$APP/$f.new" && mv "$APP/$f.new" "$APP/$f" || fail "Could not download $f. Check the internet connection and paste the line again."
done

say "Step 2 of 4: linking this Mac to your workspace"
python3 - "$DATA/bridge.json" "$URL" "$TOKEN" <<'PY' || fail "Could not save the link."
import json, os, sys
p, url, token = sys.argv[1:4]
json.dump({"url": url, "token": token}, open(p, "w"), indent=1)
os.chmod(p, 0o600)
PY

say "Step 3 of 4: starting the helper (it also starts by itself when the Mac starts)"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$VENV/bin/python</string><string>$APP/whatsapp_helper.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DATA/helper.log</string>
  <key>StandardErrorPath</key><string>$DATA/helper.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
: > "$DATA/helper.log"
launchctl bootstrap "gui/$(id -u)" "$PLIST" || fail "Could not start the helper."

say "Step 4 of 4: checking"
OK=""
for i in $(seq 1 20); do
  sleep 3
  if grep -q "helper v" "$DATA/helper.log" 2>/dev/null && ! tail -n 3 "$DATA/helper.log" | grep -q "Cannot reach the app"; then OK=1; break; fi
done
tail -n 3 "$DATA/helper.log" 2>/dev/null
if [ -n "$OK" ]; then
  say "Done. Go back to the app: the WhatsApp tab shows 'WhatsApp Sender is running'."
  echo "Click 'Open WhatsApp on the Mac' there and scan the QR code with the phone (WhatsApp → Settings → Linked devices)."
else
  echo "The helper started but has not reached the app yet. Wait one minute and look at the WhatsApp tab in the app."
fi
echo "(To remove it later: launchctl bootout gui/\$(id -u)/$LABEL; rm -rf ~/.shop-followups ~/Library/LaunchAgents/$LABEL.plist)"
