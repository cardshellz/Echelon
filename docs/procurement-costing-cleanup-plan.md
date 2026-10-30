# Purchase costing cleanup plan and tracker

This is the active tracker for consolidating purchase costing from PO through shipment, receiving, inventory and verified sales. Every implementation change, test result, PR and deployment verification for this cleanup belongs here. The linked audit preserves the evidence behind the work.

| Tracking field | Current value |
| --- | --- |
| Created | 2026-10-30 |
| Overall state | S1 foundation merged; deployment reported by the user. First S2 source-compatibility integration locally verified; two S1 policy answers remain pending |
| Current stage | S2 — compatibility integration that preserves existing authority; policy-dependent S1/S2 work remains open |
| Next work item | Publish/review the verified compatibility candidate, incorporate the receipt-allocation and supplier-tax decisions, then connect the broader monetary source adapters and financial commands |
| Working branch | `codex/purchase-cost-source-compatibility` |
| Plan branch base | `5f9e911a0c7506329624135d4a9a222842880962` |
| Latest main incorporated | Candidate begins at `80f5353b99a8500d78ac2687e7a736d0dbcc78e8`, the merge of PR #1964 |
| Audited main baseline | `e571bcac780852c3ac6b488354c10aaf7f1c417c`; reviewed costing paths were unchanged at the plan branch base |
| Audit | [Purchase costing authority review](procurement-costing-authority-audit-2026-10-30.md) |
| Stage 1 contract and ownership map | [Contract, compatibility and recognition boundary](procurement-costing-stage-1-contract.md) |
| Stage 2 compatibility trace | [Recorded authority and selected-input proof](procurement-costing-stage-2-compatibility.md) |
| Current implementation PR | S2 candidate not published yet; [#1964](https://github.com/cardshellz/Echelon/pull/1964) is merged |
| Deployment and live acceptance | User reports #1964 deployed on 2026-10-30. Release ancestry/processes and live records were not independently checked this session. S2 compatibility changes are local only. |

## Resume here after a context reset

1. Read this tracker and the linked audit. Treat earlier procurement release documents as evidence for their recorded scope and date; they do not close these findings.
2. Check the current branch, tracked changes, attached worktrees and latest `origin/main`. Preserve existing work. Revalidate audited code that changed upstream before implementing its fix.
3. Start the next open work item in the handoff section. Follow the dependency order below. Record unresolved business rules explicitly and continue work that does not depend on them.
4. Reuse the existing source-revision, financial-command, inventory application, audit and recovery owners. Do not introduce a parallel posting engine or hide warnings to obtain completion.
5. Update this file after each material implementation/test result, PR update, merge, deployment and live verification. Keep exact commits, test scope and evidence links. Separate local validation, hosted CI, deployment and live acceptance.
6. Before ending a work session, update the handoff: completed work, current state, exact next action, known blockers, changed files and remaining tests. Never rely on chat history or remembered status alone.

Work item states: `planned`, `in_progress`, `locally_verified`, `in_review`, `merged`, `deployed`, `live_verified`. Use `decision_needed` for the specific dependent task when a business rule is unresolved. A green CI run, merge or reported deployment does not establish live acceptance.

## Agreed costing and ownership contract

- The PO owns agreed quantities, prices and commercial terms. Approved invoice costs become authoritative for the goods/quantity covered. Uncovered quantities retain explicit provisional PO costs.
- Supplier product/packaging amounts and freight/duties/other charges each have a single financial source. An allocation is a share of that source, not a second charge.
- Payments own settlement and remaining payable. They do not set inventory cost or reopen an unchanged cost posting.
- One shared costing model calculates selected supplier cost, charge shares, exact landed totals and cost per piece. Every screen consumes it for the appropriate scope.
- The shipment owns shipped quantities and saved shipping measurements. The receipt owns counted quantities and its saved receive conversion. Financial changes preserve these physical facts unless an explicit quantity correction is included.
- A known supplier total must remain represented once even when its internal product/packaging split is unknown. Do not invent a split or silently drop part of the billed amount.
- Financial corrections require the appropriate approval, a clear before/after, actor and reason, an expected source/impact version, transactions, safe retries and immutable history. Existing authorization and approval policy must be checked rather than assumed.
- Costs follow proven transfer and repacking links. Recognized COGS changes require verified sales. Missing history cannot be converted into an invented sale or expense.
- Unchanged approved costs retain their approval provenance. New payment progress or proven inherited stock does not require the user to approve the same money again.
- Exact integer amounts and quantity intervals conserve source totals. Rounded display rates must not be multiplied back into postings.

## Audit findings and work items

The audit contains exact functions, source references, reasoning and limits. Each finding remains open until its acceptance evidence is recorded here.

| Work item | Audit finding | Required outcome | State |
| --- | --- | --- | --- |
| COST-01 | F1: competing PO/shipment/inventory monetary projections | One selected monetary projection, including packaging, correct source precedence and exact scope totals, feeds every consumer | in_progress |
| COST-02 | F2: all-or-nothing invoice coverage | Approved invoices establish actual costs for their covered quantities; uncovered quantities stay provisional; overlaps and ambiguity are explicit | in_progress |
| COST-03 | F3: invoice corrections stop before costing | Approved corrections invoke the shared cost pipeline or commit a durable visible continuation with complete downstream impact | planned |
| COST-04 | F4: freight invoice and charge amount dead end | One approved reconciliation replaces the estimate, preserves its history, recalculates shares and updates downstream costs | planned |
| COST-05 | F5: non-economic changes invalidate costs | Payment progress and superseded quote edits preserve unchanged cost identity; real financial/source-authority changes remain controlled | in_progress |
| COST-06 | F6: transformed lots invalidate static completion | Completion accepts proven exact cost inheritance; genuine missing links/values have a direct resolution without repeat approval of unchanged money | planned |
| COST-07 | F7: unsupported breakdowns and adjustments | Known totals, optional breakdowns, discounts, taxes, credits and supplier freight have explicit source and inclusion/allocation rules | in_progress |
| COST-08 | F8: approval lacks a reviewed financial version | Ordinary invoice approvals and corrections bind the reviewed economics and downstream impact to the transaction | planned |
| COST-09 | F9: shared results lost at UI boundaries | Relationship identifiers and shared results survive every API; completed costs and approval details appear consistently; genuine issues expose the owning action | planned |

## Delivery stages and dependencies

Develop one coordinated candidate. Changes can be split into reviewable dependent PRs, but activation must not expose a mixture of competing costing owners. Each stage extends the existing owners and retains compatibility with recorded historical sources and approvals.

### S1 — Define the authoritative cost contract and source rules

Primary work: COST-01, COST-02, COST-05, COST-07.

- [x] Define validated monetary contracts: selected source/revision, currency, quantity coverage, component/combined totals, allocated charges, provisional/confirmed state, application status and approval provenance.
- [ ] Define confirmed invoice coverage and provisional remainder behavior. Explicit interval validation and actual-plus-provisional money are implemented; the PO-line-only allocation policy still awaits the user's answer. Never choose an arbitrary historical stock destination.
- [x] Define economic identity independently of settlement metadata and superseded supporting quotes. Preserve the audit of all source documents while invalidating costs only for relevant changes. New semantic identity is not substituted into legacy posting writers in S1.
- [x] Support known combined supplier amounts without fabricating a breakdown or counting combined and component amounts twice. The additive contract and bounded compatibility strategy are documented; the stored representation/adapter must be proven in S2 before financial writes.
- [ ] Resolve the applicable inclusion/allocation rules for adjustments, tax, credits, supplier freight and non-product PO charges.
- [x] Trace ordinary order-cost updates through local reporting/transport and distinguish order basis from verified-sale recognition. [The exact trace and external-receiver evidence gap](procurement-costing-stage-1-contract.md#verified-sales-and-recognition-boundary) are recorded. S2/S3 may not change recognition semantics without closing that remaining boundary.
- [x] Add target-behavior regression tests for source precedence, partial coverage, known zero, unsupported/invalid input, exact totals and economic identity.

Exit evidence: agreed contracts/rules, exact source ownership map, bounded compatibility plan and passing domain tests. No production migration or financial backfill is implied by this stage.

### S2 — Connect financial mutations and approval to one update pipeline

Depends on the applicable S1 contracts. Primary work: COST-03, COST-04, COST-08.

- [x] Integrate the first legacy-equivalence bridge with source recording and shared status. Prove original hashes, confirmed supplier economics through the S1 model, approved settlement class and selected shipment allocation inputs; retain original revisions/approvals when unchanged. Candidate validation/review recorded below.
- [ ] Complete the broader monetary read/persistence adapters, including partial/combined supplier sources, header/credit treatment and their legacy compatibility, after the applicable policy decisions. The equivalence bridge alone is not this activation.
- [ ] Inventory every supported cost-changing command: invoice approval/correction/dispute/void, relevant PO amendments, shipment charge changes, invoice-to-charge reconciliation and source credits.
- [ ] Route these commands through shared planning/source selection and the existing revision/application owners. Record the affected scopes and update prerequisites explicitly.
- [ ] Produce a before/after preview covering document amounts, quantities, source selection, allocations, landed totals, remaining stock value, verified-sales cost changes and any unresolved amount.
- [ ] Bind approval to the reviewed source and impact version; recheck current permissions, approval authority and source state under the existing lock protocol.
- [ ] Save source changes, postings and audit atomically for bounded work. If processing must be deferred, commit a durable job tied to the approved scope and show processing until its actual result is recorded.
- [ ] Preserve AP source locks, exact reconciliation checks, idempotency and rollback behavior. A retry must not recreate physical receipts, payments or duplicate historical expenses.

Exit evidence: real database tests for the public approval/correction commands, stale previews, concurrent edits, duplicate/lost-response retries and injected audit/posting failures. Direct helper calls alone do not establish public-route acceptance.

### S3 — Prove downstream costs and inheritance

Depends on S1 source/quantity rules and S2 application orchestration. Primary work: COST-06 and downstream completion for COST-03/COST-04.

- [ ] Verify remaining inventory, transfers, repacking, returns and sale-cost dependencies against the selected financial revision.
- [ ] Recognize exact cost inheritance through recorded contribution links when evaluating completion. A new descendant alone must not invalidate unchanged proven money.
- [ ] Append an automatic costing continuation where new stock actually needs the already-approved source applied; preserve original approval provenance.
- [ ] Keep recognized COGS changes behind the verified-sales boundary established in S1. Distinguish order cost basis from recognized expense.
- [ ] Leave genuine missing lineage, inconsistent quantities or incorrect values as named exceptions with affected amounts, evidence and an owning resolution preview.
- [ ] Demonstrate that recording a new cost and resolving a historical inventory exception remain separate visible outcomes; no invented expense is used to finish a receipt.

Exit evidence: exact amount conservation through multi-step transformations and verified sales, unchanged physical quantities, no duplicated costs, stable original approvals and actionable real exceptions.

### S4 — Move every display and action to the shared result

Depends on S1-S3 contracts and owning commands. Primary work: COST-01, COST-09.

- [ ] PO header/cards/lines show agreed PO cost separately from the selected current supplier cost and total landed cost.
- [ ] Shipment lines show full landed cost including applicable packaging and their correct shares across multiple POs.
- [ ] Receipts receive the required stable line identifiers and display completed costs, original approvals, current processing and real remaining issues.
- [ ] Purchasing dashboard and lifecycle use the same monetary source, quantity coverage, revision and completion rules.
- [ ] History retains immutable approved before/after records and clearly identifies subsequent revisions/current completion.
- [ ] Remove independent monetary reconstruction from consumers after all callers have been inventoried. Formatting and scope selection remain consumer responsibilities; financial policy stays in shared owners.
- [ ] Provide direct owning resolution actions and preserve return navigation to the same PO/shipment/receipt line.
- [ ] Use human-readable status: what is saved, what is posted, what remains, its amount and the next action. Posted unchanged costs must not appear as pending approval.

Exit evidence: shared contract tests and connected desktop/mobile browser journeys across PO, shipment, receiving, dashboard, lifecycle and history.

### S5 — Complete integration and failure acceptance

Depends on the complete candidate. All COST work items remain subject to this stage.

Record the exact command, commit and result for each acceptance case. Exercise real database owners plus actual public application/HTTP workflows. Browser mocks complement database tests; they do not prove live posting.

| Case | Required proof | State |
| --- | --- | --- |
| AT-01 | No invoice uses explicit provisional PO costs; a full approved invoice replaces the relevant estimate | planned |
| AT-02 | Multiple/partial invoices and receipts use actual covered cost plus explicit provisional remainder without overlap | planned |
| AT-03 | Split shipments and multi-PO shipments conserve each charge and show only the correct document/line share | planned |
| AT-04 | Freight estimate-to-actual variance updates the approved financial source, allocations, inventory and verified-sales cost | planned |
| AT-05 | Packaging separate/included/unknown split, known zero, discounts, tax, credits and returns retain exact supported amounts | planned |
| AT-06 | Invoice quantity/price/amount correction after approval or payment updates costing while preserving physical and payment facts | planned |
| AT-07 | Payment-only progress and superseded quote changes do not reopen unchanged cost completion | planned |
| AT-08 | Repacking/transfer after posting inherits proven costs and preserves approval; deliberately broken links remain actionable | planned |
| AT-09 | Saved receiving configurations drive received pieces and cost allocation; actual quantities change only through their owning correction | planned |
| AT-10 | Late costs reach remaining stock and verified sales across receipt/invoice/freight event orders without invented expenses | planned |
| AT-11 | Duplicate requests, lost responses and repeated costing jobs produce no duplicate cost or approval | planned |
| AT-12 | Concurrent source changes and revoked authority reject stale approval; audit/posting failure rolls back financial writes | planned |
| AT-13 | Every screen agrees on amounts, source/revision, scope and status; history and return navigation remain intact | planned |
| AT-14 | Migration/contract compatibility, existing approved histories, integer limits, unsupported currency and invalid sources fail explicitly and safely | planned |

Exit evidence: passing relevant unit suites, TypeScript/build checks, PostgreSQL acceptance, desktop/mobile connected journeys and required hosted CI on the exact review head. Any skipped/unexecuted acceptance is recorded as remaining work.

### S6 — Controlled rollout and historical reconciliation

Depends on accepted S5 evidence and a deployable compatible candidate.

- [ ] Create a release manifest with exact PRs/commits, migrations, dependencies, activation state, validation and recovery steps.
- [ ] Compare the new projection with existing values using read-only production evidence. Classify expected differences, unexplained differences and records needing actual correction.
- [ ] Verify deployed commit ancestry, release/migration success and running processes before claiming the new implementation is live.
- [ ] Verify representative PO, shipment, receipt, inventory, dashboard, lifecycle and history records together. Re-read original amounts and approvals to prove unchanged records remain unchanged.
- [ ] Prepare each necessary historical correction with its exact evidence, before/after and existing admin approval flow. Preserve original postings and use only required adjustments.
- [ ] Recheck live shared status after approved corrections. Never suppress an unresolved discrepancy to satisfy acceptance.
- [ ] Retire competing runtime calculations only after all consumers and compatibility requirements are proven covered.

Exit evidence: exact deployed candidate accepted across the complete flow, original approvals preserved, and each historical correction separately recorded and reconciled. Code rollback does not reverse committed financial changes; recovery retains their audit and uses the owning corrective workflow.

## Business rules and unresolved boundaries

| Decision | State | Required treatment |
| --- | --- | --- |
| Approved invoice versus provisional PO versus payments | Agreed | Invoice-first for covered goods; PO estimate for uncovered goods; payment is settlement |
| Invoice coverage where explicit receipt links exist | Agreed principle | Preserve and use those links and immutable quantity evidence |
| Allocation where invoices identify only a PO line | Asked; awaiting answer | Require receipt allocation where costs differ, or explicitly blend costs over the PO line; no stock destination is chosen in S1 |
| Tax inclusion/recovery and allocation of header/non-product adjustments | Tax question asked; awaiting answer. Header allocation evidence remains to be adapted | The contract accepts explicit included/excluded/unclassified adjustments; no global tax rule or residual header allocation is invented |
| Known total with unknown product/packaging split | S1 contract implemented; stored compatibility still required in S2 | Preserve the full known amount once and keep the unknown breakdown explicit |
| Foreign currency | Existing unsupported/review boundary retained | Do not activate guessed FX conversions; broader currency support needs its own approved rule/scope |
| Ordinary order cost basis versus recognized COGS | Local trace documented; external recognition is not proven | Picking writes order basis; ordinary recosting/reporting includes that basis. Repaired history has an explicit verified-sale policy. S2/S3 must prove recognition before changing its behavior |
| Historical production dollar exposure | Not measured | Use separate read-only comparisons and specific reviewed corrections |

These dependencies do not stop unrelated contract, identity, preview or consumer work. Ask only the focused business questions that cannot be answered from existing approved policy or source evidence.

## PR and release ledger

Add exact identifiers as work exists. A proposed slice is not an existing PR or deployment.

| Slice | Intended contents | PR/commit | Local evidence | Hosted CI | Deployment/live proof |
| --- | --- | --- | --- | --- | --- |
| Plan and audit | This tracker, baseline audit and synthetic characterization evidence | `3cf9b7102043eb14386f69ffe70b8590951d7169` | Documentation links and synthetic evidence checks | Not run for implementation | No runtime change |
| Contract foundation | S1 contracts, economic identity, source rules and compatibility tests | [Merged #1964](https://github.com/cardshellz/Echelon/pull/1964), merge `80f5353b99a8500d78ac2687e7a736d0dbcc78e8`; head `691ae3c87a7ca36ea7c17dfc9e652c00f96c7d9b` | 480 tests / 16 files and production/server-test TypeScript passed on main-integrated code `c157e98f7` | Final head read: 49 successful, 2 skipped, 1 cancelled browser shard and its failed aggregate. Cancellation cause was not established; do not call this fully green | Deployment reported by user; independent release/live acceptance not recorded |
| Source compatibility | First S2 integration and F5: original revisions/approvals survive settlement and unused-quote changes across shared read/write owners | Current branch; PR/commit to record on publication | Final candidate: 558 focused unit tests / 17 files, 50 related reader/cache tests / 4 files, 259 real-owner PostgreSQL tests and 455 guard tests passed. Production/server-test TypeScript passed. Six SQL cases are new; the added closed-health regression remains active | Not run for new candidate | Not deployed; no live data changed |
| Commands and downstream application | S2-S3 owning workflows, approvals, inheritance and safe recovery | Not created | Not run | Not run | Not deployed |
| Shared consumers and complete acceptance | S4-S5 connected readers, actions and full acceptance | Not created | Not run | Not run | Not deployed |
| Rollout and historical review | S6 manifest, read-only comparisons and specifically approved corrections | Not created | Not run | Not run | Not deployed |

Final PR boundaries follow verified dependencies and reviewable size. If a slice is split, update this ledger and keep the complete candidate coherent; do not turn it into unrelated screen-by-screen implementations.

## Evidence already collected

- [Pinned code audit with exact functions and limitations](procurement-costing-authority-audit-2026-10-30.md).
- [Synthetic characterization source](evidence/procurement-cost-authority-audit-20261030.ts) and [captured output](evidence/procurement-cost-authority-audit-20261030.json).
- At the audit baseline, 379 existing unit tests passed across 13 focused files. The historical characterization reproduces current defects; those passing checks are not acceptance of the new design.
- The audit did not execute PostgreSQL/full browser acceptance or measure production exposure. Those remain explicit work above.
- Stage 1 added 101 target contract/fingerprint tests, with the 379 existing tests still passing: 480 tests across 16 files. New projection/schema coverage: 98.59% statements, 97.25% branches, 99.10% lines. Coverage is bounded to the three new money/projection/schema files, not the whole purchase flow.
- Stage 1 production TypeScript passed using `node --max-old-space-size=8192 node_modules/typescript/bin/tsc --pretty false --incremental false`. Default-heap TypeScript previously exhausted memory; the explicit heap run succeeded.
- Stage 1 server-test TypeScript passed using `node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p tsconfig.tests.server.json --pretty false --incremental false`. No client UI change was made in this stage.
- Repeated all 480 tests and both TypeScript checks after merging main at code commit `c157e98f72645cd51ce2da0a61ea5e6ab486ba59`: all passed. The PR/validation ledger was the only subsequent changed file.
- Windows sandbox temporary-file renames prevented Vitest cache writes; the same pure/local suites passed outside that restriction. No database credentials or live financial commands were used.

### Stage 1 repeatable local validation

Run from the repository root. These cases do not use a database. Passing them does not close the PostgreSQL, command, concurrency, browser or live acceptance rows in S5/S6.

```powershell
$cases = @(
  'server/modules/procurement/__tests__/unit/purchase-cost-authority.test.ts'
  'server/modules/procurement/__tests__/unit/purchase-cost-authority.validation.test.ts'
  'server/modules/inventory/__tests__/unit/cost-fingerprint.test.ts'
  'server/modules/procurement/__tests__/unit/purchase-cost-status.test.ts'
  'server/modules/procurement/__tests__/unit/shipment-charge-evidence.test.ts'
  'server/modules/procurement/__tests__/unit/shipment-allocation-basis.test.ts'
  'server/modules/procurement/__tests__/unit/cost-review-tasks.test.ts'
  'server/modules/procurement/__tests__/unit/po-shipment-costs.test.ts'
  'shared/procurement/__tests__/unit/po-line-landed-cost.test.ts'
  'shared/procurement/__tests__/unit/cost-source-contracts.test.ts'
  'server/modules/inventory/__tests__/unit/cost-application.domain.test.ts'
  'server/modules/inventory/__tests__/unit/verified-cost-sale.test.ts'
  'server/modules/procurement/__tests__/unit/shipment-cost-source-identity.test.ts'
  'server/modules/procurement/__tests__/unit/current-shipment-cost-source.test.ts'
  'server/modules/procurement/__tests__/unit/invoice-quantity-correction.policy.test.ts'
  'server/modules/procurement/__tests__/unit/receipt-cost-recovery.test.ts'
)
node node_modules/vitest/vitest.mjs run @cases --coverage --coverage.include=server/modules/procurement/domain/purchase-cost-authority.ts --coverage.include=server/modules/procurement/domain/purchase-cost-authority-money.ts --coverage.include=shared/procurement/purchase-cost-authority.ts --coverage.reportsDirectory=.codex-artifacts/purchase-cost-authority-stage-1-coverage --coverage.reporter=text --reporter=dot
node --max-old-space-size=8192 node_modules/typescript/bin/tsc --pretty false --incremental false
node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p tsconfig.tests.server.json --pretty false --incremental false
```

The evidence script is a baseline diagnostic outside normal test discovery. Its assertions intentionally characterize the audited behavior. Implementation must add target-behavior tests to the real suites, retain this dated evidence, and avoid treating a later diagnostic assertion failure after a fix as a production regression.

### S2 compatibility evidence and repeatable checks

- `verifiedStoredCostSource` checks the original stored contract, fingerprint and captured evidence before any semantic comparison.
- `retainEquivalentPurchaseCostSource` regenerates a supported fully confirmed legacy component and verifies its selected money through the S1 projection. Original revisions are reused in `recordCostRevision` and `readPurchaseCostStatus`; unchanged postings are not rehashed or recreated.
- `retainEquivalentShipmentCostSource` shares the approved settlement class. `normalizeUnselectedShipmentQuote` proves exact charge signatures and selected allocation methods before excluding unused PO quote inputs. By-value price dependencies remain active.
- Real SQL proof calls the actual AP payment owner, supplier reconciliation and shipment application owners. It compares original source/application/reporting/approval and stock records before/after. Genuine amount/currency/lot mismatches remain visible; concurrent retries retain one source revision.
- New closed-shipment health checks reproduced an additional F5 failure beyond the initial supplier bridge: quote fields were hashed into landed sources even for volume, weight or line-count allocation. Four target unit cases failed before the selected-input proof; the corrected six-case SQL group passed afterward. Do not remove this regression to obtain a green suite.
- Unknown captured fields, including prototype-named JSON keys, remain significant. Validation is not allowed to discard raw captured evidence during comparison.
- Final focused coverage for the four compatibility files: 95.32% statements, 92.18% branches, 100% functions and 98.37% lines. This is bounded comparison coverage, not whole-flow coverage.
- The money boundary guard rejected a direct BigInt-to-number conversion in the initial candidate. The final implementation uses the existing exact `readIntegerMills` boundary; no guard exception was added. All 455 guard tests then passed.
- Final local results on 2026-10-30: 558 focused tests / 17 files, 50 related repository-reader/cache tests / 4 files, 259 receipt/AP/freight SQL tests / 1 file, 455 guards / 12 files, and production/server-test TypeScript all passed. The final SQL run started at 16:38:34 local time and completed in 216.46 seconds.
- Testing uses a newly initialized PostgreSQL 17 cluster bound to `127.0.0.1:55439`, under ignored `.codex-artifacts/stage2-cost-source-pg`, and database `echelon_stage2_cost_compat`. No existing/live database was accessed. The fixture owns and removes its schemas; final cleanup stops this cluster.

The unit command from S1 adds `server/modules/procurement/__tests__/unit/purchase-cost-source-identity.test.ts` (558 tests total). The related reader/cache command below adds 50 separate tests. For SQL acceptance against an explicitly disposable LOCAL database:

```powershell
$env:ECHELON_TEST_DATABASE_URL = 'postgresql://test@127.0.0.1:55439/echelon_stage2_cost_compat'
$env:ECHELON_TEST_DATABASE_DISPOSABLE = 'true'
node node_modules/vitest/vitest.mjs run server/modules/procurement/__tests__/integration/receiving-cost-application.integration.test.ts --reporter=dot
node node_modules/vitest/vitest.mjs run server/modules/procurement/__tests__/unit/purchase-cost-status-batch.repository.test.ts server/modules/procurement/__tests__/unit/purchase-cost-status-snapshot.repository.test.ts server/modules/procurement/__tests__/unit/shipment-cost-review-supplier-snapshot.test.ts server/modules/procurement/__tests__/unit/supplier-credit-cost-read-cache.test.ts --reporter=dot
node scripts/ci/run-test-lane.mjs guards
node --max-old-space-size=8192 node_modules/typescript/bin/tsc --pretty false --incremental false
node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p tsconfig.tests.server.json --pretty false --incremental false
```

Never point the integration fixture at a live database. Final counts/head and hosted CI state belong in the ledger/handoff; earlier passing runs do not replace final candidate verification.

## Current handoff

**Completed:** S1 foundation merged in #1964; the user reports deployment. The first S2 candidate connects the supported semantic compatibility proof to actual source recording/shared status and shipment preparation, preserving original recorded authority across AP payment progress and unused PO quote edits. Real AP payment, source/app/history preservation, concurrent retry and genuine-exception cases pass in the disposable SQL fixture. The additional unused landed-snapshot quote dependency found by closed-shipment health tests is fixed in the selected-input proof. Final local unit/reader, SQL, guard and both TypeScript checks passed; publication/hosted verification remain.

**Implementation state:** the applicable S1 receipt-allocation/tax rules remain open. COST-05 has a cross-cutting runtime candidate; COST-01/02/07 retain foundations rather than activated replacement pricing. COST-03/04/06/08/09 and the remaining acceptance gates are open. No migration, stored-source rehash, historical correction or live stock/financial mutation has occurred. The new bridge changes equivalence/currentness in the existing owners; it does not create a new posting engine or activate unsupported costs.

**New code entry points:**

- `server/modules/procurement/domain/cost-source-compatibility.ts`: validate the original immutable proposal before reuse.
- `server/modules/procurement/domain/purchase-cost-source-identity.ts`: fully confirmed supplier equivalence through the S1 money model.
- `server/modules/procurement/domain/shipment-cost-selected-inputs.ts`: method-dependent proof of unused quote inputs, including exact source-reference verification.
- `server/modules/procurement/cost-source-revision.repository.ts`, `purchase-cost-status.repository.ts` and `shipment-cost-source-identity.ts`: shared writer/read integration.
- `server/modules/procurement/__tests__/integration/cost-source-compatibility.cases.ts`: real AP payments, immutable history, closed health, concurrent retries and real mismatches.

- `shared/procurement/purchase-cost-authority.ts`: normalized input/output schemas and types.
- `server/modules/procurement/domain/purchase-cost-authority.ts`: `projectPurchaseCostAuthority`.
- `server/modules/procurement/domain/purchase-cost-authority-money.ts`: exact signed proration, sums and classified failures.
- `server/modules/inventory/domain/cost-fingerprint.ts`: the existing canonical hash, now pure and reusable without importing infrastructure.
- `server/modules/procurement/__tests__/unit/purchase-cost-authority*.ts` and `server/modules/inventory/__tests__/unit/cost-fingerprint.test.ts`: synthetic target and boundary/compatibility tests.
- [Stage 1 contract document](procurement-costing-stage-1-contract.md): concrete ownership map, compatibility steps, recognition trace and remaining evidence gaps.

**Next action:** publish the S2 compatibility PR and check hosted CI on its exact head. Incorporate the pending policy answers, then implement the broader S2 source/persistence adapters and approved financial mutation/preview binding. The unknown-breakdown model cannot be stuffed into legacy product/packaging rows by assuming zero packaging. Validate header/credit/return allocation and the verified-sale reporting boundary before activating those paths.

**Remaining checks:** hosted validation for the new compatibility candidate; broader S2 mutation/source adapter acceptance; S3 inheritance/verified-sale acceptance; S4 complete monetary consumers and connected UI; S5/S6 complete candidate and release/live proof. A regression suite for the existing owners is not acceptance of unimplemented financial adapters or UI activation.

**Open dependencies:** the user has not yet answered the S1 receipt-allocation and supplier-tax questions. External accounting recognition and historical production exposure remain unproven. Do not assign stock destinations, tax inclusion or accounting effects from a guess.

## Change log

| Date | Change | Evidence/state |
| --- | --- | --- |
| 2026-10-30 | Established the active cleanup tracker, preserved all nine audit findings and synthetic evidence, and recorded ownership rules, stages, acceptance and resumption procedure | Planning/evidence only; implementation not started |
| 2026-10-30 | Implemented the additive S1 contract/projection and compatibility hash extraction, documented the owning paths/recognition limits, and added target/validation tests | 480 tests / 16 files and production/server-test TypeScript passed; policy answers pending; no activation/live writes |
| 2026-10-30 | Incorporated refreshed main `31c03b80b` and opened draft PR #1964 for the contract foundation and durable plan | No audited cost owner changed upstream; 480 tests and both TypeScript checks passed again on merged code `c157e98f7`; hosted CI running; no deployment or financial writes |
| 2026-10-30 | Verified #1964 merged at `80f5353b9`; recorded user-reported deployment and continued S2 on `codex/purchase-cost-source-compatibility` | Historical cleanup remains separate. Final S1 head had a cancelled browser shard/failed aggregate; cancellation cause not proven |
| 2026-10-30 | Added source-record/status compatibility, actual AP payment regression coverage and method-aware unused quote proof; retained unknown raw JSON evidence | 558 focused + 50 reader/cache + 259 real-owner SQL + 455 guard tests and both TypeScript checks passed. The expanded closed-health case exposed and now guards the extra landed-source dependency; publishing/hosted CI remain |
