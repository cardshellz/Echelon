/**
 * Structural contract: WMS sync asks for the Dropship-pinned warehouse before
 * the generic router, stamps whatever it chose onto the WMS order, and loads
 * the warehouse and assignment facts the decision needs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "../../wms-sync.service.ts"), "utf-8");

describe("wms-sync.service :: Dropship warehouse authority", () => {
  it("consults the pinned Dropship warehouse before the fulfillment router", () => {
    const pinned = SRC.indexOf("await this.resolvePinnedDropshipWarehouse(omsOrder)");
    const routed = SRC.indexOf("this.services.fulfillmentRouter.routeOrder({");
    expect(pinned).toBeGreaterThan(-1);
    expect(routed).toBeGreaterThan(pinned);
    expect(SRC).toContain("if (!routing) {");
    expect(SRC).toContain("warehouseId: routedWarehouseId,");
  });

  it("identifies Dropship orders by channel or acceptance stamp and validates the pinned warehouse", () => {
    expect(SRC).toContain('from "./dropship-order-warehouse"');
    expect(SRC).toContain("hasDropshipAcceptanceStamp(omsOrder.rawPayload)");
    expect(SRC).toContain("if (!isDropshipOmsOrder(identity)) return null;");
    expect(SRC).toContain("eq(channelWarehouseAssignments.enabled, true)");
    expect(SRC).toContain("isActive: warehouses.isActive");
    expect(SRC).toContain("decideDropshipOrderWarehouse({");
  });

  it("keeps a failed channel resolution from stopping other channels' syncs", () => {
    expect(SRC).toContain("dropshipOmsChannel: { resolveChannelId(): Promise<number> };");
    expect(SRC).toContain('logger.warn("wms_sync_dropship_channel_resolve"');
    expect(SRC).toMatch(/private async resolveDropshipOmsChannelId\(\): Promise<number \| null>/);
  });
});
