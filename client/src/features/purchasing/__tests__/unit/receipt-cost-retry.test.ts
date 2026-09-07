import { describe, expect, it, vi } from "vitest";
import { FinancialCommandRequestError } from "@/lib/financial-command";
import { createReceiptCostRetryClient } from "../../receipt-cost-retry";

const outcome = { state: "retry_required", requests: [] };
describe("receipt cost retry intent", () => {
  it("retains the same key after an uncertain response and rotates after a completed outcome", async () => {
    const ambiguous = new FinancialCommandRequestError("transport failed", { status: null, retryable: true, ambiguous: true });
    const request = vi.fn().mockRejectedValueOnce(ambiguous).mockResolvedValue(outcome);
    const generateKey = vi.fn().mockReturnValueOnce("key-one").mockReturnValueOnce("key-two");
    const retry = createReceiptCostRetryClient({ request, generateKey });
    await expect(retry(31)).rejects.toBe(ambiguous);
    expect(await retry(31)).toEqual(outcome);
    expect(await retry(31)).toEqual(outcome);
    expect(request.mock.calls.map((call) => call[1].headers["Idempotency-Key"])).toEqual(["key-one", "key-one", "key-two"]);
    expect(request.mock.calls[0]).toEqual(["/api/receiving/31/retry-costs", expect.objectContaining({ method: "POST", credentials: "include", body: "{}" })]);
  });
  it("treats a malformed success payload as ambiguous and preserves the retry key", async () => {
    const request = vi.fn().mockResolvedValueOnce({ status: "success" }).mockResolvedValue(outcome);
    const generateKey = vi.fn(() => "retained-key");
    const retry = createReceiptCostRetryClient({ request, generateKey });
    await expect(retry(31)).rejects.toMatchObject({ code: "RECEIPT_COST_RESPONSE_INVALID", ambiguous: true });
    await retry(31); expect(generateKey).toHaveBeenCalledTimes(1);
  });
  it.each([
    { state: "applied", requests: [] },
    { state: "applied", requests: [{ requestId: 1, purchaseOrderLineId: 171, state: "retry_required", issues: [], attemptRecorded: true }] },
    { state: "applied", requests: [{ requestId: 1, purchaseOrderLineId: 171, state: "applied", issues: [], attemptRecorded: false }] },
  ])("does not confirm a conflicting success outcome", async (response) => {
    const request = vi.fn().mockResolvedValueOnce(response).mockResolvedValue(outcome);
    const generateKey = vi.fn(() => "retained-key");
    const retry = createReceiptCostRetryClient({ request, generateKey });
    await expect(retry(31)).rejects.toMatchObject({ code: "RECEIPT_COST_RESPONSE_INVALID", ambiguous: true });
    await retry(31); expect(generateKey).toHaveBeenCalledTimes(1);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid receipt %s before sending a command", async (receiptId) => {
    const request = vi.fn();
    await expect(createReceiptCostRetryClient({ request, generateKey: () => "unused" })(receiptId)).rejects.toThrow("receipt reference");
    expect(request).not.toHaveBeenCalled();
  });
});
