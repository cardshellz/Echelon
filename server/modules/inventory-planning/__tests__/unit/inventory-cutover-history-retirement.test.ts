import { describe, expect, it, vi } from "vitest";
import type { HistoryRetirementResult, RetireHistoryRequest } from "@shared/types/inventory-cutover-history";
import type { OpeningSource } from "@shared/types/inventory-cutover-opening";
import { InventoryCutoverHistoryService, type RetireHistoryCommand } from "../../application/inventory-cutover-history.service";
import { activeCutoverHistory, assertHistoryRetirementApproved, reviewHistoricalWork } from "../../domain/inventory-cutover-history-retirement";
import { historyFixture } from "../fixtures/inventory-cutover-history.fixture";
import { reconstructionHash } from "../../domain/inventory-cutover-reconstruction";

function reviewFixture() {
  const { source, facts } = historyFixture();
  const review = reviewHistoricalWork(source, facts);
  const request: RetireHistoryRequest = { expectedReviewHash: review.reviewHash, expectedAuthorityRevision: "1",
    expectedConfigurationRunId: null, acceptUnresolvedOrigin: false, reason: "Retire exact reviewed history", idempotencyKey: "history-test" };
  return { source, facts, review, request };
}

describe("historical retirement review and application boundary", () => {
  it("keeps review identity stable across capture time without ignoring changed facts", () => {
    const { source, facts, review } = reviewFixture();
    source.capturedAt = facts.capturedAt = "2026-09-28T00:00:00.000Z";
    expect(reviewHistoricalWork(source, facts)).toEqual(review);
    facts.receipts[0].attemptsHash = "b".repeat(64);
    expect(reviewHistoricalWork(source, facts).reviewHash).not.toBe(review.reviewHash);
  });

  it("binds approval to evidence, authority and configuration without authorizing activation", () => {
    const { review, request } = reviewFixture();
    expect(review.activatesInventory).toBe(false);
    expect(review.preservedCurrentOrderItemIds).toEqual([11]);
    expect(() => assertHistoryRetirementApproved(review, request)).not.toThrow();
    for (const changed of [{ expectedReviewHash: "b".repeat(64) }, { expectedAuthorityRevision: "2" }, { expectedConfigurationRunId: "2" }]) {
      expect(() => assertHistoryRetirementApproved(review, { ...request, ...changed })).toThrow("Evidence changed after review");
    }
  });

  it("requires specific acceptance of unknown origin without inventing a channel", () => {
    const { source, facts, request } = reviewFixture();
    Object.assign(facts.receipts[0], { sourceChannelId: null, linkedOrderId: null, matchedOrders: [] });
    const review = reviewHistoricalWork(source, facts);
    const command = { ...request, expectedReviewHash: review.reviewHash };
    expect(review.unresolvedReceiptIds).toEqual(["20"]);
    expect(() => assertHistoryRetirementApproved(review, command)).toThrow("requires explicit quarantine acceptance");
    expect(() => assertHistoryRetirementApproved(review, { ...command, acceptUnresolvedOrigin: true })).not.toThrow();
    expect(facts.receipts[0].sourceChannelId).toBeNull();
  });

  it("rejects a blocked batch even if its hash was accepted", () => {
    const { source, facts, request } = reviewFixture();
    facts.shipments[0].openPickCorrections = 1;
    const review = reviewHistoricalWork(source, facts);
    expect(review.readyForRetirement).toBe(false);
    expect(() => assertHistoryRetirementApproved(review, { ...request, expectedReviewHash: review.reviewHash })).toThrow("blocks historical retirement");
  });

  function withSavedOpening(source: OpeningSource, evidenceHash: string): void {
    source.latestVerification = { id: "36", sourceEvidenceHash: evidenceHash, verificationHash: "c".repeat(64),
      authorityRevision: source.authorityRevision, historicalExceptionHash: "d".repeat(64), historicalExceptionCount: 0,
      verifiedAt: source.capturedAt, actor: "operator", reason: "Previous immutable opening", alreadyApplied: false,
      stockChanged: false, authorityChanged: false };
  }

  it("permits reviewed cleanup after a stale opening without mutating that opening or business evidence", () => {
    const { source, facts, request } = reviewFixture();
    withSavedOpening(source, "e".repeat(64));
    const before = structuredClone({ source, facts });
    const review = reviewHistoricalWork(source, facts);
    expect(review.readyForRetirement).toBe(true);
    expect(review.decisions.map(row => `${row.kind}:${row.id}`)).toEqual(["receipt:20", "shipment:90"]);
    expect(() => assertHistoryRetirementApproved(review, { ...request, expectedReviewHash: review.reviewHash })).not.toThrow();
    expect({ source, facts }).toEqual(before);
    expect(review.activatesInventory).toBe(false);
  });

  it.each(["current-opening", "frozen", "authority-revision", "canonical"])(
    "does not allow stale-opening recovery to bypass %s", change => {
      const { source, facts, request } = reviewFixture();
      withSavedOpening(source, "e".repeat(64));
      if (change === "current-opening") source.latestVerification!.sourceEvidenceHash = source.evidenceHash;
      if (change === "frozen") source.configurationRunId = "42";
      if (change === "authority-revision") source.latestVerification!.authorityRevision = "2";
      if (change === "canonical") source.runtimeAuthority = "canonical";
      const review = reviewHistoricalWork(source, facts);
      expect(review.blockers).toContainEqual({ code: "HISTORY_OPENING_ALREADY_SAVED", subject: "opening" });
      expect(review.readyForRetirement).toBe(false);
      expect(() => assertHistoryRetirementApproved(review, { ...request, expectedReviewHash: review.reviewHash }))
        .toThrow("blocks historical retirement");
    },
  );

  it("projects only retired processing and preserves original inventory, orders, costs and packages", () => {
    const { source, review } = reviewFixture();
    const evidence = { ...source.evidence, retiredHistory: review.decisions.map(row => ({ ...row,
      batchId: "1", reviewHash: review.reviewHash, sourceItemsHash: reconstructionHash(row.kind === "receipt" ? [] : source.evidence.sourceItems) })) };
    const before = structuredClone(evidence);
    const projected = activeCutoverHistory(evidence);
    expect(projected.sourceItems).toEqual([]);
    expect(projected.shipmentReviewEvidence).toEqual([]);
    for (const key of ["items", "orders", "physicalItems", "levels", "lots", "costs", "journals"] as const) {
      expect(projected[key]).toEqual(evidence[key]);
    }
    expect(evidence).toEqual(before);
    expect(activeCutoverHistory(source.evidence)).toEqual(source.evidence);
  });

  it("fails closed on duplicate or altered retirement membership", () => {
    const { source, review } = reviewFixture();
    const row = { ...review.decisions[1], batchId: "1", reviewHash: review.reviewHash, sourceItemsHash: reconstructionHash(source.evidence.sourceItems) };
    expect(() => activeCutoverHistory({ ...source.evidence, retiredHistory: [row, row] })).toThrow("Duplicate retired-work");
    expect(() => activeCutoverHistory({ ...source.evidence, retiredHistory: [{ ...row, sourceItemIds: [] }] })).toThrow("membership differs");
  });

  function serviceFixture() {
    const { review, request } = reviewFixture();
    const result: HistoryRetirementResult = { batchId: "1", reviewHash: review.reviewHash, retiredReceipts: 1,
      retiredShipments: 1, quarantinedReceipts: 0, actor: "operator", reason: request.reason,
      occurredAt: "2026-09-27T13:00:00.000Z", alreadyApplied: false, inventoryChanged: false, authorityChanged: false };
    const store = { review: vi.fn(async () => review), retire: vi.fn(async (_command: RetireHistoryCommand) => result) };
    return { store, request, result, service: new InventoryCutoverHistoryService(store) };
  }

  it("derives the actor from authentication and includes complete intent in idempotency", async () => {
    const { store, service, request } = serviceFixture();
    await service.review("operator");
    expect(store.retire).not.toHaveBeenCalled();
    await service.retire(request, " operator ");
    await service.retire(request, "operator");
    const hash = store.retire.mock.calls[0][0].requestHash;
    expect(store.retire.mock.calls[1][0].requestHash).toBe(hash);
    expect(store.retire.mock.calls[0][0].actor).toBe("operator");
    await service.retire(request, "different-operator");
    await service.retire({ ...request, acceptUnresolvedOrigin: true }, "operator");
    await service.retire({ ...request, reason: "Different approval" }, "operator");
    expect(store.retire.mock.calls.slice(2).every(([command]) => command.requestHash !== hash)).toBe(true);
  });

  it.each([undefined, null, 1, "", " ", "x".repeat(101)])("rejects unauthenticated actor %#", async actor => {
    const { store, request, service } = serviceFixture();
    await expect(service.review(actor)).rejects.toMatchObject({ code: "HISTORY_ACTOR_REQUIRED", status: 401 });
    await expect(service.retire(request, actor)).rejects.toMatchObject({ status: 401 });
    expect(store.review).not.toHaveBeenCalled();
    expect(store.retire).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { actor: "spoof" }, { reason: "" }, { idempotencyKey: "" },
    { expectedAuthorityRevision: "9223372036854775808" }, { acceptUnresolvedOrigin: "yes" }])("rejects malformed or widened commands %#", async change => {
    const { service, store, request } = serviceFixture();
    const input = change === undefined || Object.keys(change).length === 0 ? change : { ...request, ...change };
    await expect(service.retire(input, "operator")).rejects.toMatchObject({ code: "HISTORY_REQUEST_INVALID", status: 400 });
    expect(store.retire).not.toHaveBeenCalled();
  });

  it("propagates owner failure and validates returned receipts instead of inventing success", async () => {
    const { store, service, request } = serviceFixture();
    const error = new Error("database transaction failed");
    store.retire.mockRejectedValueOnce(error);
    await expect(service.retire(request, "operator")).rejects.toBe(error);
    store.retire.mockResolvedValueOnce({} as HistoryRetirementResult);
    await expect(service.retire(request, "operator")).rejects.toThrow();
  });
});
