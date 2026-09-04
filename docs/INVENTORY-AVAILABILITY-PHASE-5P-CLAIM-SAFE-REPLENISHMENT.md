# Inventory Availability Phase 5P: Claim-Safe Replenishment

## Outcome

Replenishment execution can no longer consume or transfer inventory that is
reserved by an order claim. The picker remains a physical participant only;
the existing replenishment resolver still decides whether work is required,
which source and destination apply, the quantity, and whether execution is
inline or queued.

Canonical picker completion may now invoke the same system-owned post-pick
replenishment orchestration used by the legacy path. This does not activate
canonical inventory authority.

## Proven ownership boundary

Canonical claims persist ownership in both aggregate and FIFO form:

- `inventory.inventory_levels.reserved_qty` protects the claimed quantity at
  the variant/location level;
- `inventory.inventory_lots.qty_reserved` protects the exact FIFO cost layers.

Every replenishment movement now requires the requested quantity to be
available in both representations. The database mutation condition repeats
the FIFO availability check, so a concurrent reservation cannot become
replenishment input after the planning read.

Case-break replenishment:

1. locks the source inventory level;
2. rejects when `variant_qty - reserved_qty` cannot fund the task;
3. consumes only FIFO quantity where `qty_on_hand - qty_reserved` is available;
4. creates exact integer-mill output cost layers;
5. preserves the claimed level and lot quantities unchanged;
6. records the source and output `break` transactions with the replenishment
   task as their reference; and
7. completes the task in the same database transaction.

Same-variant replenishment continues through the inventory transfer boundary,
which refuses reserved movement unless a caller explicitly requests it.
Replenishment never requests that override and refuses to execute without the
FIFO lot service. FIFO transfer now also requires an exact source-lot quantity,
conditionally rechecks unreserved stock during the update, and records the
owning replenishment task on its inventory ledger row.

## Fail-closed contracts

Execution fails without partial inventory writes when:

- the persisted task does not conserve source base units;
- a non-conversion task changes variant identity;
- case-break variants belong to different products;
- a case-break source does not divide exactly into the destination variant;
- the source level has insufficient unreserved quantity;
- FIFO lots cannot attribute the exact unreserved quantity;
- a FIFO lot changes concurrently; or
- exact FIFO cost evidence is invalid.

Source discovery, blocked-task recovery, short-pick guidance, and health repair
now use unreserved rather than total on-hand quantity. Claim-owned inventory is
therefore not presented as replenishment supply before execution.

## Verification contract

Deterministic tests cover:

- direct-transfer and case-break quantity conservation;
- invalid cross-product and indivisible conversion rejection;
- level-level protection when every source unit is claimed;
- exact integer-mill value conservation across case-break output layers;
- FIFO transfer shortfall before any write;
- canonical picker continuation into system-owned replenishment; and
- the existing replenishment, inventory, and picker test suites.

A disposable-PostgreSQL integration test proves task completion, aggregate
balances, FIFO balances, reserved-quantity preservation, exact mill value, and
the two-sided audit trail in one real database transaction. It runs only where
the repository's disposable integration database is configured.

## Remaining activation blockers

Canonical authority remains prohibited. This slice closes the replenishment
execution blocker only. Complete canonical publisher coverage, concurrency and
crash-recovery verification, provider readback, external endpoint consumer
verification, and the separately reviewed and explicitly authorized production
activation operation remain open.
