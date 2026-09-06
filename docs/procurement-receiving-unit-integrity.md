# Procurement receiving unit and source integrity (W02a)

Baseline: `bb21c9647647682756e5663a022f40bb4a8afe77`, the merge of shipment-line controls PR #1383. This change follows that deployed slice. Verification uses code, fictional browser responses and an explicitly disposable PostgreSQL database. No production business records or settings were read or changed.

## Summary of changes

Receipt creation now preserves exact pieces and records the selected receive unit. A shipment with 501 pieces and 11 cartons remains 501 pieces; the carton count is packing information. A preferred 50-piece variant cannot represent that total, so creation uses an active one-piece variant for the entire line. Without that real variant, preflight reports the required catalog correction. It never rounds to 550 or invents a pack size from pieces divided by cartons.

Each resolved new receiving line stores `unitsPerVariantSnapshot`; shipment-derived lines also store their exact `inboundShipmentLineId`. Unit changes preserve expected, received and damaged base-piece totals exactly. Unknown legacy units require an explicit confirmation before conversion or posting. Count editing saves the entered value, including a short count or zero, instead of substituting expected quantity.

Existing receipt navigation remains available even when older coverage needs review. Ambiguous history blocks a new quantity proposal for the affected purchase without hiding the other purchases in the shipment.

## What the code definitely does

| Owner and function | Evidence and resulting behavior |
| --- | --- |
| `server/modules/procurement/receiving-unit-contract.ts`: `planReceiptUnits` | Validates integer piece quantities and product/variant ownership; uses the preferred active variant only when the quantity divides exactly, otherwise an actual active one-piece variant. A changed recorded preferred factor requires review. |
| `purchasing.service.ts`: `getShipmentReceiptPackResolution`, `createReceiptFromPO`, `createReceiptFromShipment` | Preflight and creation use the same unit planner. Shipment creation locks its shipment, relevant receipt headers, PO sources and catalog rows, then rechecks source and remaining coverage before inserting the header and lines together. |
| `receiving-unit-contract.ts`: `convertReceiptCounts`, `receivingUnitVersion` | Computes conversion with integer arithmetic and a version derived from receipt identity, source, unit snapshot, counts and timestamp. All three counts must convert exactly within the supported PostgreSQL quantity range. |
| `receiving.service.ts`: `addLine`, `updateLine` | Manual selected-variant creation and legacy confirmation compare the operator-reviewed pack size with the locked catalog row. Unit/count edits also require the reviewed line version and authenticated actor. `updateLine` before/after evidence is inserted into `audit_events` in the same transaction. |
| `receiving.service.ts`: `bulkImportLines` | Rejects fractional, malformed, negative and out-of-range counts rather than truncating them. Rechecks the entire header and sorted line set before writing, retains source product identity, and prevents imports from rewriting exact shipment expectations or a confirmed unit. Unresolved rows retain a null unit snapshot. |
| `receiving.service.ts`: `completeAllLines` | Requires the exact current set of line versions. Preserves positive counts already entered; fills zero counts from expected quantity only when the operator explicitly invokes the bulk acceptance action. Checks units and writes line/header changes plus audit together. |
| `receiving.service.ts`: `close` | Compares complete prepared header/line snapshots under the receiving lock, including changes made within an identical timestamp. Requires recorded units matching current catalog configuration before posting and validates linked product/shipment identities. The existing inventory transaction remains the posting owner. |
| `receiving-unit-snapshot.ts`: `resolveReceivingUnitSnapshot` | Uses a frozen receipt factor, or an exact original PO posting for a closed legacy receipt. Conflicting, absent or ambiguous historical evidence produces a structured review-required error. There is no live-catalog fallback for historical quantities. |
| `purchase-order-receipt-reconciliation.service.ts`: `reconcilePurchaseOrderReceipt` | Converts PO receipt quantities using frozen/original evidence and rejects received or damaged payload counts that differ from the recorded receiving line. |
| `receipt-reversal.service.ts`: `reverseReceivingLine` | Resolves original receive units before compensation, keeps lot-unit cost precision and writes exact base units reversed. A later catalog change cannot replace the original receipt factor. |
| `receiving-shipment-coverage.ts`: `computeClosedShipmentReceivedBaseQtyByLine` | Maps coverage to the exact shipment line and nets explicit reversals. A new frozen closed receipt counts while PO reconciliation retries. Legacy receipts need an exact original posting and a uniquely provable shipment-line relationship; coverage is never distributed across repeated PO lines by guesswork. |

The receiving header lock serializes the changed receiving mutation paths. PO/catalog locks and exact source comparisons protect this slice's posting and creation inputs. This does not establish global serializability across every inventory, catalog, AP and shipment writer.

## Operator workflow

1. Open receiving from the purchase or shipment context. Existing active receipts remain directly accessible.
2. For a new shipment receipt, review remaining pieces and the planned receive unit. Cartons remain a reference. A missing piece variant links to the source product for a deliberate catalog correction.
3. On each receiving line, see the recorded unit and its piece totals. Select another unit only when all existing quantities convert exactly. Unconfirmed historical counts display their uncertainty and require explicit confirmation of their existing meaning.
4. Enter actual counts and save. Pending edits and unresolved outcomes block bulk acceptance/finalization until refreshed and reviewed. A failed or uncertain response does not cause a silent retry with changed quantities.
5. Finalize through the existing inventory owner. Close rejects stale or conflicting units before inventory writes. A previously closed receipt reuses its existing posting and retries outstanding PO reconciliation through the existing orchestration.

`client/src/lib/receiving-units.ts`, `client/src/components/purchasing/ReceivingUnitControl.tsx`, `client/src/pages/Receiving.tsx` and `ShipmentReceiptPackResolutionDialog.tsx` implement these controls. Creating a variant from an unresolved receiving SKU now creates catalog data only; linking it to existing counts is a separate explicit unit confirmation.

## Migration and compatibility

`migrations/221_receiving_unit_snapshots.sql` adds two nullable columns, a positive-factor check, a restrictive shipment-line foreign key and a partial index. It is additive and replayable. It performs no historical quantity or factor backfill. Deploy the migration before the application version using the new columns.

Existing closed records remain unchanged. Pending legacy records may require operator confirmation; old standalone receipts without frozen units or original PO evidence cannot be automatically reversed through this resolver. There is no trustworthy factor to infer for those records.

The HTTP contracts intentionally require `expectedUnitVersion` for count/unit edits, every current line version for bulk acceptance, and `expectedUnitsPerVariant` for selected-variant manual creation or explicit legacy confirmation. Existing internal/UI callers are updated. External callers of those mutation endpoints must adopt these review fields; an old client receives an actionable rejection instead of implicitly reinterpreting counts.

## Assumptions and unknowns

- No production prevalence or affected monetary total is asserted. Compatibility with the actual population of historical legacy receipts still needs a separate read-only data inspection.
- The one-piece fallback is permitted only when that active catalog variant exists. No unobserved full/loose carton distribution is inferred.
- Per-piece cost fields retain their existing contract during unit conversion. This work does not approve or repair historical economics.
- Browser fixtures establish the client behavior under controlled responses, not carrier, ERP, production data or live authentication behavior.

## Risks and remaining failure modes

- Ambiguous historical coverage or inconsistent source ownership blocks new/remainder receiving and needs evidence review. It does not justify a historical data rewrite.
- A catalog pack changed after receipt posting can still affect live inventory/ATP interpretation and later cost writers. A global policy for mutable pack definitions remains necessary.
- Direct-PO receiving can still be initiated after shipment allocation. Its capacity policy across direct receipts and shipment commitments is a separate follow-up; this slice makes no promise that those competing workflows cannot overcommit a PO.
- Physical receiving commits before PO receipt reconciliation. Existing recovery reports reconciliation failure and retries it on a closed receipt; it is not one transaction across both phases.
- Receiving's existing generic idempotency middleware and CSV update-or-insert workflow are not replaced with the durable operation-scoped command ledger used by newer shipment controls. Count versions prevent stale reinterpretation; they are not a claim of full command replay across all receiving endpoints.
- Product/AP, packaging and landed-cost component ownership still have the defects traced in [the receiving cost follow-up](procurement-receiving-cost-followup.md). Exact quantity/source identity is the prerequisite delivered here. Correct historical COGS, final freight application and Archon export completeness are not proven.

## Verification

Focused unit and HTTP coverage includes partial packs, product/source mismatch, integer bounds, exact/inexact conversion, legacy confirmation, stale counts, same-timestamp imports, reviewed catalog-factor drift, complete-all versions, immutable shipment expectations, recovery navigation and structured failures.

The PostgreSQL suite in `server/modules/procurement/__tests__/integration/receiving-unit-integrity.integration.test.ts` executes the production receiving service, procurement storage, inventory use cases, inventory repository and lot service. It checks migration replay/no backfill, constraints, concurrent edits, same-timestamp close conflicts, audit and inventory-ledger rollback, exactly 501-piece posting, duplicate close, frozen/legacy reversal evidence and rollback, and exact coverage SQL. The fixture does not wire the AP reconciler or purchasing close callback; it does not prove the combined financial propagation paths documented separately. Dedicated CI execution is added after the shipment-line PostgreSQL suite so the fixtures do not race.

Validation on 2026-09-06:

- `node node_modules/typescript/bin/tsc --noEmit --pretty false`: passed.
- `node node_modules/vitest/vitest.mjs run unit --maxWorkers=3`: 869 files passed, 8,408 tests passed, 37 tests skipped. The skipped set includes this receiving PostgreSQL suite, executed separately below. The writer-ratchet is included in the successful full unit run.
- `receiving-unit-integrity.integration.test.ts` with both `ECHELON_TEST_DATABASE_URL` and `ECHELON_TEST_DATABASE_DISPOSABLE=true`: 23/23 passed on disposable PostgreSQL 17. The 501-piece test explicitly proves that physical posting occurs once while a deliberately absent post-commit PO owner returns a retryable reconciliation error; it does not substitute a fake successful financial result.
- Full procurement browser suite: 90/90 passed, split equally between desktop and mobile. After the final refresh-isolation fix, 10/10 focused desktop/mobile recovery checks passed, including a new gated regression for overlapping receipt reloads and same-receipt purchase-context changes. Typecheck passed again after those final client changes.
- Staged whitespace/diff validation: passed. Desktop receipt and mobile preflight screenshots were visually inspected after interaction and with settled animations.

The first final unit attempt exposed an outdated shipment-source fixture and a transient `fetch: bad port` failure in an unchanged shipping HTTP test. The fixture was corrected, the HTTP suite passed separately, and the complete suite then passed as reported above. Two existing source-text tests need LF line endings; their untouched production inputs were temporarily normalized for the run and their original bytes restored afterward.

Tests and screenshots use fictional records. No deployed behavior or production migration application is implied by local success. Hosted CI has not run for this unpublished branch.

## Next checks

Implement the linked financial repair using explicit product, packaging and landed cost components, exact shipment-line attribution through receiving to lots, immutable conversion evidence for later revaluation, and durable cost-application status/retries. Prove the complete receiving -> AP -> freight -> lot/COGS sequence in PostgreSQL before claiming landed-cost completeness. Preserve historical detail and produce a separate preview before any proposed correction of existing financial records.
