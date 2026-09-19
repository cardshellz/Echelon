# Catalog conversion Phase 2 — conversion read port

Implemented on `codex/catalog-conversion-phase2-read-port` from merged
`origin/main` (`8b6b601cdf1c4bd7269f6ace53a21ca96ea3686b`).

## Contract

`server/modules/inventory-planning/application/inventory-conversion-read.port.ts`
publishes `InventoryConversionReader.getAllowedConversions(productId)`. The
result contains only source variant, destination variant, operation, input
quantity, and output quantity. It has no catalog-parent terminology and does
not expose planning tables to callers.

## Owner and selection rules

`PostgresInventoryConversionReader` is the planning-owned implementation. It
reads the product's `transformation_model_heads.active_model_id`, then requires
the referenced model to be `sealed` and `valid`. It returns only paths that are
`allowed` and `valid`, ordered deterministically. A missing head, draft-only
product, retired model, or no matching path returns an empty array. Invalid
product IDs fail before opening a database connection.

No Phase 3 consumer has been changed. `parent_variant_id` remains in place and
continues to govern legacy behavior until canonical post-cutover migration is
approved separately.

## Evidence

- Seven read-port unit tests passed, covering sealed active selection, empty
  no-model behavior, and invalid input.
- Writer ownership guard passed.
- `npm run check:tests` passed for server and client test typechecking.
- No production database, inventory, ATP, reservations, channels, or provider
  state was changed.
