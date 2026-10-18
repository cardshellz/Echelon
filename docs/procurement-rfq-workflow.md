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
