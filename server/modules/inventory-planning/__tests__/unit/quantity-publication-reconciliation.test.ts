import { describe, expect, it, vi } from "vitest";
import { publicationReconciliationRequestSchema } from "@shared/types/inventory-publication-reconciliation";
import { reviewPublicationReconciliation } from "../../domain/quantity-publication-reconciliation";
import { QuantityPublicationReconciliationService, type PublicationReconciliationCommand } from "../../application/quantity-publication-reconciliation.service";
import { reconciliationEvidence, reconciliationNow, reconciliationRequest, reconciliationResult, reconciliationReview } from "../fixtures/quantity-publication-reconciliation.fixture";

describe("explicit current-state reconciliation evidence", () => {
  it("requires exact reviewed identity and explicit acceptance, with no caller-supplied account, actor or quantity", () => {
    expect(publicationReconciliationRequestSchema.parse(reconciliationRequest())).toEqual(reconciliationRequest());
    for (const change of [{ activationRunId: "bad" }, { activationRunId: "0" }, { activationRunId: "9223372036854775808" },
      { expectedReviewHash: "bad" }, { acceptUnknownRemoteOutcomes: false }, { actor: "other" }, { force: true },
      { quantity: 5 }, { connectionId: 7 }, { reason: "short" }, { idempotencyKey: "" }]) {
      expect(publicationReconciliationRequestSchema.safeParse({ ...reconciliationRequest(), ...change }).success).toBe(false);
    }
  });
  it("hashes stable complete evidence, without using the observation time as authority", () => {
    const input = reconciliationEvidence(); const before = structuredClone(input);
    const a = reviewPublicationReconciliation(input, reconciliationNow);
    const b = reviewPublicationReconciliation(input, new Date(reconciliationNow.getTime() + 1000));
    expect(a.reviewHash).toBe(b.reviewHash); expect(input).toEqual(before);
    expect(a).toMatchObject({ ready: true, historicalOutcome: "unknown", providerWriteAttempted: false,
      requiredNextStep: "publish_and_verify_current_quantities" });
    input.attempts[0].evidenceHash = "c".repeat(64);
    expect(reviewPublicationReconciliation(input, reconciliationNow).reviewHash).not.toBe(a.reviewHash);
    input.publicationManifestHash = "d".repeat(64);
    expect(reviewPublicationReconciliation(input, reconciliationNow).reviewHash).not.toBe(a.reviewHash);
  });
  it("sorts bigint identities numerically without losing precision", () => {
    const input = reconciliationEvidence();
    input.attempts = ["9223372036854775807", "12", "2"].map(id => ({ ...input.attempts[0], id }));
    expect(reviewPublicationReconciliation(input, reconciliationNow).attempts.map(row => row.attemptId))
      .toEqual(["2", "12", "9223372036854775807"]);
  });
  it.each(["channel_connection", "dropship_store_connection"] as const)("supports exact eBay account ownership through %s", destinationKind => {
    const input = reconciliationEvidence();
    const destination = { ...input.destinations[0], destinationKind, providerKey: "ebay" as const, providerScopeType: "account" as const };
    input.destinations = [destination];
    const scope = { ...(input.attempts[0].scope as object), destinationKind, providerKey: "ebay", providerScopeType: "account" };
    input.attempts[0].scope = scope;
    input.attempts[0].affectedScopes = [scope, { ...scope, externalInventoryItemId: "second-member" }];
    expect(reviewPublicationReconciliation(input, reconciliationNow)).toMatchObject({ ready: true, destinations: [destination],
      attempts: [{ attemptId: "12", publicationTargetIds: [1] }] });
  });
  it("reviews the complete bulk set rather than requiring one command per old request", () => {
    const input = reconciliationEvidence();
    input.attempts = Array.from({ length: 50 }, (_, index) => ({ ...input.attempts[0], id: String(index + 1), state: index % 2 ? "running" : "uncertain" }));
    expect(reviewPublicationReconciliation(input, reconciliationNow).attempts).toHaveLength(50);
    input.attempts = Array.from({ length: 1001 }, (_, index) => ({ ...input.attempts[0], id: String(index + 1) }));
    expect(() => reviewPublicationReconciliation(input, reconciliationNow)).toThrow(expect.objectContaining({ code: "PUBLICATION_RECONCILIATION_EVIDENCE_INVALID" }));
  });
  it.each(["outbox", "listing_setup_zero"])("does not supersede %s owners", owner => {
    const input = reconciliationEvidence(); input.attempts[0].owner = owner;
    expect(() => reviewPublicationReconciliation(input, reconciliationNow)).toThrow(expect.objectContaining({ code: "PUBLICATION_RECONCILIATION_ATTEMPT_NOT_LEGACY" }));
  });
  it.each(["3", "4"])("rejects current or future epoch %s", epoch => {
    const input = reconciliationEvidence(); input.attempts[0].gateEpoch = epoch;
    expect(() => reviewPublicationReconciliation(input, reconciliationNow)).toThrow(expect.objectContaining({ code: "PUBLICATION_RECONCILIATION_ATTEMPT_NOT_LEGACY" }));
  });
  it("leaves other stores, locations and providers alone", () => {
    for (const change of [{ connectionId: 8 }, { externalScopeId: "canada" }, { providerKey: "ebay" }]) {
      const input = reconciliationEvidence();
      const other = { ...(input.attempts[0].scope as object), ...change };
      input.attempts[0].scope = other; input.attempts[0].affectedScopes = [other];
      expect(reviewPublicationReconciliation(input, reconciliationNow)).toMatchObject({ ready: false, attempts: [] });
    }
  });
  it("refuses partially selected grouped writes and ambiguous destination ownership", () => {
    const input = reconciliationEvidence();
    input.attempts[0].affectedScopes = [input.attempts[0].scope, { ...(input.attempts[0].scope as object), connectionId: 8 }];
    expect(() => reviewPublicationReconciliation(input, reconciliationNow)).toThrow(expect.objectContaining({ code: "PUBLICATION_RECONCILIATION_SCOPE_INCOMPLETE" }));
    const duplicate = reconciliationEvidence(); duplicate.destinations.push({ ...duplicate.destinations[0] });
    expect(() => reviewPublicationReconciliation(duplicate, reconciliationNow)).toThrow(expect.objectContaining({ code: "PUBLICATION_RECONCILIATION_DESTINATION_AMBIGUOUS" }));
  });
  it("rejects duplicate attempts, malformed epochs and incomplete scope evidence", () => {
    const duplicate = reconciliationEvidence(); duplicate.attempts.push({ ...duplicate.attempts[0] });
    expect(() => reviewPublicationReconciliation(duplicate, reconciliationNow)).toThrow(expect.objectContaining({ code: "PUBLICATION_RECONCILIATION_ATTEMPT_DUPLICATE" }));
    for (const change of [{ gateEpoch: "x" }, { id: "x" }, { affectedScopes: [] }, { scope: {} }]) {
      const input = reconciliationEvidence(); Object.assign(input.attempts[0], change);
      expect(() => reviewPublicationReconciliation(input, reconciliationNow)).toThrow();
    }
  });
});

describe("reconciliation service boundary", () => {
  const setup = () => {
    const store = { review: vi.fn(async (_runId: string, _now: Date) => reconciliationReview()),
      reconcile: vi.fn(async (_command: PublicationReconciliationCommand) => reconciliationResult()) };
    return { store, service: new QuantityPublicationReconciliationService(store, { now: () => reconciliationNow }) };
  };
  it("passes a deterministic actor-bound command and reuses its identity across time", async () => {
    const { store, service } = setup();
    await service.review({ activationRunId: "8" }, "operator");
    expect(store.review).toHaveBeenCalledWith("8", reconciliationNow);
    await service.reconcile(reconciliationRequest(), "operator");
    const next = new QuantityPublicationReconciliationService(store, { now: () => new Date(reconciliationNow.getTime() + 1) });
    await next.reconcile(reconciliationRequest(), "operator");
    expect(store.reconcile.mock.calls[0]?.[0].requestHash).toBe(store.reconcile.mock.calls[1]?.[0].requestHash);
    expect(store.reconcile.mock.calls[0]?.[0]).toMatchObject({ ...reconciliationRequest(), actor: "operator", occurredAt: reconciliationNow });
  });
  it("rejects unauthenticated callers and invalid clocks before persistence", async () => {
    const { store, service } = setup();
    await expect(service.reconcile(reconciliationRequest(), undefined)).rejects.toMatchObject({ status: 401 });
    const invalid = new QuantityPublicationReconciliationService(store, { now: () => new Date(NaN) });
    await expect(invalid.reconcile(reconciliationRequest(), "operator")).rejects.toMatchObject({ code: "PUBLICATION_RECONCILIATION_CLOCK_INVALID" });
    expect(store.reconcile).not.toHaveBeenCalled();
  });
  it("rejects mismatched store output", async () => {
    const { store, service } = setup();
    store.reconcile.mockResolvedValueOnce({ ...reconciliationResult(), activationRunId: "9" });
    await expect(service.reconcile(reconciliationRequest(), "operator")).rejects.toMatchObject({ code: "PUBLICATION_RECONCILIATION_RESULT_INVALID" });
  });
});
