import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { InventoryPublicationTargetVariantHoldResult } from "@shared/types/inventory-channel-exposure";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  InventoryPublicationTargetVariantHoldService,
  type InventoryPublicationTargetVariantHoldCommand,
} from "../../application/inventory-publication-target-variant-hold.service";

const NOW = new Date("2026-09-17T12:00:00.000Z");
const REQUEST = {
  destination: { destinationKind: "dropship_store_connection" as const, connectionId: 77 },
  productVariantIds: [102, 105],
  reason: "Dropship vendor 10: case tier below minimum",
  idempotencyKey: "dropship-listing-tiers:10:3:case:hold:77:abcd1234",
};

function result(command: "hold" | "release"): InventoryPublicationTargetVariantHoldResult {
  return {
    destination: REQUEST.destination,
    command,
    productVariantIds: REQUEST.productVariantIds,
    targets: [{ publicationTargetId: 5, revision: "4", changedProductVariantIds: [102, 105], publicationRows: 2, blockedProductIds: [] }],
    alreadyApplied: false,
    runtimeAuthorityChanged: false,
    providerWriteAttempted: false,
    outboxEnqueued: true,
  };
}

describe("InventoryPublicationTargetVariantHoldService", () => {
  it("normalizes the request, binds the actor and hashes the command kind and SKU list into the receipt", async () => {
    const apply = vi.fn(async (command: InventoryPublicationTargetVariantHoldCommand) => result(command.command));
    const service = new InventoryPublicationTargetVariantHoldService({ apply }, { now: () => NOW });

    await expect(service.holdVariants({
      ...REQUEST,
      reason: ` ${REQUEST.reason} `,
      idempotencyKey: ` ${REQUEST.idempotencyKey} `,
    }, " dropship-listing-tiers ")).resolves.toMatchObject({ command: "hold", outboxEnqueued: true });

    expect(apply).toHaveBeenCalledWith({
      ...REQUEST,
      command: "hold",
      actorId: "dropship-listing-tiers",
      occurredAt: NOW,
      requestHash: createHash("sha256").update(canonicalJson({
        commandType: "inventory_publication_target_variant_hold",
        actorId: "dropship-listing-tiers",
        request: REQUEST,
      }), "utf8").digest("hex"),
    });
  });

  it("hashes a release, and a different SKU set, differently from the hold with the same key", async () => {
    const apply = vi.fn(async (command: InventoryPublicationTargetVariantHoldCommand) => result(command.command));
    const service = new InventoryPublicationTargetVariantHoldService({ apply }, { now: () => NOW });

    await service.holdVariants(REQUEST, "operator-7");
    await service.releaseVariants(REQUEST, "operator-7");
    await service.holdVariants({ ...REQUEST, productVariantIds: [102] }, "operator-7");

    const hashes = apply.mock.calls.map((call) => call[0].requestHash);
    expect(new Set(hashes).size).toBe(3);
    expect(apply.mock.calls.map((call) => call[0].command)).toEqual(["hold", "release", "hold"]);
  });

  it("refuses an empty, oversized or duplicated SKU list and a blank actor before touching the store", async () => {
    const apply = vi.fn();
    const service = new InventoryPublicationTargetVariantHoldService({ apply }, { now: () => NOW });

    await expect(service.holdVariants({ ...REQUEST, productVariantIds: [] }, "operator-7"))
      .rejects.toMatchObject({ status: 400, code: "INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_INVALID_REQUEST" });
    await expect(service.holdVariants({ ...REQUEST, productVariantIds: [102, 102] }, "operator-7"))
      .rejects.toMatchObject({ status: 400, code: "INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_INVALID_REQUEST" });
    await expect(service.holdVariants({
      ...REQUEST,
      productVariantIds: Array.from({ length: 501 }, (_, index) => index + 1),
    }, "operator-7")).rejects.toMatchObject({ status: 400 });
    await expect(service.holdVariants({ ...REQUEST, extra: true }, "operator-7")).rejects.toMatchObject({ status: 400 });
    await expect(service.holdVariants(REQUEST, "  ")).rejects.toMatchObject({
      status: 401,
      code: "INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_ACTOR_REQUIRED",
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("validates what the store returns so a malformed receipt never reaches a caller", async () => {
    const apply = vi.fn(async () => ({ ...result("hold"), targets: [{ publicationTargetId: 5 }] }));
    const service = new InventoryPublicationTargetVariantHoldService({ apply } as never, { now: () => NOW });

    await expect(service.holdVariants(REQUEST, "operator-7")).rejects.toThrow();
  });
});
