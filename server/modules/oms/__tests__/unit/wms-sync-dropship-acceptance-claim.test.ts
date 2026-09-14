import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ReservationResult } from "../../../channels/reservation.service";
import {
  WmsRequiredInventoryClaimError,
  WmsSyncService,
} from "../../wms-sync.service";

interface RequiredReservationHarness {
  reserveRequired(wmsOrderId: number, omsOrderId: number, context: string): Promise<void>;
}

describe("WmsSyncService required dropship acceptance claim", () => {
  it("accepts canonical buildable supply represented by a complete build promise", async () => {
    const reservation = reservationPort({
      orderId: 9901,
      reserved: 0,
      promised: 1,
      failed: [],
      totalBaseUnits: 0,
      totalPromisedBaseUnits: 25,
    });
    const service = requiredReservationHarness(reservation);

    await expect(service.reserveRequired(9901, 9001, "test_buildable"))
      .resolves.toBeUndefined();

    expect(reservation.reserveOrder).toHaveBeenCalledWith(9901, "dropship_acceptance");
    expect(reservation.releaseOrderReservation).not.toHaveBeenCalled();
  });

  it("fails closed and releases every partial claim when canonical safety leaves a shortfall", async () => {
    const reservation = reservationPort({
      orderId: 9901,
      canonicalClaimId: "70",
      reserved: 1,
      promised: 0,
      failed: [{ sku: "C25", orderItemId: 77, reason: "canonical ATP after safety is 0" }],
      totalBaseUnits: 25,
      totalPromisedBaseUnits: 0,
    });
    const service = requiredReservationHarness(reservation);

    await expect(service.reserveRequired(9901, 9001, "test_safety_shortfall"))
      .rejects.toMatchObject({
        code: "WMS_REQUIRED_INVENTORY_CLAIM_FAILED",
        context: {
          wmsOrderId: 9901,
          omsOrderId: 9001,
          failed: [{ sku: "C25", orderItemId: 77, reason: "canonical ATP after safety is 0" }],
        },
      });

    expect(reservation.releaseOrderReservation).toHaveBeenCalledWith(
      9901,
      "Required dropship acceptance inventory claim failed (test_safety_shortfall)",
      "dropship_acceptance",
      { expectedCanonicalClaimId: "70" },
    );
  });

  it("compensates and preserves the canonical claim error when claim execution throws", async () => {
    const claimError = Object.assign(new Error("canonical claim transaction failed"), {
      code: "CANONICAL_CLAIM_FAILED",
    });
    const reservation = reservationPort(claimError);
    const service = requiredReservationHarness(reservation);

    await expect(service.reserveRequired(9901, 9001, "test_claim_error"))
      .rejects.toBe(claimError);
    expect(reservation.releaseOrderReservation).toHaveBeenCalledTimes(1);
  });

  it("surfaces both failures when claim compensation is incomplete", async () => {
    const reservation = reservationPort({
      orderId: 9901,
      reserved: 0,
      promised: 0,
      failed: [{ sku: "P5", orderItemId: 88, reason: "no canonical supply" }],
      totalBaseUnits: 0,
      totalPromisedBaseUnits: 0,
    }, {
      released: 0,
      failed: [{ sku: "P5", orderItemId: 88, reason: "claim release failed" }],
    });
    const service = requiredReservationHarness(reservation);

    const error = await service.reserveRequired(9901, 9001, "test_compensation")
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBeInstanceOf(WmsRequiredInventoryClaimError);
    expect((error as AggregateError).errors[1]).toBeInstanceOf(WmsRequiredInventoryClaimError);
  });

  it("releases only the exact canonical claim captured by the acceptance attempt", async () => {
    const reservation = reservationPort({
      orderId: 9901,
      canonicalClaimId: "70",
      reserved: 1,
      promised: 0,
      failed: [],
      totalBaseUnits: 25,
      totalPromisedBaseUnits: 0,
    });
    const service = new WmsSyncService({ reservation } as any);

    await service.releaseStagedInventoryClaim({
      wmsOrderId: 9901,
      inventoryClaimId: "70",
      reason: "payment hold",
    });

    expect(reservation.releaseOrderReservation).toHaveBeenCalledWith(
      9901,
      "payment hold",
      "dropship_acceptance",
      { expectedCanonicalClaimId: "70" },
    );
  });

  it("carries the exact digital no-claim identity into compensation", async () => {
    const reservation = reservationPort({
      orderId: 9901,
      canonicalClaimId: null,
      reserved: 0,
      promised: 0,
      failed: [],
      totalBaseUnits: 0,
      totalPromisedBaseUnits: 0,
    });
    const service = new WmsSyncService({ reservation } as any);

    await service.releaseStagedInventoryClaim({
      wmsOrderId: 9901,
      inventoryClaimId: null,
      reason: "payment hold",
    });

    expect(reservation.releaseOrderReservation).toHaveBeenCalledWith(
      9901,
      "payment hold",
      "dropship_acceptance",
      { expectedCanonicalClaimId: null },
    );
  });

  it("keeps staged replay fail-closed for every operational WMS status", () => {
    const source = WmsSyncService.prototype.stageOmsOrderAndClaimInventory.toString();
    const implementation = readWmsSyncSource();

    expect(source).toContain("dropship_acceptance_claim");
    expect(source).toContain("expectedWarehouseId");
    expect(implementation).toContain("pinnedDropshipWarehouseId");
    expect(implementation).toMatch(
      /if \(isDropshipAcceptanceClaim\)[\s\S]*pinnedWarehouses = await db[\s\S]*\.from\(warehouses\)[\s\S]*else \{[\s\S]*fulfillmentRouter\.routeOrder/,
    );
    expect(implementation).toContain("assertPinnedDropshipWarehouse");
    expect(implementation).toContain("assertDropshipAcceptanceReplayIsNonOperational");
    expect(implementation).toMatch(/warehouseStatus === "completed"[\s\S]*requiresShipping/);
    expect(implementation).toMatch(/warehouseStatus === "awaiting_3pl"[\s\S]*warehouseType === "3pl"/);
    expect(implementation).toContain("already operationally visible");
    expect(implementation).toContain("getOrderReservationStatus(wmsOrderId)");
    expect(implementation).toContain("reservationStatus.claim?.claimId ?? null");
  });
});

function requiredReservationHarness(reservation: ReturnType<typeof reservationPort>): RequiredReservationHarness {
  return new WmsSyncService({ reservation } as any) as unknown as RequiredReservationHarness;
}

function reservationPort(
  claim: ReservationResult | Error,
  release = { released: 1, failed: [] as Array<{ sku: string; orderItemId: number; reason: string }> },
) {
  return {
    reserveOrder: vi.fn(async () => {
      if (claim instanceof Error) throw claim;
      return claim;
    }),
    releaseOrderReservation: vi.fn(async () => release),
  };
}

function readWmsSyncSource(): string {
  return readFileSync(resolve(__dirname, "../../wms-sync.service.ts"), "utf8");
}
