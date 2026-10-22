# Sales channel sync lifecycle audit after PR 1884

> Historical baseline, preserved as the record of the reproduced failures. The implementation and green regression results are now described in [Phase 2 remediation](SALES-CHANNEL-PHASE-2-LIFECYCLE-REMEDIATION-2026-10-21.md). Statements and test outcomes below refer to the audited code, not the repaired implementation.

Audited commit: `5423f956f0bf2ba4934252f043367f2e9a141a93`, the merge of PR #1884 on October 21, 2026 at 18:30 EDT. Audit branch: `codex/channel-sync-lifecycle-audit`.

**Conclusion: phase 2 still has four confirmed recovery and completion gaps.** Five new PostgreSQL acceptance cases and one browser case run on desktop and mobile reproduce them. The existing safeguards passed the targeted baseline. These findings call for changes in the existing responsibility owners, not product-specific exceptions.

This is a source and executable-test audit of the merged code. It is not a production deployment verification or a current count of affected products. No production data, provider listings, credentials, ATP calculations, or production implementation files were changed.

## What the code definitely does

### 1. An archived member can remain in removal recovery after a crash before dispatch

**CONFIRMED GAP — P1.**

The shared `processListingMemberRetirement` owner saves `retiring` before invoking the adapter. `PostgresListingMemberLifecycleRepository.saveProgress` commits that marker on a separate connection so a crash cannot erase evidence of a possible send. On restart, the shared owner reads the exact external identity, but calls `retire` only when the saved state is not already `retiring`. If the process stopped after committing the marker and before making the external call, the remote member stays published and every later pass only observes it.

Concrete trace:
1. Discover the archived member and acquire its member/catalog locks.
2. Observe that its exact remote offer is still published.
3. Commit the `retiring` marker.
4. Process exits before adapter dispatch.
5. Restart reads `retiring`; the provider still reports published.
6. The owner saves `retiring` again and schedules another check. There is no recovery decision in this processing path.

The PostgreSQL test injects the exit immediately after the real independent commit, proves that neither clearing nor deletion was called, creates a fresh repository, and runs six further passes. It remains `retiring`. The test does **not** assert that blind resubmission would be safe.

Evidence: [processListingMemberRetirement](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/marketplace-listings/application/process-listing-member-retirement.ts#L64); [saveProgress](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/marketplace-listings/infrastructure/pg-listing-member-lifecycle.repository.ts#L178); [PostgreSQL reproduction](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/marketplace-listings/__tests__/integration/listing-member-lifecycle.integration.test.ts#L64).

**Responsible owner:** shared listing-member lifecycle. Provider adapters should report exact observations, dispatch receipts, refusal, and uncertain outcomes. They should not independently choose retries.

**Required remediation:** retain a distinct dispatch/outcome record and provide an audited recovery command for an unresolved retirement. Prove safe no-send cases where evidence permits; otherwise require a deliberate recovery decision with fresh observation, identity fencing, concurrency protection, and a stable command key. Preserve the original unknown outcome. Do not reset `retiring` solely because time passed.

**Unknown:** whether any production retirement is currently in this exact crash window. The test demonstrates the failure mode using a mocked eBay provider and the production shared state machine; it is not a live-provider reproduction.

### 2. The lifecycle reader treats history as outstanding work

**CONFIRMED GAP — P2, with two independently reproduced forms.**

**eBay:** a sync fails during policy preparation, before any provider mutation. A fresh command is admitted, successfully updates the exact listing, and completes. The original sync remains `needs_attention`. `hasOutstandingEbayListingWork` counts every job that is not completed unless its code is `EBAY_SYNC_SOURCE_SUPERSEDED`. The enqueue owner considers terminal publication jobs for continuation, but not terminal maintenance-sync jobs for settlement. Consequently, the shared exclusion lifecycle can continue reporting prior channel work after the replacement has completed.

The new PostgreSQL case first proves no outstanding work, induces a policy-preparation refusal with zero provider mutations, completes a separate replacement through the real executor/repository, and still receives `true` from the outstanding-work reader.

Evidence: [enqueueInsideTransaction](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/channels/infrastructure/ebay-listing-sync.repository.ts#L189); [hasOutstandingEbayListingWork](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/channels/infrastructure/channel-stock-selection.repository.ts#L84); [resolveListingIntentLifecycle](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/marketplace-listings/domain/listing-intent-lifecycle.ts#L59); [PostgreSQL replacement-completion reproduction](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/channels/__tests__/integration/ebay-listing-sync-recovery.integration.test.ts#L326).

**Other shared channel workflows:** `hasPendingContent` counts every listing update whose state is not `accepted`. That includes an expired `reviewed` record which has never received a command or been submitted. The normal update list explicitly excludes reviewed records.

The new Walmart case proves the excluded product has settled stock work first, then saves an expired, unsubmitted review through the real update repository. The account, environment, marketplace, and SKU match exactly. The update list is empty, but the shared lifecycle changes to `waiting_lifecycle`.

Evidence: [hasPendingContent](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/marketplace-listings/infrastructure/pg-listing-intent-lifecycle.reader.ts#L83); [PostgresListingUpdateRepository.list](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/marketplace-listings/infrastructure/pg-listing-update.repository.ts#L169); [PostgreSQL unsent-review reproduction](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/marketplace-listings/__tests__/integration/listing-intent-lifecycle.integration.test.ts#L698).

**Responsible owner:** shared listing lifecycle owns what constitutes an outstanding obligation. Existing execution owners supply evidence of dispatch, unresolved effects, verified completion, and supersession.

**Required remediation:** replace broad negative state tests with one explicit obligation contract. An unsubmitted review is not remote work. A proven pre-write failure can be settled by a verified, exact-scope replacement while retaining its immutable failure history. Partial writes and unknown sends must remain outstanding until reconciled. Record the relationship between the failed command and the command that actually resolved it; do not mark every old error complete or infer resolution from the latest product badge.

**Unknown:** how many current production history rows would qualify for settlement. A migration or repair must classify them from their evidence, not bulk-clear all old failures.

### 3. An unresolved send disables the malformed-read retry limit

**CONFIRMED GAP — P2.**

The shared provider-read policy allows five malformed-response attempts. `EbayListingSyncService.processDue` overrides the classified result whenever a publish or withdrawal has a saved start/acceptance marker, retaining an active state and resetting attempts. The repository's barrier-retention branch also resets attempts. Thus preserving the write barrier also prevents exhaustion of the read budget.

Two PostgreSQL cases retain a genuine persisted publish/withdraw start marker, inject the same malformed-read diagnostic repeatedly, and run eight worker passes. Both execute all eight reads, retain the diagnostic and original send marker, and perform no provider mutation. The expected five-read bound fails.

Evidence: [providerReadShouldRetry](https://github.com/cardshellz/Echelon/blob/c2a51c503/shared/channel-provider-read.ts#L22); [EbayListingSyncService.processDue](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/channels/ebay-listing-sync.service.ts#L408); [PostgresEbayListingSyncRepository.finish](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/channels/infrastructure/ebay-listing-sync.repository.ts#L831); [PostgreSQL publish and withdrawal reproductions](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/channels/__tests__/integration/ebay-listing-sync-recovery.integration.test.ts#L585).

**Responsible owner:** shared provider-read classification determines retry policy; the workflow owner independently retains uncertain-write authority.

**Required remediation:** separate the unresolved-write fence from read scheduling and retry counters. Persistent schema failures must reach an actionable diagnostic/review state without allowing a fresh publish or removal to bypass the old send. Corrected credentials or adapter behavior should resume the same saved operation. Adapters must return normalized read facts rather than implement their own retry loop.

**Unknown:** the original production response that triggered the earlier malformed-read error. This audit does not establish that eBay changed its response format or that ATP caused it.

### 4. The excluded-work action opens the publishing owner

**CONFIRMED GAP — P2.**

`ListingIntentChanges` offers “Review listing” for pending lifecycle work. `EbayChannelPage.onReview` always opens `MarketplaceListingChangesDialog` when the product exists. That dialog posts a rebuild preview to `/api/ebay/listings/push`. Its repository correctly refuses an excluded product and tells the user to enable it before publishing.

The result is a circular action for a product intentionally excluded while removal or clearing remains unfinished. The user needs the existing removal/reconciliation owner, not a publication preview. This is an action-routing defect; weakening publication eligibility would be an incorrect repair.

Evidence: [EbayChannelPage onReview](https://github.com/cardshellz/Echelon/blob/c2a51c503/client/src/pages/EbayChannelPage.tsx#L1268); [MarketplaceListingChangesDialog.loadPreview](https://github.com/cardshellz/Echelon/blob/c2a51c503/client/src/components/marketplace/MarketplaceListingChangesDialog.tsx#L103); [PostgresEbayListingPushRepository.readProduct](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/channels/infrastructure/ebay-listing-push.repository.ts#L85); [desktop/mobile acceptance case](C:/Users/owner/.codex/worktrees/channel-recovery-owner/Echelon/test/browser/ebay-listing-intent.spec.ts:7); [observed desktop dialog](C:/Users/owner/.codex/worktrees/channel-recovery-owner/Echelon/.codex-audits/sync-lifecycle-ui-desktop-context.md:29).

**Responsible owner:** shared lifecycle exposes a typed next action with the exact obligation/operation reference. The UI routes that action to the existing removal, mapping, or inventory-evidence workspace.

**Required remediation:** stop deriving the action merely from the existence of a product. Keep excluded products excluded; open their actual pending owner. Disabled-category products also need reachable pending-work controls: the current feed removes `type_disabled` rows before attention filtering ([filteredFeed](https://github.com/cardshellz/Echelon/blob/c2a51c503/client/src/pages/EbayChannelPage.tsx#L1192)).

**Unknown:** a complete production UI census of disabled-category products. The browser reproduction uses mocked API responses; its refused-publication response is separately grounded in the server admission code.

## Lifecycle coverage and ownership

| Lifecycle responsibility | Trace reviewed | Evidence and remaining boundary |
|---|---|---|
| Manual Sync, Sync All, stream admission | Listings routes → `syncActiveListings` → durable sync admission/repository | These entry points converge. They are not three independent sync implementations. Recovery suites cover command replay and coalescing. |
| Automatic change capture and fanout | Propagation repository `expand/claim/withDelivery/finish/defer/retry` → `ExistingListingIntentHandoff` | PostgreSQL fanout, lease, receipt-first retry, account isolation and exclusion tests passed. Lifecycle classification has finding 2. |
| Policies and prices | Business-policy owner; channel-pricing owner → prepared intent | Targeted source/publication/metadata suites passed. Pricing tests inspect the actual partial indexes and explicit-price uniqueness. |
| Pictures and prepared content | Photo resolver → prepared intent → listing connector and verification | Targeted photo and partial-sync recovery tests passed. Retained media and completion evidence were reviewed; no claim about current live galleries is made. |
| Claim, concurrency and restart | Durable sync repository session locks, ownership token, claimed revision and events | Existing restart, competing-worker, joined-command, rollback and projection tests passed. |
| Provider reads and refusals | Registration observer → shared read diagnostic → workflow classifier | Diagnostics remain retained. Finding 3 shows the retry policy is overridden after a send marker. |
| Prior uncertain writes | Inventory response recovery → shared operator-resume repository → thin listing continuation | Existing exact-scope, permissions, stale review, concurrent confirmation, idempotency and transactional rollback tests passed. Unknown writes remain fenced. |
| Initial publish and withdrawal | Existing durable workflow executors → same saved job/recovery routes | Existing publication and withdrawal coverage passed. This does not resolve the separate shared member-retirement crash window. |
| Archived member removal | Shared member lifecycle → eBay/Shopify/Walmart adapters | Normal removal, identity fencing, reactivation, concurrency and lost-response tests passed. Finding 1 covers the missing pre-dispatch crash resolution. |
| Catch-up after archival | Shared quantity catch-up owner and retained retirement evidence | Archive/canonical catch-up suites passed. ATP calculation and the separate zero-stock investigation were not changed. |
| Verification and projection | Connector readback → revision checkpoint → transactional completion/projection | Existing delayed-readback, lost-checkpoint, persistence-failure and identity-change tests passed. Old failed-history settlement remains finding 2. |
| User status and recovery actions | Saved-job dialog, recovery dialog, exclusion controls, listing-change history | 176 existing desktop/mobile cases passed. Finding 4 identifies a route those tests did not exercise. |

Source anchors: [sync admission](C:/Users/owner/.codex/worktrees/channel-recovery-owner/Echelon/server/modules/channels/infrastructure/ebay-active-listing-sync.ts); [propagation service](C:/Users/owner/.codex/worktrees/channel-recovery-owner/Echelon/server/modules/marketplace-listings/application/listing-intent-propagation.service.ts); [propagation repository](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/marketplace-listings/infrastructure/pg-listing-intent-propagation.repository.ts#L102); [handoff adapter](C:/Users/owner/.codex/worktrees/channel-recovery-owner/Echelon/server/modules/marketplace-listings/infrastructure/existing-listing-intent-handoff.ts); [policy resolution](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/channels/ebay-business-policies.service.ts#L281); [pricing index tests](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/channels/__tests__/integration/channel-pricing-owner.integration.test.ts#L32); [photo resolver](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/channels/ebay-listing-photos.service.ts#L32); [sync connector](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/channels/listing-connectors/ebay-listing.connector.ts#L885); [atomic recovery continuation](C:/Users/owner/.codex/worktrees/channel-recovery-owner/Echelon/server/modules/channels/infrastructure/ebay-listing-recovery-continuation.ts); [archive catch-up tests](C:/Users/owner/.codex/worktrees/channel-recovery-owner/Echelon/server/modules/inventory-planning/__tests__/integration/quantity-publication-catchup-archive.integration.test.ts).

## What is likely happening

**HYPOTHESIS:** persistent “channel work pending” can be caused by historical or unsubmitted records being classified as live obligations, rather than by an unfinished provider update. The two PostgreSQL cases establish that mechanism. They do not identify which current customer products have it.

**HYPOTHESIS:** repeated “checking” after a deterministic invalid provider read can reflect the retry-counter override in finding 3. Provider latency, rate limiting, or a genuine outage remain different possibilities for a particular live request.

The evidence does not support attributing all sync delays to ATP, one SKU, or one recently changed eBay field.

## What is not proven

- Current production incidence, current worker throughput, or the deployed runtime SHA.
- Current eBay stock, image galleries, prices or policy values for 180PT/260PT. No live sync or corrective write was issued.
- A user-completable recovery path for every broader-scope legacy request. The current shared resume repository intentionally rejects partial-scope recovery, and the dialog directs broader cases to an administrator. This is a remaining acceptance boundary, not permission to bypass scope fences: [recovery review](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/inventory-planning/infrastructure/publication-recovery.repository.ts#L135); [recovery dialog](https://github.com/cardshellz/Echelon/blob/c2a51c503/client/src/components/ebay/EbaySyncRecoveryDialog.tsx#L129).
- Complete retirement of legacy structural update/rebuild paths. Those commands still call `executeProduct` and the connector directly rather than the maintenance job owner: [reviewed structural dispatch](https://github.com/cardshellz/Echelon/blob/c2a51c503/server/modules/channels/infrastructure/ebay-listing-push.ts#L185). Interrupted preview recovery is explicitly limited in that path. Consolidating those paths belongs to the separately planned operation-owner work; this audit did not start it.
- Completion of persistent bulk progress outside the modal. Current stream tracking is modal-local: [SyncProgressModal](https://github.com/cardshellz/Echelon/blob/c2a51c503/client/src/components/ebay/SyncProgressModal.tsx#L57). This audit does not claim that separate UI requirement is finished.

## Test coverage and changes

Only acceptance tests and this report were added. The tests use generic fixture identities; no production SKU receives special behavior.

| Validation | Result |
|---|---|
| Existing lifecycle, propagation, catch-up and recovery PostgreSQL baseline | 334 passed in 10 suites |
| Existing policy, pricing, pictures, push and member-lifecycle PostgreSQL coverage | 95 passed in 8 suites; the new audit case was intentionally excluded |
| Existing shared publication, update and replacement PostgreSQL coverage | 56 passed in 3 suites |
| Existing eBay sync/recovery/exclusion browser baseline | 176 passed, desktop and mobile |
| New PostgreSQL acceptance cases | 5 failed on the audited implementation, reproducing findings 1–3 |
| New browser acceptance case | Failed on desktop and mobile, reproducing finding 4 |
| Final server-test and client-test TypeScript checks | Both passed using an 8 GiB Node heap |
| Patch whitespace and report reference checks | Passed; 40 source/evidence links validated |

The database tests used PostgreSQL 17 on a dedicated local disposable cluster. Relevant workflow migrations, constraints, indexes, and immutable audit triggers were installed by the suites; fixtures provide supporting schemas. External providers were mocked. This is real database evidence, not proof of live provider behavior.

Failure tests intentionally assert the required behavior and remain red. They are reproduction/acceptance evidence, **not completed regression safeguards** and not a merge-ready fix.

Logs: [lifecycle baseline](C:/Users/owner/.codex/worktrees/channel-recovery-owner/Echelon/.codex-audits/sync-lifecycle-main-postgres.log); [source-owner baseline](C:/Users/owner/.codex/worktrees/channel-recovery-owner/Echelon/.codex-audits/sync-lifecycle-source-owners-postgres.log); [shared-owner baseline](C:/Users/owner/.codex/worktrees/channel-recovery-owner/Echelon/.codex-audits/sync-lifecycle-shared-owners-postgres.log); [five PostgreSQL failures](C:/Users/owner/.codex/worktrees/channel-recovery-owner/Echelon/.codex-audits/sync-lifecycle-gap-reproductions.log); [browser baseline](C:/Users/owner/.codex/worktrees/channel-recovery-owner/Echelon/.codex-audits/sync-lifecycle-browser-baseline.log); [two browser failures](C:/Users/owner/.codex/worktrees/channel-recovery-owner/Echelon/.codex-audits/sync-lifecycle-ui-gaps.log).

## Next checks and phase 2 exit requirements

1. **Shared member lifecycle:** close the pre-dispatch crash and unresolved-retirement decision paths. Add regression gates for crash before/after dispatch, lost acknowledgement, explicit recovery, reactivation, competing workers, and command replay.
2. **Shared obligation classification:** define outstanding work once, using normalized evidence supplied by execution owners. Cover unsent/expired reviews, proven pre-write refusal, exact replacement completion, partial writes, unknown sends, and older obligations for a different account or mapping.
3. **Shared read policy and workflow scheduling:** retain the unresolved-write fence independently from a bounded malformed-read budget. Cover publish, withdraw and maintenance, including restart and diagnostics persistence.
4. **Shared next-action projection:** carry an exact owner/reference to the UI. Pending removal, stock clearing, structural review, policy correction and unknown-outcome recovery must route to different existing actions. Verify these while the product or category remains excluded.
5. Re-run the passing baseline plus the new acceptance cases after the owner fixes. Then perform a separate read-only production census before deciding whether any evidence-backed repair is needed. Preserve unresolved provider obligations during that review.

Do not declare phase 2 complete while these acceptance cases fail. No phase 3 implementation was started.
