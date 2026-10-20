import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";
vi.mock("../../supplier-return.service", () => ({ recordSupplierReturn: vi.fn() }));
vi.mock("../../../../platform/commands/command-results.repository", () => ({ financialCommandRepository: {} }));
import { recordSupplierReturn, type SupplierReturnTransaction } from "../../supplier-return.service";
import { bindSupplierReturnCommand, classifySupplierReturnFailure, createSupplierReturnCommands, SUPPLIER_RETURN_COMMAND_SCOPE, validateSupplierReturnReceipt } from "../../supplier-return.commands";
import { SupplierReturnError } from "../../supplier-return.errors";
import { CostEvidenceError } from "../../../inventory/infrastructure/cost-evidence-values";
import { SupplierReturnStockError } from "../../../inventory/domain/supplier-return-stock";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import type { FinancialCommandDescriptor, FinancialCommandRepository } from "../../../../platform/commands/transactional-command.service";
import { returnRequest, returnResult, returnPreview } from "../../../../../test/fixtures/supplier-return";

const actorId = "return-operator", key = "return-command-1234";
function descriptor(raw: unknown = returnRequest()): FinancialCommandDescriptor {
  return { ...SUPPLIER_RETURN_COMMAND_SCOPE, actorType: "user", actorId, idempotencyKey: key, contractVersion: 1,
    requestHash: hashHttpFinancialCommand({ ...SUPPLIER_RETURN_COMMAND_SCOPE, body: raw, params: {}, query: {} }) };
}
const saved = () => returnResult(returnRequest(), returnPreview(), actorId, key);
const success = (body: unknown) => ({ body, httpStatus: 201, terminalState: "succeeded" as const });
function harness() {
  const tx = {} as SupplierReturnTransaction;
  const repository: FinancialCommandRepository<SupplierReturnTransaction> = {
    reserve: vi.fn(async () => ({ kind: "claimed" as const, claim: { commandId: 1, leaseToken: "lease" } })),
    executeClaim: vi.fn(async (_claim, _descriptor, work) => ({ commandId: 1, replayed: false, terminalState: "succeeded", ...await work(tx) })),
    rejectClaim: vi.fn(async (_claim, _descriptor, failure) => ({ commandId: 1, replayed: false, terminalState: "rejected" as const, httpStatus: failure.httpStatus, body: failure.body })),
    markRetryable: vi.fn(async () => undefined),
  };
  const at = new Date("2026-10-20T15:00:00Z");
  return { tx, repository, at, commands: createSupplierReturnCommands(repository, () => at) };
}
beforeEach(() => { vi.mocked(recordSupplierReturn).mockReset(); });
describe("supplier return durable command evidence", () => {
  it("records the reviewed request and inventory receipt in the claim transaction", async () => {
    const h = harness();
    vi.mocked(recordSupplierReturn).mockResolvedValue(saved().return);
    const result = await h.commands.record(returnRequest(), descriptor());
    expect(result).toMatchObject({ httpStatus: 201, terminalState: "succeeded", body: saved() });
    expect(recordSupplierReturn).toHaveBeenCalledExactlyOnceWith(h.tx, { raw: returnRequest(), actorId, at: h.at, commandKey: key, requestFingerprint: descriptor().requestHash });
    expect(h.repository.reserve).toHaveBeenCalledExactlyOnceWith(bindSupplierReturnCommand(descriptor()));
  });
  it("binds the same physical key across actors without allowing another actor to replay it", () => {
    const first = bindSupplierReturnCommand(descriptor());
    const other = bindSupplierReturnCommand({ ...descriptor(), actorId: "other" });
    expect(other.actorId).toBe(first.actorId);
    expect(other.idempotencyKey).toBe(first.idempotencyKey);
    expect(other.requestHash).not.toBe(first.requestHash);
  });
  it.each(["actorType", "actorId", "method", "routeTemplate", "resourceKey", "commandName", "contractVersion", "idempotencyKey", "requestHash"] as const)("rejects invalid %s before reserving", async field => {
    const h = harness();
    await expect(h.commands.record(returnRequest(), { ...descriptor(), [field]: field === "contractVersion" ? 2 : field === "actorId" ? " actor" : "invalid" })).rejects.toMatchObject({ code: "SUPPLIER_RETURN_IDENTITY_INVALID" });
    expect(h.repository.reserve).not.toHaveBeenCalled();
    expect(recordSupplierReturn).not.toHaveBeenCalled();
  });
  it("replays an exact saved result without invoking the physical owner again", async () => {
    const h = harness();
    vi.mocked(h.repository.reserve).mockResolvedValue({ kind: "replay", result: { commandId: 1, replayed: true, ...success(saved()) } });
    expect(await h.commands.record(returnRequest(), descriptor())).toMatchObject({ replayed: true, body: saved() });
    expect(recordSupplierReturn).not.toHaveBeenCalled();
  });
  it.each(["actorId", "idempotencyKey"] as const)("rejects a saved result for a different %s", field => {
    const body = saved(); body[field] = "other-identity";
    expect(() => validateSupplierReturnReceipt(success(body), returnRequest(), descriptor())).toThrow("does not match");
  });
  it.each(["vendorId", "returnCalendarDate", "evidenceReference", "reason", "supplierReference", "expectedSourceFingerprint"] as const)("does not accept a receipt for different %s", field => {
    const request = returnRequest();
    const different = { ...request, [field]: field === "vendorId" ? 3 : field === "returnCalendarDate" ? "2026-10-21" : field === "expectedSourceFingerprint" ? "b".repeat(64) : "different" };
    expect(() => validateSupplierReturnReceipt(success(saved()), different, descriptor(different))).toThrow("does not match");
  });
  it("rejects changed physical quantity even if the saved request is rewritten", () => {
    const raw = { ...returnRequest(), lines: [{ inventoryLotId: 501, quantity: 3 }] };
    const body = saved(); body.request = raw;
    expect(() => validateSupplierReturnReceipt(success(body), raw, descriptor(raw))).toThrow("does not match");
  });
  it("durably rejects a known availability conflict with exact recovery identity", async () => {
    const h = harness();
    vi.mocked(recordSupplierReturn).mockRejectedValue(new SupplierReturnStockError("SUPPLIER_RETURN_RESERVED", "Stock is reserved."));
    const result = await h.commands.record(returnRequest(), descriptor());
    expect(result).toMatchObject({ terminalState: "rejected", httpStatus: 409, body: { details: { code: "SUPPLIER_RETURN_RESERVED", supplierReturnCommandOutcome: "rejected", command: "record", actorId, idempotencyKey: key } } });
    expect(h.repository.markRetryable).not.toHaveBeenCalled();
  });
  it.each([new CostEvidenceError("COST_EVIDENCE_INVALID_INTEGER", "Corrupt retained amount"), new Error("connection lost"), new z.ZodError([]), new SupplierReturnError("INVARIANT", "Evidence mismatch", 500)])("keeps unknown or corrupt execution retryable (%s)", async failure => {
    const h = harness(); vi.mocked(recordSupplierReturn).mockRejectedValue(failure);
    await expect(h.commands.record(returnRequest(), descriptor())).rejects.toBe(failure);
    expect(h.repository.markRetryable).toHaveBeenCalledOnce();
    expect(h.repository.rejectClaim).not.toHaveBeenCalled();
  });
  it.each([{ terminalState: "rejected", httpStatus: 409, body: {} }, { terminalState: "rejected", httpStatus: 503, body: { details: { supplierReturnCommandOutcome: "rejected", command: "record", actorId, idempotencyKey: key } } }] as const)("does not clear recovery for an ambiguous response", result => {
    expect(() => validateSupplierReturnReceipt(result, returnRequest(), descriptor())).toThrow("does not match");
  });
  it("classifies domain input failure as rejected, without classifying arbitrary errors as user intent", () => {
    expect(classifySupplierReturnFailure(new SupplierReturnError("INPUT", "Invalid request", 422))).toMatchObject({ kind: "rejected", httpStatus: 422 });
    expect(classifySupplierReturnFailure({ statusCode: 409, code: "CONFLICT" })).toMatchObject({ kind: "retryable" });
  });
});
