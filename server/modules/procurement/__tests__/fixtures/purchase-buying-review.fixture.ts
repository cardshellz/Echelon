import type { PurchasingRecommendationRawRow } from "../../purchasing-recommendation.engine";

export const PURCHASE_BUYING_AS_OF = "2026-09-10T12:00:00.000Z";

/** Baseline target 370 + dated demand 100, compared with 300 available pieces. */
export function forwardDemandBuyingRow(onOrderPieces = 100): PurchasingRecommendationRawRow {
  return {
    product_id: 1, base_sku: "FORWARD-STOCK", product_name: "Forecast stock",
    total_pieces: 300, total_outbound_pieces: 300, preferred_vendor_id: 10,
    lead_time_days: 30, safety_stock_days: 7, on_order_pieces: onOrderPieces, open_po_count: 1,
    recommendation_analysis_date: "2026-09-10",
    recommendation_analysis_as_of: PURCHASE_BUYING_AS_OF,
    inventory_variant_policies: [{ requiresShipping: true, trackInventory: true }],
    inbound_schedule: [{
      purchaseOrderId: 20, purchaseOrderNumber: "PO-FORWARD", purchaseOrderLineId: 21,
      remainingPieces: onOrderPieces, expectedDate: "2026-09-11", expectedDateSource: "line_promised",
    }],
    receipt_supply_evidence: { version: 1, lines: [{
      purchaseOrderId: 20, purchaseOrderNumber: "PO-FORWARD", purchaseOrderLineId: 21,
      orderedPieces: onOrderPieces, cancelledPieces: 0, poReceivedPieces: 0,
      postedReceivedPieces: 0, closedGrossReceivedPieces: 0, closedReceivedPieces: 0,
      remainingPieces: onOrderPieces, receivingLineIds: [], reviewIssues: [],
    }] },
    forward_demand_pieces: 100, forward_demand_raw_pieces: 100, forward_demand_event_count: 1,
    forward_demand_planning_as_of_date: "2026-09-10", forward_demand_horizon_days: 90,
    forward_demand_contributions: [{
      productId: 1, productVariantId: null, demandEventId: 30, demandEventLineId: 31,
      eventName: "Planned promotion", eventType: "promotion", eventStatus: "planned",
      eventStartDate: "2026-09-20", eventEndDate: null, planningAsOfDate: "2026-09-10",
      expectedPieces: 100, confidence: "high", confidenceWeightPercent: 100, weightedPieces: 100,
      eventUpdatedAt: "2026-09-09T12:00:00.000Z", lineUpdatedAt: "2026-09-09T12:00:00.000Z",
    }],
  };
}
