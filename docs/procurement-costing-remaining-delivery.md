# Remaining purchasing-costing delivery gates

Snapshot: #1993 verified deployed in v3461 at `9cf76be54f121ecb611e3adf8c3f4856e09f08dd` (#1998). [Release and live readback](procurement-costing-deployment-1993.md). The active continuation is [#2000 combined/header/tax/return costing](procurement-costing-stage-2-combined-header-credits.md), not yet deployed. These are bounded gates for the existing [plan](procurement-costing-cleanup-plan.md). Local tests, hosted CI, deployment and actual live posting are separate evidence.

## Financial sources and commands — finish S2

| Gate | Current evidence and owner | Required closure |
| --- | --- | --- |
| A1. Standalone supplier-cost approval | Deployed #1987 / v3453: `createInvoiceCostReviewCommands.review` binds a mandatory real impact preview/current Administrator and retains linked approval. Tax/origin nesting keeps its own approval | Candidate SQL/connected/types/build and final CI passed; release readback verified. Actual production approval acceptance stays open under D2 (zero approvals) |
| A2. Ordinary AP approve/dispute/void | #1991 deployed. Existing AP/cost owners now share the real preview, persisted action authority, source withdrawal, original approval preservation and immutable retained review | 63/63 final-head checks passed; v3454 slug/process/migration readback and a real live rollback-only preview verified. Actual production approval acceptance remains D2: zero retained transition reviews |
| A3. Known supplier totals and adjustments | #1993 deployed. #2000 adds explicit combined goods and signed PO/invoice header allocations, reviewed exact shares, immutable approval and existing inventory/order-cost application | Finish composed candidate/hosted acceptance and deployment readback. Separate packaging amounts are not inferred from a combined bill; missing header evidence has its own review action |
| A4. Credits/returns across receipt coverage | #1993 deployed receipt-specific price credits. #2000 adds named original-tax refunds, exact quarantine billed intervals and accepted-return invoice attribution through original receipt and transfer proof; existing outgoing return valuation remains authoritative | Finish composed candidate and live acceptance. Missing original invoice-to-return proof remains a source review. Freight returns without a proven billed-piece mapping are not automatically assigned a goods receipt |

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
| D2. Deployment and actual-record readback | Pin the release/commit/process/migration manifest, compare representative documents read-only, and verify original approvals and settled amounts. Only perform evidence-backed historical changes through the owning approved flow. #1987 is verified in v3453, but production has zero receipt assignments, freight approvals and standalone supplier approvals as of its dated readback; tests cannot substitute for live posting acceptance |

Order: A1/A2 deployed; finish A3/A4; prove B1 alongside those adapters; close C1 against the selected result; finish D1/D2. These are completion gates, not an estimate of PR count or elapsed time. FX conversion policy and broad money-storage migration remain outside this cleanup; existing explicit review boundaries must remain intact.
