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

### Baseline before Phase 1 (source-verified; line references are historical)

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

**Revised scope after operator review: UI consolidation plus routine Review → Apply.
In progress; not ready for deployment or activation.** Draft editing remains
available under either runtime authority. Routine Apply must use canonical
authority and must not invoke the legacy-to-canonical migration command.

Replace `ProductBuildRelationships` with a single card whose shape follows
`products.inventory_strategy` (`shared/catalog/inventory-strategy.ts`):

| Strategy | Label | Card shows |
|---|---|---|
| `physical_fungible` | Package hierarchy | The package ladder, one row per adjacent pair, with a direction control |
| `recipe_managed` | Build managed | Recipes — today's Build Relationships content |
| `physical_only` | Physical only | Hide this section entirely. Existing rule evidence remains accessible through Overview and the detailed administrative editor. |

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

These routes support draft editing only. Phase 1 now also requires a routine
review/apply contract; this is not a replacement ATP engine. The current migration
commit is not that contract: it requires legacy authority and performs opening
obligation reconciliation and global runtime cutover.

### Agreed routine workflow

- Show verified active rules by default. A separate draft banner offers continued
  editing; edits are labeled "Your changes — not live". Cancelling returns to
  active rules. Drafts do not require a written reason from the operator.
- Review the exact saved draft against current rules, with warehouse/SKU ATP
  results and blocking validation. Do not silently refresh or rebase an already
  reviewed version. The ATP calculation remains the existing canonical planner.
- Apply requires `inventory_planning:activate`; edit and view retain their
  existing permissions. One person can hold all three; no second approver is
  required. Actual role grants are not inferred from source defaults.
- Apply must atomically promote only reviewed definitions, record an immutable
  idempotent receipt, and enqueue the affected channel quantities through the
  existing publication service. It must not move inventory, assemble products,
  replace the ATP engine, or invoke migration commit.
- The UI distinguishes "Rules applied" from channel delivery progress. Channel
  updates start automatically; no second Publish action. Existing bounded retries
  and terminal failures must remain visible rather than claiming delivery on enqueue.
- Safety policy editing belongs to Procurement. Inventory must display the same
  policy read-only with a link to its owner. Routine safety apply also needs review
  of its complete affected SKU/warehouse scope; relocation alone does not supply it.
- Migration is temporary administrative work, not the daily product workflow.
  Its audit history remains available after migration; hiding normal navigation
  requires verified migration state, not a hardcoded assumption.

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
  removes it. Both editors use the same authority. Concurrent forms can be stale;
  edits must retain their captured model/version/hash/head tokens and require
  review after a conflict, not automatically rebase an old form.

### Not in Phase 1

The strategy radio stays editable while authority is `legacy`, and
`parent_variant_id` keeps its current backend meaning. Its ProductDetail display
is labeled legacy/read-only and ordinary SKU updates omit the parent field.
The database column and downstream consumers are not retired in this phase.

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
  endpoints, but an open form can become stale. Preserve optimistic concurrency
  evidence and require reload/review on conflict. Phase 4 removes the second editor.

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
| The ladder submits a path pair that fails validation | Draft endpoint rejects graph validation before persistence | Card reports the rejection; no new draft is saved or sealed |
| A consumer reads conversions from a draft rather than the sealed model | Port unit test | Port reads the sealed model only |
| The column is dropped while a writer remains | `npm run check` plus the migration test | Drop is the last step of Phase 4 |

## Phase 1 implementation record — 2026-09-18

Follow-up implementation: see [Product conversion Review and Apply](CATALOG-CONVERSION-REVIEW-APPLY-IMPLEMENTATION.md)
for the local product-model Apply transaction, publication progress, and Inventory
safety summary. The record below describes PR #1494, not that later branch.
Expanded Phase 1 remains open for complete-scope Procurement safety-policy Apply.

Status: **partially implemented; expanded Phase 1 is not complete** in the clean `codex/catalog-conversion-ui-consolidation-20260918`
worktree from refreshed `origin/main` commit `c073e22d617c17d9dd7496c63ee8b8658e25163c`.
Not committed, merged, deployed, or activated by this work. The original checkout's
unrelated edits were left untouched. Phases 2–4 are not implemented here.

### Delivered surfaces

- `ProductConversionCard` and `ProductConversionSummary`,
  `client/src/features/inventory-builds/ProductConversionCard.tsx`: strategy-shaped
  Variants card; separate read-only active-model summary beside Inventory behavior.
  Catalog-only users do not mount the planning query. Read-only users see direction
  labels, not editing controls. Recipe-managed products retain Build Relationships.
- `buildPackageLadder` / `updatePackageLadderDirection`,
  `client/src/features/inventory-builds/package-conversion-ladder.ts`: explicit
  adjacent directed pairs, existing GCD quantity derivation, no parent-link seeding,
  no inferred reverse path. Unrelated/nonadjacent paths remain unchanged.
- `beginPackageConversionEdit` / `buildPackageConversionCommand`,
  `client/src/features/inventory-builds/package-conversion-draft.ts`: captured
  optimistic-concurrency evidence, schema-validated requests, same-request retry
  after uncertain outcomes, no automatic conflict rebase. Routine package edits
  use a visible, factual system-generated audit note, not a required reason field.
- `InventoryCutover`, `client/src/pages/InventoryCutover.tsx`: six existing global
  sections moved to `/inventory/cutover`. Existing request bodies and activation
  guards remain. Manual review retains matching model/hash/head checks and frozen
  recipe evidence in `inventory-migration-queue-panel.tsx`.
- `ProcurementPromiseSafetySettings`,
  `client/src/pages/ProcurementPromiseSafetySettings.tsx`: ATP floors and demand
  evidence at `/settings/procurement/promise-safety`, distinct from purchasing
  `safetyStockDays`. Its planning-view permission preserves access for non-admin
  planners without granting access to admin Procurement settings. Existing safety
  mutation contracts and reason fields are unchanged.

### Safeguards and qualified plan assumptions

1. **The ladder is not the whole graph.** Blocked, recipe-backed, custom-ratio,
   duplicate, equal-sized, or otherwise ambiguous paths are never silently rewritten
   as four ordinary direction states. They remain visible/read-only or linked to
   the retained detailed editor. Known catalog-unit snapshot drift blocks saving.
2. **Mixed recipe models are read-only in the simple ladder.** The existing service
   reconstructs recipe snapshots on every full-definition save
   (`buildTransformationDefinition`,
   `server/modules/inventory-planning/application/inventory-availability-master-data.service.ts`).
   Preserving recipe IDs alone would not preserve recipe contents. Models with any
   recipe bindings therefore require the detailed editor; no backend workaround
   was added to this presentation-only phase.
3. **Strategy is presentation, not proof of runtime authority.** Runtime labels use
   `runtimeSelection`, not the API's always-legacy `runtimeAuthority` descriptor.
   Physical-only products have no Variants conversion card. Overview still
   distinguishes approved active-model sharing from draft proposals. A model is
   displayed as active only when sealed and matched to both the product and head;
   the runtime must independently report canonical authority to call it live.
4. **Existing API limitations remain.** Frontend checks detect loaded snapshot
   drift, not an atomic pin of catalog metadata. POST creation from a sealed model
   cannot supply an expected active-head revision. Saved drafts still require
   separate review/approval; this change never activates them.
5. **No retirement or production proof.** The legacy strategy radio, parent column,
   read-only legacy parent display, downstream consumers, and old per-product editor remain.
   No live runtime, inventory, recipes, configuration, ATP, claims, or channel
   quantities were inspected or changed. Cutover readiness is not established by
   these frontend tests.

### Verification

- Application TypeScript and client-test TypeScript checks passed.
- Mocked browser tests passed on desktop and mobile: 16/16, including exact
  direction payloads, nonadjacent-path preservation, permission degradation,
  stale-token rejection, and byte-identical uncertain-save retries. Desktop/mobile
  screenshots were inspected; the package card fits both widths without overflow.
- Focused ladder/draft helpers: 78/78 tests passed. Safety relocation: 22/22.
  Cutover relocation and existing guard suites also passed.
- Final combined affected-area regression run: 13 files, 163/163 tests passed,
  including the active-versus-draft overview summary added during review.
- Broader client + inventory-planning unit run: 257 files passed, two untouched
  Dropship source-text suites failed (three assertions). All four involved source/
  test files match the base Git blobs. In-memory reproduction passes all three
  assertions on the base LF text, fails all three on the CRLF checkout, and passes
  after in-memory normalization. These existing Windows line-ending failures were
  not changed; do not claim the entire repository test suite is green.

### Latest continuation verification and remaining work

- Active-first display, explicit draft editing, cancel-to-active, physical-only
  hiding, and legacy-parent read-only presentation are implemented locally.
- Focused conversion tests: 98/98 passed across four files. Mock browser tests:
  18/18 passed across desktop/mobile, including distinct active/draft directions.
- These are local/mock results, not production acceptance or provider delivery.
- Routine per-product Review → Apply, its transaction/integration tests, channel
  progress UI, and Inventory's read-only safety display are **not implemented**.
  No Apply button is wired to the global migration command as a substitute.

Next work remains **inside Phase 1**, not Phase 2. Complete the above routine
workflow before declaring this phase finished. Phase 3 consumer migration and
Phase 4 retirement remain explicitly cutover-gated.
