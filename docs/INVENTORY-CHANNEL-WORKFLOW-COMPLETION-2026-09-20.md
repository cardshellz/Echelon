# Channel Inventory — coordinated completion batch

## Scope and status

This expands the [earlier UI batch](INVENTORY-UI-COMPLETION-BATCH-2026-09-20.md)
on `codex/inventory-ui-cutover-completion-20260920`. Both batches are delivered in
**one PR**, not separate deployments. The original dirty catalog checkout is untouched.

Final integration base: refreshed `origin/main` at
`a06e994a363c41bb4fd2c51d3e317608884134a8` (PR #1506). The existing SKU publication
holds from that workstream are preserved and tested with source overrides and
restored inheritance. This branch has its own PR; it is not part of PR #1506.

It completes the channel-workspace workflow: warehouse supply, channel defaults,
product/SKU exceptions, restoring inheritance, whole-channel Review → Apply,
and recorded delivery visibility. It uses the existing canonical ATP planner,
definition lifecycle, admission fence and publication outbox. No new ATP equation
or inventory posting service is introduced.

This is implementation and local test evidence, **not production acceptance or
activation**. No production inventory, reservations, recipes, configuration,
channel quantities or runtime authority were changed during this work.

## Confirmed behavior and code owners

| Action | Behavior | Exact owner |
| --- | --- | --- |
| Select default warehouses | Existing destination binding remains the default supply set | [`SupplyTab`](../client/src/features/channel-inventory/components/SupplyTab.tsx#L23); [`saveSourceBindingDraft`](../server/modules/inventory-planning/infrastructure/inventory-channel-exposure-admin.repository.ts#L928) |
| Override product/SKU warehouses | SKU selection wins over product selection, then destination default. An override replaces the whole set, never unions it | [`RuleEditor`](../client/src/features/channel-inventory/components/ExceptionSheet.tsx#L187); [`resolveChannelSourceOverride`](../server/modules/inventory-planning/domain/inventory-channel-exposure.ts#L163); [`planTarget`](../server/modules/inventory-planning/application/inventory-channel-exposure-runtime.service.ts#L244) |
| Adjust channel/item dials | Existing field-by-field SKU → product → channel inheritance and existing server arithmetic | [`resolveChannelExposurePolicy`](../server/modules/inventory-planning/domain/inventory-channel-exposure.ts#L107), [`calculateChannelExposure`](../server/modules/inventory-planning/domain/inventory-channel-exposure.ts#L179) |
| Restore all inheritance | Explicit `inheritAll` version follows future parent changes after Apply; does not copy current parent values or delete history | [`policyFormToValue`](../client/src/features/channel-inventory/model.ts#L379); [`channelExposurePolicyValueSchema`](../shared/types/inventory-channel-exposure.ts#L51) |
| Save | Actor, time, request identity, before/after audit; optional note, no mandatory reason; no publication | [`InventoryChannelExposureAdminService.savePolicyDraft`](../server/modules/inventory-planning/application/inventory-channel-exposure-admin.service.ts#L195); [`savePolicyDraft` store](../server/modules/inventory-planning/infrastructure/inventory-channel-exposure-admin.repository.ts#L790) |
| Review | All pending channel policy/source/mapping heads, not just the displayed product; affected live targets across channels share one fresh inventory snapshot | [`captureReview`](../server/modules/inventory-planning/infrastructure/inventory-channel-definition.repository.ts#L86), [`loadChanges`](../server/modules/inventory-planning/infrastructure/inventory-channel-definition.repository.ts#L174), [`loadChannelDefinitionReviewTargets`](../server/modules/inventory-planning/infrastructure/inventory-channel-exposure-runtime.repository.ts#L209) |
| Apply | Activation permission, fresh review-hash check, exact promotion, existing publisher/outbox and immutable receipt in one transaction | [`registerChannelDefinitionRoutes`](../server/modules/inventory-planning/interfaces/http/inventory-channel-definition.routes.ts#L7); [`PostgresChannelDefinitionStore.apply`](../server/modules/inventory-planning/infrastructure/inventory-channel-definition.repository.ts#L23) |
| Retry | Original actor-bound command/key; one committed application under concurrent retries | [`ChannelDefinitionReview`](../client/src/features/channel-inventory/components/ChannelDefinitionReview.tsx#L19); [`ChannelDefinitionService.apply`](../server/modules/inventory-planning/application/inventory-channel-definition.service.ts#L25); store idempotency lock at the Apply link above |
| Check delivery | Requested, accepted and observed quantities remain separate; unknown is not zero; reads recorded evidence only | [`PublicationStatus`](../client/src/features/channel-inventory/components/PublicationStatus.tsx#L16); [`ChannelPublicationStatusService.read`](../server/modules/inventory-planning/application/inventory-channel-publication-status.service.ts#L16); [`PostgresChannelDefinitionStore.progress`](../server/modules/inventory-planning/infrastructure/inventory-channel-definition.repository.ts#L54) |

Source files:

- [UI components](../client/src/features/channel-inventory/components/), [form model](../client/src/features/channel-inventory/model.ts)
- [Domain resolver](../server/modules/inventory-planning/domain/inventory-channel-exposure.ts)
- [Channel Apply store](../server/modules/inventory-planning/infrastructure/inventory-channel-definition.repository.ts)
- [Channel Apply service](../server/modules/inventory-planning/application/inventory-channel-definition.service.ts)
- [Runtime planner adapter](../server/modules/inventory-planning/application/inventory-channel-exposure-runtime.service.ts)
- [Runtime definition reader](../server/modules/inventory-planning/infrastructure/inventory-channel-exposure-runtime.repository.ts)
- [Audited draft store](../server/modules/inventory-planning/infrastructure/inventory-channel-exposure-admin.repository.ts)
- [Apply contract](../shared/types/inventory-channel-definition.ts), [policy contract](../shared/types/inventory-channel-exposure.ts)

### Example

A destination defaults to Main Warehouse. BOX overrides supply to Main plus
Canada. BOX-C25 overrides it again to Main only; BOX-P5 inherits the product's two
warehouses. Existing ATP is computed independently in each selected warehouse
before the existing exposure rule is applied. A case cannot be assembled from
pieces split between warehouses.

Restore all inheritance on BOX-C25, then Apply, makes it follow BOX's warehouse
selection and selling rules, including later changes. This is availability
exposure, not a stock transfer or an order-fulfillment routing command.

## Atomicity and locks

1. Validate strict input and session actor; hash the complete logical command.
2. Begin READ COMMITTED; acquire the idempotency advisory lock and replay any
   matching committed receipt before attempting a new mutation.
3. Acquire the existing canonical cutover/admission exclusion fence before
   definition, inventory, order or publication locks. It drains authority users
   and uses the existing non-waiting admission behavior.
4. Recapture the complete review. Changed inventory, heads or target evidence
   invalidates the hash. No partial product subset may be applied.
5. Promote through `promoteInventoryCutoverDefinitionsInsideTransaction`;
   `enqueueReviewedDefinitionPublication` uses the existing transaction-scoped
   publisher and checks quantities/target membership against the review.
6. Persist the immutable review/receipt and commit. Any error rolls back heads,
   versions, outbox and receipt together. A failed rollback discards the connection.

Read-only review uses repeatable-read evidence. Limits are explicit: 1,000 affected
products, 10,000 pending definitions and 100,000 quantity rows. Oversized scope is
rejected, never silently truncated. Queries have lock and statement timeouts.

The additive migration stores source overrides and inheritance on the existing
versioned policy, plus immutable application receipts. A database-maintained
reference index supplies real foreign keys for the warehouse-node array, including
concurrent deletion protection; it is not independently editable configuration.
The migration selects no definitions and changes no physical quantities, target
states, provider ownership or runtime authority.

Migration: [`0686_inventory_channel_definition_completion.sql`](../migrations/0686_inventory_channel_definition_completion.sql#L1).
The number was selected after integrating main's 0684/0685 migrations; the full
unit run includes the migration-prefix collision guard.

## Failure modes and boundaries

- Missing/inactive/duplicate override warehouses block live publication; no
  implicit all-warehouse or destination-default fallback.
- Incomplete channel defaults block review even without a live destination.
- Malformed Apply results are uncertain/server errors, not definitive input
  rejections. The browser retains the original key for recovery.
- Established marketplace identities cannot silently be redirected. Otherwise
  the previous listing might retain advertised stock. That operation still needs
  an explicit identity-retirement/replacement workflow. New mappings and unchanged
  identities are supported.
- Cross-channel partition checks use each SKU's actual resolved warehouse set.
- Stopped destinations stay stopped; external/manual owners stay unchanged.
  Live Echelon updates are queued, not instantly declared provider-verified.
- Before canonical cutover, drafts can be saved but routine Apply cannot activate
  migration. Resume continues to use active definitions, never pending drafts.
- Browser navigation guards are not durable offline storage; forced closure or a
  crash can lose an unconfirmed local command.
- Rollback after applying new source overrides/inheritance is not a blind code
  downgrade: older readers do not understand those fields. Keep affected
  publication stopped until an explicitly reviewed compatible policy is restored
  or the forward fix is deployed. Retain immutable receipts and policy history;
  this additive migration is not a data-deletion rollback script.

## Validation

Final local results after integrating main, including its SKU publication holds:

| Check | Result |
| --- | --- |
| `npm run check -- --incremental false` | Passed |
| `npm run check:tests` | Passed (server and client test TypeScript) |
| `vitest run unit --maxWorkers=4` | 13,898 passed; 39 skipped; zero failed |
| `scripts/ci/postgres-tests.ts`, all eight shards | 86 suite files; 1,339 passed; zero skipped or failed |
| `playwright.inventory.config.ts` | 56 passed, desktop and mobile |
| `catalog-conversions.spec.ts` in the Dropship browser configuration | 28 passed, desktop and mobile |
| Desktop/mobile visual inspection | Channel Apply and SKU warehouse editor screenshots inspected |

Database checks used the repository's isolated-per-suite runner against an owned
localhost-only disposable PostgreSQL cluster. That cluster was stopped after
validation; existing database services were not stopped or reconfigured.
Browser/provider APIs are mocked; none are production acceptance tests. GitHub
CI has not been counted as passing by this local validation record.

Two unchanged migration files (0678 and 0683) were mechanically normalized to LF
locally for existing literal-newline tests; their Git-normalized content is not
changed by this PR. A type-only narrowing of the historical OMS identity-repair
repository's Drizzle schema avoids TypeScript's excessive-instantiation limit
after adding the schema relations; its runtime operations are unchanged.

Focused proofs cover source precedence, inheritance, audited save/reset round
trips, reference integrity, stale reviews, immutable receipts, rollback after
outbox insertion, concurrent Apply retries, unchanged stock/claims/authority/
target states, identity-remapping rejection, role gates, mobile layout and exact
retry after an ambiguous response.

## Not proven / next operational check

Production was not queried; no hypothesis about its current readiness is made.
After review and deployment, inspect actual opening stock and obligations, run the
existing full cutover preview, review warehouse/channel quantities, and obtain
explicit authorization before activation. Fixture success is not physical-stock proof.

New provider adapters, 3PL operational feeds, location promise-policy
administration and post-cutover legacy retirement are not implemented by this
batch. They remain separate from completing Channel Inventory controls.
