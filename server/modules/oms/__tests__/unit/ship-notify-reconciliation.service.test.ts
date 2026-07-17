import { describe, expect, it, vi } from "vitest";

import {
  resolveRecoveredShipNotifyNoMatchExceptions,
  resolveVoidedShipStationUnmappedPhysicalException,
  resolveVoidedShipStationUnmappedPhysicalExceptions,
} from "../../ship-notify-reconciliation.service";

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

  it("resolves an exact extra-package exception when ShipStation proves the label was voided", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = queryText(query);
      expect(text).toContain("UPDATE wms.reconciliation_exceptions");
      expect(text).toContain("provider_physical_shipment_voided");
      expect(text).toContain("exception.external_shipment_ref");
      expect(text).not.toContain("tracking_number");
      expect(text).not.toContain("order_number");
      return {
        rows: [{
          exception_id: 62,
          external_shipment_ref: "446343015",
        }],
      };
    });

    const result = await resolveVoidedShipStationUnmappedPhysicalException(
      { execute },
      {
        shipmentId: 446343015,
        voidDate: "2026-07-17T08:51:25.473Z",
      },
      {
        now: new Date("2026-07-17T18:00:00.000Z"),
        resolvedBy: "system:test",
      },
    );

    expect(result).toEqual({
      exceptionId: 62,
      externalShipmentRef: "446343015",
      providerVoidDate: "2026-07-17T08:51:25.473Z",
    });
  });

  it("re-checks exact provider ids and leaves active shipments open", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = queryText(query);
      if (text.includes("SELECT exception.id AS exception_id")) {
        return {
          rows: [
            { exception_id: 61, external_shipment_ref: "446343014" },
            { exception_id: 62, external_shipment_ref: "446343015" },
          ],
        };
      }
      if (text.includes("UPDATE wms.reconciliation_exceptions")) {
        return {
          rows: [{ exception_id: 62, external_shipment_ref: "446343015" }],
        };
      }
      return { rows: [] };
    });
    const getShipmentById = vi.fn(async (shipmentId: number) => ({
      shipmentId,
      voidDate: shipmentId === 446343015
        ? "2026-07-17T08:51:25.473Z"
        : null,
    }));

    const result = await resolveVoidedShipStationUnmappedPhysicalExceptions(
      { execute },
      { getShipmentById },
      { limit: 10, resolvedBy: "system:test" },
    );

    expect(getShipmentById).toHaveBeenCalledTimes(2);
    expect(result.checkedCount).toBe(2);
    expect(result.resolvedCount).toBe(1);
    expect(result.resolved[0]?.exceptionId).toBe(62);
    expect(result.failures).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("refuses invalid void evidence before updating an exception", async () => {
    const execute = vi.fn();

    await expect(resolveVoidedShipStationUnmappedPhysicalException(
      { execute },
      { shipmentId: 446343015, voidDate: "" },
    )).rejects.toThrow("voidDate");

    expect(execute).not.toHaveBeenCalled();
  });
});
