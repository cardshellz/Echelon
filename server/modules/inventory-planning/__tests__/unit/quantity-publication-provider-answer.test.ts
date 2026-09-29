import { describe, expect, it } from "vitest";
import { summarizeProviderAnswer, type StoredProviderRequestReceipt } from "../../domain/quantity-publication-provider-answer";

const AT = new Date("2026-09-29T09:30:00.000Z");
function receipt(patch: Partial<StoredProviderRequestReceipt> = {}): StoredProviderRequestReceipt {
  return { attemptId: "482", requestId: "9001", ordinal: 1, method: "PUT", path: "/sell/inventory/v1/inventory_item/ARM-ENV-SGL-P50",
    outcome: "completed", httpStatus: 204, responseHash: "a".repeat(64), errorCodes: [], recordedAt: AT, ...patch };
}
const refusal = receipt({ requestId: "9002", ordinal: 2, method: "POST", path: "/sell/inventory/v1/offer/77/publish",
  outcome: "uncertain", httpStatus: 400, responseHash: "b".repeat(64), errorCodes: ["25002"] });

describe("summarizeProviderAnswer", () => {
  it("offers the last 4xx answer when every request of an uncertain attempt was answered", () => {
    expect(summarizeProviderAnswer("uncertain", [refusal, receipt()])).toEqual({
      requestId: "9002", method: "POST", path: "/sell/inventory/v1/offer/77/publish", httpStatus: 400,
      errorCodes: ["25002"], responseHash: "b".repeat(64), recordedAt: "2026-09-29T09:30:00.000Z",
    });
  });

  it("offers nothing for a running attempt, an empty history, or an unanswered request", () => {
    expect(summarizeProviderAnswer("running", [receipt(), refusal])).toBeNull();
    expect(summarizeProviderAnswer("uncertain", [])).toBeNull();
    expect(summarizeProviderAnswer("uncertain", [receipt(), { ...refusal, outcome: null, httpStatus: null, responseHash: null, recordedAt: null }])).toBeNull();
    expect(summarizeProviderAnswer("uncertain", [receipt(), { ...refusal, responseHash: null }])).toBeNull();
  });

  it("offers nothing when the last answer proves no refusal: a 5xx, a completed write, or no provider codes", () => {
    expect(summarizeProviderAnswer("uncertain", [receipt(), { ...refusal, httpStatus: 503 }])).toBeNull();
    expect(summarizeProviderAnswer("uncertain", [receipt(), { ...refusal, outcome: "completed", httpStatus: 200 }])).toBeNull();
    expect(summarizeProviderAnswer("uncertain", [receipt(), { ...refusal, errorCodes: [] }])).toBeNull();
  });

  it("offers nothing when an earlier request of the attempt was itself uncertain", () => {
    expect(summarizeProviderAnswer("uncertain", [receipt({ outcome: "uncertain", httpStatus: 502 }), refusal])).toBeNull();
  });

  it("does not hand back the caller's array", () => {
    const answer = summarizeProviderAnswer("uncertain", [receipt(), refusal])!;
    expect(answer.errorCodes).not.toBe(refusal.errorCodes);
  });
});
