#!/usr/bin/env python3
"""Parse the BIRD mini-dev docker-compose file into a connection map.

Emits TSV to stdout, one line per Postgres server service (those that define
POSTGRES_DB):  db<TAB>port<TAB>user<TAB>password

Ports and credentials are read from the compose file itself (HARD FACT: do not
hardcode secrets). Sorted by host port for stable, one-DB-at-a-time processing.
"""
import sys
import yaml


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: parse_compose.py <docker-compose.yml>\n")
        return 2
    with open(sys.argv[1]) as fh:
        doc = yaml.safe_load(fh)

    rows = []
    for name, svc in (doc.get("services") or {}).items():
        env = svc.get("environment") or {}
        if isinstance(env, list):
            env = dict(e.split("=", 1) for e in env if "=" in e)
        db = env.get("POSTGRES_DB")
        if not db:
            continue  # this is a loader/utility service, not a PG server
        user = env.get("POSTGRES_USER", "postgres")
        password = env.get("POSTGRES_PASSWORD", "")
        port = None
        for p in svc.get("ports") or []:
            host = str(p).split(":")[0].strip().strip('"')
            port = host
        if port is None:
            continue
        rows.append((db, port, user, password))

    rows.sort(key=lambda r: int(r[1]))
    for db, port, user, password in rows:
        sys.stdout.write(f"{db}\t{port}\t{user}\t{password}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
