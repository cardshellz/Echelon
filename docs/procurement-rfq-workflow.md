# RFQ quote review and draft purchase handoff

`rfq-workflow.service.ts:createRfqWorkflowService` records vendor quote evidence and creates a reviewed draft PO through the existing purchasing owner. These commands do not send anything to a vendor. New requests continue to originate in the Order Builder.

## Exact evidence and conversion

- Migration 224 adds immutable quote revisions and exact RFQ-line / quote-revision / PO-line links. Original RFQ quantities remain unchanged. Before updating legacy quote mirrors, the command records their complete previous row in the audit event.
- A quote preserves its original price basis: per piece, per purchase unit with a frozen factor, or extended product total. Normalized piece costs retain their signed division residual. Stored scalar amounts must match that preserved basis exactly.
- Packaging starts unknown. A quote can be recorded with unknown or inclusive packaging, but draft conversion requires a separate explicit amount, including zero. The existing PO owner and database require USD; foreign quotes remain readable evidence and require currency review.
- An RFQ can produce multiple POs from disjoint selected lines. Each line converts once; a cancelled PO retains its original source link. A new purchasing request is needed for a replacement purchase.
- Conversion validates the reviewed workflow version, selected quote revision, quote expiry, supplier/catalog identity through the PO owner, and warehouse. A changed purchase quantity needs an explicit reason.
- `createPurchaseOrderWithLines` accepts an internal transaction. Its existing create attempt runs as a savepoint, preserving PO-number collision retries while quote links, line states, PO events, and RFQ audit commit or roll back together.
- Quote capture, conversion and reservation release use durable financial command identities. An uncertain browser response retries the same payload and key. Quote edits preserve the version opened for review; changing the workflow after line selection requires renewed selection.

## Current supplier quantity review

`rfq-workflow.repository.ts:loadRfqWorkflow` reads the immutable recommendation's `evidence_snapshot.supplierBasis` and the current vendor mapping's MOQ, operational pack, and purchase-unit factor. `shared/procurement/rfq-quantity-review.ts:reviewRfqQuantity` applies the same order-multiple precedence as `purchasing-recommendation.engine.ts`: purchase-unit factor above one, otherwise an operational pack above one, otherwise one piece. An explicitly null MOQ is unstated; missing historical rule fields remain unknown.

`assertRfqQuoteCanConvert` requires the existing `quantityOverrideReason` when the source supplier/rules changed, historical rules were not preserved, the quoted quantity is below current MOQ, or it is outside the current order multiple. Compatible quantities under unchanged valid rules need no additional reason. A reason cannot override malformed current rules. The original vendor quote remains the quantity and price authority: conversion never pads or rounds its pieces to a new case or minimum.

Current and historical rules participate in the reviewed workflow version. The conversion transaction acquires the common inventory cost graph lock before RFQ/source locks, then holds vendor mapping SHARE locks through the existing PO owner. The catalog update owner also takes the graph lock before vendor, product, and mapping locks. A stale UI version fails before purchase creation. Exact rules, issues, actor, and reason are recorded in the conversion audit; the immutable RFQ/PO link retains the reason even when requested and quoted quantities are equal. Idempotent replay returns the original purchase after subsequent catalog changes.

## Quantity pricing capability boundary

The existing data contracts support one reusable supplier price and one price/quantity basis per immutable RFQ quote revision. `shared/schema/procurement.schema.ts:vendorProducts` stores scalar `pricingBasis`, `quotedUnitCostMills`, `piecesPerPurchaseUom`, and MOQ, with a unique supplier/product/variant business key. `shared/procurement/rfq-workflow.ts:rfqQuotePricingSchema` stores one per-piece, per-purchase-unit, or extended-total price for a quoted quantity. `assertRfqQuoteCanConvert` accepts only the latest revision; older revisions preserve history.

Reusable supplier schedules are owned by `SupplierSourcingService`, with tier selection in `shared/procurement/supplier-sourcing.ts:selectSupplierPriceTier`. An RFQ quote revision records the final selected quantity and price. Conversion preserves that quote; it does not silently resize a quoted quantity or select a different tier when another source already reserves part of the demand.

## Sourcing reservation handoff

`domain/rfq-sourcing-reservation.ts:rfqPendingSourcingPieces` separates historical request quantities from pending purchasing reservations:

- Unlinked active RFQs retain their existing requested quantity as the reservation. Missing historical links are not invented.
- An exact linked draft or pending-approval PO reserves its current open line remainder. This remains true if the old RFQ is later cancelled: the purchase has its own lifecycle.
- Approved, sent, acknowledged, partially received, received, closed, and cancelled POs no longer reserve demand through the RFQ. Planning already reads committed PO supply or received stock.
- A committed or terminal linked PO changed after the target recommendation run makes that run stale for new RFQ creation. Both the owner and migration 224 allocation guard require a fresh run. Header and line update times are checked. This is conservative: a later metadata edit can also require a new run because existing snapshots do not contain a complete PO state fingerprint.

The locked allocation reader, requirement queue, automatic RFQ owner, and database guard use this handoff. PO/receipt cost graph locking begins before recommendation, catalog, or purchase locks.

## Review surface and verification

`ProcurementRfqs.tsx` loads an exact `?rfqId=` workflow independently of recent-list pagination. `RfqWorkflowPanel.tsx` provides quote authoring, exact totals and packaging, preserved revision history, selection, draft conversion, and direct purchase links. View permission allows inspection; purchasing edit permission controls writes.

Focused unit tests cover input bounds, exact decimal parsing, pricing consistency, lifecycle gates, authority, durable command scope, currency, and reservation handoff. The disposable PostgreSQL suite exercises the real PO owner, idempotent replay, overlapping conversions and catalog imports, audit rollback, immutable history, draft quantity changes, stale supply, and later purchasing after approval or completion. The browser suite covers desktop/mobile authoring, lost-response retry, direct links, permissions, ambiguous packaging, currency display, changed selections, and explicit MOQ/order-multiple review without altering quoted pieces. Current execution counts are recorded in the batch validation evidence.

## Purchase-to-RFQ navigation

`readPurchaseRfqOrigins` in `purchase-rfq-origin.repository.ts` reads the immutable conversion link and verifies its purchase, line and quote identities. `PurchaseRfqOrigins.tsx` opens the existing RFQ workflow inline on the purchase lifecycle page; its full RFQ link retains the exact RFQ ID. Older purchases without recorded conversion links remain unlinked rather than using a supplier/SKU guess. Conflicting identities or an over-limit history fail explicitly.

The real RFQ conversion PostgreSQL fixture verifies the reverse reader against the PO and exact line that the actual purchasing owner created, and excludes an unrelated purchase. Seven focused origin tests cover identity conflicts, bounded history and missing quote evidence. Two additional desktop/mobile browser cases verify opening and closing the RFQ details, then inspecting a shipment while the purchase URL stays open.


## Abandoned request recovery and overlapping draft demand

`POST /api/purchasing/rfqs/:rfqId/release` requires purchasing edit permission, a durable command key, the reviewed `expectedVersion`, and a nonempty reason. The existing RFQ command owner takes the graph/header/source locks, cancels only unconverted active lines, and cancels the request header. The audit records actor, time, reason, before/after workflow, exact released line quantities and retained purchase IDs in the same transaction. Quotes, requested quantities and linked purchases remain intact. A lost response retries the exact key and payload; changed request evidence requires a fresh review. An audit failure rolls back release. An ordered line without a verified purchase link blocks release of the whole request because header cancellation would otherwise erase its unresolved reservation.

The RFQ panel displays this recovery beside quote history and purchase links. Release is an internal sourcing action; it does not communicate with a supplier or cancel a purchase order. Converted draft obligations must be edited or cancelled through their purchase owner.

`rfq-sourcing-reservation.repository.ts:loadPendingPurchaseSourcingReservations` is the shared pending-purchase reader for automatic PO and RFQ owners. `pendingPurchaseSourcingPieces` calculates the same validated open draft/pending-approval remainder for both. Automatic PO creation checks current pending purchases and active unconverted requests under common graph/product locks, independent of old decision timestamps, receive variants or recommendation lookback identity. Converted RFQs are counted through their PO once; committed supply remains separate.

A partially covered automatic recommendation is held for review rather than silently repriced. The Runs page shows reserved, suggested and uncovered quantities with exact PO/RFQ recovery links. New manual RFQs overlapping an unrelated pending purchase return `RFQ_PENDING_PURCHASE_REVIEW_REQUIRED`; automatic RFQs record `pending_purchase_review_required`. Linked draft purchases also require review when their global/warehouse scope overlaps but the exact RFQ allocation baseline does not account for them. The existing SQL-enforced RFQ excess-allocation baseline is unchanged. Distinct explicit warehouses remain separate; an unassigned warehouse overlaps explicit warehouse demand.

No data migration, automatic release policy, production repair, supplier dispatch or automation activation accompanies this correction. The existing RFQ integration suite now includes sequential and competing PO/RFQ owners, release versus conversion, same-key release, audit rollback, linked/legacy purchase preservation and overlapping warehouse evidence. The RFQ browser suite covers release/retry/conflict/permissions, linked purchase navigation, and partial reservation recovery from Runs. Final execution counts and release status belong to the batch validation evidence.

## Persistent command recovery and discoverable work lists

The October 21 continuation starts from main `93be8ccd76f5246369284748f0bd2887b11455a9` and incorporates fetched main `bf1507790dc0acb79af19ca4f645f37b1ba74038` before final validation. It keeps the existing quote, release and PO conversion owners and their version/link safeguards. It does not introduce supplier communication.

`shared/procurement/rfq-command.ts` defines the validated command intent and verifiable receipt. The receipt binds the operation, operator, RFQ/line, original reviewed payload and command key to the returned quote, release or purchase link. `rfq-workflow.commands.ts` validates both newly produced and replayed receipts. A terminal rejection carries matching identity only after the command owner retains that rejection. A transport error, an authorization response outside the durable owner, malformed evidence or a mismatched receipt does not establish the prior command's outcome.

The ledger retains its existing service-principal/route/resource/key uniqueness scope. Its new hash binds the actual operator and request. An old key whose saved hash lacks that evidence is refused; it cannot create a second command in a new namespace. Such a legacy conflict requires review of the original record and ledger. Never invent a successful receipt or discard that key just to make the warning disappear. New clients request the envelope with `X-RFQ-Receipt-Version: 1`; legacy callers receive the original strict result shape. The result-format header does not create a new execution identity.

`rfq-workflow.service.ts::executeInTransaction` reads active, unrestricted purchasing edit authority through the Identity owner after acquiring the inventory cost graph lock. The authority locks remain held through the transaction. Read endpoints accept purchasing view or the previously supported inventory view permission; read access does not grant mutation authority.

`client/src/lib/rfq-command.ts` reuses `createPersistentFinancialIntentStore`. One actor-bound unresolved RFQ intent is retained in session storage across tracking-page, expanded-row and embedded PO panels. Saving recovery is a prerequisite to dispatch. The UI retains the original payload/version through reload, failed reads, login failures and unknown outcomes; it never silently rebases the request onto new quote economics. Only matching success or durable-rejection evidence clears the request. Storage read/save/clear failures remain actionable. Current actor, permission and mounted RFQ scope are checked before dispatch, with late callbacks fenced from another operator or record. Manual recovery uses the same key. Session storage persistence is limited to that browser session; no recovery across deliberate storage deletion or another device is claimed.

`rfq-work-list.repository.ts` reads matching count, ordered headers, lines and quote/purchase links in one read-only repeatable-read snapshot. `rfq-work-list.ts` validates bounded paging (default 25, maximum 100), nonnegative offset, stored status and literal RFQ/supplier/SKU search. Percent, underscore and backslash are search text, not uncontrolled wildcards. The additive `page` object supplies total matches and the next offset. Existing `count` and `statusCounts` continue to describe the returned page.

`domain/rfq-work-list.ts::summarizeRfqHandoff` reports verified conversion provenance separately from stored RFQ lifecycle and current PO status. Missing, conflicting or legacy ordered-without-link evidence requires review. A converted RFQ remains linked to a subsequently cancelled PO; it is not presented as active supply or silently converted again. The tracking page uses the common work-list pagination component and retains exact RFQ links outside the current page.

Opened RFQ cards stay mounted during list pagination, filtering, errors and refreshes, including a successful list refresh that no longer contains the opened request. A failed detail refresh also retains unsent editor values. New mutations are disabled while the required read evidence is unverified; receipt recovery remains available. A verified receipt resets the submitting panel's matching intent only. Another panel's unsent values and original review version survive; changed quote evidence requires explicit review before submission. Pending command recovery is durable within the session; unsent drafts remain component state and are not claimed to survive a full reload or explicitly closing their card.

Acceptance coverage is recorded in `rfq-command-recovery.test.ts`, `rfq-work-list.test.ts`, client recovery/component tests, the real PostgreSQL RFQ workflow/work-list/controlled-acceptance suites, and desktop/mobile RFQ workflow/work-list browser tests. The new database suite is explicitly registered in the PostgreSQL CI manifest and its coverage guard.

### October 21 local release validation

The integrated branch passed 4,793 unit/guard cases across 272 files, including the full procurement unit directory, focused RFQ client cases and all nine CI preflight guards. Seven existing database-gated unit cases were skipped and are not counted as passing. Five fresh disposable PostgreSQL suites passed 79 cases: RFQ workflow 57, work list 11, controlled RFQ acceptance 1, persisted financial FLOW 4 and request creation 6. Source identity remained unchanged during every database suite.

All 54 desktop/mobile browser cases passed, including lost quote/conversion/release responses, reload plus 401/403, actor/permission changes, unavailable storage/reads, malformed receipts, two mounted panels, older RFQ discovery, and draft preservation through list/detail refresh failures and disappearing rows. Application, server-test, client-test and scoped browser TypeScript checks passed; the production build and migration identity check passed. Independent server/list/client review found two draft-loss paths; both were corrected and covered by the final browser run.

Evidence is retained in `outputs/procurement-rfq-recovery-2026-10-21`: `release-unit.json`, `browser-release.log`, `release-*.log`, and `final-2026-10-21T14-00-10.238Z-dcecccf5/*.results.json`. The final source starts from main `bf1507790`; only this validation documentation was updated after the frozen runs. The disposable cluster was checked for zero other clients and zero remaining review databases, then stopped. Browser APIs are mocked; PostgreSQL uses real transactions and constraints. No SQL migration, production mutation, hosted-CI result, merge or deployment is claimed by these local results.
