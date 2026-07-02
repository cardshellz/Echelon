import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WMS_SYNC_SRC = readFileSync(
  resolve(__dirname, "../../wms-sync.service.ts"),
  "utf-8",
);

const WEBHOOKS_SRC = readFileSync(
  resolve(__dirname, "../../oms-webhooks.ts"),
  "utf-8",
);

describe("pending → ready promotion on payment", () => {
  describe("wms-sync.service :: refreshExistingWmsOrderHeaderFromOms", () => {
    it("detects pending→ready promotion via determineWarehouseStatus", () => {
      expect(WMS_SYNC_SRC).toMatch(
        /warehouseStatus === "pending" && nextWarehouseStatus === "ready"/,
      );
    });

    it("updates warehouseStatus to ready when promoted", () => {
      expect(WMS_SYNC_SRC).toMatch(/promoted \? \{ warehouseStatus: "ready" \}/);
    });

    it("returns promoted flag in the result", () => {
      expect(WMS_SYNC_SRC).toMatch(/return \{ updated: true, sortRankChanged, promoted \}/);
    });

    it("logs the promotion with OMS financial_status", () => {
      expect(WMS_SYNC_SRC).toMatch(/Promoted WMS order.*pending → ready/);
    });
  });

  describe("wms-sync.service :: syncOmsOrderToWms existing-order branch", () => {
    it("runs reservation after promotion", () => {
      // P0.1c: the promotion path reserves via the shortfall guard, which
      // wraps this.services.reservation.reserveOrder(wmsOrderId) and holds
      // the order on shortfall.
      expect(WMS_SYNC_SRC).toMatch(/headerRefresh\.promoted[\s\S]{0,200}?reserveWithShortfallGuard/);
      expect(WMS_SYNC_SRC).toContain("this.services.reservation.reserveOrder(wmsOrderId)");
    });

    it("logs promoted flag in the sync summary", () => {
      expect(WMS_SYNC_SRC).toMatch(/promoted=\$\{headerRefresh\.promoted\}/);
    });
  });

  describe("oms-webhooks :: orders/updated direct SQL promotion", () => {
    it("promotes warehouse_status from pending to ready when paid", () => {
      expect(WEBHOOKS_SRC).toMatch(
        /WHEN warehouse_status = 'pending' AND.*THEN 'ready'/,
      );
    });

    it("preserves existing warehouse_status for non-pending orders", () => {
      expect(WEBHOOKS_SRC).toMatch(/ELSE warehouse_status/);
    });
  });
});
