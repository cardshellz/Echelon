import { describe, expect, it, vi } from "vitest";

import { resolveRecoveredShipNotifyNoMatchExceptions } from "../../ship-notify-reconciliation.service";

function queryText(query: any): string {
  return (query?.queryChunks ?? [])
    .flatMap((chunk: any) => chunk?.value ?? [])
    .join(" ");
}

describe("ship-notify reconciliation exception recovery", () => {
  it("resolves an exception only from exact provider physical shipment linkage", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = queryText(query);
      expect(text).toContain("UPDATE wms.reconciliation_exceptions");
      expect(text).toContain("shipment.external_fulfillment_id");
      expect(text).toContain("physical_shipment.provider_physical_shipment_id");
      expect(text).toContain("exception.wms_order_id = match.wms_order_id");
      expect(text).toContain("exception.wms_shipment_id = match.wms_shipment_id");
      expect(text).not.toContain("shipstation_order_id");
      expect(text).not.toContain("tracking_number");
      return {
        rows: [{
          exception_id: 1,
          wms_order_id: 204628,
          wms_shipment_id: 4813,
          external_shipment_ref: "442498656",
        }],
      };
    });

    const result = await resolveRecoveredShipNotifyNoMatchExceptions(
      { execute },
      {
        externalShipmentRef: "442498656",
        limit: 10,
        now: new Date("2026-07-11T14:00:00.000Z"),
        resolvedBy: "system:test",
      },
    );

    expect(result).toEqual({
      resolvedCount: 1,
      recovered: [{
        exceptionId: 1,
        wmsOrderId: 204628,
        wmsShipmentId: 4813,
        externalShipmentRef: "442498656",
      }],
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid provider identities and limits before querying", async () => {
    const execute = vi.fn();

    await expect(resolveRecoveredShipNotifyNoMatchExceptions(
      { execute },
      { externalShipmentRef: "echelon-wms-shp-4813" },
    )).rejects.toThrow("externalShipmentRef");
    await expect(resolveRecoveredShipNotifyNoMatchExceptions(
      { execute },
      { limit: 0 },
    )).rejects.toThrow("limit");

    expect(execute).not.toHaveBeenCalled();
  });
});
