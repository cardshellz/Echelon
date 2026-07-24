import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "server/modules/procurement/purchase-forecast-backtesting.repository.ts"),
  "utf8",
);

describe("purchase forecast backtesting actual-demand query", () => {
  it("uses a closed mature horizon and a half-open demand interval", () => {
    expect(source).toContain("observed_through_exclusive");
    expect(source).toContain("recommendation_run.as_of + MAKE_INTERVAL(days => horizon.horizon_days) <= ${input.asOf}");
    expect(source).toContain("customer_order.order_placed_at >= candidate.observed_from");
    expect(source).toContain("customer_order.order_placed_at < candidate.observed_through_exclusive");
  });

  it("matches the recommendation demand eligibility filters and product base-piece conversion", () => {
    expect(source).toContain("customer_order.cancelled_at IS NULL");
    expect(source).toContain("customer_order.warehouse_status != 'cancelled'");
    expect(source).toContain("order_item.status != 'cancelled'");
    expect(source).toContain("COALESCE(order_item.requires_shipping, 1) = 1");
    expect(source).toContain("variant.sku = order_item.sku");
    expect(source).toContain("variant.product_id = candidate.product_id");
    expect(source).toContain("order_item.quantity::bigint * variant.units_per_variant::bigint");
  });

  it("loads immutable overlay contributions with deterministic event-line ordering", () => {
    expect(source).toContain("FROM procurement.purchase_forecast_overlay_contributions contribution");
    expect(source).toContain("WHERE contribution.observation_id = observation.id");
    expect(source).toContain("contribution.event_start_date");
    expect(source).toContain("contribution.demand_event_id");
    expect(source).toContain("contribution.demand_event_line_id");
  });
});
