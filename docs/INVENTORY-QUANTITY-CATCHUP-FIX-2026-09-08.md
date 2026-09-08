# Inventory quantity catch-up fix — 2026-09-08

## Summary of changes

Focused follow-up to merged PR #1417, based on `origin/main` commit `c724e8c01aee9ae4f7b684aa0418e2a98fff56a9`.
Implementation is isolated on `codex/inventory-catchup-scope-fix`. At the pre-PR local-validation handoff, no PR, deployment, activation, production mutation, or migration had been performed for this follow-up.

The investigation found valid Shopify feed mappings were ignored by the catch-up owner lookup. eBay retries invoked whole-product publication across unrelated channels, including the internal manual Dropship channel. Even an already successful exact delivery was checked only after this failing replan.

## What the code definitely does

| Behavior | Exact implementation evidence |
| --- | --- |
| Checks recorded exact delivery before attempting another replan. | `server/modules/inventory-planning/application/quantity-publication-admission.port.ts:42`, `QuantityPublicationCatchupService.processDue`. |
| Completes only the same pending revision, boundary and scope, under gate-then-scope locks. Rejects unresolved attempts, superseded success, wrong gate epoch and incorrect canonical outbox lineage. | `server/modules/inventory-planning/infrastructure/quantity-publication-admission.repository.ts:435`, `PostgresQuantityPublicationAdmission.complete`. |
| Resolves current Shopify feed/location or eBay listing/feed ownership through the exact connection. Does not substitute a global catalog SKU or historical canonical mapping. Disabled channels, ambiguity and stale ownership hints remain errors. | `server/modules/channels/infrastructure/channel-quantity-publication-catchup.repository.ts:19`, `resolve`; line 39, `resolveUsingClient`. |
| Keeps full-product allocation calculation intact, including internal channel allocations, but publishes only the retained channel variant. Shopify is additionally narrowed to one location. | `server/modules/channels/echelon-sync-orchestrator.service.ts:330`, `syncInventoryForPublicationTarget`. |
| Constrains actual provider admission without creating a synthetic provider attempt during mapping/planning. Actual provider admission rechecks destination identity and legacy authority before I/O. | `server/modules/inventory-planning/infrastructure/quantity-publication-admission.repository.ts:155`, `withLegacyCatchupScope`; line 239, `execute`. Runtime composition: `server/modules/inventory-planning/infrastructure/quantity-publication-runtime.ts:86`, `createQuantityPublicationCatchupService`. |
| Sends an explicitly calculated zero to the retained Shopify location even after its last physical placement disappears; does not invent a zero for a positive allocation missing its warehouse plan. | `server/modules/channels/echelon-sync-orchestrator.service.ts:747`, `pushInventoryToChannelWarehouseAware`. |
| Does not treat a location-only success as proof of a whole-channel aggregate watermark. | `server/modules/channels/echelon-sync-orchestrator.service.ts:889`, `pushInventoryToChannelWarehouseAware`. |

## What is likely happening / hypotheses

HYPOTHESIS: after deployment, pending rows with valid current exact-scope delivery evidence will close without another provider write; other valid rows will retry only their retained destination. This is supported by the regression tests, not by a post-deployment production observation.

## What is not proven

- This local fix has not been deployed. The production backlog has not been rechecked after the fix.
- Provider request confirmations are not an independent storefront quantity readback.
- This follow-up does not activate canonical ATP or establish completion of the broader inventory cutover.
- GitHub CI had not run at the pre-PR local-validation handoff. Local validation used the CI inventory PostgreSQL matrix; consult the new PR checks for subsequent CI results.

## Assumptions and preserved behavior

- No new ATP formula, inventory policy, channel allocation setting, or manual-channel exclusion was introduced.
- Legacy eBay mapping precedence remains listing SKU, then feed SKU, then catalog SKU only when a current channel mapping exists. This fix does not redesign eBay listing lifecycle policy.
- Existing production authority and configuration are left untouched. Unrelated original-checkout changes are preserved.

## Test coverage

- `npm run test:unit`: **11,277 passed**, 37 skipped; 984 files passed, one file skipped.
- Inventory PostgreSQL CI matrix, including the two new test files: **409 passed across 25 files**, no skips. Tests used explicitly disposable databases on localhost PostgreSQL 17; suite-owned databases were removed on completion.
- `npm run check`: passed.
- `npm run build`: passed; build reports the large-client-chunk warning.
- `git diff --check`: passed.

Regression coverage includes valid Shopify feeds absent canonical history, eBay cross-channel isolation, SKU/location remapping, disabled/quarantined mappings, duplicate ownership, current zero quantities, incomplete/mismatched adapter results, newer coalesced revisions, lock contention, uncertainty, suppression, superseded canonical outboxes, and an authority change before actual provider admission. Mapping SQL tests use a reduced named-schema fixture; publication/admission tests install the actual cutover migrations and retain their triggers.

## Risks and failure modes

- Missing, ambiguous or disabled mappings remain pending with explicit errors; no alternate destination is guessed.
- Actual uncertain provider outcomes still require reconciliation. The fix does not erase uncertainty or use elapsed time as proof.
- The legacy attempt journal records successful exact-scope owner completion, not a separate fresh-ATP calculation tag. No new schema or broader proof policy is introduced here.

## Next checks

Create a new PR when authorized; do not reuse merged PR #1417. After merge and deployment, read-only verification should confirm the retained backlog closes, unrelated channel writes are absent from scoped retries, and provider quantities agree with the intended current allocation. Do not activate ATP authority or change production configuration as part of that verification.
