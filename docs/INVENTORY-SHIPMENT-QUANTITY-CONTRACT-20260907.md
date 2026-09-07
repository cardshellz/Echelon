# Inventory shipment quantity contract — 2026-09-07

## Scope and baseline

Implemented in the isolated `codex/inventory-shipment-quantity-contract` worktree from refreshed main `19bc2377930806b327c6dc30b8ce45018bf9dbbd`, the verified main merge of PR #1405. The user reported deployment; the production release SHA, installed triggers, applied migrations and authority were not independently queried. Original checkout catalog/UOM changes remain untouched.

This batch updates quantity interpretation, read APIs, displays and existing correction-preview safeguards. It does not change physical inventory, claim counters, recipes, ATP formulas, channel quantities, order/package contents or activation settings. It adds no schema migration. It does not construct the canonical shipment runtime.

## What the code definitely does

| Result | Exact evidence and reasoning |
| --- | --- |
| Shipment quantity is separate from on-hand movement. | `interpretInventoryShipmentQuantity`, `shared/inventory/shipment-quantity.ts:55`, accepts either a valid negative legacy ship delta or an exact canonical receipt whose ship delta/reservation delta are zero and whose custody transition is picked to shipped. A zero delta alone is unverified, not zero shipped units. |
| Canonical quantity carries immutable evidence, not a guessed absolute value. | `shipmentQuantityEvidenceProjection`, `server/modules/inventory/infrastructure/shipment-quantity-evidence.sql.ts:9`, reads receipt identity and original-pick movement totals in the existing SELECT. The interpreter matches ledger/receipt order, line, source, variant and bin identities; validates warehouse/physical-pair identifiers; and requires the exact journal total with no invalid original-pick rows. |
| Recorded historical quantity is not active-demand or carrier-possession authority. | The interpreter's documented contract at `shared/inventory/shipment-quantity.ts:48` preserves a voided row's original units. Existing active-only readers still filter `voided_at IS NULL`; current history retains its existing void state. No carrier inference or unvoid occurs. |
| History and operations show shipped units and on-hand delta independently. | `getInventoryTransactionsByProductVariantId` and `getInventoryTransactions`, `server/modules/inventory/infrastructure/inventory.repository.ts:264,280`, return additive interpreted DTOs; `OperationsDashboardService.getActivity`, `server/modules/orders/operations-dashboard.service.ts:517`, uses the same projection. Raw receipt evidence is not returned to the browser. |
| UI and CSV never infer shipment units from delta. | `InventoryTransactionQuantity`, `client/src/components/inventory/InventoryTransactionQuantity.tsx:6`, renders verified units plus a separately labeled delta. `readHistoryShipmentQuantity` and `shipmentQuantityCsvFields`, `client/src/lib/inventory-transaction-quantity.ts:14,31`, validate the shared DTO, show review for missing/invalid evidence, and retain the old CSV delta while adding explicit shipment fields. `InventoryHistory.tsx:158,357,467` covers CSV/mobile/desktop; `RecentActivitySection.tsx:190` uses the same display. |
| Cycle-count arithmetic and bin-history filtering are preserved. | `describeStaleInventoryTransaction`, `client/src/lib/inventory-transaction-quantity.ts:43`, only labels existing cycle-count event quantities as on-hand deltas. `CycleCounts.tsx:2406,2803` changes those labels only. Operations `getActivity` retains its location-scoped ship exclusion at line509. |
| Historical correction previews quantify canonical dispatch but do not treat it as legacy stock-restoration authority. | `PgHistoricalShipStationContentsCorrectionRepository.loadFacts`, `server/modules/shipping/historical-shipstation-contents-correction.repository.ts:321`, compiles the projection into its existing repeatable-read READ ONLY client query. `planGroup`, `historical-shipstation-contents-correction.domain.ts:399`, marks canonical or mixed-lineage mismatches `canonical_claim_correction_required` and emits no package adjustments or restorations. Exact provider/WMS/receipt agreement is a no-op. |
| OMS source-posting checks do not sum absolute canonical deltas. | `readSourceShipmentPostedQuantity`, `server/modules/inventory/domain/source-shipment-quantity-evidence.ts`, validates all five required expected identities, rejects duplicate/mixed canonical postings and overflow, and returns quantity plus its source. `prepareLines`, `server/modules/oms/shipstation-unmapped-remediation.service.ts:1449,1533`, reads exact active source evidence instead of `SUM(ABS(delta))`. |

### Concrete example

The PostgreSQL fixtures create a real canonical dispatch of three already-picked units. The receipt quantity and original-pick journal total are both three; the ship ledger on-hand delta is zero. History now shows **3 shipped / On-hand delta 0**. This does not debit stock again or create COGS. If the receipt is missing, mismatched or lacks its journal, the UI shows review and strict server readers reject the evidence.

## Additional confirmed database gap: omission corrections

The old database proof remains in `enforce_outbound_shipment_item_lineage`, `migrations/183_omission_correction_shipment_item_authority.sql:380–395`: omission source evidence is calculated from `SUM(ABS(variant_qty_delta))`. A valid canonical zero-delta source fails that proof. This batch does not silently redefine the trigger.

`adoptShipStationUnmappedPhysicalAsReship` calls `ensureLegacyShipment` before `prepareMappedShipment`. `ensureLegacyShipment` materializes/projects the original physical package through separately committed work (`server/modules/oms/channel-fulfillment-authority.service.ts:414–419`, repository `recordPhysicalPackage` at `channel-fulfillment-authority.repository.ts:3544`). Merely teaching the application to accept canonical units would therefore allow source-projection side effects before a later omission insert failed.

The application now recognizes the recorded units but rejects canonical omission adoption with `CANONICAL_OMISSION_CORRECTION_UNAVAILABLE` inside `prepareLines`, before that source projection, mapped-shipment creation or manual notification cascade. Legacy omissions retain their existing path. This is a specific unsupported-command safeguard, not a claim that zero units shipped. Earlier exception/provider-observation behavior in the enclosing existing workflow is unchanged; the guard does not promise that the entire legacy adoption entry point is mutation-free.

The omission physical path appends a separately linked item (`materializeNonCustomerItems`, `channel-fulfillment-authority.repository.ts:1946–1970`). It is not the historical quantity-adjustment writer. Automatic corruption of canonical demand from that append is **not proven**. Full support needs a separately tested database proof and the existing omission materialization/projector flow together; changing the trigger's number alone is insufficient proof of end-to-end correctness.

## Runtime trace: confirmed remaining work

1. **Both actual shipment callers still use the legacy recorder.** `ShipStationService.recordInventoryForShipment`, `server/modules/oms/shipstation.service.ts:2544`, and channel ingress `recordInventory`, `channel-fulfillment-ingress.service.ts:172`, call `InventoryUseCases.recordShipment` (`inventory.use-cases.ts:631`). Runtime construction is in `server/services/index.ts:487,500`. The canonical dispatch repository still has no production construction.
2. **Source-bin persistence partly exists already.** `persistCanonicalWmsPickProgress`, `server/modules/wms/order-item-commands.ts:408–418`, fills NULL bins on planned/queued source rows from canonical pick progress. It cannot fill rows created after picking and does not overwrite existing bins. Its unpick branch at line422 does not reconcile those source bins. A pick-A/unpick/repick-B stale-bin scenario is a code-supported **hypothesis requiring a regression**, not a reproduced production incident.
3. **The real publication owner currently opens another transaction.** `PostgresInventoryAvailabilityRuntimePublicationExecutor.execute`, `inventory-availability-runtime-publication.repository.ts:106–154`, opens/commits its own SERIALIZABLE client. Calling it inside dispatch's required `beforeCommit` callback would not be atomic. The existing `enqueueFullPublications` owner at line494 must be reused through a tested caller-owned transaction boundary, not replaced by provider calls or an empty callback.
4. **The two ingress sequences differ.** ShipStation changes status and records inventory before later physical materialization (`shipstation.service.ts:3178,3274,2764`); channel ingress materializes/projects physical evidence before inventory (`channel-fulfillment-ingress.service.ts:360,421,450`). Replays must reuse the original immutable dispatch command, not rebuild it from newly available physical IDs.

### Next connected implementation batch

- Extract the real publication owner's existing planning/outbox work into a caller-owned transaction API, with its standalone executor delegating to it.
- Resolve canonical shipment commands from exact source and claim-picked lineage; reuse committed command replay first. Do not pick a "latest" claim, invent a fallback bin or overwrite historical source identity.
- Route both real ingress callers through one persisted-authority-aware recorder, retaining same-transaction legacy authority exclusion and forbidding canonical-to-legacy fallback.
- Prove publication failure rollback, both physical-ID orderings, multi-line recovery, concurrent dispatch/unpick/corrections, and unsupported shipment purposes before runtime construction.
- Include canonical omission proof/materialization compatibility, not just its reader, before claiming that operation is supported.
- Then complete legacy demand/custody reconstruction and the final atomic activation/recovery contract from the authority audit. Activation remains separately reviewed production work; this batch does not provide permission to enable it.

## Validation and failure limits

- Full unit suite: **929 files passed, 1 skipped; 9,835 tests passed, 37 skipped**. Includes writer-ratchet and migration-prefix guards.
- Shipment quantity UI CI step: **17 tests passed** (formatter/CSV and rendered mobile/desktop history).
- Nine inventory PostgreSQL suites: **212 tests passed**; includes 23 new actual-projection tests with migration0662 and real canonical dispatcher/WMS/inventory owners.
- New historical reader PostgreSQL suite: **6 tests passed**.
- Existing package-allocation PostgreSQL suite: **23 tests passed** with only missing read-side receipt-table fixture prerequisites added.
- Total PostgreSQL checks: **241 passed**, each suite isolated in a disposable database. The local cluster is not production.
- Typecheck, production build and whitespace checks passed. Build retains the existing large-client-chunk warning.
- CI includes the two browser-contract files and both new PostgreSQL suites. No new migration number is needed.

Reduced fixture tables prove exact read behavior, rollback and snapshot isolation, not complete historical migrations or live-data correctness. The dispatch projection suite additionally applies actual0662 and proves deferred journal rejection without disabling its triggers. Whole-API browser visual QA, live provider flows, installed production trigger versions, production authority and the final runtime concurrency/activation integration remain unverified. No stock/configuration/provider mutations were executed.
