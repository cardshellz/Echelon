# OMS/WMS Webhook Follow-ups

## Open Issues

### Auto-close dead fulfillment retries when later webhook evidence proves success

Observed case:

- Retry row `108147` for shipment `103` / order `52761` died with Shopify `fulfillmentCreateV2` quantity errors.
- A later Shopify fulfillment webhook recorded `oms.oms_order_events` event `70790` with matching tracking number `9400150106151203103112`.
- The order is fulfilled, but the old retry row remains `dead`, keeping health noisy and forcing manual cleanup.

Needed behavior:

- Reconciliation should detect dead retry rows for `delayed_tracking_push` and `shopify_fulfillment_push`.
- If OMS has later proof of fulfillment/tracking success for the same order, shipment, fulfillment id, or tracking number, mark the dead retry row `success`.
- Write a clear `last_error`/note such as `auto-closed: later Shopify fulfillment webhook confirmed success`.
- Keep truly unresolved Shopify quantity/fulfillment-order errors visible.

Reason this matters:

- Dead-letter queues should represent currently actionable failures, not stale failures that later self-healed through webhook arrival.
- Operators need health counts to mean real current risk.
- This prevents the same stale Shopify fulfillment rows from being repeatedly investigated by hand.

### Provider-specific fulfillment identifiers on OMS order lines

Current `oms.oms_order_lines` columns use Shopify-specific names:

- `shopify_fulfillment_order_id`
- `shopify_fulfillment_order_line_item_id`

This is a poor long-term contract because OMS already supports multiple providers, including eBay, and dropship/provider fulfillment flows will need their own fulfillment identifiers. The OMS core should not require every downstream flow to understand Shopify naming.

Proposed follow-up:

- Introduce provider-neutral fulfillment reference fields or a separate fulfillment-line mapping table.
- Preserve provider context explicitly, for example `provider`, `provider_fulfillment_order_id`, and `provider_fulfillment_order_line_item_id`.
- Initial compatibility slice: migration `110_oms_provider_fulfillment_references.sql` adds nullable neutral columns on `oms.oms_order_lines` and backfills them from existing Shopify fulfillment-order columns while the legacy Shopify aliases remain in place.
- Shopify fulfillment push now reads provider-neutral fulfillment references first, falls back to the Shopify aliases, and back-writes both sets when Path B self-heals fulfillment-order line ids.
- Migrate Shopify values into the neutral representation.
- Update Shopify fulfillment push, eBay fulfillment/tracking, dropship fulfillment, reconciliation, and health checks to read through the neutral contract.
- Keep compatibility aliases or transitional reads from the existing Shopify columns until all call sites are migrated.

Reason this matters:

- Prevents Shopify-specific schema from leaking into eBay/dropship code.
- Makes mixed-provider fulfillment reconciliation easier to reason about.
- Reduces risk that future provider integrations add another set of one-off columns.

### Explicit fulfillment partitions for future multi-warehouse routing

Current valid shape:

- One `oms.oms_orders` row represents the customer/channel order.
- One active `wms.orders` row represents warehouse work for that OMS order.
- Multiple `wms.shipments` rows can exist under that WMS order for packages,
  labels, and partial shipment events.

Future multi-warehouse routing should allow multiple WMS work orders only when
they represent explicit, non-overlapping fulfillment partitions. Duplicate WMS
rows with the same OMS order, same warehouse context, and same item coverage are
still invalid.

Proposed follow-up:

- Add an explicit fulfillment partition concept, for example
  `fulfillment_group_id`, `fulfillment_partition_key`, or route/allocation
  version metadata.
- Model the invariant as one active WMS order per
  `source + oms_fulfillment_order_id + warehouse_id + fulfillment_partition`.
- Add a partial unique constraint/index that enforces that invariant for active
  OMS-backed WMS rows.
- Ensure each partition contains only the item quantities assigned to that
  warehouse/route, not a duplicated full copy of the order.
- Make reconciliation and health checks flag duplicate item coverage across WMS
  partitions as an integrity exception.

Reason this matters:

- Keeps today's duplicate-WMS-row race from being reintroduced as "split
  fulfillment."
- Gives future multi-warehouse routing a clear schema contract.
- Preserves the package/shipment distinction: split warehouses create explicit
  fulfillment partitions; split packages create shipments.
