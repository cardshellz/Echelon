import { describe, expect, it, vi } from "vitest";
import { createPurchaseApprovalCommands, purchaseApprovalCommandScope } from "../../purchase-approval.commands";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import type { FinancialCommandDescriptor, FinancialCommandRepository } from "../../../../platform/commands/transactional-command.service";

const body = { expectedUpdatedAt: "2026-10-23T12:00:00.000Z", expectedTotalCents: 10000, expectedLinesFingerprint: "a".repeat(64) };
const result = { id: 1, status: "approved", approvedBy: "operator-a", totalCents: 10000, updatedAt: "2026-10-23T12:01:00.000Z", reviewedUpdatedAt: body.expectedUpdatedAt, reviewedLinesFingerprint: body.expectedLinesFingerprint };
function setup() {
  const descriptor: FinancialCommandDescriptor = { ...purchaseApprovalCommandScope(1), actorType: "user", actorId: "operator-a", idempotencyKey: "approval-command-1", contractVersion: 1,
    requestHash: hashHttpFinancialCommand({ ...purchaseApprovalCommandScope(1), params: { id: "1" }, body }) };
  const tx = {};
  const repository: FinancialCommandRepository<typeof tx> = {
    reserve: vi.fn(async () => ({ kind: "claimed" as const, claim: { commandId: 1, leaseToken: "lease" } })),
    executeClaim: async (_claim, _descriptor, work) => {
      const saved = await work(tx);
      return { commandId: 1, replayed: false, terminalState: "succeeded", httpStatus: saved.httpStatus, body: saved.body };
    },
    rejectClaim: vi.fn(async (_claim, _descriptor, rejected) => ({ commandId: 1, replayed: false, terminalState: "rejected" as const, httpStatus: rejected.httpStatus, body: rejected.body })),
    markRetryable: vi.fn(async () => undefined),
  };
  const owner = { authorize: vi.fn(async () => undefined), approve: vi.fn(async () => result) };
  return { descriptor, tx, repository, owner, commands: createPurchaseApprovalCommands(owner, repository) };
}

describe("reviewed purchase approval command identity", () => {
  it("uses one transaction and records verified actor, purchase, reviewed amount/version and command identity", async () => {
    const { commands, descriptor, owner, tx } = setup();
    const saved = await commands.execute(1, body, "operator-a", descriptor);
    expect(saved).toMatchObject({ terminalState: "succeeded", httpStatus: 200, body: { ...result, approvalCommand: { name: descriptor.commandName, idempotencyKey: descriptor.idempotencyKey } } });
    expect(owner.authorize).toHaveBeenCalledWith("operator-a");
    expect(owner.approve).toHaveBeenCalledWith(tx, 1, "operator-a", body);
  });
  it.each([{ actorId: "other" }, { resourceKey: "purchase_order:2" }, { routeTemplate: "/different" }, { commandName: "procurement.other" }, { actorType: "service" }])("rejects altered command scope without reserving or writing: %j", async patch => {
    const { commands, descriptor, repository, owner } = setup();
    await expect(commands.execute(1, body, "operator-a", { ...descriptor, ...patch } as FinancialCommandDescriptor)).rejects.toMatchObject({ code: "PO_APPROVAL_SCOPE_INVALID" });
    expect(repository.reserve).not.toHaveBeenCalled();
    expect(owner.approve).not.toHaveBeenCalled();
  });
  it("rejects mismatched raw body identity before reserving a command", async () => {
    const { commands, descriptor, repository } = setup();
    await expect(commands.execute(1, { ...body, expectedTotalCents: 100000 }, "operator-a", descriptor)).rejects.toMatchObject({ code: "PO_APPROVAL_IDENTITY_INVALID" });
    expect(repository.reserve).not.toHaveBeenCalled();
  });
  it("revalidates current permission before a stored success is replayed", async () => {
    const { commands, descriptor, repository, owner } = setup();
    owner.authorize.mockRejectedValueOnce(new Error("current permission revoked"));
    await expect(commands.execute(1, body, "operator-a", descriptor)).rejects.toThrow("current permission revoked");
    expect(repository.reserve).not.toHaveBeenCalled();
  });
  it.each([{ id: 2 }, { approvedBy: "other" }, { totalCents: 100001 }, { reviewedUpdatedAt: result.updatedAt }, { approvalCommand: { name: "procurement.purchase_order.approve", idempotencyKey: "different-key" } }])("refuses mismatched stored success without executing approval again: %j", async patch => {
    const { commands, descriptor, repository, owner } = setup();
    vi.mocked(repository.reserve).mockResolvedValueOnce({ kind: "replay", result: { commandId: 1, replayed: true, terminalState: "succeeded", httpStatus: 200,
      body: { ...result, approvalCommand: { name: descriptor.commandName, idempotencyKey: descriptor.idempotencyKey }, ...patch } } });
    await expect(commands.execute(1, body, "operator-a", descriptor)).rejects.toMatchObject({ code: "PO_APPROVAL_RESULT_INVALID" });
    expect(owner.approve).not.toHaveBeenCalled();
  });
  it("does not publish an invalid fresh owner result as a successful durable command", async () => {
    const { commands, descriptor, repository, owner } = setup();
    owner.approve.mockResolvedValueOnce({ ...result, totalCents: 100000 });
    await expect(commands.execute(1, body, "operator-a", descriptor)).rejects.toMatchObject({ code: "PO_APPROVAL_RESULT_INVALID" });
    expect(repository.markRetryable).toHaveBeenCalled();
    expect(repository.rejectClaim).not.toHaveBeenCalled();
  });
});
