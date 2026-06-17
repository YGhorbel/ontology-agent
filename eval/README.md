# BIRD mini-dev — native PostgreSQL eval substrate

This directory holds the tooling that loads the 11 BIRD mini-dev databases into a
running Docker Compose stack of Postgres servers, from the repo's **native
PostgreSQL `pg_dump`** — *not* from the SQLite→pgloader path that produced the
earlier bad builds (see [`../docs/adr/000b-bird-minidev-postgres-native.md`](../docs/adr/000b-bird-minidev-postgres-native.md)).

> Scope: diagnose → reload → verify. No eval harness / matcher / metrics here,
> and no ontology generation — those are later steps.

## Compose topology

The stack lives at `…/minidev_0703/minidev/docker-compose.dev-databases.yml`
(`MINIDEV_DIR`, default `/home/yassinegprd/Downloads/minidev_0703/minidev`). It
defines **11 `postgres:16-alpine` servers** (one DB each, user/pass `dev`/`dev`,
named volume `<db>_pgdata`) plus 11 `dimitri/pgloader` jobs. The pgloader jobs
are the *original* loader and the root cause of the bad data — we no longer use
them; we reload the running servers in place.

| Database                  | Host port | Container                              | Connection URL |
|---------------------------|-----------|---------------------------------------|----------------|
| formula1                  | 54321     | minidev-formula1-db                   | `postgresql://dev:dev@localhost:54321/formula1` |
| financial                 | 54322     | minidev-financial-db                  | `postgresql://dev:dev@localhost:54322/financial` |
| california_schools        | 54323     | minidev-california-schools-db         | `postgresql://dev:dev@localhost:54323/california_schools` |
| card_games                | 54324     | minidev-card-games-db                 | `postgresql://dev:dev@localhost:54324/card_games` |
| codebase_community        | 54325     | minidev-codebase-community-db         | `postgresql://dev:dev@localhost:54325/codebase_community` |
| debit_card_specializing   | 54326     | minidev-debit-card-specializing-db    | `postgresql://dev:dev@localhost:54326/debit_card_specializing` |
| european_football_2       | 54327     | minidev-european-football-2-db        | `postgresql://dev:dev@localhost:54327/european_football_2` |
| student_club              | 54328     | minidev-student-club-db               | `postgresql://dev:dev@localhost:54328/student_club` |
| superhero                 | 54329     | minidev-superhero-db                  | `postgresql://dev:dev@localhost:54329/superhero` |
| thrombosis_prediction     | 54330     | minidev-thrombosis-prediction-db      | `postgresql://dev:dev@localhost:54330/thrombosis_prediction` |
| toxicology                | 54331     | minidev-toxicology-db                 | `postgresql://dev:dev@localhost:54331/toxicology` |

Ports and credentials are **read from the compose file** at runtime
(`parse_compose.py`); nothing is hardcoded in committed files.

## The native Postgres SQL and its structure

- **SQL:** `MINIDEV_postgresql/BIRD_dev.sql` — a single ~956 MB `pg_dump`
  (Postgres 14.12). **Use this one only**, never the MySQL twin
  `MINIDEV_mysql/BIRD_dev.sql`.
- **Gold:** `MINIDEV/mini_dev_postgresql.json` (500 queries) — copied verbatim to
  [`gold/bird_minidev_postgresql.json`](gold/bird_minidev_postgresql.json).

Structure that drives the reload: the dump is **one combined dump** — a single
`-- PostgreSQL database dump` header/footer, **no `CREATE DATABASE`, no
`\connect`** — with **all 75 tables in one `public` schema** under an empty
`search_path`. The 11 databases are distinguished *only* by which tables belong
to each. That membership is clean: it is an exact 1:1 with the live containers,
with **zero cross-DB table-name collisions**, so the dump can be sliced
per-database by table membership.

## How to run the reload — `fix_bird_pg.sh`

```bash
# reload ALL 11 running servers from the native dump (idempotent, re-runnable)
bash eval/scripts/fix_bird_pg.sh
# optional: point at a different mini-dev checkout
MINIDEV_DIR=/path/to/minidev bash eval/scripts/fix_bird_pg.sh
```

What it does, one DB at a time:

1. `parse_compose.py` → `slices/conn_map.tsv` (db, port, user, password).
2. Builds the table→DB membership map from the live containers (cached in
   `slices/table_db_map.tsv`, so a re-run after a partial wipe can't corrupt it).
3. `split_bird_dev.py` streams `BIRD_dev.sql` once and routes every pg_dump
   object block (CREATE TABLE, COPY data, sequences, DEFAULTs, PK/FK
   constraints, indexes) to its owning DB's `slices/<db>.sql`, stripping the
   dump's `OWNER TO xiaolongli` lines. It **fails loudly** on a wrong-dialect
   (MySQL) file or if any slice gets 0 tables.
4. For each server: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` then
   `psql -v ON_ERROR_STOP=1 -f slices/<db>.sql`.

No containers or images are rebuilt — only data is reloaded into the running
servers. The `slices/` artifacts (~1 GB) and `conn_map.tsv` (credentials) are
git-ignored.

## Verification — `verify_bird_pg.py` (Phase C)

```bash
python3 eval/scripts/verify_bird_pg.py
```

Checks (1) structure & constraint layer — table count, largest-table row count,
`#PRIMARY KEY` and `#FOREIGN KEY` (`information_schema.table_constraints`),
native-slice vs reloaded — and (2) gold execution — 5 gold queries per DB run
**read-only** (`default_transaction_read_only=on`), reporting the exact failure
rate.

### Last verification result (all 11 reloaded from native)

Constraint counts matter because the ontology generator reads declared PK/FK as
its highest-confidence provenance tier; a missing-constraint reload would
silently corrupt downstream research. They line up exactly:

| Database                | tables (n/r) | largest table | rows (n/r) | PK (n/r) | FK (n/r) | OK |
|-------------------------|:---:|---|---:|:---:|:---:|:--:|
| formula1                | 13/13 | laptimes          | 400524/400524 | 13/13 | 16/16 | ✓ |
| financial               | 8/8   | trans             | 1056320/1056320 | 8/8 | 8/8 | ✓ |
| california_schools      | 3/3   | schools           | 17686/17686 | 1/1 | 2/2 | ✓ |
| card_games              | 6/6   | legalities        | 427907/427907 | 6/6 | 2/2 | ✓ |
| codebase_community      | 8/8   | posthistory       | 303155/303155 | 8/8 | 7/7 | ✓ |
| debit_card_specializing | 5/5   | yearmonth         | 383282/383282 | 4/4 | 0/0 | ✓ |
| european_football_2     | 7/7   | player_attributes | 183978/183978 | 7/7 | 26/26 | ✓ |
| student_club            | 8/8   | zip_code          | 41877/41877 | 8/8 | 8/8 | ✓ |
| superhero               | 10/10 | hero_power        | 5825/5825 | 8/8 | 11/11 | ✓ |
| thrombosis_prediction   | 3/3   | laboratory        | 13908/13908 | 1/1 | 2/2 | ✓ |
| toxicology              | 4/4   | connected         | 18312/18312 | 4/4 | 5/5 | ✓ |

`n` = native slice, `r` = reloaded DB. **Structure: all match.**
**Gold: 55/55 (5 per DB) executed cleanly, 0.0 % failure rate.**

`debit_card_specializing` legitimately declares 0 foreign keys; `superhero` has
8 PKs across 10 tables (two junction tables declare none) — both faithfully
reflect the native dump.

## Files

| File | Purpose |
|------|---------|
| `scripts/parse_compose.py`  | compose → `db / port / user / password` TSV |
| `scripts/split_bird_dev.py` | split combined native dump into per-DB slices |
| `scripts/fix_bird_pg.sh`    | Phase B — reload all 11 running servers |
| `scripts/verify_bird_pg.py` | Phase C — structure/constraint + gold checks |
| `gold/bird_minidev_postgresql.json` | gold queries, copied verbatim (scored later) |
| `scripts/slices/` (git-ignored) | generated per-DB `.sql`, maps, manifest |
