# Exact shipment value allocation

Reviewed base: `a18a6501dde0ba9457aaf08ca3c542285b2fc8c1` on 2026-10-14. This addresses procurement finding F18. Quarantine PR1789 is merged into that base and deployment is operator-confirmed; independent production acceptance is not established here.

## Confirmed defect and authority

`shipment-tracking.service.ts` previously built value-based allocation from `unitCostCents * qtyShipped`. For PO product totals of 490 and 500 cents, each ordered and shipped as 1,000 base pieces, rounded unit cents are 0 and 1. A 990-cent duty charge therefore split as 0/990 instead of 490/500. The current-base reproduction exercised the actual allocation service.

`purchaseOrderLines.totalProductCostCents` is explicitly the product-total authority in `shared/schema/procurement.schema.ts`. `resolveShipmentProductValue` in `domain/shipment-allocation-basis.ts` now uses that recorded total multiplied by shipped base pieces and divided by ordered base pieces. This preserves the existing PO-value source policy; it does not introduce invoice-value, customs-value, packaging, tax, discount or quote-remainder policy.

`allocateShipmentCents` distributes integer cents using exact integer fractions and largest remainders. Shipment line ID breaks exact ties deterministically. Repeating partial-shipment ratios remain fractions throughout allocation. Decimal numbers and six-place database fields are display/compatibility mirrors only; neither owns the distribution.

## Source evidence and failure behavior

Each new allocation records versioned `basis_evidence`: method, original PO/dimension source, exact line and total fractions, and whether the established all-zero fallback applied. Landed snapshots separately record `product_value_evidence`. Frozen product evidence supplies per-piece compatibility projections without reading a subsequently edited PO. `recordShipmentCostRevisions` captures the same source for financial revision identity.

Value allocations require a product PO line belonging to the shipment's linked PO, an explicit nonnegative integer product total, positive ordered and shipped base-piece quantities, and USD currency. Missing, malformed, unsupported or out-of-range evidence produces an actionable review result. Legitimate zero-value sources remain distinct from missing data. The established equal split for all-known-zero values remains visible as a warning.

Source changes, allocation amount changes and altered saved evidence invalidate a previously calculated value allocation. Old numeric-only value allocations require an explicit rerun; the system cannot prove their original product source. Existing numeric-only dimensional allocation compatibility remains. An orphan shipment line retains the existing missing-source handling rather than acquiring an invented zero product value.

The cost-graph lock, shipment lock and transaction protect allocation, snapshots and source revisions. The direct HTTP charge and physical-line command owners now acquire that same graph lock before source reads and shipment locks, matching standalone allocation/finalization and PO amendments. A failure rolls back the entire attempt. The existing financial-command identity and source-revision application owners handle retries and sold-stock COGS. This change creates no separate posting authority.

Closed-shipment adjustments retain the full before/after total difference while separately describing product projection and each landed-charge component. A legacy source is explicitly unavailable; its changed projection is not asserted to be a historical price change. Even offsetting component changes retain audit history. Invalid prior amounts or frozen evidence block replacement.

## Release and recovery

1. PR1792 allocates `migrations/900000005000017920001_shipment_exact_value_basis.sql`, with generated ownership/dependency metadata and the integration fixture referencing that file. Its SQL bytes are identical to the reviewed candidate.
2. Drain old procurement writers, apply the allocated forward migration, then run the new application code. It adds nullable JSON evidence columns and version checks; no historical allocation, inventory lot or COGS value is rewritten.
3. For an affected shipment, review the PO source and the displayed allocation blockers. Correct invalid source records through their existing owner. Use **Re-run allocation** to calculate new allocation evidence, then **Finalize** to replace the current landed snapshot. Closing also finalizes through the existing command path.
4. Review **Push Costs to Lots** results separately. Shipment closure alone is not proof that financial application completed. Use the existing retry command after resolving reported review issues; do not fabricate a source value or apply manual rounding corrections.
5. Preserve prior cost-source revisions, adjustments and financial applications. Historical live data requires an explicit review; the migration is not historical remediation.

Do not drop evidence columns during an application rollback. Old code cannot honor exact value evidence; keep affected allocation/finalization/cost-application writes paused until the compatible version is restored. Other financial changes, including shared-invoice PO attribution (F19), void/replacement recovery (F21), and durable post-close recovery (F23), remain separate work.

## Limits

Exact evidence has a bounded 1,024-digit ratio representation; an unsupported source fails explicitly rather than being approximated. Compatibility cents and per-piece mills round once from exact totals. This does not change the existing inventory extended-total authority or imply that multiplying rounded per-piece displays conserves the source total.

The shared graph lock serializes these command paths with other financial writers; throughput was not benchmarked. The migration and local tests do not prove hosted CI, deployment, production prevalence, live repair or full procurement acceptance. Local PostgreSQL validation uses version17; hosted CI uses its configured PostgreSQL version.
