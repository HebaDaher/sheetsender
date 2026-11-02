#!/bin/bash
# Shop Follow-ups — installs the WhatsApp Sender helper on THIS Mac (the one where WhatsApp will run). Run once:
#   bash ~/Desktop/shop-followups/whatsapp/"Install WhatsApp Sender.command"
# After this, the helper starts by itself whenever the Mac starts; everything is controlled from the app's WhatsApp tab.
cd "$(dirname "$0")/.." || exit 1
say()  { printf "\n\033[1;32m==> %s\033[0m\n" "$1"; }
fail() { printf "\n\033[1;31m%s\033[0m\n\n" "$1"; read -r -p "Press Enter to close."; exit 1; }
DATA="$HOME/.shop-followups"; VENV="$DATA/venv"; APP="$DATA/app"
LABEL="com.shopfollowups.whatsapp"; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -f .clasp.json ] && [ -f .deployment-id ] || fail "Run Install.command first (it publishes the app), then run this again."
command -v node >/dev/null 2>&1 || fail "Node.js is missing. Run Install.command first."
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
  open "https://www.python.org/downloads/macos/"
  fail "Python 3.9 or newer is needed. Install it from the page that just opened, then run this again."
fi

say "Step 1 of 4: installing the WhatsApp Sender (first time 2-3 minutes)"
mkdir -p "$DATA"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV" || fail "Could not create the Python environment."
"$VENV/bin/python" -m pip install --quiet --upgrade pip playwright || fail "Could not install Playwright. Check the internet connection and try again."
"$VENV/bin/python" -m playwright install chromium || fail "Could not download the browser. Try again."

say "Step 2 of 4: connecting the helper to your app (secure private link)"
bash whatsapp/deploy-bridge.sh || fail "Could not create the private link. Try again."

say "Step 3 of 4: starting the helper (it will also start by itself when the Mac starts)"
mkdir -p "$APP" "$HOME/Library/LaunchAgents"
cp whatsapp/whatsapp_sender.py whatsapp/whatsapp_helper.py "$APP/"
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
launchctl bootstrap "gui/$(id -u)" "$PLIST" || fail "Could not start the helper."

say "Step 4 of 4: checking"
OK=""
for i in $(seq 1 20); do
  sleep 3
  if grep -q "helper v" "$DATA/helper.log" 2>/dev/null && ! tail -n 3 "$DATA/helper.log" | grep -q "Cannot reach the app"; then OK=1; break; fi
done
tail -n 5 "$DATA/helper.log" 2>/dev/null
if [ -n "$OK" ]; then
  say "Done. Open the app → choose a shop → WhatsApp tab. You should see 'The WhatsApp Sender is running'."
  echo "Click 'Open WhatsApp on the Mac' and scan the QR code with the phone the first time."
else
  echo "The helper started but has not reached the app yet. Wait one minute and open the WhatsApp tab in the app."
  echo "If it still says 'not running', send the lines above to whoever set this up."
fi
read -r -p "Press Enter to close."
