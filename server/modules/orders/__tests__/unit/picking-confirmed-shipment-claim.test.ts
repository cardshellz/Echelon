import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { canonicalAvailabilityClaimCommandSchema } from "@shared/types/inventory-availability-claims";
import type { InventoryAvailabilityRuntimeClaimContext } from "../../../inventory-planning/application/inventory-availability-runtime-claim.service";
import { PickingUseCases, shortClaimMessage } from "../../picking.use-cases";

// 2026-10-02: 12 of 19 stuck corrections belonged to orders already marked
// shipped. Shipped orders could not be claimed or re-planned, and a post-ship
// release left #63570 with no claim at all, so a picker's "Yes, it shipped"
// could never be recorded.

const beforeItem = {
  id: 900, orderId: 63570, sku: "ESS-TOP-STD-SLV-CLR-C1000", name: "Case", quantity: 1, pickedQuantity: 0,
  fulfilledQuantity: 1, requiresShipping: 1, location: "F-03", status: "pending", shortReason: null, onHold: 0,
} as any;

function harness(options: { latest: Array<{ claimId: string; status: "active" | "released" } | null>; claimOrder: ReturnType<typeof vi.fn> }) {
  const latest = [...options.latest];
  const pickClaimLine = vi.fn(async () => ({ outcome: "picked", warehouseLocationIds: [3] }));
  const context: InventoryAvailabilityRuntimeClaimContext = {
    authority: "canonical", authorityRevision: "2", activationRunId: "8", legacy: {} as any,
    canonical: { pickClaimLine, claimOrder: options.claimOrder, replaceOrderClaim: vi.fn() } as any,
    getLatestClaim: vi.fn(async () => {
      const next = latest.length > 1 ? latest.shift()! : latest[0];
      return next && { ...next, revision: 1, plan: {} as any };
    }),
    getClaimLinePickMovementCursor: vi.fn(async () => "cursor"),
    getVariantMetadata: vi.fn(async () => new Map()),
    getOrderIdByShopifyOrderId: vi.fn(async () => null),
  };
  const storage = {
    getProductVariantBySku: vi.fn(async () => ({ id: 12, sku: beforeItem.sku, requiresShipping: true, trackInventory: true })),
    getInventoryLevelsByProductVariantId: vi.fn(async () => [{ warehouseLocationId: 3, variantQty: 2 }]),
    getAllWarehouseLocations: vi.fn(async () => [{ id: 3, code: "F-03", warehouseId: 1,
      isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" }]),
    getOrderItemById: vi.fn(async () => ({ ...beforeItem, pickedQuantity: 1, status: "completed" })),
  };
  const service = new PickingUseCases({} as any, { getLevel: vi.fn(async () => ({ variantQty: 1 })) } as any,
    {} as any, storage as any);
  const pick = (pickMethod: string) => (service as any).applyCanonicalPickProgress(context, { itemId: 900, beforeItem,
    status: "completed", effectivePickedQuantity: 1, warehouseId: 1, warehouseLocationId: 3, userId: "picker", pickMethod,
    pickCorrectionId: 5, pickCorrectionRevision: 2 });
  return { pick, pickClaimLine };
}

describe("recording a confirmed shipment whose order has no active claim", () => {
  it("claims the shipped order's unrecorded units, keyed by its released claim, then records the pick", async () => {
    const claimOrder = vi.fn(async () => ({ outcome: "claimed", claimId: "41" }));
    const { pick, pickClaimLine } = harness({ latest: [{ claimId: "40", status: "released" }, { claimId: "41", status: "active" }], claimOrder });

    await expect(pick("missed_pick_confirmation")).resolves.toMatchObject({ item: { pickedQuantity: 1 } });

    expect(claimOrder).toHaveBeenCalledOnce();
    const command = (claimOrder.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(command).toMatchObject({ orderId: 63570, recordConfirmedShipment: true, actor: "picker" });
    expect(canonicalAvailabilityClaimCommandSchema.safeParse(command).success).toBe(true);
    expect(pickClaimLine).toHaveBeenCalledWith(expect.objectContaining({ claimId: "41" }));
  });

  it("still reports the missing claim when there is nothing to claim", async () => {
    const claimOrder = vi.fn(async () => ({ outcome: "no_claim_required" }));
    const { pick, pickClaimLine } = harness({ latest: [null], claimOrder });
    await expect(pick("missed_pick_confirmation")).rejects.toMatchObject({ context: { reason: "active_canonical_claim_missing" } });
    expect(pickClaimLine).not.toHaveBeenCalled();
  });

  it("never claims for an ordinary pick", async () => {
    const claimOrder = vi.fn();
    const { pick } = harness({ latest: [{ claimId: "40", status: "released" }], claimOrder });
    await expect(pick("scan")).rejects.toMatchObject({ context: { reason: "active_canonical_claim_missing" } });
    expect(claimOrder).not.toHaveBeenCalled();
  });
});

describe("shortClaimMessage", () => {
  it("asks for a count or receipt only when stock is genuinely missing", () => {
    expect(shortClaimMessage("CLAIM_SUPPLY_REFRESH_NO_IMPROVEMENT", "SKU-1", "C-11")).toContain("Count or receive C-11");
    for (const code of ["CLAIM_SUPPLY_REFRESH_PICK_IN_PROGRESS", "CLAIM_SUPPLY_REFRESH_LINE_REGRESSION",
      "CLAIM_SUPPLY_REFRESH_DEMAND_CHANGED", "REPLACEMENT_ORDER_NOT_CLAIMABLE"]) {
      expect(shortClaimMessage(code, "SKU-1", "C-11")).not.toContain("Count or receive");
    }
  });
});

describe("shipped-order claim contract", () => {
  const repository = readFileSync(resolve(process.cwd(),
    "server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts"), "utf8");

  it("limits a shipped order's demand to units that shipped without a pick record", () => {
    expect(repository).toMatch(/WHEN \$2::boolean THEN GREATEST\(\s*LEAST\(COALESCE\(item\.quantity, 0\), COALESCE\(item\.fulfilled_quantity, 0\)\)\s*- COALESCE\(item\.picked_quantity, 0\), 0\)/);
    expect(repository).toMatch(/\[orderId, orderRow\.warehouse_status === "shipped"\]/);
  });

  it("claims or refreshes a shipped order only to record a confirmed shipment", () => {
    expect(repository).toMatch(/orderClaimable\(preliminaryOrder, command\.recordConfirmedShipment === true\)/);
    expect(repository).toMatch(/orderClaimable\(lockedOrder, command\.recordConfirmedShipment === true\)/);
    expect(repository).toMatch(/orderClaimable\(preliminaryOrder, command\.refreshSupply === true\)/);
    expect(repository).toMatch(/orderClaimable\(lockedOrder, command\.refreshSupply === true\)/);
    expect(repository).toMatch(/return order\.warehouseStatus !== "shipped" \|\| recordingConfirmedShipment;/);
  });

  it("accepts only an explicit confirmed-shipment flag on claim commands", () => {
    const base = { orderId: 1, idempotencyKey: "k", actor: "a", reason: "r" };
    expect(canonicalAvailabilityClaimCommandSchema.safeParse({ ...base, recordConfirmedShipment: true }).success).toBe(true);
    expect(canonicalAvailabilityClaimCommandSchema.safeParse({ ...base, recordConfirmedShipment: false }).success).toBe(false);
    expect(canonicalAvailabilityClaimCommandSchema.safeParse(base).success).toBe(true);
  });
});
