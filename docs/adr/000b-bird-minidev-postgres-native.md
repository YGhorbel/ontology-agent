# ADR 000b — BIRD mini-dev databases use the native PostgreSQL build

**Status:** Accepted — 2026-06-13

The 11 BIRD mini-dev databases in the `docker-compose.dev-databases.yml` stack
are loaded from the repo's **native PostgreSQL artifact**
(`MINIDEV_postgresql/BIRD_dev.sql`, a single `pg_dump`), not from the
SQLite→pgloader conversion that originally populated them. The SQLite path was
the root cause of the bad builds: its two heaviest pgloader jobs
(`codebase_community`, `european_football_2`) hung and silently left those
databases with full schemas but **zero rows**, while offering no guarantee the
other nine matched the canonical Postgres data. We now slice the combined native
dump per database by table membership (it has no `CREATE DATABASE`/`\connect`
delimiters — all 75 tables live in one `public` schema, cleanly partitioned with
no cross-DB name collisions), strip its `OWNER TO` lines, and reload each running
container with `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` followed by
its slice — idempotently, one DB at a time, under `ON_ERROR_STOP=1`. Reloads go
**into the already-running containers; images and containers are never rebuilt.**
Verification confirms every database matches the native dump on table count,
row counts, and declared PRIMARY/FOREIGN KEY counts — the last of these matters
because the ontology generator treats declared constraints as its
highest-confidence provenance tier.
