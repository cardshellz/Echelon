# Reuse saved warehouse settings in inventory-source setup

## Outcome

The existing Inventory Exposure setup now uses the warehouse's saved building
type and inventory source instead of asking an operator to re-enter ownership.
This supersedes the duplicate-choice UI introduced in PR #1384. No new page,
migration, production backfill, publishing target, or activation was added.

## Evidence and rules

- `client/src/pages/Warehouses.tsx`, `handleWarehouseTypeChange`, already sets
  an initial inventory source from building type. The saved inventory source
  remains a separate setting and must be read rather than reconstructed from
  that UI default.
- `server/modules/orders/fulfillment-router.service.ts`,
  `assignWarehouseToOrder`, sends 3PL orders to `awaiting_3pl` rather than the
  internal pick/pack workflow. The warehouse editor identifies bulk storage
  as non-fulfilling.
- `server/modules/inventory/application/inventory.use-cases.ts`,
  `syncWarehouse`, reads channel-owned inventory through the configured source
  channel. Internal/manual inventory does not use that importer; integration
  adapters are not supported there.
- `resolveConfiguredWarehouseSource` in the warehouse domain translates these
  saved settings independently: internal stock -> Echelon, manual -> manual,
  channel -> external inventory with incoming direction. Operations -> Echelon
  fulfillment, 3PL -> external fulfillment, bulk storage -> no fulfillment.

No warehouse IDs, codes, names, or channel IDs are hardcoded in the resolver.
An unsupported source type or missing/malformed incoming channel identity is
blocked, not silently changed to internal inventory.

## Contract, audit, and failure modes

The new UI sends `authoritySource: warehouse_settings` with the selected warehouse,
fingerprint, reason, and idempotency key. It cannot override either authority in
that mode. The server resolves the saved settings again under the warehouse row
lock; the fingerprint includes the incoming channel identity as well as building
type, inventory source, identity, and active state. A stale snapshot rejects the
save before writes.

Only `inventory_source_config.channelId` is projected into the read model. Other
integration configuration is not exposed. The immutable audit records the saved
settings and resolved incoming/internal/manual direction. A retry returns the
original receipt, including after subsequent settings changes; it never edits
the original node or audit.

The original explicit-authority API remains available for compatibility with
existing callers. The updated UI only uses the saved-settings mode. Older
responses without the new summary leave the updated UI unable to save until it
reloads current data. Existing prepared sources are not replaced.

The node is always draft, with external provider identity still unset. Source
channel identity here proves the configured selection, not channel existence,
provider authentication, inventory freshness, location validity, or permission
to publish to that channel. Those checks remain prerequisites for subsequent
configuration and activation. No outgoing target is created by this operation;
this change is not an outgoing-publication enforcement redesign.

## Verification

- Focused domain/service, HTTP, and rendered UI tests: 68 passed.
- Complete unit suite: 868 files passed; 8,340 tests passed and 14 skipped,
  including writer-ratchet and migration-prefix guards.
- Inventory-availability PostgreSQL integration suite: 42 passed against the
  isolated disposable local test database; it was stopped after the run.
- The saved-settings mode is exercised by the existing concurrency, idempotency,
  stale/inactive rejection, disabled target/binding setup, and audit rollback
  database tests. Additional tests cover incoming-feed audit evidence, changed
  source channel, missing source configuration, storage-only fulfillment, and
  no outgoing target/outbox/runtime changes.
- Nonincremental TypeScript validation passed.
- No production write, live UI interaction, or provider delivery test was run.

## Remaining rollout work

After review/deployment, prepare the selected warehouse drafts through the
existing API. Continue exact-store/location/item checks before configuring any
outgoing destination. In particular, a warehouse configured to read stock from
a channel must not be treated as permission to publish stock back to that channel.
