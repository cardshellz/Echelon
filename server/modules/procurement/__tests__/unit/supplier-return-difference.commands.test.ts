import { describe, expect, it, vi, beforeEach } from "vitest";
vi.mock("../../supplier-return.service", () => ({ recordSupplierReturn: vi.fn() }));
vi.mock("../../supplier-return-difference.service", () => ({ recordSupplierReturnDifferenceReview: vi.fn() }));
vi.mock("../../../../platform/commands/command-results.repository", () => ({ financialCommandRepository: {} }));
import { recordSupplierReturnDifferenceReview } from "../../supplier-return-difference.service";
import { createSupplierReturnReviewCommands, SUPPLIER_RETURN_REVIEW_COMMAND_SCOPE, validateSupplierReturnReviewReceipt } from "../../supplier-return-difference.commands";
import { SupplierReturnError } from "../../supplier-return.errors";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import type { FinancialCommandDescriptor, FinancialCommandRepository } from "../../../../platform/commands/transactional-command.service";
import type { SupplierReturnTransaction } from "../../supplier-return.repository";
import { returnCreditReviewRequest, returnCreditReviewResult, returnCreditReview } from "../../../../../test/fixtures/supplier-return";

const actorId = "review-operator", key = "supplier-review-1234", entitlementId = 111;
function descriptor(raw: unknown = returnCreditReviewRequest()): FinancialCommandDescriptor {
  return { ...SUPPLIER_RETURN_REVIEW_COMMAND_SCOPE, actorType: "user", actorId, idempotencyKey: key, contractVersion: 1,
    requestHash: hashHttpFinancialCommand({ ...SUPPLIER_RETURN_REVIEW_COMMAND_SCOPE, body: raw, params: { id: String(entitlementId) }, query: {} }) };
}
const saved = () => returnCreditReviewResult(returnCreditReviewRequest(), returnCreditReview(), actorId, key);
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
  return { tx, repository, at, commands: createSupplierReturnReviewCommands(repository, () => at) };
}
beforeEach(() => { vi.mocked(recordSupplierReturnDifferenceReview).mockReset(); });
describe("durable return credit difference review", () => {
  it("retains unresolved differences while saving the exact review receipt", async () => {
    const h = harness(); vi.mocked(recordSupplierReturnDifferenceReview).mockResolvedValue(saved().review);
    const result = await h.commands.review(entitlementId, returnCreditReviewRequest(), descriptor());
    expect(result).toMatchObject({ terminalState: "succeeded", httpStatus: 201, body: saved() });
    expect(saved().review.differences.totalMills).not.toBe(0);
    expect(recordSupplierReturnDifferenceReview).toHaveBeenCalledExactlyOnceWith(h.tx, { entitlementId, raw: returnCreditReviewRequest(), actorId, at: h.at, commandKey: key });
  });
  it("replays saved review without appending or applying money again", async () => {
    const h = harness();
    vi.mocked(h.repository.reserve).mockResolvedValue({ kind: "replay", result: { commandId: 1, replayed: true, ...success(saved()) } });
    expect(await h.commands.review(entitlementId, returnCreditReviewRequest(), descriptor())).toMatchObject({ replayed: true, body: saved() });
    expect(recordSupplierReturnDifferenceReview).not.toHaveBeenCalled();
  });
  it("requires the exact entitlement request identity before claiming", async () => {
    const h = harness();
    await expect(h.commands.review(entitlementId + 1, returnCreditReviewRequest(), descriptor())).rejects.toMatchObject({ code: "SUPPLIER_RETURN_REVIEW_IDENTITY_INVALID" });
    expect(h.repository.reserve).not.toHaveBeenCalled();
  });
  it.each(["recordedBy", "expectedVersion", "reason", "evidenceReference"] as const)("rejects mismatched retained review %s", field => {
    const body = saved(); body.review.latestReview![field] = field === "expectedVersion" ? "f".repeat(64) : "different";
    expect(() => validateSupplierReturnReviewReceipt(success(body), entitlementId, returnCreditReviewRequest(), descriptor())).toThrow("does not match");
  });
  it("does not confirm an absent, duplicated or stale immutable review", () => {
    for (const failure of ["missing", "duplicate", "stale", "unchanged", "not-last"] as const) {
      const body = saved();
      if (failure === "missing") body.review.reviewHistory = [];
      if (failure === "duplicate") body.review.reviewHistory.push(structuredClone(body.review.latestReview!));
      if (failure === "stale") body.review.reviewCurrent = false;
      if (failure === "unchanged") body.review.version = returnCreditReviewRequest().expectedVersion;
      if (failure === "not-last") body.review.reviewHistory.push({ ...structuredClone(body.review.latestReview!), id: 999 });
      expect(() => validateSupplierReturnReviewReceipt(success(body), entitlementId, returnCreditReviewRequest(), descriptor())).toThrow("does not match");
    }
  });
  it("returns terminal stale-review refusal bound to actor, key and entitlement", async () => {
    const h = harness(); vi.mocked(recordSupplierReturnDifferenceReview).mockRejectedValue(new SupplierReturnError("RETURN_CREDIT_REVIEW_STALE", "Reload current value"));
    expect(await h.commands.review(entitlementId, returnCreditReviewRequest(), descriptor())).toMatchObject({ terminalState: "rejected", httpStatus: 409,
      body: { details: { supplierReturnCommandOutcome: "rejected", command: "review_credit_difference", actorId, idempotencyKey: key, entitlementId } } });
  });
  it("keeps audit and transport failures retryable", async () => {
    const h = harness(), failure = new Error("audit transaction unavailable");
    vi.mocked(recordSupplierReturnDifferenceReview).mockRejectedValue(failure);
    await expect(h.commands.review(entitlementId, returnCreditReviewRequest(), descriptor())).rejects.toBe(failure);
    expect(h.repository.markRetryable).toHaveBeenCalledOnce(); expect(h.repository.rejectClaim).not.toHaveBeenCalled();
  });
});
