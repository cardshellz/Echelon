# Warehouse/program packaging implementation

Implementation base: e36d97a8b (main after PR 1431, includes PR 1430).
Publication base: df3797bff (refreshed main including PR 1428; procurement-only changes).
Branch: codex/warehouse-program-packaging.

## Approved scope

One shared box catalog; explicit warehouse box availability; reusable suites;
real channel fulfillment configuration selects a suite independently of pricing.
One effective suite per channel/warehouse, with a visible channel default and
warehouse overrides. Unbranded-only policies reject branded or unclassified boxes.
Estimates, automatic packing, and manual box confirmation must enforce the same
authority. No order splitting, inventory reservation, or origin routing changes.

## Compatibility / migration

Do not infer warehouse availability or branding from names or missing records.
Existing channels retain clearly labeled legacy behavior until an administrator
saves a concrete channel packaging policy. New policies require explicit warehouse
availability; empty overrides fail rather than fall back. Existing quotes and
pack plans retain immutable configuration evidence. Catalog changes need revisions,
idempotency, and audit; no hidden hard delete or controller DB writes.

## Implemented

- `ShippingSettings.tsx / BoxCatalogTab`: one catalog with explicit branding,
  reviewed warehouse availability, revision-checked saves, and automatic refresh.
  Plain and graphic containers are separate catalog identities, not names used as rules.
- `BoxSuitesPanel`: reusable membership, duplicate/archive/restore, and concrete
  channel/warehouse usage. Suites remain separate from catalog and pricing.
- `ChannelPackagingPanel`: actual channel/configuration selector; default suite;
  independent warehouse overrides; available-box counts/details; explicit save,
  cancel and inheritance reset. Initial setup can save default plus exceptions atomically.
  Warehouses are searchable and paginated. Two Shopify stores are distinct IDs.
- `DropshipSharedShippingPanel`: pricing and packaging alongside every warehouse,
  not a selector implying only one warehouse can fulfill. Dropship packaging uses
  the same OMS channel resolver as intake, not a display-name/provider tag match.
- `ChannelPackagingRepository / resolve`: one suite for the actual channel and
  warehouse, intersected with active, reviewed warehouse availability. No union
  with the default and no fallback when an explicit assignment is unusable.
- `configurationCommand`: transactional revision/CAS, stable retry IDs, immutable
  actor/before/after/time journal, shared serialization across box/suite/policy edits.
- `BasicDropshipCartonizationProvider` and `ensurePackPlan`: consume this resolver;
  retain policy/suite/box evidence. White-label policies require outer packaging,
  rather than letting ships-in-own-container bypass the requirement.
- `confirmParcel`: snapshot-scoped choices, current warehouse/channel and box
  availability validation, authenticated actor, locked plan/parcels, append-only
  confirmation audit. Identical retries return the existing result. A failed
  audit insert rolls back actuals and plan status.
- Migration `241_channel_packaging_policies.sql` adds the reviewed metadata,
  actual-channel policies/overrides and confirmation journal. No synthetic
  branding, warehouse assignments or canonical policies are populated.
- Writer ownership ratchet adds only the three new shipping-engine-owned tables.
  No inventory or OMS writer baseline changes.

## Runtime trace / boundaries

1. Dropship quote/estimate invokes `BasicDropshipCartonizationProvider.cartonize`.
2. `resolveDropshipPackagingChannel` uses the existing intake channel resolver.
3. `SharedShippingConfigurationRepository.loadPackaging(profile, warehouse, channelId)`
   checks the concrete channel policy first; only an absent policy uses legacy configuration.
4. `ChannelPackagingRepository.resolve` returns the effective suite and eligible boxes.
5. Cartonization passes parcels to the existing shared pricing engine. This work
   does not change pricing program/rate/markup/insurance calculations.
6. WMS `ensurePackPlan` uses the order's real channel and assigned warehouse;
   missing warehouse does not silently become warehouse 1.
7. The packing station shows permitted choices from the plan and validates actuals
   again on the server. Invalid snapshots fail closed. Pre-snapshot legacy plans
   can be confirmed as planned but need regeneration for a different box.

Checkout carrier callbacks and manual rate quotes use `weightOnlyParcelProvider`;
they do not select physical boxes. Their weight-based pricing is deliberately unchanged.
The legacy `runShadow` historical comparison tool remains on its older Shopify
profile/rate context; it is not an acceptance test for these new channel policies.
Warehouse selection, order splitting, inventory reservation, external label purchasing,
marketplace listing publication and order acceptance are outside this change.

## Assumptions and unknowns

- "Program" here means the actual fulfillment channel/configuration context.
  Its pricing program and packaging suite remain sibling assignments; changing a
  rate book cannot accidentally change packaging permissions.
- Physical box branding and availability cannot be verified from names or existing
  missing rows. An administrator must review them. Availability is configuration,
  not real-time packaging inventory quantities.
- Legacy configuration remains until explicitly replaced for each actual channel.
  Imported suites still used by legacy assignments cannot be archived; renaming
  and editing remain possible. No fallback assignment is silently retired.
- Existing quote/plan evidence is retained. New plans use new policy revisions;
  changed current availability/branding can block a new manual confirmation.
- Production data, external providers, and deployed behavior were not exercised.
  Tests use disposable local databases and mocked browser API responses.

## Validation

- TypeScript no-emit check and client/server production build passed.
- Final consolidated shipping/cartonization/Dropship/UI unit suite, three PostgreSQL
  integration suites, and ownership/migration-prefix checks: 2,204 tests passed in
  239 files.
- PostgreSQL integration covers multiple warehouses, distinct same-provider channels,
  actual Dropship provider wiring, branded-box rejection, suite archive/edit conflicts,
  concurrent stale policy edits, retry identity, unavailable overrides, atomic initial
  exceptions, inheritance reset, and audit rollback/immutability for real confirmations.
- Browser checks: 20 desktop/mobile tests passed, including real catalog editor,
  saved-state refresh, per-warehouse assignment/reset, white-label rejection,
  preserved failed edits/retries, suite lifecycle, pricing and service-level controls.
- Existing migration-preflight fixture updated to use explicit column names when
  inserting policy routes, preserving its shared-retail-program rejection scenario.
- Build reports the existing large-bundle advisory; no build failure.

## Deployment acceptance

1. Apply migration 241 before this application version; verify migration prefix
   against latest main again when publishing the PR.
2. In Box catalog, classify plain/graphic boxes and check the real warehouses that
   have each. Save and reopen to verify persisted branding and availability.
3. Create/review white-label and graphic suites in Box suites.
4. Configure Dropship OMS with the white-label requirement and suite; configure
   the main Shopify store independently with the graphic suite.
5. Check both warehouse rows. Set an override where their available suites differ;
   reset it and verify the visible inherited default. Pricing is not changed by this.
6. Generate fresh Dropship estimates/pack plans for each warehouse. Verify permitted
   boxes and confirm that graphic substitutions cannot pass for white-label orders.
7. Independently verify production warehouse routing and physical stock; this feature
   neither enables warehouses nor reroutes existing orders.

Implementation is isolated in its own worktree. Creating the PR does not deploy
the change or modify production settings or data.
