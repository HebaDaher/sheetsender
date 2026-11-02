#!/bin/bash
# Shop Follow-ups — WhatsApp Sender. Run with:  bash ~/Desktop/shop-followups/whatsapp/"WhatsApp Sender.command"
cd "$(dirname "$0")" || exit 1
VENV="$HOME/.shop-followups/venv"
say()  { printf "\n\033[1;32m==> %s\033[0m\n" "$1"; }
fail() { printf "\n\033[1;31m%s\033[0m\n\n" "$1"; read -r -p "Press Enter to close."; exit 1; }

if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
  open "https://www.python.org/downloads/macos/"
  fail "Python 3.9 or newer is needed. Install it from the page that just opened, then run this again."
fi

if [ ! -x "$VENV/bin/python" ] || ! "$VENV/bin/python" -c "import playwright" 2>/dev/null; then
  say "First time only: installing the WhatsApp Sender (2-3 minutes)…"
  mkdir -p "$HOME/.shop-followups"
  python3 -m venv "$VENV" || fail "Could not create the Python environment."
  "$VENV/bin/python" -m pip install --quiet --upgrade pip playwright || fail "Could not install Playwright. Check the internet connection and try again."
  "$VENV/bin/python" -m playwright install chromium || fail "Could not download the browser. Try again."
fi

say "Starting the WhatsApp Sender. Keep this window open and the Mac awake. Press Ctrl+C to stop."
caffeinate -i "$VENV/bin/python" whatsapp_sender.py "$@"
read -r -p "Press Enter to close."
