# Remaining purchasing-costing delivery gates

Snapshot: main `56c547ae5f8e0ff60e7d0570999a58f3b973ef92` (#1983), plus this supplier-approval candidate. This is the bounded delivery list for the existing [plan](procurement-costing-cleanup-plan.md), not another costing subsystem. Checkboxes in older stage notes are historical evidence and do not prove these exit gates.

## Financial sources and commands — finish S2

| Gate | Current evidence and owner | Required closure |
| --- | --- | --- |
| A1. Standalone supplier-cost approval | This candidate: `createInvoiceCostReviewCommands.review` binds a mandatory real impact preview/current Administrator and retains linked approval. Tax/origin nesting keeps its own approval | Exact candidate SQL, connected desktop/mobile, types/build and hosted CI; then deployment readback |
| A2. Ordinary AP approve/dispute/void | `executeApInvoiceCommandInTransaction` -> `reconcileApprovedInvoiceVariance` -> `reconcilePurchaseCostEvidence`. The separate correction/freight commands have measured approval; ordinary AP transitions do not yet share that complete reviewed-impact contract | Review the actual source-authority change and downstream effects once; preserve original AP approval and settlement. Cover draft/approved/paid/disputed/void transitions and source withdrawal without new posting owners |
| A3. Known supplier totals and adjustments | `resolvePurchaseCostSource` still requires explicit component evidence in its stored adapter; S1's `projectPurchaseCostAuthority` supports a known combined amount. Receipt-specific source and tax adapters exist; other header amounts/discounts, supplier freight and tax-credit attribution are not globally accepted | Store/select the known billed amount once without inventing a product/packaging split; explicit inclusion/allocation for each adjustment; propagate only covered receipt costs, retaining provisional remainders |
| A4. Credits/returns across receipt coverage | `approveSupplierCreditSources` / `voidSupplierCreditSources` -> `reconcileCreditSources` delegate to supplier and shipment application owners. Source-backed credit/physical-return tests exist; that is not proof of every receipt-specific/header/tax credit combination | Trace credit authority/coverage through the receipt-specific adapter and prove exact net costs, over-credit rejection, original history and safe reversal/retry. Unsupported attribution stays an owning review |

The command inventory is maintained in [the invoice correction trace](procurement-costing-stage-2-invoice-corrections.md#command-owner-inventory-and-remaining-work). Relevant callers were re-enumerated with `rg` under `server/modules/procurement`, excluding tests: invoice corrections, standalone supplier review, AP transitions, PO amendments, tax changes, receipt assignments/corrections, receipt recovery, supplier credits and shipment finalization all reach the existing supplier or shipment cost owners. Caller discovery is **not** full mutation-scope acceptance; each gate above needs its own executable trace and failure tests.

## Downstream integrity — S3

| Gate | Existing owners | Required closure |
| --- | --- | --- |
| B1. Inheritance, missing links and verified-sale recognition | Inventory `applyCostRevision`, cost-quantity/origin graph, transfer/repacking owners, `COGSService`, receipt cost queue and historical approvals | Prove exact inheritance after transfer/repack, event-order independence, real missing-link resolution, unchanged-money completion and retry safety. Local order cost basis is not proof of external recognized COGS; trace the actual accounting recipient before changing recognition behavior. No inferred sales or expenses |

## Shared experience — S4

| Gate | Confirmed shared readers | Required closure |
| --- | --- | --- |
| C1. One selected monetary result and actionable status everywhere | `readPurchaseCostStatus` feeds batch/snapshot, PO shipment summary, trace, cost history, shipment review and supplier-credit readers. `resolveCostPostingStatus` is reused by supplier/shipment projections; `projectPoLineLandedCosts` exists | Inventory every remaining monetary display/action by actual caller, then route invoice-selected/receipt-scoped values through the shared projection. PO agreement, invoice liability and payment settlement keep distinct labels. Verify PO/shipments/receipts/dashboard/lifecycle/history agree on their exact scope and return navigation. Do not hide real unresolved amounts |

The reader calls listed above are confirmed from current source imports/call sites. Complete screen-by-screen financial equivalence and all remaining consumers are **not proven** by that enumeration; closing C1 requires the concrete consumer matrix and connected assertions.

## Whole-flow acceptance and rollout — S5/S6

| Gate | Required closure |
| --- | --- |
| D1. Final candidate acceptance | Run AT-01 through AT-14 from the main plan on the composed candidate: real SQL/HTTP owners, connected desktop/mobile, exact totals/coverage, permissions, concurrency, rollback, retries, physical invariants, immutable approvals, migrations and unsupported cases. Record exact head and hosted results; overlapping suite totals are not added together |
| D2. Deployment and actual-record readback | Pin the release/commit/process/migration manifest, compare representative documents read-only, and verify original approvals and settled amounts. Only perform evidence-backed historical changes through the owning approved flow. #1983 is deployed, but production has zero receipt assignments and zero freight approvals as of its dated readback; tests cannot substitute for live posting acceptance |

Order: close A1 acceptance, then A2/A3/A4; prove B1 alongside those adapters; close C1 against the selected result; finish D1/D2. These are completion gates, not an estimate of PR count or elapsed time. FX conversion policy and broad money-storage migration remain outside this cleanup; existing explicit review boundaries must remain intact.
