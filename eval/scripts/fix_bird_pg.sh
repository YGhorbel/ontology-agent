#!/usr/bin/env bash
#
# Phase B — reload all 11 BIRD mini-dev Postgres databases from the repo's
# NATIVE pg_dump (MINIDEV_postgresql/BIRD_dev.sql), NOT the SQLite/pgloader path
# that produced the bad builds. Reloads go into the already-running containers;
# images are never rebuilt.
#
# Per database: split the combined dump into a per-DB slice (by table
# membership), then  DROP SCHEMA public CASCADE; CREATE SCHEMA public;  and load
# the slice. Idempotent / re-runnable, one DB at a time, ON_ERROR_STOP=1.
#
# Credentials/ports are read from the compose file (no hardcoded secrets).
# Override the mini-dev location with MINIDEV_DIR=... if needed.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MINIDEV="${MINIDEV_DIR:-/home/yassinegprd/Downloads/minidev_0703/minidev}"
SQL="$MINIDEV/MINIDEV_postgresql/BIRD_dev.sql"
COMPOSE="$MINIDEV/docker-compose.dev-databases.yml"
SLICES="$HERE/slices"
MAP="$SLICES/table_db_map.tsv"
CONN="$SLICES/conn_map.tsv"
HOST="${PGHOST:-localhost}"

mkdir -p "$SLICES"

[ -f "$SQL" ] || { echo "FATAL: native Postgres SQL not found: $SQL" >&2; exit 1; }
[ -f "$COMPOSE" ] || { echo "FATAL: compose file not found: $COMPOSE" >&2; exit 1; }
# HARD FACT: must be the POSTGRESQL BIRD_dev.sql, never the mysql twin.
case "$SQL" in
  *MINIDEV_postgresql*) : ;;
  *) echo "FATAL: refusing BIRD_dev.sql outside MINIDEV_postgresql: $SQL" >&2; exit 1 ;;
esac

echo "==> Parsing connection map from compose"
python3 "$HERE/parse_compose.py" "$COMPOSE" > "$CONN"
nconn=$(wc -l < "$CONN")
echo "    $nconn Postgres servers found"
[ "$nconn" -eq 11 ] || { echo "FATAL: expected 11 servers, got $nconn" >&2; exit 1; }

# Build the authoritative table->db membership map from the live containers.
# (Schemas of all 11 DBs are present even where data was empty; this matches the
# native dump 1:1.) Cached so a re-run after a partial wipe cannot corrupt it.
if [ ! -s "$MAP" ]; then
  echo "==> Building table->db membership map from live containers"
  : > "$MAP"
  while IFS=$'\t' read -r db port user pass; do
    PGPASSWORD="$pass" psql -h "$HOST" -p "$port" -U "$user" -d "$db" -tAc \
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" \
      | while IFS= read -r t; do
          [ -n "$t" ] && printf '%s\t%s\n' "$t" "$db" >> "$MAP"
        done
  done < "$CONN"
  echo "    $(wc -l < "$MAP") tables mapped"
else
  echo "==> Reusing cached membership map ($(wc -l < "$MAP") tables)"
fi

echo "==> Splitting native dump into per-database slices"
python3 "$HERE/split_bird_dev.py" --sql "$SQL" --map "$MAP" --outdir "$SLICES"

echo
echo "==> Reloading databases (one at a time)"
while IFS=$'\t' read -r db port user pass; do
  slice="$SLICES/$db.sql"
  [ -s "$slice" ] || { echo "FATAL: missing/empty slice for $db: $slice" >&2; exit 1; }
  echo "------------------------------------------------------------"
  echo "[$db] port=$port  slice=$(basename "$slice") ($(wc -l < "$slice") lines)"
  echo "[$db] DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
  PGPASSWORD="$pass" psql -h "$HOST" -p "$port" -U "$user" -d "$db" -v ON_ERROR_STOP=1 -q \
    -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
  echo "[$db] loading native slice ..."
  PGPASSWORD="$pass" psql -h "$HOST" -p "$port" -U "$user" -d "$db" -v ON_ERROR_STOP=1 -q \
    -f "$slice"
  ntab=$(PGPASSWORD="$pass" psql -h "$HOST" -p "$port" -U "$user" -d "$db" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
  echo "[$db] DONE — $ntab tables present"
done < "$CONN"

echo
echo "==> Phase B complete. All 11 databases reloaded from native pg_dump."
echo "    Run verify_bird_pg.py for the Phase C acceptance report."
