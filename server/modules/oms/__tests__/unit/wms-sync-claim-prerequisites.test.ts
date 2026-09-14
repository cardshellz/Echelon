import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  admitInitialProviderShipmentAfterInventoryAuthority,
  requireRoutedWarehouseId,
  WmsShipmentPrerequisiteError,
  WmsSyncService,
} from "../../wms-sync.service";

interface ReservationPrerequisiteHarness {
  reserveBeforeShipmentProcessing(
    wmsOrderId: number,
    omsOrderId: number | null,
    context: string,
  ): Promise<void>;
}

const WMS_SYNC_SOURCE = readFileSync(
  resolve(__dirname, "../../wms-sync.service.ts"),
  "utf8",
);

describe("WMS shipment inventory prerequisites", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects a shippable order when routing returns no explicit warehouse", () => {
    expect(() => requireRoutedWarehouseId({
      omsOrderId: 9001,
      hasShippableItems: true,
      routedWarehouseId: null,
    })).toThrow(WmsShipmentPrerequisiteError);

    try {
      requireRoutedWarehouseId({
        omsOrderId: 9001,
        hasShippableItems: true,
        routedWarehouseId: null,
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "WMS_SHIPMENT_PREREQUISITE_FAILED",
        context: { omsOrderId: 9001, routedWarehouseId: null },
      });
    }
  });

  it("keeps digital routing optional and accepts a positive physical warehouse", () => {
    expect(requireRoutedWarehouseId({
      omsOrderId: 9002,
      hasShippableItems: false,
      routedWarehouseId: null,
    })).toBeNull();
    expect(requireRoutedWarehouseId({
      omsOrderId: 9003,
      hasShippableItems: true,
      routedWarehouseId: 7,
    })).toBe(7);
  });

  it("allows an untracked physical line when authority returns an explicit no-claim success", async () => {
    const reserveOrder = vi.fn(async () => ({
      orderId: 9901,
      canonicalClaimId: null,
      reserved: 0,
      promised: 0,
      failed: [],
      totalBaseUnits: 0,
      totalPromisedBaseUnits: 0,
    }));
    const service = reservationHarness(reserveOrder);

    await expect(service.reserveBeforeShipmentProcessing(9901, null, "untracked_physical"))
      .resolves.toBeUndefined();
    expect(reserveOrder).toHaveBeenCalledWith(9901);
  });

  it("keeps an explicit business shortfall eligible for discrepancy picking", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reserveOrder = vi.fn(async () => ({
      orderId: 9902,
      canonicalClaimId: "71",
      reserved: 1,
      promised: 0,
      failed: [{ sku: "C25", orderItemId: 44, reason: "canonical ATP after safety is 0" }],
      totalBaseUnits: 25,
      totalPromisedBaseUnits: 0,
    }));
    const service = reservationHarness(reserveOrder);

    await expect(service.reserveBeforeShipmentProcessing(9902, null, "explicit_shortfall"))
      .resolves.toBeUndefined();
  });

  it("fails the sync when reservation authority throws instead of treating it as a shortfall", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cause = Object.assign(new Error("runtime authority unavailable"), {
      code: "INVENTORY_RUNTIME_AUTHORITY_UNAVAILABLE",
    });
    const service = reservationHarness(vi.fn(async () => { throw cause; }));

    await expect(service.reserveBeforeShipmentProcessing(9903, 9003, "post_create"))
      .rejects.toMatchObject({
        code: "WMS_SHIPMENT_PREREQUISITE_FAILED",
        context: {
          wmsOrderId: 9903,
          omsOrderId: 9003,
          context: "post_create",
          causeCode: "INVENTORY_RUNTIME_AUTHORITY_UNAVAILABLE",
        },
        cause,
      });
  });

  it("persists provider work only after inventory authority resolves", async () => {
    const order: string[] = [];
    const result = await admitInitialProviderShipmentAfterInventoryAuthority(
      {
        hasShippableItems: true,
        isDropshipAcceptanceClaim: false,
        warehouseStatus: "ready",
      },
      {
        assertInventoryAuthority: vi.fn(async () => { order.push("authority"); }),
        persistProviderShipment: vi.fn(async () => {
          order.push("provider");
          return 701;
        }),
      },
    );

    expect(result).toBe(701);
    expect(order).toEqual(["authority", "provider"]);
  });

  it("admits no provider work when inventory authority throws", async () => {
    const persistProviderShipment = vi.fn(async () => 702);
    await expect(admitInitialProviderShipmentAfterInventoryAuthority(
      {
        hasShippableItems: true,
        isDropshipAcceptanceClaim: false,
        warehouseStatus: "ready",
      },
      {
        assertInventoryAuthority: vi.fn(async () => {
          throw new Error("authority unavailable");
        }),
        persistProviderShipment,
      },
    )).rejects.toThrow("authority unavailable");

    expect(persistProviderShipment).not.toHaveBeenCalled();
  });

  it.each([
    { hasShippableItems: false, warehouseStatus: "completed" },
    { hasShippableItems: true, warehouseStatus: "pending" },
    { hasShippableItems: true, warehouseStatus: "awaiting_3pl" },
  ])("skips local authority and provider work for $warehouseStatus", async (input) => {
    const assertInventoryAuthority = vi.fn(async () => undefined);
    const persistProviderShipment = vi.fn(async () => 703);

    await expect(admitInitialProviderShipmentAfterInventoryAuthority(
      {
        ...input,
        isDropshipAcceptanceClaim: false,
      },
      { assertInventoryAuthority, persistProviderShipment },
    )).resolves.toBeNull();
    expect(assertInventoryAuthority).not.toHaveBeenCalled();
    expect(persistProviderShipment).not.toHaveBeenCalled();
  });

  it("checks routing before WMS persistence and existing-order claims before shipment mutation", () => {
    const routeGuard = WMS_SYNC_SOURCE.indexOf("const routedWarehouseId = requireRoutedWarehouseId({");
    const wmsOrderData = WMS_SYNC_SOURCE.indexOf("const wmsOrderData: InsertWmsOrder = {");
    expect(routeGuard).toBeGreaterThan(0);
    expect(routeGuard).toBeLessThan(wmsOrderData);

    const reconciliationStart = WMS_SYNC_SOURCE.indexOf("private async reconcileExistingWmsOrderLines(");
    const reconciliationEnd = WMS_SYNC_SOURCE.indexOf("async propagateOmsEditsToWms(", reconciliationStart);
    const reconciliation = WMS_SYNC_SOURCE.slice(reconciliationStart, reconciliationEnd);
    const reservationGuard = reconciliation.indexOf("await this.reserveBeforeShipmentProcessing(");
    const shipmentMutation = reconciliation.indexOf("const activeShipments = await db");
    expect(reservationGuard).toBeGreaterThan(0);
    expect(reservationGuard).toBeLessThan(shipmentMutation);

    const createTxStart = WMS_SYNC_SOURCE.indexOf("const txResult = await db.transaction");
    const createTxEnd = WMS_SYNC_SOURCE.indexOf("// Concurrency guard tripped", createTxStart);
    const createTx = WMS_SYNC_SOURCE.slice(createTxStart, createTxEnd);
    expect(createTx).not.toContain("createShipmentForOrder(");
    expect(createTx).not.toContain("enqueueShipStationShipmentPushRetry(");

    const admissionCall = WMS_SYNC_SOURCE.indexOf(
      "admitInitialProviderShipmentAfterInventoryAuthority(",
      createTxEnd,
    );
    const authorityCallback = WMS_SYNC_SOURCE.indexOf(
      "assertInventoryAuthority:",
      admissionCall,
    );
    const providerCallback = WMS_SYNC_SOURCE.indexOf(
      "persistProviderShipment:",
      admissionCall,
    );
    expect(admissionCall).toBeGreaterThan(createTxEnd);
    expect(authorityCallback).toBeGreaterThan(admissionCall);
    expect(providerCallback).toBeGreaterThan(authorityCallback);
  });
});

function reservationHarness(
  reserveOrder: (...args: any[]) => Promise<any>,
): ReservationPrerequisiteHarness {
  return new WmsSyncService({ reservation: { reserveOrder } } as any) as unknown as ReservationPrerequisiteHarness;
}
