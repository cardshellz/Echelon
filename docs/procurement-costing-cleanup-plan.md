# Purchase costing cleanup plan and tracker

This is the active tracker for consolidating purchase costing from PO through shipment, receiving, inventory and verified sales. Every implementation change, test result, PR and deployment verification for this cleanup belongs here. The linked audit preserves the evidence behind the work.

| Tracking field | Current value |
| --- | --- |
| Created | 2026-10-30 |
| Overall state | Planned; implementation has not started |
| Current stage | S1 — authoritative cost contract and source rules |
| Next work item | COST-01/COST-02: define the shared monetary projection and quantity-scoped source selection, with regression tests |
| Working branch | `codex/purchase-cost-authority-cleanup` |
| Plan branch base | `5f9e911a0c7506329624135d4a9a222842880962` |
| Audited main baseline | `e571bcac780852c3ac6b488354c10aaf7f1c417c`; reviewed costing paths were unchanged at the plan branch base |
| Audit | [Purchase costing authority review](procurement-costing-authority-audit-2026-10-30.md) |
| Current implementation PR | None |
| Deployment and live acceptance | Not started for this cleanup |

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
| COST-01 | F1: competing PO/shipment/inventory monetary projections | One selected monetary projection, including packaging, correct source precedence and exact scope totals, feeds every consumer | planned |
| COST-02 | F2: all-or-nothing invoice coverage | Approved invoices establish actual costs for their covered quantities; uncovered quantities stay provisional; overlaps and ambiguity are explicit | planned |
| COST-03 | F3: invoice corrections stop before costing | Approved corrections invoke the shared cost pipeline or commit a durable visible continuation with complete downstream impact | planned |
| COST-04 | F4: freight invoice and charge amount dead end | One approved reconciliation replaces the estimate, preserves its history, recalculates shares and updates downstream costs | planned |
| COST-05 | F5: non-economic changes invalidate costs | Payment progress and superseded quote edits preserve unchanged cost identity; real financial/source-authority changes remain controlled | planned |
| COST-06 | F6: transformed lots invalidate static completion | Completion accepts proven exact cost inheritance; genuine missing links/values have a direct resolution without repeat approval of unchanged money | planned |
| COST-07 | F7: unsupported breakdowns and adjustments | Known totals, optional breakdowns, discounts, taxes, credits and supplier freight have explicit source and inclusion/allocation rules | planned |
| COST-08 | F8: approval lacks a reviewed financial version | Ordinary invoice approvals and corrections bind the reviewed economics and downstream impact to the transaction | planned |
| COST-09 | F9: shared results lost at UI boundaries | Relationship identifiers and shared results survive every API; completed costs and approval details appear consistently; genuine issues expose the owning action | planned |

## Delivery stages and dependencies

Develop one coordinated candidate. Changes can be split into reviewable dependent PRs, but activation must not expose a mixture of competing costing owners. Each stage extends the existing owners and retains compatibility with recorded historical sources and approvals.

### S1 — Define the authoritative cost contract and source rules

Primary work: COST-01, COST-02, COST-05, COST-07.

- [ ] Define validated monetary contracts: selected source/revision, currency, quantity coverage, component/combined totals, allocated charges, provisional/confirmed state, application status and approval provenance.
- [ ] Define confirmed invoice coverage and provisional remainder behavior. Use explicit existing receipt/shipment links; document the rule for cases linked only to a PO line. Never choose an arbitrary historical stock destination.
- [ ] Define economic identity independently of settlement metadata and superseded supporting quotes. Preserve the audit of all source documents while invalidating costs only for relevant changes.
- [ ] Support known combined supplier amounts without fabricating a breakdown or counting combined and component amounts twice. Define a compatible representation and migration strategy before writing new financial rows.
- [ ] Resolve the applicable inclusion/allocation rules for adjustments, tax, credits, supplier freight and non-product PO charges.
- [ ] Trace ordinary order-cost updates through reporting/recognition to establish the verified-sale boundary before changing COGS behavior.
- [ ] Add target-behavior regression tests for source precedence, partial coverage, known zero, unsupported/invalid input, exact totals and economic identity.

Exit evidence: agreed contracts/rules, exact source ownership map, bounded compatibility plan and passing domain tests. No production migration or financial backfill is implied by this stage.

### S2 — Connect financial mutations and approval to one update pipeline

Depends on the applicable S1 contracts. Primary work: COST-03, COST-04, COST-08.

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
| Allocation where invoices identify only a PO line | Decision needed in S1 | Document and test the deterministic rule before assigning actual costs to specific receipts/lots |
| Tax inclusion/recovery and allocation of header/non-product adjustments | Decision needed in S1 | Follow an explicit approved business/accounting policy; do not infer it from a residual |
| Known total with unknown product/packaging split | Agreed principle; representation needed in S1 | Preserve the full known amount once and keep the unknown breakdown explicit |
| Foreign currency | Existing unsupported/review boundary retained | Do not activate guessed FX conversions; broader currency support needs its own approved rule/scope |
| Ordinary order cost basis versus recognized COGS | Verification needed in S1 | Trace the actual recognition boundary and enforce verified sales consistently before changing postings |
| Historical production dollar exposure | Not measured | Use separate read-only comparisons and specific reviewed corrections |

These dependencies do not stop unrelated contract, identity, preview or consumer work. Ask only the focused business questions that cannot be answered from existing approved policy or source evidence.

## PR and release ledger

Add exact identifiers as work exists. A proposed slice is not an existing PR or deployment.

| Slice | Intended contents | PR/commit | Local evidence | Hosted CI | Deployment/live proof |
| --- | --- | --- | --- | --- | --- |
| Plan and audit | This tracker, baseline audit and synthetic characterization evidence | Record the documentation commit in Git history | Documentation links and synthetic evidence checks | Not run for implementation | No runtime change |
| Contract foundation | S1 contracts, economic identity, source rules and compatibility tests | Not created | Not run | Not run | Not deployed |
| Commands and downstream application | S2-S3 owning workflows, approvals, inheritance and safe recovery | Not created | Not run | Not run | Not deployed |
| Shared consumers and complete acceptance | S4-S5 connected readers, actions and full acceptance | Not created | Not run | Not run | Not deployed |
| Rollout and historical review | S6 manifest, read-only comparisons and specifically approved corrections | Not created | Not run | Not run | Not deployed |

Final PR boundaries follow verified dependencies and reviewable size. If a slice is split, update this ledger and keep the complete candidate coherent; do not turn it into unrelated screen-by-screen implementations.

## Evidence already collected

- [Pinned code audit with exact functions and limitations](procurement-costing-authority-audit-2026-10-30.md).
- [Synthetic characterization source](evidence/procurement-cost-authority-audit-20261030.ts) and [captured output](evidence/procurement-cost-authority-audit-20261030.json).
- At the audit baseline, 379 existing unit tests passed across 13 focused files. The historical characterization reproduces current defects; those passing checks are not acceptance of the new design.
- The audit did not execute PostgreSQL/full browser acceptance or measure production exposure. Those remain explicit work above.

The evidence script is a baseline diagnostic outside normal test discovery. Its assertions intentionally characterize the audited behavior. Implementation must add target-behavior tests to the real suites, retain this dated evidence, and avoid treating a later diagnostic assertion failure after a fix as a production regression.

## Current handoff

**Completed:** reviewed merged code, identified F1-F9, executed focused unit suites and synthetic diagnostics, agreed the six-stage cleanup approach, and persisted this tracker plus its evidence.

**Implementation state:** no COST item or S1-S6 exit gate is complete. No costing implementation, migration, historical correction or live financial change has been performed for this cleanup.

**Next action:** begin S1 by inventorying every monetary reader/writer against the ownership contract, then define the selected-cost/quantity-coverage contract and its target regression tests. Reproduce the $1,000 PO + $1,200 approved invoice + $200 freight discrepancy as a failing target test, and add payment-only identity and partial-invoice coverage cases.

**First code entry points to inspect:**

- `server/modules/procurement/domain/purchase-cost-source.ts`: `resolvePurchaseCostSource`.
- `server/modules/procurement/purchase-cost-application.service.ts`: source recording and supplier application.
- `server/modules/procurement/shipment-cost-revision-proposals.ts` and `shipment-cost-source-identity.ts`: landed source/economic identity.
- `shared/procurement/po-line-landed-cost.ts` and `server/modules/procurement/domain/po-shipment-cost-summary.ts`: competing monetary projections.
- `server/modules/procurement/invoice-quantity-correction.repository.ts` and `ap-ledger.service.ts`: correction/approval integration.
- `server/modules/inventory/application/apply-cost-revision.ts` and `cogs.service.ts`: existing downstream owners and sale-recognition boundary.

**Open dependencies:** S1 business-rule decisions above. Do not fill them with guesses or pause independent work unnecessarily.

**Before the next handoff:** update current stage, work item states, changed files, exact validation results, PR/commit state, any remaining decisions and the next concrete action.

## Change log

| Date | Change | Evidence/state |
| --- | --- | --- |
| 2026-10-30 | Established the active cleanup tracker, preserved all nine audit findings and synthetic evidence, and recorded ownership rules, stages, acceptance and resumption procedure | Planning/evidence only; implementation not started |
