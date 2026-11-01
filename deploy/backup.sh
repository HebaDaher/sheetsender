#!/bin/sh
# Daily backup of the database and media library (keeps 14 days). Installed by SETUP.md step 9.
set -e
mkdir -p /opt/sheetsender-backups
STAMP=$(date +%Y-%m-%d)
sqlite3 /opt/sheetsender/data/app.db ".backup '/opt/sheetsender-backups/app-$STAMP.db'"
tar -czf /opt/sheetsender-backups/media-$STAMP.tar.gz -C /opt/sheetsender/data media
find /opt/sheetsender-backups -type f -mtime +14 -delete
