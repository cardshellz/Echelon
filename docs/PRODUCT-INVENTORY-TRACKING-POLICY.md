# Product inventory tracking and confirmation-only picking

## Behavior

Inventory tracking is a warehouse policy, separate from accounting `inventoryType`, product inventory strategy, and shipping eligibility. The product owns `inventoryTrackingDefault`. A variant owns a nullable `inventoryTrackingOverride`: `null` inherits, `true` tracks, and `false` does not track.

| Product default | Variant override | Physical variant behavior |
| --- | --- | --- |
| Track | Inherit | Track |
| Track | Track | Track |
| Track | Do not track | Confirmation only |
| Do not track | Inherit | Confirmation only |
| Do not track | Track | Track |
| Do not track | Do not track | Confirmation only |

Products with no variants use the product default directly. Digital variants remain untracked regardless of the default or override. `resolveInventoryTrackingPolicy` in `shared/catalog/inventory-tracking-policy.ts` owns this decision. The existing `product_variants.track_inventory` column is an effective projection so existing ATP, stock, and publication readers see the same answer.

In Product Detail, edit **Default inventory tracking**. In each variant editor, select **Inherit product**, **Track inventory**, or **Do not track inventory**. Returning an override to Inherit immediately uses the current product default. Changing the product default leaves explicit overrides intact.

## Identity and order policy

`resolveOrderLineCatalogIdentity` in `server/modules/oms/order-line-catalog-identity.service.ts` resolves a product without variants through a verified, channel-scoped product binding. The Shopify mapping panel can verify and link a remote product without creating warehouse variants. A reused source SKU cannot override this binding. SKU fallback also rejects known conflicting provider product/variant identities.

The schema supports channel-scoped bindings; the product-only setup UI in this change is Shopify-specific. There is no automatic product-name match, unscoped provider-ID match, or product-SKU fallback that could guess the owner. A tracked physical product still requires its normal stock variant before inventory movement can occur.

New OMS lines record catalog product identity and effective inventory tracking; WMS materialization copies these facts and the canonical product/variant SKU. Source replay preserves established snapshots, including legacy NULL snapshots. A later product setting change affects new lines rather than rewriting old orders. The migration does not classify existing orders or repair historical pick records.

## Picking, reservation, and fulfillment

`PickingUseCases.pickItem` records explicit untracked physical items as confirmation-only picks. Both inventory authorities retain quantity validation, order/item locks, replay checks, and an atomic audit event. Unpick reverses confirmed progress without stock movement. These lines do not require a bin or create reservation, lot, stock, or replenishment demand. Queue reads do not borrow another SKU's bin or replenishment hints.

Missing identity is not an implicit permission to bypass inventory. Tracked snapshots that conflict with the current catalog stop for review. Legacy reservation and canonical claim readers honor the same explicit untracked snapshot. `decideChannelFulfillmentInventoryPosting` requires matching OMS/WMS product and policy facts before bypassing inventory posting; normal physical shipment evidence requirements still apply. An untracked product without a provider SKU can use its materialized WMS SKU at fulfillment ingress.

Rejected stock picks return failure with unchanged progress. `Picking.tsx` restores confirmed line and order/batch state, reports the rejection, and prevents false completion. The regression harness exercises the actual page handlers with real React and mocked transport; it is not a live warehouse session.

## Policy writes and rollout

`updateProductInventoryTracking` and `prepareVariantInventoryTracking` in `server/modules/catalog/inventory-tracking-policy.repository.ts` lock parent products before variants. Effective changes are blocked by nonzero stock/custody, lots, active claims/resources, unfinished order demand, or pending publication work. Product changes project inherited variants atomically and are audited; variant edits retain the existing fulfillment audit with override before/after values. Disabling tracking deactivates quantity feeds. Re-enabling does not automatically activate them.

Migration `0693_product_inventory_tracking_policy.sql` defaults products to tracked and preserves existing explicit false variant settings as false overrides. Existing true/NULL variant values initially inherit the true default. Re-running the migration does not convert inherited choices into overrides. Deferred projection constraints reject inconsistent direct writes. Custody/claim triggers serialize nonzero inventory writes with policy changes and reject inventory ownership by untracked identities.

Apply the migration before deploying code that selects its new columns. Configure the intended product defaults and verified mappings before accepting new orders for product-only items; an unmapped physical item will require review. Existing stock or work blockers need their own reviewed resolution. No stock quantities, completed orders, channel tracking numbers, or production catalog settings are changed by this PR's implementation work. External provider inventory settings are not automatically changed by this warehouse policy.

## Validation and limits

- Policy matrix, digital eligibility, malformed/ambiguous writes, and shipping-policy disagreement have unit coverage.
- Disposable PostgreSQL exercises migration/replay, both override directions, returning to inheritance, rollback, concurrent receipt versus disabling tracking, verified product-only mapping, channel isolation, reused SKU rejection, OMS replay, WMS materialization, reservation/claim exclusion, and pick/replay/unpick under both inventory authorities.
- The PostgreSQL CI manifest grows from 88 to 89 files. Reduced schema fixtures include the new columns so Drizzle reads exercise the same field contract.
- Desktop/mobile browser tests cover rejected, tracked-success, and untracked-success responses for manual, scan, and pick-all handlers with one and four unfinished lines.

The local checks do not establish production deployment, live provider verification, or live handheld behavior. The existing restricted receipt-repair workflow retains its evidence requirements; this change does not authorize historical recovery.
