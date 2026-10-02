import { describe, expect, it, vi } from "vitest";

import type { InventoryAvailabilityRuntimeClaimContext } from "../../../inventory-planning/application/inventory-availability-runtime-claim.service";
import { PickingUseCases } from "../../picking.use-cases";

// #63712 / #63696 (2026-10-02): the order's case was reserved in a reserve bin
// (K-09, G-04-B) while the correction card pointed at the pick face (RACK-14,
// H-01), which holds no recorded stock. A missed-pick Yes failed with
// CLAIM_RESOURCE_CONFLICT forever because it was barred from the observation
// reconciliation that a live scan uses for exactly this mismatch.

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

const beforeItem = {
  id: 700, orderId: 63712, sku: "GLV-MAG-130PT-C5000", name: "Magnetic case", quantity: 1, pickedQuantity: 0,
  fulfilledQuantity: 1, requiresShipping: 1, location: "RACK-14", status: "pending", shortReason: null, onHold: 0,
} as any;

function harness(pickClaimLine: ReturnType<typeof vi.fn>, pickMethod: string) {
  const context: InventoryAvailabilityRuntimeClaimContext = {
    authority: "canonical", authorityRevision: "2", activationRunId: "8", legacy: {} as any,
    canonical: { pickClaimLine, replaceOrderClaim: vi.fn() } as any,
    getLatestClaim: vi.fn(async () => ({ claimId: "9", revision: 1, status: "active" as const, plan: {} as any })),
    getClaimLinePickMovementCursor: vi.fn(async () => "cursor"),
    getVariantMetadata: vi.fn(async () => new Map()),
    getOrderIdByShopifyOrderId: vi.fn(async () => null),
  };
  const storage = {
    getProductVariantBySku: vi.fn(async () => ({ id: 205, sku: beforeItem.sku, requiresShipping: true, trackInventory: true })),
    getInventoryLevelsByProductVariantId: vi.fn(async () => [{ warehouseLocationId: 14, variantQty: 0 }]),
    getAllWarehouseLocations: vi.fn(async () => [{ id: 14, code: "RACK-14", warehouseId: 1,
      isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" }]),
    getOrderItemById: vi.fn(async () => ({ ...beforeItem, pickedQuantity: 1, status: "completed" })),
  };
  const service = new PickingUseCases({} as any, { getLevel: vi.fn(async () => ({ variantQty: 0 })) } as any,
    {} as any, storage as any);
  return () => (service as any).applyCanonicalPickProgress(context, { itemId: 700, beforeItem, status: "completed",
    effectivePickedQuantity: 1, warehouseId: 1, warehouseLocationId: 14, userId: "picker", pickMethod,
    pickCorrectionId: 77, pickCorrectionRevision: 4 });
}

describe("missed-pick Yes when the reservation sits in another bin", () => {
  it("moves the order's own reserved unit into the directed bin and records the pick", async () => {
    const pickClaimLine = vi.fn()
      .mockRejectedValueOnce(codedError("CLAIM_PICK_LOCATION_SHORTFALL"))
      .mockRejectedValueOnce(codedError("CLAIM_RESOURCE_CONFLICT"))
      .mockResolvedValueOnce({ outcome: "picked_with_observation", warehouseLocationIds: [14], observedRelocatedQuantity: "1" });

    await expect(harness(pickClaimLine, "missed_pick_confirmation")()).resolves.toMatchObject({ item: { pickedQuantity: 1 } });

    expect(pickClaimLine.mock.calls.map(([command]) => command.locationStrategy))
      .toEqual(["strict", "reconcile_recorded_stock", "reconcile_picker_observation"]);
    const observed = pickClaimLine.mock.calls[2][0];
    expect(observed).toMatchObject({
      claimId: "9", warehouseLocationId: 14, quantity: "1",
      observation: { kind: "picker_confirmed_physical_stock", observedPhysicalQty: "1", locationCode: "RACK-14" },
      wmsProgress: expect.objectContaining({ pickCorrectionId: 77, pickCorrectionRevision: 4 }),
    });
    // The audit trail must distinguish a retrospective confirmation from a live scan.
    expect(observed.reason).toContain("Missed-pick confirmation");
  });

  it("still fails closed on errors that observation cannot repair", async () => {
    const pickClaimLine = vi.fn()
      .mockRejectedValueOnce(codedError("CLAIM_PICK_LOCATION_SHORTFALL"))
      .mockRejectedValueOnce(codedError("CLAIM_WMS_PICK_CUSTODY_MISMATCH"));

    await expect(harness(pickClaimLine, "missed_pick_confirmation")()).rejects.toMatchObject({ code: "CLAIM_WMS_PICK_CUSTODY_MISMATCH" });
    expect(pickClaimLine).toHaveBeenCalledTimes(2);
  });

  it("keeps the live-scan reason unchanged", async () => {
    const pickClaimLine = vi.fn().mockResolvedValueOnce({ outcome: "picked", warehouseLocationIds: [14] });
    await harness(pickClaimLine, "scan")();
    expect(pickClaimLine.mock.calls[0][0].reason).toBe("Picker advanced order item 700 to 1 from RACK-14");
  });
});

describe("every canonical pick command the gun sends passes the claim schema", () => {
  // The claim service validates commands against this schema before the store
  // runs. Mocked stores above never did, which hid a 123-character observation
  // key that failed every observation pick in production (limit 120).
  it.each(["scan", "missed_pick_confirmation"])("strict, recorded-stock and observation commands are valid (%s)", async (pickMethod) => {
    const { canonicalAvailabilityClaimPickCommandSchema } = await import("@shared/types/inventory-availability-claims");
    const { CANONICAL_CLAIM_IDEMPOTENCY_KEY_MAX } = await import("../../picking.use-cases");
    const sent: unknown[] = [];
    const pickClaimLine = vi.fn(async (command: unknown) => {
      sent.push(command);
      const parsed = canonicalAvailabilityClaimPickCommandSchema.safeParse(command);
      if (!parsed.success) throw codedError("INVALID_CANONICAL_CLAIM_COMMAND");
      if (sent.length === 1) throw codedError("CLAIM_PICK_LOCATION_SHORTFALL");
      if (sent.length === 2) throw codedError("CLAIM_RESOURCE_CONFLICT");
      return { outcome: "picked_with_observation", warehouseLocationIds: [14], observedRelocatedQuantity: "1" };
    });
    await expect(harness(pickClaimLine, pickMethod)()).resolves.toMatchObject({ item: { pickedQuantity: 1 } });
    expect(sent).toHaveLength(3);
    for (const command of sent as Array<{ idempotencyKey: string }>) {
      expect(canonicalAvailabilityClaimPickCommandSchema.safeParse(command).success).toBe(true);
      expect(command.idempotencyKey.length).toBeLessThanOrEqual(CANONICAL_CLAIM_IDEMPOTENCY_KEY_MAX);
    }
  });
});
