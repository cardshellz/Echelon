import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { canonicalJson } from "@shared/utils/canonical-json";
import { InventoryPublicationGlobalControlService } from "../../application/inventory-publication-global-control.service";

const NOW = new Date("2026-09-14T12:00:00.000Z");
const REQUEST = {
  globalEnabled: true,
  sweepIntervalMinutes: 10,
  expectedRevision: "3",
  idempotencyKey: "global-control-1",
  changeReason: "Enable after reviewed pre-activation proof",
};

describe("InventoryPublicationGlobalControlService", () => {
  it("validates, timestamps, and hashes the exact actor-bound command deterministically", async () => {
    const change = vi.fn(async (command) => ({
      globalEnabled: command.globalEnabled,
      sweepIntervalMinutes: command.sweepIntervalMinutes,
      revision: "4",
      changedBy: command.actorId,
      changeReason: command.changeReason,
      changedAt: command.occurredAt.toISOString(),
      alreadyApplied: false,
    }));
    const service = new InventoryPublicationGlobalControlService(
      { change },
      { now: () => NOW },
    );

    await expect(service.change(REQUEST, "operator-7")).resolves.toMatchObject({
      globalEnabled: true,
      revision: "4",
      changedBy: "operator-7",
    });
    expect(change).toHaveBeenCalledWith({
      ...REQUEST,
      actorId: "operator-7",
      occurredAt: NOW,
      requestHash: createHash("sha256").update(canonicalJson({
        commandType: "inventory_publication_global_control_change",
        actorId: "operator-7",
        request: REQUEST,
      }), "utf8").digest("hex"),
    });
  });

  it("rejects empty changes and invalid revisions before calling the store", async () => {
    const change = vi.fn();
    const service = new InventoryPublicationGlobalControlService({ change });

    await expect(service.change({
      expectedRevision: "3",
      idempotencyKey: "global-control-1",
      changeReason: "No actual setting",
    }, "operator-7")).rejects.toMatchObject({
      code: "INVENTORY_PUBLICATION_GLOBAL_CONTROL_INVALID_REQUEST",
    });
    await expect(service.change({ ...REQUEST, expectedRevision: "0" }, "operator-7"))
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_GLOBAL_CONTROL_INVALID_REQUEST" });
    expect(change).not.toHaveBeenCalled();
  });

  it("requires an authenticated bounded actor and a valid injected clock", async () => {
    const change = vi.fn();
    await expect(new InventoryPublicationGlobalControlService({ change })
      .change(REQUEST, " ")).rejects.toMatchObject({
      code: "INVENTORY_PUBLICATION_GLOBAL_CONTROL_ACTOR_REQUIRED",
    });
    await expect(new InventoryPublicationGlobalControlService(
      { change },
      { now: () => new Date(Number.NaN) },
    ).change(REQUEST, "operator-7")).rejects.toMatchObject({
      code: "INVENTORY_PUBLICATION_GLOBAL_CONTROL_CLOCK_INVALID",
    });
    expect(change).not.toHaveBeenCalled();
  });

  it("fails closed when the store returns a malformed receipt", async () => {
    const service = new InventoryPublicationGlobalControlService({
      change: vi.fn(async () => ({ revision: 4 } as never)),
    }, { now: () => NOW });

    await expect(service.change(REQUEST, "operator-7")).rejects.toThrow();
  });
});
