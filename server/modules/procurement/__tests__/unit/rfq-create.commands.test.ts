import { describe, expect, it, vi } from "vitest";
import { rfqCreateIntent, rfqCreateReceipt } from "../../../../../test/fixtures/rfq-create-command";
import { createRfqCreateCommands, hashRfqCreateIdentity, rfqCreateCommandScope, RFQ_CREATE_COMMAND_PRINCIPAL } from "../../rfq-create.commands";
import { buildRfqCreationRequestHash } from "../../purchasing-rfq-allocation";
import { PurchasingError } from "../../purchasing.service";
import type { FinancialCommandRepository } from "../../../../platform/commands/transactional-command.service";
import type { RfqWorkflowTransaction } from "../../rfq-workflow.service";

const actor = "operator-a", key = "initial-rfq-command";
function fixture() {
  const intent = rfqCreateIntent;
  const receipt = rfqCreateReceipt(intent, key, actor);
  const expectedHash = buildRfqCreationRequestHash(intent.payload, actor);
  receipt.result.rfqs.forEach(row => { row.requestHash = expectedHash; });
  const descriptor = { ...rfqCreateCommandScope(), actorType: "service" as const, actorId: RFQ_CREATE_COMMAND_PRINCIPAL,
    idempotencyKey: key, contractVersion: 1, requestHash: hashRfqCreateIdentity(intent.payload, actor) };
  const repository: FinancialCommandRepository<RfqWorkflowTransaction> = {
    reserve: vi.fn(async () => ({ kind: "claimed" as const, claim: { commandId: 1, leaseToken: "lease" } })),
    executeClaim: vi.fn(async (_claim, _descriptor, work) => ({ commandId: 1, replayed: false, terminalState: "succeeded" as const, ...await work({} as RfqWorkflowTransaction) })),
    rejectClaim: vi.fn(async (_claim, _descriptor, rejection) => ({ commandId: 1, replayed: false, terminalState: "rejected" as const, httpStatus: rejection.httpStatus, body: rejection.body })),
    markRetryable: vi.fn(async () => undefined),
  };
  const owner = { assertRfqCreationAuthority: vi.fn(async () => undefined), createRfqBatchInTransaction: vi.fn(async () => receipt.result) };
  return { intent, descriptor, receipt, repository, owner, command: createRfqCreateCommands(owner, repository) };
}
describe("initial RFQ command owner", () => {
  it("saves the verified result in the same transaction and rechecks authority after the ledger wait", async () => {
    const f = fixture(); const result = await f.command.execute(f.intent.payload, actor, f.descriptor);
    expect(result).toMatchObject({ httpStatus: 201, body: f.receipt, terminalState: "succeeded" });
    expect(f.owner.assertRfqCreationAuthority).toHaveBeenCalledTimes(2);
    expect(f.owner.createRfqBatchInTransaction).toHaveBeenCalledWith(expect.anything(), f.intent.payload, actor, key);
  });
  it("binds actor, payload and resource before reserving a key", async () => {
    const f = fixture();
    await expect(f.command.execute(f.intent.payload, "operator-b", f.descriptor)).rejects.toMatchObject({ code: "RFQ_CREATE_IDENTITY_INVALID" });
    await expect(f.command.execute({ ...f.intent.payload, requestNote: "changed" }, actor, f.descriptor)).rejects.toMatchObject({ code: "RFQ_CREATE_IDENTITY_INVALID" });
    await expect(f.command.execute(f.intent.payload, actor, { ...f.descriptor, resourceKey: "other" })).rejects.toMatchObject({ code: "RFQ_CREATE_IDENTITY_INVALID" });
    expect(f.repository.reserve).not.toHaveBeenCalled();
  });
  it.each(["actor", "key", "hash", "pieces", "supplier", "source"])("retains unverifiable fresh %s evidence as retryable", async fault => {
    const f = fixture(); const row = f.receipt.result.rfqs[0], line = f.receipt.result.lines[0];
    if (fault === "actor") row.createdBy = "another";
    if (fault === "key") row.idempotencyKey = "another-key";
    if (fault === "hash") row.requestHash = "b".repeat(64);
    if (fault === "pieces") line.requestedPieces = 99;
    if (fault === "supplier") row.vendorId = 3;
    if (fault === "source") line.recommendationLineId = 99;
    await expect(f.command.execute(f.intent.payload, actor, f.descriptor)).rejects.toMatchObject({ code: "RFQ_CREATE_RESULT_INVALID" });
    expect(f.repository.markRetryable).toHaveBeenCalledOnce(); expect(f.repository.rejectClaim).not.toHaveBeenCalled();
  });
  it("returns proof only after recording a known business rejection", async () => {
    const f = fixture(); f.owner.createRfqBatchInTransaction.mockRejectedValue(new PurchasingError("Demand changed", 409, { code: "RFQ_ALLOCATION_CONFLICT" }));
    expect(await f.command.execute(f.intent.payload, actor, f.descriptor)).toMatchObject({ terminalState: "rejected", httpStatus: 409,
      body: { code: "RFQ_ALLOCATION_CONFLICT", details: { rfqCommandOutcome: "rejected", actorId: actor, idempotencyKey: key, intent: f.intent } } });
    expect(f.repository.rejectClaim).toHaveBeenCalledOnce();
  });
  it.each(["RFQ_IDEMPOTENCY_CONFLICT", "RFQ_IDEMPOTENCY_ACTOR_CONFLICT"])("retains legacy %s without licensing another request", async code => {
    const f = fixture(); f.owner.createRfqBatchInTransaction.mockRejectedValue(new PurchasingError("Original identity unresolved", 409, { code }));
    await expect(f.command.execute(f.intent.payload, actor, f.descriptor)).rejects.toMatchObject({ details: { code } });
    expect(f.repository.markRetryable).toHaveBeenCalledOnce(); expect(f.repository.rejectClaim).not.toHaveBeenCalled();
  });
  it("does not expose a saved result after authority is revoked during the ledger wait", async () => {
    const f = fixture(); f.owner.assertRfqCreationAuthority.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PurchasingError("Revoked", 403));
    vi.mocked(f.repository.reserve).mockResolvedValue({ kind: "replay", result: { commandId: 1, replayed: true, terminalState: "succeeded", httpStatus: 201, body: f.receipt } });
    await expect(f.command.execute(f.intent.payload, actor, f.descriptor)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.owner.createRfqBatchInTransaction).not.toHaveBeenCalled();
  });
  it("validates the stored result instead of trusting a replay discriminator", async () => {
    const f = fixture(); f.receipt.result.rfqs[0].requestHash = "c".repeat(64);
    vi.mocked(f.repository.reserve).mockResolvedValue({ kind: "replay", result: { commandId: 1, replayed: true, terminalState: "succeeded", httpStatus: 201, body: f.receipt } });
    await expect(f.command.execute(f.intent.payload, actor, f.descriptor)).rejects.toMatchObject({ code: "RFQ_CREATE_RESULT_INVALID" });
  });
});
