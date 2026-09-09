# Shared shipping configuration

Implemented locally on `codex/shared-shipping-programs-and-box-suites`. No production settings, orders, vendor balances, or marketplace listings were changed.

## Ownership and assignment

| Concern | Authority | Assignment |
| --- | --- | --- |
| Box/mailer/envelope dimensions, tare, cost, active state | Shared Shipping Settings box catalog | One canonical identity per physical packaging specification |
| Warehouse availability | Shared box catalog warehouse availability | A box may be available at several warehouses |
| Packaging choice | Named, revisioned box suite | Channel default, optionally replaced by one warehouse-specific suite |
| Rates, coverage, markup, insurance charge | Shared pricing program | Existing pricing-program/channel-routing assignments |
| Dropship quote service | Configured fulfillment service level | One Dropship default; carrier methods remain service-level-owned |
| Carrier coverage, claims, credits | Existing carrier protection subsystem | Unchanged; an insurance charge does not purchase coverage |

Packaging is selected independently of the pricing program. `channel + warehouse` resolves one suite; there is no implicit union and no `warehouse + pricing program` cross-product. The suite's current members are intersected with active catalog boxes and warehouse availability.

The channel keys are the existing shipping-engine business profiles: `dropship`, `shopify`, `ebay`, and `internal`. They are not individual vendor stores or arbitrary OMS channel IDs. Manual/API/other unmarked WMS orders retain the internal profile. Accepted internal Dropship OMS orders and explicitly marked Dropship channels use the Dropship profile.

Warehouse availability retains the existing compatibility convention: no availability rows means available at all warehouses; once rows exist, the box must have an enabled row at the requested warehouse. This is availability configuration, not consumable box-inventory tracking.

## Concrete runtime trace

1. `SharedShippingConfigurationRepository.loadPackaging` reads assignment, suite revision, members, active state, warehouse availability, and box specifications in one database statement. `resolvePackagingAssignment` chooses an exact warehouse binding before the channel default. Missing/empty assignments fail explicitly.
2. `BasicDropshipCartonizationProvider.cartonize` uses that resolved suite and physical facts from the canonical product catalog. Migrated packing preferences preserve existing package boundaries without reading the old Dropship package-profile table. An old preferred box is honored only while it is available in the assigned suite; otherwise the suite supplies the choices and an internal warning records the ignored preference. Existing degraded-weight-only handling for incomplete product dimensions remains; this change does not invent missing product measurements.
3. `ensurePackPlan` in the cartonization application uses the same suite resolver for WMS. Its hash includes the configuration evidence; persisted pack plans retain the exact suite/assignment revisions and box specifications. Changed revisions cause a new plan rather than rewriting old evidence.
4. Inner dimensions determine fit. When supplied, outer dimensions determine parcel dimensions and dimensional weight. Existing boxes without measured outer dimensions retain their prior dimensional estimate. The API and database reject partial or undersized outer dimensions.
5. `quoteShipmentRates` applies `applyProgramCharges` after the selected program's rate/product rules. Percentage arithmetic uses integer/BigInt cents, floors each percentage, then adds the flat amount and applies minimum/maximum caps. Markup uses the base rate; insurance charge uses base plus markup.
6. `SharedEngineDropshipShippingQuoteProvider.quote` selects the configured service level, not a hardcoded Standard service. `calculateDropshipShippingQuote` produces version-4 pricing evidence for persistence and does not read/add legacy fee policies when the shared engine supplies the charge evidence. Historical quote replay remains unchanged.
7. The existing vendor estimate response stays total-only. Internal fees, rate-table identifiers, and calculation evidence are not added to the customer DTO or UI.

## Administration

- Shipping Settings > Boxes: shared catalog, named suites, bounded membership editor, affected-assignment summary, and channel/warehouse assignment form.
- Shipping Settings > Pricing programs > program detail: editable percentage plus flat markup/insurance charge, optional caps, revision, and audit history.
- Dropship > Shipping: pricing program, packaging suite, and fulfillment-service selections. Links lead to their shared editors; no new navigation item.
- If `DROPSHIP_OMS_CHANNEL_ID` binds canonical channel routing, the versioned channel-routing editor remains the program assignment authority. The simplified page does not bypass destination/warehouse routing with a second writer.
- Legacy Dropship box/profile/zone/rate/markup/insurance write endpoints return 410. Read-only history remains available. Carrier protection controls are retained separately.

Configuration commands use authenticated actor identity, strict request validation, transactions, stable retry keys, expected revisions, and immutable audit history. Stale edits conflict rather than overwriting another administrator. Suite changes that strand an assigned warehouse are rejected. The history UI loads only when expanded.

## Migration and rollout constraints

`238_shared_packaging_and_program_charges.sql` is deliberately one migration because `executeMigrationWithRetry` commits each migration file independently. All new tables, copied box identities, fee migration, outer-dimension fields, and packing preferences therefore commit or roll back together.

- Legacy tables and historical quote payloads are preserved.
- Existing shared and Dropship packaging receive separate initial suites. Equal dimensions do not merge box identities.
- Existing Dropship markup/insurance windows migrate only into programs already assigned to vendor fulfillment. Retail-only programs remain unchanged.
- A program shared by retail checkout and Dropship vendor pricing blocks the migration with `SHIPPING_PROGRAM_SHARED_WITH_RETAIL`. Deliberately separate those programs before retrying; the migration does not decide new retail prices.
- Overlapping legacy fee windows block with `SHIPPING_CHARGES_OVERLAP`. Gaps remain unavailable, not silently free.
- Existing explicit legacy/test cutover modes remain supported for rollback compatibility. The admin UI warns when the deployment is not live. Shared program edits do not update preserved legacy fee tables.
- Drain quote/packing traffic and relevant workers for the migration/runtime handoff. The migration copies active legacy boxes into the shared catalog; an old, concurrently running cartonizer would not understand the new suite boundaries. Do not treat this as a proven zero-downtime mixed-version deployment or blindly roll back to the old all-boxes reader.
- Database history is protected by migration-owned triggers and deferred constraints. Use the release migration runner, not `db:push`, for this change.

Production program assignments, fee-window cleanliness, warehouse availability, actual measured outer dimensions, and deployment cutover mode have not been checked or changed in this implementation turn. An administrator must verify them before release.

## Verification and next live checks

Automated coverage includes domain arithmetic/overflow/caps; configuration permission and validation boundaries; retired endpoint routing order; exact warehouse override and empty-suite failures; idempotent replay and concurrent stale edits; immutable audit history; bounded charge-window replacement; atomic migration rollback; real database-backed packing of quantities 1, 2, and 5; configured non-Standard service selection; WMS suite revision evidence; and the real shared rate application path without double fees.

Desktop/mobile browser tests cover shared configuration saves, bounded suite editing, retry identity, and existing listing description, pricing, policy recovery, and private shipping-estimate behavior. Typecheck, writer ownership ratchet, and production build are also run.

Local verification at handoff: 2,088 unit tests across 229 files; 119 PostgreSQL integration tests across 9 files; 46 desktop/mobile browser tests. Typecheck, writer ratchet, and production build pass. The build retains its large-client-bundle warning. CI and production smoke tests have not run for this branch.

After deployment, with explicit authority for any live setting changes:

1. Confirm the migrated Dropship suite, program, fee revision, and service level in admin. Confirm the deployment mode is live.
2. Estimate the same listing at quantities 1, 2, and 5 for a known covered destination. Verify totals against program testing; the vendor sees no rate/fee breakdown.
3. Configure a second warehouse override and confirm its suite replaces, rather than combines with, the default. Test a warehouse with no available member and verify an actionable failure.
4. Verify a retail quote still uses its own program and suite. Confirm changing Dropship settings does not change retail charges.
5. Verify a new Dropship WMS pack plan uses the same suite as estimation. Retain historical plan/quote evidence and inspect the recorded revisions.
6. Retry an interrupted admin save and attempt a stale concurrent edit. The first must replay once; the second must require a reload.

No suggested listing-price algorithm, delivery promise engine, carrier insurance procurement, or live marketplace publication is introduced here.
