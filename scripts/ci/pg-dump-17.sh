#!/usr/bin/env bash
# pg_dump from the postgres:17 image, for CI runners whose own pg_dump is older
# than the database (pg_dump refuses a server newer than itself).
#
# The connection is passed through libpq environment variables, which Docker
# forwards by name only (`-e NAME`), so no value appears on a command line.
# `--network host` lets it reach the PostgreSQL service on the runner.
set -euo pipefail
exec docker run --rm --network host \
  -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE -e PGOPTIONS \
  postgres:17 pg_dump "$@"
