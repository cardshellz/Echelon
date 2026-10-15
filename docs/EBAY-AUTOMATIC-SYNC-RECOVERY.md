# Automatic recovery for existing eBay listing updates

Initial baseline: `ec1b87c53f021e9ce021f8598bcde4a6baa8e2fe`.
Fresh-main compatibility reference: `37a41a80ed2dfc570730ac49928e11cb72f3294b`.
PR: https://github.com/cardshellz/Echelon/pull/1812.

An interrupted quantity request can retain an unknown outcome indefinitely. Existing
listing sync checks that history before updating catalog content and pictures, so a
lost response can strand the entire saved sync. The recovery dialog can also retain
an obsolete error after a successful recovery handoff.

## Implementation contract

- Existing Sync owns the saved request through recovery and verified content
  completion. Repeated clicks coalesce; process restarts resume durable work.
- Inventory remains the sole quantity publisher. Automatic recovery applies only
  to verified existing listings and supported replacement/absolute-quantity
  operations, after excluding live local senders and checking every affected scope.
- Superseding an unknown request preserves its unknown outcome and immutable audit
  evidence. A local timeout is not proof that an eBay request terminated.
- Recovery atomically retains follow-up work. New writes use current canonical
  stock and current catalog content, never a replay of historical quantities.
- A durable recurring check continues after recovery, including after a successful
  readback. It detects late provider writes and uses the same publication and
  listing-sync owners to restore current stock and content. There is no assumed
  maximum delay after which an unknown remote request is declared harmless.
- Completion and progress distinguish verified listing content from stock
  publication. Genuine identity, permission, connection and catalog problems retain
  their protections and actionable UI; historical errors do not masquerade as the
  current state after recovery.

This provides eventual correction after delayed provider effects. It cannot make
eBay apply requests transactionally with Echelon, prevent every transient remote
overwrite, or establish the historical result of a lost response.

## Acceptance evidence

Local acceptance on 2026-10-15 uses PostgreSQL 17 in a disposable local database,
controlled provider HTTP responses, and desktop/mobile browser tests against the
real client with mocked application APIs. No production recovery or publication
was performed. Clocks and worker invocations are controlled in integration tests;
these results do not establish a deployed scheduler or live eBay acceptance.

### Source trace

1. `EbayExistingListingSyncExecution.execute` in
   `server/modules/channels/ebay-listing-sync.service.ts:62` verifies the current
   listing identity, checks terminal-response evidence, and invokes inventory's
   automatic recovery for the exact saved Sync revision. An active local sender
   retains its lock; Sync waits and retries. A recovered request prepares inventory
   even if its pictures already match, so a retained inactive variant cannot miss
   its canonical zero mapping.
2. `PostgresEbayAutomaticPublicationRecoveryRepository.recover` in
   `server/modules/inventory-planning/infrastructure/ebay-automatic-publication-recovery.repository.ts:15`
   locks every affected scope, checks supported request operations, and atomically
   saves the old attempt, request evidence, recurring watch and catch-up work.
   Only the attempt state becomes `superseded_unknown`; its historical result is
  not rewritten as success. A changed verified membership can establish a new
  exact watch without replacing the earlier watch or its evidence. A job linked
  to several watches shows their most urgent outstanding status.
3. `EbayPublicationReconciliationService.processDue` in
   `server/modules/inventory-planning/application/ebay-publication-reconciliation.service.ts:54`
   leases one due check at a time. `recordStock` in the corresponding PostgreSQL
   repository verifies that the observed target and desired revision remain
   current, then sends drift evidence through the existing canonical planner and
   outbox. It does not calculate a separate ATP quantity. Checks recur every
   15 minutes after a completed cycle, with bounded retry backoff after failure.
4. `refreshRecoveredEbayListing` in
   `server/modules/channels/infrastructure/ebay-active-listing-sync.ts:591` requests
   content verification through the existing Sync owner. Its deterministic command
   key resolves an already-consumed receipt before reading mutable catalog state;
   a crash after enqueue cannot duplicate the command or trap it after a rename.
5. `readEbayInventoryQuantity` in
   `server/modules/channels/adapters/ebay/ebay-inventory-quantity.ts` records whether
   inventory-item and offer quantities agree. The outbox and recurring check retain
   that evidence: a smaller matching quantity cannot hide a stale larger quantity
   on the other eBay resource.
6. `presentEbayListingJob` and `presentInventoryReconciliation` in
   `shared/ebay-listing-progress.ts` show the actual saved phase, retry eligibility,
   content verification and stock evidence separately. Queued/running/completed
   jobs do not display an older attempt's error as the current blocker. Status
   polling continues while stock reconciliation remains attached to a completed
   listing update. A stock-status read failure degrades that status rather than
   failing the listing feed.

### Validation

- Channel/inventory unit selection: **271 files, 4,491 tests passed**. This includes
  the automatic recovery and reconciliation contracts, quantity readback,
  composition, bounded retries and optional-status failure handling.
- Real PostgreSQL suites:
  - `ebay-automatic-sync-recovery.integration.test.ts`: **10 passed**. Lost response;
    recovery receipt rollback; restart; concurrent stock writer and repeated Sync;
    late old stock and photo writes after completion; crash after durable enqueue;
    independent item-only and offer-only quantity drift; automatic scheduled pickup
    of an existing awaiting-evidence request without another command. Completion asserts current
    title, photos, exact price, offer/listing identity and canonical quantity.
  - `ebay-publication-readiness.integration.test.ts`: **26 passed**, including already
    current pictures and a crash before preparation of a retained inactive member.
  - `ebay-automatic-publication-recovery.integration.test.ts`: **20 passed**,
    including immutable receipts, exact no-request outbox evidence, locks,
    concurrent recovery, lease expiry, mapping retirement, inconsistent readback,
    later variant additions, another lost response after membership changes, and
    conservative status across multiple watches. Changed SKUs cannot redirect an
    old watch; that path performs no provider read or content handoff.
  - `ebay-listing-sync-recovery.integration.test.ts`: **31 passed**, including durable
    coalescing, ownership and clearing obsolete errors only for a new queued revision.
  - Seven related publication suites: **45 passed**. The terminal-response and
    explicit operator-recovery suites were then rerun with the new transition
    migration installed: **16 passed**, preserving their existing protections.
- Desktop/mobile eBay browser selection: **152 passed**, covering recovery, listing
  intent, mapping review, publication and photos. Follow-up focused checks cover
  the final recovery copy and delayed-stock status. Final actual timeout/lost-response
  cases: **8 passed**, with **143 passing** shared presenter/resolver unit cases.
- Application, server-test and client-test TypeScript checks passed.
- Writer/CI-shard guards: **82 passed**. Migration allocation/collision/runner
  guards: **63 passed**. `check-migrations.mjs --base origin/main` validates all
  519 migration names. `git diff --check` passes.

Both new PostgreSQL suites are included in `scripts/ci/postgres-test-manifest.ts`
and its coverage guard. The writer baseline adds only the four new tables owned
by inventory planning.

## Migration and operational limits

- Migration `900000008000018120001_ebay_automatic_sync_recovery.sql` adds the durable
  recovery, watch, observation and cycle records and extends the attempt transition
  guard without removing the existing response/operator/cutover receipt checks.
- Migration `900000009000018120002_inventory_publication_quantity_consistency.sql`
  adds nullable consistency evidence to existing publication readbacks. Historical
  NULLs remain unknown; the migration does not invent historical observations. Its
  allocated SQL is byte-identical to the tested candidate (SHA256
  `baba972161f59ea33b30273fcde7a46df6d85226401f12da3e4577fef45ca7f0`).
- Automatic replacement is restricted to verified existing-listing Sync and the
  supported synchronous item/group/offer replacement or absolute-quantity request
  operations. Unknown creation, publication or deletion does not gain a blind retry.
- Existing permissions, connection selection, canonical inventory authority,
  global pause, cooldown and publisher locks remain in force. Reconciliation runs
  through the existing inventory worker lifecycle and honors its disable setting.
- Late remote writes can temporarily overwrite newer content or quantities. The
  durable recurring check restores current values; it cannot make eBay's request
  ordering atomic or prove how an old lost response ended. There is no invented
  timeout after which that historical uncertainty is discarded.
- CI, merge, deployment, migration application and production acceptance are
  separate evidence. The local results above establish none of those release states.
