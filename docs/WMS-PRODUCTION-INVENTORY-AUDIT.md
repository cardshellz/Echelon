# WMS Production Inventory Integrity Audit

This audit establishes the production baseline before inventory remediation.
It is read-only and intentionally does not use the legacy ledger replay as an
inventory authority.

The first classified production result is recorded in
`docs/WMS-PRODUCTION-INVENTORY-BASELINE-2026-07-09.md`.

## Safety Contract

- One PostgreSQL connection.
- One `REPEATABLE READ, READ ONLY` transaction.
- A configurable statement timeout for every check.
- Transaction-local lock and idle-in-transaction timeouts.
- PostgreSQL application name `wms-inventory-integrity-audit` for operational visibility.
- One scan per check for exact count plus bounded samples.
- An unconditional rollback after success or failure.
- No inventory repair, external API calls, or output-file writes.

`scripts/record-wms-inventory-integrity.ts` is a separate command. It executes the
same read-only audit and then writes only the `inventory.integrity_*` lifecycle
registry tables in a separate serialized transaction. It cannot write inventory
levels, lots, reservations, or movement rows.

## First Production Run

List checks after deployment:

```powershell
heroku run "npx tsx scripts/audit-wms-inventory-integrity.ts --list-checks" -a cardshellz-echelon
```

Run a bounded human-readable baseline:

```powershell
heroku run "npx tsx scripts/audit-wms-inventory-integrity.ts --limit=25 --statement-timeout-ms=120000" -a cardshellz-echelon
```

Capture the Heroku command output locally from a second run:

```powershell
heroku run "npx tsx scripts/audit-wms-inventory-integrity.ts --json --limit=25 --statement-timeout-ms=120000" -a cardshellz-echelon | Tee-Object -FilePath wms-inventory-baseline.json
```

Heroku may prepend a dyno startup line before the JSON document. Preserve the
file as run evidence, but strip that line before feeding the document to a JSON
parser.

Do not use `--limit=all` on the first run. Exact counts are always computed;
the limit controls only samples printed and retained in JSON.

## Interpretation

- `blocker`: the rows violate a quantity, ownership, cost, or control invariant.
  Preserve the sample IDs and do not bulk-correct them yet.
- `warning`: the rows are ambiguous, historically incomplete, or structurally
  unsafe. They require classification before remediation.
- A zero count means the stated check found no violation in its database
  snapshot. It does not prove untested history or physical warehouse truth.

The same deployed script and flags must be run after each remediation phase.
The before/after JSON output is the audit evidence.

## Durable Finding Registry

Migration `126_inventory_integrity_registry.sql` creates:

- `inventory.integrity_audit_runs`: immutable completed-run metadata and totals;
- `inventory.integrity_audit_run_checks`: exact count and elapsed time per check;
- `inventory.integrity_findings`: current lifecycle state for one stable check/entity
  fingerprint;
- `inventory.integrity_finding_observations`: append-only new, changed, worsened,
  improved, recurred, and resolved evidence.

The entity fingerprint contains only the check ID and declared identity columns.
Changing quantities therefore update the same finding instead of manufacturing a new
one. The full evidence has a separate hash, and quantitative checks persist a
non-negative magnitude so worsening can be distinguished from ordinary evidence
change.

Registry persistence has these controls:

- `--dry-run` is the default;
- a complete finding set is mandatory (`--limit=all` is enforced internally);
- one transaction advisory lock serializes recorders;
- findings are staged in bounded JSON batches;
- only checks executed by the completed run can resolve prior findings;
- the run, check totals, findings, observations, and resolutions commit together;
- any persistence failure rolls the entire registry transaction back.

### Deployment Verification

After migration deployment, confirm the registry and immutable observation trigger:

```sql
SELECT
  to_regclass('inventory.integrity_audit_runs') AS runs,
  to_regclass('inventory.integrity_audit_run_checks') AS run_checks,
  to_regclass('inventory.integrity_findings') AS findings,
  to_regclass('inventory.integrity_finding_observations') AS observations;

SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'inventory.integrity_finding_observations'::regclass
  AND NOT tgisinternal;
```

Both queries must return all objects before running the recorder.

### First Registry Runs

Preview the complete lifecycle diff without writing the registry:

```powershell
heroku run "npx tsx scripts/record-wms-inventory-integrity.ts --dry-run --statement-timeout-ms=120000" -a cardshellz-echelon
```

On an empty registry, every current finding should classify as `new` and nothing
should classify as `resolved`.

Persist the first watermark:

```powershell
heroku run "npx tsx scripts/record-wms-inventory-integrity.ts --execute --statement-timeout-ms=120000" -a cardshellz-echelon
```

Run a second dry-run. Stable findings should be `unchanged`; quantity magnitude growth
is `worsened`; absent findings are `resolved`; a previously resolved fingerprint is
`recurred`.

Target one check when validating lifecycle behavior:

```powershell
heroku run "npx tsx scripts/record-wms-inventory-integrity.ts --dry-run --check=terminal_order_open_reservation --statement-timeout-ms=120000" -a cardshellz-echelon
```

A targeted run can only resolve findings for that targeted check. It is stored with
`scope = 'targeted'`, not as a complete all-check watermark.

### Registry Inspection

```sql
SELECT
  id,
  scope,
  snapshot_at,
  check_count,
  blocker_count,
  warning_count,
  finding_count
FROM inventory.integrity_audit_runs
ORDER BY snapshot_at DESC
LIMIT 10;

SELECT
  status,
  severity,
  check_id,
  COUNT(*) AS findings,
  SUM(current_metric) AS total_metric,
  MIN(first_seen_at) AS first_seen,
  MAX(last_seen_at) AS last_seen
FROM inventory.integrity_findings
GROUP BY status, severity, check_id
ORDER BY status, severity, check_id;

SELECT
  observation_kind,
  COUNT(*) AS observations
FROM inventory.integrity_finding_observations
GROUP BY observation_kind
ORDER BY observation_kind;
```

Automatic scheduling is intentionally not enabled by this change. First deploy the
migration, complete the dry-run/execute/dry-run verification above, inspect runtime and
query load, and then enable the 15-minute/current plus daily/full cadence in a separate
reviewed deployment.
