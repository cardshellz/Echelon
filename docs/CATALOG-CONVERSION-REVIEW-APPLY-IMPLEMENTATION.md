# Product conversion Review and Apply — 2026-09-18

## Scope and delivery status

Implemented locally on `codex/catalog-conversion-review-apply-20260918`, based on
merged PR #1494 (`a5f221a9dde14ef5a035315e3d293c72c9d986f1`). Not merged,
deployed, or exercised against production. Unrelated checkout changes preserved.

This is product-model Review/Apply, Procurement-owned safety-policy Review/Apply,
automatic publication progress, and the read-only Inventory safety display.
Expanded Phase 1 is implemented locally; Phases 2–4 are untouched.

## Confirmed implementation

- `ProductDefinitionReview` in
  `client/src/features/inventory-builds/ProductDefinitionReview.tsx` presents
  current versus saved rules, warehouse ATP, proposed channel quantities, blockers,
  permission-gated Apply, and separate publication progress. Uncertain responses
  retain the identical command key for retry; editing is disabled during that
  uncertainty. This retry state is component-local, not durable across navigation.
- `registerProductDefinitionRoutes` in
  `server/modules/inventory-planning/interfaces/http/inventory-product-definition.routes.ts`
  requires planning view for review/progress and planning activate for Apply.
  Actor identity comes from the authenticated session.
- `captureReview` and `PostgresProductDefinitionStore.apply` in
  `server/modules/inventory-planning/infrastructure/inventory-product-definition.repository.ts`
  use existing canonical snapshots, ATP and channel publication. Review selects
  only the edited product's draft, retaining active definitions elsewhere. The
  affected scope includes reverse active recipe dependencies.
- Apply locks its idempotency key, acquires the existing canonical admission
  fence, recaptures evidence, rejects changed/blocked review, promotes only the
  selected model, enqueues publication, and records an immutable receipt in one
  transaction. A receipt failure rolls back model promotion and publication.
  Previous model identity/hash are included in the persisted review. Neither
  migration commit nor physical movement nor provider HTTP runs in this command.
- Migration `0680_inventory_product_definition_applications.sql` adds immutable
  receipts with unique retry keys and fence-protected insertion. It does not
  activate runtime authority. Insertion requires the active sealed product model.
- `ProductSafetySummary` in
  `client/src/features/inventory-builds/ProductSafetySummary.tsx` reads the existing
  safety-policy endpoint, distinguishes active policy from drafts, and links to
  Procurement. It introduces no duplicate editor or policy store.
- `SafetyDefinitionReview`, `SafetyDefinitionService`, and
  `PostgresSafetyDefinitionStore` provide the Procurement-owned safety workflow
  for business, network/variant, and warehouse/variant scopes. The review expands
  to the complete affected SKU/product graph, shows ATP/channel impact, and Apply
  uses the same canonical fence, idempotency, immutable receipt, and outbox path.

## Validation

- Focused Vitest suites passed, including 19 real disposable
  PostgreSQL composition tests; no production database connection was used.
- Database tests exercise unchanged stock/claims/authority, rejected stale review,
  injected receipt-write rollback, concurrent identical retries, actor-conflicting
  retries, immutable receipt protection, and actual publication composition.
- Snapshot tests verify one-product draft selection and active-only selection for
  other products. Command-boundary tests reject invalid identifiers, forged actor
  input, missing authentication, and malformed review hashes.
- All 20 catalog conversion browser tests passed across desktop/mobile, including
  lost-response same-command retry and current-versus-draft review.
- Application, client-test, and server-test TypeScript checks passed on the final implementation.
- Four HTTP tests verify view versus activate permission, denial before mutation,
  authenticated actor propagation, and stale-review conflict responses.
- Migration-prefix and writer-owner guards pass. Only the new receipt table was
  added to the existing inventory-planning writer-owner baseline.

## Boundaries and remaining proof

- Source/testing is not evidence that production canonical authority is active,
  role grants are configured, or providers accepted quantities. Runtime Apply
  refuses legacy authority. Publication status reflects persisted worker state.
- Released build execution reads its retained model by recorded ID, not the new
  active head (`transformation-execution-authority.repository.ts`, retained build
  authorization path). Old sealed models are preserved. The new tests prove
  claim rows unchanged, but do not constitute end-to-end picker/build execution
  acceptance after a model change.
- Full repository CI, dedicated safety-summary browser coverage, and production
  read-only acceptance remain to be completed before calling this production-proven.
  Review graph size is bounded at 1,000 products;
  larger scopes reject rather than partially apply.
- No live provider calls, production settings, stock, reservations, channel
  quantities, or migrations were changed during implementation.
