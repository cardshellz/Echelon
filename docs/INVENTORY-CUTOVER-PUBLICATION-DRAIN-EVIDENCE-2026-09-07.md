# Inventory cutover: publication drain evidence

## September 8 implementation follow-up

This file preserves the **pre-fix investigation** and its historical line references. The user subsequently approved the local publication-admission, durable catch-up, recovery, and cutover-proof implementation. See [the September 8 test handoff](INVENTORY-CUTOVER-TEST-HANDOFF-2026-09-08.md) for the current code and validation record. The earlier instruction to retain the unconditional blocker below is superseded by evidence-based readiness checks; unresolved or stale evidence still blocks activation. No production activation or provider request was performed locally.

## Historical investigation

Recorded: 2026-09-07. Documentation-only bounded follow-up; no provider, production database, channel setting, or inventory changes were performed for this investigation.

Inspected checkout: `C:/Users/owner/Echelon/worktrees/inventory-cutover-final-batch`, based on commit `213a50cce0b4e6322df7166db24ab75c902db9d5`, including the uncommitted coordinated final-batch work. Paths below are complete repository-relative paths; line references describe this checkout, not a deployed build.

## Outcome

**Confirmed: the existing runtime-authority lock and open configuration freeze do not establish a complete legacy-publication drain. Final activation must remain blocked.**

The authority lock drains the legacy callbacks that use the publication executor while an exclusive authority lock is held. It does not suppress subsequent legacy callbacks after preparation commits, and several quantity-capable listing paths do not use that executor. A fresh provider readback can therefore predate a later provider quantity write.

The final-batch review explicitly reports `CUTOVER_LEGACY_PUBLICATION_DRAIN_UNPROVEN`: `server/modules/inventory-planning/infrastructure/inventory-cutover-review.repository.ts`, `captureInventoryCutoverReviewInsideTransaction`, lines 35-40. This is an unresolved readiness blocker, not a claim that publication suppression has been implemented.

Migration `232_inventory_cutover_admission.sql` was not created or executed because its write-guard scope requires approval. The current final-batch admission helper is not evidence that a migration-backed global barrier exists. The writer-ratchet baseline was also not modified. Neither approval would, by itself, prove the external-provider lifecycle described here.

## 1. What the existing lock and freeze definitely do

| Evidence | Confirmed behavior and reasoning |
| --- | --- |
| `server/modules/inventory-planning/infrastructure/inventory-availability-runtime-atp.repository.ts`, `loadAndLockRuntimeAuthority`, lines 87-98 | Reads the singleton authority with `FOR SHARE`. The selected columns are authority, authority revision, and activation run ID; this query does not read the configuration freeze. |
| `server/modules/inventory-planning/infrastructure/inventory-availability-runtime-publication.repository.ts`, `PostgresInventoryAvailabilityRuntimePublicationExecutor.execute`, lines 109-121; `createPublicationContext`, lines 217-222 | Opens a transaction, obtains the authority through the context, awaits the supplied work, then commits. Therefore the authority share lock encloses the awaited legacy callback, not merely its initial authority decision. |
| `server/modules/inventory-planning/application/inventory-availability-runtime-publication.service.ts`, `AuthorityAwareInventoryPublicationService.publishProduct`, lines 145-155; `publishVariantAvailability`, lines 166-184 | If the pinned authority is `legacy`, immediately awaits `legacyPublisher()`. Neither fallback checks an open activation freeze. An exclusive authority lock can drain these callbacks, but after that lock is released a new callback still sees legacy authority and proceeds. |
| `server/modules/inventory-planning/infrastructure/inventory-availability-activation.repository.ts`, `PostgresInventoryAvailabilityActivationRepository.prepare`, lines 82-197; `inCutoverTransaction`, lines 372-381 | Preparation is a finite transaction that records preparation/conservative-publication work and returns without changing runtime authority to canonical. Its transaction lock does not remain held throughout subsequent provider publication/readback. The new admission helper referenced by this batch remains migration-blocked as noted above. |
| `migrations/0638_inventory_availability_cutover.sql`, `inventory.guard_cutover_configuration_write`, lines 495-516; attached triggers, lines 520-574 | The durable open freeze is checked by configuration-table row triggers. The existing implementation uses the activation-run GUC as its exception. These triggers neither intercept provider HTTP calls nor change the publication service's legacy fallback decision. |

**Conclusion:** adding a freeze check to the routed callback would be a new implementation, not behavior already supplied by these locks or triggers. Database write rejection after a provider call cannot undo the external call.

## 2. Quantity-capable paths identified in this bounded trace

The table distinguishes routed inventory publication from listing lifecycle writes. Sharing an ATP reader does not imply sharing publication admission or a lock held through the provider request.

| Path | Exact files, functions, and relevant lines | Finding |
| --- | --- | --- |
| Normal channel inventory sync | `server/modules/channels/echelon-sync-orchestrator.service.ts`, `syncInventoryForProduct`, lines 253-264; `syncInventoryForProductLegacy`, line 267; `pushInventoryToChannelWarehouseAware`, line 377, provider calls at 502 and 809 | Routed through `inventoryPublication.publishProduct`. Existing authority-share protection encloses this callback. It still resumes under legacy authority after preparation commits. |
| Variant availability worker | `server/modules/channels/variant-availability-sync.service.ts`, `processClaim`, publication call at 136-142 and completion at 143-145; `publishLegacyAvailability`, provider call at 272 | Routed through `publishVariantAvailability`. Provider work is inside the authority callback, but feed/worker completion is outside it. |
| eBay maintenance sync | `server/routes/ebay/ebay-sync-helpers.ts`, `syncActiveListings`, line 205, ATP capture at 462-465, draft at 528, connector call at 537; `triggerPricingRuleSync`, lines 633-661 | Captures ATP, builds a quantity-bearing listing draft, then directly calls the listing connector. This call path does not use the inventory publication executor or consult the activation freeze. A pricing-triggered maintenance sync can also use this path. |
| eBay maintenance entry points | `server/routes/ebay/ebay-listings.routes.ts`, POST `/api/ebay/listings/sync-all`, lines 1161-1163; POST `/api/ebay/listings/sync-product/:productId`, lines 1175-1182; GET `/api/ebay/listings/sync-stream`, line 1194, ATP capture at 1406-1408, connector call at 1493 | These are executable HTTP entry points for the maintenance paths, not proof that they are currently running in production. The streaming path also captures ATP before its direct provider call. |
| eBay listing push/rebuild | `server/routes/ebay/ebay-listings.routes.ts`, POST `/api/ebay/listings/push`, line 402, ATP capture at 587-589, connector calls at 679-693; GET `/api/ebay/listings/push-stream`, line 796, ATP capture at 1010-1012, connector call at 1050 | Quantity-bearing listing creation, update, and rebuild paths invoke the connector outside the inventory publication executor. |
| Shared eBay connector writes | `server/modules/channels/listing-connectors/ebay-listing.connector.ts`, `syncExistingListing`, lines 585-617; `pushListing`, lines 147-199; `updateExistingListing`, line 351, provider mutations at 422-480; `server/routes/ebay/ebay-listing-draft-builder.ts`, `buildEbayRouteListingDraft`, quantity selection at 89-93 | Maintenance calls `updateOffer` with the draft payload and `createOrReplaceInventoryItem` with the draft inventory payload. The route draft uses the supplied ATP map for listed variants. These are quantity writes, not metadata-only updates. |
| Dropship eBay listing worker | `server/modules/dropship/application/dropship-listing-push-worker-service.ts`, `processItem`, lines 193-247; `server/modules/dropship/infrastructure/dropship-ebay-listing-push.provider.ts`, `pushListing`, lines 113-138; `buildDropshipEbayListingDraft`, lines 637 and 699-704 | Worker calls the provider from persisted listing intent. The provider passes `intent.quantity` to the listing builder and invokes the shared connector directly. No inventory publication executor or activation-freeze check is present in this traced worker/provider path. |
| Explicit eBay zeroing | `server/routes/ebay/ebay-listing-state.ts`, `zeroEbayVariantListing`, lines 290-336, called from `server/routes/ebay/ebay-config.routes.ts`, line 412; `server/modules/channels/listing-connectors/ebay-listing.connector.ts`, `disableRetainedVariation`, lines 556-578 | Direct quantity-zero writes also bypass the inventory publication executor. They cannot increase exposure, but they still invalidate a claim that *all* remote quantity writers are drained. |
| Generic eBay listing adapter | `server/modules/channels/echelon-sync-orchestrator.service.ts`, `syncListingsForChannel`, line 1108, adapter call at 1247; `server/modules/channels/adapters/ebay.adapter.ts`, `pushListings`, line 132, `pushSingleListing`, lines 167-208; `server/modules/channels/adapters/ebay/ebay-listing-builder.ts`, `resolveAvailableQuantity`, lines 537-544 | This listing path is separate from `publishProduct`. In the inspected adapter call no quantity override is provided, so the builder returns zero for missing quantities. Do not describe it as a positive ATP feed; it remains a quantity-capable listing mutation. |
| Canonical/conservative outbox transport | `server/modules/channels/channel-inventory-publication-transport.adapter.ts`, `publishAbsolute`, lines 26-47; `server/modules/inventory-planning/application/inventory-publication-outbox.service.ts`, `processDue`, line 58, provider call at 116 | The dedicated outbox transport passes exact destination/scope and `authority: canonical_outbox` to the adapter. This is intentional outbox-owned provider work, not the legacy fallback. A future legacy-suppression mechanism must preserve the intended conservative publication/readback workflow. |

Two search matches are **not** evidence of an active positive-quantity bypass:

- `server/modules/channels/sync.service.ts`, private `pushWithRetry` at line 619, leads to old direct Shopify helpers, but the inspected class has no caller of `pushWithRetry`. Its public `syncProduct` at lines 146-204 delegates to the orchestrator and fails closed if no orchestrator is wired. The private chain should not be reported as a confirmed live fallback.
- `server/modules/channels/adapters/ebay.adapter.ts`, `pushPricing`, lines 522-555, uses the bulk price/quantity endpoint but the inspected payload contains price fields and no available quantity. Endpoint naming alone is not evidence of an inventory write.

## 3. Retry, dirty-state, and watermark evidence

| Evidence | Confirmed behavior; limitation |
| --- | --- |
| `shared/schema/channels.schema.ts`, `channelFeeds`, lines 118-137 | `last_synced_at` and `last_synced_qty` are feed-level fields. They are not an immutable exact-destination provider-attempt journal. The unique feed identity is channel/variant, not publication destination/location. |
| `server/modules/channels/echelon-sync-orchestrator.service.ts`, `pushInventoryToChannelWarehouseAware`, provider call at 809, success update at 821-831; `recordNonShopifyInventorySyncSuccess`, lines 1575-1630 | Updates the local success watermark after provider success. A successful remote call followed by a failed local update does not have a guaranteed new success watermark in this path. This is a possible failure sequence supported by the ordering, not a claim that it occurred. |
| `server/modules/channels/variant-availability-sync.service.ts`, `processClaim`, lines 136-145; `server/modules/channels/variant-availability-sync.repository.ts`, `markVariantAvailabilitySynced`, lines 330-369 | The provider callback returns and its routing transaction releases before the separate completion transaction persists the feed watermark. Draining the routing lock alone does not guarantee that this local success watermark is already visible. |
| `server/modules/channels/sync.service.ts`, `pendingSyncs`, line 87; `queueSyncAfterInventoryChange`, lines 296-425 | Ordinary inventory-change work is debounced in an in-memory map. The timer removes the pending entry at line 351 before invoking `syncProduct` at 397; its catch at 418-423 logs failure. This path does not persist a suppressed-work or retry marker. Merely skipping these callbacks during a freeze would not establish durable catch-up. |
| `server/modules/channels/variant-availability-sync.service.ts`, `processClaim`, failure handling at 159-174; `server/modules/channels/variant-availability-sync.repository.ts`, `markVariantAvailabilityFailed`, lines 516-546 | This worker does have durable retry state: lease is cleared, state becomes retryable, and `next_attempt_at` is advanced with bounded backoff. That does not establish a general dirty-work mechanism for the ordinary debounce and listing paths. |
| `server/modules/dropship/application/dropship-listing-push-worker-service.ts`, `processItem`, lines 236-265; `server/modules/dropship/infrastructure/dropship-listing-push-worker.repository.ts`, `failItem`, line 274, terminal-status persistence at 372-425 | Listing failures and retryability metadata are persisted. A cutover-freeze-specific suppression/replay and abort catch-up contract is not present in this inspected path. This report does not claim that retryable metadata alone guarantees rescheduling. |

## 4. Abort behavior

`server/modules/inventory-planning/infrastructure/inventory-availability-activation.repository.ts`, `PostgresInventoryAvailabilityActivationRepository.abort`, lines 200-313:

1. Requires the open legacy-authority preparation and an abortable state.
2. Rejects abort while an outbox row for the run is leased, lines 230-243.
3. Cancels desired/queued/retryable/drifted outbox rows, lines 245-250.
4. Marks the activation run failed and releases the configuration freeze, lines 254-264.
5. Persists result, event, and idempotent command receipt, lines 269-312.

**Confirmed limitation:** this function does not enqueue a channel dirty sweep, restore or re-plan the quantities already reduced by successful conservative publication, or persist a catch-up obligation for suppressed ordinary inventory events. It is not evidence of a completed abort-publication recovery contract.

## 5. Why fresh readback is insufficient

The ordering permitted by the traced code is:

1. Conservative publication succeeds and a readback records a sufficiently low quantity.
2. Another permitted legacy or direct listing writer changes remote quantity after that observation.
3. Final cutover drains the routed legacy callbacks and reads the earlier, still-fresh observation.

This is a **possible execution sequence**, not an observed production incident. The direct listing bypasses make a routed-callback-only drain insufficient as well.

The new pure validator correctly checks the evidence it receives: `server/modules/inventory-planning/domain/inventory-cutover-publication-proof.ts`, `validateInventoryCutoverPublicationProof`, lines 64-108, and `isCurrentProof`, lines 111-134. It checks exact identity, valid acknowledgement/readback ordering, freshness, no future timestamps, coverage, and observed quantity against the proposed plan. It cannot prove that no external quantity write occurred after observation. Its documentation explicitly limits that claim.

## 6. Finite closure required before removing the blocker

The following are required acceptance outcomes, **not implemented changes or permission to change production**:

1. **One quantity-publication admission contract.** Every quantity-capable path identified above must participate before provider I/O: routed inventory sync, availability worker, eBay maintenance and push/rebuild, dropship listing workers, and intentional zero/disable paths. Metadata-only work must be demonstrably quantity-free or participate too. The contract must distinguish permitted conservative outbox work from suppressed legacy work and account for already-running attempts.
2. **Durable suppression and catch-up.** Inventory events received during suppression must record a durable coalesced obligation with exact destination/product scope. Process crashes, retries, expired leases, and successful remote writes with uncertain local persistence must not silently discard the obligation. Resume/abort must re-plan current inventory rather than replay stale quantity payloads.
3. **Explicit abort recovery.** Releasing the configuration freeze must atomically retain/enqueue durable catch-up for affected destinations, including successful conservative reductions and suppressed work. Unknown provider outcomes must remain visible until reconciled. An abort response must not imply remote quantities have already been restored.
4. **Post-drain provider proof.** Prove that accepted observations follow every admitted or uncertain quantity attempt for their exact destination/item identity, with no later writer admitted before authority handoff. A mutable feed success timestamp alone is insufficient. Provider I/O must not be smuggled into the database transaction as an ad-hoc workaround; the lifecycle must give the observation a durable, verifiable relationship to the drain boundary.
5. **Regression proof.** Cover writer-before-freeze, writer-during-freeze, readback-then-late-write, remote-success/local-failure, process restart, aborted preparation, and duplicate retry across each admitted owner path. Verify that no suppressed work disappears, conservative work can finish, and activation cannot proceed on unresolved provider outcomes. Remove the readiness blocker only after these finite acceptance cases pass.

## What is not proven

- No production queries, provider reads/writes, credentials, current channel enablement, running jobs, or deployment state were inspected. Executable code paths do not prove current live usage.
- This was a bounded trace of the known inventory publisher, channel adapters, eBay listing routes/connectors, dropship listing worker, and preparation/abort owners. It is not proof against out-of-repository integrations or administrators changing provider inventory directly.
- No migration-backed admission-barrier or complete publication-drain integration test was run for the blocked migration. Unit validation of recorded evidence does not establish external-writer exclusion.
- No new suppression, catch-up, abort-recovery, or provider-attempt lifecycle was implemented in this documentation follow-up.
