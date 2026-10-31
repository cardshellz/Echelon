import type {
  AutomaticPaidReplayEvidence, PaidReplayStoredOrder, PaidReplayStoredLine,
} from "../../domain/shopify-paid-replay-policy";

export function paidReplayFixture(): {
  evidence: AutomaticPaidReplayEvidence; stored: PaidReplayStoredOrder;
  lines: PaidReplayStoredLine[];
} {
  const evidence: AutomaticPaidReplayEvidence = {
    channelId: 36, shopDomain: "fixture.myshopify.com",
    order: {
      id: "1001", updated_at: "2026-10-30T12:01:00Z", financial_status: "paid", currency: "USD", discount_applications: [],
      fulfillment_status: null, cancelled_at: null, refunds: [], fulfillments: [],
      line_items: [11, 12, 13].map(id => ({
        id: String(id), sku: "FIXTURE-" + id, quantity: 1, current_quantity: 1,
        product_id: "900", variant_id: String(100 + id),
        title: "Fixture", name: "Fixture", variant_title: null,
        price: "10.00", total_discount: "0.00", discount_allocations: [],
        fulfillable_quantity: 1, requires_shipping: true,
      })),
    },
  };
  return {
    evidence,
    stored: {
      channel_id: 36, external_order_id: "1001", status: "confirmed", financial_status: "paid",
      fulfillment_status: "unfulfilled", settled: true, source_domain: evidence.shopDomain,
      paid_payload: { ...structuredClone(evidence.order), updated_at: "2026-10-30T12:00:00Z" },
    },
    lines: evidence.order.line_items.map(line => ({
      external_line_item_id: line.id, sku: line.sku, quantity: 1, requires_shipping: true,
      paid_quantity: 0, authority_fulfillable_quantity: 0, cancelled_quantity: 0,
      refunded_quantity: 0, wms_materialized_quantity: 0, authorization_status: "seen",
      channel_current_quantity: 1, channel_quantity_updated_at: "2026-10-30T12:00:30Z",
    })),
  };
}
