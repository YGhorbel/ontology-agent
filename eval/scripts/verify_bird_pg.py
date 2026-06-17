#!/usr/bin/env python3
"""Phase C — acceptance verification for the native-reloaded BIRD mini-dev DBs.

Two checks:

1. STRUCTURE  per database, native (from the per-DB slice) vs reloaded (live):
     table count, largest table + its row count, #PRIMARY KEY, #FOREIGN KEY.
   PK/FK come from information_schema.table_constraints (reloaded) and the
   `ADD CONSTRAINT ... PRIMARY KEY / FOREIGN KEY` statements routed into the
   slice (native). The ontology generator treats declared PK/FK as its
   highest-confidence provenance, so these MUST line up.

2. GOLD       for each DB, run 5 gold SQL queries from mini_dev_postgresql.json
   READ-ONLY against the reloaded DB; report execute-success and row counts,
   and the exact failure rate with query + error for any that fail.

Read-only: every gold query runs under default_transaction_read_only=on with a
statement timeout, so it can never mutate data.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SLICES = os.path.join(HERE, "slices")
CONN = os.path.join(SLICES, "conn_map.tsv")
HOST = os.environ.get("PGHOST", "localhost")
GOLD = sys.argv[1] if len(sys.argv) > 1 else \
    "/home/yassinegprd/Downloads/minidev_0703/minidev/MINIDEV/mini_dev_postgresql.json"

# gold db_id -> postgres database name (only formula differs)
GOLD_DBID_TO_DB = {"formula_1": "formula1"}
DB_TO_GOLD_DBID = {"formula1": "formula_1"}

COPY_RE = re.compile(r'^COPY public\.("?)([A-Za-z0-9_]+)\1')


def load_conn():
    rows = []
    with open(CONN) as fh:
        for line in fh:
            db, port, user, pw = line.rstrip("\n").split("\t")
            rows.append({"db": db, "port": port, "user": user, "pw": pw})
    return rows


def psql(conn, sql, read_only=False):
    """Run sql via psql; return (rc, stdout, stderr)."""
    env = dict(os.environ, PGPASSWORD=conn["pw"])
    opts = "-c statement_timeout=60000"
    if read_only:
        opts += " -c default_transaction_read_only=on"
    env["PGOPTIONS"] = opts
    p = subprocess.run(
        ["psql", "-h", HOST, "-p", conn["port"], "-U", conn["user"],
         "-d", conn["db"], "-v", "ON_ERROR_STOP=1", "-tA", "-F", "\t", "-c", sql],
        capture_output=True, text=True, env=env,
    )
    return p.returncode, p.stdout, p.stderr


def native_table_counts(db):
    """Per-table native row counts from the slice's COPY blocks."""
    counts = {}
    path = os.path.join(SLICES, f"{db}.sql")
    cur = None
    n = 0
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if cur is not None:
                if line.rstrip("\n") == "\\.":
                    counts[cur] = n
                    cur = None
                else:
                    n += 1
                continue
            m = COPY_RE.match(line)
            if m:
                cur = m.group(2)
                n = 0
    return counts


def native_constraints(db):
    pk = fk = 0
    with open(os.path.join(SLICES, f"{db}.sql"), "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if "ADD CONSTRAINT" in line and "PRIMARY KEY" in line:
                pk += 1
            if "ADD CONSTRAINT" in line and "FOREIGN KEY" in line:
                fk += 1
    return pk, fk


def main():
    conns = load_conn()
    gold = json.load(open(GOLD))
    by_db = {}
    for item in gold:
        by_db.setdefault(item["db_id"], []).append(item)

    print("=" * 110)
    print("PHASE C.1 — STRUCTURE & CONSTRAINT LAYER (native slice vs reloaded DB)")
    print("=" * 110)
    hdr = (f"{'database':<26}{'tables n/r':>12}{'largest table':>22}"
           f"{'rows n/r':>22}{'PK n/r':>10}{'FK n/r':>10}  OK")
    print(hdr)
    print("-" * 110)

    all_ok = True
    struct_rows = []
    for c in conns:
        db = c["db"]
        ntc = native_table_counts(db)
        npk, nfk = native_constraints(db)
        n_tables = len(ntc)

        rc, out, err = psql(c, "SELECT count(*) FROM information_schema.tables "
                                "WHERE table_schema='public' AND table_type='BASE TABLE'")
        r_tables = int(out.strip()) if rc == 0 else -1

        # largest table by native rows
        largest = max(ntc, key=ntc.get) if ntc else "-"
        n_rows = ntc.get(largest, 0)
        rc, out, err = psql(c, f'SELECT count(*) FROM public."{largest}"')
        r_rows = int(out.strip()) if rc == 0 else -1

        rc, out, _ = psql(c, "SELECT count(*) FROM information_schema.table_constraints "
                             "WHERE constraint_schema='public' AND constraint_type='PRIMARY KEY'")
        r_pk = int(out.strip()) if rc == 0 else -1
        rc, out, _ = psql(c, "SELECT count(*) FROM information_schema.table_constraints "
                             "WHERE constraint_schema='public' AND constraint_type='FOREIGN KEY'")
        r_fk = int(out.strip()) if rc == 0 else -1

        ok = (n_tables == r_tables and n_rows == r_rows and npk == r_pk and nfk == r_fk
              and r_rows >= 0)
        all_ok = all_ok and ok
        print(f"{db:<26}{f'{n_tables}/{r_tables}':>12}{largest:>22}"
              f"{f'{n_rows}/{r_rows}':>22}{f'{npk}/{r_pk}':>10}{f'{nfk}/{r_fk}':>10}  "
              f"{'✓' if ok else '✗ MISMATCH'}")
        struct_rows.append((db, n_tables, r_tables, largest, n_rows, r_rows, npk, r_pk, nfk, r_fk, ok))

    print("-" * 110)
    print(f"STRUCTURE: {'ALL MATCH ✓' if all_ok else 'MISMATCHES PRESENT ✗'}")

    print()
    print("=" * 110)
    print("PHASE C.2 — GOLD SQL EXECUTION (5 per DB, READ-ONLY)")
    print("=" * 110)
    total = passed = 0
    failures = []
    for c in conns:
        db = c["db"]
        gid = DB_TO_GOLD_DBID.get(db, db)
        items = by_db.get(gid, [])[:5]
        oks = 0
        for it in items:
            total += 1
            rc, out, err = psql(c, it["SQL"], read_only=True)
            if rc == 0:
                passed += 1
                oks += 1
            else:
                failures.append((db, it.get("question_id"), it["SQL"], err.strip()))
        nrows_note = f"{oks}/{len(items)} executed"
        print(f"{db:<26} {nrows_note}")

    print("-" * 110)
    rate = (total - passed) / total * 100 if total else 0
    print(f"GOLD: {passed}/{total} executed cleanly  |  failure rate {rate:.1f}%  ({len(failures)} failed)")
    if failures:
        print()
        print("FAILURES:")
        for db, qid, sql, err in failures:
            print(f"\n  [{db}] question_id={qid}")
            print(f"    SQL: {sql}")
            print(f"    ERR: {err.splitlines()[0] if err else '(no stderr)'}")

    print()
    overall = all_ok and not failures
    print(f"OVERALL: structure {'OK' if all_ok else 'FAIL'}; "
          f"gold {passed}/{total} clean. "
          f"{'ACCEPT' if overall else 'REVIEW NEEDED (see above)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
