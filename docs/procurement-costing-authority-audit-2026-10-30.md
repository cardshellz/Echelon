# Purchase costing ownership review — 2026-10-30

## Scope and evidence

Target design: approved invoice costs replace provisional PO costs for the quantity covered; payments settle the payable; one shared cost projection feeds PO, shipment, receipt, inventory and downstream costing. This is the agreed design criterion for this review.

Fetched and pinned merged main at `e571bcac780852c3ac6b488354c10aaf7f1c417c`. The reviewed procurement/inventory/shared purchasing files, both detail pages, and service composition match that commit byte-for-byte in this checkout. Local HEAD is `cf345b71b62c804b87d76e9b74499865ec61a3b2`. No tracked production code or live records were changed. Findings below concern code paths and synthetic evidence; this review does not quantify historical production misstatements.

Executable, database-free characterization: [purchase-cost-authority-audit.ts](evidence/procurement-cost-authority-audit-20261030.ts). Captured results: [purchase-cost-authority-audit-results.json](evidence/procurement-cost-authority-audit-20261030.json). All amounts in the probe are synthetic integers.

## What the code definitely does

There is already a versioned cost application owner worth retaining. The gap is that not every financial reader and mutation participates in it.

| Step | Existing owner and trace |
| --- | --- |
| Read supplier sources | `readPurchaseCostSources` reads PO product/packaging amounts and invoice lines whose headers are approved, partially paid or paid. It does not read payment allocations or use paid amounts as product cost. [Repository](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/purchase-cost-source.repository.ts#L47). |
| Select PO versus invoice | `resolvePurchaseCostSource` chooses estimated PO components or confirmed invoice components, subject to the gates discussed below. [Resolver](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/domain/purchase-cost-source.ts#L55). |
| Record financial authority | `recordCostRevision` validates a source contract, locks the inventory cost graph, reuses an unchanged fingerprint and otherwise appends a revision. [Revision owner](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/cost-source-revision.repository.ts#L7). |
| Apply supplier costs | `reconcilePurchaseCostEvidence` records the selected revisions and calls the same inventory application owner for product and packaging. [Application service](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/purchase-cost-application.service.ts#L25). |
| Apply shipment costs | `applyShipmentCostRevisions` records landed-charge revisions and calls `applyCostRevision`. [Shipment application](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/shipment-cost-application.service.ts#L35). |
| Propagate downstream | `applyCostRevision` walks recorded receipt/transfer/conversion origins, allocates exact totals and revalues components through `COGSService`; it records applications, before/after snapshots and reporting events. Unchanged applications can replay. [Inventory application](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/inventory/application/apply-cost-revision.ts#L48). |
| Admit receipt costs | `resolveReceiptCostEvidence` calls the supplier and shipment revision owners, uses the receipt's saved pack conversion and marks unresolved costs provisional. Receiving then creates stock through `inventoryCore.receiveInventory`. [Evidence](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/receipt-cost-evidence.service.ts#L31), [receiving](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/receiving.service.ts#L1670). |
| Recover receipt supplier costing | A durable request commits with the receipt. The post-close worker invokes supplier-cost reconciliation; financial failure does not require re-receiving goods. [Queue](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/receipt-cost-queue.service.ts#L28), [composition](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/services/index.ts#L390). |

These controls should be extended and connected, rather than introducing a second posting engine or weakening audit, locking, currency or lineage checks.

## Confirmed gaps against the agreed design

### F1 — P1: PO, shipment and inventory source selection use different financial projections

`readPoShipmentCosts` reads `purchase_orders.total_cents`; `evaluatePoShipmentCosts` adds saved shipment allocations to that PO amount. `projectPoLineLandedCosts` likewise uses saved PO line totals and ordered quantity. Neither financial projection selects the current supplier invoice revision. Meanwhile inventory supplier costing can select approved invoice components.

The shipment's `getEnrichedLines`/`projectLineProductValue` calls `projectShipmentProductValue`, which adds shipment charges to the PO **product-only** total. Packaging is absent from that displayed landed amount. The shared supplier-status DTO carries revision IDs and completion metadata but not a common selected monetary projection for these screens.

The pure probe demonstrates the conflict for the same 100 synthetic pieces:

| Fact/result | Amount |
| --- | ---: |
| PO product + packaging | $1,000 |
| Approved invoice product + packaging | $1,200 |
| Allocated freight | $200 |
| Agreed design's landed amount | **$1,400** |
| Current PO landed projection | **$1,200** |
| Current shipment landed projection | **$1,100** |

This is an executable projection discrepancy, not proof that a particular live ledger contains those numbers.

Sources: [PO header read](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/po-shipment-cost-summary.repository.ts#L31), [PO combined total](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/domain/po-shipment-cost-summary.ts#L252), [PO line projection](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/shared/procurement/po-line-landed-cost.ts#L128), [shipment projection](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/shipment-tracking.service.ts#L596), [product-only arithmetic](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/domain/shipment-allocation-basis.ts#L138).

Required cleanup: expose a common selected-cost projection, with exact totals, quantity coverage, source/revision, provisional/confirmed state and posting status. Every screen consumes that projection for the same scope. Keep the PO's contractual amount separately labeled. Keep allocation-basis policy separate from the full landed-price display.

### F2 — P1: Approved partial invoices cannot establish actual cost for their covered quantity

`purchaseInvoiceEvidence` sums invoice quantities for the whole PO line. `resolvePurchaseCostSource` requires that sum to equal the entire required quantity, and requires every invoice component breakdown to parse. Otherwise both components remain based on the full PO quote and become review-required. The revision scope represents one amount/quantity pair per purchase line, not mixed confirmed and provisional coverage.

Probe: 100 pieces on the PO, an approved $600 invoice for 50 pieces with a complete breakdown. The current resolver returns the original $1,000 PO basis for 100 pieces with `INVOICE_COMPONENT_REVIEW_REQUIRED`; it does not use $600 for the covered 50 pieces and retain a PO estimate for the rest.

Sources: [coverage basis](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/domain/purchase-cost-source.ts#L19), [all-or-nothing gate](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/domain/purchase-cost-source.ts#L63), [revision scope](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/cost-source-revision.repository.ts#L20).

Required cleanup: resolve explicitly covered quantities/intervals, prevent overlapping invoice coverage and preserve provisional costs for uncovered goods. Define the policy for allocating invoice coverage to receipts instead of arbitrarily choosing stock lots.

### F3 — P1: Admin invoice corrections stop before cost application

`persistInvoiceQuantityCorrection` updates the invoice quantity and optional amount, clears component evidence when money changes, recalculates invoice/PO financial aggregates, recomputes matching and appends approval history. Its complete path does not invoke or queue supplier/shipment cost reconciliation. `recalculateCorrectedInvoiceFinancialsInTransaction` recalculates invoice totals, balance and linked PO aggregates only.

Consequently a successful document correction is not a completed downstream cost correction. A quantity-only correction can make formerly invalid invoice coverage valid without applying it. A money correction intentionally clears the breakdown, leaving another review before actual costs can replace the quote.

Sources: [correction write](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/invoice-quantity-correction.repository.ts#L50), [financial recalculation](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/ap-ledger.service.ts#L3137), [normal approval contrast](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/ap-ledger.service.ts#L1470).

Required cleanup: the approved correction must include the necessary cost-source disposition and either apply its complete cost impact transactionally or commit a durable, visible costing continuation. The preview must show document totals and downstream cost effects. Preserve original approvals and physical quantities.

### F4 — P1: A changed freight invoice does not become the shipment's cost authority

`resolveShipmentChargeEvidence` takes its effective amount from the shipment charge's actual/estimated fields. An approved invoice is accepted only if its linked lines equal that amount. A changed invoice produces `LANDED_INVOICE_AMOUNT_REVIEW` instead of an approved replacement cost revision.

Creation allows explicit invoice-line overrides, but `createInvoiceFromShipmentCosts` updates charge linkage/status without replacing the charge amount or recalculating allocations. The charge edit command then rejects financial changes to an AP-linked charge. Invoice approval reconciliation collects PO-line IDs, so freight-only invoice lines do not enter shipment recosting through that path.

Probe: a $200 charge estimate linked to an otherwise valid approved $220 freight invoice produces review-required. The invoice does not supply the selected $220 costing amount. The mismatch check prevents a silent inconsistency; the missing piece is an owning reconciliation operation that actually resolves it.

Sources: [charge authority](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/domain/shipment-charge-evidence.ts#L97), [mismatch guard](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/domain/shipment-charge-evidence.ts#L142), [invoice override](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/ap-ledger.service.ts#L3785), [link-only update](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/ap-ledger.service.ts#L3867), [AP-owned lock](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/shipment-tracking.service.ts#L973), [approval reconciliation scope](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/ap-ledger.service.ts#L1479).

Required cleanup: one approved freight reconciliation accepts the authoritative billed amount, preserves its earlier estimate and source, recalculates charge shares, and invokes the existing landed-cost application owner. Retain the AP ownership lock and exact matching guard.

### F5 — P1: Settlement-only changes can invalidate unchanged shipping costs

Paid amounts are not the pricing basis, but invoice **status** is selected into shipment source evidence. `buildShipmentCostRevisionProposals` hashes the entire invoice row into references and retains the raw rows as source evidence. `retainEquivalentShipmentCostSource` normalizes nullable relationship fields only. `currentShipmentCostSourceIssue` marks a different fingerprint outdated.

Probe: changing only `approved` to `paid`, with the same $220 amount and confirmed authority, changes the source fingerprint and yields `COST_UPDATE_OUTDATED`. The charge-authority function itself returns the same confirmed result for approved, partially paid and paid. Economic identity and settlement metadata therefore disagree about equivalence.

Sources: [selected status](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/shipment-cost-revision-read.repository.ts#L102), [invoice hash](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/shipment-cost-revision-proposals.ts#L119), [raw source evidence](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/shipment-cost-revision-proposals.ts#L153), [equivalence policy](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/shipment-cost-source-identity.ts#L24), [outdated result](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/domain/current-shipment-cost-source.ts#L35).

Required cleanup: define economic identity independently of settlement progress. Approved/partially-paid/paid transitions with unchanged cost authority preserve costing completion. Disputes, voids, changed amounts/currency/source relationships still receive explicit review. Do not simply ignore all status changes or overwrite historical approvals.

The supplier side also hashes the complete PO source row into a revision even after the invoice has become authoritative. The probe changes only the superseded PO product price: `resolvePurchaseCostSource` returns an identical confirmed invoice input, but `recordCostRevision`'s fingerprint formula changes because the complete PO row is retained in `sourceEvidence`. Keep that PO change in document audit; cost-currentness should distinguish retained supporting history from fields that actually determine the selected invoice cost. [Supplier revision recording](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/purchase-cost-application.service.ts#L20), [full-evidence fingerprint](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/cost-source-revision.repository.ts#L16).

### F6 — P2: New transformed lots invalidate a frozen completion list

`projectPurchaseComponentStatus` requires today's graph lot IDs to match the application-time list and snapshots exactly. Adding a new descendant alone changes applied to review-required. The existing unit test explicitly expects that behavior.

Inventory conversion/repacking already copies product, packaging and landed components into output lots and records exact contribution links. The completion check does not accept that inheritance proof as an alternative to every descendant appearing in the original application snapshot. A new descendant is therefore sufficient to demand another application even when the transformation carried costs correctly.

The probe reproduces applied -> `COST_APPLICATION_SCOPE_CHANGED` after adding lot 902 to a previously complete lot-901 scope, with unchanged source and original amounts. This does not prove that the two live PO exceptions have no dollar differences; those particular lot histories still need a separate trace.

Sources: [scope comparison](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/domain/purchase-cost-status.ts#L98), [saved snapshot coverage](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/purchase-cost-status.repository.ts#L105), [inherited repacking costs and links](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/inventory/application/inventory.use-cases.ts#L1882), [existing test](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/__tests__/unit/purchase-cost-status.test.ts#L87).

Required cleanup: prove current coverage through approved applications plus exact transformation inheritance, or append an automatic continuation when actual recosting is needed. Missing links or wrong values remain actionable; unchanged approved money does not require another approval.

### F7 — P2: Known bill totals, component breakdowns and adjustments are coupled too tightly

A full approved invoice without `cost_component_evidence` cannot replace PO costs. An exact, documented nonzero adjustment also remains unsupported: `resolvePurchaseCostSource` raises review whenever `adjustmentMills !== 0`, even when the component sum exactly equals the invoice total. The pure probe reproduces both cases. The strict checks are intentional safety behavior, but the selected cost model has no supported disposition for these ordinary financial facts.

There is also an unconnected PO adjustment path: PO headers include shipping/tax/discount in totals, and non-product PO lines can be allocated by `computeAllocatedLineCosts`. The current supplier source repository reads only product/packaging line components plus line-level tax/discount and PO currency; it excludes header amounts and non-product sources. Receipt evidence uses that resolver. A search found the older allocator exposed separately, not called by this receipt/revision path. Thus its existence does not establish one shared treatment of these charges.

Sources: [breakdown gate](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/domain/purchase-cost-source.ts#L65), [adjustment restriction](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/domain/purchase-cost-source.ts#L110), [selected fields](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/purchase-cost-source.repository.ts#L47), [older PO allocation owner](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/purchasing.service.ts#L747), [separate exported entry](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/purchasing.service.ts#L8784), [header totals](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/purchasing.service.ts#L2111).

Required cleanup: distinguish a known total from a known internal split; preserve the full approved amount without inventing product/packaging evidence. Define explicit treatment and allocation for discounts, credits, tax and supplier freight, including exclusion where appropriate. An unclassified amount remains visible and unresolved instead of silently disappearing or becoming a guessed component.

### F8 — P1 control gap: Ordinary invoice approval is not bound to the reviewed financial version

The approval route passes invoice ID and user ID into the command. `ApLedgerCommandInput` has no expected invoice/cost-preview version. `approveInvoiceInTransaction` locks and approves the current row and can immediately recost inventory. The lock provides atomicity, but it does not prove the operator saw the version being approved. A draft amount can change between opening the invoice and approving it.

Sources: [HTTP approval input](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/ap-ledger.routes.ts#L166), [command input](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/ap-ledger.service.ts#L408), [locked approval and recost](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/ap-ledger.service.ts#L1431), [UI approve action](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/client/src/pages/APInvoiceDetail.tsx#L279).

Required cleanup: an approval binds invoice economics and downstream impact to a reviewed version, validates it under the existing locks, and returns a stale-preview error when that financial scope changes. Keep the existing durable idempotency command owner.

### F9 — P2: Shared costing results are still lost at UI boundaries

Receipt review filters shipping lines by PO-line identifiers, while the shipment reader/route omit the opt-in that preserves those IDs. Completed shipping details disappear from receipts. Supplier scope issues are also classified into a generic accounting task that renders receipt/invoice links instead of the supported apply action.

Sources: [shipment hook](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/client/src/features/purchasing/use-shipment-cost-review.ts#L10), [route](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/inbound-shipment.routes.ts#L458), [DTO negotiation](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/shared/procurement/shipment-cost-review-version.ts#L6), [receipt membership filter](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/client/src/features/purchasing/ReceiptSupplierCosts.tsx#L53), [task classification](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/shared/procurement/cost-review-tasks.ts#L81), [task action](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/client/src/features/purchasing/CostReviewPanel.tsx#L38).

Required cleanup: preserve the shared identity/result contract across every reader and provide the owning resolution action with its preview. No SKU guessing, warning suppression or duplicated financial calculation in the UI.

## What is likely happening

HYPOTHESIS: these overlapping gaps explain why the experience feels like repeated repairs: document edits can finish before costing does; different screens compute different totals; payment progress can invalidate unchanged costs; later repacking can invalidate a static completion list; and the task view can omit completed work or lack a resolution action. Each mechanism above is proven in code or a pure probe. Assigning a particular historical production warning or dollar discrepancy to one mechanism still requires that record's before/after trace.

## What is not proven

- The production dollar exposure across all POs, inventory lots, order costs or external accounting books has not been measured. No new production queries or writes were performed in this audit.
- The two specific live supplier scope warnings have not been proven to be value-neutral. Do not clear them or reapprove their original costs without checking current component totals and inheritance.
- Recognized COGS needs an additional boundary check. `hasVerifiedCostSale` is explicitly used by the repaired-history path; ordinary `cascadeRecostExactQuantities` selects lot-linked `oms.order_item_costs` without a sale-state filter. Those rows are also created at picking. Updating order cost basis is not by itself proof of recognizing an expense. Trace reporting/recognition before claiming incorrect COGS or changing that policy. [Conditional repaired policy](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/inventory/application/apply-cost-revision.ts#L253), [cost-basis cascade](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/inventory/cogs.service.ts#L146), [pick cost owner](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/inventory/lots.service.ts#L425).
- Current posting owners require explicit USD evidence. Foreign currency is rejected/reviewed rather than silently converted; a general FX costing policy is not implemented by the traced resolver. [Currency selection](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/domain/purchase-cost-source.ts#L148), [posting gate](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/inventory/application/apply-cost-revision.ts#L87).
- Tax inclusion/recovery, allocation of invoice coverage to receipt intervals and treatment of combined supplier amounts require explicit business rules. No rule or historical split was invented in this review.

## Next checks and cleanup sequence

1. Extend the existing versioned cost-source model into a common monetary projection: selected supplier cost, covered/provisional quantity, charges, exact totals, currency, source revision, application status and approval provenance.
2. Separate economic identity from settlement metadata. Prove that paying a bill cannot reopen an unchanged cost posting while disputes/voids and actual financial changes remain controlled.
3. Connect every supported financial mutation to the existing cost application pipeline. Start with approved invoice corrections and freight invoice variances. Use versioned before/after previews and one owning approval; make any deferred work durable and visible.
4. Add quantity-scoped invoice precedence and explicit adjustment/inclusion policies. Preserve received/shipped/paid facts and exact amount conservation.
5. Make current cost completion account for proven transfer/repacking inheritance. Keep real unlinked or financially incorrect descendants actionable without repeating unchanged approvals.
6. Move PO, shipment, receipt, dashboard, lifecycle and history monetary reads onto the common projection. Preserve scope/return navigation and display the appropriate shares.
7. Retire or redirect competing calculations only after caller coverage is proven. Keep historical reconciliation separate from engineering deployment; use read-only production comparisons to identify any required corrections.

Required acceptance matrix: no invoice; full invoice variance; partial/multiple invoices and receipts; split shipments and multi-PO shipments; freight estimate-to-actual variance; packaging included/separate/unknown split; discounts/tax/credits/returns; invoice correction after payment; payment-only transitions; receipt configuration changes; late costs after verified sales; repacking after posting; duplicate/retried commands; failed audit/posting rollback; and concurrent edits between preview and approval. Each case must assert exact totals, unchanged physical/payment facts, source/revision agreement on all screens and absence of duplicate costs/approvals.

## Validation completed

- **379 existing unit tests passed across 13 files.** Coverage included supplier status/source decisions, charge confirmation, allocation basis, PO landed projections, cost contracts, application math, sale evidence, source equivalence/currentness, invoice corrections and receipt recovery.
- The first unit invocation was stopped before tests by Windows sandbox temporary-file rename permissions. The same focused tests ran successfully with execution outside that sandbox restriction.
- The pure diagnostic script passed and captured nine areas: PO/invoice selection, partial coverage, missing component evidence, nonzero invoice adjustments, conflicting monetary projections, freight invoice variance, settlement-only invalidation, superseded quote edits and descendant completion behavior. Its assertions characterize current behavior; they do not endorse it as the target design.
- PostgreSQL integration tests, external accounting acceptance and a new full browser flow were **not** run during this code audit. Existing convergence integration tests use explicit freight finalization/application and a helper for supplier reconciliation; their presence does not prove that every real approval/correction route invokes the whole flow. [Existing convergence cases](https://github.com/cardshellz/Echelon/blob/e571bcac780852c3ac6b488354c10aaf7f1c417c/server/modules/procurement/__tests__/integration/receiving-cost-application.integration.test.ts#L511).

## Changes, assumptions, risks and failure modes

Changes: ignored local audit artifacts only. No implementation, migrations, PR or live financial changes.

Assumptions: the earlier agreed invoice-first/provisional-PO design is the review criterion. Probe amounts and identifiers are explicitly synthetic. No assumption was made about actual supplier evidence, sales or missing stock history.

Risks demonstrated: understated or inconsistent displayed landed amounts; approved costs waiting on whole-line coverage; document corrections leaving valuation stale; freight variance dead ends; unchanged costs resurfacing after settlement or repacking; approval of a financial version the operator did not review.

Failure modes to preserve during cleanup: invalid or ambiguous evidence remains explicit; financial operations retain transactions, exact integer totals, locks, idempotency and before/after audit; unknown history cannot become an invented sale/expense; unchanged original approvals remain traceable; a cost failure must not replay physical receiving or payments.
