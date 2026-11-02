#!/bin/bash
# Stops the WhatsApp Sender helper and removes it from starting with the Mac. Your WhatsApp link stays until you
# remove it on the phone (WhatsApp → Settings → Linked devices).
LABEL="com.shopfollowups.whatsapp"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "The WhatsApp Sender helper is stopped and will not start again."
read -r -p "Press Enter to close."
