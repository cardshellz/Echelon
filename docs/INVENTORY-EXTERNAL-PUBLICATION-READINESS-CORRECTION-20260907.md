# External publication readiness correction — 2026-09-07

## Confirmed gap and bounded correction

The provider refresh repository selects only `publication_authority = 'echelon'` (`server/modules/inventory-planning/infrastructure/inventory-publication-readback.repository.ts`, `loadTargets`, line 215). The activation dry run previously demanded fresh provider readback from all enabled targets, including `external_provider` and `manual`. Its built-in refresh therefore could not satisfy those externally managed targets.

`InventoryAvailabilityActivationDryRunService.runDryRun` still emits `observe_only` for externally managed eligible rows. `legacyPublicationCoverageBlockers` now scopes Echelon acknowledgement/readback prerequisites to enabled Echelon targets. `targetPublicationBlockers` scopes exact readback verification to eligible Echelon rows and records `EXTERNALLY_MANAGED_PUBLICATION_OBSERVE_ONLY` as explicit review evidence for other authorities (`server/modules/inventory-planning/application/inventory-availability-activation-dry-run.service.ts`, lines 534, 576, 695).

Exact target destination, scope, revision and authority changes remain blocking, as do changed/missing SKU mappings and existing source-binding/shadow blockers. These checks are independent of provider readback. The request contract version changes so an old idempotency key cannot silently replay evidence under the previous readiness rules.

This does not grant Echelon publication authority. Preparation still filters exclusively to `disposition === 'publish'` (`server/modules/inventory-planning/infrastructure/inventory-availability-activation.repository.ts`, `publicationIntents`, line 618). No provider adapter, outbox writer, physical inventory reader, warehouse setting, or live target is changed by this correction.

## Deliberate limits and next checks

- `ready_for_publication` remains preparation readiness, not proof of full catalog authority cutover or order-claim reconstruction (`shared/types/inventory-availability-phase4.ts`, `inventoryActivationDryRunSchema` and `inventoryActivationCommandResultSchema`).
- An observation-only row does not certify external inventory custody or freshness. Shopify available quantity is not represented as physical 3PL on-hand. Canada can remain externally managed; no blanket node-type prohibition or automatic authority conversion is introduced.
- Complete real-world account/location/listing coverage is not proved by enumerating configured targets. An independent enabled-destination coverage manifest must reconcile provider accounts, existing feeds, target mappings and documented exclusions before final cutover.
- The existing Supply & Transformations page now has a separate, manual read-only WMS demand/inventory preflight panel (`client/src/pages/inventory-cutover-preflight-panel.tsx`). It validates the response, labels stale retained evidence, pages records in groups of 20, and displays the backend's not-evaluated list. It offers no repair, reservation, provider write or activation operation.

## Verification

Focused unit command: `npx vitest run client/src/pages/__tests__/inventory-cutover-preflight-panel.test.ts server/modules/inventory-planning/__tests__/unit/inventory-availability-activation-dry-run.service.test.ts server/modules/inventory-planning/__tests__/unit/inventory-availability-activation-dry-run.repository.test.ts server/modules/inventory-planning/__tests__/unit/inventory-availability-activation.service.test.ts`.

Result: 4 files, 62 tests passed. Coverage includes external/manual missing/stale/obsolete readbacks, unchanged Echelon requirements, target/mapping drift, source blockers, strict read-only HTTP validation, permission-hidden UI, failed-refresh stale evidence and a 50,000-line fixture bounded to 20 rendered rows.

No production/provider calls, activation, deployment or production data changes were performed for this correction. Database and live external-custody proof remain outside these unit tests.
