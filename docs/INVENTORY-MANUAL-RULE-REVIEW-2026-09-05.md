# Manual transformation rules: implementation handoff

## Summary

This change completes manual direction editing and approval in the existing Supply
& Transformations page. It does not add another operations page or activate the
canonical inventory runtime.

- `PostgresInventoryAvailabilityMasterDataStore.updateTransformationModelDraft`
  supersedes the current draft and inserts an operator-authored successor.
  The original definition and reviews remain immutable. An edit never inherits
  approval, including an edit that preserves the same directional definition.
- `captureOperatorInputHash` binds the successor to current catalog evidence.
  `InventoryAvailabilityBackfillService.getMigrationQueue` recognizes validated,
  source-current manual drafts independently of generated candidate equality.
- `PostgresInventoryAvailabilityBackfillRepository.reviewTransformationModelDraft`
  checks the exact model, version, definition, head revision, latest-review token,
  and current source evidence before recording approval.
- `refreshProductDraft` continues to reject operator drafts. Manual edits of
  generated drafts now acquire operator origin, so refresh cannot restore a
  direction that the operator blocked.
- `MigrationQueuePanel` displays the saved manual directions with product SKU
  details, waits for matching model evidence, and submits the latest-review token.
  `transformationRuntimeLabel` distinguishes actual runtime selection from a
  saved or approved draft. The admin read uses one repeatable-read snapshot.

## Assumptions and boundaries

- Direction permission remains explicit per product. Approval does not infer or
  add a reverse path. No SKU-name heuristic or product-specific hardcoded rule
  was introduced.
- No production settings, approvals, stock, claims, or channel quantities were
  changed in this implementation step. The already-completed production batch
  was not repeated.
- Generated backfill algorithm v3 and generated definition hashes are unchanged.
  Manual selections now contribute their exact version evidence to the catalog
  result fingerprint.
- Manual rules are reviewed individually; bulk generated-rule review skips them.
- Approval is not activation. This change introduces no activation endpoint.

## Validation completed

The full suite, database tests, and build below ran on base `8785bc75`.
Before publishing, the branch was fast-forwarded to `552fe1dd` (non-overlapping
dropship UI changes); all 48 focused checks across six files and typecheck passed
again on that updated base.

- `npm run test:unit`: 825 files passed; 7,446 tests passed, 14 skipped.
- Disposable local PostgreSQL 17, with both disposable-test environment guards:
  `inventory-availability-foundation.integration.test.ts`: 34 tests passed.
- Client presentation helpers, migration-prefix collision, and writer-ratchet:
  15 tests passed across the three focused files.
- `npm run check`: passed.
- `npm run build`: client and server passed; existing bundle-size warning remains.
- `git diff --check`: passed.

PostgreSQL tests cover generated approval followed by a one-way manual successor,
preserved approval history, exact saved-direction readback, manual approval and
replay, competing-review rejection, source drift, reapproval after resave,
automatic-refresh rejection, concurrent edits, stale rollback, durable receipts,
immutable source hashes, and isolation from inventory/publication writes.

Two unchanged source files needed local CRLF-to-LF normalization for existing
Windows-sensitive structural test regexes. This was test-environment formatting,
not a behavior change or an intended PR diff.

## Risks and failure modes

- Migration `0654_inventory_manual_transformation_review.sql` must run before
  the new application queries its added column. Main was refreshed and verified
  at `552fe1dd` before publishing; migration 0654 was free. Recheck before merging.
- Legacy operator drafts without a source fingerprint require a new saved version
  before approval. No fingerprint is backfilled onto an old immutable definition.
- Changed catalog sources or stale heads reject approval/edit commands. Concurrent
  edits serialize; one succeeds, the loser must reload. A reused idempotency key
  with a different command fails without partial writes.
- Blocking or excluded catalog classifications still prevent review. This change
  does not bypass catalog validation to approve a manually edited definition.
- Missing runtime metadata is shown as unavailable, not guessed to be active.
- If reverting the application, preserve the new versions and review history;
  suspend manual authoring instead of deleting that audit evidence.

## Not yet proven / next checks

### PR 1377 concurrency correction

CI exposed a missing whole-transaction retry after SERIALIZABLE was applied to
manual draft creation. A lock-barrier regression reproduced PostgreSQL `40001`
reliably for both concurrent creation and editing; neither loser returned the
expected current-state business conflict.

`retrySerializableMasterDataTransaction` now wraps complete create, edit, and
generated-refresh transactions, including commit/rollback. It retries only
serialization aborts, at most three attempts, and logs retry metadata without
SQL or command payloads. Every attempt rechecks the owner head, references, and
idempotency receipts using a fresh transaction. Isolation is not weakened.
Constraint failures, business conflicts, and uncertain connection errors are
not retried. Exhausted serialization failures preserve the existing HTTP retry
response.

The lock-barrier tests require both transactions to wait on the product owner
lock before releasing either writer. They retain strict `DRAFT_EXISTS` and
`DRAFT_STALE` expectations and verify no extra model or losing edit receipt.
All 34 PostgreSQL tests plus 20 retry/architecture checks passed after the fix.
This follows [PostgreSQL's complete-transaction retry requirement](https://www.postgresql.org/docs/17/mvcc-serialization-failure-handling.html).

The implementation has not been deployed or browser-tested against production.
Next: create and review the scoped PR, deploy it, then verify the existing editor
with a storage-box product. Apply and approve only the explicitly chosen
smaller-to-larger rules. Production activation remains a separate decision.
