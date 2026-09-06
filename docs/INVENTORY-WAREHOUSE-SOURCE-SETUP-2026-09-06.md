# Existing warehouse inventory-source setup - 2026-09-06

## Summary of changes

Closes the missing warehouse-source creation step in existing Inventory Exposure
setup. No new page, database migration, startup backfill, activation operation, or
provider call was added.

- `WarehouseInventorySourceSetup` in
  `client/src/components/inventory/WarehouseInventorySourceSetup.tsx:29` lists
  existing warehouses by code/name, requires explicit inventory and fulfillment
  ownership choices, and saves a draft. Existing or inactive sources cannot be
  replaced by the form.
- `InventoryExposure.tsx:372` embeds that control above existing destination setup.
- `registerWarehouseInventorySourceRoutes` in
  `server/modules/warehouse/interfaces/warehouse-inventory-source.routes.ts:9`
  exposes GET/POST `/api/warehouses/inventory-sources`. The routes require
  inventory-planning view/edit permission; the actor comes from the session.
  Request fields cannot forge an actor or request activation.
- `WarehouseInventorySourceService.prepareDraft` in
  `server/modules/warehouse/application/warehouse-inventory-source.service.ts:34`
  validates inputs/output, injects time and hashes the normalized command plus actor.
- `planWarehouseInventorySource` in
  `server/modules/warehouse/domain/warehouse-inventory-source.ts:27` preserves
  existing warehouse identity, derives node classification from the validated
  warehouse type, rejects stale/inactive settings and never infers provider IDs.
- `PostgresWarehouseInventorySourceStore.prepareDraft` in
  `server/modules/warehouse/infrastructure/warehouse-inventory-source.repository.ts:50`
  locks the idempotency key and warehouse row, creates one draft node, persists
  immutable audit evidence and the receipt in the same transaction.
  READ COMMITTED plus row serialization avoids the stale pre-lock snapshot problem.
- The writer baseline adds only the warehouse owner for
  `warehouse.fulfillment_nodes` and its shared idempotency receipt writes.
  Audit-event writes still use the audit infrastructure API.
- Two existing source-inspection tests now accept LF and CRLF. Their behavioral
  assertions are unchanged.

## Assumptions and authority boundaries

No business ownership choice is assumed: both ownership fields must be explicit.
Operations/bulk-storage warehouse types map to internal-warehouse classification;
the saved 3PL type maps to third-party-logistics classification. Neither mapping
chooses inventory or fulfillment authority.

The command deliberately leaves provider account/location identity unset and
lifecycle state draft. It does not certify a 3PL identity or activate any node,
target, source binding, policy, mapping, publication runtime or inventory claim.
It copies no Shopify/eBay identifiers and changes no allocation rules.

No production operation was performed during this implementation turn. The prior
production preview is separate evidence, not a live test of this patch.

## Failure modes and risks

- Stale warehouse fingerprint or inactive warehouse: reject before writes.
- Existing source: 409, never replace or change it.
- Same key/payload/actor retry: return original receipt without another audit/write.
- Reused key with changed payload/actor: 409.
- Competing creators: one commit, one domain conflict.
- Code/foreign-key collision: classified 409; historical source identities are not
  overwritten. This is initial preparation, not source retirement/replacement.
- Audit or receipt persistence failure: the complete transaction rolls back.
- Deadlock/serialization/lock contention: classified retryable conflict; exact
  retries retain their key.
- Unexpected database errors: structured server logging and sanitized client errors.
- New schema references are resolved at query execution, not public-module import,
  preserving existing partial-mock consumers and avoiding import-time behavior.
- No live provider readback or delivery test is included. Canada scope handling,
  missing item identities and rollout policy decisions from the earlier preview
  remain separate work before any production cutover.

## Tests and evidence

Tested application code commit: `4b5c0d4673f5bc2a9ced96ba3d690fe9c3348746`.
Includes current main `f2cfb4b2` without conflicts; the other agent's changes remain intact.

- Complete local unit suite: **858 files passed; 8,032 tests passed; 14 skipped**.
- Inventory-availability PostgreSQL suite: **39 passed** against a new isolated
  local PostgreSQL 17.11 database on loopback, never a production database.
- New targeted unit/HTTP/UI tests: **43 passed** (included in the full unit total).
- Writer-ratchet and migration-prefix checks passed in the unit suite.
- Clean nonincremental TypeScript validation (`npx tsc --incremental false`) passed.
- The task-specific local PostgreSQL instance was stopped after testing; its
  disposable data and logs were retained. No existing database was stopped.
- Database tests at
  `server/modules/inventory-planning/__tests__/integration/inventory-availability-foundation.integration.test.ts:427`
  exercise the real source service, existing destination creation, and existing
  source-binding save together. They assert no changed stock, no outbox rows,
  disabled destination state and unchanged legacy runtime authority.
  Subsequent tests cover simultaneous retries/competing requests, stale/inactive/
  missing warehouses and audit-failure rollback.
- UI tests render the actual component with cached query data to check recognizable
  warehouse names, no preselected authority, disabled states and inactive wording.
  They are not a live browser visual or provider verification.

No PR has been created or pushed by this implementation turn. After PR review and
deployment, prepare only explicitly selected warehouses and carry forward verified
channel settings through the existing APIs. Obtain fresh exact-store/item readback
evidence before any live publishing or runtime cutover.
