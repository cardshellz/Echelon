import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { shouldCreateInitialWmsShipment } from "../../wms-sync.service";

const WMS_SYNC_SRC = readFileSync(
  resolve(__dirname, "../../wms-sync.service.ts"),
  "utf-8",
);

describe("wms-sync.service :: shippable item gates", () => {
  it("does not create or push ShipStation shipments for digital-only OMS orders", () => {
    expect(WMS_SYNC_SRC).toMatch(/const txHasShippableItems = remainingOmsLines\.some\(\(line\) => line\.requiresShipping !== false\)/);
    expect(shouldCreateInitialWmsShipment({
      hasShippableItems: false,
      isDropshipAcceptanceClaim: false,
      warehouseStatus: "completed",
    })).toBe(false);
  });

  it("creates initial shipment work only for ready ordinary physical fulfillment", () => {
    expect(shouldCreateInitialWmsShipment({
      hasShippableItems: true,
      isDropshipAcceptanceClaim: false,
      warehouseStatus: "ready",
    })).toBe(true);
    expect(shouldCreateInitialWmsShipment({
      hasShippableItems: true,
      isDropshipAcceptanceClaim: true,
      warehouseStatus: "pending",
    })).toBe(false);
    expect(shouldCreateInitialWmsShipment({
      hasShippableItems: true,
      isDropshipAcceptanceClaim: false,
      warehouseStatus: "pending",
    })).toBe(false);
    expect(shouldCreateInitialWmsShipment({
      hasShippableItems: true,
      isDropshipAcceptanceClaim: false,
      warehouseStatus: "awaiting_3pl",
    })).toBe(false);
    expect(WMS_SYNC_SRC).toContain("if (!shouldCreateInitialWmsShipment(input)) return null;");
  });

  it("only includes shippable lines in outbound shipment item inputs", () => {
    expect(WMS_SYNC_SRC).toMatch(/requiresShipping: wmsOrderItems\.requiresShipping/);
    expect(WMS_SYNC_SRC).toMatch(/\.filter\(\(item: any\) => item\.requiresShipping !== 0/);
    expect(WMS_SYNC_SRC).toMatch(/hasShippableItems = materializableOmsLines\.some\(line => line\.requiresShipping !== false\)/);
  });

  it("admits no shipment or provider outbox work in the WMS materialization transaction", () => {
    const materializationStart = WMS_SYNC_SRC.indexOf("const txResult = await db.transaction");
    const materializationEnd = WMS_SYNC_SRC.indexOf("// Concurrency guard tripped", materializationStart);
    const materialization = WMS_SYNC_SRC.slice(materializationStart, materializationEnd);

    expect(materializationStart).toBeGreaterThan(0);
    expect(materializationEnd).toBeGreaterThan(materializationStart);
    expect(materialization).not.toContain("createShipmentForOrder(");
    expect(materialization).not.toContain("linkChildToParentShipment(");
    expect(materialization).not.toContain("enqueueShipStationShipmentPushRetry(");
  });

  it("persists shipment and outbox atomically only in the post-authority transaction", () => {
    const methodStart = WMS_SYNC_SRC.indexOf(
      "private async persistInitialProviderShipmentAfterInventoryAuthority",
    );
    const nextMethod = WMS_SYNC_SRC.indexOf("\n  /**", methodStart + 1);
    const method = WMS_SYNC_SRC.slice(methodStart, nextMethod);

    expect(methodStart).toBeGreaterThan(0);
    expect(method).toContain("return db.transaction(async (tx: any)");
    expect(method).toContain("createShipmentForOrder(");
    expect(method).toContain("linkChildToParentShipment(");
    expect(method).toMatch(
      /await enqueueShipStationShipmentPushRetry\(\s*tx,\s*shipment\.shipmentId,\s*"initial shipping-engine handoff after inventory authority",\s*\)/,
    );
  });
});
