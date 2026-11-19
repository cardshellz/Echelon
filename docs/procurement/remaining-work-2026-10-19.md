# Procurement corrective work and remaining acceptance

## Current state verified October 21, 2026

PR1883 is now merged and its exact merge has a successful deployment record. Independent readback confirms sampled receipt/PO/shipment quantity agreement, posted shipment-cost agreement, and AP totals. Final verification also identified a concrete receiving CSV retry obstruction in the failed hosted browser shard. The bounded correction, release evidence and remaining acceptance limits are tracked in [final verification](final-verification-2026-10-21.md). No further major corrective feature batch is listed; this follow-up and its release verification remain open. Historical cost exceptions and unavailable production scenarios are stated explicitly rather than certified by the deployment.

### Pre-deployment acceptance checkpoint

This acceptance pass started from fetched main `b0edad6447da59f4aa1a8f4b2147c4fa48f874df` and incorporated `1b7910d9223c7253a44f252be726d60b93ae7b42` before final local validation. RFQ PR1875 merged as `e5c5a7071da92ea4212d045775319ac4ccc0fe4e`; all 59 PR checks and post-merge Core CI `39652973253` passed. The merge is an ancestor of the pinned main. GitHub deployment status records confirm successful Heroku deployment of that merge and its later replacement by `b0edad644`. Deployment metadata does not establish correctness of every saved business record.

Combined acceptance reproduced a new custody bypass: an ordinary second receipt could post held goods while the original quarantine observation still retained them. The correction and connected acceptance evidence are recorded in [lifecycle acceptance](lifecycle-acceptance-2026-10-21.md). This finding prevents marking the entire effort complete merely because the earlier batches deployed.

The correction and bounded combined acceptance now pass local validation: 4,920 unit/guard cases, 331 PostgreSQL cases, 186 browser cases, four typechecks and the build. Read-only deployed sampling confirmed saved shipment/PO cost agreement; the RFQ list contained no saved RFQs, so its real quote/conversion recovery could not be verified. The remaining release work is hosted CI, deployment of this custody correction and independent readback of that deployed version within available saved-record and permission evidence. Historical data repair, new supplier communication, cash transfers and production test transactions are not implied.

## Previous corrective checkpoint

This continuation began on fetched main `93be8ccd76f5246369284748f0bd2887b11455a9` and incorporated `bf1507790dc0acb79af19ca4f645f37b1ba74038` before final validation. PR1868 was merged into PR1857, then PR1857 was reconciled with main and merged as `4d137ca98018c76228b6d174ba0b78dd7eb5217d`. All 59 PR checks passed. Post-merge Core CI run `39490362528` and Returns portal admin preview run `39490362883` passed. These are repository and CI facts; no independent production readback is established here.

The AP advance/calendar-date/quarantine recovery work, supplier credits, full-quarantine zero-effect completion, accepted-stock returns and credit-difference review are now incorporated in main. Their supported accounting and provenance boundaries remain in `supplier-credits-and-returns.md`; unsupported writeoffs, cash refunds, claims, GL posting or mixed stock provenance are not inferred as completed.

The **RFQ recovery and work-list reachability** batch was implemented and locally validated at this checkpoint. The trace confirmed the in-memory request identity, lack of actor-bound success/rejection receipts, latest-25 list, and read-permission mismatch described below. Existing version/link safeguards remain enforced; duplicate purchase creation is not a demonstrated defect. See `../procurement-rfq-workflow.md` for the implemented contract and validation record. Its later merge and deployment evidence are recorded above.

After this batch, the remaining planned work is **combined lifecycle acceptance**, followed by **independent deployed readback**. Failures found in those exercises become concrete follow-up defects; they must not be hidden by calling focused suite results full-system acceptance.

## Historical baseline and completed corrective batches

Verified source baseline: `8bd0a464101233ec664131dcbf6e13b18f524ee5` (`origin/main`, PR1855 merged). The operator reports deployment. Merge evidence and that report do not establish an independent production readback.

### PR1857 baseline findings

| Item | Confirmed source behavior at the baseline | Correction / acceptance requirement |
| --- | --- | --- |
| AP-A5: apply an existing supplier advance | `ap-ledger.service.ts::recordPaymentInTransaction` allows total cash above the initial invoice allocations. There was no command to allocate the remainder later; `ap_payment_allocations_pay_inv_idx` prevented an additional row for the same payment/invoice. | Append applications to the existing cash record under graph/payment/invoice locks. Recheck current authority, version, remaining funds and invoice evidence. Preserve original rows and auditable exact-once command results. |
| AP-A7: payment calendar date | `ap-ledger.routes.ts` converted the form date with `new Date`; payment screens formatted the timestamp in the browser timezone. An October 1 UTC midnight value displays September 30 in New York. | Explicit validated calendar date across request, storage, reads and all payment screens. Preserve legacy timestamps without inventing their intended calendar date. |
| Quarantine retry identity | The baseline `receiving-quarantine-client.ts` stored receipt-scoped attempts without actor identity and treated authorization failures as definitive. Unknown-goods intake has no source-line version; old durable keys were scoped to actors. | Keep the original request through auth/read/storage failures. Bind command/key/operator/resource and verify result content. Prevent a second operator from reusing an unknown-intake key to create a second observation; protect legacy keys. |

The table records the original PR1857 findings. That batch is now merged, with local and hosted evidence recorded separately. Production acceptance remains unverified.

### Implementation identified at the original baseline

1. **Supplier credits and physical-return financial disposition (AP-A6).** The `SIGNED_LANDED_CREDIT_REVIEW` branch in `shipment-cost-application.service.ts` retains signed freight credit evidence but cannot complete cost posting. `docs/RECEIVING-QUARANTINE-WORKFLOW.md` explicitly says physical return does not establish a supplier credit, refund, writeoff or settlement. A credit requires an explicit document, owner, approval/application/reversal and inventory/COGS disposition. No negative cash payment or inferred historical credit is a substitute. Exact policy boundaries and existing accounting integrations still need an end-to-end trace before this batch is designed.
2. **RFQ recovery and work-list reachability.** `RfqWorkflowPanel.tsx` retains command intents in component memory. `financial-command.ts` treats an unauthorized response as definitive, allowing a new key after a previously ambiguous request; reload also loses identity. Version guards are present, so duplicate PO creation is not claimed. `ProcurementRfqs.tsx` and `purchasing-rfq.service.ts::listRequestForQuotes` expose only the newest 25 records without page/search/status controls. `rfq-workflow.routes.ts` requires `inventory:view` for reads while purchasing workspace access uses `purchasing:view`; the embedded RFQ panel can fail for purchasing-only operators. Finish persistent verified recovery, bounded discoverable lists and coherent read access, with database and desktop/mobile regression coverage.

### Supplier-credit corrective follow-up history

The supplier-credit batch was based on tested PR1857 head `00e18a2a07d4745adc131ed920be8af7a50e4791`. PR1857 was still open at that historical checkpoint; the current merge state is recorded above. See `supplier-credits-and-returns.md` for the complete trace, implementation boundaries and validation evidence.

The batch adds a supplier credit document, explicit approval/application/reversal/void/replacement, separate cash and credit settlement, exact inventory/COGS reductions and linkage to immutable quarantine return evidence. Local validation passed; the supplier-credit runbook records the distinct cases, reviewed failure modes and remaining boundaries. This is not a production acceptance claim.

The subsequent PR1868 return batch completed accepted-stock supplier return ownership, canonical completion for exact full quarantine returns with zero inventory quantity, and explicit unresolved return-value differences. RFQ recovery and work-list reachability are the next correction. Historical signed-charge conversion/repair requires separate evidence and an explicit reviewed payload. Supplier cash refunds and GL posting are not implicitly supplied by this credit owner.

## Acceptance after the corrective batches

- Combined RFQ -> PO -> multi-PO shipment -> conversion/import -> partial receiving/quarantine -> inventory/COGS -> invoice -> payment/credit -> reversal/recovery acceptance, including unhappy paths and concurrent commands. Existing focused suites prove their tested paths, not complete lifecycle acceptance.
- Independent deployed readback of migration state, permissions, saved records and cross-screen status agreement. No production mutation or historical repair is implied by this plan. Any discovered repair must have its own concrete evidence and reviewed payload.

This replaces the narrower remaining-work statement in `invoice-ownership-po-authority.md`: that document identified AP-A5/A6/AP-A7 but did not include the quarantine and RFQ gaps confirmed in this pass. No reliable calendar completion estimate follows from test counts; report remaining batches and actual validation state instead.
