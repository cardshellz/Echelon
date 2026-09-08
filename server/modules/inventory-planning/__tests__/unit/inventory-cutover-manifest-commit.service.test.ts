import { describe, expect, it, vi } from "vitest";
import type { InventoryCutoverCommitResult, InventoryCutoverReview } from "@shared/types/inventory-cutover-commit";
import { InventoryCutoverCommitService, type InventoryCutoverCommitCommand } from "../../application/inventory-cutover-commit.service";

const HASH = "a".repeat(64);
const NOW = new Date("2026-09-07T20:00:00.000Z");
const REQUEST = { activationRunId: "1", expectedAuthorityRevision: "2", expectedReviewHash: HASH,
  idempotencyKey: "cutover-1", reason: "Commit the reviewed full catalog" };

function result(): InventoryCutoverCommitResult {
  return { activationRunId: "1", runtimeAuthority: "canonical", authorityRevision: "3", reviewHash: HASH,
    selectionManifestHash: HASH, reconstructionHash: HASH, fullPublicationRows: 1, publicationVerification: "pending", alreadyApplied: false };
}
function review(): InventoryCutoverReview {
  return { contractVersion: "inventory_cutover_review_v1", activationRunId: "1", authorityRevision: "2", capturedAt: NOW.toISOString(),
    reviewHash: HASH, selectionManifestHash: HASH, reconstructionHash: HASH, freshClaimImpactHash: HASH, ready: true,
    manifest: { contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [1], publicationTargetIds: [2],
      selections: [{ kind: "model", key: "1", definitionId: 10, definitionHash: HASH }] },
    summary: { orders: 1, lines: 1, retainedIndependentBuildHolds: 0 },
    publicationRows: [{ publicationTargetId: 2, productVariantId: 3, desiredQuantity: "4" }], blockers: [],
    operationalWriteAttempted: false, providerWriteAttempted: false };
}
function fixture(now: () => Date = () => NOW) {
  const store = { preview: vi.fn(async (_id: string, _now: Date) => review()),
    commit: vi.fn(async (_command: InventoryCutoverCommitCommand) => result()) };
  return { store, service: new InventoryCutoverCommitService(store, { now }) };
}

describe("cutover manifest commit service boundary", () => {
  it("previews without submitting a commit or provider write", async () => {
    const { store, service } = fixture();
    await expect(service.preview({ activationRunId: "1" }, " operator-1 ")).resolves.toEqual(review());
    expect(store.preview).toHaveBeenCalledWith("1", NOW);
    expect(store.commit).not.toHaveBeenCalled();
  });

  it("passes actor, reviewed revision/hash and injected time to a single owner command", async () => {
    const { store, service } = fixture();
    await expect(service.commit(REQUEST, " operator-1 ")).resolves.toEqual(result());
    expect(store.commit).toHaveBeenCalledExactlyOnceWith({ ...REQUEST, actor: "operator-1", occurredAt: NOW,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(store.preview).not.toHaveBeenCalled();
  });

  it("keeps retry identity independent of retry time but sensitive to actor and reviewed intent", async () => {
    let now = NOW;
    const { store, service } = fixture(() => now);
    await service.commit(REQUEST, "operator-1");
    now = new Date("2026-09-07T20:01:00.000Z");
    await service.commit(REQUEST, "operator-1");
    expect(store.commit.mock.calls[0][0].requestHash).toBe(store.commit.mock.calls[1][0].requestHash);
    expect(store.commit.mock.calls[0][0].occurredAt).not.toEqual(store.commit.mock.calls[1][0].occurredAt);
    await service.commit(REQUEST, "operator-2");
    await service.commit({ ...REQUEST, expectedReviewHash: "b".repeat(64) }, "operator-1");
    expect(store.commit.mock.calls[2][0].requestHash).not.toBe(store.commit.mock.calls[0][0].requestHash);
    expect(store.commit.mock.calls[3][0].requestHash).not.toBe(store.commit.mock.calls[0][0].requestHash);
  });

  it.each(["", "abc", "1.5", "0", "01", "-1", "9223372036854775808", 1, null])(
    "classifies malformed run ID %j before store access", async (activationRunId) => {
      const { store, service } = fixture();
      await expect(service.preview({ activationRunId }, "operator-1")).rejects.toMatchObject({ code: "CUTOVER_REVIEW_REQUEST_INVALID", status: 400 });
      await expect(service.commit({ ...REQUEST, activationRunId }, "operator-1")).rejects.toMatchObject({ code: "CUTOVER_COMMIT_REQUEST_INVALID", status: 400 });
      expect(store.preview).not.toHaveBeenCalled();
      expect(store.commit).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, 1, "", " ", "x".repeat(101)])("requires an actor for both commands: %#", async (actor) => {
    const { store, service } = fixture();
    await expect(service.preview({ activationRunId: "1" }, actor)).rejects.toMatchObject({ code: "CUTOVER_ACTOR_REQUIRED", status: 401 });
    await expect(service.commit(REQUEST, actor)).rejects.toMatchObject({ code: "CUTOVER_ACTOR_REQUIRED", status: 401 });
    expect(store.preview).not.toHaveBeenCalled();
    expect(store.commit).not.toHaveBeenCalled();
  });

  it.each([{ ...REQUEST, reason: " " }, { ...REQUEST, idempotencyKey: "" }, { ...REQUEST, expectedReviewHash: "abc" },
    { ...REQUEST, expectedAuthorityRevision: "abc" }, { ...REQUEST, unexpected: true },
  ])("rejects malformed reviewed intent: %#", async (request) => {
    const { store, service } = fixture();
    await expect(service.commit(request, "operator-1")).rejects.toMatchObject({ code: "CUTOVER_COMMIT_REQUEST_INVALID", status: 400 });
    expect(store.commit).not.toHaveBeenCalled();
  });

  it("fails a malformed clock before sending a mutation command", async () => {
    const { store, service } = fixture(() => new Date("invalid"));
    await expect(service.commit(REQUEST, "operator-1")).rejects.toMatchObject({ code: "CUTOVER_CLOCK_INVALID", status: 500 });
    expect(store.commit).not.toHaveBeenCalled();
  });

  it("propagates owner failures without rewriting them as successful replay", async () => {
    const { store, service } = fixture();
    const failure = Object.assign(new Error("review changed"), { code: "CUTOVER_REVIEW_CHANGED" });
    store.commit.mockRejectedValueOnce(failure);
    await expect(service.commit(REQUEST, "operator-1")).rejects.toBe(failure);
    expect(store.commit).toHaveBeenCalledTimes(1);
  });

  it("does not accept a malformed result or a review inconsistent with its blockers", async () => {
    const { store, service } = fixture();
    store.commit.mockResolvedValueOnce({ ...result(), runtimeAuthority: "legacy" } as never);
    await expect(service.commit(REQUEST, "operator-1")).rejects.toMatchObject({ name: "ZodError" });
    store.preview.mockResolvedValueOnce({ ...review(), blockers: [{ code: "BLOCKED", subject: "catalog", message: "Pending" }] });
    await expect(service.preview({ activationRunId: "1" }, "operator-1")).rejects.toMatchObject({ name: "ZodError" });
  });
});
