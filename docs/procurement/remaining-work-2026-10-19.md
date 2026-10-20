# Procurement remaining work after PR1855

Verified source baseline: `8bd0a464101233ec664131dcbf6e13b18f524ee5` (`origin/main`, PR1855 merged). The operator reports deployment. Merge evidence and that report do not establish an independent production readback.

## Current corrective batch

| Item | Confirmed source behavior at the baseline | Correction / acceptance requirement |
| --- | --- | --- |
| AP-A5: apply an existing supplier advance | `ap-ledger.service.ts::recordPaymentInTransaction` allows total cash above the initial invoice allocations. There was no command to allocate the remainder later; `ap_payment_allocations_pay_inv_idx` prevented an additional row for the same payment/invoice. | Append applications to the existing cash record under graph/payment/invoice locks. Recheck current authority, version, remaining funds and invoice evidence. Preserve original rows and auditable exact-once command results. |
| AP-A7: payment calendar date | `ap-ledger.routes.ts` converted the form date with `new Date`; payment screens formatted the timestamp in the browser timezone. An October 1 UTC midnight value displays September 30 in New York. | Explicit validated calendar date across request, storage, reads and all payment screens. Preserve legacy timestamps without inventing their intended calendar date. |
| Quarantine retry identity | The baseline `receiving-quarantine-client.ts` stored receipt-scoped attempts without actor identity and treated authorization failures as definitive. Unknown-goods intake has no source-line version; old durable keys were scoped to actors. | Keep the original request through auth/read/storage failures. Bind command/key/operator/resource and verify result content. Prevent a second operator from reusing an unknown-intake key to create a second observation; protect legacy keys. |

This batch is implemented and locally validated. Its runbook records the final evidence separately. Draft PR1857 publishes this batch, with unchanged SQL allocated under its generated identity. Hosted CI, deployment and production acceptance remain separate; this ledger does not claim they have occurred.

## Remaining implementation identified at the baseline

1. **Supplier credits and physical-return financial disposition (AP-A6).** The `SIGNED_LANDED_CREDIT_REVIEW` branch in `shipment-cost-application.service.ts` retains signed freight credit evidence but cannot complete cost posting. `docs/RECEIVING-QUARANTINE-WORKFLOW.md` explicitly says physical return does not establish a supplier credit, refund, writeoff or settlement. A credit requires an explicit document, owner, approval/application/reversal and inventory/COGS disposition. No negative cash payment or inferred historical credit is a substitute. Exact policy boundaries and existing accounting integrations still need an end-to-end trace before this batch is designed.
2. **RFQ recovery and work-list reachability.** `RfqWorkflowPanel.tsx` retains command intents in component memory. `financial-command.ts` treats an unauthorized response as definitive, allowing a new key after a previously ambiguous request; reload also loses identity. Version guards are present, so duplicate PO creation is not claimed. `ProcurementRfqs.tsx` and `purchasing-rfq.service.ts::listRequestForQuotes` expose only the newest 25 records without page/search/status controls. `rfq-workflow.routes.ts` requires `inventory:view` for reads while purchasing workspace access uses `purchasing:view`; the embedded RFQ panel can fail for purchasing-only operators. Finish persistent verified recovery, bounded discoverable lists and coherent read access, with database and desktop/mobile regression coverage.

## Supplier-credit corrective follow-up

The supplier-credit batch is based on tested PR1857 head `00e18a2a07d4745adc131ed920be8af7a50e4791`. The operator reports PR1857 deployed; GitHub still reported it open when refreshed during this work. See `supplier-credits-and-returns.md` for the complete trace, implementation boundaries and validation evidence.

The batch adds a supplier credit document, explicit approval/application/reversal/void/replacement, separate cash and credit settlement, exact inventory/COGS reductions and linkage to immutable quarantine return evidence. Local validation passed; the supplier-credit runbook records the distinct cases, reviewed failure modes and remaining boundaries. This is not a production acceptance claim.

After this batch, the remaining implementation work is **accepted-stock supplier return ownership, canonical completion for exact full quarantine returns with zero inventory quantity, and unresolved return-value differences**, followed by **RFQ recovery and work-list reachability**. Historical signed-charge conversion/repair requires separate evidence and an explicit reviewed payload. Supplier cash refunds and GL posting are not implicitly supplied by this credit owner.

## Acceptance after the corrective batches

- Combined RFQ -> PO -> multi-PO shipment -> conversion/import -> partial receiving/quarantine -> inventory/COGS -> invoice -> payment/credit -> reversal/recovery acceptance, including unhappy paths and concurrent commands. Existing focused suites prove their tested paths, not complete lifecycle acceptance.
- Independent deployed readback of migration state, permissions, saved records and cross-screen status agreement. No production mutation or historical repair is implied by this plan. Any discovered repair must have its own concrete evidence and reviewed payload.

This replaces the narrower remaining-work statement in `invoice-ownership-po-authority.md`: that document identified AP-A5/A6/AP-A7 but did not include the quarantine and RFQ gaps confirmed in this pass. No reliable calendar completion estimate follows from test counts; report remaining batches and actual validation state instead.
