import { describe, expect, it, vi } from "vitest";
import {
  buildShipStationRecoveredLabelObservation,
  createShipStationPhysicalRecoveryService,
  findShipStationPhysicalRecoveryCandidates,
} from "../../shipstation-physical-recovery.service";
import type { ShipStationCompletedPhysicalPackage } from "../../../shipping/shipstation-physical-recovery.client";

function queryText(query: any): string {
  return (query?.queryChunks ?? [])
    .flatMap((chunk: any) => chunk?.value ?? [])
    .join(" ");
}

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    wms_order_id: 204657,
    oms_order_id: 232103,
    order_number: "#59564",
    provider: "shopify",
    wms_shipment_ids: [4842],
    wms_shipment_item_ids: [9638],
    wms_shipment_items: [{
      sourceShipmentItemId: 9638,
      quantity: 1,
    }],
    oldest_shipment_created_at: "2026-06-28T18:08:50.782Z",
    ...overrides,
  };
}

function combinedPackage(
  wmsShipmentItemIds: number[] = [9638],
): ShipStationCompletedPhysicalPackage {
  return {
    providerShipmentId: "se-755791888",
    providerLabelId: "se-442730042",
    legacyShipStationShipmentId: 442730042,
    trackingNumber: "9400150206217759204396",
    shipDate: "2026-07-01",
    carrierCode: "stamps_com",
    serviceCode: "usps_ground_advantage",
    isReturnLabel: false,
    wmsShipmentItems: wmsShipmentItemIds.map((sourceShipmentItemId) =>
      ({ sourceShipmentItemId, quantity: 1 })),
  };
}

function carrierTracking(overrides: Record<string, unknown> = {}) {
  return {
    observeShipStationLabel: vi.fn(async () => ({
      shippingProviderLabelId: 10,
      labelInserted: true,
      eventInserted: true,
    })),
    reconcileShipStationLabel: vi.fn(async () => ({
      shippingProviderLabelId: 10,
      linksInserted: 2,
      totalLinks: 2,
    })),
    hydrateShipStationTrackingIdentity: vi.fn(async () => ({
      dispatchCommandInserted: true,
    })),
    ...overrides,
  };
}

describe("shipstation physical recovery service", () => {
  it("selects old completed pick lines until active label carrier evidence matches them", async () => {
    const execute = vi.fn(async () => ({ rows: [candidateRow()] }));

    const candidates = await findShipStationPhysicalRecoveryCandidates(
      { execute },
      { orderNumber: "#59564", minAgeMinutes: 15, maxAgeDays: null, limit: null },
    );

    expect(candidates).toEqual([expect.objectContaining({
      wmsOrderId: 204657,
      omsOrderId: 232103,
      orderNumber: "#59564",
      wmsShipmentIds: [4842],
      wmsShipmentItemIds: [9638],
    })]);
    const query = queryText(execute.mock.calls[0]?.[0]);
    expect(query).toContain("WITH covered_provider_item_ids AS");
    expect(query).toContain("label.label_status = 'active'");
    expect(query).toContain("event_match.match_status = 'matched'");
    expect(query).toContain("FROM '^wms-item-([1-9][0-9]{0,9})$'");
    expect(query).toContain("::bigint <= 2147483647");
    expect(query).toContain(
      "THEN bounded_key.wms_shipment_item_id_text::integer",
    );
    expect(query).toContain("provider_identity.shipment_item_id IS NOT NULL");
    expect(query).not.toMatch(
      /FROM '\^wms-item-\(\[1-9\]\[0-9\]\*\)\$'\s*\)::integer/,
    );
    expect(query).toContain("COALESCE(oi.picked_quantity, 0) >= COALESCE(osi.qty, 0)");
    expect(query).toContain("oi.status = 'completed'");
    expect(query).toContain("wo.warehouse_status <> 'cancelled'");
    expect(query).not.toContain("os.status IN ('planned', 'queued', 'labeled')");
    expect(query).not.toContain("os.shipped_at IS NULL");
  });

  it("rejects invalid or conflicting scan bounds instead of changing them", async () => {
    const execute = vi.fn();

    await expect(findShipStationPhysicalRecoveryCandidates(
      { execute },
      { limit: 501 },
    )).rejects.toThrow(/limit must be an integer from 1 through 500/);
    await expect(findShipStationPhysicalRecoveryCandidates(
      { execute },
      { minAgeHours: 6, minAgeMinutes: 15 },
    )).rejects.toThrow(/either minAgeHours or minAgeMinutes/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("builds a canonical label observation with only exact WMS item identities", () => {
    expect(buildShipStationRecoveredLabelObservation(
      combinedPackage([9636, 9638]),
    )).toEqual({
      shipmentId: 442730042,
      orderId: null,
      orderKey: null,
      trackingNumber: "9400150206217759204396",
      carrierCode: "stamps_com",
      serviceCode: "usps_ground_advantage",
      shipDate: "2026-07-01",
      voidDate: null,
      isReturnLabel: false,
      shipmentItems: [
        { lineItemKey: "wms-item-9636", quantity: 1 },
        { lineItemKey: "wms-item-9638", quantity: 1 },
      ],
    });
  });

  it("recovers a missed label through exact lineage and carrier dispatch authority", async () => {
    const db = { execute: vi.fn(async () => ({ rows: [candidateRow()] })) };
    const client = {
      isConfigured: () => true,
      listCompletedPackagesForOrder: vi.fn(async () => [combinedPackage()]),
    };
    const tracking = carrierTracking();
    const service = createShipStationPhysicalRecoveryService(db, {
      client,
      carrierTracking: tracking as any,
    });

    const result = await service.recover({ mode: "execute", orderNumber: "#59564" });

    expect(client.listCompletedPackagesForOrder).toHaveBeenCalledWith("#59564");
    expect(tracking.observeShipStationLabel).toHaveBeenCalledWith(
      buildShipStationRecoveredLabelObservation(combinedPackage()),
    );
    expect(tracking.reconcileShipStationLabel).toHaveBeenCalledWith("442730042");
    expect(tracking.hydrateShipStationTrackingIdentity).toHaveBeenCalledWith({
      carrierCode: "stamps_com",
      trackingNumber: "9400150206217759204396",
    });
    expect(result).toMatchObject({
      candidates: 1,
      matchedPackages: 1,
      labelsObserved: 1,
      labelsInserted: 1,
      labelLinksInserted: 2,
      trackingSnapshotsHydrated: 1,
      dispatchCommandsCreated: 1,
      trackingWarnings: 0,
      noMatch: 0,
      errors: 0,
      results: [{ outcome: "recovered" }],
    });
  });

  it("does not authorize a package containing an ineligible extra item", async () => {
    const db = { execute: vi.fn(async () => ({ rows: [candidateRow()] })) };
    const tracking = carrierTracking();
    const service = createShipStationPhysicalRecoveryService(db, {
      client: {
        isConfigured: () => true,
        listCompletedPackagesForOrder: vi.fn(async () => [combinedPackage([9638, 9636])]),
      },
      carrierTracking: tracking as any,
    });

    const result = await service.recover({ mode: "execute", orderNumber: "#59564" });

    expect(result).toMatchObject({
      matchedPackages: 0,
      labelsObserved: 0,
      noMatch: 1,
      errors: 0,
    });
    expect(tracking.observeShipStationLabel).not.toHaveBeenCalled();
    expect(tracking.hydrateShipStationTrackingIdentity).not.toHaveBeenCalled();
  });

  it("reports the repair in dry-run mode without writing label or tracking evidence", async () => {
    const db = { execute: vi.fn(async () => ({ rows: [candidateRow()] })) };
    const tracking = carrierTracking();
    const service = createShipStationPhysicalRecoveryService(db, {
      client: {
        isConfigured: () => true,
        listCompletedPackagesForOrder: vi.fn(async () => [combinedPackage()]),
      },
      carrierTracking: tracking as any,
    });

    const result = await service.recover({ mode: "dry-run", orderNumber: "#59564" });

    expect(result.results[0]?.outcome).toBe("planned");
    expect(result.labelsObserved).toBe(0);
    expect(tracking.observeShipStationLabel).not.toHaveBeenCalled();
    expect(tracking.reconcileShipStationLabel).not.toHaveBeenCalled();
    expect(tracking.hydrateShipStationTrackingIdentity).not.toHaveBeenCalled();
  });

  it("deduplicates one physical label spanning multiple WMS orders within a run", async () => {
    const db = {
      execute: vi.fn(async () => ({
        rows: [
          candidateRow(),
          candidateRow({
            wms_order_id: 204658,
            oms_order_id: 232104,
            order_number: "#59565",
            wms_shipment_ids: [4843],
            wms_shipment_item_ids: [9640],
            wms_shipment_items: [{
              sourceShipmentItemId: 9640,
              quantity: 1,
            }],
          }),
        ],
      })),
    };
    const physicalPackage = combinedPackage([9638, 9640]);
    const tracking = carrierTracking();
    const service = createShipStationPhysicalRecoveryService(db, {
      client: {
        isConfigured: () => true,
        listCompletedPackagesForOrder: vi.fn(async () => [physicalPackage]),
      },
      carrierTracking: tracking as any,
    });

    const result = await service.recover({ mode: "execute" });

    expect(result).toMatchObject({
      candidates: 2,
      matchedPackages: 2,
      labelsObserved: 1,
      trackingSnapshotsHydrated: 1,
      dispatchCommandsCreated: 1,
      errors: 0,
    });
    expect(tracking.observeShipStationLabel).toHaveBeenCalledOnce();
    expect(tracking.reconcileShipStationLabel).toHaveBeenCalledOnce();
    expect(tracking.hydrateShipStationTrackingIdentity).toHaveBeenCalledOnce();
  });

  it("retains recovered label evidence but exposes transient tracking hydration debt", async () => {
    const db = { execute: vi.fn(async () => ({ rows: [candidateRow()] })) };
    const tracking = carrierTracking({
      hydrateShipStationTrackingIdentity: vi.fn(async () => {
        throw new Error("provider timeout");
      }),
    });
    const service = createShipStationPhysicalRecoveryService(db, {
      client: {
        isConfigured: () => true,
        listCompletedPackagesForOrder: vi.fn(async () => [combinedPackage()]),
      },
      carrierTracking: tracking as any,
    });

    const result = await service.recover({ mode: "execute" });

    expect(result).toMatchObject({
      labelsObserved: 1,
      trackingSnapshotsHydrated: 0,
      dispatchCommandsCreated: 0,
      trackingWarnings: 1,
      errors: 0,
      results: [{
        outcome: "recovered",
        trackingWarnings: [
          expect.stringContaining("tracking hydration failed: provider timeout"),
        ],
      }],
    });
  });

  it("fails closed when exact label lineage cannot be linked", async () => {
    const db = { execute: vi.fn(async () => ({ rows: [candidateRow()] })) };
    const tracking = carrierTracking({
      reconcileShipStationLabel: vi.fn(async () => ({
        shippingProviderLabelId: 10,
        linksInserted: 0,
        totalLinks: 0,
      })),
    });
    const service = createShipStationPhysicalRecoveryService(db, {
      client: {
        isConfigured: () => true,
        listCompletedPackagesForOrder: vi.fn(async () => [combinedPackage()]),
      },
      carrierTracking: tracking as any,
    });

    const result = await service.recover({ mode: "execute" });

    expect(result).toMatchObject({
      labelsObserved: 1,
      trackingSnapshotsHydrated: 0,
      errors: 1,
      results: [{
        outcome: "error",
        error: expect.stringContaining("did not link to any authorized shipment"),
      }],
    });
    expect(tracking.hydrateShipStationTrackingIdentity).not.toHaveBeenCalled();
  });
});
