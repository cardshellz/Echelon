# Operations Control Tower V2 Runbook

## Scope

This release replaces the interactive live-aggregation workflow with a
persistent read model for the four durable exception registries that currently
have stable atomic identities:

- `inventory.integrity_findings`
- `wms.reconciliation_exceptions`
- `procurement.po_exceptions`
- `oms.channel_fulfillment_pushes`

The Control Tower does not own or mutate source-domain state. Its writes are
limited to source-run history, projected work items, immutable observations,
operator assignment, acknowledgement, and snooze state.

Computed OMS/WMS health detectors that do not yet have stable atomic finding
identities remain outside the V2 queue. They must be converted in Phase 3 of
the design before the legacy live endpoint can be removed.

## Runtime Behavior

The web process starts a dyno-safe projector ten seconds after boot and repeats
every 60 seconds. A scheduler-level PostgreSQL advisory lock permits one active
projector across dynos. Each source also has its own transaction-scoped lock.

Environment controls:

- `CONTROL_TOWER_PROJECTOR_DISABLED=true` disables automatic projection.
- `CONTROL_TOWER_PROJECTOR_INTERVAL_MS` changes the interval. Valid range is
  30,000 through 3,600,000 milliseconds.
- `CONTROL_TOWER_SOURCE_STALE_MINUTES` controls the UI freshness threshold.
  Valid range is 5 through 1,440 minutes; default is 20.
- `DISABLE_SCHEDULERS=true` disables the projector with the other schedulers.

A partial or failed source scan cannot resolve an absent work item. Only a
complete successful scan can mark an item resolved.

## Deployment

Migration `128_operations_control_tower_v2.sql` creates the `operations`
schema and read-model tables. The normal release migration runner applies it.

The normal RBAC seed adds these permissions on boot:

- `operations:view`
- `operations:triage`
- `operations:assign`
- `operations:view_technical`

Administrator receives all four. Team Lead receives all four explicitly.

## Preflight

Run a source-only preview before writing the initial projection:

```powershell
heroku run "npx tsx scripts/run-operations-control-tower-projection.ts --dry-run --source=all --json" -a cardshellz-echelon
```

Required result:

- `failedSources` is `0`.
- Every source has `completeScan: true`.
- `rowsFailed` is `0` for every source.

## Initial Backfill

The in-process scheduler will backfill automatically after deploy. To populate
the queue immediately and produce an explicit operator-visible result, run:

```powershell
heroku run "npx tsx scripts/run-operations-control-tower-projection.ts --execute --source=all --json" -a cardshellz-echelon
```

The command is idempotent. Re-running it updates the same work items by stable
source identity and does not duplicate observations for unchanged evidence.

## Database Verification

### Tables and immutable observation guard

```sql
SELECT
  table_schema,
  table_name
FROM information_schema.tables
WHERE table_schema = 'operations'
  AND table_name IN (
    'control_tower_source_runs',
    'control_tower_work_items',
    'control_tower_observations',
    'control_tower_action_attempts'
  )
ORDER BY table_name;

SELECT
  event_object_schema,
  event_object_table,
  trigger_name,
  action_timing,
  event_manipulation
FROM information_schema.triggers
WHERE event_object_schema = 'operations'
  AND event_object_table = 'control_tower_observations';
```

Expected: four tables and two trigger rows for the immutable guard (`UPDATE`
and `DELETE` events).

### Latest source runs

```sql
SELECT DISTINCT ON (source_name)
  source_name,
  status,
  complete_scan,
  projector_version,
  rows_scanned,
  rows_created,
  rows_updated,
  rows_resolved,
  rows_failed,
  started_at,
  completed_at,
  error_code,
  error_message
FROM operations.control_tower_source_runs
ORDER BY source_name, started_at DESC;
```

Expected: one current row per source, `status = 'succeeded'`,
`complete_scan = true`, and `rows_failed = 0`.

### Exact source-to-projection reconciliation

```sql
WITH source_counts AS (
  SELECT
    'inventory.integrity_findings'::TEXT AS source_namespace,
    COUNT(*)::BIGINT AS source_count
  FROM inventory.integrity_findings
  WHERE status IN ('open', 'acknowledged')

  UNION ALL

  SELECT
    'wms.reconciliation_exceptions',
    COUNT(*)::BIGINT
  FROM wms.reconciliation_exceptions
  WHERE status IN ('open', 'acknowledged')
    AND classification <> 'historical_ignore'

  UNION ALL

  SELECT
    'procurement.po_exceptions',
    COUNT(*)::BIGINT
  FROM procurement.po_exceptions
  WHERE status IN ('open', 'acknowledged')

  UNION ALL

  SELECT
    'oms.channel_fulfillment_pushes',
    COUNT(*)::BIGINT
  FROM oms.channel_fulfillment_pushes
  WHERE push_status IN ('failed', 'review')
     OR (
       push_status = 'pending'
       AND created_at <= NOW() - INTERVAL '15 minutes'
     )
),
projection_counts AS (
  SELECT
    source_namespace,
    COUNT(*)::BIGINT AS projection_count
  FROM operations.control_tower_work_items
  WHERE source_status IN ('open', 'acknowledged')
  GROUP BY source_namespace
)
SELECT
  source.source_namespace,
  source.source_count,
  COALESCE(projected.projection_count, 0) AS projection_count,
  source.source_count - COALESCE(projected.projection_count, 0) AS difference
FROM source_counts AS source
LEFT JOIN projection_counts AS projected
  ON projected.source_namespace = source.source_namespace
ORDER BY source.source_namespace;
```

Expected: `difference = 0` for every row.

## API Verification

After signing in as an Administrator or Team Lead, verify:

```text
GET /api/operations/control-tower/v2/work-items?view=attention&domain=all&severity=all&limit=50
GET /api/operations/control-tower/v2/sources
GET /api/operations/control-tower/v2/work-items/{id}
```

The queue response must not contain `evidenceSummary`. Detail returns technical
evidence only when `includeTechnical=1` and the user has
`operations:view_technical`.

## Operator State

- **Take ownership** changes triage to `in_progress`, assigns the current
  session user when unassigned, increments the optimistic row version, and
  appends an immutable acknowledgement observation.
- **Assign** validates that the selected user is active and appends an
  assignment observation.
- **Snooze** requires a reason and a review time between one minute and 30 days
  in the future. An expired snooze appears in Needs Attention without changing
  source-domain state.
- Source resolution is never an operator button. The next complete source scan
  proves the condition is absent and resolves the projected item.

## Failure Handling

- A source failure is isolated; other projectors continue.
- A failed or partial scan preserves all previously open items.
- A crashed run remains visible as a degraded source until a later run
  supersedes it.
- Set `CONTROL_TOWER_PROJECTOR_DISABLED=true` to stop projection without
  changing source systems or deleting Control Tower history.
- The legacy `/api/operations/control-tower` endpoint remains available during
  the parallel observation period. V2 does not call it from the interactive
  queue.
