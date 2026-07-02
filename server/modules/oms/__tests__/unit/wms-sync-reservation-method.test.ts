import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WMS_SYNC_SRC = readFileSync(
  resolve(__dirname, "../../wms-sync.service.ts"),
  "utf-8",
);

describe("wms-sync.service :: inventory reservation call", () => {
  it("calls reserveOrder (order-level) not reserveForOrder (per-item 5-arg)", () => {
    // P0.1c: the ready branch reserves via the shortfall guard, which wraps
    // the order-level reserveOrder. The per-item 5-arg reserveForOrder must
    // never appear in wms-sync.
    const reserveReadyBlock = WMS_SYNC_SRC.match(
      /warehouseStatus === "ready"[\s\S]{0,500}?reserveWithShortfallGuard\(/,
    );
    expect(reserveReadyBlock).not.toBeNull();
    expect(WMS_SYNC_SRC).toContain("this.services.reservation.reserveOrder(wmsOrderId)");
    expect(WMS_SYNC_SRC).not.toMatch(/reservation\.reserveForOrder\(/);
  });

  it("checks failed array from ReservationResult, not a .success property", () => {
    expect(WMS_SYNC_SRC).toMatch(/reserveResult\.failed\.length/);
    expect(WMS_SYNC_SRC).not.toMatch(/reserveResult\.success/);
  });
});
