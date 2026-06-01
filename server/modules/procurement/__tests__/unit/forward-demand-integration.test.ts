import { describe, expect, it } from "vitest";
import { generatePurchasingRecommendations } from "../../purchasing-recommendation.engine";

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    product_id: 10,
    variant_id: 101,
    base_sku: "SKU-FWD",
    product_name: "Forward Demand Product",
    total_pieces: 50,
    total_reserved_pieces: 5,
    total_outbound_pieces: 60,
    previous_outbound_pieces: 50,
    demand_order_count: 15,
    demand_active_days: 12,
    latest_demand_at: "2026-05-28T12:00:00.000Z",
    on_order_pieces: 0,
    open_po_count: 0,
    lead_time_days: 14,
    safety_stock_days: 7,
    order_uom_units: 1,
    vendor_product_id: 1,
    preferred_vendor_id: 1,
    preferred_vendor_name: "Test Vendor",
    estimated_cost_cents: 500,
    ...overrides,
  };
}

describe("forward demand integration into purchasing recommendations", () => {
  it("increases reorder point and suggested qty when forward demand is present", () => {
    const withoutForward = generatePurchasingRecommendations({
      lookbackDays: 30,
      rows: [baseRow({ forward_demand_pieces: 0 })],
      defaults: { leadTimeDays: 14, safetyStockDays: 7 },
    });

    const withForward = generatePurchasingRecommendations({
      lookbackDays: 30,
      rows: [baseRow({ forward_demand_pieces: 100 })],
      defaults: { leadTimeDays: 14, safetyStockDays: 7 },
    });

    const itemWithout = withoutForward.items[0];
    const itemWith = withForward.items[0];

    expect(itemWith.reorderPoint).toBeGreaterThan(itemWithout.reorderPoint);
    expect(itemWith.reorderPoint).toBe(itemWithout.reorderPoint + 100);
    expect(itemWith.suggestedOrderPieces).toBeGreaterThan(itemWithout.suggestedOrderPieces);
  });

  it("includes forward demand basis in output item", () => {
    const result = generatePurchasingRecommendations({
      lookbackDays: 30,
      rows: [baseRow({
        forward_demand_pieces: 200,
        forward_demand_raw_pieces: 250,
        forward_demand_event_count: 3,
      })],
      defaults: { leadTimeDays: 14, safetyStockDays: 7 },
    });

    const item = result.items[0];
    expect(item.forwardDemandBasis).toBeDefined();
    expect(item.forwardDemandBasis.forwardDemandPieces).toBe(200);
    expect(item.forwardDemandBasis.forwardDemandRawPieces).toBe(250);
    expect(item.forwardDemandBasis.forwardDemandEventCount).toBe(3);
    expect(item.forwardDemandBasis.adjustedReorderPoint).toBe(item.reorderPoint);
  });

  it("treats zero forward demand as no change to reorder point", () => {
    const noForward = generatePurchasingRecommendations({
      lookbackDays: 30,
      rows: [baseRow()],
      defaults: { leadTimeDays: 14, safetyStockDays: 7 },
    });

    const zeroForward = generatePurchasingRecommendations({
      lookbackDays: 30,
      rows: [baseRow({ forward_demand_pieces: 0, forward_demand_raw_pieces: 0, forward_demand_event_count: 0 })],
      defaults: { leadTimeDays: 14, safetyStockDays: 7 },
    });

    expect(noForward.items[0].reorderPoint).toBe(zeroForward.items[0].reorderPoint);
    expect(noForward.items[0].suggestedOrderPieces).toBe(zeroForward.items[0].suggestedOrderPieces);
  });

  it("forward demand can push a product from ok to order_now status", () => {
    // Product with enough stock: available = 50 - 5 = 45, velocity = 60/30 = 2/day
    // Base reorder: (14 + 7) * 2 = 42. available + 0 on_order = 45 > 42 → ok
    const okResult = generatePurchasingRecommendations({
      lookbackDays: 30,
      rows: [baseRow({ forward_demand_pieces: 0 })],
      defaults: { leadTimeDays: 14, safetyStockDays: 7 },
    });

    // With forward demand of 50: adjusted reorder = 42 + 50 = 92
    // effectiveSupply = 45, 45 < 92 → order_now
    const orderNowResult = generatePurchasingRecommendations({
      lookbackDays: 30,
      rows: [baseRow({ forward_demand_pieces: 50 })],
      defaults: { leadTimeDays: 14, safetyStockDays: 7 },
    });

    expect(okResult.items[0].status).not.toBe("order_now");
    expect(orderNowResult.items[0].status).toBe("order_now");
  });

  it("forward demand increases suggested order qty by the forward demand amount", () => {
    const base = generatePurchasingRecommendations({
      lookbackDays: 30,
      rows: [baseRow({
        total_pieces: 10,
        total_reserved_pieces: 0,
        forward_demand_pieces: 0,
      })],
      defaults: { leadTimeDays: 14, safetyStockDays: 7 },
    });

    const withFwd = generatePurchasingRecommendations({
      lookbackDays: 30,
      rows: [baseRow({
        total_pieces: 10,
        total_reserved_pieces: 0,
        forward_demand_pieces: 75,
      })],
      defaults: { leadTimeDays: 14, safetyStockDays: 7 },
    });

    // The difference in suggestedOrderPieces should be exactly the forward demand amount
    expect(withFwd.items[0].suggestedOrderPieces - base.items[0].suggestedOrderPieces).toBe(75);
  });

  it("forward demand interacts correctly with on_order supply", () => {
    // With forward demand but also sufficient on-order supply
    const result = generatePurchasingRecommendations({
      lookbackDays: 30,
      rows: [baseRow({
        total_pieces: 10,
        total_reserved_pieces: 0,
        on_order_pieces: 200,
        open_po_count: 1,
        forward_demand_pieces: 50,
      })],
      defaults: { leadTimeDays: 14, safetyStockDays: 7 },
    });

    const item = result.items[0];
    // effectiveSupply = 10 + 200 = 210
    // adjustedReorderPoint = ceil((14+7)*2) + 50 = 42 + 50 = 92
    // 210 > 92 → should not need to order
    expect(item.suggestedOrderPieces).toBe(0);
  });
});
