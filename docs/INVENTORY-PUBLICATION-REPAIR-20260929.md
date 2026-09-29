# Inventory publication repair — 2026-09-29

## Scope and status

This is a repair to the existing quantity publication path, not a new ATP engine, UI, inventory model, listing creator or cutover approval. It was developed on `codex/channel-quantity-repair`, based on `origin/main` commit `31667182d2e0ae760056961f9c04bfb3df6b1a8e`, in an isolated worktree. No schema migration is needed.

No production quantity, catalog link, channel setting, hold, reservation or authority was changed during this implementation. Production diagnostics were read-only. Local passing tests are not evidence of deployment or successful production cutover.

## What the code definitely does

| Repair | Evidence and reasoning |
| --- | --- |
| Use one bulk request builder and acknowledgement parser for ordinary eBay offer quantity updates, canonical publication and independently credentialed Dropship publication. | `server/modules/channels/adapters/ebay/ebay-quantity-update.ts`, `sendEbayQuantityUpdates` and `readEbayQuantityUpdateResults`. `EbayAdapter.pushInventory` and `publishEbayInventoryQuantity` now call the same sender. The Dropship adapter already delegates to `publishEbayInventoryQuantity`. Existing connections, account identity, admission and readback remain intact. |
| Accept both separate inventory-item/offer results and previously accepted combined/nested results. | `readEbayQuantityUpdateResults` matches exact SKU/offer identities, not array order. An item failure cannot be hidden by an offer success. Missing offer evidence, duplicate acknowledgements, conflicting identities, provider errors and unsuccessful statuses do not confirm success. |
| Validate quantities and batch identities before sending. | `validateUpdates` accepts 1–25 unique SKU/offer operations with nonnegative safe integer quantities. `EbayQuantityUpdateInputError` cannot enter the legacy individual-write fallback. The canonical path still does not fall back to item replacement or another writer after an uncertain result. |
| Commit provider outcomes independently of failed-run cleanup. | `PostgresInventoryPublicationOutboxRepository.recordFailure` and `recordVerified` no longer call global failure finalization. A cleanup failure therefore cannot roll back a committed provider result and restore its lease. |
| Clean up only after provider locks are released, including after a process restart or an empty poll. | `InventoryPublicationOutboxService.processDue` calls `finalizeFailedRuns` before claiming and after processing the batch. The finalizer starts a READ COMMITTED transaction, acquires the existing exclusive cutover admission fence **before** run/outbox locks, and uses the existing audited suppression-release owner. It releases the publication gate/configuration freeze and queues catch-up atomically. |
| Recover expired, unowned worker leases without fabricating provider success. | `recoverExpiredInventoryPublicationLeases` requires expiry and a free target/variant advisory lock. It records `LEASE_EXPIRED`; unknown remote effects stay unknown. `PostgresInventoryAvailabilityActivationRepository.abort` uses this same recovery after obtaining its fence. Unexpired or actively owned leases still prevent abort. |
| Preserve retry and failure evidence. | Cleanup rolls back as a unit on error and can be retried. Concurrent cleanup produces one failed-state event. A permanently failed conservative run cannot claim new work. Existing full-publication behavior after canonical activation remains independent. |

The response-shape defect is demonstrated by deterministic tests and the eBay OpenAPI `BulkPriceQuantityResponse` / `PriceQuantityResponse` definitions. The raw bodies of the original failed production responses were not retained; this repair does **not** prove that every old eBay failure had that cause.

## Validation

- `npm run check` — passed.
- `npm run check:tests` — passed.
- Broad channel, Dropship, inventory-planning and server unit suite — **5,994 passed** before the final adapter regression additions; no skips. Final affected sender/adapter tests plus writer ownership guard — **162 passed**.
- Real disposable PostgreSQL: failure cleanup, complete cutover composition, admission fence, publication admission, canonical catch-up and verified opening — **155 passed**, six files, no skips.
- New PostgreSQL suite uses the actual admission/freeze guards and verifies result durability, injected cleanup rollback, concurrent retries, expired leases, live provider locks, idempotent abort and unchanged inventory.
- New regression suite is included in the PostgreSQL CI manifest and coverage guard. No migration prefix or writer-ratchet baseline changed.
- `git diff --check` — passed. Unrelated changes were preserved. Test-only LF normalization of unchanged Windows checkout files was restored; no migration/schema content is part of this repair.

## Read-only provider findings, separate from the repair

Captured at **2026-09-29 21:39:28 UTC**. These are the same identities stored in the ordinary channel feed and the failed cutover snapshot, not newly invented mappings.

| Channel / local variant | Confirmed provider response | Not proven / action still required |
| --- | --- | --- |
| Shopify 141 — `SHLZ-MAG-35PT-P1` | Stored inventory item `46402733998239` and variant `44262347374751` both return 404; inventory levels are empty. | No current exact-SKU candidate was found. Do not invent a replacement or delete the local product. |
| Shopify 175 — `SHLZ-TOP-TCG-SLIM-CLR-P25` | Stored inventory item `55033676759199` and variant `57859119251615` both return 404; inventory levels are empty. | Neither this SKU nor stored external SKU `SHLZ-TOP-40PT-SLIM-P25` appears in the completed two-page catalog read. |
| Shopify 176 — `SHLZ-TOP-TCG-SLIM-CLR-C1000` | Stored inventory item `55033676791967` and variant `57859119284383` both return 404; inventory levels are empty. | Neither this SKU nor stored external SKU `SHLZ-TOP-40PT-SLIM-C1000` appears in that catalog read. |
| eBay 65 — `ARM-ENV-GRD-C60` | Exactly one offer, `136412200011`, is `UNPUBLISHED`, quantity 0, with no listing ID in the response. | Quantity publication must not create/publish a listing. Confirm exclusion of this non-live destination from the initial existing-listing scope, or restore the listing in its normal workflow. |
| eBay 7 / 64 — `SHLZ-TOP-260PT-P10` / `ARM-ENV-GRD-P10` | Both stored offers still exist and are `PUBLISHED`; exact offer GETs succeed. | This does not explain their prior HTTP 400 responses. Preserve/review the next actual response rather than claim the parser fixed an unobserved response body. |

The first diagnostic-only eBay GET omitted `Accept-Language` and returned error 25709. Repeating it with the **existing adapter's** headers succeeded. That diagnostic error is not evidence of a production header defect; production already sends the required headers.

Local evidence: `C:/Users/owner/Echelon/.codex-artifacts/atp-provider-reference-diagnostics-2026-09-29T21-39-28-124Z.json`. It contains no credentials. No additional listing exclusions or remaps were applied.

## Deployment and recovery sequence

1. Review, merge and deploy this repair. No automatic authority switch or quantity-ledger opening is introduced.
2. Let the existing worker or admitted abort owner close failed run 42; verify its freeze and publication gate are released. The test reproduces its dead-letter-plus-expired-lease shape, but production recovery is not yet verified. Do not manually delete leases or disable guards.
3. Approve retirement of the three missing Shopify links and omission of the unpublished eBay offer from the **initial existing-listing scope**, or supply actual replacement listing identities. Keep local catalog items and warehouse inventory unchanged. These are explicit scope decisions, not automatic successes.
4. Resume the existing approved cutover using current evidence and the repaired sender. Retain exact-destination readback and the existing recovery path for uncertain prior attempts. Do not repeat the retired 54-attempt reconciliation or reinterpret held C1000 cases as shipped.

Risks/unknowns: no production verification of the repaired code yet; old provider responses may represent partial real writes; releasing the global gate does not override unresolved per-scope attempts or provider failures. This repair deliberately does not bypass those distinctions or claim cutover completion.
