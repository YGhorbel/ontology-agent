#!/usr/bin/env python3
"""Split the combined native Postgres BIRD_dev.sql into per-database slices.

The native MINIDEV_postgresql/BIRD_dev.sql is a SINGLE pg_dump containing all 75
tables of all 11 BIRD mini-dev databases in one `public` schema, with NO
CREATE DATABASE / \\connect delimiters. The only thing distinguishing the 11
databases is *which tables belong to each* — and that mapping is clean
(verified: exact 1:1 with the live containers, zero cross-DB table-name
collisions).

This script streams the dump once and routes every pg_dump object block
(CREATE TABLE, COPY data, sequences, DEFAULTs, PK/FK constraints, indexes) to
its owning database's slice file, based on the unique `public.<table>` it
references. Sequences are routed via their `ALTER SEQUENCE ... OWNED BY
public.<table>.<col>` declaration. `OWNER TO <role>` lines are stripped (the
dump's `xiaolongli` role does not exist in our containers).

Output: <outdir>/<db>.sql  (one self-contained, dependency-ordered slice per DB)
        <outdir>/split_manifest.tsv  (db, tables, pk, fk, copy_blocks)

Fails loudly on wrong dialect (MySQL) or if any database slice gets 0 tables.
"""
import argparse
import os
import re
import sys

PUB_TOK = re.compile(r'public\.("?)([A-Za-z0-9_]+)\1')
OWNED_BY = re.compile(
    r'ALTER SEQUENCE public\.("?)([A-Za-z0-9_]+)\1 OWNED BY public\.("?)([A-Za-z0-9_]+)\3\.'
)


def load_map(path):
    table_db, dbs = {}, set()
    with open(path) as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                continue
            t, d = line.split("\t")
            table_db[t.lower()] = d
            dbs.add(d)
    return table_db, dbs


def dialect_guard(sql_path):
    with open(sql_path, "r", encoding="utf-8", errors="replace") as fh:
        head = fh.read(2_000_000)
    if "PostgreSQL database dump" not in head:
        sys.exit(f"FATAL: {sql_path} is not a PostgreSQL pg_dump (header missing). Refusing.")
    if re.search(r"ENGINE=|AUTO_INCREMENT|`", head):
        sys.exit(f"FATAL: {sql_path} looks like a MySQL dump. Refusing to use wrong dialect.")
    if "FROM stdin;" not in head and "COPY " not in head:
        sys.exit(f"FATAL: {sql_path} has no COPY data — not the expected native dump. Refusing.")


def build_seq_map(sql_path, table_db):
    """Pass A: map sequence name -> owning database via OWNED BY declarations."""
    seq_db = {}
    with open(sql_path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("ALTER SEQUENCE"):
                m = OWNED_BY.search(line)
                if m:
                    seq, tbl = m.group(2), m.group(4).lower()
                    if tbl in table_db:
                        seq_db[seq] = table_db[tbl]
    return seq_db


def route_db(line, table_db, seq_db):
    """Return the set of databases referenced by public.* tokens on this line."""
    hits = []
    for m in PUB_TOK.finditer(line):
        ident = m.group(2)
        if ident in table_db:
            hits.append(table_db[ident])
        elif ident in seq_db:
            hits.append(seq_db[ident])
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sql", required=True)
    ap.add_argument("--map", required=True)
    ap.add_argument("--outdir", required=True)
    a = ap.parse_args()

    table_db, dbs = load_map(a.map)
    if not dbs:
        sys.exit("FATAL: empty table->db map.")
    dialect_guard(a.sql)
    seq_db = build_seq_map(a.sql, table_db)

    os.makedirs(a.outdir, exist_ok=True)
    handles = {d: open(os.path.join(a.outdir, f"{d}.sql"), "w", encoding="utf-8") for d in dbs}
    stats = {d: {"tables": 0, "pk": 0, "fk": 0, "copy": 0} for d in dbs}

    fh = open(a.sql, "r", encoding="utf-8", errors="replace")

    # Preamble (SET / search_path lines before the first object) -> all slices.
    preamble = []
    line = fh.readline()
    while line and not line.startswith("-- Name:"):
        preamble.append(line)
        line = fh.readline()
    pre = "".join(preamble)
    for d in dbs:
        handles[d].write(pre)

    block = []          # buffered lines of the current object (never COPY data)
    cur = None          # current target database
    in_copy = False
    warned = set()

    def flush():
        if cur and block:
            handles[cur].write("".join(block))
        block.clear()

    while line:
        if in_copy:
            handles[cur].write(line)
            if line.rstrip("\n") == "\\.":
                in_copy = False
            line = fh.readline()
            continue

        # pg_dump uses two object-header styles: "-- Name:" for DDL objects and
        # "-- Data for Name:" for COPY data. BOTH are block boundaries — missing
        # the data header lets the last DDL block leak into the next COPY's DB.
        if line.startswith("-- Name:") or line.startswith("-- Data for Name:"):
            flush()
            cur = None
            block.append(line)
            line = fh.readline()
            continue

        if line.startswith("COPY public."):
            m = PUB_TOK.search(line)
            tbl = m.group(2)
            cur = table_db.get(tbl, cur)
            if cur is None:
                sys.exit(f"FATAL: COPY for unmapped table {tbl!r}: {line.strip()}")
            if block:
                handles[cur].write("".join(block))
                block.clear()
            handles[cur].write(line)            # COPY header
            stats[cur]["copy"] += 1
            in_copy = True
            line = fh.readline()
            continue

        if cur is None:
            hits = route_db(line, table_db, seq_db)
            if hits:
                cur = hits[0]
                if len(set(hits)) > 1 and tuple(sorted(set(hits))) not in warned:
                    warned.add(tuple(sorted(set(hits))))
                    sys.stderr.write(
                        f"WARN: block references multiple DBs {sorted(set(hits))}; "
                        f"routing to {cur}: {line.strip()[:80]}\n"
                    )

        if " OWNER TO " in line:           # strip role ownership (xiaolongli absent)
            line = fh.readline()
            continue

        block.append(line)
        if cur:
            if line.startswith("CREATE TABLE"):
                stats[cur]["tables"] += 1
            if "ADD CONSTRAINT" in line and "PRIMARY KEY" in line:
                stats[cur]["pk"] += 1
            if "ADD CONSTRAINT" in line and "FOREIGN KEY" in line:
                stats[cur]["fk"] += 1
        line = fh.readline()

    flush()
    for h in handles.values():
        h.close()
    fh.close()

    # Validate + manifest
    empty = [d for d in dbs if stats[d]["tables"] == 0]
    if empty:
        sys.exit(f"FATAL: these database slices got 0 tables: {empty}")

    man = os.path.join(a.outdir, "split_manifest.tsv")
    with open(man, "w") as mf:
        mf.write("db\ttables\tpk\tfk\tcopy_blocks\n")
        for d in sorted(dbs):
            s = stats[d]
            mf.write(f"{d}\t{s['tables']}\t{s['pk']}\t{s['fk']}\t{s['copy']}\n")

    total = sum(stats[d]["tables"] for d in dbs)
    print(f"split OK: {len(dbs)} databases, {total} tables total")
    for d in sorted(dbs):
        s = stats[d]
        print(f"  {d:<26} tables={s['tables']:>3} pk={s['pk']:>3} fk={s['fk']:>3} copy={s['copy']:>3}")
    if total != 75:
        sys.stderr.write(f"WARN: expected 75 tables total, routed {total}\n")


if __name__ == "__main__":
    main()
