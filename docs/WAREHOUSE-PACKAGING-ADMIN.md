# Warehouse-owned packaging administration

## Ownership

- **Shipping Settings → Box catalog:** physical dimensions, weight, cost, active status and branding. Search/filter/select rows to classify branding in bulk. Saving metadata never writes warehouse availability or suite membership.
- **Shipping Settings → Box suites:** reusable collections of catalog items. Search and filter the catalog inside the suite editor. Selecting a white-label suite does not reclassify its members.
- **Warehouses → Packaging:** search/paginate warehouses, configure available packaging, and assign suites by actual fulfillment program/channel identity. The same controls are available in an individual warehouse's Settings → Packaging tab.
- **Program defaults:** remain in channel shipping configuration. Warehouse-specific assignments are managed in Warehouses. Existing exceptions are preserved when changing a default.

Packaging assignments do not enable a warehouse for order routing, decide split shipments, change inventory counts, or select a pricing program. Pricing stays independent. A program default is a suite fallback, not proof that all its boxes are physically available everywhere.

## Bulk workflow

1. Filter warehouses and select individual rows or all matching warehouses (including other pages).
2. Choose **Update available packaging** or **Assign program suites**.
3. For availability, choose catalog items directly or select members from an existing suite. Choose add or remove. Other boxes and warehouses are untouched.
4. For assignments, choose the fulfillment program and suite. Existing warehouse exceptions are preserved unless **Replace existing warehouse assignments** is explicitly checked. Choose **Use program default** with replacement enabled to clear selected exceptions.
5. Review the selected warehouses and changes, then save. A failed save keeps the draft and retry command.

An unconfigured program can be initialized with explicit default suite/branding requirements and selected warehouse exceptions in the same transaction. The review calls out that new defaults also apply to warehouses without exceptions. Coverage is validated against all enabled warehouses before commit.

Adding packaging from a suite uses a revision-checked snapshot of the selected members. Later suite additions do **not** become warehouse availability. No branding, inventory, or pricing is inferred from membership.

## Consistency and compatibility

Migration `243_warehouse_packaging_availability.sql` adds warehouse-owned availability overrides and independent warehouse revisions. It does not populate availability or change existing configuration.

`shipping.box_available_at` resolves an explicit warehouse override first. Otherwise it retains the prior availability baseline. This is intentional: reviewing warehouse A must not change historical implicit availability at warehouse B. The old `box_warehouse_stock` data is a compatibility baseline, not a second editable admin surface. New catalog items start unavailable everywhere.

Reviewed channel policies, legacy suite resolution, suite-coverage validation and packing confirmation use the same effective-availability function. Current availability is rechecked before confirming a new parcel; an identical successful confirmation remains idempotent.

Catalog, branding, warehouse availability and program assignments use the shared configuration transaction lock and immutable command journal. Commands require authenticated actors, UUID idempotency keys and expected revisions. A stale target or incompatible assigned white-label policy rejects the whole operation. Availability supports at most 1,000 warehouses, 1,000 boxes and 100,000 selected pairs per operation; the UI renders warehouse pages of 25 and catalog pages of 50.

The overview currently loads configuration metadata once and paginates it in the client. It is not a server-paged inventory or stock-count API. The regression suite exercises a 100-warehouse configuration; larger-scale latency needs measurement before claiming unlimited scale.

## Deployment and acceptance

Apply migration 242 before the new server/UI code. No production configuration is changed by this implementation. Old catalog clients submitting warehouse IDs are rejected instead of silently changing availability.

- Edit a box name or branding; confirm warehouse availability stays unchanged.
- Bulk-classify selected catalog rows; confirm suite membership stays unchanged.
- Add boxes to a suite from inside its editor. Confirm a later membership addition is not automatically available at warehouses.
- Make white-label packaging available at two warehouses. Assign that suite to Dropship and a graphic suite to the main-store program independently.
- Filter/select warehouses across pages, review and apply a bulk change. Confirm unselected warehouses remain unchanged.
- Leave replacement unchecked and confirm existing program exceptions are preserved. Explicitly replace or return selected warehouses to the program default.
- Remove availability and verify new quotes/packing reject an unavailable box. Removal may intentionally leave a suite without usable packaging; the review warns about this, and runtime fails closed.
- Open competing drafts and verify stale saves fail without partial writes. Retry a transient failure and verify only one audit command is recorded.

Automated coverage includes schema/HTTP boundaries, independent catalog writes, legacy compatibility, stale revisions, concurrent commands, suite snapshot changes, branding conflicts, audit failure rollback, real packing confirmation, 100-warehouse bulk updates, and desktop/mobile workflows. Live production acceptance remains an operator step after deployment.
