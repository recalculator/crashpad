#!/bin/sh
# Copy the Crashpad service state to a dated file and keep the newest $CRASHPAD_BACKUP_KEEP.
# The service writes state.json by atomic rename, so a plain copy is always a complete file.
# These copies are on the same disk: also enable your host's volume snapshots or copy
# $CRASHPAD_BACKUP_DIR off the host (docs/github-app.md, "Persistent storage").
set -eu
DATA="${CRASHPAD_SERVICE_DATA:?set CRASHPAD_SERVICE_DATA}"
DIR="${CRASHPAD_BACKUP_DIR:-$(dirname "$DATA")/backups}"
KEEP="${CRASHPAD_BACKUP_KEEP:-14}"
if [ ! -f "$DATA" ]; then
  echo "crashpad-backup: $DATA does not exist yet (no state to back up)"
  exit 0
fi
umask 077
mkdir -p "$DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TMP="$DIR/.state-$STAMP.json.tmp"
cp "$DATA" "$TMP"
# Refuse to keep a copy that is not valid JSON.
if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$TMP"; then
  rm -f "$TMP"
  echo "crashpad-backup: $DATA is not valid JSON; nothing was kept" >&2
  exit 1
fi
mv "$TMP" "$DIR/state-$STAMP.json"
# Prune: keep the newest $KEEP backups.
ls -1 "$DIR"/state-*.json 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f "$old"; done
echo "crashpad-backup: $DIR/state-$STAMP.json ($(ls -1 "$DIR"/state-*.json | wc -l | tr -d ' ') kept)"
