import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WMS_SYNC_SRC = readFileSync(
  resolve(__dirname, "../../wms-sync.service.ts"),
  "utf-8",
);

describe("wms-sync.service :: inventory reservation call", () => {
  it("calls reserveOrder (order-level) not reserveForOrder (per-item 5-arg)", () => {
    const reserveReadyBlock = WMS_SYNC_SRC.match(
      /warehouseStatus === "ready"[\s\S]{0,500}?reservation\.(reserveOrder|reserveForOrder)\(/,
    );
    expect(reserveReadyBlock).not.toBeNull();
    expect(reserveReadyBlock![1]).toBe("reserveOrder");
  });

  it("checks failed array from ReservationResult, not a .success property", () => {
    expect(WMS_SYNC_SRC).toMatch(/reserveResult\.failed\.length > 0/);
    expect(WMS_SYNC_SRC).not.toMatch(/reserveResult\.success/);
  });
});
