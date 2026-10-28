# Current package reconciliation

Use this owner when historical ShipStation packages disagree with canonical
commercial allocations and Shopify already contains the fulfilled quantities.
It supports merged orders and split parcels. It never posts inventory movement,
creates another Shopify fulfillment, cancels a fulfillment, or changes its items.

The application composes the pure complete-package planner, exact authenticated
ShipStation reads, canonical package materializer, WMS/OMS projector, and existing
Shopify tracking update and command lifecycle owners.

## Preview and apply

Run with the target database and ShipStation credentials supplied through the
normal environment. The actor must be an active administrator. Start with exact
outbound shipment item identities, not SKU or tracking-number matching:

```sh
npx tsx scripts/reconcile-shipment-packages.ts \
  --source-item-ids 101,102 \
  --actor '<administrator-id>' \
  --reason 'Verified package correction and its evidence' \
  --command-key '<unique-stable-operation-key>' --json
```

Review the complete discovered source/label graph and `plan.sourceQuantities`.
Only `ready` or `unchanged` plans can apply. Add `--execute` and
`--expected-plan-hash '<preview-plan-evidenceHash>'` to apply that reviewed plan.
Execution refreshes provider proof and rechecks the database snapshot under locks.

Use `--correct-previous-label-ids` only after an operator has confirmed that an
earlier physical package's contents allocation is wrong. Each selected earlier
label must have exact provider merge lineage to a current target. This records an
explicit correction; it does not void that label or remove its carrier history.
Carrier-owned allocations cannot move through the automatic relabel path.

ShipStation order shipment lists establish package membership, while exact
shipment-ID reads establish contents. The distinction matters because a merged
order's list can display the new contents against an older voided shipment.

## Retry and failure handling

Repeat the original command and intent with the same command key after a timeout.
Completed commands return their immutable result and readback without projecting
old parcels again. Later relabels or provider changes cannot reinterpret that
completed historical command; a new correction requires a new reviewed command.
An applied receipt holds its new channel commands in review while the application
projects packages and checks every existing native fulfillment. A uniquely matched
earlier fulfillment may receive a tracking-only update with customer notification
disabled; an immutable tracking intent is recorded first. A lost provider response
is resolved by readback before any repeated update.

The normal fulfillment worker resumes unfinished historical readbacks with bounded
backoff. Eight failed attempts retain the receipt and held commands for review.
Fix the underlying evidence or provider issue, then retry the original command.
Changed intent requires a new preview and command key. Never reset an old command,
delete a failed attempt, invent a prior pick, or adjust stock to clear a review.

Stale snapshots, excess quantities, incomplete source graphs, unknown parcels,
conflicting identities, missing predecessor channel correction, and ambiguous
native fulfillment mappings fail closed. The allocation transaction rolls back on
any target failure. A later provider or projection failure retains the applied
receipt, allowing the same command to finish without reallocating quantities.

## Acceptance

Verify exact package/order line quantities and tracking in canonical storage and
the originating Shopify account. Confirm the original inventory transactions,
physical items, carrier observations, and failed void attempts are unchanged.
Only then does the owner resolve the matching allocation reviews. Fulfillment
reconciliation does not establish delivery or resolve a carrier investigation.
