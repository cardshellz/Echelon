import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FinancialCommandDescriptor, FinancialCommandRepository, FinancialCommandResult } from "../../../../platform/commands/transactional-command.service";
import type { ReceivingEntryTransaction } from "../../receiving-entry.repository";
import { ReceivingError } from "../../receiving.service";
import { ReceivingEntryError, assertReceivingEntryAuthority } from "../../domain/receiving-entry";
import { receivingEntryCommandSchema, receivingEntryLineFields } from "@shared/procurement/receiving-entry-command";
vi.mock("../../../../platform/commands/command-results.repository", () => ({ financialCommandRepository: {} }));
import { createReceivingEntryCommands, hashReceivingEntryCommandIdentity, receivingEntryCommandScope, RECEIVING_ENTRY_COMMAND_PRINCIPAL } from "../../receiving-entry.commands";

const actorId = "receiver";
const key = "receiving-entry-1234";
const command = { action: "add-line", targetId: 10, payload: {
  sku: "FIVE-CASE", productVariantId: 101, productId: 20, expectedUnitsPerVariant: 5, receivedQty: 5, expectedQty: 5,
  putawayLocationId: 100, unitCostMills: 375, unitCost: 4,
} } as const;
const line = { id: 11, receivingOrderId: 10, sku: "FIVE-CASE", productName: null, barcode: null,
  productVariantId: 101, productId: 20, expectedQty: 5, receivedQty: 5, damagedQty: 0,
  unitsPerVariantSnapshot: 5, putawayLocationId: 100, unitCost: 4, unitCostMills: 375 };
function descriptor(input: unknown = command, actor = actorId): FinancialCommandDescriptor {
  return { ...receivingEntryCommandScope(), actorType: "service", actorId: RECEIVING_ENTRY_COMMAND_PRINCIPAL,
    idempotencyKey: key, requestHash: hashReceivingEntryCommandIdentity(input, actor), contractVersion: 1 };
}
function harness() {
  const tx: ReceivingEntryTransaction = { execute: vi.fn(async () => ({ rows: [] })) };
  const owner = { assertEntryAuthority: vi.fn(async (_actor: string) => undefined),
    executeEntryInTransaction: vi.fn(async (): Promise<{ order: Record<string, unknown>; receivingLineId: number | null }> => ({ order: { id: 10, receiptNumber: "RCV-TEST", status: "open", lines: [line] }, receivingLineId: 11 })) };
  const repository: FinancialCommandRepository<ReceivingEntryTransaction> = {
    reserve: vi.fn(async () => ({ kind: "claimed" as const, claim: { commandId: 1, leaseToken: "lease" } })),
    executeClaim: vi.fn(async (_claim, _descriptor, work) => ({ commandId: 1, replayed: false, terminalState: "succeeded" as const, ...await work(tx) })),
    rejectClaim: vi.fn(async (_claim, _descriptor, failure) => ({ commandId: 1, replayed: false, terminalState: "rejected" as const, httpStatus: failure.httpStatus, body: failure.body })),
    markRetryable: vi.fn(async () => undefined),
  };
  return { owner, tx, repository, commands: createReceivingEntryCommands(owner, repository) };
}

describe("durable receiving entry commands", () => {
  it("passes the normalized intent, actor and command key into the claim transaction", async () => {
    const h = harness();
    expect(await h.commands.execute(command, actorId, descriptor())).toMatchObject({ httpStatus: 201, terminalState: "succeeded",
      body: { entryCommand: { action: "add-line", targetId: 10, actorId, idempotencyKey: key, receivingOrderId: 10, receivingLineId: 11 }, lines: [line] } });
    expect(h.owner.executeEntryInTransaction).toHaveBeenCalledExactlyOnceWith(h.tx, receivingEntryCommandSchema.parse(command), actorId, key);
  });
  it.each(["actorType", "actorId", "method", "routeTemplate", "resourceKey", "commandName", "contractVersion", "idempotencyKey"] as const)("rejects invalid descriptor %s before reserving", async field => {
    const h = harness();
    await expect(h.commands.execute(command, actorId, { ...descriptor(), [field]: field === "contractVersion" ? 2 : "invalid" } as FinancialCommandDescriptor))
      .rejects.toMatchObject({ code: "RECEIVING_ENTRY_SCOPE_INVALID" });
    expect(h.repository.reserve).not.toHaveBeenCalled();
  });
  it.each(["", " actor", "x".repeat(101)])("rejects invalid actor %j", async actor => {
    const h = harness();
    await expect(h.commands.execute(command, actor, descriptor())).rejects.toMatchObject({ code: "RECEIVING_ENTRY_ACTOR_REQUIRED" });
    expect(h.repository.reserve).not.toHaveBeenCalled();
  });
  it.each([
    { ...command, targetId: 20 }, { action: "create", targetId: null, payload: {} },
    { ...command, payload: { ...command.payload, receivedQty: 6 } },
    { ...command, payload: { ...command.payload, sku: " FIVE-CASE" } },
  ])("binds the original action, target and unmodified payload %j", async changed => {
    const h = harness();
    await expect(h.commands.execute(changed, actorId, descriptor())).rejects.toMatchObject({ code: "RECEIVING_ENTRY_IDENTITY_INVALID" });
    expect(h.repository.reserve).not.toHaveBeenCalled();
  });
  it("binds the authenticated actor even for shared workstations", async () => {
    const h = harness();
    await expect(h.commands.execute(command, "another-receiver", descriptor())).rejects.toMatchObject({ code: "RECEIVING_ENTRY_IDENTITY_INVALID" });
  });
  it.each([
    { receivedQty: -1 }, { receivedQty: 0.5 }, { receivedQty: 2_147_483_648 }, { productVariantId: "101" },
    { unitCost: 5 }, { unit_cost_mills: 376 }, { unitCost: Number.MAX_SAFE_INTEGER, unitCostMills: undefined },
    { unknown: true },
  ])("durably rejects invalid input without mutation %j", async patch => {
    const h = harness();
    const invalid = { ...command, payload: { ...command.payload, ...patch } };
    expect(await h.commands.execute(invalid, actorId, descriptor(invalid))).toMatchObject({ terminalState: "rejected", httpStatus: 400,
      body: { code: "RECEIVING_ENTRY_INPUT_INVALID", details: { receivingEntryOutcome: "rejected", idempotencyKey: key } } });
    expect(h.owner.executeEntryInTransaction).not.toHaveBeenCalled();
  });
  it("retains exact mills, derives cents and leaves zero quantities valid", () => {
    const parsed = receivingEntryCommandSchema.parse({ ...command, payload: { ...command.payload, expectedQty: 0, receivedQty: 0, unitCost: undefined } });
    if (parsed.action !== "add-line") throw new Error("Expected add line");
    expect(receivingEntryLineFields(parsed.payload)).toMatchObject({ expectedQty: 0, receivedQty: 0, unitCost: 4, unitCostMills: 375 });
  });
  it("accepts the product resolved from the reviewed variant when its ID was not supplied", async () => {
    const h = harness();
    const selectedVariant = { ...command, payload: { ...command.payload, productId: null } };
    expect(await h.commands.execute(selectedVariant, actorId, descriptor(selectedVariant))).toMatchObject({ terminalState: "succeeded" });
  });
  it("denies recovery before reservation when the current actor was disabled or revoked", async () => {
    const h = harness();
    h.owner.assertEntryAuthority.mockRejectedValue(new ReceivingEntryError("RECEIVING_ENTRY_FORBIDDEN", "Permission revoked", 403));
    await expect(h.commands.execute(command, actorId, descriptor())).rejects.toMatchObject({ code: "RECEIVING_ENTRY_FORBIDDEN" });
    expect(h.repository.reserve).not.toHaveBeenCalled();
  });
  it.each([
    { userId: actorId, active: false, permissions: ["inventory:adjust"], scopedPermissions: [] },
    { userId: actorId, active: true, permissions: [], scopedPermissions: ["inventory:adjust"] },
  ])("never grants broad command authority from inactive or scoped evidence %j", actor => {
    expect(() => assertReceivingEntryAuthority(actor)).toThrow("inventory adjustment permission");
  });
  it("persists operational rejection without allowing an unknown result to look rejected", async () => {
    const h = harness();
    h.owner.executeEntryInTransaction.mockRejectedValue(new ReceivingError("Receipt closed", 409, { code: "RECEIVING_ORDER_IMMUTABLE" }));
    expect(await h.commands.execute(command, actorId, descriptor())).toMatchObject({ terminalState: "rejected", httpStatus: 409,
      body: { details: { receivingEntryOutcome: "rejected", idempotencyKey: key } } });
    expect(h.repository.markRetryable).not.toHaveBeenCalled();
  });
  it.each([new Error("connection lost"), z.object({ evidence: z.string() }).safeParse({}).error])("keeps internal failures retryable %s", async failure => {
    const h = harness();
    h.owner.executeEntryInTransaction.mockRejectedValue(failure);
    await expect(h.commands.execute(command, actorId, descriptor())).rejects.toBe(failure);
    expect(h.repository.markRetryable).toHaveBeenCalledOnce();
    expect(h.repository.rejectClaim).not.toHaveBeenCalled();
  });
  it.each([{ receivedQty: 6 }, { unitsPerVariantSnapshot: 10 }, { productVariantId: 102 }, { unitCostMills: 376 }, { receivingOrderId: 12 }])("rejects incorrect owner recovery evidence %j before commit", async patch => {
    const h = harness();
    h.owner.executeEntryInTransaction.mockResolvedValue({ order: { id: 10, receiptNumber: "RCV-TEST", status: "open", lines: [{ ...line, ...patch }] }, receivingLineId: 11 });
    await expect(h.commands.execute(command, actorId, descriptor())).rejects.toMatchObject({ code: "RECEIVING_ENTRY_RESULT_INVALID" });
    expect(h.repository.markRetryable).toHaveBeenCalledOnce();
  });
  it("replays the exact saved result and rechecks current authority without running the mutation", async () => {
    const h = harness();
    const first = await h.commands.execute(command, actorId, descriptor());
    vi.mocked(h.repository.reserve).mockResolvedValue({ kind: "replay", result: { ...first, replayed: true } });
    expect((await h.commands.execute(command, actorId, descriptor())).body).toEqual(first.body);
    expect(h.owner.executeEntryInTransaction).toHaveBeenCalledOnce();
    expect(h.owner.assertEntryAuthority).toHaveBeenCalledTimes(2);
  });
  it.each([{ warehouseId: 2 }, { vendorId: 4 }, { poNumber: "wrong" }, { asnNumber: "wrong" }, { notes: "wrong" }, { expectedDate: "2026-10-24T00:00:00.000Z" }, { createdBy: "other" }, { status: "open" }])("does not commit a create result with different reviewed header evidence %j", async patch => {
    const h = harness();
    const creation = { action: "create", targetId: null, payload: { sourceType: "blind", warehouseId: 1, vendorId: 5,
      poNumber: "Supplier PO", asnNumber: "ASN", notes: "Reviewed note", expectedDate: "2026-10-23" } };
    h.owner.executeEntryInTransaction.mockResolvedValue({ order: { id: 10, receiptNumber: "RCV-NEW", status: "draft", createdBy: actorId,
      ...creation.payload, expectedDate: "2026-10-23T00:00:00.000Z", ...patch }, receivingLineId: null });
    await expect(h.commands.execute(creation, actorId, descriptor(creation))).rejects.toMatchObject({ code: "RECEIVING_ENTRY_RESULT_INVALID" });
    expect(h.repository.markRetryable).toHaveBeenCalledOnce();
  });
  it.each([{ actorId: "other" }, { targetId: 99 }, { idempotencyKey: "other-key" }])("refuses a corrupt persisted result %j", async patch => {
    const h = harness();
    const result: FinancialCommandResult = { commandId: 1, replayed: true, terminalState: "succeeded", httpStatus: 201,
      body: { id: 10, receiptNumber: "RCV-TEST", status: "open", lines: [line], entryCommand: {
        action: "add-line", targetId: 10, actorId, idempotencyKey: key, receivingOrderId: 10, receivingLineId: 11, ...patch } } };
    vi.mocked(h.repository.reserve).mockResolvedValue({ kind: "replay", result });
    await expect(h.commands.execute(command, actorId, descriptor())).rejects.toMatchObject({ code: "RECEIVING_ENTRY_RESULT_INVALID" });
    expect(h.owner.executeEntryInTransaction).not.toHaveBeenCalled();
  });
});
