# Combined supplier totals, header adjustments and tax/return attribution

Active implementation following deployed #1993. Initial deployed baseline: `9cf76be54f121ecb611e3adf8c3f4856e09f08dd`; current main `efe0eee86` (#2001) is incorporated; branch `codex/supplier-combined-header-tax-return-costs`. This is continuation of A3/A4 in the existing cleanup plan. It must use the existing transaction, cost revision, inventory application, approval/audit and recovery owners.

## Evidence and required implementation

- [x] Combined goods: extend `invoiceCostComponentEvidenceSchema` and the existing invoice review to represent one supplier goods amount with an unknown product/packaging split. Preserve that explicit basis in source identity and displays. Do not describe a combined total as a known product-only price or invent a packaging amount. Separate packaging credits require an evidenced split.
- [x] Header amounts: `purchase_orders` owns header discount, tax and shipping; `vendor_invoices` owns the gross bill but currently has no classified header allocation owner. `readPurchaseCostSources` selects line amounts, not unallocated header differences. Add exact classified, reviewed line allocations of the original header amounts, with visible proposed defaults and overrides, conservation and current-source checks. Use the existing tax owner for tax treatment, and the existing supplier/shipment cost owners for application. Preserve original bills and cash. Trace old PO header/typed-line allocation before changing its integration so no charge is counted twice.
- [x] Tax credits: attribute refunds to a named original tax source and its configured treatment. Cap cumulative refunds both on that source and, when selected, its saved receipt interval. Inventory tax credits reduce the corresponding selected cost; recoverable tax credits stay outside inventory. Retain source evidence, approval, reversal and original tax amounts. Do not infer a tax type or refund treatment.
- [x] Returns: trace the immutable quarantine/accepted-return owners and the original invoice-to-receipt relationship. Refunding returned goods must not reduce prices on retained receipts. Keep accepted-stock outgoing valuation and financial credit settlement under their existing owners. Add exact supported attribution and a direct review path for genuinely missing source evidence.
- [ ] Source propagation: invoice correction, tax review, header edit, AP transitions, receipt assignment, supplier credits/reversal, transfer/repacking and shared reads must retain these classifications and exact scopes. Do not add another posting engine.
- [ ] Acceptance: deterministic domain cases; real PostgreSQL/HTTP transactions; desktop/mobile connected flows; unchanged bills/cash/counts/prior approvals; partial receipts/provisional pieces; exact remainders; stale data; current assigned authority; concurrency; audit failure rollback; durable retry; credit void and source withdrawal.
- [ ] Publish/update the PR and plan; verify final-head hosted checks separately from merge/deployment/live approval.

Proposed by-value header allocations are review defaults, not facts about the supplier's intent. The approver must see each line's before/after and can override the proposed shares. Unsupported evidence remains visible; a named review is not proof that costs have posted.

## Current handoff

#1993's release, live controls, actual rollback-only review and unchanged financial readback are verified in [the deployment record](procurement-costing-deployment-1993.md). There are no saved production receipt assignments or credit documents for an actual posting acceptance. Discovery above is grounded in `invoice-cost-evidence.ts`, `invoice-cost-review.service.ts`, `purchase-cost-source.repository.ts`, `purchase-tax-evidence.repository.ts`, `supplier-credit-source.service.ts`, `domain/receipt-invoice-costs.ts` and `supplier-return-credit.repository.ts`. Implementation and acceptance boxes remain open until the corresponding code and tests pass.

### Implemented scope and acceptance, 2026-11-04

PR [#2000](https://github.com/cardshellz/Echelon/pull/2000) contains the implementation. It incorporates main `efe0eee86` (#2001). Forward migration `900000055000020000001_supplier_header_tax_return_sources.sql` follows #2001's generation 54, with an explicit dependency sidecar. No production record was changed for this candidate.

The existing owners remain authoritative:

| Concern | Exact owner / resulting behavior |
| --- | --- |
| Known goods total | `invoiceCostComponentEvidenceSchema`, `invoiceGoodsAmounts`, supplier/receipt selectors: explicit `combined` preserves the whole goods amount and unknown split. Separate packaging attribution requires evidence |
| Original header amounts and proposed shares | `buildPurchaseOrderHeaderSource`, `buildInvoiceHeaderSource`, `allocateSupplierHeader`: signed cent conservation, stable ties, parent scopes, manual overrides, configured tax treatment |
| Approval / recovery / history | `createSupplierHeaderCostService`, `readSupplierHeaderReviewSource`: transaction-held graph/source/current Administrator checks, rollback-only preview, measured cost impact, durable command replay, append-only linked PO/audit history |
| Shipment charges | `applySupplierHeaderShipmentCosts` calls the existing reviewed freight amount writer and shipment cost updater. Gross bill shares retain separate recoverable tax and excluded-service portions; `readPoShipmentCosts` agrees with that inventory value |
| Credits | `validateSupplierCreditSourceLines`, `supplierInvoiceAmounts`, `supplierTaxCreditCapIssues`: exact original named tax/receipt/quarantine source, cumulative caps, current configured treatment and original immutable approval. Void uses the existing compensating owner |
| Accepted returns | `loadReturnCreditEvidence`, `acceptedReturnInvoiceAttribution`: original receipt assignment and recorded one-to-one transfers prove billed pieces. Existing outgoing return valuation remains separate from retained stock prices. The credit UI shows frozen receipt/billed ranges |

Verified locally:

- Procurement unit suite: 302 files / 5,348 tests. Client library suite: 70 files / 1,631 tests (includes nine header input/recovery cases).
- Real owner PostgreSQL suite: 410/410; the two added mixed-header/immutable-guard cases also passed. A four-case focused run additionally proves configured tax treatment changes update existing refunds without changing their original credit evidence, and PO selected amounts match actual gross freight/recoverable exclusion.
- Original financial supplier-credit SQL suite: 36/36. Composed lifecycle SQL suite: 4/4, including $4,610 through partial receipts, sale, late freight, actual admin receipt assignment, accepted-stock return, replacement credit, cash settlement and exact-once retry. Its original fixture had enabled receipt-specific costing without saving assignments; the scenario now uses the actual receipt approval owner, rather than weakening the return source check.
- Actual compiled app / PostgreSQL: desktop and mobile receipt-credit regression passed; desktop and mobile combined/header review passed. The latter proves the original $25 receipt becomes $24.67 after its exact header discount share, the second receipt stays $30, original bills/payments/counts/receipt approvals remain unchanged, and reopening shows the saved approver. Mobile 390px and desktop screenshots were inspected.
- A reproduced empty-header review regression is covered: an empty classification does not alter the original invoice fingerprint or make a saved tax refund stale. The 5,348-unit suite and all nine real header HTTP cases passed after the correction.
- App build; application, server-test, client-test and connected-test TypeScript checks. Migration policy validates against incorporated main. Financial coercion/owner guards pass (71 tests); only Procurement owns the new approval table.

Local records are under ignored `.codex-artifacts`: `supplier-final-owner-flow.log`, `supplier-header-current-tax-flow.log`, `supplier-lifecycle-final.log`, `supplier-final-units-5348.log`, `supplier-client-unit-all.log`, `supplier-header-browser-final.log` (receipt regression), `supplier-header-browser-acceptance.log`, `supplier-owner-guards.log`, and the `supplier-*-types*.log` / build logs. Failed exploratory runs are retained separately and are not counted as acceptance. An initial overlapping local SQL/browser run hit Windows PostgreSQL checkpoint/cleanup contention; rerunning suites separately passed without weakening cleanup.

### Remaining boundaries

Source propagation keeps original classification metadata through current goods, receipt, tax and credit readers. Changed header amounts require a new reviewed allocation; manual rules whose line disappeared remain actionable review. Existing mixed goods/freight invoice-correction restrictions remain; this PR does not silently authorize those document edits or infer an exchange rate. Receipt-specific return tax needs a proved billed-piece mapping; unsupported freight-return tax cannot be assigned to a goods receipt merely because it shares a PO. RFQ quote entry still uses its existing quote bases; combined invoice evidence is additive.

Final-head hosted checks and review readiness must be verified on the published SHA. Deployment of #2000 and D2 actual-record posting acceptance remain open. Production had zero receipt assignments / supplier-credit documents at the dated #1993 readback. B1 external accounting recognition / complete inheritance acceptance and C1 the complete monetary-consumer matrix remain separate tracked gates; local order-cost updates are not proof of externally recognized COGS.
