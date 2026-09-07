# Procurement release manifest

The coordinated local candidate is implemented and tested. Three ordered release branches separate the compatible schema foundation, the complete financial/physical runtime, and the planning/lifecycle experience. Their combined tree is checked against the integration candidate before publication. This manifest does not claim deployment, production reconciliation or external integration delivery.

## Ordered releases

| Order | Branch / prerequisite | Contents | Migrations |
| --- | --- | --- | --- |
| Existing prerequisite | PR [#1391](https://github.com/cardshellz/Echelon/pull/1391), `codex/procurement-cost-application`, head `6f033fe613ce21fed715a4bcd83ced437fdc0065` | Preserve invoice totals during metadata edits. The PR was still open when checked during packaging; both configured CI jobs succeeded on this exact head. | Existing release contents |
| 1 | `codex/procurement-01-cost-foundation`, commit `414b4de3`, based on #1391 | Strict cost/source contracts and immutable evidence storage. Existing runtime remains compatible with the additive schema. | 222 |
| 2 | `codex/procurement-02-cost-runtime`, commit `74fb5dab`, based on release1 | Complete receipt/transfer/transformation lineage and component application; COGS/report evidence; invoice review; cost workspace/recovery; current approval authority and history retention. | 227; retains unchanged222 |
| 3 | `codex/procurement-03-planning-lifecycle`, based on release2 | Planning policy and dated supply, growth/replacement forecasts, basket constraints, exact RFQ quote-to-PO handoff and reverse navigation, current quantity-rule review, production/inbound value/arrival dashboard, supplier reports and truthful settings. | 223,224,225,226; retains222/227 |

The exact full release hashes and proposed PR bodies are captured in the accompanying local publication package. Resolve the release3 branch head when publishing rather than treating the integration branch's intermediate commits as a deployment order. No new branch was pushed or PR created during packaging because automatic approval review requires explicit authorization for the exact public destination and changes.

## Verification

| Candidate | Verified locally |
| --- | --- |
| Release1 | 8,770 unit tests; full TypeScript; five actual PostgreSQL foundation tests. One file /37 tests intentionally skipped. |
| Release2 | 8,947 unit tests; TypeScript; client/server production build; 209 distinct affected PostgreSQL tests;26 desktop/mobile cost-workspace and invoice-review cases. One file /37 unit tests intentionally skipped. |
| Complete candidate / release3 contents | 9,165 unit and client-math tests across905 passing files; TypeScript; client/server production build;439 real PostgreSQL tests across all26 configured database CI steps;154 desktop/mobile browser cases. One file /37 unit tests intentionally skipped. |

The final database run follows the actual CI step order on a fresh, explicitly disposable local PostgreSQL17 database. A pipeline fixture originally required a developer-specific database name; it was corrected to use the same explicit disposable/local boundary and exclusive schema lease as the other procurement fixtures, then its step and all remaining steps passed. The final TypeScript check includes that test-only correction. No production database was accessed by these proofs.

Browser tests run the actual frontend and intercept all APIs with fictional fixtures, including mutations. They prove controls, validation, navigation, retry identity and rendering; they do not prove production connectivity. Desktop pipeline and mobile supplier-history screenshots were inspected. Build output includes existing chunk-size warnings; no build errors occurred.

GitHub's configured environment uses Linux, Node20 and PostgreSQL16. Local checks used Windows, Node22, PostgreSQL17 and installed Chrome. Required remote checks must succeed on the exact published release heads. Local proof does not replace that gate.

## Deployment and verification procedure

1. Publish the prepared draft PRs to `cardshellz/Echelon` with the dependencies above. Review each incremental diff against its immediate predecessor. After a predecessor is merged, retarget/rebase its dependants onto the reviewed main commit while preserving their scoped changes; rerun checks on the resulting heads. Do not deploy all branches simultaneously.
2. Deploy the existing prerequisite, then release1. `Procfile` runs `scripts/release.sh`, which invokes `migrations/run-migrations.ts:runMigrations`; the runner locks migrations and records each filename. Confirm release success and migration222, then verify an existing purchase and invoice still open. This step alone does not activate new physical/cost writers.
3. Deploy release2, including227 and the complete writer/application set. New runtime owners become active with this application release; there is no separate feature flag that permits deploying only some physical writers. Keep current roles/settings as configured. Verify a representative receipt's physical state, cost request, source revisions, applications and lot/COGS evidence. Review an invoice whose product and packaging evidence are known; unknown components must remain visibly unresolved. Check a controlled approval and a no-required-approval solo flow with the intended operator capabilities.
4. Deploy release3. The runner applies all pending223–226 filenames even though227 is already recorded; it uses individual filenames, not a numeric high-water mark. Migration223 initializes neutral planning policy and does not infer real growth/stock targets;226 initializes no supplier reports. Inspect planning, a quoted RFQ, its draft PO, a split/consolidated purchase and the inbound dashboard. Check that physical receipts have left the pipeline before any pending cost retry completes.
5. Configure real demand windows, targets, essential items, supplier lead stages, MOQ/multiples and basket economics through the operator controls. Review a representative imported and domestic recommendation against known inputs before using unattended daily drafting. No schedule, live policy, member guarantee or vendor send was activated during development.

Schema tests apply the affected real migrations against explicit owner fixtures. They do not rehearse every historical migration against a copy of the production schema or establish production index-build duration. Preserve all historical rows and migration files; do not rewrite an already applied migration to repair data.

## Recovery and rollback limits

- Release1's schema is additive. Retain it when reverting compatible application code. Old records retain missing evidence, and no historical backfill needs reversing.
- **Release2 is the minimum compatible inventory-writer version once new physical work begins.** New receipt/transfer/build/assembly/picker owners record contribution edges consumed by cost applications. Older writers omit them. Keep compatible writers, or pause affected physical operations during recovery and correct forward; retaining tables alone is insufficient. Retain227's history guards.
- A failed financial transaction rolls back component, COGS, application and audit/report writes together. A physically closed receipt is separate and remains recorded; its durable cost request can be retried through the permission-gated command. Do not retry physical receipt to fix a cost-only failure.
- Reverting release3 to release2 stops using new planning/RFQ/pipeline features but retains their histories and records. Preserve the planning-aware forecast readers when inspecting newer capture versions. A neutral policy can be saved through the audited command when appropriate; do not delete or relabel historical forecasts.
- Code rollback never reverses committed inventory, invoice, payment, COGS or historical corrections. Such corrections need their own reviewed source evidence and owning transaction.

## Explicit follow-on boundaries

The [acceptance ledger](procurement-integrated-acceptance.md) lists the code paths, proof, assumptions and remaining work. Carrier feeds and Archon delivery/posting require actual external contracts/access. Quantity-tier schedules and automatic ranked supplier substitution remain unsupported; an exact manually quoted discount is supported. Historic missing lineage/unit evidence, FX/credits/ambiguous adjustments, manual protection release and production forecast/data reconciliation require explicit review. There is no new background receipt-cost retry worker, and production load/lock contention has not been benchmarked.

These are visible limits of the delivered candidate, not promises inferred from passing synthetic tests.
