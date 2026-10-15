import { describe, expect, it, vi } from "vitest";
import { shipmentCostUpdateInputSchema } from "@shared/procurement/shipment-cost-workflow";
import { ShipmentTrackingError } from "../../shipment-tracking.service";
import { createShipmentCostUpdateCommands, classifyShipmentCostUpdateFailure, shipmentCostUpdateScope, SHIPMENT_COST_UPDATE_PRINCIPAL } from "../../shipment-cost-update.commands";
import type { FinancialCommandDescriptor, FinancialCommandRepository, FinancialCommandResult } from "../../../../platform/commands/transactional-command.service";

const descriptor: FinancialCommandDescriptor = { ...shipmentCostUpdateScope(42), actorType: "service",
  actorId: SHIPMENT_COST_UPDATE_PRINCIPAL, contractVersion: 1, requestHash: "a".repeat(64), idempotencyKey: "cost-update-42" };
const outcome = { shipmentId: 42, finalizedLines: 1, adjustments: 1, status: "applied" as const, updated: 1, total: 1, skipped: [] };

function harness() {
  const tx = { transaction: "owned by durable command" };
  let saved: FinancialCommandResult | undefined;
  const repository: FinancialCommandRepository<typeof tx> = {
    reserve: vi.fn(async () => saved ? { kind: "replay" as const, result: { ...saved, replayed: true } }
      : { kind: "claimed" as const, claim: { commandId: 1, leaseToken: "lease" } }),
    executeClaim: async (_claim, _descriptor, work) => {
      const result = { ...await work(tx), commandId: 1, replayed: false, terminalState: "succeeded" as const };
      saved = result;
      return result;
    },
    rejectClaim: vi.fn(async (_claim, _descriptor, rejection) => ({ commandId: 1, replayed: false,
      httpStatus: rejection.httpStatus, body: rejection.body, terminalState: "rejected" as const })),
    markRetryable: vi.fn(async () => undefined),
  };
  const updateCostsInTransaction = vi.fn(async () => outcome);
  const now = new Date("2026-10-15T12:00:00Z");
  const commands = createShipmentCostUpdateCommands({ updateCostsInTransaction }, repository, () => now);
  return { tx, repository, updateCostsInTransaction, now, commands };
}

describe("audited shipment cost update command", () => {
  it("uses one transaction, actor and clock, and replays the saved result without repeating work", async () => {
    const h = harness();
    expect(await h.commands.execute(42, {}, "approver", descriptor)).toMatchObject({ replayed: false, body: outcome });
    expect(await h.commands.execute(42, {}, "approver", descriptor)).toMatchObject({ replayed: true, body: outcome });
    expect(h.updateCostsInTransaction).toHaveBeenCalledExactlyOnceWith(h.tx, 42, {}, "approver", h.now);
  });
  it("rejects absent actors, unsafe body fields, and mismatched scope before reserving", async () => {
    const h = harness();
    await expect(h.commands.execute(42, {}, "", descriptor)).rejects.toMatchObject({ statusCode: 401 });
    await expect(h.commands.execute(42, { totalCents: 1 }, "approver", descriptor)).rejects.toMatchObject({ code: "SHIPMENT_COST_UPDATE_INPUT_INVALID" });
    await expect(h.commands.execute(43, {}, "approver", descriptor)).rejects.toMatchObject({ code: "SHIPMENT_COST_UPDATE_SCOPE_INVALID" });
    expect(h.repository.reserve).not.toHaveBeenCalled();
    expect(h.updateCostsInTransaction).not.toHaveBeenCalled();
  });
  it("stores a business rejection but leaves infrastructure failures retryable", async () => {
    const h = harness();
    h.updateCostsInTransaction.mockRejectedValueOnce(new ShipmentTrackingError("Check quantities", 409, { code: "COST_REVIEW" }));
    expect(await h.commands.execute(42, {}, "approver", descriptor)).toMatchObject({ terminalState: "rejected", httpStatus: 409, body: { code: "COST_REVIEW" } });
    h.updateCostsInTransaction.mockRejectedValueOnce(new Error("database disconnected"));
    await expect(h.commands.execute(42, {}, "approver", descriptor)).rejects.toThrow("database disconnected");
    expect(h.repository.markRetryable).toHaveBeenCalledOnce();
  });
  it("never misclassifies malformed stored evidence as a user input rejection", () => {
    const invalidEvidence = shipmentCostUpdateInputSchema.safeParse({ invalid: true });
    expect(classifyShipmentCostUpdateFailure(invalidEvidence.error)).toMatchObject({ kind: "retryable" });
  });
});
