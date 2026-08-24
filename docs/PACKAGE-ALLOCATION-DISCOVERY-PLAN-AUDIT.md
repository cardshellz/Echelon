# Package-allocation discovery plan audit

This command collects a production PostgreSQL cost plan for the package-allocation
relationship-discovery query. It is an inert Phase 2 checkpoint. It does not create
allocation groups, load package evidence, append ledger rows, enable effects, or call
a provider.

## What the command proves

- `WMS_INTEGRITY_AUDIT_DATABASE_URL` identifies the existing non-elevated,
  globally read-only audit role.
- That role also has `SELECT` and schema `USAGE` for every relation used by the
  relationship-discovery query, and none of those relations has row-level security.
- The eight indexes introduced by migration `0619` exist on the expected WMS
  relations with the reviewed key columns and partial predicates, and PostgreSQL
  reports each index valid, ready, and live.
- PostgreSQL can plan the exact production query for one explicitly selected WMS
  source item. The command records aggregate costs, selected reviewed indexes, and
  relevant sequential-scan relation names.

`EXPLAIN` is issued with `ANALYZE FALSE`. PostgreSQL plans but does not execute the
relationship-discovery query. The source identifier is a planning parameter and is
never included in success or failure output.

## Deliberate gates

1. Deploy this command before attempting to run it.
2. Review the audit-credential dry-run. The credential configuration now includes
   the discovery relations, but deployment does not grant them automatically.
3. Obtain separate approval before executing the credential grant update.
4. Select one representative positive `wms.outbound_shipment_items.id` through an
   approved read-only investigation. Do not guess or emit the identifier in reports.
5. Run one supervised command with an external wall-clock deadline:

   ```text
   PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_ENABLED=true \
   npm run wms:audit-package-allocation-discovery-plan -- --source-id=<approved-id>
   ```

The enable value must be exactly `true`; the command never falls back to
`DATABASE_URL`. Its server statement deadline is 15 seconds and its client query
deadline is 25 seconds. Pool shutdown is still supervised by the external wall-clock
deadline.

## Reading the result

- `queryExecuted` must be `false`.
- `readOnlyRoleVerified` must be `true`.
- `expectedIndexCount` must be `8`.
- Every entry in `indexes` reports whether PostgreSQL's normal cost model selected
  that reviewed index for this source.
- `sequentialScanRelations` names only discovery relations scanned sequentially.

A zero or partial `costSelectedExpectedIndexCount` is evidence, not automatic
approval or failure. Small relations may be cheaper to scan. Review the chosen plan,
estimated costs, table statistics, and relevant production cardinalities before
deciding whether another index/query change is required.

## What remains unproven

Because `ANALYZE` is disabled, this checkpoint does not prove actual query runtime,
buffer reads, memory, row counts, or behavior for every source shape. It also does not
authorize runtime wiring, scheduling, ledger writes, or executable effects. Any later
execution measurement must be separately designed, bounded, reviewed, and approved.
