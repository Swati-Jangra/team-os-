#!/usr/bin/env bash
# Logical backup of the TeamOS database (custom format, compressed) plus the meeting-audio volume.
#   DIRECT_URL=postgresql://migrator:...@host/teamos ./scripts/ops/backup.sh [outdir]
# Uses the schema-owner role (needs to read everything; app_user is subject to RLS and would dump nothing useful).
set -euo pipefail
: "${DIRECT_URL:?set DIRECT_URL to the migrator connection string}"
out="${1:-./backups}"; mkdir -p "$out"; ts=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump --format=custom --no-owner --no-privileges --file "$out/teamos-$ts.dump" "$DIRECT_URL"
if [ -n "${STORAGE_DIR:-}" ] && [ -d "$STORAGE_DIR" ]; then tar -C "$STORAGE_DIR" -czf "$out/storage-$ts.tgz" .; fi
# a backup nobody has restored is not a backup: list the archive to prove it is readable
pg_restore --list "$out/teamos-$ts.dump" > /dev/null
echo "ok: $out/teamos-$ts.dump"
