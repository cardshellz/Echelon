# Package-allocation discovery execution audit

This command measures one actual execution of the package-allocation relationship-
discovery `SELECT`. It is a bounded, read-only Phase 2 checkpoint. It does not resolve
package authority, create allocation groups, append ledger rows, schedule work, enable
effects, or call a provider.

## What the command proves

- The existing non-elevated audit credential remains globally read-only and has the
  exact `SELECT` and schema `USAGE` needed by both lifecycle evidence and discovery.
- The deployed discovery relations and eight reviewed indexes still satisfy the
  non-executing catalog and cost-plan contract.
- The approved source exists and has at least one root relationship used by the
  production discovery query: a shipment-request relationship, a legacy shipment
  request, or a direct physical-shipment item.
- PostgreSQL executes the exact shared discovery `SELECT` once through
  `EXPLAIN ANALYZE` in a `REPEATABLE READ READ ONLY` transaction.
- The result reports aggregate planning/execution time, actual root rows/loops,
  root-level buffer counters, executed reviewed indexes, and executed sequential-scan
  relation names.

The transaction always rolls back. Success and failure output never includes the
source identifier, label identifiers, tracking numbers, item identifiers, payloads,
or query-plan JSON.

## Deliberate production gates

Deployment does not authorize execution. Before any production run:

1. Verify the cost-plan audit is still successful for the same privately selected
   source and the dedicated credential.
2. Confirm the source is representative through an approved read-only investigation;
   never guess it or paste it into shared reports.
3. Review current application/database health and choose an external wall-clock
   deadline. Pool shutdown is not bounded by the query timeout.
4. Obtain explicit approval for one supervised execution.
5. Set the execution-specific enable flag for only that command:

   ```text
   PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_AUDIT_ENABLED=true \
   npm run wms:audit-package-allocation-discovery-execution -- --source-id=<approved-id>
   ```

The enable value must be exactly `true`. The command uses only
`WMS_INTEGRITY_AUDIT_DATABASE_URL` and never falls back to `DATABASE_URL`. The
repository statement deadline is 15 seconds, the pool's server statement deadline is
20 seconds, and the client query deadline is 25 seconds.

## Reading the result

- `mode` must be `read_only_explain_analyze`.
- `queryExecuted`, `representativeSourceVerified`, and `readOnlyRoleVerified` must all
  be `true`.
- `expectedIndexCount` must be `8`.
- `costSelectedExpectedIndexCount` records reviewed indexes selected by the normal
  cost plan.
- `executedExpectedIndexCount` records reviewed index nodes whose `Actual Loops` was
  greater than zero in the analyzed plan.
- `executionBuffers` contains root-level shared, local, and temporary block counters;
  child-node buffers are intentionally not summed because PostgreSQL parent totals
  already include descendants.
  A nonzero dirtied-block count can reflect PostgreSQL hint-bit maintenance by
  a logical `SELECT`; mutation safety comes from the read-only transaction and
  credential proof, not from assuming every buffer counter is zero.
- `plannedSequentialScanRelations` and `executedSequentialScanRelations` include only
  relations in the discovery contract.

Sequential scans or a partial executed-index count are evidence for review, not an
automatic pass or failure. Small relations, zero-row branches, and cache state can
legitimately change which plan nodes execute.

## What remains unproven

One source does not prove every relationship shape, production cardinality, cache
state, concurrency level, or worst-case runtime. This command does not execute the
full authority-resolution service, which currently uses row locks and a serializable
write-capable repository transaction. It does not authorize runtime wiring,
scheduling, ledger mutation, or executable effects. Those remain separate reviewed
Phase 2 gates.
