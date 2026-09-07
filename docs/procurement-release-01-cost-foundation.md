# Procurement release 1: immutable cost evidence

Prerequisite: invoice metadata containment PR #1391 (`494c461f0f8327d96896220501fddd90cfc1603f`). This is the first prepared release of the coordinated procurement candidate.

## Behavior and scope

Migration `222_procurement_cost_evidence.sql` adds nullable receipt/invoice component evidence and immutable source revisions, receipt origins, transformation contributions, component protections, applications, reporting events and receipt cost recovery requests. It does not reprice historical inventory or infer missing links. The source recorder and exact integer-mill allocation domain are available for subsequent owning services.

This release does not connect the new cost application engine to receiving, AP or freight. Those connections are a later release. Its receipt/invoice schema additions coexist with the prerequisite application's writers. New historical fields remain null until a later owner records explicit evidence.

`recordCostRevision` in `server/modules/procurement/cost-source-revision.repository.ts` serializes revisions using the inventory graph transaction lock, retains the complete raw source payload, and replays only the latest identical revision. A change A → B → A produces three revisions. `recordReceiptCostOrigin` and `recordLotCostContribution` in the inventory infrastructure repository own lineage validation and immutable insertion. The pure `cost-application.domain.ts` uses integer arithmetic and preserves allocation residuals explicitly.

## Verified release boundary

- Full unit selection on this release: 885 files passed, 1 existing skipped file; 8,770 tests passed and 37 skipped.
- TypeScript passed.
- Five actual PostgreSQL cases passed in `procurement-cost-evidence.integration.test.ts`: additive migration replay with historical values preserved, exact raw source capture, latest-revision replay, A → B → A history, concurrent deduplication, immutable update/delete rejection, and owning-transaction rollback.
- The writer baseline adds only the intended inventory lineage and procurement source-revision owning modules. The writer-ratchet is included in the full unit run.

These are the original prepared-candidate checks. The unpublished release was refreshed onto the updated prerequisite before bulk publication; the procurement patch is unchanged apart from trailing whitespace and this documentation. GitHub CI must pass on the published head. These checks use synthetic rows in a separate disposable local PostgreSQL database. They do not establish production data completeness, production migration duration or financial balances.

## Deployment and recovery

`Procfile` invokes `scripts/release.sh`; that script runs `migrations/run-migrations.ts` before the web release. The runner processes pending SQL files in filename order and stops release on a migration error. Apply this release before deploying any later consumer of migration 222. Startup fallback DDL is not the migration proof for these tables.

After the release, verify the migration ledger records `222_procurement_cost_evidence.sql`, the added tables and immutable triggers exist, and the existing receipt/invoice screens load. No new workflow activation or production financial backfill is included.

Retain the additive schema when reverting application code. Dropping evidence tables is not a code rollback. Once later releases record physical lineage, reverting below the compatible lineage writer release can lose new transformation evidence; the complete release manifest identifies that boundary. Reverting code never reverses inventory, invoice, payment or COGS transactions that already committed.

## Remaining boundaries

The complete candidate's financial/UI/planning releases consume these contracts. Historical lineage recovery, signed-credit disposition, protection release policies, carrier feeds and external accounting delivery remain explicit independent boundaries. A stored reporting event here does not mean that Archon received or booked anything.
