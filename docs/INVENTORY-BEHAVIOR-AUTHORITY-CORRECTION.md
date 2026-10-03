# Product inventory behavior: authority correction

Date: 2026-10-02. Source baseline: `origin/main` at
`f3480b7ba67fab6ad58be9a7ebdacd769c86ba74` (PR #1643).
Implementation branch: `codex/product-inventory-behavior-authority`.

Final main refresh: `dede4daf2` (PR #1644) contains nine Dropship-only file changes
since this branch's base, with no overlapping changed files or migrations. The
implementation/tests reported here remain based on `f3480b7ba`; migration prefix
0718 is still unclaimed on the refreshed main.

## What the code definitely does

There was a real consistency gap. The previous UI consolidation intentionally
retired the editable Catalog strategy after cutover, but its Variants card still
used that retired strategy to choose or hide its content. Recipe authoring and
build-order creation also retained legacy strategy checks. The canonical model
had explicit paths and recipe bindings, but no explicit three-way product choice.

The final cross-system trace found two further uses of the retired flag: component
inventory-change fan-out called `RecipeCapacityService.getAffectedOutputProductIds`
(`server/modules/inventory/recipe-capacity.service.ts:263-307`), and the warehouse
inventory query filtered zero-physical rows by `recipe_managed`
(`inventory.repository.ts:904-906` at the baseline). Both are corrected here:
refresh scope follows sealed bindings under a pinned runtime authority, and
warehouse rows are no longer hidden before the canonical ATP projection runs.

Baseline evidence: `ProductConversionCard` in
`client/src/features/inventory-builds/ProductConversionCard.tsx:114,272` hides
Physical only and selects the recipe summary from the retired field.
`BuildRepository.createRecipe`, `updateRecipe`, and `createOrder` in
`server/modules/inventory/infrastructure/build.repository.ts:374,549,726` call
the legacy strategy assertion unconditionally at the baseline commit above.
The old decision is also recorded in the historical Phase 1 sections
of `CATALOG-CONVERSION-UI-CONSOLIDATION-PLAN.md`. The changes in this branch remove
those conflicting canonical-runtime decisions, rather than re-enable a second
Catalog authority.

### One saved choice, with these meanings

| Choice | Exact finished SKU stock | Additional supply / execution |
|---|---|---|
| Physical only | Allowed | No conversion paths, recipes, or component-build promise |
| Package hierarchy | Allowed | Only explicitly allowed recipe-free break-down/build-up directions |
| Build managed | Allowed | Component assembly through selected recipe bindings; package conversions require a selected forward recipe; no implied reverse |

Source: `shared/inventory/inventory-behavior.ts:4-68`, especially
`permitsPackagePath`, `permitsRecipeBuild`, and `inventoryBehaviorDefinitionIssues`.
The choice describes how the output product can be supplied; an exact physical
component can still be consumed by another product's authorized recipe.

The mode does not waive warehouse eligibility, stock obligations, safety floors,
work execution requirements, or channel allocation. It selects permitted supply
operations within the existing planner, not a different ATP calculation.

### Execution trace and enforcement

Line references below are to this branch's corrected files.

| Step / path | Exact owner and evidence | Effect |
|---|---|---|
| Choose and edit | `ProductConversionCard`, `client/src/features/inventory-builds/ProductConversionCard.tsx:184`; `beginPackageConversionEdit` and `changeInventoryBehavior`, `package-conversion-draft.ts:56-73` | Always show the three choices. View the active model; explicitly open the draft to edit. Changing mode clears draft paths/bindings, not physical stock or recipe definitions. |
| Select a recipe | `selectBuildRecipe`, `client/src/features/inventory-builds/package-conversion-draft.ts:75`; `ProductRecipeRules`, `ProductRecipeRules.tsx:11` | Select exact recipe IDs. Assembly creates a component binding; conversion creates only its forward directed path. Existing binding identities/scopes are retained unless removed explicitly. |
| Author recipes | `BuildRecipeCreate`, `client/src/pages/BuildRecipeCreate.tsx:98`; `BuildRepository.createRecipe:361`, `updateRecipe:441`, `createOrder:693` | Product-context create/edit returns to Variants. Runtime is pinned before recipe/catalog locks. Legacy strategy checks run only in legacy mode; authoring a recipe does not activate it. |
| Save | `InventoryAvailabilityMasterDataService.createTransformationModelDraft:130`, `updateTransformationModelDraft:177`, and `buildTransformationDefinition:383` in `server/modules/inventory-planning/application/inventory-availability-master-data.service.ts` | Preserve explicit mode; validate it against paths/bindings. Old callers cannot silently strip an existing mode. |
| Persist and audit | `PostgresInventoryAvailabilityMasterDataStore.createTransformationModelDraft:189`, `updateTransformationModelDraft:345` in `server/modules/inventory-planning/infrastructure/inventory-availability-master-data.repository.ts` | Serializable transaction; idempotency and product-owner locks, captured head revision, definition hash and audit. A stale create/update cannot silently overwrite the current choice. |
| Database constraints | `inventory.guard_model_inventory_behavior`, `migrations/0718_inventory_model_behavior.sql:17` | Deferred final-state checks reject validated definitions whose mode contradicts allowed paths or bindings. Existing sealed-definition guards protect the added field. |
| Review / Apply | `PostgresProductDefinitionStore.apply:23`, `captureReview:88`, `captureDefinitionImpact:129` in `server/modules/inventory-planning/infrastructure/inventory-product-definition.repository.ts` | Existing reviewed, hash-bound, idempotent promotion. Recalculates warehouse ATP and channel quantities using the same planner and enqueues publication atomically. No global cutover or physical movement. |
| ATP and new claims | `buildContext:628`, `projectCanonicalAtp:1073`, `planCanonicalClaim:1210` in `server/modules/inventory-planning/domain/inventory-availability-planner.ts` | Both calculations share the same mode restrictions. Incompatible paths/bindings produce blockers and are not used; eligible exact stock remains usable. |
| Conversion readers | `PostgresInventoryConversionReader.getAllowedConversions`, `server/modules/inventory-planning/infrastructure/inventory-conversion-read.repository.ts:12` | Read only the active sealed valid model, then apply mode restrictions. No legacy parent/ratio fallback. |
| Manual break / assemble | `authorizePackageConversionDefinition:304` and `assertBehaviorPermission:209` in `server/modules/inventory/domain/transformation-execution-authority.ts`; callers `breakVariant:157,209`, `assembleVariant:296,333` in `server/modules/inventory/application/break-assembly.use-cases.ts` | Reject operations forbidden by the model mode; authorize and re-pin the exact path inside the movement transaction. |
| Replenishment | `planCanonicalTaskExecution:1226`, authorization at `1278`, execution pin at `1363`, in `server/modules/inventory/application/replenishment.use-cases.ts` | The existing replenishment executor uses the same transformation authority. A picker action cannot invent a conversion. |
| Component inventory changes | `PostgresInventorySupplyDependencyReader.getAffectedProductIds:21` in `server/modules/inventory-planning/infrastructure/inventory-supply-dependency-read.repository.ts`; `queueVariantInventorySync:522` in `server/services/index.ts` | A repeatable-read, runtime-pinned read follows the transitive sealed binding graph, including dependent package siblings. It queues the existing publication/replenishment mechanism; it does not calculate or authorize ATP. Cycles deduplicate, invalid identities fail, and an oversized graph is rejected rather than truncated. |
| Warehouse inventory rows | `getInventoryLevelsSummary:862,904` in `server/modules/inventory/infrastructure/inventory.repository.ts`; `projectInventoryLevels:55` in `server/modules/inventory/application/inventory-levels.query.ts` | Zero-physical active tracked SKUs remain available to canonical ATP projection regardless of the retired flag, matching the all-warehouses query. Physical quantities are unchanged. |
| Component builds | `authorizeBuildBindingDefinition:503` in `server/modules/inventory/domain/transformation-execution-authority.ts`; `PostgresCanonicalClaimBuildRepository.handoffOperation:106,144`, `executeOperation:528,644` in `server/modules/inventory/infrastructure/canonical-claim-build.repository.ts` | Build-managed mode plus the exact sealed recipe binding is required. Retained claims use their recorded model, not a new Catalog flag. |
| Pick operation execution | `assertOperationMatchesPlan:2205` and `executeLockedPackageOperation:6522` in `server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts` | Execute only the operation recorded in the hashed claim plan. This correction does not retroactively rewrite historical claims or add a reverse operation. |
| Runtime composition | `server/services/index.ts:205,248-289`; `PostgresInventoryAvailabilityRuntimeClaimExecutor.execute:85` in `server/modules/inventory-planning/infrastructure/inventory-availability-runtime-claim.repository.ts` | Production composition injects the authority-aware ATP, claim and transformation services. Legacy paths remain isolated for legacy runtime compatibility. |

### Catalog workflow

Product → Variants → Inventory behavior → Edit → choose mode and allowed
directions/recipes → Save draft → Review draft changes → Apply reviewed changes.

The UI uses `inventory_planning:view/edit/activate`; recipe authoring retains
`inventory:adjust`. A user can hold all permissions. No second approver or written
draft reason was added. The automatic audit note records the action. See
`ProductConversionCard:111`, `ProductRecipeRules:26`, and
`ProductDefinitionReview:21-47` in `client/src/features/inventory-builds/`.

The obsolete read-only `ProductBuildRelationships` component was removed and
replaced by `ProductRecipeRules`; it remains recoverable from Git. Overview links
to the Variants authority editor. No new standalone configuration page was added.

## What is likely happening — historical Quad Box limitation

The saved read-only evidence identifies a real **historical C25 → P5 case break**:
task 2129, September 28 at 14:52 Eastern, transactions 75314/75315. The two P5 picks
for order 63662 later consumed that recorded P5 balance. This is not evidence that
component assembly occurred for that order.

Source: `C:/Users/owner/Echelon/.codex-audits/order-63662-pick-readonly-20261002/p5-provenance-readonly.json:12-55`,
fields `recordedP5Origin`, `subsequentP5Picks`, and `cutoverReservation`. The file
records the later canonical cutover reservation on September 30. The task is
therefore not proof of a new post-cutover reverse conversion. Its exact historical
authorization/configuration and physical assembly work remain unproven
(`unknowns:82-85`). No historical quantity or cost entry was changed here.

The new regression uses **2 P5, 5 EA, and 100 C25**, with only the recipe
**5 EA → 1 P5**. Both ATP and a new claim allow **3 P5**, not 503, and never consume
C25. Evidence: `inventory-availability-planner.test.ts:151-170` in
`server/modules/inventory-planning/__tests__/unit/`. This is a deterministic fixture,
not a fresh production stock assertion.

## Compatibility, assumptions and risks

- Existing sealed versions have a null/absent mode. Their exact paths, recipe
  snapshots, hashes and claims are preserved. `describeInventoryBehavior` provides
  a UI description from those saved rules, not from the Catalog flag. A reviewed
  successor records the explicit choice. Migration 0718 does not backfill or
  activate choices automatically.
- Exact stock is treated as recorded inventory; choosing Build managed does not
  prove it was assembled correctly in the past or retroactively consume components.
- Changing rules governs new planning. Previously accepted claims retain their
  original model and operation evidence. Revoking or replanning those obligations
  is a separate audited action, not a side effect of this selector.
- Mixed pre-mode definitions remain preserved but cannot be saved as an explicit
  incompatible mode. The recipe editor exposes unbound directions for removal;
  unsupported detailed relationships remain visible in Detailed rules.
- Deploy the additive migration with the application change. New queries read
  the added column. Do not activate product successors during a mixed-version
  rollout where an older application instance could ignore the explicit mode.
- Warehouse-specific inventory views now retain zero-physical active tracked
  SKUs, like the all-warehouses view, so valid conversion/build ATP is not hidden.
  The existing per-product ATP read pattern remains; this is not a pagination or
  inventory-query performance redesign.
- These are implementation compatibility decisions, not proof of every product's
  intended configuration. No production model, BOM, inventory, reservation,
  provider quantity, or channel setting was changed.

## Failure modes covered

- Malformed modes or contradictory paths/bindings fail contract validation and
  database checks; runtime policy also refuses conflicting operations.
- Missing mode on an old model does not manufacture new directions.
- Stale heads, hashes and recipe references reject the draft or Apply; no automatic
  rebase. Unknown network outcomes retry the same command identity.
- Drafts never replace the displayed active rules or publish inventory. Only the
  existing permissioned Apply performs promotion and queues channel updates.
- An active recipe alone is not permission to transform. Its sealed binding and,
  for package conversion, exact directed path must exist.

## Test coverage and verification

- TypeScript application and both test-project checks passed with incremental
  output disabled because this isolated worktree shares a dependency junction.
- Final focused regression batch: **197 passed in 13 files**, including the
  migration-prefix collision guard, Catalog controls, mode-sensitive planner,
  transformation execution authority and recipe authoring.
- After the dependency-refresh and warehouse-view corrections, the complete
  affected inventory/planning unit and Catalog batch passed: **3,297 tests in
  238 files**, with no failures or skips. Application and server-test TypeScript
  checks were rerun successfully after those corrections.
- Browser: **28 passed**, desktop and mobile. Tests cover all three modes,
  recipe selection, active/draft separation, permissions, stale saves, unchanged
  retry identity, and Review/Apply.
- Disposable local PostgreSQL: **116 distinct tests passed** — foundation 51,
  transformation execution authority 7, cutover composition 58. These exercise the real migration,
  sealed immutability, invalid mode rollback, stale head rollback, idempotent draft
  writes, active/retained execution authority and transitive canonical refresh
  without mutable recipe/Catalog tables. The dedicated clusters were stopped.
- Unit/contract coverage includes mode-sensitive ATP/claims, exact recipe direction,
  old hash compatibility, reference/permission validation and legacy-independent
  canonical recipe authoring. Broader repository run before the final dependency
  refresh additions: **20,698 passed, 1 failed, 2,141
  pending/skipped**. The one failure was a local `fetch failed` in the unrelated
  `purchasing-admin.routes.test.ts`; that suite and the final Catalog render suite
  passed separately (**31 tests**). This is not a claim of a fully green full-suite
  run. Environment-gated integration suites are not claimed as executed.
- Initial full runs exposed unrelated CRLF-sensitive source-text assertions and
  two local HTTP fetch failures. LF normalization of unchanged files was verified
  to preserve Git blob identity; HTTP suites passed separately (87 tests). No
  Dropship feature change belongs to this correction. The temporary line-ending
  normalization was reversed after testing, with all 14 files matching their
  original Git blob identities.

## What is not proven / next checks

1. This branch is not merged or deployed. Local verification is not production
   acceptance. Review the complete diff and CI before deployment.
2. The automatic recipe-backed package operation needed by order 63662 is a
   separate existing fix: [PR #1642](https://github.com/cardshellz/Echelon/pull/1642),
   verified open/unmerged during this investigation. Current main's
   `materializePickCaseBreaks` (`inventory-availability-claim.repository.ts:6479`)
   still selects only `break_pack`, not `directed_conversion`. Do not claim this
   behavior-selector correction alone clears that order. Coordinate the two fixes
   without introducing C25 → P5 authority.
3. After deployment, verify the Catalog controls and the saved active Quad Box
   model. Any mode/path/recipe change requires a reviewed successor; no blanket
   production rewrite is included here.
4. Physical assembly behind task 2129 and EA adjustment 59993, and the historical
   configuration that permitted them, remain unknown. Stock/cost recovery is not
   performed or inferred from the UI problem.
