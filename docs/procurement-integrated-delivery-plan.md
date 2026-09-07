# Procurement integrated development and ordered rollout

The coordinated implementation is recorded in [the integrated acceptance ledger](procurement-integrated-acceptance.md). Use [the release manifest](procurement-release-manifest.md) for exact local commits, evidence, deployment order and remaining publication/production steps. The delivery decisions below retain the original planning context.

## Delivery decision

Develop the remaining procurement overhaul as one coordinated program. Production deployments are rollout checkpoints, not prerequisites for starting dependent development. This records the user's requested workflow change: complete and test the system together, then deploy compatible releases in order.

This is a delivery plan, not a claim that the remaining implementation exists. The current cost dependencies are documented in [the cost application design](procurement-cost-application-design.md#proposed-system-contract), [the shipment and descendant trace](procurement-cost-shipment-trace.md), and [the real-owner database proof](procurement-cost-test-proof.md). Those tests already demonstrate why isolated successful components do not establish a correct combined flow.

## One scope and acceptance ledger

Track the original requirements in one ledger with `verified complete`, `implementation needed`, `verification needed`, or `decision needed`, backed by source and test evidence. Existing behavior must be inspected before being marked complete or replaced. The program covers:

- Daily proposed RFQs/POs for human review, including what, when, quantity, preferred supplier, projected cost, and the reason for each recommendation.
- Historical demand windows, growth overlays and explicit lumpy forecasts; stock targets, lead-time stages, essential-item service policy, MOQs, order multiples and freight efficiency.
- Continuous RFQ -> PO -> production -> shipment -> receipt navigation, including split deliveries and consolidated shipments, with source detail available in context.
- Production/in-transit/received inventory value and arrival forecasts, separate from pickable availability.
- Explicit product, packaging, freight and other cost sources; invoice/payment visibility; reliable inventory valuation, downstream COGS, and a versioned future Archon export contract.
- Single-operator efficiency with configurable roles and controls, immutable history, recoverable failures and auditable corrections.

Carrier visibility and an operational Archon connection depend on real external interfaces and access. Define and test the integration boundaries while developing the program; do not label a mocked adapter or undelivered export as operational.

## Development structure

1. Establish shared domain contracts first: quantity units, source identities, component authority, revision/application identity, errors, permissions, and transaction/locking responsibilities. An interface decision can block dependent code; a production deployment is not required to resolve it.
2. Keep an integration branch containing the complete candidate system. Allocate bounded workstreams to agents in separate worktrees with explicit file ownership. Merge their work into the candidate frequently rather than waiting for a production release.
3. Develop recommendation/planning behavior, procurement workflows, financial/source propagation, and UI/reporting concurrently once their contracts are compatible. Verification of existing functionality proceeds alongside implementation.
4. Maintain an ordered PR series. A dependent PR can build on a prior PR branch while that prior PR is still under review. Record each dependency and refresh/retest dependent branches when their bases change.
5. Keep a release manifest containing PR/commit, prerequisites, migrations, default activation state, tests, compatibility limits, validation steps, and recovery procedure. The final candidate and every deployable prefix must pass the tests relevant to the behavior they expose.

## Proposed release groups

These groups describe deployment dependencies, not a serial development schedule. Final PR boundaries follow the verified code dependencies and reviewable size; there is no fixed promise of one PR per row.

| Group | Release content | Requirement before activation |
| --- | --- | --- |
| Existing containment | Reviewed invoice metadata/input/audit fix, tracked in PR #1391 | Required checks on the actual reviewed head |
| Source contracts and compatible schema | Explicit quantity/cost/component evidence, immutable revisions, additive storage, readiness reads | Current application can coexist with new schema; old rows retain explicit unknowns |
| Inventory lineage and cost application | Receipt and transformed-lot contributions, versioned application, transactional cost/COGS updates and durable recovery | All affected inventory owners follow a proven lock/version protocol; incomplete lineage is visible |
| Complete workflow and workspace | Cost trace, source drill-down, invoice/receipt/shipment continuity, status and reporting consumers | UI and consumers distinguish estimates, recorded values, applied revisions and review cases |
| Planning and daily review completion | Verified recommendation/forecast/MOQ/lead-time behavior and its links to the full purchasing lifecycle | Complete user journeys and recommendation explanations pass their acceptance scenarios |
| Controlled activation and historical review | Enable verified behavior, then separately reviewed historical corrections and downstream integration activation | Readiness evidence, explicit scope, production validation and a documented recovery route |

Planning and workspace work can be developed before the financial groups ship. Their release placement must follow their actual dependency graph. Feature activation should be distinct from code availability where that enables a compatible rollout; a flag by itself is not proof that incompatible schemas or financial writers can coexist.

## Combined verification and rollout rehearsal

The complete candidate needs actual database and browser journeys across the connected system. Required scenarios include both invoice/freight/receipt event orders, source revisions, split/consolidated shipments, partial receipts, credits, exact remainders, frozen units, transfers/conversions/builds, sold-order COGS, concurrency, rollback and lost-response retries. See the detailed cost proof for current observations and remaining gaps.

Also exercise the deployment sequence from the currently supported application/schema state: apply each migration and release in order, run that step's verification, and confirm that exposed behavior does not rely on a later undeployed release. Rehearse disabling the new behavior and running the supported previous application where compatibility permits it.

Code rollback does not reverse already committed inventory or cost transactions. The current receiving transaction and post-close PO reconciliation are separate phases, and cost revaluation writes persisted lot/OMS/audit data; see `server/modules/procurement/receiving.service.ts:1206–1525`, `server/modules/inventory/cogs.service.ts:207–310`, and the baseline references in the cost design. Recovery must distinguish disabling future work, restoring a compatible application version, and making separately audited corrective entries. Preserve historical source and posting evidence.

## Decisions and external dependencies

Collect business questions together and continue independent development while answers are pending. Invoice packaging can be included, separate, or unresolved; short/damaged goods can require different dispositions. Support explicit evidence and review states in the design rather than selecting an accounting outcome from an unexplained numeric residual. The user's answers determine the eventual rules and activation configuration.

Pause only the work that genuinely depends on a missing business decision, external integration, unproven compatibility condition, or authorization for production action. Report the exact dependency and continue the unaffected workstreams. Deployments, historical financial corrections, and integration activation remain separate actions with their own concrete reviewable scope.

## Completion package

Deliver the complete tested candidate, an ordered PR/release manifest, the acceptance ledger, migration/activation steps, production verification checks, recovery procedures, and any specifically unresolved external dependencies. The operator should be able to deploy the prepared sequence without repeatedly requesting the next development slice.
