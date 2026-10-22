# Phase 2: sync lifecycle recovery remediation

PR: [#1888](https://github.com/cardshellz/Echelon/pull/1888). Scope: the four gaps reproduced in the [historical audit](SALES-CHANNEL-SYNC-LIFECYCLE-AUDIT-2026-10-21.md). ATP calculations and phase 3 are excluded.

## What the code definitely does

| Gap | Change and single responsible owner | Evidence |
| --- | --- | --- |
| An archived member can remain unresolvable after a crash between its saved send marker and dispatch. | The shared member lifecycle separates dispatch status, verification attempts and recovery authorization. It continues safe observations, exposes a deliberate recovery decision for an unconfirmed removal, and dispatches only through the existing adapter. | [processListingMemberRetirement](../server/modules/marketplace-listings/application/process-listing-member-retirement.ts#L16), [ListingMemberRecoveryService.preview/resume](../server/modules/marketplace-listings/application/listing-member-recovery.service.ts#L133). |
| Failed history and unsent reviews can keep excluded products pending forever. | The shared obligation classifier distinguishes unsubmitted, pending, attention, completed and settled work. The existing sync writer records an immutable failed-to-replacement link only when the earlier request is proven to have stopped before any provider mutation and an exact-scope replacement has verified completion. | [hasListingWorkObligation / canSettleUnsentListingFailure](../server/modules/marketplace-listings/domain/listing-work-obligation.ts#L6), [readContentWork](../server/modules/marketplace-listings/infrastructure/pg-listing-intent-lifecycle.reader.ts#L62), [settleUnsentFailures](../server/modules/channels/infrastructure/ebay-listing-sync.repository.ts#L922). |
| Retaining an uncertain publish/withdrawal also resets the malformed-read budget. | The existing workflow persists the shared provider-read policy's counter separately from write uncertainty. Five malformed reads pause automatic checks. An explicit retry resumes checks on the same saved operation; original send evidence and publication uniqueness remain intact. | [syncFailure](../server/modules/channels/ebay-listing-sync.domain.ts#L159), [EbayListingSyncService.processDue](../server/modules/channels/ebay-listing-sync.service.ts#L328), [read scheduling migration](../migrations/900000021000018880001_channel_lifecycle_recovery.sql). |
| “Review listing” opens a publication editor while excluded work belongs elsewhere. | The lifecycle supplies typed action-owner references. The UI opens the saved sync/withdrawal, shared member-removal recovery, mapping owner or stock workspace. Generic channel and Dropship consumers use the same contract. Category exclusion no longer hides a row with unfinished work. | [ListingIntentChangesPanel](../client/src/features/channel-listing-publication/ListingIntentChanges.tsx#L46), [ListingRemainingWorkDialog](../client/src/features/channel-listing-publication/ListingRemainingWorkDialog.tsx#L56), [ListingMemberRecoveryDialog](../client/src/features/channel-listing-publication/ListingMemberRecoveryDialog.tsx#L20). |

The mapping-repair replay reader now obtains its saved job through [PostgresEbayListingSyncRepository.readSavedJob](../server/modules/channels/infrastructure/ebay-listing-sync.repository.ts#L598). It therefore returns the same paused-check state and diagnostics as the original request. No alternate recovery owner or provider retry implementation was added.

## Recovery trace and failure modes

1. The shared owner observes the exact archived remote member under the existing identity, mapping and catalog fences.
2. Before dispatch, it independently commits an unknown send marker. An accepted adapter result is recorded separately. A crash or lost response cannot erase either event.
3. If the member remains published after an unknown send, automatic passes observe it without another send. They expose recovery required. Accepted asynchronous removals receive bounded verification before requiring review.
4. Recovery preview makes a fresh validated observation and fingerprints the operation, source revision, saved version and identity. It does not mutate the provider.
5. Confirmation rechecks the review and scope, then atomically records the authenticated actor, command key, before-state, observation and queued authorization. Database triggers reject unauthorized state resets and incomplete authorization/audit transactions.
6. The worker rechecks current identity/archival before dispatch. Reactivation or changed mappings invalidate old work. Duplicate commands replay their durable receipt; concurrent confirmations cannot authorize duplicate dispatch.
7. Safe observations can still prove completion while a review is outstanding. Malformed normalized observations cannot be interpreted as successful removal.

The [recovery repository](../server/modules/marketplace-listings/infrastructure/pg-listing-member-lifecycle.repository.ts#L215) owns authorization persistence. The [migration](../migrations/900000022000018880002_listing_member_recovery.sql) enforces immutable evidence and transactional scheduling. eBay, Shopify, Walmart and Dropship tests exercise this shared owner. Adapters continue to implement provider observations and mutations only.

Partial writes, uncertain sends, different accounts and changed identities are deliberately not settled by a later successful product badge. They retain their outstanding duty and recovery action. The historical migration applies the same conservative rule as new completions, preserves failed rows and events, and is idempotent. See [settlement guards](../migrations/900000023000018880003_listing_work_settlement.sql) and [historical settlement](../migrations/900000024000018880004_settle_proven_historical_listing_work.sql).

## Validation

- **514 PostgreSQL tests passed in 22 suites.** A dedicated disposable PostgreSQL 17 cluster runs the relevant actual migrations, indexes, constraints and immutable evidence triggers. Supporting tables use test fixtures; external provider responses are mocked.
- Coverage includes crash before dispatch, lost acknowledgement, archival/reactivation, conflicting identities, concurrent confirmation, idempotent replay, audit rollback, malformed observations, HTTP authorization, Dropship tenant scope, and direct SQL rejection of unauthorized recovery.
- Settlement tests prove both safe replacement completion and historical backfill, including rerunning the actual backfill, and reject settlement after partial writes or across accounts.
- The broader database selection includes policy source/publication/metadata, store/category/product/variant pricing, pictures, automatic propagation, listing registration, initial publication/update, replacement recovery and archived-member catch-up.
- **188 browser tests passed on desktop and mobile.** Coverage includes exact-owner navigation while excluded, paused publish/withdrawal diagnostics, read-only access, and retrying the same recovery command after a lost response and dialog close/reopen. Browser API responses are mocked.
- **2,594 owner/shared unit tests passed in 153 suites.**
- **314 affected client contract tests passed in 19 suites.**
- CI preflight: the eight unaffected checks passed; the writer registry initially rejected the two new tables, then passed all 42 writer checks after registering each under its single owning module. The registry diff adds only those two tables.
- Application, server-test and client-test TypeScript checks all passed.
- Migration allocation/provenance checks and patch whitespace checks passed.

Test logs are retained locally in the worktree's uncommitted .codex-audits directory. They are not production observations.

## What is likely happening

The reproduced failures explain how the prior implementation could appear stuck even while provider reads continued, and why a later success did not always clear excluded-product work. This is a supported explanation of the tested code paths; attributing a specific current production SKU to one of them still requires its operation and event evidence.

## What is not proven

- This change has not been deployed or exercised against live provider accounts.
- No production census was run in this implementation task. The number of historical rows that qualify for settlement is unknown.
- CI, deployment and live acceptance are separate from the local green test results.
- The historical migration takes a write fence on the sync jobs table while recording proven settlements. Its duration at production data volume has not been measured.
- These fixes do not assert that all future provider refusals or all possible lifecycle defects are eliminated.

## Next checks before phase 3

1. Review the implementation and four allocated migrations in PR #1888; require hosted CI on its final head.
2. After deployment, inspect migration results and the shared job/member lifecycle evidence without clearing uncertain work.
3. Verify representative listing workflows end to end: policy/pricing source, complete image set, change propagation, exact provider observation, sync completion, archived-member recovery, exclusion and reactivation.
4. Confirm paused checks remain visibly actionable and accepted recovery survives refresh/reopen without duplicate provider writes.
5. Report deployment acceptance separately. Keep the ATP-zero investigation and phase 3 work separate.

No production data, provider listings or ATP calculations were changed by this implementation session.
