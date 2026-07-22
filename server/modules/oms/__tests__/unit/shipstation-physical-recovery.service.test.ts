import { describe, expect, it, vi } from "vitest";
import {
  createShipStationPhysicalRecoveryService,
  findShipStationPhysicalRecoveryCandidates,
} from "../../shipstation-physical-recovery.service";
import type { ShipStationCompletedPhysicalPackage } from "../../../shipping/shipstation-physical-recovery.client";

function queryText(query: any): string {
  return (query?.queryChunks ?? [])
    .flatMap((chunk: any) => chunk?.value ?? [])
    .join(" ");
}

function candidateRow() {
  return {
    wms_order_id: 204657,
    oms_order_id: 232103,
    order_number: "#59564",
    provider: "shopify",
    wms_shipment_ids: [4842],
    wms_shipment_item_ids: [9638],
    oldest_shipment_created_at: "2026-06-28T18:08:50.782Z",
  };
}

function combinedPackage(
  wmsShipmentItemIds: number[] = [9636, 9638],
): ShipStationCompletedPhysicalPackage {
  return {
    providerShipmentId: "se-755791888",
    providerLabelId: "se-442730042",
    legacyShipStationShipmentId: 442730042,
    trackingNumber: "9400150206217759204396",
    shipDate: "2026-07-01",
    carrierCode: "stamps_com",
    serviceCode: "usps_ground_advantage",
    wmsShipmentItemIds,
  };
}

describe("shipstation physical recovery service", () => {
  it("selects only old, fully picked customer-fulfillment shipments", async () => {
    const execute = vi.fn(async () => ({ rows: [candidateRow()] }));

    const candidates = await findShipStationPhysicalRecoveryCandidates(
      { execute },
      { orderNumber: "#59564", minAgeHours: 6, maxAgeDays: null, limit: null },
    );

    expect(candidates).toEqual([expect.objectContaining({
      wmsOrderId: 204657,
      omsOrderId: 232103,
      orderNumber: "#59564",
      wmsShipmentIds: [4842],
      wmsShipmentItemIds: [9638],
    })]);
    const sql = queryText(execute.mock.calls[0]?.[0]);
    expect(sql).toContain("wo.source IN ('oms', 'ebay')");
    expect(sql).toContain("WITH eligible_shipments AS");
    expect(sql).toContain("os.status IN ('planned', 'queued', 'labeled')");
    expect(sql).toContain("os.shipped_at IS NULL");
    expect(sql).toContain("COALESCE(oi.picked_quantity, 0) >= COALESCE(osi.qty, 0)");
    expect(sql).toContain("oi.status = 'completed'");
    expect(sql.indexOf("HAVING BOOL_AND")).toBeLessThan(
      sql.indexOf("ARRAY_AGG(DISTINCT eligible.id"),
    );
  });

  it("rejects invalid scan bounds instead of silently changing them", async () => {
    const execute = vi.fn();

    await expect(findShipStationPhysicalRecoveryCandidates(
      { execute },
      { limit: 501 },
    )).rejects.toThrow(/limit must be an integer from 1 through 500/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("enqueues the canonical SHIP_NOTIFY path for a combined package containing this order's item", async () => {
    const db = { execute: vi.fn(async () => ({ rows: [candidateRow()] })) };
    const enqueueRetry = vi.fn(async () => undefined);
    const client = {
      isConfigured: () => true,
      listCompletedPackagesForOrder: vi.fn(async () => [combinedPackage()]),
    };
    const service = createShipStationPhysicalRecoveryService(db, { client, enqueueRetry });

    const result = await service.recover({ mode: "execute", orderNumber: "#59564" });

    expect(client.listCompletedPackagesForOrder).toHaveBeenCalledWith("#59564");
    expect(enqueueRetry).toHaveBeenCalledWith(db, {
      resource_url: "https://ssapi.shipstation.com/shipments?shipmentId=442730042&includeShipmentItems=false",
    });
    expect(result).toMatchObject({
      candidates: 1,
      matchedPackages: 1,
      enqueueRequests: 1,
      noMatch: 0,
      errors: 0,
      results: [{ outcome: "enqueued" }],
    });
  });

  it("does not authorize a sibling package that lacks this order's exact item identity", async () => {
    const db = { execute: vi.fn(async () => ({ rows: [candidateRow()] })) };
    const enqueueRetry = vi.fn(async () => undefined);
    const service = createShipStationPhysicalRecoveryService(db, {
      client: {
        isConfigured: () => true,
        listCompletedPackagesForOrder: vi.fn(async () => [combinedPackage([9636])]),
      },
      enqueueRetry,
    });

    const result = await service.recover({ mode: "execute", orderNumber: "#59564" });

    expect(result).toMatchObject({ matchedPackages: 0, enqueueRequests: 0, noMatch: 1 });
    expect(enqueueRetry).not.toHaveBeenCalled();
  });

  it("reports the same repair in dry-run mode without enqueueing it", async () => {
    const db = { execute: vi.fn(async () => ({ rows: [candidateRow()] })) };
    const enqueueRetry = vi.fn(async () => undefined);
    const service = createShipStationPhysicalRecoveryService(db, {
      client: {
        isConfigured: () => true,
        listCompletedPackagesForOrder: vi.fn(async () => [combinedPackage()]),
      },
      enqueueRetry,
    });

    const result = await service.recover({ mode: "dry-run", orderNumber: "#59564" });

    expect(result.results[0]?.outcome).toBe("planned");
    expect(result.enqueueRequests).toBe(0);
    expect(enqueueRetry).not.toHaveBeenCalled();
  });
});
