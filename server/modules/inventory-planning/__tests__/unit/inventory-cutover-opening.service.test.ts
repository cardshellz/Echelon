import { describe, expect, it, vi } from "vitest";
import type { OpeningAssessment, OpeningSaved, OpeningSource, OpeningVerification } from "@shared/types/inventory-cutover-opening";
import { InventoryCutoverOpeningService, type OpeningSaveCommand } from "../../application/inventory-cutover-opening.service";
import { reconstructionEvidence } from "../fixtures/inventory-cutover-reconstruction.fixture";

const HASH = "a".repeat(64);
const NOW = new Date("2026-09-09T16:00:00.000Z");
function verification(): OpeningVerification {
  const evidence = reconstructionEvidence();
  return { contractVersion: "inventory_cutover_opening_v1", expectedEvidenceHash: HASH, expectedAuthorityRevision: "1",
    expectedConfigurationRunId: null, verificationReference: "Physical count and open-order review 2026-09-09",
    verificationEvidenceHash: HASH, verifiedAt: "2026-09-09T15:00:00Z", historicalDisposition: "preserve_unresolved",
    levels: evidence.levels, lots: evidence.lots, owners: [{ orderId: 1, orderItemId: 11, remainingQty: "6",
      reservedQty: "3", pickedQty: "2", allocations: [{ inventoryLevelId: 10, lots: [{ inventoryLotId: 4,
        reservedQty: "3", pickedQty: "2", originalCostIds: [9] }] }] }] };
}
function saved(): OpeningSaved { return { id: "1", sourceEvidenceHash: HASH, verificationHash: HASH, authorityRevision: "1",
  historicalExceptionHash: HASH, historicalExceptionCount: 0, verifiedAt: verification().verifiedAt, actor: "operator",
  reason: "Reviewed all current facts", alreadyApplied: false, stockChanged: false, authorityChanged: false }; }
function assessment(): OpeningAssessment { return { sourceEvidenceHash: HASH, verificationHash: HASH, ready: true,
  blockers: [], historicalExceptions: [], historicalExceptionHash: HASH,
  plan: { evidenceHash: HASH, ready: true, blockers: [], orders: [], retainedIndependentBuildReservationIds: [], legacyPromiseReleases: [] } }; }
function source(): OpeningSource { return { contractVersion: "inventory_cutover_opening_source_v1", capturedAt: NOW.toISOString(),
  runtimeAuthority: "legacy", authorityRevision: "1", configurationRunId: null, evidenceHash: HASH,
  evidence: reconstructionEvidence(), labels: [], latestVerification: null }; }
function fixture(clock: { now(): Date } = { now: () => NOW }) {
  const store = { capture: vi.fn(async (_now: Date) => source()),
    preview: vi.fn(async (_verification: OpeningVerification, _now: Date) => assessment()),
    save: vi.fn(async (_command: OpeningSaveCommand) => saved()) };
  return { store, service: new InventoryCutoverOpeningService(store, clock) };
}

describe("opening verification application boundary", () => {
  it("captures source and evaluates proposed facts without issuing a save", async () => {
    const { store, service } = fixture();
    await expect(service.capture("operator")).resolves.toEqual(source());
    await expect(service.preview(verification(), "operator")).resolves.toEqual(assessment());
    expect(store.capture).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(store.preview).toHaveBeenCalledExactlyOnceWith(verification(), NOW);
    expect(store.save).not.toHaveBeenCalled();
  });

  it("derives actor from authentication and hashes complete intent but not retry time", async () => {
    let now = NOW;
    const { store, service } = fixture({ now: () => now });
    const request = { verification: verification(), reason: "Reviewed all current facts", idempotencyKey: "opening-1" };
    await expect(service.save(request, " operator ")).resolves.toEqual(saved());
    now = new Date("2026-09-09T17:00:00Z");
    await service.save(request, "operator");
    expect(store.save.mock.calls[0][0]).toMatchObject({ ...request, actor: "operator", occurredAt: NOW });
    expect(store.save.mock.calls[0][0].requestHash).toBe(store.save.mock.calls[1][0].requestHash);
    await service.save(request, "other-operator");
    await service.save({ ...request, reason: "Different explicit reason" }, "operator");
    expect(store.save.mock.calls[2][0].requestHash).not.toBe(store.save.mock.calls[0][0].requestHash);
    expect(store.save.mock.calls[3][0].requestHash).not.toBe(store.save.mock.calls[0][0].requestHash);
  });

  it.each([undefined, null, 2, "", " ", "x".repeat(101)])("requires authenticated operator: %#", async actor => {
    const { store, service } = fixture();
    await expect(service.capture(actor)).rejects.toMatchObject({ code: "CUTOVER_OPENING_ACTOR_REQUIRED", status: 401 });
    await expect(service.preview(verification(), actor)).rejects.toMatchObject({ status: 401 });
    await expect(service.save({ verification: verification(), reason: "Review", idempotencyKey: "key" }, actor)).rejects.toMatchObject({ status: 401 });
    expect(store.capture).not.toHaveBeenCalled(); expect(store.preview).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { ...verification(), actor: "spoof" }, { ...verification(), historicalDisposition: "erase" },
    { ...verification(), expectedAuthorityRevision: "9223372036854775808" },
    { ...verification(), verificationEvidenceHash: "not-a-hash" },
    { ...verification(), owners: [{ ...verification().owners[0], reservedQty: 3 }] },
  ])("rejects incomplete or widened facts before capture: %#", async input => {
    const { store, service } = fixture();
    await expect(service.preview(input, "operator")).rejects.toMatchObject({ code: "CUTOVER_OPENING_REQUEST_INVALID", status: 400 });
    await expect(service.save({ verification: input, reason: "Review", idempotencyKey: "key" }, "operator")).rejects.toMatchObject({ status: 400 });
    expect(store.preview).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
  });

  it.each([{ reason: "", idempotencyKey: "key" }, { reason: "Review", idempotencyKey: "" },
    { reason: "Review", idempotencyKey: "key", actor: "spoof" }])("rejects invalid save metadata: %#", async metadata => {
    const { store, service } = fixture();
    await expect(service.save({ verification: verification(), ...metadata }, "operator")).rejects.toMatchObject({ status: 400 });
    expect(store.save).not.toHaveBeenCalled();
  });

  it("rejects future-dated verification and invalid injected clocks", async () => {
    const { store, service } = fixture();
    const future = { ...verification(), verifiedAt: "2026-09-10T00:00:00Z" };
    await expect(service.preview(future, "operator")).rejects.toMatchObject({ code: "CUTOVER_OPENING_VERIFICATION_TIME_INVALID" });
    await expect(service.save({ verification: future, reason: "Review", idempotencyKey: "key" }, "operator")).rejects.toMatchObject({ code: "CUTOVER_OPENING_VERIFICATION_TIME_INVALID" });
    expect(store.preview).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
    const invalid = fixture({ now: () => new Date("invalid") });
    await expect(invalid.service.capture("operator")).rejects.toMatchObject({ code: "CUTOVER_OPENING_CLOCK_INVALID", status: 500 });
    expect(invalid.store.capture).not.toHaveBeenCalled();
  });

  it("propagates owner failures without reporting successful verification", async () => {
    const { store, service } = fixture(); const failure = new Error("protected capture failed");
    store.save.mockRejectedValue(failure);
    await expect(service.save({ verification: verification(), reason: "Review", idempotencyKey: "key" }, "operator")).rejects.toBe(failure);
    expect(store.save).toHaveBeenCalledOnce();
  });

  it("validates source, assessment and save outputs instead of exposing malformed owner data", async () => {
    const { store, service } = fixture();
    store.capture.mockResolvedValue({ ...source(), runtimeAuthority: "unknown" } as unknown as OpeningSource);
    store.preview.mockResolvedValue({ ...assessment(), ready: false });
    store.save.mockResolvedValue({ ...saved(), stockChanged: true } as unknown as OpeningSaved);
    await expect(service.capture("operator")).rejects.toThrow();
    await expect(service.preview(verification(), "operator")).rejects.toThrow();
    await expect(service.save({ verification: verification(), reason: "Review", idempotencyKey: "key" }, "operator")).rejects.toThrow();
  });
});
