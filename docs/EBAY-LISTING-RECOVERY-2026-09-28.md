# Existing eBay listing recovery — September 28, 2026

## Scope and production boundary

Fix the stale direct-eBay replacement recovery. Do not recreate existing listings, change prices or quantities, resurrect retired C700, or activate ATP. No production writes were performed while developing this patch. The separate Dropship missing-offer correction belongs to PR #1592, not this branch.

## Confirmed read-only observations

Production database readback at 2026-09-28 23:43 UTC:

- `marketplace.listing_replacement_operations.id=5`: channel 67, product 33, scope 1; `manual_recovery_required`, phase `compensate`, source publication 1, target publication 6. The last recorded error was the generic `MARKETPLACE_LISTING_REPLACEMENT_DATABASE_ERROR`.
- Publication 1 is historical active provenance for P50/C700. Publication 6 remains planned for P50/C750. The failed source-recovery step must not replay that obsolete C700 membership.
- `marketplace.listing_verification_snapshots.id=1` already records the August 8 correction: listing `298569307307`, source group `ARM-ENV-SGL`, included variants 66/P50 and 438/C750; variant 67/C700 excluded.

Fresh eBay GETs against the registered channel account confirmed:

| Read | Observed result |
| --- | --- |
| Group `ARM-ENV-SGL` | Present; contains P50, C700 and C750 inventory items |
| Group `ARM-ENV-SGL-R6` | 404 / group not found |
| P50 offer `136412213011` | Published on listing `298569307307` |
| C700 offer `136412217011` | Unpublished, no listing ID |
| C750 offer `136412210011` | Published on listing `298569307307` |

Group membership is not the same as a published offer: retaining the unpublished C700 inventory item does not justify republishing it.

Dropship listing 1 separately failed on GET offers with eBay 404/error 25713, “This Offer is not available.” PR #1592 was open when checked; its deployment and successful retry were not proven here.

## What the code does and what changes

1. **Fix forbidden history writes.** Before this patch, `updateRestoredSourcePublication` at base commit `6160b498b` tried to update the active publication's identity/verification time and its members. Migration `0607_marketplace_listing_replacement_foundation.sql`, functions `guard_listing_publication` and `guard_listing_publication_member`, prohibit these changes. The PostgreSQL regression reproduces that rejection. Recovery now uses `appendRecoveredSourceVerification` and the same `appendListingVerification` writer as normal listing verification; history stays immutable.
2. **Honor the already-verified correction.** `withVerifiedRecoverySource` in `server/modules/marketplace-listings/infrastructure/pg-listing-recovery-verification.ts` loads the latest verification only for compensation. If it is newer than the failed operation, `EbayMarketplaceListingReplacementProvider.ensureSourceLive` uses `verifyCorrectedSource`: GETs only. It checks current source offer identities, excludes C700, rechecks target-group absence and checks that target offers are not live outside the verified source. A changed group identity is rejected rather than guessed.
3. **Close the old operation atomically.** `PgMarketplaceListingReplacementExecutionRepository.completeCompensationAndFailOperation` appends fresh verification, succeeds the compensation step, marks the abandoned target failed and the old replacement failed/compensated, and records audit events in one transaction. “Failed” describes the abandoned replacement, not a failed recovery. The active source remains active. A terminal retry does not repeat provider work or append another receipt.
4. **Preserve concurrency safeguards.** Scope-before-operation locks and executor leases remain. A verification saved after the claim invalidates completion. Missing identities, conflicting offers, provider read errors, or database failures do not produce a successful recovery.
5. **Remove this specific pending-publication obstruction.** `readRegisteredMembers` in `inventory-publication-initial-scope.reader.ts:146` flags planned/staged publications, and line 171 reports `PENDING_PUBLICATION`. Completing recovery changes the abandoned target from planned to failed. The reader already consumes latest verified members; it does not require a new listing or a new ATP calculator.

## Hypotheses and unknowns

- The forbidden write is a reproducible recovery defect and is consistent with operation 5's recorded failure. Its historical error omitted the PostgreSQL constraint, so the exact original exception cannot be reconstructed from that record alone. This patch retains safe database error code/constraint metadata for future diagnosis.
- Provider reads are point-in-time observations, not a distributed lock on eBay. Recovery reads again when executed and rejects changed evidence.
- This patch has not itself been deployed or used to close production operation 5. It does not establish that all ATP cutover prerequisites are complete.

## Validation

- Marketplace-listing unit tests and CI manifest/migration-prefix guards.
- Real PostgreSQL migrations 0607, 0609 and 0610: forbidden historical update, normal compensation, current P50/C750 read-only reconciliation, immutable history, registration readback, no duplicate terminal retry, rollback on failed evidence insert, concurrent lease exclusion, stale verification rejection, and malformed result rejection.
- Existing initial publication-scope PostgreSQL regressions.
- Production and test TypeScript checks. No browser behavior changed.

## After deployment

The existing recovery gate was read as enabled; no setting was changed. Use the existing authenticated channel recovery action for operation 5 with channel 67, product 33 and marketplace `EBAY_US`. It rechecks eBay, then writes only recovery/verification/audit records for that operation and scope. Verify target 6 is failed, operation 5 is failed/compensated, source 1 remains active, and the latest verification includes P50/C750 but not C700.

Do not run the old recovery implementation. Do not activate ATP as part of this listing repair. Dropship retry remains a separate action after its actual PR deployment is confirmed.
