# Catalog Conversion UI Consolidation Plan

> Companion to `INVENTORY-TRANSFORMATION-ARCHITECTURE-AND-MIGRATION-PLAN.md`.
> That document defines the transformation model and the cutover. This one defines
> where an operator edits it, and how `catalog.product_variants.parent_variant_id`
> is removed cleanly rather than left as a legacy shadow.

## Goal

One place to declare what converts into what: the product's **Variants** tab.

After cutover, `parent_variant_id` does not exist. There is no derived column, no
dual-write, and no second editor. A conversion is allowed because a sealed
transformation model says so, and for no other reason.

## Why the conversion editor belongs on the product

`inventory.transformation_model_paths` is stored outside `catalog` for reasons that
are about the table, not the screen: a path is a directed pair, it is versioned and
sealed (`transformation_model_versions.lifecycle_status`, `sealed_by`, `sealed_at`,
`change_reason`), and exactly one draft may exist per product at a time
(`transformation_model_versions_one_draft_uq`). None of that is an argument for a
separate page. The rows being edited are relationships between two variants already
listed on the Variants tab.

`INVENTORY-TRANSFORMATION-ARCHITECTURE-AND-MIGRATION-PLAN.md:323-338` already
specifies a product-detail entry point. This plan implements it and retires the
competing surfaces.

### Current state (verified)

| Surface | File | Reads | Editable |
|---|---|---|---|
| "Inventory behavior" radio | `client/src/pages/ProductDetail.tsx:2838` | `products.inventory_strategy` | yes, while authority is `legacy` |
| "Breaks Into" column | `client/src/pages/ProductDetail.tsx:3683` | `parent_variant_id` | read-only |
| "Breaks Into (Parent Variant)" control | `client/src/pages/ProductDetail.tsx:4320` | `parent_variant_id` | yes |
| "Build Relationships" card | `client/src/features/inventory-builds/ProductBuildRelationships.tsx` | `inventory.build_recipes` only | no |
| "Authority by output SKU" | `client/src/pages/SupplyTransformations.tsx:1919` | `transformation_model_paths` | yes, after "Edit current draft" |

Four surfaces describe the same concept, none of them completely. The Build
Relationships card reads recipes only, so a `physical_fungible` product with two
approved directed paths renders as "0 linked / No build recipe" — correct for what
it queries, useless for what the operator asked.

---

## Phase 1 — Conversion card on the Variants tab

**Additive. No backend work. Safe under either runtime authority.**

Replace `ProductBuildRelationships` with a single card whose shape follows
`products.inventory_strategy` (`shared/catalog/inventory-strategy.ts`):

| Strategy | Label | Card shows |
|---|---|---|
| `physical_fungible` | Package hierarchy | The package ladder, one row per adjacent pair, with a direction control |
| `recipe_managed` | Build managed | Recipes — today's Build Relationships content |
| `physical_only` | Physical only | "No conversions." Nothing editable. |

### The ladder control

One row per adjacent relationship, ascending by `units_per_variant`, with a
four-state segmented control per `INVENTORY-TRANSFORMATION-ARCHITECTURE-AND-MIGRATION-PLAN.md:344-362`:

```text
P20                40 P20 = 1 C800                C800
Pack of 20      [ None | Break down | Build up | Reversible ]      Case of 800
```

The four states map to directed path rows, which is what makes the control honest
about a model that has no notion of reversibility:

| Control state | Rows in `transformation_model_paths` |
|---|---|
| None | neither |
| Break down only | `C800 -> P20` (`break_pack`) |
| Build up only | `P20 -> C800` (`assemble_pack`) |
| Reversible | both |

Quantities are derived, never typed: `deriveLosslessPath`
(`client/src/pages/supply-transformations-model.ts:44`) computes them from
`units_per_variant` via GCD. The operator supplies direction and nothing else.

### Endpoints — all of these already exist

| Purpose | Route | Permission |
|---|---|---|
| Read model, variants, recipes, runtime selection | `GET /api/inventory-planning/admin/supply-transformations/:productId` | `inventory_planning:view` |
| Create draft | `POST /api/inventory-planning/admin/supply-transformations/:productId/drafts` | `inventory_planning:edit` |
| Update draft | `PUT /api/inventory-planning/admin/supply-transformations/:productId/drafts/:draftModelId` | `inventory_planning:edit` |

No new routes, services, or schemas. Phase 1 is presentation only.

### Permission degradation

ProductDetail is reachable by users holding `catalog` permissions who may not hold
`inventory_planning:view`. The card must render a permission notice and no data
rather than an error, and must not make the query at all when the permission is
absent. Editing controls appear only with `inventory_planning:edit`.

### Also in Phase 1

- Product detail summary per `INVENTORY-TRANSFORMATION-ARCHITECTURE-AND-MIGRATION-PLAN.md:323-338`:
  model status and package sharing, read-only, next to the strategy radio.
- Move `PromiseSafetyPolicyPanel` off Supply & Transformations. Safety floors and
  demand evidence are a different concern and belong with Procurement settings.
- Split `/inventory/supply-transformations` in two: the six catalog-wide cutover
  panels move to `/inventory/cutover`; the per-product editor stays until Phase 4
  removes it. Both editors read the same rows, so they cannot disagree.

### Not in Phase 1

The strategy radio stays editable while authority is `legacy`, and
`parent_variant_id` keeps its current meaning. Nothing is removed.

---

## Phase 2 — Conversion read port

**Additive. No consumer changes. Can land any time after Phase 1.**

Four consumers outside `inventory-planning` read `parent_variant_id` for
conversion facts. They cannot read `inventory.transformation_model_paths`
directly — `BOUNDARIES.md` forbids it and
`server/__tests__/unit/writer-ratchet.test.ts` fails the build on a new
(table <- writer) pair.

Publish a narrow read port on the planning module:

```ts
getAllowedConversions(productId: number): Promise<ReadonlyArray<{
  sourceVariantId: number;
  destinationVariantId: number;
  operationType: "break_pack" | "assemble_pack" | "directed_conversion";
  inputQty: number;
  outputQty: number;
}>>
```

Reads the sealed active model only; a product without one returns an empty array,
which every consumer must treat as "no conversions", never as "unknown".

---

## Phase 3 — Migrate consumers off `parent_variant_id`

**Post-cutover only.** `break-assembly.use-cases.ts` gates on `parent_variant_id`
whenever `authority === "legacy"`, and that is the arm running in production today.
Migrating before cutover would mean writing a legacy replacement to delete a month
later.

| Consumer | Today | After |
|---|---|---|
| `server/modules/inventory/application/break-assembly.use-cases.ts` (lines 170, 309, 472, 538, 639, 753) | `authority === "legacy"` parent-child gate | Delete the legacy arms. The canonical arm (`authorizePackageConversion`, line 648) already exists and needs no change. |
| `server/modules/inventory/application/inventory-levels.query.ts:93` | `noCaseBreak: hierarchyLevel >= 2 && !parentVariantId && !isBaseUnit` | No allowed `break_pack` path out of this variant |
| `server/modules/procurement/receive-validation.service.ts:207` | "no parent while siblings have one" detector | Delete. `transformation_model_versions.validation_state` already blocks an unconfigured product, and the planner returns `MISSING_TRANSFORMATION_MODEL`. Confirm the receiving path surfaces that before deleting. |
| `server/modules/inventory/application/replenishment.use-cases.ts:3319, 3692` | Parent-chain cascade walk; parent-first sort preference | Walk allowed `break_pack` paths; order by path, or drop the preference and keep the units/position sort |

---

## Phase 4 — Remove the column

**Post-cutover, after Phase 3 soaks.**

- Writers: `server/modules/catalog/catalog.routes.ts`, `variant-uom.ts`,
  `product-duplicate.service.ts`, `piece-variant-backfill.service.ts`,
  `server/modules/inventory/infrastructure/inventory.repository.ts`,
  `server/modules/inventory/inventory.routes.ts`
- UI: the "Breaks Into (Parent Variant)" control (`ProductDetail.tsx:4320`) and the
  "Breaks Into" column (`ProductDetail.tsx:3683`); the ladder card replaces both
- Retire the per-product editor on `/inventory/supply-transformations`; the
  Variants tab is the only editor
- Schema: drop `parent_variant_id` from `shared/schema/catalog.schema.ts` and
  rewrite `product_variants_single_unit_uom_invariants_chk`, which names the column
  (`migrations/202_catalog_piece_variant_uom.sql:15-23`). The remaining invariants
  (`units_per_variant = 1 AND hierarchy_level = 1 AND is_base_unit = true`) stay.
- Retire `calculateSellableVariantAtp` and the strategy branching in
  `shared/catalog/inventory-strategy.ts` under Phase 7 of the parent plan

---

## Assumptions

Labelled as assumptions; none are verified in code.

1. Every active product will hold a sealed, valid model before Phase 3. Gate 6 of
   the parent plan requires it; this plan depends on it.
2. `receive-validation.service.ts`'s missing-parent detector has no caller that
   needs it independently of ATP. **Verify before deleting.**
3. Splitting the cutover panels onto their own route breaks no operator runbook.
4. Products with more than two package tiers render acceptably as a ladder. Worth
   checking the widest product in the catalog before building.

## Risks

- **Phase 3 before cutover breaks break/assemble.** The sequencing is the control;
  do not collapse Phase 3 into an earlier release.
- **A product with no sealed model silently loses conversions** once Phase 3 lands,
  because the port returns an empty array. Gate 6 is the mitigation, plus an
  explicit count of active products without a sealed model at Phase 3 start.
- **New products are born blocked.** `planInventoryAvailabilityBackfill` is only
  reached through the admin HTTP routes; no worker or product-creation hook calls
  it, and `inventory-availability-planner.ts` returns `status: "blocked"` for a
  product with no model. A product created after cutover has no model until someone
  opens the admin page. **This is independent of this plan and should be fixed
  before cutover, not after.**
- **Two editors during Phases 1-3.** Both write the same rows through the same
  endpoints, so they cannot disagree, but an operator can be confused about which
  to use. Phase 4 closes it.

## Test coverage

Phase 1: unit tests for the control-state ↔ path-rows mapping in both directions;
render tests per strategy; a permission test proving no query fires without
`inventory_planning:view`.

Phase 2: port unit tests including a product with no sealed model, a draft-only
product, and a retired model.

Phase 3: per consumer, a test proving old and new agree on a product with a
conventional ladder, and a test proving the new behavior on a product whose paths
contradict `parent_variant_id`. Extend `writer-ratchet.test.ts` to the new reader.

Phase 4: a migration test proving the rewritten constraint still rejects a
`piece`/`each` variant with `units_per_variant <> 1`, `hierarchy_level <> 1`, or
`is_base_unit = false`.

## Failure modes

| Failure | Detection | Response |
|---|---|---|
| Phase 3 lands with products lacking a sealed model | Count active products with no sealed model, at Phase 3 start | Block the release |
| The ladder writes a path pair that fails validation | `validation_state = 'invalid'` on draft save | Card reports the blocker; nothing seals |
| A consumer reads conversions from a draft rather than the sealed model | Port unit test | Port reads the sealed model only |
| The column is dropped while a writer remains | `npm run check` plus the migration test | Drop is the last step of Phase 4 |
