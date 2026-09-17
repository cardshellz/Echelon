import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { InventoryPublicationTargetHoldResult } from "@shared/types/inventory-channel-exposure";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  InventoryPublicationTargetHoldService,
  type InventoryPublicationTargetHoldCommand,
} from "../../application/inventory-publication-target-hold.service";

const NOW = new Date("2026-09-17T12:00:00.000Z");
const REQUEST = {
  destination: { destinationKind: "dropship_store_connection" as const, connectionId: 77 },
  reason: "Vendor 10 paused: card declined",
  idempotencyKey: "vendor-standing:10:hold:1",
};

function result(command: "hold" | "release"): InventoryPublicationTargetHoldResult {
  return {
    destination: REQUEST.destination,
    command,
    targets: [{ publicationTargetId: 5, revision: "4", changed: true, publicationRows: 2, blockedProductIds: [] }],
    alreadyApplied: false,
    runtimeAuthorityChanged: false,
    providerWriteAttempted: false,
    outboxEnqueued: true,
  };
}

describe("InventoryPublicationTargetHoldService", () => {
  it("normalizes the request, binds the actor and hashes the command kind into the receipt", async () => {
    const apply = vi.fn(async (command: InventoryPublicationTargetHoldCommand) => result(command.command));
    const service = new InventoryPublicationTargetHoldService({ apply }, { now: () => NOW });

    await expect(service.hold({
      ...REQUEST,
      reason: ` ${REQUEST.reason} `,
      idempotencyKey: ` ${REQUEST.idempotencyKey} `,
    }, " dropship-vendor-standing ")).resolves.toMatchObject({ command: "hold", outboxEnqueued: true });

    expect(apply).toHaveBeenCalledWith({
      ...REQUEST,
      command: "hold",
      actorId: "dropship-vendor-standing",
      occurredAt: NOW,
      requestHash: createHash("sha256").update(canonicalJson({
        commandType: "inventory_publication_target_hold",
        actorId: "dropship-vendor-standing",
        request: REQUEST,
      }), "utf8").digest("hex"),
    });
  });

  it("hashes a release differently from a hold with the same key, so the receipts cannot be confused", async () => {
    const apply = vi.fn(async (command: InventoryPublicationTargetHoldCommand) => result(command.command));
    const service = new InventoryPublicationTargetHoldService({ apply }, { now: () => NOW });

    await service.hold(REQUEST, "operator-7");
    await service.release(REQUEST, "operator-7");

    const [holdCommand, releaseCommand] = apply.mock.calls.map((call) => call[0]);
    expect(holdCommand.command).toBe("hold");
    expect(releaseCommand.command).toBe("release");
    expect(holdCommand.requestHash).not.toBe(releaseCommand.requestHash);
  });

  it("refuses malformed requests, a blank actor and an invalid clock before touching the store", async () => {
    const apply = vi.fn();
    const service = new InventoryPublicationTargetHoldService({ apply }, { now: () => NOW });

    await expect(service.hold({ ...REQUEST, reason: "" }, "operator-7"))
      .rejects.toMatchObject({ status: 400, code: "INVENTORY_PUBLICATION_TARGET_HOLD_INVALID_REQUEST" });
    await expect(service.hold({ ...REQUEST, destination: { destinationKind: "warehouse", connectionId: 1 } }, "operator-7"))
      .rejects.toMatchObject({ status: 400, code: "INVENTORY_PUBLICATION_TARGET_HOLD_INVALID_REQUEST" });
    await expect(service.release(REQUEST, "   "))
      .rejects.toMatchObject({ status: 401, code: "INVENTORY_PUBLICATION_TARGET_HOLD_ACTOR_REQUIRED" });
    await expect(new InventoryPublicationTargetHoldService({ apply }, { now: () => new Date(Number.NaN) }).hold(REQUEST, "operator-7"))
      .rejects.toMatchObject({ status: 500, code: "INVENTORY_PUBLICATION_TARGET_HOLD_CLOCK_INVALID" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("validates what the store returns", async () => {
    // Deliberately malformed store output: the service must reject it, not pass it through.
    const apply = vi.fn(async () => ({
      ...result("hold"),
      targets: [{ publicationTargetId: 5 }],
    }) as unknown as InventoryPublicationTargetHoldResult);
    const service = new InventoryPublicationTargetHoldService({ apply }, { now: () => NOW });

    await expect(service.hold(REQUEST, "operator-7")).rejects.toBeInstanceOf(Error);
  });
});
