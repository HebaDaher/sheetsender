#!/bin/bash
# Publishes (or updates) the private "bridge" link that the WhatsApp Sender helper on this Mac uses to talk to the app.
# It is a second deployment of the same Apps Script project that runs as the owner and accepts only requests with the
# helper's secret token. Called by "Install WhatsApp Sender.command" and, when present, by Install.command.
# Run from the project folder (the one with .clasp.json).
set -u
CLASP="npx --yes @google/clasp@3"
DATA="$HOME/.shop-followups"
mkdir -p "$DATA"

# 1. Secret token (stays on this Mac) and its SHA-256 for the app.
python3 - "$DATA/bridge.json" "src/Bridge.config.gs" <<'PY' || exit 1
import json, hashlib, secrets, sys, os
cfg_path, gs_path = sys.argv[1], sys.argv[2]
try: cfg = json.load(open(cfg_path))
except Exception: cfg = {}
if not cfg.get("token"):
    cfg["token"] = secrets.token_urlsafe(32)
json.dump(cfg, open(cfg_path, "w"), indent=1); os.chmod(cfg_path, 0o600)
sha = hashlib.sha256(cfg["token"].encode()).hexdigest()
open(gs_path, "w").write("/** Made by the WhatsApp Sender installer. Fingerprint of the helper's secret token (the token stays on the Mac). */\nconst BRIDGE_TOKEN_SHA256 = '%s';\n" % sha)
PY

# 2. Push the code with the bridge settings (runs as the owner, reachable by the helper), publish, then restore.
python3 - <<'PY' || exit 1
import json
m = json.load(open("config/appsscript.json"))
m["webapp"] = {"executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS"}
json.dump(m, open("src/appsscript.json", "w"), indent=2)
PY
$CLASP push --force >/dev/null || { cp config/appsscript.json src/appsscript.json; echo "Upload for the bridge failed."; exit 1; }
if [ -f .bridge-deployment-id ]; then
  BID="$(cat .bridge-deployment-id)"
  $CLASP create-deployment --deploymentId "$BID" --description "WhatsApp bridge $(date +%Y-%m-%d)" >/dev/null || { cp config/appsscript.json src/appsscript.json; $CLASP push --force >/dev/null; echo "Updating the bridge failed."; exit 1; }
else
  OUT="$($CLASP create-deployment --description "WhatsApp bridge (do not delete)" 2>&1)"
  BID="$(echo "$OUT" | grep -oE 'AKfyc[A-Za-z0-9_-]+' | head -1)"
  [ -n "$BID" ] || { cp config/appsscript.json src/appsscript.json; $CLASP push --force >/dev/null; echo "$OUT"; echo "Could not create the bridge."; exit 1; }
  echo "$BID" > .bridge-deployment-id
fi
cp config/appsscript.json src/appsscript.json
$CLASP push --force >/dev/null || { echo "Restoring the app settings failed. Run Install.command again."; exit 1; }

python3 - "$DATA/bridge.json" "https://script.google.com/macros/s/$BID/exec" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1])); cfg["url"] = sys.argv[2]
json.dump(cfg, open(sys.argv[1], "w"), indent=1)
PY
echo "Bridge ready."
