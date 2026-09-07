# Package-close contract checkpoint

Later continuation: [connected assembly package evidence](WMS-ASSEMBLY-PACKAGE-REVIEW-2026-09-06.md). The pure close contract below remains unwired; the later read-only endpoint/UI does not manufacture its missing authority fields or close packages.

## Status and scope

PR #1389 is verified merged at `03ea5b00983d1f59b181fa4d0c2b007832fd4a27`; the user reported deployment. This continuation is isolated on `codex/wms-assembly-package-close`, based on that commit. Unrelated catalog changes in the original checkout are untouched.

**Implemented here: a strict owner-evidence DTO, operator command DTO, and pure package-close validation policy with unit tests. Not implemented: a package-close endpoint, receipt writer, production authority adapter, or bench UI.** Do not publish this checkpoint as a usable packing-completion feature. Keep subsequent integration on this branch; no deployment is needed for the unwired contract.

There are no new database migrations, stock/reservation writes, channel effects, activation changes, or provider requests. The contract is not imported by a runtime consumer. A policy result is not a persisted close receipt, inventory posting, label purchase, or shipment.

## What current code definitely does

| Evidence | Conclusion | Remaining limit |
| --- | --- | --- |
| `server/modules/oms/shipstation.service.ts:4038`, `processShipNotify` | Hydrates label direction, persists observed labels, and optionally invokes commercial fulfillment processing. It does not call the carrier dispatch command here. | This does not mean label printing has no customer-visible effects: commercial channel commands are explicitly a separate possibility. Production configuration and live event timing were not inspected. |
| `server/modules/oms/shipstation.service.ts:4101`, `confirmDispatch`; tracking check and `processShipmentNotification` call around 4235-4270 | Carrier dispatch separately validates current provider tracking and outbound direction before physical shipment processing. | This continuation does not alter this path or assert that every legacy ingress is covered. |
| `server/modules/shipping-engine/application/packing.service.ts:341`, `confirmParcel` | Existing confirmation stores actual box/weight and timestamps, and can mark a cartonization plan packed. Reconfirmation overwrites its actuals. | It contains no exact current-label validation. A carton plan is not sufficient evidence for the new close command. |
| `server/modules/shipping/package-allocation-authority-resolution.service.ts:394`, `PackageAllocationAuthorityResolutionPreviewService` | Explicitly inert preview; no group creation, plan append, operator actions, or executable effects. Uses a repeatable-read, read-only transaction. | Do not change `shadow_only` into live authority in a WMS adapter or assume relationship discovery proves all packages. |
| `server/modules/shipping/package-allocation-ledger.repository.ts:183`, preview transaction interface; `:200`, ledger transaction interface; `:151`, outbox contract | Existing owner interfaces distinguish read preview from locked writes. Outbox execution remains disabled in this contract. | A new close service cannot obtain concurrency guarantees just by invoking the preview reader and later writing independently. |
| `shared/schema/fulfillment.schema.ts:370`, `shippingProviderLabels`; `:412`, `shippingProviderLabelLinks` | Provider label identity, tracking, status, and relationship records already exist. | The label row shown here has no explicit provider-account identity or integer label revision. The new DTO requires proven owner equivalents; none are fabricated by this checkpoint. |
| `shared/warehouse-package-close.ts:44`, `packageCloseEvidenceSchema`; `:72`, `packageCloseCommandSchema` | Owner facts and operator acknowledgment are different strict schemas. Client commands cannot inject actor, contents, picked totals, or authority mode. | Schema validation does not authenticate evidence; runtime construction must remain inside trusted owner reads. |
| `server/modules/wms/package-close-policy.ts:86`, `previewPackageClose`; `:96`, `evaluatePackageClose` | Pure, deterministic validation; checks exact identity, warehouse, source quantities, picks, current label, worker capability/assignment, and supplied version hash. | No database fence, receipt, external side effect, or runtime activation is implemented. |

## Example using the new contract

These are test fixtures, not live SKUs or inventory observations.

The owner says package 501 contains two P5 from source shipment item 101, order 70 / item 71, warehouse 1. That exact source has two authorized units and two picked units, with none closed in another package. The assigned assembler has packing capability at the same enabled bench. Label 601 is active, outbound, and belongs to the same provider account and package.

The worker verifies the displayed contents and scans/applies the existing label. A command containing the preview hash and exact label revision passes the policy. It still does not close anything until the future owner transaction records its receipt.

If four units were picked for source 101, package A already closed two, and package B contains the other two, B is eligible. If A already closed three, B rejects. These counts must come from source-specific owner evidence, not the full order-line picked total copied onto every source.

Only the contents of the selected authorized package are evaluated. Unrelated held items and another warehouse's package are not required. Any held/cancelled/nonphysical line actually included in this package blocks it. Ambiguous multiple source rows for one order line within the package reject until source-specific pick lineage is established; this is a documented limitation, not permission to reduce selling quantities or change ATP.

## Assumptions, hypotheses, and unknowns

- The DTO is a proposed published owner contract, not a mirror of an existing database table. `packageVersion`, account identity, label revision, exact package completeness, exclusively assigned picked-source quantity, and other-package close totals still require proven runtime producers.
- HYPOTHESIS: existing shipment-source identity and declared-package evidence can supply most package contents without another allocation ledger. The inspected preview service is insufficient proof of an executable write contract.
- Unknown: how the active shipment owner will fence all changes that can invalidate close (source quantities, cancellation, label void/reprint, carrier possession, and competing closes). A concrete per-writer lock matrix is required before creating the close writer.
- Unknown: live permissions/routes, label ingestion latency, provider account identity, label supersession completeness, and physical bench behavior. No production inspection was performed here.
- Exact replay after close belongs in an application receipt lookup with current authorization and actor/task/command hash checks. The pure policy deliberately rejects a fresh close against an already-closed package.

## Required next implementation, in this branch

1. **Published shipping/WMS owner read and fence.** Resolve the task to exact authorized package/source identities; prove account and label generation. Derive source-specific pick ownership and existing close balances through their owning modules. Missing or preview-only facts must fail visibly. Do not substitute a carton suggestion, order number, tracking alone, or raw order picked total.
2. **Concurrency contract before writes.** Inventory/claim and shipment source locks must serialize competing use of the same picked units across packages. Label mutation and carrier dispatch must fence against close using compatible ordering. Reuse existing owner transaction interfaces; do not hold warehouse task locks and then enter an inverse-order shipping transaction. This file intentionally does not assert an unproven final lock order.
3. **Append-only WMS close receipt.** Bind command ID and actor/task intent hash to package identity/version, exact source lines/quantities, current label/account/generation, physical acknowledgments, and injected time. Unique command and current-package-close constraints, rollback, exact retry, and before/after evidence are mandatory. No automatic stock, commercial fulfillment, carrier, or package-allocation outbox activation is part of receipt insertion.
4. **Same-bench UI.** After the existing assembly/output-pick/readiness steps, display authoritative package contents and current label in the selected job. Validate the scan and explicit contents/label acknowledgments, then show success only from the durable receipt. Keep the same employee and station. Preserve completed assembly when the label is absent, voided, delayed, or mismatched. Do not add a fake success button while the owner contract is unavailable.
5. **Close correction/relabel and dispatch integration.** A pre-close replacement label can supersede a void label; stale commands reject. Reopening an already-closed package needs its own audited owner transition, not editing the old receipt. Dispatch remains separately evidenced. Multi-package and multi-warehouse cases must use exact source ownership, not whole-order equality.

## Verification and failure modes

Focused tests exercise the new policy plus existing assembly packing readiness: 72 passed. Full unit regression after deterministic ordering hardening: **880 files passed, 1 skipped; 8,644 tests passed, 37 skipped**. Final `tsc --incremental false` and staged whitespace checks passed. No production build, database integration, or browser acceptance is claimed for this unwired checkpoint.

New cases cover unknown/shadow authority, incomplete/empty contents, cancelled/closed/carrier-held packages, held/digital/cancelled contents, warehouse mismatch, insufficient picked/authorized balances, duplicate sources, ambiguous order-line sources, missing/unknown/void/superseded/return labels, ambiguous labels, wrong provider/account/package, worker/role/station mismatch, stale hashes/revisions, wrong scans, maximum quantities and bigint IDs, input injection, deterministic ordering, and input immutability.

Malformed DTOs raise validation errors; valid-but-ineligible evidence returns explicit blocker codes. There is no fallback that labels an ineligible package packed or shipped. Database rollback/concurrency, provider integration, HTTP authorization, browser interaction, physical label application, and receipt replay are **not proven by these unit tests** and remain required once their runtime code exists.
