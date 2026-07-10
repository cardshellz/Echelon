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

## Verified First Watermark

Release `v2321` (`05802478`) deployed the measurement foundation. The required
production sequence completed on July 10, 2026:

- dry-run: 31 checks, 1,773 blockers, 25,888 warnings, 27,661 findings classified
  `new`;
- execute: run `864c28b7-f8c8-4146-963d-1e89ae02e099`, snapshot
  `2026-07-10T09:10:06.971Z`;
- second dry-run: all 27,661 findings classified `unchanged`, with zero new,
  worsened, recurred, or resolved findings.

The execute command displayed `new: 1` because its SQL summary reader counted one
group row instead of the group's `COUNT(*)`. The complete second dry-run proved the
27,661 finding rows were persisted. Measurement activation corrects that display bug
and adds a regression test.

## Continuous Monitoring Activation

Migration `127_inventory_integrity_monitoring.sql` adds:

- a singleton stabilization watermark tied to one completed all-check audit run;
- a durable alert outbox with leases, retry backoff, terminal dead-letter state, and
  one alert identity per continuous run.

The continuous command is deliberately not an inventory writer. The audit connection
must use `WMS_INTEGRITY_AUDIT_DATABASE_URL`; startup rejects that credential if it can
insert, update, delete, or truncate any operational table in the audited schemas. The
registry transaction uses `WMS_INTEGRITY_REGISTRY_DATABASE_URL` when configured and
otherwise the application database credential, but its SQL is limited to
`inventory.integrity_*` tables.

### Deployment Verification

```sql
SELECT
  to_regclass('inventory.integrity_monitor_state') AS monitor_state,
  to_regclass('inventory.integrity_alert_outbox') AS alert_outbox;
```

Both values must be non-null before activation.

### Activate The Stabilization Watermark

Preview the exact baseline selection:

```powershell
heroku run "npx tsx scripts/activate-wms-inventory-integrity-monitor.ts --dry-run --baseline-run-id=864c28b7-f8c8-4146-963d-1e89ae02e099" -a cardshellz-echelon
```

Activate it once, with an attributable operator identity:

```powershell
heroku run "npx tsx scripts/activate-wms-inventory-integrity-monitor.ts --execute --baseline-run-id=864c28b7-f8c8-4146-963d-1e89ae02e099 --actor=owner@cardshellz.com" -a cardshellz-echelon
```

The command is idempotent for that baseline and refuses to replace it with a different
run. Changing the watermark requires a reviewed migration, not an ad hoc update.

### Credential And Alert Preflight

Create a dedicated Heroku Postgres credential. Heroku creates custom credentials with
CONNECT only; do not grant a schema-wide writer role:

```powershell
heroku pg:credentials:create DATABASE_URL --name wms_integrity_auditor -a cardshellz-echelon
```

Preview and apply the exact relation-level grants derived from the deployed audit
queries:

```powershell
heroku run "npx tsx scripts/configure-wms-integrity-audit-credential.ts --dry-run --credential=wms_integrity_auditor" -a cardshellz-echelon
heroku run "npx tsx scripts/configure-wms-integrity-audit-credential.ts --execute --credential=wms_integrity_auditor" -a cardshellz-echelon
```

Attach that credential to the app using the exact config-var name consumed by the
monitor:

```powershell
heroku addons:attach <postgres-addon-name> --credential wms_integrity_auditor --as WMS_INTEGRITY_AUDIT_DATABASE -a cardshellz-echelon
```

Do not copy or print the credential URL. The attachment manages
`WMS_INTEGRITY_AUDIT_DATABASE_URL` and credential rotation.

`WMS_INTEGRITY_ALERT_WEBHOOK_URL` is preferred. Until a dedicated endpoint is set, the
runner can use the existing `OMS_OPS_ALERT_WEBHOOK_URL`. Never print either value in
run evidence.

Run the full read-only audit and lifecycle preview through the exact scheduled path:

```powershell
heroku run "npx tsx scripts/run-wms-inventory-integrity-monitor.ts --dry-run --statement-timeout-ms=120000" -a cardshellz-echelon
```

The output must name the read-only database user and report no role-privilege error.

### Schedule

Configure Heroku Scheduler to run this command hourly:

```text
npm run wms:monitor-integrity
```

Hourly is the initial reviewed cadence because the verified full production runs took
approximately 20 seconds. Revisit the cadence from recorded runtime and database-load
evidence; do not silently add a faster web-dyno interval.

Each scheduled execution:

1. acquires a cross-dyno PostgreSQL advisory lock;
2. verifies the audit credential has zero operational DML privileges;
3. runs all checks in one repeatable-read, read-only transaction;
4. records one `continuous` lifecycle run atomically;
5. alerts only for new blocker fingerprints, worsening metrics, recurrences, or
   blocker-count growth;
6. leases and delivers pending alerts from the durable outbox.

Stable historical findings do not repeatedly alert.

### Monitoring Inspection And Rollback

```sql
SELECT * FROM inventory.integrity_monitor_state;

SELECT status, COUNT(*)
FROM inventory.integrity_alert_outbox
GROUP BY status
ORDER BY status;

SELECT id, run_id, status, attempt_count, next_attempt_at, sent_at, last_error
FROM inventory.integrity_alert_outbox
WHERE status <> 'sent'
ORDER BY created_at;
```

Rollback is operational: disable the Heroku Scheduler entry. Do not delete the
watermark, audit runs, findings, observations, or alert history. A delivered alert can
be duplicated if the process exits after the remote webhook accepts it but before the
outbox row is marked sent; the run ID makes that retry recognizable, and retrying is
safer than losing an integrity regression.
