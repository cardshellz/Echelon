import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@shared/utils/canonical-json";
import { InventoryPublicationTargetStopService, type InventoryPublicationTargetStopCommand } from "../../application/inventory-publication-target-stop.service";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const REQUEST = { publicationTargetId: 5, expectedRevision: "3", idempotencyKey: "pause-5" };
const RESULT = { publicationTargetId: 5, revision: "4", state: "disabled" as const,
  alreadyApplied: false, runtimeAuthorityChanged: false as const,
  providerWriteAttempted: false as const, outboxEnqueued: false as const };
const requestHash = (request: unknown, actorId = "operator-7") => createHash("sha256").update(canonicalJson({
  commandType: "inventory_publication_target_stop", actorId, request,
}), "utf8").digest("hex");

describe("InventoryPublicationTargetStopService", () => {
  it.each([undefined, "", "   ", null])("pauses without a reason (%s), using one normalized actor-bound command", async changeReason => {
    const stop = vi.fn(async (_command: InventoryPublicationTargetStopCommand) => RESULT);
    const service = new InventoryPublicationTargetStopService({ stop }, { now: () => NOW });
    await expect(service.stop({ ...REQUEST, ...(changeReason === undefined ? {} : { changeReason }) }, " operator-7 "))
      .resolves.toEqual(RESULT);
    expect(stop).toHaveBeenCalledWith({ ...REQUEST, changeReason: null, actorId: "operator-7", occurredAt: NOW,
      requestHash: requestHash({ ...REQUEST, changeReason: null }) });
    await service.stop(REQUEST, "operator-8");
    expect(stop.mock.calls[1][0].requestHash).not.toBe(stop.mock.calls[0][0].requestHash);
  });

  it("preserves optional legacy notes and their idempotency hashes", async () => {
    const stop = vi.fn(async (_command: InventoryPublicationTargetStopCommand) => RESULT);
    const service = new InventoryPublicationTargetStopService({ stop }, { now: () => NOW });
    const request = { ...REQUEST, changeReason: "Operator note" };
    await service.stop({ ...request, changeReason: "  Operator note  " }, "operator-7");
    expect(stop.mock.calls[0][0]).toMatchObject({ changeReason: "Operator note", requestHash: requestHash(request) });
  });

  it.each([{ changeReason: 12 }, { changeReason: "x".repeat(1001) }, { publicationTargetId: 0 },
    { expectedRevision: "bad" }, { idempotencyKey: "" }, { unexpected: true }])("rejects malformed input before writing", async invalid => {
    const stop = vi.fn();
    const service = new InventoryPublicationTargetStopService({ stop }, { now: () => NOW });
    await expect(service.stop({ ...REQUEST, ...invalid } as never, "operator-7"))
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_TARGET_STOP_INVALID_REQUEST" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("still requires a valid actor, clock and store receipt", async () => {
    const stop = vi.fn();
    await expect(new InventoryPublicationTargetStopService({ stop }).stop(REQUEST, " "))
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_TARGET_STOP_ACTOR_REQUIRED" });
    await expect(new InventoryPublicationTargetStopService({ stop }, { now: () => new Date(NaN) }).stop(REQUEST, "operator-7"))
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_TARGET_STOP_CLOCK_INVALID" });
    expect(stop).not.toHaveBeenCalled();
    await expect(new InventoryPublicationTargetStopService({ stop: vi.fn(async () => ({ revision: 4 }) as never) }, { now: () => NOW })
      .stop(REQUEST, "operator-7")).rejects.toThrow();
  });
});
