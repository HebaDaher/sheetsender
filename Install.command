#!/bin/bash
# Shop Follow-ups — one-time installer (also used for updates). Double-click this file in Finder.
cd "$(dirname "$0")" || exit 1

say()  { printf "\n\033[1;32m==> %s\033[0m\n" "$1"; }
fail() { printf "\n\033[1;31m%s\033[0m\n\n" "$1"; read -r -p "Press Enter to close."; exit 1; }
CLASP="npx --yes @google/clasp@3"

# Node.js 22+ is needed for clasp.
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  open "https://nodejs.org/en/download"
  fail "Node.js 22 or newer is needed. Install the LTS version from the page that just opened, then double-click Install.command again."
fi

if [ ! -f .clasp.json ]; then
  say "Step 1 of 5: allow Apps Script access"
  echo "A page opens. Signed in as the OWNER Google account, switch 'Google Apps Script API' ON."
  open "https://script.google.com/home/usersettings"
  read -r -p "Press Enter here when it is ON... "
fi

if [ ! -f "$HOME/.clasprc.json" ]; then
  say "Step 2 of 5: sign in to Google"
  echo "Your browser opens. Choose the OWNER account and click Allow (Continue)."
  $CLASP login || fail "Sign-in did not finish. Double-click Install.command to try again."
fi

if [ ! -f .clasp.json ]; then
  say "Step 3 of 5: create the Apps Script project"
  $CLASP create-script --type standalone --title "Shop Follow-ups" --rootDir src \
    || fail "Could not create the project. Check that 'Google Apps Script API' is ON (step 1), then try again."
fi
cp config/appsscript.json src/appsscript.json

say "Step 4 of 5: upload the code"
$CLASP push --force || fail "Upload failed. Check your internet connection and try again."

# An update that needs a NEW Google permission: the administrator allows it in the editor BEFORE the new version is
# published, so the live app never runs without it. (First installs allow everything with 'setup' at the end.)
SCOPES="$(python3 -c 'import json;print(" ".join(sorted(json.load(open("config/appsscript.json"))["oauthScopes"])))')"
if [ -f .deployment-id ] && [ "$(cat .authorized-scopes 2>/dev/null)" != "$SCOPES" ]; then
  say "One extra step for this update: allow a new permission"
  echo "This update adds photos and videos for WhatsApp. They are kept in your Google Drive, in a folder the app makes."
  echo "Google asks you once to allow it (the app can only see the files it makes itself, nothing else in your Drive)."
  echo
  echo "  1. The script editor opens in your browser. Click Code.gs on the left."
  echo "  2. At the top, choose 'authorize' in the function menu and click Run."
  echo "  3. Review permissions -> choose the owner account -> Advanced -> Go to Shop Follow-ups (unsafe) -> Allow."
  echo "  4. When the log at the bottom says 'Thank you', come back here."
  $CLASP open-script
  read -r -p "Press Enter here after you clicked Allow... "
fi
echo "Publishing the private WhatsApp link (used by the Macs that send WhatsApp messages)..."
bash whatsapp/deploy-bridge.sh || echo "The WhatsApp link could not be published this time (the rest of the app is fine). Run Install.command again later."

say "Step 5 of 5: publish the web app"
if [ -f .deployment-id ]; then
  ID="$(cat .deployment-id)"
  $CLASP create-deployment --deploymentId "$ID" --description "update $(date +%Y-%m-%d)" \
    || fail "Publishing the update failed. Try again."
else
  OUT="$($CLASP create-deployment --description "v1" 2>&1)"
  echo "$OUT"
  ID="$(echo "$OUT" | grep -oE 'AKfyc[A-Za-z0-9_-]+' | head -1)"
  [ -n "$ID" ] || fail "Could not read the web app ID from the output above."
  echo "$ID" > .deployment-id
fi

# The app's own link is where Google sends people back after "Sign in with Google" / "Allow".
URL="https://script.google.com/macros/s/$ID/exec"
CFG="const APP_URL = '$URL'; // made by Install.command: Google sends people back here after signing in"
if [ "$(cat src/App.config.gs 2>/dev/null)" != "$CFG" ]; then
  echo "$CFG" > src/App.config.gs
  $CLASP push --force >/dev/null && $CLASP create-deployment --deploymentId "$ID" --description "app link $(date +%Y-%m-%d)" >/dev/null \
    || fail "Saving the app link failed. Double-click Install.command again."
fi

if [ -f "$HOME/Library/LaunchAgents/com.shopfollowups.whatsapp.plist" ]; then
  mkdir -p "$HOME/.shop-followups/app" && cp whatsapp/whatsapp_sender.py whatsapp/whatsapp_helper.py "$HOME/.shop-followups/app/" 2>/dev/null
  launchctl kickstart -k "gui/$(id -u)/com.shopfollowups.whatsapp" 2>/dev/null
fi

echo "$SCOPES" > .authorized-scopes
echo "$URL" > "App link.txt"
say "Uploaded and published."
echo "App link (also saved in 'App link.txt'):"
echo "  $URL"
echo
echo "Google Cloud check (once): Google Auth Platform -> Clients -> your client -> 'Authorized redirect URIs'"
echo "must include exactly:  $URL"
echo
if [ ! -f .setup-shown ]; then
  echo "LAST STEP: the script editor opens in your browser."
  echo "  1. Click Code.gs on the left."
  echo "  2. At the top, choose 'setup' in the function menu and click Run."
  echo "  3. Review permissions -> choose the owner account -> Advanced -> Go to Shop Follow-ups (unsafe) -> Allow."
  echo "  4. Then open the app link above and continue with the guide (Google Cloud sign-in)."
  touch .setup-shown
  $CLASP open-script
fi
read -r -p "Press Enter to close."
