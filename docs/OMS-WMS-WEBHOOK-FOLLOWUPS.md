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
- Migrate Shopify values into the neutral representation.
- Update Shopify fulfillment push, eBay fulfillment/tracking, dropship fulfillment, reconciliation, and health checks to read through the neutral contract.
- Keep compatibility aliases or transitional reads from the existing Shopify columns until all call sites are migrated.

Reason this matters:

- Prevents Shopify-specific schema from leaking into eBay/dropship code.
- Makes mixed-provider fulfillment reconciliation easier to reason about.
- Reduces risk that future provider integrations add another set of one-off columns.
