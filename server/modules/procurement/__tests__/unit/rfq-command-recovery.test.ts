import { describe, expect, it, vi } from "vitest";
import { reviewRfqQuantity } from "@shared/procurement/rfq-quantity-review";
import { matchesRfqCommandReceipt, rfqCommandIntentSchema, rfqCommandReceiptSchema } from "@shared/procurement/rfq-command";
import type { RfqWorkflowDetail } from "@shared/procurement/rfq-workflow";
import { createRfqWorkflowCommands, RFQ_WORKFLOW_COMMAND_PRINCIPAL, rfqWorkflowCommandScope, validateRfqWorkflowReceipt } from "../../rfq-workflow.commands";
import { createRfqWorkflowService, RfqWorkflowError, type RfqWorkflowCommand, type RfqWorkflowTransaction } from "../../rfq-workflow.service";
import type { FinancialCommandRepository, FinancialCommandResult } from "../../../../platform/commands/transactional-command.service";

const actor = "rfq-editor";
const key = "rfq-recovery-test-1";
const beforeVersion = "a".repeat(64);
const afterVersion = "b".repeat(64);
const at = new Date("2026-10-21T12:00:00Z");
const quote = { pricing: { basis: "per_piece" as const, quantityPieces: 2, unitCostMills: 10000 },
  packagingTreatment: "separate" as const, packagingCostCents: 0, quoteReference: "V-1",
  quoteValidUntil: null, quotedAt: at.toISOString(), leadTimeDays: null, reason: "Supplier confirmed" };

function fixture(operation: RfqWorkflowCommand["operation"] = "capture_quote") {
  const rules = { vendorProductId: 6, minimumOrderPieces: 1, piecesPerPurchaseUom: null, packSize: 1 };
  const workflow: RfqWorkflowDetail = { id: 10, rfqNumber: "RFQ-10", vendorId: 5, currency: "USD",
    status: operation === "release" ? "cancelled" : "quoted", version: afterVersion, lines: [{
      id: 20, status: operation === "release" ? "cancelled" : "quoted", productId: 100, productVariantId: 200,
      warehouseId: 1, vendorProductId: 6, sku: "CASE", productName: "Case", requestedPieces: 2,
      quantityReview: reviewRfqQuantity({ recommendationRules: rules, currentRules: rules, quotedPieces: 2 }),
      purchaseOrder: null, latestQuote: { id: 7, rfqLineId: 20, revision: 1, fingerprint: "c".repeat(64),
        currency: "USD", quotedPieces: 2, quotedUnitCostMills: 10000, productTotalMills: 20000,
        pricingRemainderMills: 0, quote, createdBy: actor, createdAt: at.toISOString() },
    }] };
  const command: RfqWorkflowCommand = operation === "capture_quote"
    ? { operation, rfqId: 10, lineId: 20, body: { expectedVersion: beforeVersion, quote } }
    : operation === "release" ? { operation, rfqId: 10, body: { expectedVersion: beforeVersion, reason: "Supplier declined" } }
      : { operation, rfqId: 10, body: { expectedVersion: beforeVersion, lines: [{ rfqLineId: 20, quoteRevisionId: 7 }], quantityOverrideReason: null } };
  const result = operation === "convert" ? { rfqId: 10, purchaseOrderId: 30, poNumber: "PO-30", status: "draft",
    lines: [{ rfqLineId: 20, quoteRevisionId: 7, purchaseOrderLineId: 40 }] } : workflow;
  const intent = rfqCommandIntentSchema.parse({ operation, rfqId: 10,
    ...(operation === "capture_quote" ? { lineId: 20 } : {}), payload: command.body });
  const receipt = { version: 1, actorId: actor, idempotencyKey: key, intent, result };
  const descriptor = { actorType: "service" as const, actorId: RFQ_WORKFLOW_COMMAND_PRINCIPAL,
    ...rfqWorkflowCommandScope(command), idempotencyKey: key, requestHash: "d".repeat(64), contractVersion: 1 };
  return { command, workflow, result, intent, receipt, descriptor };
}

function harness() {
  const repository: FinancialCommandRepository<RfqWorkflowTransaction> = {
    reserve: vi.fn(async () => ({ kind: "claimed" as const, claim: { commandId: 1, leaseToken: "lease" } })),
    executeClaim: async (_claim, _descriptor, work) => ({ commandId: 1, replayed: false,
      terminalState: "succeeded", ...await work({} as RfqWorkflowTransaction) }),
    rejectClaim: async (_claim, _descriptor, rejection) => ({ commandId: 1, replayed: false,
      terminalState: "rejected", httpStatus: rejection.httpStatus, body: rejection.body }),
    markRetryable: vi.fn(async () => undefined),
  };
  const service = { executeInTransaction: vi.fn() };
  return { repository, service, commands: createRfqWorkflowCommands(service, repository, () => at) };
}

describe("RFQ recovery receipts", () => {
  it.each(["capture_quote", "release", "convert"] as const)("persists verified %s identity while retaining its old uniqueness scope", async operation => {
    const f = fixture(operation), h = harness();
    h.service.executeInTransaction.mockResolvedValue(f.result);
    const result = await h.commands.execute(f.command, actor, f.descriptor);
    expect(result.body).toEqual(f.receipt);
    expect(matchesRfqCommandReceipt(result.body, { actorId: actor, idempotencyKey: key, intent: f.intent })).toBe(true);
    expect(h.repository.reserve).toHaveBeenCalledWith({ ...f.descriptor, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(vi.mocked(h.repository.reserve).mock.calls[0][0].requestHash).not.toBe(f.descriptor.requestHash);
    expect(h.service.executeInTransaction).toHaveBeenCalledWith(expect.anything(), f.command, actor, at, key);
  });

  it("changes the request binding for a different real actor without changing its ledger identity", async () => {
    const f = fixture("release"), h = harness();
    h.service.executeInTransaction.mockResolvedValue(f.result);
    await h.commands.execute(f.command, actor, f.descriptor);
    await h.commands.execute(f.command, "another-operator", f.descriptor);
    const [first, second] = vi.mocked(h.repository.reserve).mock.calls.map(call => call[0]);
    expect(first.requestHash).not.toBe(second.requestHash);
    expect({ ...first, requestHash: "" }).toEqual({ ...second, requestHash: "" });
  });

  it.each(["wrong_actor", "wrong_key", "wrong_rfq", "wrong_quote", "unchanged_version"])("rejects a superficially valid capture response: %s", change => {
    const f = fixture();
    const value = structuredClone(f.receipt);
    if (change === "wrong_actor") value.actorId = "another";
    if (change === "wrong_key") value.idempotencyKey = "another-request-key";
    if ("id" in value.result) {
      if (change === "wrong_rfq") value.result.id = 11;
      if (change === "wrong_quote") value.result.lines[0].latestQuote!.quote.quoteReference = "Different quote";
      if (change === "unchanged_version") value.result.version = beforeVersion;
    }
    expect(matchesRfqCommandReceipt(value, { actorId: actor, idempotencyKey: key, intent: f.intent })).toBe(false);
  });

  it("rejects substituted conversion selections and duplicate created purchase-line identities", () => {
    const f = fixture("convert");
    if (!("rfqId" in f.receipt.result)) throw new Error("Fixture conversion missing");
    f.receipt.result.lines[0].quoteRevisionId = 99;
    expect(rfqCommandReceiptSchema.safeParse(f.receipt).success).toBe(false);
    f.receipt.result.lines[0].quoteRevisionId = 7;
    f.receipt.result.lines.push({ ...f.receipt.result.lines[0] });
    expect(rfqCommandReceiptSchema.safeParse(f.receipt).success).toBe(false);
  });

  it("does not acknowledge an invalid fresh result or persist it as a definitive rejection", async () => {
    const f = fixture(), h = harness();
    h.service.executeInTransaction.mockResolvedValue({ ...f.workflow, id: 99 });
    await expect(h.commands.execute(f.command, actor, f.descriptor)).rejects.toMatchObject({ code: "RFQ_COMMAND_RECEIPT_INVALID" });
    expect(h.repository.markRetryable).toHaveBeenCalledOnce();
  });

  it("verifies replayed results without executing the operation again", async () => {
    const f = fixture(), h = harness();
    const saved: FinancialCommandResult = { commandId: 1, replayed: true, httpStatus: 200, terminalState: "succeeded", body: f.receipt };
    vi.mocked(h.repository.reserve).mockResolvedValue({ kind: "replay", result: saved });
    expect(await h.commands.execute(f.command, actor, f.descriptor)).toEqual(saved);
    saved.body = f.workflow; // A historical raw result is not invented receipt evidence.
    await expect(h.commands.execute(f.command, actor, f.descriptor)).rejects.toMatchObject({ code: "RFQ_COMMAND_RECEIPT_INVALID" });
    expect(h.service.executeInTransaction).not.toHaveBeenCalled();
  });

  it("marks only durable domain rejections with matching request proof", async () => {
    const f = fixture("release"), h = harness();
    h.service.executeInTransaction.mockRejectedValue(new RfqWorkflowError("RFQ_VERSION_CONFLICT", "Refresh"));
    const result = await h.commands.execute(f.command, actor, f.descriptor);
    expect(result).toMatchObject({ terminalState: "rejected", httpStatus: 409, body: {
      details: { rfqCommandOutcome: "rejected", actorId: actor, idempotencyKey: key, intent: f.intent },
    } });
    expect(() => validateRfqWorkflowReceipt({ ...result, httpStatus: 500 }, f.command, actor, key)).toThrow();
    expect(() => validateRfqWorkflowReceipt({ ...result, body: { code: "RFQ_VERSION_CONFLICT" } }, f.command, actor, key)).toThrow();
  });

  it("keeps malformed stored authority evidence retryable instead of labeling it invalid operator input", async () => {
    const f = fixture("release"), h = harness();
    const tx = { execute: vi.fn().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: actor, active: "malformed" }] }), transaction: vi.fn(), select: vi.fn(), insert: vi.fn() };
    const service = createRfqWorkflowService({ transaction: vi.fn() }, { createPurchaseOrderWithLines: vi.fn() });
    let failure: unknown;
    try { await service.executeInTransaction(tx, f.command, actor, at, key); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "RFQ_AUTHORITY_EVIDENCE_INVALID", statusCode: 500 });
    h.service.executeInTransaction.mockRejectedValue(failure);
    await expect(h.commands.execute(f.command, actor, f.descriptor)).rejects.toBe(failure);
    expect(h.repository.markRetryable).toHaveBeenCalledOnce();
  });
});
