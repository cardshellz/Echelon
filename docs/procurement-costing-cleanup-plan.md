# Purchase costing cleanup plan and tracker

This is the active tracker for consolidating purchase costing from PO through shipment, receiving, inventory and verified sales. Every implementation change, test result, PR and deployment verification for this cleanup belongs here. The linked audit preserves the evidence behind the work.

| Tracking field | Current value |
| --- | --- |
| Created | 2026-10-30 |
| Overall state | #1964, #1967, #1971, #1979 and #1983 merged. #1983 independently verified in v3447, exact merge commit/process/migration and all 27 post-merge checks successful. Production has zero receipt assignments/enabled lines and zero freight approvals; live financial posting acceptance remains unproven. Receipt-specific prices and configured tax treatment remain confirmed policy |
| Current stage | S2 — connect approved financial corrections to the existing costing pipeline and reviewed impact |
| Next work item | Finish A1 standalone supplier-review approval acceptance, then A2 ordinary AP transitions and A3/A4 combined/header/credit adapters. [Finite remaining delivery gates](procurement-costing-remaining-delivery.md) define the remaining command, downstream, consumer and acceptance work |
| Working branch | `codex/purchase-cost-review-approval` |
| Plan branch base | `e5d69368639528cdf9c73d60799184591f8d8e88` |
| Latest main incorporated | `56c547ae5f8e0ff60e7d0570999a58f3b973ef92` (#1983), verified deployed as v3447 |
| Audited main baseline | `e571bcac780852c3ac6b488354c10aaf7f1c417c`, the historical F1-F9 audit baseline. Later implementation and deployment evidence is recorded below; this baseline is not current production acceptance proof |
| Audit | [Purchase costing authority review](procurement-costing-authority-audit-2026-10-30.md) |
| Stage 1 contract and ownership map | [Contract, compatibility and recognition boundary](procurement-costing-stage-1-contract.md) |
| Stage 2 compatibility trace | [Recorded authority and selected-input proof](procurement-costing-stage-2-compatibility.md) |
| Current implementation PR | Supplier-review approval continuation on the branch above; publication and final-head acceptance recorded below when available. [#1983](https://github.com/cardshellz/Echelon/pull/1983) freight reconciliation and [#1979](https://github.com/cardshellz/Echelon/pull/1979) receipt assignment are merged and deployed |
| Deployment and live acceptance | [#1983 verification](procurement-costing-deployment-1983.md): v3447 runs exact merge `56c547ae5`, migration succeeded, web/capture processes up on the same release, all 27 deployed-commit checks passed. Read-only counts at 2026-11-02 13:41 UTC: zero receipt assignments/enabled lines/freight approval events. Historical facts and original approvals were preserved. Actual production postings remain unproven; no live financial/stock writes were made |

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
- Configure each tax type explicitly as inventory cost or recoverable tax. PO defaults and line overrides own estimates; supplier invoice tax owns the actual billed tax; shipment tax/duty keeps its gross charge share while only its capitalized share reaches inventory. Receiving inherits the selected rule. Changing rules or saved assignments requires one current-admin approval of measured before/after costs. This records recoverable tax; it does not assert eligibility or submit a tax claim.

## Audit findings and work items

The audit contains exact functions, source references, reasoning and limits. Each finding remains open until its acceptance evidence is recorded here.

| Work item | Audit finding | Required outcome | State |
| --- | --- | --- | --- |
| COST-01 | F1: competing PO/shipment/inventory monetary projections | One selected monetary projection, including packaging, correct source precedence and exact scope totals, feeds every consumer | in_progress |
| COST-02 | F2: all-or-nothing invoice coverage | Approved invoices establish actual costs for their covered quantities; uncovered quantities stay provisional; overlaps and ambiguity are explicit | deployed (#1979; live posting acceptance pending: zero approved assignments) |
| COST-03 | F3: invoice corrections stop before costing | Approved corrections invoke the shared cost pipeline or commit a durable visible continuation with complete downstream impact | in_progress |
| COST-04 | F4: freight invoice and charge amount dead end | One approved reconciliation replaces the estimate, preserves its history, recalculates shares and updates downstream costs | bounded implementation deployed ([#1983 verification](procurement-costing-deployment-1983.md)); mixed/header/credit scopes and live posting acceptance remain open |
| COST-05 | F5: non-economic changes invalidate costs | Payment progress and superseded quote edits preserve unchanged cost identity; real financial/source-authority changes remain controlled | in_progress |
| COST-06 | F6: transformed lots invalidate static completion | Completion accepts proven exact cost inheritance; genuine missing links/values have a direct resolution without repeat approval of unchanged money | planned |
| COST-07 | F7: unsupported breakdowns and adjustments | Known totals, optional breakdowns, discounts, taxes, credits and supplier freight have explicit source and inclusion/allocation rules | in_progress |
| COST-08 | F8: approval lacks a reviewed financial version | Ordinary invoice approvals and corrections bind the reviewed economics and downstream impact to the transaction | in_progress |
| COST-09 | F9: shared results lost at UI boundaries | Relationship identifiers and shared results survive every API; completed costs and approval details appear consistently; genuine issues expose the owning action | planned |

## Delivery stages and dependencies

Develop one coordinated candidate. Changes can be split into reviewable dependent PRs, but activation must not expose a mixture of competing costing owners. Each stage extends the existing owners and retains compatibility with recorded historical sources and approvals.

### S1 — Define the authoritative cost contract and source rules

Primary work: COST-01, COST-02, COST-05, COST-07.

- [x] Define validated monetary contracts: selected source/revision, currency, quantity coverage, component/combined totals, allocated charges, provisional/confirmed state, application status and approval provenance.
- [x] Define confirmed invoice coverage and provisional remainder behavior. Explicit interval validation and actual-plus-provisional money are implemented. On 2026-11-01 the user confirmed that each receipt keeps its own invoice cost; do not average differently priced invoices. #1979 deployed the S2 persistence/allocation adapter. Live financial acceptance remains open because production has no approved assignments. Never choose an arbitrary historical stock destination.
- [x] Define economic identity independently of settlement metadata and superseded supporting quotes. Preserve the audit of all source documents while invalidating costs only for relevant changes. New semantic identity is not substituted into legacy posting writers in S1.
- [x] Support known combined supplier amounts without fabricating a breakdown or counting combined and component amounts twice. The additive contract and bounded compatibility strategy are documented; the stored representation/adapter must be proven in S2 before financial writes.
- [ ] Resolve the applicable inclusion/allocation rules for adjustments, tax, credits, supplier freight and non-product PO charges.
- [x] Trace ordinary order-cost updates through local reporting/transport and distinguish order basis from verified-sale recognition. [The exact trace and external-receiver evidence gap](procurement-costing-stage-1-contract.md#verified-sales-and-recognition-boundary) are recorded. S2/S3 may not change recognition semantics without closing that remaining boundary.
- [x] Add target-behavior regression tests for source precedence, partial coverage, known zero, unsupported/invalid input, exact totals and economic identity.

Exit evidence: agreed contracts/rules, exact source ownership map, bounded compatibility plan and passing domain tests. No production migration or financial backfill is implied by this stage.

### S2 — Connect financial mutations and approval to one update pipeline

Depends on the applicable S1 contracts. Primary work: COST-03, COST-04, COST-08.

- [x] Integrate the first legacy-equivalence bridge with source recording and shared status. Prove original hashes, confirmed supplier economics through the S1 model, approved settlement class and selected shipment allocation inputs; retain original revisions/approvals when unchanged. Candidate validation/review recorded below.
- [x] Implement the bounded invoice-correction connector: measure the actual document/cost owners in a rolled-back preview, require a reviewed impact version for new approvals, commit supported costs and history in one transaction, replay committed legacy receipts without new postings, and retain a durable separate review for real missing cost evidence. [Trace, examples, owner inventory and limitations](procurement-costing-stage-2-invoice-corrections.md). Final broader S2 gates below remain open.
- [x] Implement mandatory standalone supplier-review impact binding and persisted Administrator approval through the same supplier cost owner. Exact remaining-stock values and linked immutable approval history are included; tax/origin commands retain their complete outer approval. [Execution trace and acceptance boundary](procurement-costing-stage-2-supplier-approval.md). Candidate validation/deployment remain separate; ordinary AP transitions and source adapters are still open.
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
| Allocation where invoices identify only a PO line | User confirmed 2026-11-01: keep each receipt's own invoice cost | Use explicit receipt coverage; never introduce PO-line averaging. #1979's administrator-approved interval adapter is deployed; historical mappings are not inferred. New correction application rejects ambiguous multi-invoice scopes rather than activating legacy averaging |
| Tax inclusion/recovery and allocation of header/non-product adjustments | Confirmed on 2026-11-01: configure each tax type once as inventory cost or recoverable tax; inherit it through purchasing/receiving; changes require current-admin approval with measured before/after. No actual tax eligibility is assumed. The tax adapter uses exact net-goods allocation for header/unparented tax and preserves explicit parent/line tax ownership | The configured-tax candidate is in #1971. Other discounts, supplier tax-credit attribution, supplier freight and non-tax header charges remain separate source-adapter work; unsupported amounts are not invented or silently capitalized |
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
| Source compatibility | First S2 integration and F5: original revisions/approvals survive settlement and unused-quote changes across shared read/write owners | [Merged #1967](https://github.com/cardshellz/Echelon/pull/1967), merge `2ea5a8d2cabe65ecfa0436f583a6eee7ad351278`; final head `b2d57e538f705698d3752d7ff55ea3ad8f662621` | Main-integrated runtime: 608 unit/reader tests / 21 files, 259 real-owner PostgreSQL tests, 456 guards and production/server-test TypeScript passed | Final head verified: 51 successful, 2 skipped, no failing checks | User reports deployment; independent release ancestry/process/live acceptance not recorded |
| Approved invoice corrections | COST-03 and correction portion of COST-08: real document/cost preview, mandatory impact binding, optional same-approval supplier evidence, atomic postings/history, safe legacy/retry behavior | [#1971](https://github.com/cardshellz/Echelon/pull/1971), implementation `49906226f4f5e489750591e4fdc771711ca8c550`; based on pinned main `2ea5a8d2c`; following tracker-only commit does not change runtime | 698 unit/reader/form tests / 24 files, 278 receipt/AP/freight SQL cases (including 19 new HTTP cases), 97 existing correction SQL cases, 52 desktop/mobile browser cases repeated on final UI, 456 guards, production/server/client-test TypeScript and production build passed. Published implementation's 19 HTTP cases passed again (08:40:15 local; 36.88s) | [Checks](https://github.com/cardshellz/Echelon/pull/1971/checks) started; first read has 7 queued and no failures. Final-head hosted acceptance remains pending | Not deployed; no live writes |
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
- Repeated on main-integrated code `f4e0c6dd821eef6bf573bc53a74486bc2dbde208`: 608 unit/reader tests / 21 files, 259 SQL cases / 1 file, 456 guards / 12 files, and both production/server-test TypeScript checks passed. The SQL repeat started at 16:44:28 local time and completed in 244.09 seconds. Main added one guard case; the compatibility implementation did not change. Subsequent changes only record validation/PR documentation.
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

**Completed:** #1964 and #1967 are merged and the user reports both deployments. #1967's final head has 51 successful and 2 skipped checks. The new correction slice connects approved invoice quantity/price/amount/component edits to the existing supplier source/application/status owners, with a real rolled-back cost preview and mandatory new approval fingerprint. Legacy committed receipts replay without applying new costs. Known supplier components are retained for quantity-only edits; changed money without new evidence leaves a durable visible supplier review. Real invoice/matching/cost/audit writes share one transaction.

**Implementation state:** COST-03, configured tax, receipt-specific assignment and bounded freight reconciliation have deployed implementations; whole-stage completion is not claimed. #1983 runs in verified v3447. Production still has zero receipt assignments/enabled lines/freight approvals, so financial posting acceptance remains open. The current candidate closes mandatory reviewed-impact/current-admin enforcement for standalone supplier review and retains the linked approval through existing history. Mixed/header/credit/combined source scopes, ordinary AP transition binding, downstream inheritance/recognition and complete consumer acceptance remain in the [finite delivery gates](procurement-costing-remaining-delivery.md). No historical cleanup or live financial/stock mutation was performed.

**Configured-tax addition:** `purchase_tax_types` owns explicit rules; PO defaults/line tax overrides, actual invoice tax parts and shipment tax/duty references use those rules. `createPurchaseTaxChangeService` runs the existing supplier and shipment cost owners inside one current-admin financial command. Preview uses the same rolled-back execution; the normalized shared impact DTO binds the approval without generated IDs. Unknown history stays visible and cannot invent an expense. Existing approved historical destinations can receive changed amounts through the existing updater without replacing their original approvals. Receiving inherits the saved rule/conversion. Tax-aware PO and shipment displays use the selected supplier amounts and separately retained recoverable tax. Recent approvals show actor, reason and the saved before/after.

**Deployment closeout:** #1979 is merged and independently verified deployed in v3445 at `5407e8938999f8967aab2f4265849f8cab533a2d`, including the receipt allocation migration and both active processes. Final PR-head checks: 75 successful. Current deployed-commit checks: 27 successful. Original merge checks included two cancelled SQL shards and their failed aggregate; their cancellation cause is unproven. Production read-only evidence contains zero receipt allocations, zero enabled lines and zero new approval audits. The live editor accurately shows uncovered receipt coverage, but its projection does not establish historical lot flags. See [deployment evidence and acceptance still required](procurement-costing-deployment-1979.md). Earlier tax release evidence remains in the [#1971 receipt](procurement-costing-deployment-1971.md).

**New code entry points:**

- `invoice-quantity-correction.service.ts`: common measured execution, rolled-back preview, current authority and transactional impact binding.
- `invoice-correction-costs.service.ts`: existing supplier cost owner, current shared status/tasks and target-line impact scope.
- `invoice-correction-cost-values.ts`: exact original/remaining lot value via the existing valuation owner.
- `invoice-quantity-correction.repository.ts`: separate persistence and final audit/history, complete billing/freight-link evidence, review version 4.
- `shared/procurement/invoice-correction-cost-impact.ts`: validated measured result; no generated preview IDs in economic identity.
- `InvoiceCorrectionSupplierAmounts.tsx`, `InvoiceCorrectionCostImpact.tsx`, `invoice-correction-review.ts`: same-modal optional amounts, before/after/posting result and strict saved-intent recovery.
- `invoice-correction-costs.cases.ts`: actual public HTTP/IAM/AP/command/cost/status/audit acceptance, concurrency, rollback and compatibility cases.
- [Stage 2 correction trace](procurement-costing-stage-2-invoice-corrections.md): exact owner sequence, examples, mutation inventory and unsupported scopes.
- [Stage 2 configured-tax trace](procurement-costing-stage-2-tax-treatment.md): authority, exact allocation, receiving inheritance, current-admin approval, stable measured review and explicit unsupported scopes.

Earlier foundation/compatibility entry points:

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

**Next action:** complete the [standalone supplier approval candidate](procurement-costing-stage-2-supplier-approval.md), which closes the optional-preview/persisted-admin gap in that specific command. Follow [remaining gates A2 through D2](procurement-costing-remaining-delivery.md) for ordinary AP transitions, source adapters, downstream integrity, all consumers and final acceptance. #1983 deployment is verified; its live financial acceptance and receipt-specific production posting still require actual evidence and approved records. Do not create guessed assignments or infer zero packaging from an unknown breakdown.

**Acceptance and remaining delivery:** #1983's final PR head passed 63 hosted checks; the deployed merge passed all 27 post-merge checks. [Release/process/migration evidence](procurement-costing-deployment-1983.md) is separate from live posting acceptance. The [finite remaining delivery list](procurement-costing-remaining-delivery.md) preserves open S2-S6 gates and proof still required. Earlier receipt/freight validation counts are historical and overlap; they are not added to this candidate's totals. Production records were not changed.

**Open dependencies:** tax configuration policy and receipt-specific invoice costing are confirmed and their bounded adapters are deployed; production receipt assignment acceptance remains pending. Supplier tax credits/FX and unrelated header adjustments still require supported source adapters. External accounting recognition and historical production exposure remain unproven. Do not choose a stock destination, actual tax eligibility or recognized expense from a guess.

## Change log

| Date | Change | Evidence / boundary |
| --- | --- | --- |
| 2026-11-02 | Verified #1983 deployment and continued with standalone supplier approval binding | [v3447 evidence](procurement-costing-deployment-1983.md): exact merge/migration/processes and all 27 deployed-commit checks passed, zero actual receipt assignments/freight approvals. [Current supplier review candidate](procurement-costing-stage-2-supplier-approval.md) requires measured impact/current persisted Administrator and retains linked approval. [Finite remaining gates](procurement-costing-remaining-delivery.md) replace an ambiguous next-work handoff. Candidate validation and PR acceptance are recorded separately below; no production writes |
| 2026-11-02 | Unified freight invoice and PO approval history and closed hosted ownership browser failures | Both views read the existing immutable PO event stream, retaining the actor, authority, reason, before/after and actor-scoped command key. A single partial lookup index is allocated after current main's migration frontier. Canonical approval references support safe bigint IDs; missing PO relationships are explicit blockers. 22 focused SQL, 66 desktop/mobile ownership/review cases, four connected cases and all four TypeScript programs passed before the unrelated main refresh. Final composed acceptance and CI are recorded on #1983 |
| 2026-11-01 | Verified #1979 deployment and continued S2 with freight invoice reconciliation | [Read-only production evidence](procurement-costing-deployment-1979.md): v3445 includes #1979, but zero assignments/enabled lines/approval audits prevent claiming live receipt-specific posting. [#1983](https://github.com/cardshellz/Echelon/pull/1983) uses the existing AP/allocation/application owners with one reviewed current-admin approval, original estimates/approvals, exact shared-shipment shares, durable retries and immutable history. 18 targeted SQL, 14 mocked and four connected browser cases, 164 focused/guard tests, 313 related regressions, all four TypeScript projects and production build passed. Full 346-case SQL and final-head hosted acceptance are tracked on the PR. Broad S2/S3/S4 and live financial acceptance remain separate |
| 2026-10-30 | Established the active cleanup tracker, preserved all nine audit findings and synthetic evidence, and recorded ownership rules, stages, acceptance and resumption procedure | Planning/evidence only; implementation not started |
| 2026-10-30 | Implemented the additive S1 contract/projection and compatibility hash extraction, documented the owning paths/recognition limits, and added target/validation tests | 480 tests / 16 files and production/server-test TypeScript passed; policy answers pending; no activation/live writes |
| 2026-10-30 | Incorporated refreshed main `31c03b80b` and opened draft PR #1964 for the contract foundation and durable plan | No audited cost owner changed upstream; 480 tests and both TypeScript checks passed again on merged code `c157e98f7`; hosted CI running; no deployment or financial writes |
| 2026-10-30 | Verified #1964 merged at `80f5353b9`; recorded user-reported deployment and continued S2 on `codex/purchase-cost-source-compatibility` | Historical cleanup remains separate. Final S1 head had a cancelled browser shard/failed aggregate; cancellation cause not proven |
| 2026-10-30 | Added source-record/status compatibility, actual AP payment regression coverage and method-aware unused quote proof; retained unknown raw JSON evidence | 558 focused + 50 reader/cache + 259 real-owner SQL + 455 guard tests and both TypeScript checks passed. The expanded closed-health case exposed and now guards the extra landed-source dependency; publishing/hosted CI remain |
| 2026-10-30 | Incorporated current main #1965 at `f4e0c6dd8`, opened/attached #1967 and repeated validation | No costing implementation file changed upstream. All 608 unit/reader, 259 SQL and 456 guard tests passed, as did both TypeScript checks. Hosted CI is running; no deployment/live writes |
| 2026-11-01 | Verified #1967 merge `2ea5a8d2c`, final-head hosted results (51 successful / 2 skipped) and recorded reported deployment; started approved correction integration from pinned main | No upstream drift at the prepublication fetch. Each receipt keeping its own invoice cost is confirmed; tax example explained without selecting a treatment |
| 2026-11-01 | Added measured same-approval invoice/supplier-cost correction, exact remaining-stock values, shared human tasks, strict impact binding and legacy/retry protections | 639 unit/reader, 278 receipt/AP/freight SQL (19 new HTTP cases), 97 existing correction SQL, 52 browser and 456 guard cases passed; production/server/client-test TypeScript and production build passed. Full SQL started 08:32:03 local and completed in 322.91s; publication/hosted CI remain pending |
| 2026-11-01 | Published and attached non-draft #1971 from clean branch `codex/purchase-cost-approved-corrections`, implementation `49906226f4f5e489750591e4fdc771711ca8c550` | Final UI browser repeat passed all 52 cases. First hosted read: 7 queued, no failures; no hosted-green, deployment or live acceptance claim |
| 2026-11-01 | Verified the exact published implementation's new HTTP cases and the existing shared form/editor cases | All 19 HTTP cases passed again (36.88s). The 59 additional form/editor cases passed, giving 698 unit/reader/form cases across 24 files. No runtime edits followed |
| 2026-11-01 | Stopped the owned disposable local PostgreSQL cluster after validation | `pg_ctl` exited 0 with server stopped; its log confirms database shutdown at 08:41:54 local. No existing/live database or filesystem data was removed |
| 2026-11-01 | User authorized configured tax treatments in the existing flow; integrated main through `b82b7984c` and added explicit rule/assignment ownership, exact tax allocations, inherited receiving costs and current-admin measured approval/history | Initial actual migration constraints, 22 tax HTTP/receipt/stock/landed/historical tests, 458 guards and all three TypeScript projects passed. Expanded 301-case SQL, broad unit/browser regressions and production build are running; final-head publication/CI remain pending |
| 2026-11-01 | Completed tax candidate; preserved unchanged selected invoice sources instead of applying a legacy average when only superseded quote tax changes; added fresh actor-bound modal context, clear posted/readiness states and identity-safe before/after tax labels | 5,238 procurement unit tests / 296 files; 301-case full receipt/AP/freight SQL run plus final 26 tax cases; 122 desktop/mobile regressions plus 16 final tax repeats; 458 guards; three TypeScript projects and production build passed before final main #1973 integration. Four affected unit files repeated: 67 passed. Final publication checks/build are being repeated; no live writes |
| 2026-11-01 | Ran five additional real PostgreSQL suites via the existing isolated-database CI runner | 177 assertions passed: 97 PO/invoice amendments, 59 shipment commands, 12 workspace reads, 6 source-batching cases and 3 actual migration cases. Three runner database-drop operations hit the local 60-second cleanup timeout during concurrent load; their three exact generated database names were verified and removed successfully afterward. No application assertion failed; do not report the original runner exit as green |
| 2026-11-01 | Corrected first-head CI fixtures and completed connected tax acceptance | New tax tables are installed in the reduced connected database; its admin has the persisted system role plus current purchasing approval. Configured duty/tax command boundaries and policy/projection checks passed 122 cases. All five additional SQL suites reran successfully with clean runner exits. The 24 existing connected journeys passed. Added desktop/mobile real Settings → actual invoice tax approval → both PO-specific receipts → inventory cost processing → saved PO approval history coverage, with $25 bill = $20 product + $5 recoverable tax and unchanged billing/payments/approval records. Current main remains `26caa7551`; production/server/client TypeScript, production build and 458 guards passed. Hosted checks and deployment/live acceptance remain separate evidence |
| 2026-11-01 | Increased complete procurement browser partitioning after first-head CI timed out with passing progress | A 199-case browser shard exhausted the 20-minute job budget without reporting an assertion failure. Twelve complete shards replace eight; per-case limits, two workers, failure behavior and the required aggregate remain unchanged. The CI contract checks the full index set and matching shard total; 149 CI-contract/dependency-selection cases passed. Final tax-editor repeat passed 16 cases and connected tax repeat passed both desktop/mobile; the owned disposable test cluster stopped cleanly at 10:49:23 local |
| 2026-11-01 | Verified the configured-tax flow in hosted connected acceptance and removed a wider browser-helper race | `7b232f216` passed all 54 connected database/browser journeys across four shards, including actual tax configuration, approval, both linked receipts, inventory costs and original approval history. A wider mobile test checked for a line-edit button before relationship actions loaded and fell back to a non-interactive SKU. Waiting for the real edit action fixes that helper; all 40 desktop/mobile shipment-line command journeys passed locally afterward. Financial implementation and its controls are unchanged; final-head hosted gates remain tracked on #1971 |
| 2026-11-01 | Aligned the concurrent HTTP acceptance test with the existing financial command owner and integrated current main | The first complete hosted SQL file passed 303/304 cases; its strict simultaneous-200 expectation was invalid for an owner that explicitly permits `FINANCIAL_COMMAND_IN_PROGRESS`/`Retry-After`. Only that specific busy response is now accepted; replay must preserve the original result and financial state with one approval. A deterministic real-graph-lock test verifies the busy path and exact single-posted inventory amounts. No financial locking or idempotency behavior changed; logs now retain safe classified codes. Main #1974 at `9435b75d5` merged cleanly without purchasing/migration overlap. Full local SQL: 305 passed, followed by 27 final tax cases; all 56 desktop/mobile tax/editor journeys, production/server TypeScript and full build passed. The owned disposable cluster stopped after the final runs. Final-head hosted results remain linked from #1971 |
| 2026-11-01 | Completed the 75-check hosted baseline, then closed recorded-rejection recovery in the shared financial client | `a1161fbc0` passed all 75 hosted checks. A later review reproduced a trapped key after a definite stored authority rejection. Tax and invoice correction editors now share receipt-aware recovery: recorded rejections require a fresh reviewed key; unknown permission-gated outcomes retain the original key. Successful replay clears the stale prompt. The real SQL case proves restored authority cannot rewrite the old rejection and only the fresh approval posts. Validation: 42 unit, 28 tax SQL, 72 browser + 4 targeted invoice cases, plus 12 focused cases after non-overlapping main #1975 at `83b7e0ff5`; production/server/client-test TypeScript and full build passed. The disposable cluster stopped at 11:47:15 local. Final-head hosted results and review remain tracked on #1971; receipt-specific allocation remains the next implementation slice |
| 2026-11-01 | Verified deployed #1971 and prepared the next planned receipt-allocation branch from its merge | Final PR head `be1d01944` passed all 75 checks. Merge/current main/deployed slug are `e5d693686`; release v3437 succeeded, its tax migration completed and both web/inventory-capture processes are up. All 27 post-merge checks across both workflows passed. Production financial acceptance and live historical cleanup were not performed. [Receipt](procurement-costing-deployment-1971.md). Next: explicit receipt-specific invoice allocations; no averaging or guessed destinations |
| 2026-11-01 | Began #1979 from verified deployed #1971; traced line-wide selection and frozen receipt intervals | Added explicit interval contracts, allocated migration, same-owner supplier source/application integration, locked admin review/approval and initial shared UI. Initial 21 domain tests pass; one early application TypeScript pass predates the final UI. Full HTTP/SQL/browser/CI and production build remain pending. No live records changed. [Working trace](procurement-costing-stage-2-receipt-allocation.md) |
| 2026-11-01 | Published receipt-specific costing implementation to #1979; completed local financial regressions | Exact explicit receipt/invoice intervals replace line-wide averaging only for enabled lines. Uncovered pieces retain provisional PO costs; current-admin approval binds measured inventory/order/history impact. All new-line writers, including inline draft entry and recommendation handoff, enable the policy; historical siblings are preserved. 6,430 unit/owner tests, 325 full receipt/AP/freight SQL tests, 21 targeted receipt HTTP/SQL tests, 22 PO entry recovery tests, 4 actual migration tests and 18 mocked browser tests passed. Rebuilt connected desktop/mobile receipt acceptance passed; an isolated four-case repeat and final types/hosted CI are pending. Money-boundary preflight findings use exact readers without exemptions. No live records changed. [Detailed limits and evidence](procurement-costing-stage-2-receipt-allocation.md) |
| 2026-11-01 | Completed connected acceptance and closed the hosted return-action regression | All four rebuilt desktop/mobile tax/receipt cases passed, including teardown. All TypeScript projects and production build passed. A hosted unit failure exposed an inappropriate assignment action on no-inventory returns; the shared receipt-destination model now omits that action while retaining missing-proof review, and unreceived invoices lead to receiving. All 244 affected UI/domain/money tests passed. The owned test cluster is stopped and clean. Final-head hosted CI/review, deployment and production acceptance remain separate on #1979 |
| 2026-11-01 | Preserved the existing no-inventory return owner under the new receipt policy | Source review found the new policy must retain a fully credited pre-acceptance return with no receipt destinations, rather than require an inventory allocation. The original supplier-credit source and live application proof remain authoritative. All 83 focused return/source/UI unit cases and the real end-to-end quarantine credit case pass, including audit/reporting rollback, retries and no physical/COGS mutation. Accepted or contradictory receipt history cannot use this zero-effect disposition. Inventory-affecting receipt credits remain a separate adapter |
| 2026-11-01 | Verified hosted connected/type acceptance and completed the controlled RFQ fixture | Runtime head `16e59effa` passed all 56 connected procurement browser cases, all TypeScript projects and fast money/architecture guards. A PostgreSQL shard identified the controlled RFQ harness missing the new table; its declaration is now included. All four RFQ-to-receipt/sale/freight/settlement cases pass locally without changing financial assertions, including $4,610 conserved and no duplicate inventory/payment/credit effects. Final-head hosted CI remains tracked on #1979 |
| 2026-11-01 | Closed the real invoice-withdrawal status path | A new real AP-void regression reproduced stale confirmed inventory flags after receipt coverage became invalid. Unresolved receipt revisions now run the same provisional-state refresh while retaining posted amounts and approval history. All 22 receipt HTTP/SQL cases pass. A subsequent admin coverage correction also proves the valid receipt becomes confirmed again while uncovered pieces stay provisional and the original approval remains. No legacy source path or quantity/bill writer was replaced |
| 2026-11-01 | Corrected an unrelated hosted tracking-queue test assumption | SQL selects the two priority jobs but does not order its update results. The test now checks their exact identities and count instead of unspecified row order; all 46 real SQL returns cases passed locally. No shipping behavior or financial assertion changed. The browser aggregate reported this same dependency failure; final-head CI remains tracked on #1979 |
