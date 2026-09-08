import { describe, expect, it } from "vitest";
import { validateCutoverDrainReadbacks } from "../../domain/inventory-cutover-drain-readback-proof";
import { completionDrain, completionPublication } from "../fixtures/inventory-cutover-completion.fixture";

function codes(proof: unknown = completionDrain(), readbacks: readonly unknown[] = [completionPublication()], runId = "1") {
  return validateCutoverDrainReadbacks(proof, runId, readbacks).map(row => row.code);
}

describe("publication drain to exact readback lineage", () => {
  it("requires a terminal admitted outbox owner before exact provider observation", () => {
    expect(codes()).toEqual([]);
  });

  it("does not relabel operator terminal attestation as a provider readback", () => {
    const proof = completionDrain();
    proof.latestAttemptsByScope[0].resolutionBasis = "operator_attestation";
    const before = JSON.stringify(proof);
    expect(codes(proof)).toEqual([]);
    expect(codes(proof, [{ ...completionPublication(), observedAt: null }])).toContain("CUTOVER_READBACK_PREDATES_PUBLICATION_DRAIN");
    expect(JSON.stringify(proof)).toBe(before);
  });

  it.each([null, {}, { ...completionDrain(), suppressed: false }, { ...completionDrain(), activationRunId: "2" },
    { ...completionDrain(), gateEpoch: "abc" }, { ...completionDrain(), latestAttemptId: "abc" },
    { ...completionDrain(), gateEpoch: "9223372036854775808" }, { ...completionDrain(), unexpected: true },
  ])("fails missing, wrong-run or malformed gate evidence closed without native exceptions: %#", proof => {
    expect(codes(proof)).toEqual(["CUTOVER_PUBLICATION_SUPPRESSION_MISSING"]);
  });

  it.each(["legacy", "outbox"] as const)("blocks any unresolved %s write, including outside requested target scopes", owner => {
    const proof = completionDrain();
    proof.unresolvedAttempts = [{ attemptId: "19", owner, state: "uncertain", outboxId: owner === "outbox" ? "9" : null,
      scope: { ...proof.latestAttemptsByScope[0].scope, externalInventoryItemId: "unrelated-item" } }];
    expect(codes(proof)).toEqual(["CUTOVER_PUBLICATION_OUTCOME_UNRESOLVED"]);
    proof.unresolvedAttempts[0].state = "running";
    expect(codes(proof, [])).toEqual(["CUTOVER_PUBLICATION_OUTCOME_UNRESOLVED"]);
  });

  it.each([
    { owner: "legacy", outboxId: null }, { outboxId: "9" }, { outboxId: null }, { completedAt: null },
    { completedAt: "2026-09-08T19:55:00.001Z" }, { resolutionBasis: null }, { gateEpoch: "1" },
    { gateEpoch: "3" }, { attemptId: "21" },
  ])("rejects stale, unrelated or unfinished latest admission: %#", override => {
    const proof = completionDrain();
    expect(codes({ ...proof, latestAttemptsByScope: [{ ...proof.latestAttemptsByScope[0], ...override }] }))
      .toContain("CUTOVER_READBACK_PREDATES_PUBLICATION_DRAIN");
  });

  it.each([
    { destinationKind: "dropship_store_connection" }, { connectionId: 4 }, { providerScopeType: "account" },
    { externalScopeId: "other-location" }, { externalInventoryItemId: "other-item" },
  ])("does not confuse a different external-item identity: %#", override => {
    const proof = completionDrain();
    expect(codes({ ...proof, latestAttemptsByScope: [{ ...proof.latestAttemptsByScope[0], scope: { ...proof.latestAttemptsByScope[0].scope, ...override } }] }))
      .toContain("CUTOVER_READBACK_PREDATES_PUBLICATION_DRAIN");
  });

  it("accepts dropship only with its matching destination owner", () => {
    const proof = completionDrain(); const row = completionPublication();
    row.expectedIdentity = { ...row.expectedIdentity, destinationKind: "dropship_store_connection", channelConnectionId: null, dropshipStoreConnectionId: 3 };
    expect(codes(proof, [row])).toContain("CUTOVER_READBACK_PREDATES_PUBLICATION_DRAIN");
    proof.latestAttemptsByScope[0].scope.destinationKind = "dropship_store_connection";
    expect(codes(proof, [row])).toEqual([]);
  });

  it("rejects duplicate or absent latest attempts for an exact scope", () => {
    const proof = completionDrain();
    expect(codes({ ...proof, latestAttemptsByScope: [] })).toContain("CUTOVER_READBACK_PREDATES_PUBLICATION_DRAIN");
    proof.latestAttemptsByScope.push({ ...proof.latestAttemptsByScope[0], attemptId: "19" });
    expect(codes(proof)).toContain("CUTOVER_READBACK_PREDATES_PUBLICATION_DRAIN");
  });

  it("accepts equal completion/readback timestamps, including Date evidence", () => {
    const proof = completionDrain();
    proof.latestAttemptsByScope[0].completedAt = "2026-09-08T19:55:00.000Z";
    expect(codes(proof)).toEqual([]);
    expect(codes(proof, [{ ...completionPublication(), observedAt: new Date("2026-09-08T19:55:00.000Z") }])).toEqual([]);
  });

  it.each([null, {}, { ...completionPublication(), publicationId: "abc" }, { ...completionPublication(), observedAt: "bad" }])(
    "does not silently ignore malformed readbacks: %#", row => {
      expect(codes(completionDrain(), [row])).toContain("CUTOVER_PUBLICATION_DRAIN_READBACK_INVALID");
    },
  );

  it("allows explicitly empty target coverage only after global uncertain writes have drained", () => {
    expect(codes({ ...completionDrain(), latestAttemptsByScope: [] }, [])).toEqual([]);
    expect(codes({ ...completionDrain(), suppressed: false }, [])).toContain("CUTOVER_PUBLICATION_SUPPRESSION_MISSING");
  });

  it.each([{ readbacks: null }, { readbacks: {} }, { readbacks: Array(100_001).fill(null) }])("rejects an absent or oversized readback census: %#", ({ readbacks }) => {
    expect(validateCutoverDrainReadbacks(completionDrain(), "1", readbacks).map(row => row.code))
      .toEqual(["CUTOVER_PUBLICATION_DRAIN_READBACK_INVALID"]);
  });

  it("does not confuse pending catch-up obligations with unresolved HTTP attempts or mutate evidence", () => {
    const proof = completionDrain(); proof.pendingCatchupCount = 5;
    const readbacks = [completionPublication()]; const before = JSON.stringify({ proof, readbacks });
    expect(codes(proof, readbacks)).toEqual([]);
    expect(JSON.stringify({ proof, readbacks })).toBe(before);
  });
});
