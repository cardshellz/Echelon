import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@shared/utils/canonical-json";
import { purchaseOrderEntryCommandSchema, purchaseOrderEntryCommandResultSchema, purchaseOrderEntryResultMatchesRequest } from "@shared/procurement/purchase-order-entry-command";
import type { FinancialCommandDescriptor, FinancialCommandRepository } from "../../../../platform/commands/transactional-command.service";
import type { PurchaseOrderEntryTransaction } from "../../purchase-order-entry.repository";
import { PurchasingError } from "../../purchasing.service";
import { PurchaseOrderEntryError, assertPurchaseOrderEntryAuthority, purchaseOrderEntryPermission } from "../../domain/purchase-order-entry";
vi.mock("../../../../platform/commands/command-results.repository", () => ({ financialCommandRepository: {} }));
import { createPurchaseOrderEntryCommands, hashPurchaseOrderEntryCommandIdentity, purchaseOrderEntryCommandScope, PURCHASE_ORDER_ENTRY_COMMAND_PRINCIPAL } from "../../purchase-order-entry.commands";

const actor = "buyer";
const key = "purchase-order-entry:test";
const command = { action: "create", targetId: null, payload: { vendor_id: 1, lines: [{ product_id: 10, quantity_ordered: 2 }] } } as const;
const po = { id: 12, poNumber: "PO-TEST", status: "draft", physicalStatus: "draft", vendorId: 1,
  updatedAt: "2026-10-24T12:00:00.000Z", totalCents: 400, lineCount: 1 };
const lines = [{ id: 13, purchaseOrderId: 12, orderQty: 2, status: "open", lineNumber: 1 }];
function descriptor(input: unknown = command, actorId = actor): FinancialCommandDescriptor {
  return { ...purchaseOrderEntryCommandScope(), actorType: "service", actorId: PURCHASE_ORDER_ENTRY_COMMAND_PRINCIPAL,
    idempotencyKey: key, requestHash: hashPurchaseOrderEntryCommandIdentity(input, actorId), contractVersion: 1 };
}
function harness() {
  const tx = {} as PurchaseOrderEntryTransaction;
  const owner = { assertPurchaseEntryAuthority: vi.fn(async () => undefined),
    executePurchaseEntryInTransaction: vi.fn(async (): Promise<Record<string, unknown>> => ({ po, lines })) };
  const repository: FinancialCommandRepository<PurchaseOrderEntryTransaction> = {
    reserve: vi.fn(async () => ({ kind: "claimed" as const, claim: { commandId: 1, leaseToken: "lease" } })),
    executeClaim: vi.fn(async (_claim, _descriptor, work) => ({ commandId: 1, replayed: false, terminalState: "succeeded" as const, ...await work(tx) })),
    rejectClaim: vi.fn(async (_claim, _descriptor, failure) => ({ commandId: 1, replayed: false, terminalState: "rejected" as const, httpStatus: failure.httpStatus, body: failure.body })),
    markRetryable: vi.fn(async () => undefined),
  };
  return { tx, owner, repository, commands: createPurchaseOrderEntryCommands(owner, repository) };
}

describe("purchase order entry exact recovery", () => {
  it("binds the exact request, actor, key and returned PO in the claim transaction", async () => {
    const h = harness();
    const result = await h.commands.execute(command, actor, descriptor());
    expect(result).toMatchObject({ httpStatus: 201, body: { po, lines, entryCommand: {
      action: "create", targetId: null, actorId: actor, idempotencyKey: key, purchaseOrderId: 12, requestCanonical: canonicalJson(command),
    } } });
    expect(h.owner.executePurchaseEntryInTransaction).toHaveBeenCalledExactlyOnceWith(h.tx, command, actor, key);
    expect(h.owner.assertPurchaseEntryAuthority).toHaveBeenCalledTimes(2);
  });
  it.each(["actorType", "actorId", "method", "routeTemplate", "resourceKey", "commandName", "contractVersion", "idempotencyKey"] as const)("refuses invalid command descriptor %s before reservation", async field => {
    const h = harness();
    await expect(h.commands.execute(command, actor, { ...descriptor(), [field]: field === "contractVersion" ? 2 : "bad" } as FinancialCommandDescriptor))
      .rejects.toMatchObject({ code: "PURCHASE_ORDER_ENTRY_SCOPE_INVALID" });
    expect(h.repository.reserve).not.toHaveBeenCalled();
  });
  it.each(["", " buyer", "x".repeat(101)])("requires a valid authenticated actor %j", async actorId => {
    const h = harness();
    await expect(h.commands.execute(command, actorId, descriptor())).rejects.toMatchObject({ code: "PURCHASE_ORDER_ENTRY_ACTOR_REQUIRED" });
    expect(h.repository.reserve).not.toHaveBeenCalled();
  });
  it.each([{ ...command, payload: { ...command.payload, vendor_id: 2 } }, { action: "duplicate", targetId: 12, payload: {} }])("refuses changed request identity %j", async changed => {
    const h = harness();
    await expect(h.commands.execute(changed, actor, descriptor())).rejects.toMatchObject({ code: "PURCHASE_ORDER_ENTRY_IDENTITY_INVALID" });
    expect(h.repository.reserve).not.toHaveBeenCalled();
  });
  it("does not reserve or reinterpret a legacy unresolved key", async () => {
    const h = harness();
    h.owner.assertPurchaseEntryAuthority.mockRejectedValue(new PurchaseOrderEntryError("PURCHASE_ORDER_ENTRY_LEGACY_REVIEW_REQUIRED", "Review existing record", 409));
    await expect(h.commands.execute(command, actor, descriptor())).rejects.toMatchObject({ code: "PURCHASE_ORDER_ENTRY_LEGACY_REVIEW_REQUIRED" });
    expect(h.repository.reserve).not.toHaveBeenCalled();
  });
  it("replays the saved original response without dispatching the owner", async () => {
    const h = harness();
    const first = await h.commands.execute(command, actor, descriptor());
    vi.mocked(h.repository.reserve).mockResolvedValue({ kind: "replay", result: { ...first, replayed: true } });
    expect(await h.commands.execute(command, actor, descriptor())).toEqual({ ...first, replayed: true });
    expect(h.owner.executePurchaseEntryInTransaction).toHaveBeenCalledOnce();
  });
  it("withholds replay when permission is revoked while reservation waits", async () => {
    const h = harness();
    const first = await h.commands.execute(command, actor, descriptor());
    vi.mocked(h.repository.reserve).mockResolvedValue({ kind: "replay", result: { ...first, replayed: true } });
    h.owner.assertPurchaseEntryAuthority.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PurchaseOrderEntryError("PURCHASE_ORDER_ENTRY_FORBIDDEN", "Permission revoked", 403));
    await expect(h.commands.execute(command, actor, descriptor())).rejects.toMatchObject({ code: "PURCHASE_ORDER_ENTRY_FORBIDDEN" });
    expect(h.owner.executePurchaseEntryInTransaction).toHaveBeenCalledOnce();
  });
  it("binds every durable rejection to the exact action, actor, target and request", async () => {
    const h = harness();
    h.owner.executePurchaseEntryInTransaction.mockRejectedValue(new PurchasingError("Quote changed", 409, { code: "QUOTE_CHANGED" }));
    expect(await h.commands.execute(command, actor, descriptor())).toMatchObject({ terminalState: "rejected", httpStatus: 409,
      body: { code: "QUOTE_CHANGED", details: { purchaseOrderEntryOutcome: "rejected", idempotencyKey: key,
        actorId: actor, action: command.action, targetId: null, requestCanonical: canonicalJson(command) } } });
    expect(h.repository.markRetryable).not.toHaveBeenCalled();
  });
  it.each([new Error("audit unavailable"), new PurchasingError("Allocator busy", 409, { code: "PO_NUMBER_ALLOCATION_EXHAUSTED" })])("keeps uncertain failures retryable %j", async error => {
    const h = harness(); h.owner.executePurchaseEntryInTransaction.mockRejectedValue(error);
    await expect(h.commands.execute(command, actor, descriptor())).rejects.toBe(error);
    expect(h.repository.markRetryable).toHaveBeenCalledOnce(); expect(h.repository.rejectClaim).not.toHaveBeenCalled();
  });
  it.each([{ lines: [] }, { lines: [lines[0], lines[0]] }, { po: { ...po, status: "sent", physicalStatus: "sent" } },
    { po: { ...po, updatedAt: undefined } }, { dispatch_recorded: true }])("refuses malformed or misleading success before commit %j", async patch => {
    const h = harness(); h.owner.executePurchaseEntryInTransaction.mockResolvedValue({ po, lines, ...patch });
    await expect(h.commands.execute(command, actor, descriptor())).rejects.toMatchObject({ code: "PURCHASE_ORDER_ENTRY_RESULT_INVALID" });
    expect(h.repository.markRetryable).toHaveBeenCalledOnce();
  });
  it("preserves a saved draft after a verified supplier-preparation rejection", async () => {
    const h = harness(); const requested = { ...command, payload: { ...command.payload, prepare_for_supplier: true } };
    h.owner.executePurchaseEntryInTransaction.mockResolvedValue({ po, lines, status: "draft", dispatch_recorded: false, sendError: "Quote requires review" });
    expect(await h.commands.execute(requested, actor, descriptor(requested))).toMatchObject({ httpStatus: 201, terminalState: "succeeded" });
  });
  it.each(["create", "duplicate", "prepare", "save-draft", "prepare-document"] as const)("checks the actual route permission for %s", action => {
    const permission = purchaseOrderEntryPermission(action);
    expect(permission).toBe(["save-draft", "prepare-document"].includes(action) ? "edit" : "create");
    expect(() => assertPurchaseOrderEntryAuthority({ userId: actor, active: true, permissions: [], scopedPermissions: [`purchasing:${permission}`] }, action)).toThrow();
    expect(() => assertPurchaseOrderEntryAuthority({ userId: actor, active: true, permissions: [`purchasing:${permission}`], scopedPermissions: [] }, action)).not.toThrow();
  });
  it("does not accept matching metadata for another original request", async () => {
    const h = harness(); const first = await h.commands.execute(command, actor, descriptor());
    const result = purchaseOrderEntryCommandResultSchema.parse(first.body);
    expect(purchaseOrderEntryResultMatchesRequest(result, purchaseOrderEntryCommandSchema.parse({ ...command, payload: {} }), actor)).toBe(false);
  });
});
