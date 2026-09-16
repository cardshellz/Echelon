# Shopify split-fulfillment recovery

## Scope

Correct valid package-level Shopify updates after ShipStation splits an order. Recover only exact order-line quantities and tracking, using existing owner services. This change does not run a production backfill, move inventory, introduce a review page, or mark carrier possession from label creation.

Customer-specific order, tracking and provider-response evidence belongs in the private operational report, not this public repository.

## Corrected execution paths

- `fulfillment-push.service.ts` / `projectCanonicalCommandQuantities`: an activated allocation is immutable, while its compatibility WMS source row may shrink after a split. Validate the exact persisted package grant and allow a valid reduced live source quantity. Invalid or enlarged sources still fail; Shopify's current remaining quantities are checked before the provider write.
- `channel-fulfillment-authority.service.ts` / `providerCommandInput`: hydrate the current parent header of the same exact source item only when the command has complete allocation-entry/effect provenance. The provider adapter still verifies the complete persisted grant. Never rewrite the command's saved metadata or hash.
- `package-allocation-authority-resolution.service.ts` / `resolvePackageAllocationAuthorityEvidence`: provider order relationships discover candidates, not shared quantity ownership. Exclude only complete, current-flow, disjoint package histories from the selected source group's planner input. Keep all discovered evidence in the audit. Unknown, empty, mixed, overlapping, rejected and previously bound packages remain in scope.
- `package-allocation-ledger.repository.ts` / `assertMaterializedLegacyRequestLinks`: reconstruct a split source from its root plus exact recorded children when validating later canonical request enrichment. Preserve order, line, purpose, variant, request, plan and physical-item checks. Missing historical split links must not be invented.
- `channel-fulfillment-review-retry.*`: support a separately audited `notifyCustomer: false` retry for eligible held Shopify commands. Require the preview fingerprint and an authenticated operator's reason. A retry neither edits the original notification intent nor resets its attempt history.
- `channel-fulfillment-authority.repository.ts` / `claimCommands`: hydrate the request-hash-bound suppression audit into each retry attempt and honor explicit command-ID scope when handling expired leases. Successful and failed attempts retain suppression provenance.

For example, two cases shipped in two one-case packages must produce two exact one-case fulfillment updates, not a duplicate-order rejection. A package containing a different line does not become a competing package for those cases merely because it shares the order number.

## Deployment and rollback

1. Apply `0675_channel_fulfillment_silent_review_retry.sql` with the normal release migration process. Confirm its numeric prefix remains unique against the latest main branch before merge.
2. Deploy the matching application code and verify the deployed commit. The migration alone does not requeue or fulfill anything.
3. Refresh exact Shopify store/order/line identities, fulfillment-order remaining quantities, tracking and command fingerprints before proposing any recovery.
4. Obtain approval for the exact package/command batch and its audit effects before executing. Historical recovery must use `notifyCustomer: false`; ordinary new fulfillment behavior is unchanged.
5. Use existing owner workflows to materialize eligible new package commands or retry existing held commands. Do not duplicate an existing successful command or replay a previous execution manifest blindly.
6. Read Shopify back by line ID, quantity and tracking. A queued command is not successful recovery. Report true backorders, conflicting evidence and provider failures separately.

The migration adds a per-attempt notification-policy acknowledgment. A database trigger prevents an old or rolled-back worker from claiming a silently reviewed command without honoring suppression. On rollback, retain the immutable suppression audit and fence; pause/drain affected workers rather than removing the protection and risking historical customer emails.

## Failure modes and boundaries

- Preview does not reserve provider capacity or prove that a later mutation will succeed. Live data can change between provider reads; refresh before apply.
- A stored allocation grant does not authorize fulfillment beyond Shopify's current remaining line quantities.
- A refund, removed line, replacement line or unknown historical package is not resolved by matching SKU alone. Preserve its hold until exact evidence supports a decision.
- Requeue is idempotent and fingerprinted. Concurrent duplicate requests produce one audit/action; changed state requires a fresh preview.
- Suppression is Shopify-only, request-hash-bound and false-only. No API option can enable notifications through this override.
- Provider errors remain classified and auditable. Replays retain package identity and do not issue quantity twice.

## Validation

- OMS/shipping unit suites and migration/writer/test-typecheck guards: 210 files, 2,801 tests passed.
- Complete package-allocation PostgreSQL integration suite: 78 tests passed on a disposable local PostgreSQL 17 database, including concurrent retry, rollback, immutable metadata, silent provider payload, old-worker rejection and explicit split replay.
- Full application typecheck, server/client test typechecks and production build passed before publication. The existing test-typecheck exclusions were not increased.
- The source-inspection conformance helper normalizes CRLF so its unchanged assertions also work on Windows.
- Production provider previews were read-only. No customer-specific evidence, credentials or execution manifests are committed with this change.
