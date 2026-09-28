# Pre-cutover publication scope correction

## Current approved correction: ATP handoff, bundle scope and external ownership

Prepared for PR from refreshed main `1c684e79a` on
`codex/cutover-publication-scope`; no production command,
channel quantity write, deployment, or final cutover has been performed.
PR #1579 used migration 0713 before this branch was published. This branch's
undeployed migration and fixture reference were renumbered to **0714**; no
deployed migration was renamed or modified.

The owner identified these two offers as unsupported bundles and authorized
skipping them. This is an explicit owner decision, not an inference from an API
error or a product name:

| Exact intended scope | Product / variant | SKU | eBay offer |
| --- | --- | --- | --- |
| Direct eBay, target 3 / channel 67 in the September 28 evidence | 191 / 406, Armalope Toploader 100CT Bundle | SHOPIFY-62448810885279 | 136411431011 |
| Same destination | 194 / 409, BUNDLE: 200CT Armalope + Semi-Rigid + Easy-Glide Soft Sleeve | SHOPIFY-62610189877407 | 136412110011 |

Do not copy that historical target revision into a production command without
reading its current identity. Other channels, bundles and listings are not
implicitly excluded. No catalog tracking flag or physical balance is changed.

Implemented locally:

- `reviewInitialPublicationScope` now accepts explicit `excludedVariants` with
  reason `unsupported_bundle`. The current destination listing census must
  contain each selected catalog variant. The review hash includes the exact
  decisions; unresolved listing outcomes and quarantine still block.
- `PostgresInitialPublicationScopeStore.prepare` writes excluded membership as
  `included=false`, together with its immutable receipt and before/after audit.
  Migration 0714 validates both included and excluded heads at commit. Missing
  exclusion rows roll back the entire operation. The destination stays preview.
- Admin `preview` returns identity-only evidence for external/manual ownership;
  it does not require Echelon policy, source binding or SKU mapping. Dry-run
  output contains no quantity proposals for those destinations. Target identity
  and membership are still sealed and checked before activation.
- Explicit bundle exclusions are distinct from accidentally missing membership.
  The dry run honors the former and continues blocking the latter for active
  legacy publications. The supply graph is not pruned.
- `PostgresInventoryPublicationReadbackRepository.loadTargets` follows explicit
  membership too. An excluded bundle is not queried and does not manufacture a
  missing-readback failure; included SKUs retain the existing verification path.

Relevant source: `shared/types/inventory-publication-initial-scope.ts`,
`domain/inventory-publication-initial-scope.ts`,
`infrastructure/inventory-publication-initial-scope.repository.ts`,
`infrastructure/inventory-channel-exposure-admin.repository.ts`,
`application/inventory-availability-activation-dry-run.service.ts`, and
`infrastructure/inventory-availability-activation.repository.ts`. Short paths
are under `server/modules/inventory-planning/`.

### Approved ATP quantity correction

The owner explicitly approved the code-only change to send Echelon ATP even
when it increases an existing Shopify/eBay quantity, retaining verification
afterward. The earlier safety-review rejection was not bypassed: implementation
resumed only after that explicit approval. This is not approval to execute it
against production. **STOP BEFORE FINAL CUTOVER remains in force.**

The initial absolute quantity is now the current post-reconstruction ATP after
the selected channel controls. It is not `min(provider stock, Echelon ATP)` and
does not fall back to an older dry-run quantity. Historical acknowledgements
and observations remain comparison evidence, not prerequisites for this first
send. Missing current mappings, changed ownership, quarantine and unresolved
provider sends remain errors; none is hidden by this correction.

Example covered by the real-database composition test: 20 physical packages
less six reconstructed outstanding obligations produces a planned quantity of
14. Old provider quantities of 20, 3, zero, or an unusable negative observation
all lead to the same queued quantity: 14. The negative-provider scenario has no
stored successful readback; it does not pretend that negative stock was zero.

The persisted phase name `conservative` is retained for existing database/API
compatibility. It now names the pre-switch handoff, not a cap by old provider
stock. No second ATP engine, new allocation formula or UI was introduced.

| Confirmed behavior | Exact source and function | Evidence / reasoning |
| --- | --- | --- |
| The prepared quantity comes from current reconstructed ATP and selected channel controls. | `infrastructure/inventory-availability-activation.repository.ts`, `PostgresInventoryAvailabilityActivationRepository.prepare`, lines 82-105; `publicationIntents`, lines 693-740. | Fresh projection is required for every exact target/SKU; no prior readback query or old-quantity cap remains. Missing coverage, non-whole/negative quantities and provider-unsafe quantities fail. |
| Old observations do not block an initial send; current identity still does. | `application/inventory-availability-activation-dry-run.service.ts`, `legacyPublicationCoverageBlockers`, line 565; `targetPublicationBlockers`, line 647; contract version at line 33. | The v7 readiness contract removes historical quantity prerequisites but preserves exact target/mapping, ownership and configuration-drift checks. |
| The provider must receive and then return the submitted quantity. | `application/inventory-publication-outbox.service.ts`, `publishAndVerify`, line 91; `infrastructure/inventory-publication-outbox.repository.ts`, `recordVerified`, line 190. | The absolute send precedes readback. Invalid acknowledgement/readback fails; a differing valid quantity is recorded as drift and retried, not verified. |
| Unverified sends cannot switch authority. | `infrastructure/inventory-cutover-review.repository.ts`, `captureInventoryCutoverReviewInsideTransaction`, lines 19-51; `domain/inventory-cutover-publication-proof.ts`, `validateInventoryCutoverPublicationProof`, line 64. | Commit review still requires `publication_verified`, exact destination identity, fresh post-send evidence, no unresolved send, and exposure no greater than the fresh ATP plan. |
| Existing adapters support replacing lower stock; the tests make no external calls. | `server/modules/channels/__tests__/unit/channel-inventory-provider-readback.test.ts`, eBay case at line 48 and Shopify cases at line 84. | Actual adapters with mocked HTTP send eBay 14 over old zero; Shopify sends 0 or 14 over old -18 without a preliminary quantity read, then reads back the new value. |
| Retry, rollback and the complete handoff work with or without old observations. | `__tests__/integration/inventory-cutover-composition.integration.test.ts`, parameterized composition at line 462 and failed-verification case at line 514. | Disposable PostgreSQL runs actual preparation, outbox, authority/ledger owners, commit and completion. A mismatched readback blocks commit; exact retry proceeds. No live provider or production database is used. |

Paths in the table are under `server/modules/inventory-planning/` unless they
already start with `server/`. References describe this local patch, not a
deployed version.

Follow-up validation (2,291 unit/guard cases in the final combined 146-file run):

- 2,171 unit/guard tests passed across 142 files (inventory-planning units plus
  migration-prefix, writer-ownership and PostgreSQL-manifest guards).
- All 30 database suites passed in one run: 578 cases, none skipped. This includes
  all 27 inventory-planning suites and three quantity-ledger/encumbrance suites.
  The expanded end-to-end composition suite accounts for 45 of those cases.
- Another 120 unit cases passed across four files: actual Shopify/eBay adapters,
  provider transport and the existing Windows line-ending migration assertion.
- Application TypeScript and both server/client test TypeScript projects passed
  again after the final adapter regressions and upstream refresh. `git diff
  --check` passed. The exact loopback-only disposable PostgreSQL cluster was
  stopped after the tests; no test database was production-connected.
- No new full-repository unit run, browser run, CI, deployment or production
  readiness is claimed. No UI was changed. Earlier full-suite limitations below
  remain historical rather than being declared resolved by these focused tests.

Assumptions and remaining checks: no additional bundle eligibility was inferred.
The owner's two explicit exclusions must be prepared against the current exact
eBay destination, only after a separately approved production preview. Live
Shopify/eBay acceptance, deployment, fresh catalog/demand readiness and final
cutover are not proven by these tests. Actual mapping/quarantine failures or
provider write/readback failures must still be resolved, not silently skipped.
When eventually approved and executed, this change can increase published stock;
that is the intended ATP behavior, not a promise that an old channel cap remains.

## Historical implementation report before this follow-up

## Status and boundary

The owner instructed: **continue, but stop before final cutover**. This patch is
local implementation and validation, not activation or a claim of cutover readiness.
The owner's subsequent **"fine"** approved building the audited initial-scope
preparation path. That path is now implemented locally, including migration
`0714_inventory_initial_publication_scope.sql`. It has **not** been executed in
production. Applying the migration only creates guards/evidence storage; it does
not change any existing destination's membership or activate publishing.

No production connection, inventory adjustment, configuration write, provider
call, listing operation, deployment, or final cutover was performed in this turn.

Base: refreshed and fast-forwarded `origin/main` at
`c2529d0d38beb1828e511b9b3e94d3b790d0bfbd`.
Branch: `codex/cutover-publication-scope`. Work is isolated from the unrelated
catalog edits in the primary checkout.

## What the code definitely does

| Conclusion | Exact code evidence | Reasoning |
| --- | --- | --- |
| Preview and runtime use one outbound SKU selector. | `server/modules/inventory-planning/domain/inventory-publication-scope.ts`, `selectPublicationVariants`, line 4; runtime `planTarget` in `application/inventory-channel-exposure-runtime.service.ts`, line 256; admin `PostgresInventoryChannelExposureAdminStore.preview` in `infrastructure/inventory-channel-exposure-admin.repository.ts`, lines 1074 and 1120. | Whole-product scope keeps all eligible output SKUs. Explicit scope selects only included identities and reports unavailable included identities. The supply snapshot is not filtered. |
| The dry run can distinguish an explicitly excluded, absent feed from a missing mapping for an included SKU. | `application/inventory-availability-activation-dry-run.service.ts`, `isProvenUnlistedPair`, line 521. | Exemption requires no feed, mapping state `missing`, at least one configured target, and explicit exclusion in every configured target's preview. Unknown, inactive, quarantined, whole-product, and included evidence still enters the existing checks. |
| Explicit scope cannot silently omit an active legacy publication. | Same application service, `InventoryAvailabilityActivationDryRunService.runDryRun`, `ACTIVE_LEGACY_PUBLICATION_EXCLUDED` check, line 338. | An active feed excluded from an enabled Echelon target blocks the review instead of disappearing from its output. |
| Empty destinations remain reviewed configuration, not omitted evidence. | Same application service, `publicationTargetSelections`, line 415; `domain/inventory-cutover-manifest.ts`, `buildInventoryCutoverManifest`, line 80. | A target's revision and membership are saved even when it has no publication rows; the target census still includes it. |
| A later membership change invalidates the captured review. | `infrastructure/inventory-availability-activation.repository.ts`, `configurationDigest`, line 454, and `assertDryRunSelectionsCurrent`, line 473. | Revalidation checks target revision, membership mode, exact included identities for the product, and allowed state. Target locks precede membership-head locks. An empty Echelon target still must be in preview. |
| Initial preparation is a separate, bounded command, not normal live membership editing. | `infrastructure/inventory-publication-initial-scope.repository.ts`, `PostgresInitialPublicationScopeStore.prepare`, line 21; `migrations/0714_inventory_initial_publication_scope.sql`, `guard_publication_membership_mode`, line 64. | Whole-product to explicit is allowed only for a pristine, Echelon-owned preview destination, under the real legacy-authority fence, with an immutable same-transaction receipt. Ordinary canonical/live membership behavior is unchanged. |
| The operator cannot choose a convenient subset or supply an actor in the body. | `shared/types/inventory-publication-initial-scope.ts`, `prepareInitialPublicationScopeSchema`, line 10; `interfaces/http/inventory-publication-initial-scope.routes.ts`, `registerInventoryPublicationInitialScopeRoutes`, line 6. | The strict request takes target/revision, reviewed hash and command key. Both endpoints require the existing activation permission; preparation uses the authenticated session actor. |
| Dropship membership is not inferred from an empty legacy table. | `infrastructure/inventory-publication-initial-scope.reader.ts`, `readInitialPublicationScopeFacts`, line 36, and `readRegisteredMembers`, line 106. | The reader also checks registered listing owners, account bindings and latest verification membership. Verified membership replaces historical publication membership. Unmatched legacy listing identities, pending publications and conflicting owners block preparation. |
| Only inventory-tracked listed identities are proposed. | `domain/inventory-publication-initial-scope.ts`, `reviewInitialPublicationScope`, line 36. | Uses existing `resolveInventoryTrackingPolicy` with product default, variant override and physical/shipping policy. Non-stock identities are reported separately. Current stock listings with quarantine, uncertainty, ineligibility or mismatched mappings remain blockers. |
| Preparation is atomic and retryable. | Repository `prepare`, lines 27-72; migration `0714_inventory_initial_publication_scope.sql`, `guard_initial_publication_scope_receipt`, line 25, and `assert_initial_publication_scope_complete`, line 87. | Exact request/actor replay is returned without a second write. Different requests cannot reuse the key. Missing membership or audit rolls the transaction back, including deferred-constraint failures. |

Paths abbreviated to application/domain/infrastructure above are relative to
`server/modules/inventory-planning/`.

## Preparation contract and execution trace

There is no new UI or automatic startup job. The two permission-gated endpoints
are below `/api/inventory-planning/admin/publication-initial-scope`:

1. `POST /review`: `{ publicationTargetId, expectedTargetRevision }`.
   A repeatable-read, read-only transaction returns the current target revision,
   authority revision, deterministic review hash, included inventory variant IDs,
   excluded non-stock IDs and blockers. It writes nothing.
2. `POST /prepare`: the same fields plus `expectedReviewHash` and
   `idempotencyKey`. No SKU override, reason text, caller-supplied actor, activation
   option or provider quantity is accepted.
3. Preparation locks the command key, checks an existing receipt, acquires the
   real cutover admission fence for **legacy / no open freeze**, then takes
   fail-fast SHARE locks on the listing/catalog/mapping predicates and locks the
   exact target. It re-reads the facts and recomputes the review before writing.
4. One transaction inserts an immutable receipt containing the evidence, changes
   this target's membership mode to explicit with revision +1, creates included
   membership versions/heads, and writes the actor/before/after audit event.
   The target stays in **preview**. A deferred database guard verifies complete
   membership and audit evidence at commit.

Changes, if separately executed: only the selected target's mode/revision and
normal update timestamp, its new membership versions/heads, its immutable
preparation receipt, one audit event, and the admission fence's coordination
metadata. No existing membership is overwritten: any prior versions/heads block
this one-time initializer.

Untouched: inventory balances/lots/journals/costs, orders, reservations/claims,
recipes, safety/exposure policies, source bindings, exact mappings, other targets,
runtime authority, cutover freezes, publication outbox and external systems.

The initial census supports the **existing Shopify and eBay listing owners**,
including eBay-backed Dropship. It does not pretend that another provider's empty
legacy feed is a complete census. New Walmart targets already start explicit and
continue using their existing membership workflow; an old whole-product Walmart
target or future adapter cannot use this initializer without implementing its
own census. Canada's external-provider target is rejected, not reclassified.

## What is likely happening

**HYPOTHESIS, not yet verified by a new production dry run:** applying a properly
reviewed initial listing scope will eliminate the false missing-mapping errors
caused by projecting every sellable SKU to every channel. Local database tests
prove the corrected selector behavior. They do not establish that all existing
production destinations have the right scope or that all remaining blockers clear.

## What is not proven or changed

- The approved initial commissioning path is built, but no production target has
  been prepared by it. A successful local fixture is not evidence that the
  production listing census, mappings or policy are currently complete.
- Canada/external-provider preview semantics are unchanged. The remaining
  requirements for Echelon policy, mapping, and source evidence have not been
  relaxed. This is still an outstanding part of the activation-path correction.
- The actual Shopify negative quantity and two unpublished eBay offers are not
  repaired by scope selection. `ShopifyAdapter.readInventory` at
  `server/modules/channels/adapters/shopify.adapter.ts:224` rejects an invalid or
  negative observation; `publishedOffer` at
  `server/modules/channels/adapters/ebay/ebay-inventory-quantity.ts:45` requires
  exactly one published offer. Neither adapter was changed to manufacture a
  successful readback. The exact production observations remain in the private
  operational evidence, not committed here.
- Empty `dropship_vendor_listings` alone does not prove an empty Dropship scope.
  `currentRegistrationStatusesSql` at
  `server/modules/marketplace-listings/infrastructure/pg-listing-registration.repository.ts:1285`
  also reads registered publication identities and the latest verification
  members. The new preparation reader includes those records; it has not been
  run against production in this turn. Neither reader queries the provider live.
- No complete new production activation dry run, PR, deployment, or final cutover
  is claimed by this report.

## Assumptions, risks, and failure modes

No assumption was made that unlisted means zero stock, that an unpublished eBay
offer should be relisted, that a negative Shopify quantity equals zero, or that
Canada should become Echelon-controlled.

The main risk is omitting a real listing while narrowing scope. The patch retains
legacy-feed validation, adds the active-feed exclusion blocker, preserves exact
target identity and provider readback checks, and invalidates stale membership.
The initializer now seals the local owner census and atomic, idempotent
receipt/selection updates. Listing registration/verification provenance is
hashed even for an empty selection. A direct target-mode update still fails.

SHARE predicate locks deliberately prevent new listing/catalog/mapping rows from
appearing between revalidation and commit. They are table-wide, not row-only.
The command fails fast if these tables are busy; it must not be scheduled as a
routine background task. Existing transaction timeouts and rollback/discard
behavior are reused (`inInventoryCutoverTransaction` in
`infrastructure/inventory-cutover-commit.repository.ts:167`).

This is a point-in-time preparation, not a promise that future listing activity
cannot change. Before final activation, current listing coverage and the actual
provider observations must be checked again. Do not reuse a preparation receipt
as authority to relist, zero a provider quantity or ignore later evidence.

Historical dry-run payloads may lack the new optional selection field. Existing
evidence remains readable. New captures use contract version
`membership_scoped_publication_readiness_v5` and include target selections. An old
blocked dry run is not made ready retroactively.

## Test coverage

- **2,197 tests passed across 146 focused unit/HTTP/guard files** on the final
  base, including all inventory-planning unit tests. The
  policy/HTTP coverage includes permission denial, authenticated actor,
  strict request validation, deterministic facts, stale revisions, non-stock
  policy, and refusal of unsupported providers. Source: the new
  `__tests__/unit/inventory-publication-initial-scope*.test.ts` files.
- **546 tests passed** across **30 actual PostgreSQL integration files**, using a new
  loopback-only disposable cluster and uniquely created per-suite databases.
  Includes all inventory-planning integration suites plus both quantity-ledger
  suites and the encumbrance suite. No selected database tests were skipped.
- The 26 initial-scope database cases cover actual migration/fence/append-only
  guards, no quantity/authority/outbox changes, concurrent retries and competing
  commands, stale mapping/feed/tracking/verification evidence, partial write
  rollback, audit omission, missing member heads, direct-update refusal,
  Canada-style external/manual ownership, actual open freeze/canonical authority,
  latest Dropship membership and a competing new listing insertion.
  Source: `__tests__/integration/inventory-publication-initial-scope.integration.test.ts`.
  Other owners' listing tables in that fixture are reduced named-schema query
  fixtures, not proof of their full write workflows or live provider data.
- Both new database suites are explicitly registered in the eight-shard CI manifest;
  the manifest guard preserves the previous suite inventory.
- The writer-ownership baseline and its guard now identify
  `inventory.publication_initial_scope_receipts` as owned only by
  `modules/inventory-planning`, including operational-script scanning.
- Main incorporated the Walmart database-clock test correction in PR #1575 while
  this work was running. That change is now part of the base, not duplicated or
  claimed as this patch's implementation.
- Main subsequently introduced `0712_dropship_cost_change_notices.sql` in
  PR #1578. Only this patch's undeployed migration was renamed to `0713`;
  the collision guard passed on the combined tree. Recheck numbering before
  publication if another migration merges first.
- The broader unit run on base `84b6430b1` ended with **16,616 passed, six failed,
  39 skipped**. All six failures were `fetch failed / bad port` in three
  unmodified Procurement HTTP suites (`cost-reporting.routes`,
  `inbound-shipment.routes`, `rfq-workflow.routes`); all 27 tests in those suites
  passed in the final focused rerun. Do not describe the full suite as green.
  The new initial-scope HTTP suite uses native HTTP to avoid this port issue.
- The broad run also identified a pre-existing Windows CRLF-versus-LF assertion
  in `dropship-cost-schedule-migration.test.ts`. The only unrelated test edit
  normalizes line endings before its unchanged SQL assertions; neither migration
  `0711` nor Dropship business behavior was modified by this patch.
- Application TypeScript and both test TypeScript projects passed on the final
  base: `tsc --noEmit`, `tsc -p tsconfig.tests.server.json`, and
  `tsc -p tsconfig.tests.client.json`. `git diff --check` passed. The owned local
  PostgreSQL cluster was stopped after the final database rerun.
- No CI run or production behavior is inferred from local results.

## Next checks, in order

1. Review/merge/deploy this code before attempting the new preparation command.
   Building it was approved; production execution and final cutover were not.
2. Verify current listing-owner membership with the read-only review, including
   Dropship registrations, and resolve the separate external-provider preview
   semantics. Only use the audited prepare owner for an approved current review.
3. Review the actual negative/unpublished/quarantined/missing-identity provider
   exceptions without silently zeroing or relisting them.
4. Integrate and validate the remaining correction, then review a fresh full
   activation preview. Do not reuse the earlier blocked run as approval.
5. **Stop. Final cutover and quantity publication require new owner direction.**
