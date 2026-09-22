# Stop tracking and keep history

The bulk product review accepts `stockDisposition: "retain_history"` only when
`inventoryTrackingDefault` is false. Existing API callers that omit this intent
keep the existing stock dependency guard. Variant overrides are preserved.

For example, an inheriting variant with 2 recorded on hand and 1 recorded picked
can stop tracking without entering a physical count correction. Apply retains
the exact original level and lot rows, including cost precision, actor and time,
in immutable history. The active managed counters become zero and the affected
lots become `tracking_stopped`. These zero counters mean there is no managed
balance; they do not assert that the physical goods disappeared. Product detail
labels the saved balances as historical and offers their original JSON export.

New order identity resolution returns the untracked policy. Physical pick
confirmation remains required, including combined orders, but does not check or
deduct inventory. Existing receipts, picks, shipments, order policy snapshots,
received/consumed lot quantities and lot costs are preserved. No adjustment,
shipment, COGS or accounting journal is created by this transition. Retained
balances leave current inventory valuation; their last recorded lot value stays
in the historical record. Enabling tracking later does not restore those old
balances; new managed quantities require the inventory workflow.

## Implementation and failure behavior

- `loadBulkInventoryTrackingSelection` locks products and variants; the inventory
  owner locks levels/lots and fingerprints the complete database JSON, not only
  the twenty displayed dependency records. One review is limited to 10,000
  nonzero level/lot records.
- `createBulkInventoryTrackingService.apply` verifies the review under the same
  locks and uses the existing durable financial-command receipt. Stale reviews
  reject, retries return the committed result, and any failure rolls back the
  entire batch, including history, feed state, counters, policy and audit rows.
- `projectVariant` calls `retainTrackingStopHistory` before disabling tracking.
  Migration 0697 makes history immutable and serializes new tracked OMS/WMS
  line inserts with the catalog policy lock. A stale order classification must
  resolve the new policy before retrying; it cannot create a tracked obligation
  against retired balances.
- Active OMS/WMS orders, inventory claims, build reservations, replenishment,
  frozen count locations and pending publication remain blockers. This action
  does not infer cancellation or fulfillment from old counters. The eligible
  subset workflow remains available.
- This counter transition requires legacy inventory authority. An active
  canonical quantity ledger requires its own explicit retirement operation and
  is rejected rather than bypassed. The cutover admission fence is held while
  applying. Missing authority/schema evidence fails the operation.

## Verification and limits

PostgreSQL regressions cover exact snapshots above JavaScript's safe integer
range, stock/cost changes after review, terminal-order preservation, overrides,
rollback, replay, immutable history, migration replay, record limits, concurrent
stock/lot/order inserts, current valuation exclusion, and a future combined-order
pick with no inventory deduction. HTTP tests cover permissions, identity
validation, pagination, exact exports and unavailable/missing history. Browser
tests cover review/apply and retained balances at desktop and mobile sizes.

These tests use a disposable PostgreSQL database and mocked browser APIs. They
do not establish a current physical count or authorize production changes.
Deploy migration 0697 with the application before using this workflow. Applying
it remains an explicit user action in the reviewed bulk dialog.
