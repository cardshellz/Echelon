# RFQ quote review and draft purchase handoff

`rfq-workflow.service.ts:createRfqWorkflowService` records vendor quote evidence and creates a reviewed draft PO through the existing purchasing owner. These commands do not send anything to a vendor. New requests continue to originate in the Order Builder.

## Exact evidence and conversion

- Migration 224 adds immutable quote revisions and exact RFQ-line / quote-revision / PO-line links. Original RFQ quantities remain unchanged. Before updating legacy quote mirrors, the command records their complete previous row in the audit event.
- A quote preserves its original price basis: per piece, per purchase unit with a frozen factor, or extended product total. Normalized piece costs retain their signed division residual. Stored scalar amounts must match that preserved basis exactly.
- Packaging starts unknown. A quote can be recorded with unknown or inclusive packaging, but draft conversion requires a separate explicit amount, including zero. The existing PO owner and database require USD; foreign quotes remain readable evidence and require currency review.
- An RFQ can produce multiple POs from disjoint selected lines. Each line converts once; a cancelled PO retains its original source link. A new purchasing request is needed for a replacement purchase.
- Conversion validates the reviewed workflow version, selected quote revision, quote expiry, supplier/catalog identity through the PO owner, and warehouse. A changed purchase quantity needs an explicit reason.
- `createPurchaseOrderWithLines` accepts an internal transaction. Its existing create attempt runs as a savepoint, preserving PO-number collision retries while quote links, line states, PO events, and RFQ audit commit or roll back together.
- Both write commands use durable financial command identities. An uncertain browser response retries the same payload and key. Quote edits preserve the version opened for review; changing the workflow after line selection requires renewed selection.

## Current supplier quantity review

`rfq-workflow.repository.ts:loadRfqWorkflow` reads the immutable recommendation's `evidence_snapshot.supplierBasis` and the current vendor mapping's MOQ, operational pack, and purchase-unit factor. `shared/procurement/rfq-quantity-review.ts:reviewRfqQuantity` applies the same order-multiple precedence as `purchasing-recommendation.engine.ts`: purchase-unit factor above one, otherwise an operational pack above one, otherwise one piece. An explicitly null MOQ is unstated; missing historical rule fields remain unknown.

`assertRfqQuoteCanConvert` requires the existing `quantityOverrideReason` when the source supplier/rules changed, historical rules were not preserved, the quoted quantity is below current MOQ, or it is outside the current order multiple. Compatible quantities under unchanged valid rules need no additional reason. A reason cannot override malformed current rules. The original vendor quote remains the quantity and price authority: conversion never pads or rounds its pieces to a new case or minimum.

Current and historical rules participate in the reviewed workflow version. The conversion transaction acquires the common inventory cost graph lock before RFQ/source locks, then holds vendor mapping SHARE locks through the existing PO owner. The catalog update owner also takes the graph lock before vendor, product, and mapping locks. A stale UI version fails before purchase creation. Exact rules, issues, actor, and reason are recorded in the conversion audit; the immutable RFQ/PO link retains the reason even when requested and quoted quantities are equal. Idempotent replay returns the original purchase after subsequent catalog changes.

## Quantity pricing capability boundary

The existing data contracts support one reusable supplier price and one price/quantity basis per immutable RFQ quote revision. `shared/schema/procurement.schema.ts:vendorProducts` stores scalar `pricingBasis`, `quotedUnitCostMills`, `piecesPerPurchaseUom`, and MOQ, with a unique supplier/product/variant business key. `shared/procurement/rfq-workflow.ts:rfqQuotePricingSchema` stores one per-piece, per-purchase-unit, or extended-total price for a quoted quantity. `assertRfqQuoteCanConvert` accepts only the latest revision; older revisions preserve history.

There is no quantity-tier schedule in those contracts: no breakpoint ranges, concurrent alternative tiers, tier-selection rule, or automatic discount evaluation in `purchasing-recommendation.engine.ts:resolveSupplierCost`. A vendor's selected discounted quote can be recorded explicitly today, including its exact quantity and price; a reusable multi-tier schedule and optimization across tiers remain unsupported. This change does not add a catalog redesign.

## Sourcing reservation handoff

`domain/rfq-sourcing-reservation.ts:rfqPendingSourcingPieces` separates historical request quantities from pending purchasing reservations:

- Unlinked active RFQs retain their existing requested quantity as the reservation. Missing historical links are not invented.
- An exact linked draft or pending-approval PO reserves its current open line remainder. This remains true if the old RFQ is later cancelled: the purchase has its own lifecycle.
- Approved, sent, acknowledged, partially received, received, closed, and cancelled POs no longer reserve demand through the RFQ. Planning already reads committed PO supply or received stock.
- A committed or terminal linked PO changed after the target recommendation run makes that run stale for new RFQ creation. Both the owner and migration 224 allocation guard require a fresh run. Header and line update times are checked. This is conservative: a later metadata edit can also require a new run because existing snapshots do not contain a complete PO state fingerprint.

The locked allocation reader, requirement queue, automatic RFQ owner, and database guard use this handoff. PO/receipt cost graph locking begins before recommendation, catalog, or purchase locks.

## Review surface and verification

`ProcurementRfqs.tsx` loads an exact `?rfqId=` workflow independently of recent-list pagination. `RfqWorkflowPanel.tsx` provides quote authoring, exact totals and packaging, preserved revision history, selection, draft conversion, and direct purchase links. View permission allows inspection; purchasing edit permission controls writes.

Focused unit tests cover input bounds, exact decimal parsing, pricing consistency, lifecycle gates, authority, durable command scope, currency, and reservation handoff. Sixteen disposable PostgreSQL cases exercise the real PO owner, idempotent replay, overlapping conversions, audit rollback, immutable history, draft quantity changes, stale supply, and later purchasing after approval or completion. Twelve browser cases cover desktop/mobile authoring, lost-response retry, direct links, permissions, ambiguous packaging, currency display, changed selections, and explicit MOQ/order-multiple review without altering quoted pieces.

## Purchase-to-RFQ navigation

`readPurchaseRfqOrigins` in `purchase-rfq-origin.repository.ts` reads the immutable conversion link and verifies its purchase, line and quote identities. `PurchaseRfqOrigins.tsx` opens the existing RFQ workflow inline on the purchase lifecycle page; its full RFQ link retains the exact RFQ ID. Older purchases without recorded conversion links remain unlinked rather than using a supplier/SKU guess. Conflicting identities or an over-limit history fail explicitly.

The real RFQ conversion PostgreSQL fixture verifies the reverse reader against the PO and exact line that the actual purchasing owner created, and excludes an unrelated purchase. Seven focused origin tests cover identity conflicts, bounded history and missing quote evidence. Two additional desktop/mobile browser cases verify opening and closing the RFQ details, then inspecting a shipment while the purchase URL stays open.
