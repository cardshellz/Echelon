# Inventory cutover integrated test handoff — September 8, 2026

## PR publication validation

The user subsequently requested publication of this integrated batch. The isolated branch was safely fast-forwarded to `7042cde26707f8faaae87f5b75ce2ad3cec44580` after checking that the 13 incoming files did not overlap this 149-file batch. Migrations 233–237 remain unoccupied on that refreshed base.

Fresh publication checks: **11,111 unit tests passed, 0 failed, 37 skipped across 978 files; typecheck and production build passed.** Report: `C:/Users/owner/AppData/Local/Temp/echelon-cutover-pr-unit-20260908.json`. Staged-file validation also removed nine extra blank lines at EOF without changing code behavior. The 382 PostgreSQL results below were obtained during implementation, not rerun during this publication-only step. Remote CI is not presumed successful; inspect the new PR's checks. No production activation or deployment is authorized by creating the PR.

## Local implementation record — before PR publication

**Implemented and locally validated as one integrated batch, ready for review and controlled staging testing.** This report supersedes the unfinished September 7 and earlier September 8 snapshots. No production database, inventory, recipe, channel setting, provider quantity, or runtime authority was changed. No commit, push, PR, deployment, or live provider request was performed.

- Worktree: `C:/Users/owner/Echelon/worktrees/inventory-cutover-final-batch`.
- Branch: `codex/inventory-cutover-final-batch`.
- Refreshed base: `099c6402c3f5f7bd0b13b56c215d631478546b1f`.
- New migrations: **233–237**, in repository migration-runner order. Upstream owns 232; historical migration prefixes are unchanged.
- The original checkout's ten unrelated catalog/UOM edits are not part of this worktree or batch.

## What the code definitely does

Paths in this document are relative to this worktree. Named functions and tests are the authoritative navigation points; this is local code evidence, not a statement about deployed behavior.

| Completed behavior | Exact code / proof |
| --- | --- |
| Reconstruct existing order ownership without subtracting already-picked units twice; plan uncovered demand cumulatively against shared supply. | `server/modules/inventory-planning/domain/inventory-cutover-reconstruction-planning.ts:14`, `planFreshCutoverClaims`; `server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts:3998`, `persistReconstructedCutoverClaim`; `server/modules/inventory-planning/__tests__/integration/inventory-cutover-reconstruction.integration.test.ts:115`. |
| Preserve canonical zero-on-hand-delta shipment evidence, legacy shipment compatibility, operational replacement dispatch, and partial-pick/unpick lineage. | `migrations/234_inventory_canonical_shipment_compatibility.sql`; `server/modules/inventory/infrastructure/operational-shipment-dispatch.repository.ts:33`, `dispatch`; `server/modules/inventory-planning/infrastructure/inventory-availability-dispatch-publication.ts:12`, `publishOperationalShipmentInsideTransaction`; actual PostgreSQL compatibility suites in CI. |
| Fence operational/configuration writers during the final transaction, while preparation holds a durable configuration freeze. | `migrations/236_inventory_cutover_admission.sql`; `server/modules/inventory-planning/domain/inventory-cutover-admission-fence.ts:27` and `:63`, table manifests; `server/modules/inventory-planning/infrastructure/inventory-cutover-admission-fence.repository.ts:23`, `acquireInventoryCutoverFenceInsideTransaction`. |
| Suppress channel quantity writes durably; admit intentional conservative/full outbox work; retain exact destination/SKU catch-up; journal uncertain provider outcomes. | `migrations/237_inventory_quantity_publication_admission.sql`; `server/modules/inventory-planning/infrastructure/quantity-publication-admission.repository.ts:142`, `PostgresQuantityPublicationAdmission`; real `server/modules/inventory-planning/__tests__/integration/quantity-publication-admission.integration.test.ts`. |
| Route known Shopify, eBay, Dropship, listing-maintenance, and standalone live-sync quantity writes through shared admission. Require fresh exact canonical plan membership instead of reusing a stale outbox quantity for an omitted/ineligible SKU. | `server/modules/inventory-planning/infrastructure/quantity-publication-runtime.ts:41`, `planCurrentCanonicalListingQuantity`; `server/modules/channels/quantity-publication-request.ts:54`, `executeAdmittedEbayQuantityRequest`; `server/modules/channels/__tests__/unit/quantity-publication-request.audit.test.ts`; adapter factories and the three live-sync scripts inject the shared admission owner. |
| Bound HTTP request lifetime and existing Retry-After delays; an aborted local request remains an uncertain remote outcome. | `server/modules/channels/provider-request-limits.ts:2`, `PROVIDER_REQUEST_TIMEOUT_MS`, and `:11`, `createProviderRequestDeadline`; `server/modules/channels/__tests__/unit/quantity-provider-request-limits.test.ts`; real PostgreSQL timeout/admission cleanup case. |
| Require exact reviewed inventory/configuration/publication evidence before authority changes. Replace the temporary unconditional engineering blocker with actual readiness checks. | `server/modules/inventory-planning/infrastructure/inventory-cutover-review.repository.ts:16`, `captureInventoryCutoverReviewInsideTransaction`; `server/modules/inventory-planning/infrastructure/inventory-cutover-commit.repository.ts:24`, `commit`. |
| Serialize identical commit/finish retries before reading immutable receipts. Stale evidence, failed writes, and rollback do not partially activate the model. | `server/modules/inventory-planning/infrastructure/inventory-cutover-commit.repository.ts:163`, `lockInventoryCutoverCommandInsideTransaction`; `server/modules/inventory-planning/infrastructure/inventory-cutover-completion.repository.ts:30`, `finish`; `migrations/235_inventory_cutover_commit_evidence.sql`; actual concurrent composition tests. |
| Keep non-Echelon-controlled targets unchanged. Verify the latest full canonical publication before unlocking configuration; new demand can invalidate older publication proof. | `server/modules/inventory-planning/infrastructure/inventory-cutover-commit.repository.ts:24`, `commit`; `server/modules/inventory-planning/infrastructure/inventory-cutover-completion.repository.ts:87`, `captureInventoryCutoverVerificationInsideTransaction`; `server/modules/inventory-planning/domain/inventory-cutover-full-publication-proof.ts`; real composition suite. |
| Provide permission-gated final review, explicit authority-switch confirmation, full-publication verification, finish, and advanced uncertain-outcome recovery in Supply Transformations. | `client/src/pages/SupplyTransformations.tsx:1093`, `InventoryCutoverControls`, and `:1108`, `InventoryPublicationRecoveryPanel`; `client/src/pages/inventory-cutover-http.ts`; recovery routes registered in `server/routes.ts:155`. |
| Keep exact idempotency requests after uncertain HTTP/proxy/network outcomes; allow paginated inspection without truncating server evidence. Recovery records human attestation, not fabricated provider verification. | `client/src/pages/inventory-cutover-http.ts:24`, `isDefinitiveCutoverRejection`; `client/src/pages/inventory-cutover-controls.tsx:21`, `InventoryCutoverControls`, and `:128`, `EvidencePage`; `client/src/pages/inventory-publication-recovery-panel.tsx:14`, `InventoryPublicationRecoveryPanel`; three `client/src/pages/__tests__/unit/inventory-*.test.ts` suites. |
| Rebuild suppressed work from current authority, not saved quantities. Start bounded, nonoverlapping catch-up under the existing publication-worker scheduler gate. | `server/services/index.ts:387`, `createQuantityPublicationCatchupService` composition; `server/index.ts:835`, worker startup; `server/modules/inventory-planning/application/quantity-publication-catchup.worker.ts:11`, `startQuantityPublicationCatchupWorker`; Dropship current-preview callback tests. |

### Concrete end-to-end evidence

The real PostgreSQL composition test exercises prepare → conservative publication/readback → final review → commit → full publication/readback → verify → finish, with actual snapshots, reconstruction, owner services, migrations, fences, and receipts. Owner behavior is not mocked: every owner receives the disposable pool/client. External provider transport is mocked, and the unused process-global database import is disabled to prevent accidental application-database access. Schema prerequisites are controlled test fixtures, not a full production clone. The test also proves a zero-publication catalog does not need invented provider evidence and an external-controlled target remains unchanged.

During the same canonical run, accepting another one-unit order changes the current quantity **14 → 13**. The old 14 publication/readback cannot finish the cutover; the latest 13 proof can. The immutable original commit manifest is preserved. Concurrent identical commit and finish requests each produce one original result and one replay. Evidence: `server/modules/inventory-planning/__tests__/integration/inventory-cutover-composition.integration.test.ts:353`; exact current listing and forged/expired/superseded lease checks begin at `:410`.

Actual reconstruction-to-picker testing preserves the two units already picked on a six-unit line, then moves only the four remaining units: on-hand **20 → 16**, reserved **4 → 0**, picked custody **2 → 6**. Retry does not debit again. Replacement-dispatch testing proves stock, dispatch evidence, and desired channel quantity commit or roll back together.

The new-order test exposed and now covers a real policy-lock query defect: `promise_safety_policy_heads` has no `product_variant_id`. `lockPlanningPolicyHeads` in `server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts:829` now joins the active immutable policy version by ID and scope and locks relevant heads in deterministic scope order, matching the actual policy schema.

## Validation record

The following passed **after the product-code freeze and final fixture corrections**:

| Check | Final result |
| --- | --- |
| `npx vitest run unit --maxWorkers=4` | **11,047 passed, 0 failed, 37 skipped; 977 test files.** |
| The 23 files in CI's `Inventory availability foundation PostgreSQL guarantees` step, using `npx vitest run --no-file-parallelism` | **382 passed, 0 failed, 0 skipped.** Includes the 16 real composition cases and 10 publication-admission cases. |
| `npm run check` | Passed; no TypeScript diagnostics. |
| `npm run build` | Passed; client and server artifacts built. Existing oversized-bundle warning remains. |
| Writer-ratchet and migration-prefix guards, explicitly rerun | **4 passed** across 2 files. Baseline diff is exactly 30 insertions and 0 deletions for the 10 intended table-owner registrations; no blanket regeneration. |
| `git -c core.safecrlf=false diff --check` | Passed. |

Machine-readable final reports are retained locally as `C:/Users/owner/AppData/Local/Temp/echelon-cutover-frozen-unit-20260908.json` and `C:/Users/owner/AppData/Local/Temp/echelon-cutover-frozen-pg-20260908.json`. The unit report's 37 skipped cases are not counted as passed. Existing Vitest warnings about nested procurement mocks are unchanged. Focused timeout, protocol, UI/retry, recovery and policy-lock regression tests are included in the full unit count, not added twice.

Earlier failing runs identified the policy-lock defect and outdated HTTP fixtures; the final result above is a new full rerun, not a sum of selective reruns. **Remote CI has not run for this uncommitted batch.** The broader unrelated finance/procurement PostgreSQL jobs were not run locally.

All PostgreSQL runs use an explicitly owned local disposable PostgreSQL 17 cluster on `127.0.0.1:55487`. Both `ECHELON_TEST_DATABASE_URL` and `ECHELON_TEST_DATABASE_DISPOSABLE=true` are required. No production environment file or connection was used. The inventory CI step now includes the new fence, reconstruction, full composition, and publication-admission suites.

After validation, the exact data directory and port were checked, PostgreSQL reported no other client backends, and the owned test cluster was stopped successfully. Its data directory and test reports are retained; no unrelated process or data was removed.

## How to test this as one batch

These are review/test instructions, **not authorization to perform production actions**.

1. Review and build this single branch with migrations 233–237. Use a disposable environment with test channel credentials/provider fakes; never point a local test run at production inventory or provider accounts.
2. In Supply Transformations, review the complete physical catalog, conversion/build definitions, safety policies, warehouse/source bindings, and per-SKU/channel exposure. Existing dry-run blockers remain actionable; the UI does not silently skip malformed inventory or ambiguous legacy ownership.
3. As an operator with the existing inventory-activation capability, run the dry-run and prepare workflow. Inspect conservative publication/readback status, then **Capture final review**. Confirm reconstructed order counts and proposed channel quantities.
4. Attempt a stale review, duplicate request, and uncertain response. Changed evidence must be rejected; an uncertain response must retain the exact original retry request. No duplicate inventory movement or receipt is acceptable.
5. Apply the reviewed switch in the test environment. Exercise a partially picked order, new order/reservation, release/unpick, assembly handoff, and shipment. Inspect both physical stock and canonical ownership; do not equate label printing with a second stock debit.
6. Wait for the latest full publication/readback, then **Check full publication** and **Finish and unlock configuration**. Add new demand before finish to verify older quantities cannot be accepted as current proof.
7. In a separate prepared legacy-authority test run, suppress a quantity update and abort. The response must report queued catch-up, not pretend provider quantities are already restored. Confirm current inventory is replanned. Unknown provider outcomes stay visible until supported by explicit recovery evidence.

## Assumptions, risks, and failure modes

- **No production-data assumption:** the tests prove behavior on actual schemas and controlled fixtures, not that the current live catalog, order custody, or provider configuration is clean. Ambiguous ownership, unsupported history, missing mappings, or incomplete models remain blocking evidence requiring review.
- **Provider boundary:** external HTTP is mocked in automated tests. Repository-owned paths can be covered; unrelated integrations or a person editing provider inventory directly are outside this admission mechanism. Actual provider credentials, throttling, response variants, and remote readback need a controlled staging test.
- **Uncertain writes fail closed:** a process loss or local acknowledgement failure after a provider request retains unresolved evidence. Time passing or a low quantity readback does not prove an old request cannot still complete. Advanced recovery requires an authorized operator, reason, and terminal-request evidence.
- **Catch-up is durable but asynchronous:** abort/finish does not mean all remote quantities have already changed. A disabled publication worker, provider outage, unresolved identity, or uncertain prior attempt keeps pending work visible instead of acknowledging skipped callbacks.
- **Operational fence:** migration 236 covers the reviewed 77-table manifest. Lock contention is bounded; busy or changed state causes retry/review instead of a partial authority change. The migration and code must ship together.
- **No automatic legacy rollback after commit:** finish releases configuration only after current canonical proof. It does not switch reservations or ATP back to legacy. The UI distinguishes aborting preparation from completing a canonical cutover.
- **No new package-content editing workflow:** shipment compatibility and ownership reconstruction are inventory correctness work. This batch does not authorize rewriting customer orders, recipes, package contents, or production shipment history.

## What is likely happening / not proven / next checks

**HYPOTHESIS only:** the previously documented independent channel/listing writers could have caused stale quantity publication in a deployed system. No production incident or current enablement was investigated here; this batch closes the demonstrated repository paths without attributing a live failure.

Remote CI, live-data dry-run, actual provider integration, and a physical picker/assembly-station walkthrough remain unproven until performed in their appropriate environments. UI tests exercise component handlers and rendering contracts, not a live browser-layout walkthrough. Next action is review of this integrated branch and an explicitly authorized PR/deployment workflow; production activation remains a separate deliberate operator action. No known local implementation or validation blocker remains in this batch.
