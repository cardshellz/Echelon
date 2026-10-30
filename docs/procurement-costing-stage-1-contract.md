# Stage 1: purchase cost authority contract

Tracker: [purchase costing cleanup](procurement-costing-cleanup-plan.md). Baseline findings and pinned source links: [authority audit](procurement-costing-authority-audit-2026-10-30.md).

State: additive contract and pure projection implemented; receipt allocation policy and supplier tax policy are awaiting the user's answers. This document records the foundation and the boundaries that later stages must satisfy. The new projection is not connected to runtime readers or posting commands.

## Implemented contract

[`purchaseCostAuthorityInputSchema` and `purchaseCostAuthoritySchema`](../shared/procurement/purchase-cost-authority.ts) validate both sides of [`projectPurchaseCostAuthority`](../server/modules/procurement/domain/purchase-cost-authority.ts). The function has no database, clock, network, stock mutation or posting side effect. It returns a monetary projection; it grants no permission to change a financial source.

| Input | Meaning and owning evidence |
| --- | --- |
| `scope` | Stable PO/PO-line identity, explicit currency and the positive base-piece quantity being costed. This quantity is supplied by the owning adapter; the projection does not edit ordered, shipped, received or invoiced quantities. |
| `quote` | Agreed PO amount, optional product/packaging split, explicit adjustments and the quote's own quantity denominator. Missing amount is `null`; it never means free goods. |
| `invoices` | Referenced invoice lines, their actual quantities, amounts, approval states and optional exact receipt coverage. `approved`, `partially_paid` and `paid` all establish the same cost authority. Draft, received, disputed and voided bills do not. |
| `receiptCoverage` | Non-overlapping, zero-based intervals in the supplied purchase-line cost scope, with stable receiving-line IDs. These are normalized financial coverage facts, not a statement that an invoice creates a receipt. The later database adapter must prove the receiving-line membership, immutable piece conversion and interval origin. |
| `shipmentShares` | Existing allocated amounts for this scope, each tied to one shipment, shipment line, charge, category and financial source. The full charge amount is retained for validation; only its saved share enters this scope's landed total. |
| `shipmentCostCoverage` | Explicitly not applicable, complete with saved charge evidence, or awaiting source. An empty query result cannot silently establish zero freight. A genuine zero charge can be supplied explicitly. |
| `receiptAllocationPolicy` | Explicit receipts, an explicitly chosen PO-line blend, or unresolved. No policy is inferred from invoice creation order or a convenient lot. |
| `application` | Recorded application IDs, the identity they applied and original approvals. Missing application evidence is distinct from a known monetary total. |

The output retains the agreed quote separately from the selected supplier total. It includes each selected source's original amount, projected amount, quantity denominator, currency, revision ID and known approval provenance. Unknown revision/approval details remain `null`; they are not synthesized from the current operator or time.

Monetary certainty, stock allocation and posting state are separate:

- `sourceState`: estimated, confirmed, mixed or review required. A confirmed invoice with estimated freight is mixed.
- `coverage`: confirmed and provisional pieces plus the receipt-allocation disposition. A known invoice amount can coexist with an unresolved receipt destination.
- `application.state`: not requested, pending, applied, changed source, review required or retry required. Applied requires actual recorded application references, complete cost evidence and no unresolved allocation.

For a synthetic 100-piece line, a $1,000 PO estimate, a full $1,200 approved invoice and $200 allocated freight produce **$1,400 landed cost**. The $1,000 agreement remains visible separately. For a $600 approved invoice covering 50 pieces, the supplier projection is $600 actual plus $500 provisional for the other 50. Without receipt links or an approved blending policy, the $1,100 amount remains known while stock assignment requires a decision.

## Exact money, breakdowns and adjustments

The existing inventory contract defines one mill as 1/100 cent, or 1/10,000 USD: [`cost-source-contracts.ts`](../shared/procurement/cost-source-contracts.ts). The new contract uses the same unit. All external numbers must be safe integers; arithmetic and sums use `BigInt`, then explicitly reject results beyond the supported JSON integer range. Strings, booleans, fractional currency and unsafe integers are rejected, not coerced.

[`purchaseCostAmountSchema`](../shared/procurement/purchase-cost-authority.ts) requires:

```text
goods + signed adjustments = document amount
product + packaging = goods, when the split is known
inventory cost = goods + explicitly included adjustments
landed cost = selected supplier inventory cost + saved shipment shares
```

A `null` breakdown preserves the full combined goods amount with unknown product/packaging amounts. It does not assert zero packaging or put the same combined amount into both components. The Stage 2 persistence adapter must support that distinction before an unknown split can produce new financial rows.

Each adjustment has a stable key, category and explicit treatment: inventory, excluded, or unclassified. Discounts and credits are signed amounts; tax and supplier freight are separate named categories. Unclassified nonzero adjustments preserve the document amount but leave included/landed cost unavailable. Opposite unclassified amounts cannot cancel into false completion. No supplier tax policy is activated by this representation.

[`projectAuthorityAmount`](../server/modules/procurement/domain/purchase-cost-authority-money.ts) uses cumulative half-away-from-zero rounding for a selected provisional fraction, retaining exact document/component conservation. Adjustment order is normalized by stable key. This is one purchase-line source projection, not an allocator for independently rounding every receipt or lot. The existing exact interval allocation owners must conserve the complete source across destinations in Stage 2/3.

A smaller scope uses the quote's original denominator. A larger scope cannot extrapolate an estimate without an explicit financial source for the extra goods. A full approved invoice can cover that larger actual scope. A foreign-currency source remains visible with its own currency, but does not become USD or enter a mixed-currency sum.

Saved charge shares must reference the current selected source amount, have a consistent sign and not exceed their charge. Shares from the same charge must agree about shipment, source, category and evidence. A financial source cannot be claimed by two charges or counted again after supplying the selected goods amount. A negative charge requires an explicit supplier-credit source. These checks do not replace the later database proof that a share belongs to this exact PO line or that all shares across a consolidated shipment reconcile.

## Economic identity and historical compatibility

The new `economicFingerprint` hashes normalized selected financial facts, quantity denominators, relevant receipt coverage, currency, allocation disposition and charge shares. It changes for a real selected amount, source, classification or quantity change. It does not change for:

- approved → partially paid → paid with identical cost authority;
- a quoted amount that is fully replaced by the selected invoice;
- timestamps, approval display metadata or revision serial IDs;
- input ordering of invoices, adjustments or receipt intervals.

Original application IDs and approvals are returned unchanged. A mismatch against their recorded economic identity reports `source_changed`; the pure function never creates a replacement application or approval.

The canonical SHA-256 function moved to [`inventory/domain/cost-fingerprint.ts`](../server/modules/inventory/domain/cost-fingerprint.ts). [`cost-evidence-values.ts`](../server/modules/inventory/infrastructure/cost-evidence-values.ts) retains its existing export. The implementation's bytes are unchanged, with a fixed canonical-hash fixture and regression suites. Existing revision writers still hash the exact same legacy inputs.

Compatibility requirements for Stage 2, before activation:

1. Preserve every immutable legacy source revision, fingerprint, application, approval and reporting event. This stage performs no schema migration or historical rewrite.
2. Normalize the captured economic facts of an old revision through a read-only adapter. Prove source IDs, currency, scope, amount, component treatment and quantity coverage; carry the original revision/application/approval IDs separately.
3. Compare semantic money and authority, not a legacy byte hash against the new projection hash. A changed hash format is not evidence that approved money changed.
4. If the facts are equivalent, preserve the original application and approval provenance. Use the existing owning continuation only where actual downstream cost work is required.
5. If evidence is incomplete or money differs, retain an explicit issue and produce the existing approved before/after workflow. Do not fill an unknown split with product cost, manufacture an expense, reapprove unchanged money or overwrite old postings.
6. Keep existing full-quarantine-return/no-inventory-effect contracts on their current owner until the new adapter proves their compatibility. The new positive-quantity projection does not replace those zero-effect proofs.
7. Add real PostgreSQL compatibility, retry, concurrent-source-change and rollback tests before any new representation reaches `recordCostRevision` or `applyCostRevision`.

No compatibility bridge or runtime activation is claimed by the pure contract tests.

## Reader and writer ownership map

This map identifies the paths traced for F1-F9. The later activation PR must enumerate all callers of the replaced projections and commands; this bounded map is not proof that every repository caller has been migrated.

| Concern | Actual file/function and current behavior | Integration stage |
| --- | --- | --- |
| Agreed PO amount | [`purchasing.service.ts`](../server/modules/procurement/purchasing.service.ts): `calculateLineCosts`, `computePoTotalsFromLines`, `computeAllocatedLineCosts` calculate commercial PO amounts and allocations. [`po-amendment-costs.service.ts`](../server/modules/procurement/po-amendment-costs.service.ts): `refreshPoAmendmentCosts` invokes supplier reconciliation and shipment allocation refresh. | S2 preserves the PO agreement and uses common selected money for impact; S4 replaces independent current-cost displays. |
| Supplier evidence and selection | [`purchase-cost-source.repository.ts`](../server/modules/procurement/purchase-cost-source.repository.ts): `readPurchaseCostSources`; [`domain/purchase-cost-source.ts`](../server/modules/procurement/domain/purchase-cost-source.ts): `resolvePurchaseCostSource`. Existing all-or-nothing coverage and breakdown restrictions remain active. | S2 adapts explicit sources and quantity coverage; requires the pending receipt/tax decisions. |
| Source revisions | [`cost-source-revision.repository.ts`](../server/modules/procurement/cost-source-revision.repository.ts): `recordCostRevision` locks and records immutable source contracts with legacy evidence fingerprints. | S2 extends this owner after the compatibility proof. |
| Supplier application | [`purchase-cost-application.service.ts`](../server/modules/procurement/purchase-cost-application.service.ts): `recordPurchaseCostRevisions`, `reconcilePurchaseCostEvidence` call the existing inventory owner. | S2 uses this owning pipeline; no second posting engine. |
| Normal invoice approval/dispute/void | [`ap-ledger.service.ts`](../server/modules/procurement/ap-ledger.service.ts): `approveInvoiceInTransaction`, `reconcileApprovedInvoiceVariance`, `disputeInvoiceInTransaction`, `voidInvoiceInTransaction`. Approval currently reconciles PO-line costs; its command lacks a reviewed cost version. | S2 binds a reviewed version and includes all affected source scopes. |
| Approved invoice edits | [`invoice-quantity-correction.repository.ts`](../server/modules/procurement/invoice-quantity-correction.repository.ts): `persistInvoiceQuantityCorrection` updates documents/matching/history without invoking the cost owner. [`invoice-cost-review.service.ts`](../server/modules/procurement/invoice-cost-review.service.ts): component review can invoke reconciliation. | S2 connects all approved financial edits to one pipeline or durable continuation. |
| Freight/AP relationship | [`ap-ledger.service.ts`](../server/modules/procurement/ap-ledger.service.ts): `createInvoiceFromShipmentCostsInTransaction` links an invoice without replacing charge amounts. [`domain/shipment-charge-evidence.ts`](../server/modules/procurement/domain/shipment-charge-evidence.ts): `resolveShipmentChargeEvidence` flags invoice/charge differences. | S2 adds an owning approved estimate-to-actual reconciliation while retaining AP source locks. |
| Shipment cost commands | [`shipment-tracking.service.ts`](../server/modules/procurement/shipment-tracking.service.ts): `executeCostCommandInTransaction`, `updateCostsInTransaction`; [`shipment-cost-application.service.ts`](../server/modules/procurement/shipment-cost-application.service.ts): `applyShipmentCostRevisions`. | S2 uses these existing allocation/revision/application owners and the shared selected source. |
| Receiving cost admission/recovery | [`receipt-cost-evidence.service.ts`](../server/modules/procurement/receipt-cost-evidence.service.ts): `resolveReceiptCostEvidence` uses saved receive conversion and current revision owners. [`receipt-cost-queue.service.ts`](../server/modules/procurement/receipt-cost-queue.service.ts): `enqueueReceiptCostRequests`, `processReceiptCostRequests` retain supplier-cost recovery after physical receipt. | S2 connects complete source scope; S3 proves descendants; physical receiving is not replayed to retry money. |
| Lot valuation and propagation | [`inventory/application/apply-cost-revision.ts`](../server/modules/inventory/application/apply-cost-revision.ts): `applyCostRevision`; [`inventory/cogs.service.ts`](../server/modules/inventory/cogs.service.ts): exact revaluation; [`inventory/application/inventory.use-cases.ts`](../server/modules/inventory/application/inventory.use-cases.ts): repacking carries components and contributions. | S3 extends exact source coverage and inheritance without changing physical counts. |
| Current supplier status | [`domain/purchase-cost-status.ts`](../server/modules/procurement/domain/purchase-cost-status.ts): `projectPurchaseComponentStatus` compares current graph membership with recorded application snapshots. | S3 accepts proven inheritance; genuine missing cost links remain actionable. |
| PO totals and line displays | [`po-shipment-cost-summary.repository.ts`](../server/modules/procurement/po-shipment-cost-summary.repository.ts): `readPoShipmentCosts`; [`domain/po-shipment-cost-summary.ts`](../server/modules/procurement/domain/po-shipment-cost-summary.ts): `evaluatePoShipmentCosts`; [`shared/procurement/po-line-landed-cost.ts`](../shared/procurement/po-line-landed-cost.ts): `projectPoLineLandedCosts`. Current projections use PO amounts. | S4 consumes selected supplier money plus this PO's saved charge shares. |
| Shipment line displays | [`shipment-tracking.service.ts`](../server/modules/procurement/shipment-tracking.service.ts): `getEnrichedLines`; [`domain/shipment-allocation-basis.ts`](../server/modules/procurement/domain/shipment-allocation-basis.ts): `projectShipmentProductValue` currently projects product-only PO value. | S4 includes applicable packaging and shared selected source; allocation basis remains a separate policy. |
| Pipeline/dashboard | [`purchase-pipeline.repository.ts`](../server/modules/procurement/purchase-pipeline.repository.ts): `createPurchasePipelineRepository`; [`purchase-pipeline.service.ts`](../server/modules/procurement/purchase-pipeline.service.ts): `componentCost` uses recorded component revisions or quotes. | S4 uses the common projection, scope and current application result. |
| Receipt/lifecycle/UI boundary | [`ReceiptSupplierCosts.tsx`](../client/src/features/purchasing/ReceiptSupplierCosts.tsx), [`use-shipment-cost-review.ts`](../client/src/features/purchasing/use-shipment-cost-review.ts), [`CostReviewPanel.tsx`](../client/src/features/purchasing/CostReviewPanel.tsx), [`shipment-cost-review-version.ts`](../shared/procurement/shipment-cost-review-version.ts). Audit F9 proves identifier/result/action gaps. | S4 carries stable relationship IDs and owning actions through every DTO; keeps return navigation. |
| Immutable posting history/report delivery | [`apply-cost-revision.ts`](../server/modules/inventory/application/apply-cost-revision.ts) appends cost applications/snapshots/report events. [`cost-reporting.repository.ts`](../server/modules/procurement/cost-reporting.repository.ts) validates delivery evidence; [`cost-reporting.transport.ts`](../server/modules/procurement/cost-reporting.transport.ts): `sendCostReport` sends an acknowledged HTTPS envelope. | S2/S3 retain these owners; S4 renders original approval/history from persisted evidence. |

## Verified sales and recognition boundary

The concrete trace is:

1. [`InventoryLotService.pickFromLots`](../server/modules/inventory/lots.service.ts) writes `oms.order_item_costs` while picking. Those rows identify order cost basis; their existence alone is not proof the goods shipped or that an accounting expense was recognized.
2. [`COGSService.cascadeRecostExactQuantities`](../server/modules/inventory/cogs.service.ts) selects lot-linked order-cost rows, revalues exact intervals and returns a delta. The ordinary selection has no sale-state filter.
3. [`applyCostRevision`](../server/modules/inventory/application/apply-cost-revision.ts) uses [`reviewRepairedOrderCosts`](../server/modules/inventory/application/repaired-cost-order-review.ts) only for a persisted repaired-origin policy requiring verified sales. That reviewer calls [`hasVerifiedCostSale`](../server/modules/inventory/domain/verified-cost-sale.ts), checking recorded order/item, cancellation and fulfillment evidence before allowing the relevant COGS update.
4. `applyCostRevision` records `cogsDeltaCents` in `inventory.cost_reporting_events`. [`inventoryCostReportEventSchema`](../shared/procurement/cost-report-delivery.ts) carries that aggregate and historical adjustments; the ordinary aggregate does not itself carry per-order sale-recognition proof.
5. [`COGSService.getOrderCOGS` / `readOrderCOGS`](../server/modules/inventory/cogs.service.ts) read order financial snapshots and recorded costs in one repeatable-read snapshot. [`buildOrderCOGSReport`](../server/modules/inventory/domain/order-cogs-read.ts) validates and sums them; it does not filter by fulfillment or recognize a journal expense.
6. The reporting repository/transport validate and deliver the event. This code trace does not establish the external receiver's journal-recognition policy or prove that delivery is enabled in production. No live configuration or external accounting record was read for this stage.

Decision for later implementation: preserve the distinction between updating an order's cost basis and changing recognized expense. S2/S3 must prove the reporting/recognition boundary and verified sale coverage before changing COGS event semantics. The available code proves a missing universal distinction in this event path, not an actual posting to an external general ledger. Stage 1 changes neither cost rows nor recognition behavior.

## Pending decisions and limits

Two questions were sent to the user during Stage 1 and are still unanswered:

1. For multiple invoice lines linked only to a PO line, require receipt allocation where costs differ, or blend actual supplier cost across that PO line? Until answered, the model calculates known money but returns `INVOICE_RECEIPT_ALLOCATION_REQUIRED` rather than choosing lots.
2. Classify each supplier tax charge, include all supplier tax, or exclude all supplier tax? Until answered, only an explicitly supplied treatment is modeled; no global tax inclusion rule is activated.

Header-level and non-product adjustments still need a proven, stable allocation into these line source facts. The new adjustment schema supports their exact signed money and disposition, but an arbitrary residual is not evidence of a header allocation. The existing header/line writers are not changed in Stage 1.

S1 source tests do not prove database ownership, stored compatibility, transaction rollback, concurrency, HTTP permissions, browser flows, FX conversion, external accounting acceptance or historical production values. Those remain in the tracker rather than being marked complete by a pure projection.

## Validation and failure behavior

Tests: [`purchase-cost-authority.test.ts`](../server/modules/procurement/__tests__/unit/purchase-cost-authority.test.ts), [`purchase-cost-authority.validation.test.ts`](../server/modules/procurement/__tests__/unit/purchase-cost-authority.validation.test.ts), [`cost-fingerprint.test.ts`](../server/modules/inventory/__tests__/unit/cost-fingerprint.test.ts). Fixtures are explicitly synthetic.

Coverage includes invoice precedence, partial/overlapping coverage, unknown split versus zero, included/excluded/unclassified adjustments, exact signed rounding, stale/duplicated/overallocated charges, mixed source states, unsupported currency, invalid/unsafe inputs, payment-independent identity and original application/approval preservation. Outbound schemas reject conflicting totals, coverage and completion claims.

`PurchaseCostAuthorityError` classifies invalid input, unsupported exact range, invalid quantity ratio and invalid internal output. Valid but unresolved financial evidence returns named issues and preserves source facts; it does not silently price missing data at zero. There is no financial transaction to roll back in this pure stage. Existing transaction, audit, locking and idempotency owners remain required for S2 activation.

Exact final commands, results and implementation commit are recorded in the main tracker. Hosted CI, database/full browser acceptance and deployment are separate evidence.
