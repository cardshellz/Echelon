import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "server/modules/inventory/infrastructure/build.repository.ts"),
  "utf8",
);

describe("build repository transaction contract", () => {
  it("locks the order, component balances, and FIFO lots before mutation", () => {
    expect(source).toMatch(/build_orders[\s\S]*FOR UPDATE/);
    expect(source).toMatch(/inventory_levels[\s\S]*FOR UPDATE/);
    expect(source).toMatch(/inventory_lots[\s\S]*ORDER BY received_at, id[\s\S]*FOR UPDATE/);
  });

  it("does not consume reserved component stock", () => {
    expect(source).toContain("Number(level.variant_qty) - Number(level.reserved_qty)");
    expect(source).toContain("Number(lot.qty_on_hand) - Number(lot.qty_reserved)");
  });

  it("posts linked assemble ledger rows for inputs and outputs", () => {
    expect(source).toContain("'assemble'");
    expect(source).toContain("build_order_id, build_order_component_id");
    expect(source).toContain("build_order_id, notes, user_id");
    expect(source).toContain("reference_type, reference_id");
  });

  it("records each consumed FIFO lot on its own immutable ledger row", () => {
    expect(source).toContain("let levelQtyAfterConsumption = Number(level.variant_qty)");
    expect(source).toContain("unit_cost_cents, inventory_lot_id");
    expect(source).toContain("${unitCostCents}, ${lot.id}");
    expect(source).toContain("levelQtyAfterConsumption -= take");
  });
  it("persists authoritative integer-mill output cost layers", () => {
    expect(source).toContain("po_unit_cost_mills");
    expect(source).toContain("packaging_cost_mills");
    expect(source).toContain("landed_cost_mills");
    expect(source).toContain("total_unit_cost_mills");
    expect(source).toContain("allocateBuildCostLayers(consumedCost, outputQty)");
  });
});
