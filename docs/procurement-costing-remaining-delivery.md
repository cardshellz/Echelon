# Remaining purchasing-costing delivery gates

Snapshot: verified deployed main `209f40c11c669289be0e0cbc8bc8e2157da28cf9` (#1991), v3454, plus the [billed-line adjustment / receipt-credit candidate](procurement-costing-stage-2-receipt-credits.md). This is the bounded delivery list for the existing [plan](procurement-costing-cleanup-plan.md), not another costing subsystem. Checkboxes in older stage notes are historical evidence and do not prove these exit gates.

## Financial sources and commands — finish S2

| Gate | Current evidence and owner | Required closure |
| --- | --- | --- |
| A1. Standalone supplier-cost approval | Deployed #1987 / v3453: `createInvoiceCostReviewCommands.review` binds a mandatory real impact preview/current Administrator and retains linked approval. Tax/origin nesting keeps its own approval | Candidate SQL/connected/types/build and final CI passed; release readback verified. Actual production approval acceptance stays open under D2 (zero approvals) |
| A2. Ordinary AP approve/dispute/void | #1991 deployed. Existing AP/cost owners now share the real preview, persisted action authority, source withdrawal, original approval preservation and immutable retained review | 63/63 final-head checks passed; v3454 slug/process/migration readback and a real live rollback-only preview verified. Actual production approval acceptance remains D2: zero retained transition reviews |
| A3. Known supplier totals and adjustments | Candidate: classified signed adjustments already included on an invoice line select net goods through the existing review/source owner, with inventory or excluded disposition and exact unchanged bill conservation. Tax/correction forms retain that evidence | Finish candidate acceptance. Then store/select combined goods without an invented split and implement explicit PO/invoice header allocation. Only covered receipt costs become actual; provisional remainders stay visible |
| A4. Credits/returns across receipt coverage | Candidate: a price credit freezes its exact saved invoice-to-receipt interval, enforces invoice and receipt caps, and uses existing supplier/application owners. Admin preview/approval/reversal retain exact values and original history. Accepted returns retain their separate outgoing-value owner | Finish candidate acceptance; extend explicit tax-credit and remaining quarantine/receipt attribution. Unsupported attribution stays an owning review; no invoice-wide averaging or invented receipt destination |

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
