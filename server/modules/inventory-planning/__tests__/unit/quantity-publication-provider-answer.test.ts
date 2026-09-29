import { describe, expect, it } from "vitest";
import { REQUEST_QUIESCENCE_MARGIN_MS, summarizeProviderAnswer, summarizeRequestTermination,
  type StoredProviderRequestReceipt } from "../../domain/quantity-publication-provider-answer";

const AT = new Date("2026-09-29T09:30:00.000Z");
const STARTED = new Date("2026-09-29T09:29:50.000Z");
function receipt(patch: Partial<StoredProviderRequestReceipt> = {}): StoredProviderRequestReceipt {
  return { attemptId: "482", requestId: "9001", ordinal: 1, method: "PUT", path: "/sell/inventory/v1/inventory_item/ARM-ENV-SGL-P50",
    startedAt: STARTED, outcome: "completed", httpStatus: 204, responseHash: "a".repeat(64), errorCodes: [], recordedAt: AT, ...patch };
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

describe("summarizeRequestTermination", () => {
  const TIMEOUT_MS = 30_000;
  const attemptStart = new Date("2026-09-29T09:29:00.000Z");
  const serverError = receipt({ requestId: "9002", ordinal: 2, method: "POST", path: "/sell/inventory/v1/offer/77/publish",
    outcome: "uncertain", httpStatus: 500, responseHash: "c".repeat(64), errorCodes: ["25001"] });
  function summarize(now: string, patch: Partial<Parameters<typeof summarizeRequestTermination>[0]> = {}) {
    return summarizeRequestTermination({ attemptId: "482", state: "uncertain", startedAt: attemptStart, receipts: [serverError, receipt()],
      now: new Date(now), providerRequestTimeoutMs: TIMEOUT_MS, ...patch });
  }

  it("proves termination once the deadline and the margin have passed since the last stored activity", () => {
    // Last activity is the answer recorded at 09:30:00; quiescent from 09:30:30 plus the 60-minute margin.
    const result = summarize("2026-09-29T10:30:30.000Z");
    expect(result).toMatchObject({ requestCount: 2, lastActivityAt: "2026-09-29T09:30:00.000Z", quiescentSince: "2026-09-29T10:30:30.000Z",
      providerRequestTimeoutSeconds: 30, quiescenceMarginMinutes: 60 });
    expect(result?.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(REQUEST_QUIESCENCE_MARGIN_MS).toBe(60 * 60 * 1000);
  });

  it("proves nothing while the last activity is still within the deadline plus the margin", () => {
    expect(summarize("2026-09-29T10:30:29.999Z")).toBeNull();
    expect(summarize("2026-09-29T09:30:00.000Z")).toBeNull();
  });

  it("counts an unanswered request's start and the attempt's own start as activity", () => {
    const unanswered = { ...serverError, outcome: null, httpStatus: null, responseHash: null, recordedAt: null, startedAt: new Date("2026-09-29T09:45:00.000Z") };
    expect(summarize("2026-09-29T10:45:29.000Z", { receipts: [receipt(), unanswered] })).toBeNull();
    expect(summarize("2026-09-29T10:45:30.000Z", { receipts: [receipt(), unanswered] })).toMatchObject({ lastActivityAt: "2026-09-29T09:45:00.000Z" });
    expect(summarize("2026-09-29T10:29:00.000Z", { receipts: [] })).toBeNull();
    expect(summarize("2026-09-29T10:29:30.000Z", { receipts: [] })).toMatchObject({ requestCount: 0, lastActivityAt: "2026-09-29T09:29:00.000Z" });
  });

  it("covers running attempts too, since a resolved attempt can no longer record a request", () => {
    expect(summarize("2026-09-29T11:00:00.000Z", { state: "running" })).toMatchObject({ requestCount: 2 });
  });

  it("pins the exact stored record: any change to state or receipts changes the hash", () => {
    const base = summarize("2026-09-29T11:00:00.000Z")!;
    expect(summarize("2026-09-29T11:00:00.000Z")!.evidenceHash).toBe(base.evidenceHash);
    expect(summarize("2026-09-29T11:00:00.000Z", { state: "running" })!.evidenceHash).not.toBe(base.evidenceHash);
    expect(summarize("2026-09-29T11:00:00.000Z", { receipts: [receipt(), { ...serverError, responseHash: "d".repeat(64) }] })!.evidenceHash).not.toBe(base.evidenceHash);
  });

  it("proves nothing on invalid clocks or limits", () => {
    expect(summarize("invalid")).toBeNull();
    expect(summarize("2026-09-29T11:00:00.000Z", { providerRequestTimeoutMs: 0 })).toBeNull();
    expect(summarize("2026-09-29T11:00:00.000Z", { quiescenceMarginMs: -1 })).toBeNull();
    expect(summarize("2026-09-29T11:00:00.000Z", { startedAt: new Date("invalid") })).toBeNull();
  });
});
