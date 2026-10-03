# Product inventory behavior: authority correction

Date: 2026-10-02. Final source baseline: `origin/main` at
`62e80322f` (PR #1645), fetched again after implementation.
Implementation branch: `codex/product-inventory-behavior-authority`.

The initial behavior correction was checkpointed as `dba14c3f5`, current main was
merged locally, and the automatic pick conversion fix from PR #1642
(`955ef9cb0699ea1f78e90e4a5bdb835d538ee1d8`) was integrated as `d3d4e32e0`.
They are one coordinated branch for review. This is not a claim that PR #1642
was merged, or that this branch was pushed, merged, deployed or activated.
Migration prefix 0718 remains unclaimed on the refreshed main.
The original diagnosis below used baseline `f3480b7ba` (PR #1643).

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
| Conversion readers | `PostgresInventoryConversionReader.getAllowedConversions`, `server/modules/inventory-planning/infrastructure/inventory-conversion-read.repository.ts:11` | Read only the active sealed valid model, then apply mode restrictions and validate the returned DTO. No legacy parent/ratio fallback. |
| Manual break / assemble | `authorizePackageConversionDefinition:304` and `assertBehaviorPermission:209` in `server/modules/inventory/domain/transformation-execution-authority.ts`; callers `breakVariant:157,209`, `assembleVariant:296,333` in `server/modules/inventory/application/break-assembly.use-cases.ts` | Reject operations forbidden by the model mode; authorize and re-pin the exact path inside the movement transaction. |
| Replenishment | `planCanonicalTaskExecution:1226`, authorization at `1278`, execution pin at `1363`, in `server/modules/inventory/application/replenishment.use-cases.ts` | The existing replenishment executor uses the same transformation authority. A picker action cannot invent a conversion. |
| Component inventory changes | `PostgresInventorySupplyDependencyReader.getAffectedProductIds:21` in `server/modules/inventory-planning/infrastructure/inventory-supply-dependency-read.repository.ts`; `queueVariantInventorySync:522` in `server/services/index.ts` | A repeatable-read, runtime-pinned read follows the transitive sealed binding graph, including dependent package siblings. It queues the existing publication/replenishment mechanism; it does not calculate or authorize ATP. Cycles deduplicate, invalid identities fail, and an oversized graph is rejected rather than truncated. |
| Warehouse inventory rows | `getInventoryLevelsSummary:862,904` in `server/modules/inventory/infrastructure/inventory.repository.ts`; `projectInventoryLevels:55` in `server/modules/inventory/application/inventory-levels.query.ts` | Zero-physical active tracked SKUs remain available to canonical ATP projection regardless of the retired flag, matching the all-warehouses query. Physical quantities are unchanged. |
| Component builds | `authorizeBuildBindingDefinition:503` in `server/modules/inventory/domain/transformation-execution-authority.ts`; `PostgresCanonicalClaimBuildRepository.handoffOperation:106,144`, `executeOperation:528,644` in `server/modules/inventory/infrastructure/canonical-claim-build.repository.ts` | Build-managed mode plus the exact sealed recipe binding is required. Retained claims use their recorded model, not a new Catalog flag. |
| Pick operation execution | `materializePickPackageConversions:6480` and `executeLockedPackageOperation:6531` in `server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts`; `isClaimPickRepackaging:86` in `domain/claim-pick-package-conversions.ts` | Execute approved, outstanding package operations recorded in the claim before its pick, including recipe-backed same-product repackaging. Conversion and pick share the transaction. Cross-product component assembly still uses assembly work; no inferred reverse operation or rewriting of historical claims. |
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

### Additional audit gaps closed in this coordinated branch

| Gap | Corrected code and reasoning | Regression evidence |
|---|---|---|
| Mutable legacy recipes were still loaded into operational snapshots. | `captureGraphInsideTransaction`, `server/modules/inventory-planning/infrastructure/inventory-availability-shadow.repository.ts:434`, now loads them only for an explicitly requested legacy shadow comparison. Active ATP, active claims and reviewed product/safety snapshots use sealed definitions only. The default at `captureInsideTransaction:706` is false; only `PostgresInventoryAvailabilityShadowRepository.captureSupplySnapshot:1124` opts in. Stored old snapshots and hashes are not rewritten. | `inventory-availability-shadow.repository.test.ts:29` throws on any legacy recipe query and proves the operational readers still work; `:51` retains explicit comparison coverage. |
| Summary endpoints calculated legacy ATP before overwriting its numbers. | `AuthorityAwareInventoryAtpService.getProductSummary:199` and `getInventoryItemSummary:232`, `server/modules/inventory-planning/application/inventory-availability-runtime-atp.service.ts`, now branch before invoking any legacy summary. Canonical mode reads physical facts with `readInventoryProductBalances`, `infrastructure/inventory-product-balances.reader.ts:5`, and uses the existing canonical planner for availability. Picked is not subtracted again from physical stock. Legacy strategy remains compatibility metadata only. | `inventory-availability-runtime-atp.service.test.ts:102` rejects every legacy summary call; `inventory-cutover-composition.integration.test.ts:197` exercises the real SQL read, including missing product behavior. `inventory-product-balances.test.ts` covers integer validation and overflow. |
| Inventory actions and warnings still inferred conversions from parent pointers. | `projectInventoryLevels`, `server/modules/inventory/application/inventory-levels.query.ts:60`, supplies `allowedConversions` from the read port. `allowedCaseBreakSources`, `client/src/features/inventory/allowed-case-breaks.ts:13`, permits only an explicit direct break path, never a transitive shortcut. `AuthorizedCaseBreakLocationRows`, `client/src/pages/Inventory.tsx:381`, passes the saved integer batch quantities to the command dialog. Missing/failed authority never falls back to parent inference. | `inventory-levels.query.test.ts`, `allowed-case-breaks.test.ts`, and `test/browser/inventory-availability.spec.ts:166,217` cover contradictory old parents, missing permission, whole batches and fractional-quantity rejection. |
| Catalog and contextual recipe SKU creation exposed retired parent controls. | `BuildVariantSelector`, `client/src/features/inventory-builds/BuildVariantSelector.tsx:56,304`, creates a physical SKU without a parent or any conversion grant. ProductDetail removes the old parent column/editor and directs configuration to Inventory behavior (`client/src/pages/ProductDetail.tsx:4303`). Receiving's missing-parent detector was removed from `evaluateReceiveWarnings`, `server/modules/procurement/receive-validation.service.ts:94`; unrelated quantity/cost warnings remain. | `inventory-builds-ui.test.ts`, `receive-validation.service.test.ts`, and the desktop/mobile creation flow at `test/browser/catalog-conversions.spec.ts:111` prove a P5 can be created without inventing an EA or parent permission. |
| Duplication silently copied legacy flags/parents but no active model. | `duplicateProduct`, `server/modules/catalog/product-duplicate.service.ts:61`, now requires a draft, resets legacy strategy to physical-only compatibility metadata (`:127`), and drops copied parent links (`:142`). It does **not** clone any model, path or recipe permission. `ProductDetail.tsx:1808,2717` explains this and opens the new copy's Variants tab for explicit setup. | `product-duplicate.service.test.ts` verifies draft-only input, no parent writes and reset metadata. This is explicit setup, not automatic model cloning. |

All relative test filenames in the first two rows are under
`server/modules/inventory-planning/__tests__/unit/`, except the explicitly named
composition integration test under `__tests__/integration/`. Inventory tests are
under their owning module/feature. No new ATP engine or production cutover is
introduced by these changes.

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
- Automatic pick conversion follows the configured inline/queued replenishment
  policy. It performs only an approved package operation; it does not assert that
  physical component assembly happened. Existing component-work handoffs remain.
- A duplicate's setup is explicit rather than automatically remapping recipes.
  It starts as a draft with no active model. This does not add a universal guard
  to every later Catalog status-edit endpoint, nor redesign the existing
  multi-step catalog duplication transaction. No inventory movement occurs there.
- Inventory action hints and ATP are separate read requests; an intervening model
  change may make a displayed action stale. The movement transaction reauthorizes
  the exact operation and rejects it rather than trusting the browser's hint.
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
- Coordinated inventory/planning unit, Catalog, receiving and UI-contract batch:
  **3,610 passed in 273 files**, with 118 environment-gated tests skipped across
  four files, zero failures. The final run includes the added balance validation
  and runtime-summary regressions. Its JSON evidence is retained locally at
  `.codex-audits/final-gap-regressions.json` (not committed).
- Browser: **34 passed** — Catalog 30, inventory availability 4 — desktop and
  mobile. Includes all three modes, recipe selection, active/draft separation,
  permissions, stale/retried commands, Review/Apply, recipe SKU creation without
  legacy parents, authoritative case-break hints and exact integer batches.
  Mobile recipe creation and desktop mode controls were also visually inspected.
- Disposable local PostgreSQL: **135 distinct tests passed** — foundation 51,
  transformation execution authority 7, cutover composition 59, automatic pick
  conversion 18. Covers real migration, sealed immutability, contradictory mode
  rollback, stale heads, idempotency, retained execution authority, summary SQL,
  conversion/pick rollback, insufficient input and recipe-backed package picks.
  Dedicated clusters were stopped. An initial runner invocation used an incorrect
  authority-test path (no tests found); the correct seven-test suite was then run
  successfully. No skipped database test is counted as a pass.
- Migration prefix collision guard passed. Final refreshed main has no 0718
  migration. Whitespace checks passed. No full-repository or GitHub CI green
  claim is made here; earlier exploratory full-suite environment failures are
  not silently represented as resolved by this targeted verification.

## What is not proven / next checks

1. This branch is not merged or deployed. Local verification is not production
   acceptance. Review the complete diff and CI before deployment.
2. The automatic recipe-backed package fix from
   [PR #1642](https://github.com/cardshellz/Echelon/pull/1642) is now integrated and
   tested on this branch. Order 63662 has **not** been retried or recovered here;
   its current claim, operation inputs and physical assembly remain a separate
   production verification. Passing fixture tests does not prove it is cleared.
3. After deployment, verify the Catalog controls and the saved active Quad Box
   model. Any mode/path/recipe change requires a reviewed successor; no blanket
   production rewrite is included here.
4. Physical assembly behind task 2129 and EA adjustment 59993, and the historical
   configuration that permitted them, remain unknown. Stock/cost recovery is not
   performed or inferred from the UI problem.
