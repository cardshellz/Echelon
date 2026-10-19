import { describe, expect, it, vi } from "vitest";
import { IntegrityError, ValidationError } from "@shared/errors";
import { CostEvidenceError } from "../../../inventory/infrastructure/cost-evidence-values";
import { z } from "zod";
import { PgDialect } from "drizzle-orm/pg-core";
import { type FinancialCommandDescriptor, type FinancialCommandRepository, type FinancialCommandResult } from "../../../../platform/commands/transactional-command.service";
import { ReceiptReversalError, type ReceiptReversalTransaction } from "../../receipt-reversal.service";
vi.mock("../../../../platform/commands/command-results.repository", () => ({ financialCommandRepository: {} }));
import { createReceiptReversalCommands, hashReceiptReversalCommandIdentity, receiptReversalCommandScope, receiptReversalStorageKey, RECEIPT_REVERSAL_COMMAND_PRINCIPAL } from "../../receipt-reversal.commands";

const actorId = "review-operator";
const body = { qty: 2, reason: "Correct recorded receipt" };
const key = "receipt-command-1234";
const lineResult = { reversalId: 13, receivingOrderId: 10, receivingLineId: 11, qty: 2, baseUnitsReversed: 500, lotUnitCostMills: 124999, apReconciliationReopened: true, idempotentReplay: false };
function descriptor(input = body): FinancialCommandDescriptor {
  return { ...receiptReversalCommandScope(), actorType: "service", actorId: RECEIPT_REVERSAL_COMMAND_PRINCIPAL, idempotencyKey: key,
    requestHash: hashReceiptReversalCommandIdentity({ action: "line", targetId: 11, actorId, body: input }), contractVersion: 1 };
}
function harness(evidence: Record<string, unknown>[] = []) {
  const sql: string[] = [];
  const tx: ReceiptReversalTransaction = { execute: vi.fn(async (query) => {
    const text = new PgDialect().sqlToQuery(query).sql;
    sql.push(text);
    return { rows: text.includes("receipt_reversals") ? evidence : [] };
  }) };
  const owner = { reverseReceivingLineInTransaction: vi.fn(async () => lineResult), reverseReceivingOrderInTransaction: vi.fn(async () => ({ receivingOrderId: 10, reversals: [lineResult], poStatusUpdate: null })) };
  const repository: FinancialCommandRepository<ReceiptReversalTransaction> = {
    reserve: vi.fn(async () => ({ kind: "claimed" as const, claim: { commandId: 1, leaseToken: "lease" } })),
    executeClaim: vi.fn(async (_claim, _descriptor, work) => ({ commandId: 1, replayed: false, terminalState: "succeeded" as const, ...await work(tx) })),
    rejectClaim: vi.fn(async (_claim, _descriptor, failure) => ({ commandId: 1, replayed: false, terminalState: "rejected" as const, httpStatus: failure.httpStatus, body: failure.body })),
    markRetryable: vi.fn(async () => undefined),
  };
  return { sql, tx, owner, repository, commands: createReceiptReversalCommands(owner, repository) };
}

describe("receipt reversal durable command boundary", () => {
  it("executes inside the claim transaction with bounded audit identity and exact saved response", async () => {
    const h = harness();
    const result = await h.commands.execute("line", 11, body, actorId, descriptor());
    expect(result).toEqual({ commandId: 1, replayed: false, terminalState: "succeeded", httpStatus: 200,
      body: { ...lineResult, action: "line", targetId: 11, actorId, idempotencyKey: key }, resultType: "receipt_reversal", resultId: 13 });
    expect(h.owner.reverseReceivingLineInTransaction).toHaveBeenCalledExactlyOnceWith(h.tx, { receivingLineId: 11, qty: 2, reason: body.reason, allowNegative: undefined, userId: actorId, idempotencyKey: receiptReversalStorageKey(key) });
    expect(h.sql[0]).toContain("pg_advisory_xact_lock");
    expect(h.sql.slice(1).every((text) => !text.includes(" LIKE "))).toBe(true);
  });

  it.each(["actorType", "actorId", "method", "routeTemplate", "resourceKey", "commandName", "contractVersion", "idempotencyKey"] as const)("rejects invalid descriptor %s before reserving", async (field) => {
    const h = harness();
    const invalid = { ...descriptor(), [field]: field === "contractVersion" ? 2 : "invalid" };
    await expect(h.commands.execute("line", 11, body, actorId, invalid as FinancialCommandDescriptor)).rejects.toMatchObject({ code: "RECEIPT_REVERSAL_SCOPE_INVALID" });
    expect(h.repository.reserve).not.toHaveBeenCalled();
  });

  it.each(["", " actor", "x".repeat(101)])("requires exact authenticated actor %j", async (actor) => {
    const h = harness();
    await expect(h.commands.execute("line", 11, body, actor, descriptor())).rejects.toMatchObject({ code: "RECEIPT_REVERSAL_ACTOR_REQUIRED" });
    expect(h.repository.reserve).not.toHaveBeenCalled();
  });

  it.each([
    { action: "order", targetId: 11, actorId, body },
    { action: "line", targetId: 12, actorId, body },
    { action: "line", targetId: 11, actorId: "another-operator", body },
    { action: "line", targetId: 11, actorId, body: { ...body, qty: 3 } },
    { action: "line", targetId: 11, actorId, body: { ...body, reason: ` ${body.reason}` } },
    { action: "line", targetId: 11, actorId, body: { ...body, allowNegative: false } },
  ] as const)("binds exact action, target, actor and raw body %j", async (intent) => {
    const h = harness();
    expect(hashReceiptReversalCommandIdentity(intent)).not.toBe(descriptor().requestHash);
    await expect(h.commands.execute(intent.action, intent.targetId, intent.body, intent.actorId, descriptor())).rejects.toMatchObject({ code: "RECEIPT_REVERSAL_IDENTITY_INVALID" });
    expect(h.repository.reserve).not.toHaveBeenCalled();
  });

  it.each([{ qty: 0, reason: "x" }, { qty: 1.1, reason: "x" }, { qty: 2147483648, reason: "x" }, { qty: 1, reason: " " }, { qty: 1, reason: "x", allowNegative: "false" }, { qty: 1, reason: "x", extra: true }])("durably rejects invalid input before any side effect %j", async (invalid) => {
    const h = harness();
    const identity = { ...descriptor(), requestHash: hashReceiptReversalCommandIdentity({ action: "line", targetId: 11, actorId, body: invalid }) };
    expect(await h.commands.execute("line", 11, invalid, actorId, identity)).toMatchObject({ terminalState: "rejected", httpStatus: 400, body: { code: "RECEIPT_REVERSAL_INPUT_INVALID", details: { receiptReversalOutcome: "rejected", idempotencyKey: key } } });
    expect(h.owner.reverseReceivingLineInTransaction).not.toHaveBeenCalled();
    expect(h.tx.execute).not.toHaveBeenCalled();
  });

  it("does not compensate existing historical evidence without a saved command result", async () => {
    const h = harness([{ id: 99 }]);
    expect(await h.commands.execute("line", 11, body, actorId, descriptor())).toMatchObject({ terminalState: "rejected", httpStatus: 409, body: { code: "RECEIPT_REVERSAL_EVIDENCE_REVIEW_REQUIRED", details: { receiptReversalOutcome: "rejected", idempotencyKey: key } } });
    expect(h.owner.reverseReceivingLineInTransaction).not.toHaveBeenCalled();
  });

  it("persists business rejection with only its matching recovery acknowledgement", async () => {
    const h = harness();
    h.owner.reverseReceivingLineInTransaction.mockRejectedValue(new ReceiptReversalError("Insufficient original stock", 409, { code: "REVERSAL_INSUFFICIENT_ON_HAND" }));
    expect(await h.commands.execute("line", 11, body, actorId, descriptor())).toMatchObject({ terminalState: "rejected", body: { code: "REVERSAL_INSUFFICIENT_ON_HAND", details: { receiptReversalOutcome: "rejected", idempotencyKey: key } } });
    expect(h.repository.markRetryable).not.toHaveBeenCalled();
  });

  it.each([
    new ValidationError("Negative receipt reversal is unavailable after quantity-ledger activation"),
    new IntegrityError("Receipt reversal requires exact original lot evidence"),
    new CostEvidenceError("COST_EVIDENCE_INVALID_INTEGER", "Original cost needs review"),
  ])("records known inventory operational rejection %s", async (failure) => {
    const h = harness();
    h.owner.reverseReceivingLineInTransaction.mockRejectedValue(failure);
    expect(await h.commands.execute("line", 11, body, actorId, descriptor())).toMatchObject({ terminalState: "rejected", httpStatus: failure.statusCode, body: { code: failure.code, details: { receiptReversalOutcome: "rejected", idempotencyKey: key } } });
    expect(h.repository.markRetryable).not.toHaveBeenCalled();
  });

  it("does not misclassify internal schema corruption as user-input rejection", async () => {
    const h = harness();
    const invalid = z.object({ evidence: z.string() }).safeParse({ evidence: null });
    if (invalid.success) throw new Error("Invalid fixture should fail validation");
    h.owner.reverseReceivingLineInTransaction.mockRejectedValue(invalid.error);
    await expect(h.commands.execute("line", 11, body, actorId, descriptor())).rejects.toBe(invalid.error);
    expect(h.repository.markRetryable).toHaveBeenCalledOnce();
    expect(h.repository.rejectClaim).not.toHaveBeenCalled();
  });

  it("leaves infrastructure errors retryable without definitive rejection acknowledgement", async () => {
    const h = harness();
    const failure = new Error("connection lost");
    h.owner.reverseReceivingLineInTransaction.mockRejectedValue(failure);
    await expect(h.commands.execute("line", 11, body, actorId, descriptor())).rejects.toBe(failure);
    expect(h.repository.markRetryable).toHaveBeenCalledOnce();
    expect(h.repository.rejectClaim).not.toHaveBeenCalled();
  });

  it.each([{ receivingLineId: 12 }, { qty: 3 }, { baseUnitsReversed: 0 }, { lotUnitCostMills: Number.MAX_SAFE_INTEGER + 1 }])("rolls back malformed owner result %j", async (patch) => {
    const h = harness();
    h.owner.reverseReceivingLineInTransaction.mockResolvedValue({ ...lineResult, ...patch });
    await expect(h.commands.execute("line", 11, body, actorId, descriptor())).rejects.toMatchObject({ details: { code: "RECEIPT_REVERSAL_RESULT_INVALID" } });
    expect(h.repository.markRetryable).toHaveBeenCalledOnce();
  });

  it.each([{ actorId: "other" }, { idempotencyKey: "other-key" }, { qty: 3 }, { targetId: 99 }, { baseUnitsReversed: null }])("refuses corrupt persisted replay %j without executing work", async (patch) => {
    const h = harness();
    const replay: FinancialCommandResult = { commandId: 1, replayed: true, terminalState: "succeeded", httpStatus: 200, body: { ...lineResult, action: "line", targetId: 11, actorId, idempotencyKey: key, ...patch } };
    vi.mocked(h.repository.reserve).mockResolvedValue({ kind: "replay", result: replay });
    await expect(h.commands.execute("line", 11, body, actorId, descriptor())).rejects.toMatchObject({ code: "RECEIPT_REVERSAL_RESULT_INVALID" });
    expect(h.owner.reverseReceivingLineInTransaction).not.toHaveBeenCalled();
  });

  it.each([
    { httpStatus: 200, body: { code: "REJECTED", error: "Not allowed", details: { receiptReversalOutcome: "rejected", idempotencyKey: key } } },
    { httpStatus: 409, body: { code: "REJECTED", error: "Not allowed", details: { receiptReversalOutcome: "rejected", idempotencyKey: "another-key" } } },
    { httpStatus: 409, body: { code: "REJECTED", error: "Not allowed" } },
  ])("refuses a malformed saved rejection acknowledgement %j", async (patch) => {
    const h = harness();
    vi.mocked(h.repository.reserve).mockResolvedValue({ kind: "replay", result: { commandId: 1, replayed: true, terminalState: "rejected", ...patch } });
    await expect(h.commands.execute("line", 11, body, actorId, descriptor())).rejects.toMatchObject({ code: "RECEIPT_REVERSAL_RESULT_INVALID" });
    expect(h.owner.reverseReceivingLineInTransaction).not.toHaveBeenCalled();
  });

  it("replays exactly the successful result without re-running state decisions", async () => {
    const h = harness();
    const first = await h.commands.execute("line", 11, body, actorId, descriptor());
    vi.mocked(h.repository.reserve).mockResolvedValue({ kind: "replay", result: { ...first, replayed: true } });
    expect((await h.commands.execute("line", 11, body, actorId, descriptor())).body).toEqual(first.body);
    expect(h.owner.reverseReceivingLineInTransaction).toHaveBeenCalledOnce();
  });

  it("keeps a 200-character key within the old audit column including largest line ID", () => {
    expect(`${receiptReversalStorageKey("x".repeat(200))}:line:2147483647`.length).toBeLessThanOrEqual(100);
    expect(receiptReversalStorageKey("x".repeat(200))).not.toEqual(receiptReversalStorageKey("x".repeat(199)));
  });
});
