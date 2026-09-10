# One physical quantity authority

## Scope and status

Implementation record for `codex/inventory-single-quantity-authority`, based on
`origin/main` at `a36020e9b00c22d6c843a59fe42a7a37758b5c85` (refetched September 10,
2026). The source checkout and its unrelated catalog edits are preserved.

**This branch does not authorize or perform production activation.** Installing
migration `242_inventory_quantity_ledger.sql` creates the journal and its guards;
it does not open the ledger, replace existing counts, change ATP authority, or
publish inventory. The approved verified opening and ATP cutover are one later
transaction, through the existing cutover workflow.

## The actual change

Previously, operational owners updated lot quantities and bin quantities
separately. After the verified opening, neither is independently writable:

1. The business owner selects exact lots and prepares explicit custody movements.
2. `PostgresInventoryQuantityLedger.postInsideTransaction` appends one command and
   its lot movements inside the owner's transaction.
3. Both lot and bin quantity columns are derived from those same entries.
4. Deferred database guards reject an incomplete journal or a projection that
   disagrees with it. Updating both old counters together without a journal is
   also rejected.

This is not another reconciliation job. `inventory.quantity_entries` is the
quantity authority; `inventory.inventory_lots` and `inventory.inventory_levels`
retain useful identities, cost metadata, and synchronous read projections.
Existing ATP readers can consume those projections without maintaining a second
physical stock calculation.

Evidence: `server/modules/inventory/infrastructure/quantity-ledger.repository.ts`,
`PostgresInventoryQuantityLedger.post`, `project`, and migration242's
`quantity_lot_balances`, `quantity_level_balances`,
`guard_quantity_projection_commit`, and `guard_quantity_command_commit`.

## Exact quantity meaning

All quantities are integer **units of the exact package SKU** at an exact
warehouse location and lot, not interchangeable base-piece equivalents.

| Journal bucket | Existing lot projection | Existing bin projection | Meaning |
| --- | --- | --- | --- |
| `onHand` | `qty_on_hand` | `variant_qty` | Unpicked physical stock |
| `reserved` | `qty_reserved` | `reserved_qty` | Holds on that on-hand stock; not extra stock |
| `picked` | `qty_picked` | `picked_qty` | Physically picked custody |
| `packed` | `qty_packed` | `packed_qty` | Explicit packed custody, where used by an owner |

`physical custody = onHand + picked + packed`. Do **not** add reserved again.
`unreserved exact-SKU stock = onHand - reserved` is an input to ATP, **not** the
complete ATP equation. Warehouse eligibility, directed conversions/builds, safety
policy and channel exposure remain with the canonical planners already built.

Example: 20 P5 on hand, 3 reserved, 2 already picked represents 22 P5 physically in
custody. Picking one reserved P5 posts `{onHand:-1,reserved:-1,picked:+1,packed:0}`;
shipping that picked P5 posts `{onHand:0,reserved:0,picked:-1,packed:0}`. Shipping
does not subtract on-hand a second time. A physical case break consumes exact
source lots and creates exact output lots through one `transform` command; an
ATP promise itself does not manufacture either SKU.

Evidence: `server/modules/inventory/domain/quantity-ledger.ts`,
`quantityBalanceSchema`, `normalizeQuantityCommand`, `applyQuantityDelta`.

## Contracts and persistence

| Contract / relation | Responsibility |
| --- | --- |
| `QuantityCommand` (`inventory_quantity_v1`) | Stable key, actor, reason, first occurrence time, business reference, optional reversed command, explicit exact-lot deltas |
| `InventoryQuantityPostingPort` | Post in a caller-owned transaction; no connection or commit ownership |
| `quantity_commands` | Immutable request identity and original command |
| `quantity_entries` | Immutable deltas and exact before/after custody; one line per affected lot per command |
| `quantity_operation_receipts` | Immutable original business reply, checked before FIFO selection; explicit no-movement replies for empty business intents |
| `quantity_ledger_opening` | One-way receipt binding the opening command to the verified snapshot, source hash and ATP revision |

Commands and replies are not silently overwritten on retry. The same intent key
and payload returns the original reply; a changed intent conflicts. Retry clock
changes are excluded from the quantity command's semantic hash. Warehouse, bin,
SKU and lot identity cannot be rebound to disguise a transfer. Projected lots and
levels cannot be deleted after opening, including zero rows. Transfers and
corrections preserve historical identities instead.

The ledger does not calculate money, choose FIFO lots, authorize recipe changes,
own order reservations, or send provider requests. Those remain with their
business owners and commit costs, ownership receipts and outbox work in the same
transaction as the posting. Original lot cost lineage and integer-mill evidence
are preserved; no historical COGS is recreated from current prices.

## Writer routing evidence

These are source-level traces, not claims that production has been activated.

| Operation | Owning path after opening |
| --- | --- |
| Receive / receipt reversal | `InventoryUseCases.receiveInventory`, `reverseReceiptInventory` -> `OperationalQuantityPosting` -> ledger |
| Manual adjustment / SKU correction | `InventoryUseCases.adjustInventory`, `convertSku` -> selected FIFO lot movements -> ledger |
| Transfer / inline replenishment / case break | `InventoryUseCases` transfer and `executeReplenishmentMove` owners -> lot movement collector -> ledger |
| Manual package break / assembly | `BreakAssemblyUseCases.runConversion` -> both adjustments share one collector and transaction -> one transform receipt |
| Catalog archive / merge with stock transfer | `CatalogInventoryCommandService.execute` -> one full source-set transaction, shared SKU corrections and original reply; metadata/audit commits with quantities |
| Reserve / release / pick / unpick / discrepancy / count | `PostgresCanonicalClaimInventoryRepository` -> `CanonicalClaimQuantityPosting` -> ledger |
| Canonical transformation / build | Canonical claim inventory owner -> exact input/output movements, original cost evidence -> ledger |
| Generic build lifecycle | `BuildExecutionRepository` reserve, execute, cancel and reverse owners -> ledger |
| Canonical shipment | `canonical-claim-dispatch-inventory.ts` -> picked/packed consumption -> ledger |
| Operational / replacement shipment | `operational-shipment-dispatch.repository.ts` -> ledger; legacy replacement use case separately rejects canonical authority |
| Return restock | `applyReturnRestock` -> exact return lots -> ledger in the return transaction |
| Storage transfer undo | `createInventoryMethods` undo owner -> original transfer evidence and one ledger posting |

Core paths are under `server/modules/inventory/application/` and
`server/modules/inventory/infrastructure/`. Lot selection and cost lineage remain
in `server/modules/inventory/lots.service.ts`. Stable canonical claim command
identities come from
`server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts`.

Legacy compatibility writes remain only before the opening or behind existing
legacy-authority checks. The database additionally prevents an old script or an
unmigrated caller from changing balances after opening.

## Opening and cutover

The new `inventory_cutover_opening_v2` worksheet asks for independently verified
lot custody and exact current ownership. Bin totals are derived from those lots;
the operator is not asked to make two inaccurate counters agree.

The full original source census and unresolved historical exceptions remain
immutable evidence. Lot identities and original costs must still match. Nonzero
unlocated lots, ambiguous ownership, changed source evidence and unsupported
packed custody block opening; they are not guessed or reset. Explicit zero
historical lots may remain unlocated. Historical v1 saved assessments retain
their original validation/hash semantics.

The transaction sequence is:

1. Acquire existing exclusive cutover admission and verify the reviewed source.
2. Resolve the exact verified opening and preview fresh claims using its
   lot-derived positions.
3. Append the opening and project lot/bin balances.
4. Reconstruct ownership and post fresh canonical reservations.
5. Change canonical ATP authority and commit publication work with the existing
   cutover owner.
6. Commit everything together. Any late failure rolls everything back.

Evidence: `shared/types/inventory-cutover-opening.ts`,
`deriveVerifiedOpeningPositions`, `projectVerifiedOpeningClaimSupply`,
`projectVerifiedOpeningSupply`, and
`PostgresInventoryCutoverReconstructionRepository.persistReviewed` in
`server/modules/inventory-planning/infrastructure/inventory-cutover-reconstruction.repository.ts`.
Migration242 separately binds opening receipt and final authority at commit.

Ordinary writers first pin shared cutover admission, then claim stable operation
identity before stock selection. Multi-cell operations acquire the complete
existing level set in `(warehouse_location_id, product_variant_id, id)` order,
followed by lots in the existing FIFO lock order. The ledger independently locks
and validates identities and balances; callers retain their existing business and
cost-graph locks. Autocommit callers are rejected using a transaction savepoint.

## UI and retired entrypoints

Manual stock commands carry a stable `commandKey`; the HTTP layer forwards it to
the business owner rather than using a separate, nontransactional HTTP cache.
The client retains unresolved keys and exact payloads in actor-scoped session
storage before sending, including across a page reload. Storage failure blocks
a new write with recovery guidance. Catalog batches replay before enumerating
stock again; even an inspected empty transfer records a no-movement result, so a
retry cannot acquire later-arriving stock. Its actor, original command, source
cells and result are audited in the same transaction. A new tab/session after
an uncertain outcome still requires checking the original command; session
storage is not a cross-device command recovery interface.
Cost-only corrections remain available. After opening, legacy quantity CSV
imports, COGS-created stock, manual lot deletion and Shopify inventory backfill
are rejected with recovery guidance. Corresponding inventory/cost controls use
the server's capability response rather than advertising retired operations.

`assertLegacyQuantityImportAllowed` also gates the dormant external
`syncWarehouse` importer before provider I/O. The currently assembled service
container sets the legacy `inventorySource` to null, so that importer is not
proven to be an active runtime bypass. External-provider/3PL stock is a separate
observational authority, not a local FIFO receipt. The warehouse-source binding
model exists; a complete production 3PL observation-ingestion flow was **not**
verified in this work.

## Changes to the older migration plan

- Replace independently maintained "ledger and lot records" quantity authority
  with one append-only quantity journal and two protected read projections.
- Use independently verified lot observations as the opening basis, not equality
  of two potentially incorrect legacy counters.
- Install the code/schema together while inactive. Do not introduce a second
  quantity-enable flag or an independent activation deployment.
- Activate the quantity opening and canonical ATP in one cutover transaction;
  do not roll back to legacy quantity writers after opening.
- Retire old import/deletion controls at that boundary, not before operators have
  the replacement receiving/adjustment/return/conversion paths.

These decisions supersede the corresponding historical assumptions, without
changing directed transformation authority, warehouse-aware safety/exposure,
picker discrepancy handling, or existing publication admission contracts.

## Exact source index for this branch

| Conclusion | File and entrypoint |
| --- | --- |
| One transactional journal writer | `server/modules/inventory/infrastructure/quantity-ledger.repository.ts:27`, `postInsideTransaction`; `:41`, `post` |
| Explicit independent opening owner | `server/modules/inventory/infrastructure/quantity-ledger.repository.ts:33`, `openInsideTransaction` |
| Bucket contract and reservation overlap | `server/modules/inventory/domain/quantity-ledger.ts:10`, `quantityBalanceSchema`; `:28`, `quantityCommandSchema` |
| Bin opening derives from lot observations | `shared/types/inventory-opening-quantity-projection.ts:8`, `deriveVerifiedOpeningPositions` |
| Opening posts before fresh claim reservations | `server/modules/inventory-planning/infrastructure/inventory-cutover-reconstruction.repository.ts:90`, `persistReviewed` |
| Immutable zero-history identities | `migrations/242_inventory_quantity_ledger.sql:318`, `guard_quantity_projection_identity` |
| Replay before FIFO; explicit empty intent | `server/modules/inventory/infrastructure/operational-quantity-posting.ts:47`, `beginOperation`; `:77`, `finishNoMovement` |
| Atomic full-source catalog batch | `server/modules/catalog/application/catalog-inventory-command.service.ts:62`, `execute`; `server/modules/catalog/infrastructure/catalog-inventory-command.repository.ts:14`, `transaction` |
| Reload-safe pending client intent | `client/src/lib/inventory-command.ts:32`, `createInventoryCommandRequester` |

## Validation and remaining acceptance

Final local validation on September 10, 2026:

- `npm run check`: passed.
- `npm run build`: passed; the existing large-client-bundle warning remains.
- `npm run test:unit -- --maxWorkers=4`: **12,085 passed**, 37 skipped;
  1,023 test files passed, one skipped. Includes migration prefix and writer
  ownership guards. The ownership baseline adds only the four new inventory-owned
  journal/receipt tables; no other module gains ownership of those tables.
- Inventory integration directory plus cutover opening/composition integration
  suites, `--maxWorkers=1`: **199 passed across 16 files**, with actual PostgreSQL
  migrations and constraints. The final run has no skipped or failing cases.
- `git diff --check`: passed. `origin/main` was refreshed again and remained at
  the recorded base; migration242 was still the next lexical migration after241.

Tests used a separately created local disposable PostgreSQL cluster, never
production credentials. New ledger/cutover fixtures use unique databases. The
old replenishment fixture was repaired to use one of those databases instead of
a shared incomplete schema. Serial execution also avoids interference among
older shared-schema integration fixtures. The task-owned cluster was stopped
after the final run; its local artifacts are not part of the source change.

Coverage includes immutable history and zero identities, transaction rollback,
complete projections, opening proof, concurrent keys, overflow, real receive /
pick / release / shipment / transform / build / return movements, exact costs,
multi-SKU catalog transfers, empty-operation replay, and reload-safe client
intents. Full cutover cases prove late failures roll back the opening, claims,
authority and publication records together. Existing v1 compatibility and v2
lot-derived opening behavior are both exercised.

### Assumptions, risks and failure modes

- No production quantity or historical explanation is assumed correct. Human
  verification and existing ownership/cost proof remain explicit requirements.
- Pre-opening compatibility is intentional; a deployment alone must not silently
  turn inaccurate legacy counters into the ledger's opening facts.
- Missing schema, malformed authority evidence, incomplete journal/projections,
  wrong warehouse/lot identity and out-of-range quantities fail explicitly.
  They never grant permission to resume legacy writes after opening.
- Conflicting reuse of a command key fails before a new FIFO plan. A lost reply
  retries the original command. Database/late business failures roll back the
  whole operation; no partial success is represented as a completed transfer.
- Retired imports and identity edits are rejected, not repaired automatically.
  Live operators must use the receiving, adjustment, cost correction or physical
  transfer owner appropriate to the actual event.
- A verified opening is an administrative, full-census operation. Production
  memory/performance headroom and an actual operational review remain necessary;
  this branch does not benchmark or change production capacity.

There is no unresolved hypothesis used to justify a quantity mutation in this
implementation. Source wiring, local tests and live production acceptance are
separate evidence categories.

**Not proven by local tests:** production counts, live operator acceptance,
deployment state, provider acknowledgement, runtime production performance or
the readiness of a production verified opening. Before activation, review the
actual worksheet, ownership/cost exceptions and current dry-run publication
results. No production repair, count, reservation, recipe, setting or channel
quantity was changed during this implementation.
