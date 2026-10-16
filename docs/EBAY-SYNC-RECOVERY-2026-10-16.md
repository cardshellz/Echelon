# eBay Sync recovery — October 16, 2026

PR: https://github.com/cardshellz/Echelon/pull/1817

Reviewed base: `8c42b2c63aa76ab24f932a4c33d4c665f68bb95e` (`origin/main`, fetched October 16).
Read-only Heroku release metadata reported successful deployment `v3285`, source `8c42b2c6`.
That identifies the deployed source; it does not prove every job, migration, or eBay response succeeded.
The dirty primary checkout and the order recovery worktrees were preserved.

## Confirmed causes

### A rejected publication was incorrectly treated as an unknown outcome

For product 232 (`SHLZ-TOP-180PT-BLU`), saved publication job
`1e4fae5d-ce57-4d72-817d-9dc714b4a877` retained attempt `19115`.
The first two quantity requests returned HTTP 200. The group publish request returned
HTTP 400, error 25007, category `Request`, and a terminated response. The saved job event
at `2026-10-15T19:10:27.950Z` retained eBay's explanation: invalid data in the fulfillment
policy / invalid shipping policy.

`classifyEbayQuantityResponse` in
`server/modules/channels/adapters/ebay/ebay-quantity-http.ts` recognized only uppercase
`REQUEST` and `BUSINESS`. The actual title-case category was classified as uncertain.
Subsequent recovery then showed a generic prior-publication error instead of the refusal.

The classifier now normalizes the provider category. Historical immutable receipts are
not rewritten. `isRejectedEbayPublicationReceipt` in
`server/modules/inventory-planning/domain/quantity-provider-terminal-response.ts` can
interpret the narrowly documented HTTP 400 rejection codes 25007 and 25016 retained in
old receipts. A timeout, missing response, accepted publication, unknown code, or server
failure does not become rejection proof.

### Sync did not consistently continue the publication that already existed

`PostgresEbayListingSyncRepository.enqueueInsideTransaction` now joins a matching active
or failed saved publication when the caller requests Sync. It retains the original
operation, exact identity, targets, acceptance, and delivery checkpoints. It prioritizes
an active job over an older failed preparation and does not hide unresolved historical
publication barriers behind another job.

`assertCommandOperation` checks the immutable requested-operation receipt for both
admission replay and command lookup. A Sync command that continued Publish stays a Sync
command; neither reverse operation reuse nor a different requester is accepted.
Normal Sync also recovers an accepted command before capturing today's mapping, so a
lost acknowledgement followed by newly saved eBay listing IDs does not create a second
request or an identity replay conflict.

`EbayPublicationCompletionExecution.execute` now uses the same
`recoverPriorEbayListingRequests` owner as existing-listing maintenance. Inventory remains
the owner of current quantity calculation, request evidence, and automatic stock recovery.
The current catalog draft and canonical photo resolver remain the content owners.

`PostgresEbayPublicationRejectionReader.readInsideTransaction` correlates the latest saved
publication stage with exact account/scope locks, request time, path, body hash, and all
retained request results. The channel repository appends a rejection checkpoint inside
the same transaction. Only that proof permits the same saved publication to send again.
It does not manufacture publication acceptance or remove the original audit history.

### Recurring stock recovery selected an older revision

`PostgresEbayPublicationReconciliationRepository.currentPlan` selected
`desired_revision::text` and ordered by the unqualified alias. PostgreSQL therefore sorted
the revision as text: 9 could outrank 10, 22, 45, or 55.

Read-only production comparison confirmed this mismatch for ten products:
13, 15, 28, 50, 52, 55, 69, 77, 88, and 97. Their saved checks reported
`PUBLICATION_RECONCILIATION_PLAN_CHANGED` even though newer numeric revisions existed.

Recovery now uses the existing publisher's `LATEST_PUBLICATION_ROW_SQL`; there is no
second latest-revision algorithm. Stock-plan changes and temporary ownership conflicts
remain scheduled automatic checks, rather than appearing as a decision the operator
must resolve. Identity and mapping conflicts still remain actionable failures.

### Bulk Sync could omit saved offers

`isExistingEbayListingSyncCandidate` in
`server/modules/channels/ebay-listing-eligibility.ts` now owns the candidate decision for
both `readActiveEbaySyncRows` and the feed's `canSyncExistingListing` field. Pending saved
offers can nominate a product for Sync. Excluded, ended, deleted, inactive, or SKU-only
unmapped rows cannot nominate a new publication. Once a product is selected, all retained
members are still captured for exact provider identity validation.

The UI counts the server's candidates and uses normal Sync for saved-publication recovery.
It preserves the real provider refusal and links shipping-policy errors to the existing
business-policy controls. Recovery progress is distinct from verified completion.

## Migration and integrity

`900000010000018170001_ebay_saved_publication_continuation.sql` permits a narrowly owned
terminal-publication continuation. It requires exact job/product/enqueue/command advisory
locks, an immutable command receipt from the current transaction, and unchanged provider
identity, target, acceptance, and verification checkpoints. It does not authorize another
unknown publish or clear a delivery barrier.

The allocator assigned PR 1817 after fresh main, with an explicit dependency on the latest
PR 1812 migration. Allocation preserved the tested SQL bytes exactly. A redundant final
blank line was subsequently removed for the whitespace check; no SQL statement changed.
Final migration SHA-256: `EA201447EAB8611CBB11ABD2B4E62203ECE58CD66B4BC02F546EC7D7B1E63C9B`.

## Validation and limits

- Combined disposable PostgreSQL run: 160 cases passed across channel sync, publication,
  mapping, response recovery, and recurring stock recovery suites. Cases include known
  refusal recovery, accepted/unknown refusal to resend, rollback, crash checkpoints,
  concurrent requests, delayed stock effects, command replay, and revision 9→10 / 99→100.
- Application and server-test TypeScript checks passed during implementation. Final broad
  unit and browser results are recorded in the PR validation section.
- The combined channel, inventory, dropship, shared, route, and writer-boundary unit scope
  passed 11,675 tests. The final response-loss replay and recovery-action changes then
  passed 174 focused cases. These overlapping runs must not be added together.
- Provider responses are simulated in automated tests. No live eBay writes, stock changes,
  policy changes, release, or production migration were performed for this PR.

The 25 Errors badge is not proof that every product has the same cause. Other observed
rows included changed membership, missing canonical mappings, and excluded content.
Those are not silently reclassified as successful by this change.

For the blue 180PT product, a read-only configuration check found product fulfillment
override `260509063019`, while the channel default was `264720997019`; neither variant
had its own override. `preparePushDraft` in
`server/modules/channels/infrastructure/ebay-listing-push.ts` gives the product override
precedence over the channel default. eBay rejected the policy used by the recorded
attempt. The current validity or intended replacement of either policy was not verified
with a new eBay policy read. This PR does not silently choose different shipping terms.

A historical publish-start checkpoint without a provable provider request/response is
still insufficient evidence to repeat publication. Exact current provider identity and
response evidence must resolve that uncertainty; no success or non-delivery is invented.
