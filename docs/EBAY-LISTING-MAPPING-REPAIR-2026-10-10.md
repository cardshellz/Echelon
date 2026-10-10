# eBay listing mapping diagnosis and repair

Base: `origin/main` at `73b98ea29630f1f9222160a8f4939efdfee8473d`. Dedicated branch: `codex/ebay-mapping-repair`. This follows merged PR #1744; it does not reuse that PR or modify production.

## Confirmed problem and resulting behavior

The previous mapping branch in `EbaySyncRecoveryDialog` displayed saved source identity and a generic identity rejection. It did not show a fresh per-SKU comparison or offer a transactionally recorded mapping correction. Retrying verification could therefore return the same unexplained error.

`EbayMappingRepairDialog` now reads a fresh review and shows saved/current SKU, offer, listing, and publication status, plus missing/extra group members. Each affected variant has a specific explanation and recommendation. If the complete live publication proves one unambiguous match, the user can apply the verified mapping and queue sync. If the saved mapping already matches, the action resumes sync. Read failures, account authorization, disabled variants, ambiguous publications, local ownership conflicts, and canonical registration conflicts have separate directions.

The screenshot alone does not establish which provider condition caused the reported product failure. No live account query was performed in this task. The new review obtains that evidence when opened after deployment.

## Code trace and ownership

1. `server/routes/ebay/ebay-listing-mapping.routes.ts:16`, `registerEbayListingMappingRoutes`: authenticated, permission-checked GET review, POST confirmation, and scoped receipt lookup; strict command validation and no-store responses. A GET review performs no mapping or quantity mutation.
2. `server/modules/channels/ebay-listing-mapping.service.ts:58`, `diagnose` / `apply`: fresh source and provider inspection, source fence, canonical/local ownership checks, review hash comparison, exact command replay, and durable refusal handling. Unknown outcomes retain their command.
3. `server/modules/marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer.ts:203`, `inspectExistingPublication`: reuses canonical credential, pagination, offer, and complete publication discovery. `resolveCoherentListingId` now accepts the same listing ID repeated across variation offers while still rejecting genuinely distinct publications. This defect was reproduced by tests; it is not established as the cause of the screenshot.
4. `server/modules/channels/ebay-listing-mapping.domain.ts:102`, `buildEbayListingMappingDiagnosis`: explicit per-SKU diagnosis and recommended action; no guessed remapping. Mutable ATP and observation timestamps do not make an otherwise identical review stale.
5. `server/modules/channels/infrastructure/ebay-listing-mapping.repository.ts`, `apply` / `rejectReviewedCommand`: serializes confirmation, verifies current saved state and ownership, changes local identifiers, records immutable before/after evidence, and queues through the existing `enqueueInsideTransaction` owner in one transaction. Successful and rejected outcomes for a command cannot both commit.
6. `client/src/components/ebay/EbayMappingRepairDialog.tsx:70`: persists UUID and review hash before POST, checks exact receipts after lost responses/reload, preserves uncertain commands, and follows the authoritative sync job through completion or its next actionable issue.

## Data and concurrency boundaries

Migration `0736_ebay_listing_mapping_repairs.sql` adds immutable repair and refusal journals. Repair changes only saved external SKU, offer, listing, URL, and update timestamp. Price, quantity, acknowledgment, historical status, and provider-operation evidence remain intact. The repair does not publish, delete, or recreate an eBay listing. Its queued sync uses the existing quantity admission and recovery protections.

Provider reads occur before the short local transaction. Source revalidation, mapping update, audit receipt, and durable enqueue share one transaction. Canonical registration locks and local source locks prevent conflicting apply-time ownership. A brief listing-table lock serializes repair with existing mapping writers; under contention it times out rather than partially applying. Independent edits after commit remain subject to normal sync source/provider fences.

An existing compatible job may receive another requested revision. Its exact queued identity is retained separately from the newly verified mapping evidence; historical group hints are not rewritten. A prior bound provider identity cannot silently become a different publication. Unknown prior writes remain subject to the canonical group/member quantity recovery checks.

## Validation and limits

- Full unit suite: 21,820 passed; 40 skipped. The initial Windows run exposed unchanged CRLF-sensitive Dropship fixtures. Sixteen unchanged fixture/schema/migration inputs were normalized locally to committed LF bytes; they have no Git diff and are not included in this change.
- Browser: 90 desktop/mobile mapping, recovery, and photo checks passed; two additional permission checks and four receipt/reload follow-up checks passed. Browser responses are mocked; this is UI evidence, not live eBay proof.
- Application, server-test, and client/shared TypeScript checks passed; application/server checks and the production build were repeated successfully after the final integration refinements.
- Production build passed, with the existing bundle-size warning.
- Disposable PostgreSQL: 48 passed (26 mapping repair, 22 existing sync/recovery). Coverage includes atomic application/enqueue, immutable evidence, concurrency, durable refusals, stale state, rollback, exact replay, ownership conflicts, lock ordering, eligibility toggles, and post-commit worker admission. A changed-group test proves the original unresolved request still blocks new provider mutations through the common member SKU. No production database is used.
- Final focused refinements and writer/CI guards: 159 passed. Migration prefix 0736 was checked against freshly fetched main at the base commit above.

Malformed local mappings or ambiguous ownership do not have a safe automatic choice. Those cases explicitly identify the local diagnostic and administrator correction boundary. The UI must not claim that Seller Hub can repair a local database inconsistency. Deployment, live-provider behavior, and the user's particular listing remain unverified until separately exercised. No migration was applied to production, and no production or provider write occurred.
