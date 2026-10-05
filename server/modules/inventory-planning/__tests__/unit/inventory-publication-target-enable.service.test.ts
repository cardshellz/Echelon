import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@shared/utils/canonical-json";
import { InventoryPublicationTargetEnableService, type InventoryPublicationTargetEnableCommand } from "../../application/inventory-publication-target-enable.service";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const REQUEST = { publicationTargetId: 5, expectedRevision: "3", idempotencyKey: "enable-5" };
const RESULT = { publicationTargetId: 5, revision: "4", state: "live" as const, publicationRows: 0, initialDefinitionsApplied: 0,
  alreadyApplied: false, runtimeAuthorityChanged: false as const, providerWriteAttempted: false as const };

describe("InventoryPublicationTargetEnableService", () => {
  it("validates and hashes an actor-bound enable without a reason or historical review", async () => {
    const enable = vi.fn(async (_command: InventoryPublicationTargetEnableCommand) => RESULT);
    const service = new InventoryPublicationTargetEnableService({ enable }, { now: () => NOW });
    expect(await service.enable(REQUEST, " operator-7 ")).toEqual(RESULT);
    expect(enable).toHaveBeenCalledWith({ ...REQUEST, actorId: "operator-7", occurredAt: NOW,
      requestHash: createHash("sha256").update(canonicalJson({ commandType: "inventory_publication_target_enable", actorId: "operator-7", request: REQUEST }), "utf8").digest("hex") });
    await service.enable(REQUEST, "operator-8");
    expect(enable.mock.calls[1][0].requestHash).not.toBe(enable.mock.calls[0][0].requestHash);
  });
  it.each([{ publicationTargetId: 0 }, { publicationTargetId: 2147483648 }, { expectedRevision: "bad" },
    { expectedRevision: "9223372036854775808" }, { expectedRevision: "0" }, { idempotencyKey: "" }, { unexpected: true }])("rejects invalid input before calling the store: %j", async invalid => {
    const enable = vi.fn();
    await expect(new InventoryPublicationTargetEnableService({ enable }, { now: () => NOW }).enable({ ...REQUEST, ...invalid } as never, "operator"))
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_TARGET_ENABLE_INVALID_REQUEST" });
    expect(enable).not.toHaveBeenCalled();
  });
  it("requires a valid actor, injected clock, and validated store receipt", async () => {
    const enable = vi.fn();
    await expect(new InventoryPublicationTargetEnableService({ enable }).enable(REQUEST, " "))
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_TARGET_ENABLE_ACTOR_REQUIRED" });
    await expect(new InventoryPublicationTargetEnableService({ enable }, { now: () => new Date(NaN) }).enable(REQUEST, "operator"))
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_TARGET_ENABLE_CLOCK_INVALID" });
    expect(enable).not.toHaveBeenCalled();
    await expect(new InventoryPublicationTargetEnableService({ enable: vi.fn(async () => ({ revision: 4 }) as never) }, { now: () => NOW })
      .enable(REQUEST, "operator")).rejects.toThrow();
  });
});
