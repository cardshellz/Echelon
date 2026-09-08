import { describe, expect, it } from "vitest";
import {
  validateInventoryCutoverPublicationProof,
  type InventoryCutoverConservativePublicationEvidence,
  type InventoryCutoverPublicationIdentity,
} from "../../domain/inventory-cutover-publication-proof";

const NOW = new Date("2026-09-07T20:00:00.000Z");
const MAX_AGE = 15 * 60 * 1000;
const PLAN = { publicationTargetId: 1, productVariantId: 2, desiredQuantity: "5" };
function identity(): InventoryCutoverPublicationIdentity {
  return { externalInventoryItemId: "item-1", publicationTargetRevision: "2", destinationKind: "channel_connection",
    channelConnectionId: 3, dropshipStoreConnectionId: null, providerScopeType: "location", externalScopeId: "location-1" };
}
function evidence(): InventoryCutoverConservativePublicationEvidence {
  return { publicationId: "10", publicationTargetId: 1, productVariantId: 2, state: "verified", conservativeQuantity: "3",
    acknowledgedAt: new Date("2026-09-07T19:50:00.000Z"), observedQuantity: "3", observedAt: new Date("2026-09-07T19:55:00.000Z"),
    expectedIdentity: identity(), observedIdentity: identity() };
}
function input(rows: unknown[] = [evidence()], quantities: unknown[] = [PLAN]) {
  return { evidence: rows, quantities, occurredAt: NOW, maxReadbackAgeMs: MAX_AGE };
}
function codes(value: unknown): string[] { return validateInventoryCutoverPublicationProof(value).blockers.map((row) => row.code); }

describe("cutover publication proof", () => {
  it("accepts exact location identity with successful acknowledgement followed by fresh readback", () => {
    expect(validateInventoryCutoverPublicationProof(input())).toEqual({ blockers: [] });
  });

  it("accepts an explicitly owned dropship/account destination", () => {
    const row = evidence();
    row.expectedIdentity = { ...identity(), destinationKind: "dropship_store_connection", channelConnectionId: null,
      dropshipStoreConnectionId: 6, providerScopeType: "account", externalScopeId: "merchant-1" };
    row.observedIdentity = { ...row.expectedIdentity };
    expect(codes(input([row]))).toEqual([]);
  });

  it.each([
    ["externalInventoryItemId", "other-item"], ["publicationTargetRevision", "3"],
    ["channelConnectionId", 7], ["dropshipStoreConnectionId", 7],
    ["destinationKind", "dropship_store_connection"], ["providerScopeType", "account"], ["externalScopeId", "other-location"],
  ])("rejects a different readback %s", (field, value) => {
    const row = evidence();
    row.observedIdentity = { ...identity(), [String(field)]: value } as InventoryCutoverPublicationIdentity;
    expect(codes(input([row]))).toEqual(["CUTOVER_PROVIDER_PROOF_INCOMPLETE"]);
  });

  it("rejects a complete different destination owner even when item/revision match", () => {
    const row = evidence();
    row.observedIdentity = { ...identity(), destinationKind: "dropship_store_connection", channelConnectionId: null, dropshipStoreConnectionId: 3 };
    expect(codes(input([row]))).toEqual(["CUTOVER_PROVIDER_PROOF_INCOMPLETE"]);
  });

  it.each([
    { channelConnectionId: null }, { dropshipStoreConnectionId: 9 },
    { externalScopeId: " " }, { publicationTargetRevision: "0" }, { publicationTargetRevision: "abc" },
  ])("does not let equally malformed expected and observed identity count as a match: %#", (override) => {
    const row = evidence();
    row.expectedIdentity = { ...identity(), ...override } as InventoryCutoverPublicationIdentity;
    row.observedIdentity = { ...row.expectedIdentity };
    expect(codes(input([row]))).toEqual(["CUTOVER_PROVIDER_PROOF_INCOMPLETE"]);
  });

  it.each([
    { acknowledgedAt: null }, { observedAt: null }, { observedQuantity: null }, { observedIdentity: null },
    { state: "acknowledged" }, { state: "retryable" }, { acknowledgedAt: "not-a-time" }, { observedAt: new Date("invalid") },
    { observedAt: new Date("2026-09-07T19:49:59.999Z") },
    { observedAt: new Date("2026-09-07T20:00:00.001Z") },
    { acknowledgedAt: new Date("2026-09-07T20:00:00.001Z") },
  ])("requires valid ordered non-future acknowledgement/readback evidence: %#", (override) => {
    expect(codes(input([{ ...evidence(), ...override }]))).toEqual(["CUTOVER_PROVIDER_PROOF_INCOMPLETE"]);
  });

  it("accepts the exact freshness boundary but rejects one millisecond older", () => {
    const row = evidence();
    row.acknowledgedAt = new Date("2026-09-07T19:00:00.000Z");
    row.observedAt = new Date(NOW.getTime() - MAX_AGE);
    expect(codes(input([row]))).toEqual([]);
    row.observedAt = new Date(NOW.getTime() - MAX_AGE - 1);
    expect(codes(input([row]))).toEqual(["CUTOVER_PROVIDER_PROOF_INCOMPLETE"]);
  });

  it("allows a fresh exact observation to reconfirm an older successful acknowledgement", () => {
    const row = evidence();
    row.acknowledgedAt = "2026-09-06T19:00:00.000Z";
    row.observedAt = NOW.toISOString();
    expect(codes(input([row]))).toEqual([]);
  });

  it("accepts equal acknowledgement and observation timestamps", () => {
    const row = evidence();
    row.acknowledgedAt = NOW;
    row.observedAt = NOW;
    expect(codes(input([row]))).toEqual([]);
  });

  it("blocks exposure above the fresh reconstruction plan, not just above the earlier conservative write", () => {
    expect(codes(input([{ ...evidence(), observedQuantity: "6" }]))).toEqual(["CUTOVER_PROVIDER_EXPOSURE_ABOVE_PLAN"]);
    expect(codes(input([{ ...evidence(), observedQuantity: "5" }]))).toEqual([]);
    expect(codes(input([{ ...evidence(), observedQuantity: "0" }]))).toEqual([]);
  });

  it("compares full PostgreSQL bigint quantities without floating-point rounding", () => {
    const plan = { ...PLAN, desiredQuantity: "9223372036854775806" };
    expect(codes(input([{ ...evidence(), observedQuantity: "9223372036854775807" }], [plan])))
      .toEqual(["CUTOVER_PROVIDER_EXPOSURE_ABOVE_PLAN"]);
    expect(codes(input([{ ...evidence(), observedQuantity: "9223372036854775806" }], [plan]))).toEqual([]);
  });

  it.each(["abc", "1.5", "", "01", "-1", "9223372036854775808", "9".repeat(200), 1, null])(
    "classifies malformed planned quantity %j without a native BigInt exception", (desiredQuantity) => {
      expect(codes(input([evidence()], [{ ...PLAN, desiredQuantity }]))).toEqual(["CUTOVER_PUBLICATION_PLAN_INVALID"]);
    },
  );

  it.each(["abc", "1.5", "", "01", "-1", "9223372036854775808", "9".repeat(200), 1])(
    "classifies malformed observed quantity %j without a native BigInt exception", (observedQuantity) => {
      expect(codes(input([{ ...evidence(), observedQuantity }]))).toEqual(["CUTOVER_PROVIDER_PROOF_INCOMPLETE"]);
    },
  );

  it.each([
    { name: "missing", rows: [] },
    { name: "duplicate", rows: [evidence(), { ...evidence(), publicationId: "11" }] },
    { name: "wrong target at same cardinality", rows: [{ ...evidence(), publicationTargetId: 9 }] },
    { name: "wrong SKU at same cardinality", rows: [{ ...evidence(), productVariantId: 9 }] },
    { name: "malformed identity", rows: [{ ...evidence(), publicationTargetId: "1" }] },
  ])("rejects $name coverage", ({ rows }) => {
    expect(codes(input(rows))).toContain("CUTOVER_CONSERVATIVE_COVERAGE_INVALID");
    expect(codes(input(rows))).toContain("CUTOVER_PROVIDER_PROOF_INCOMPLETE");
  });

  it("rejects extra evidence and duplicate planned identities even if valid rows exist", () => {
    expect(codes(input([evidence(), { ...evidence(), publicationTargetId: 9 }]))).toContain("CUTOVER_CONSERVATIVE_COVERAGE_INVALID");
    expect(codes(input([evidence()], [PLAN, PLAN]))).toContain("CUTOVER_CONSERVATIVE_COVERAGE_INVALID");
    expect(codes(input([evidence()], []))).toContain("CUTOVER_CONSERVATIVE_COVERAGE_INVALID");
    expect(codes(input([], []))).toEqual([]);
  });

  it.each([null, {}, { ...input(), occurredAt: new Date("invalid") }, { ...input(), occurredAt: NOW.toISOString() },
    { ...input(), maxReadbackAgeMs: 0 }, { ...input(), maxReadbackAgeMs: -1 }, { ...input(), unexpected: true },
  ])("fails malformed proof input closed: %#", (value) => {
    expect(codes(value)).toEqual(["CUTOVER_PROVIDER_PROOF_INPUT_INVALID"]);
  });

  it("does not mutate caller evidence and is deterministic", () => {
    const value = input();
    const before = JSON.stringify(value);
    expect(validateInventoryCutoverPublicationProof(value)).toEqual(validateInventoryCutoverPublicationProof(value));
    expect(JSON.stringify(value)).toBe(before);
  });
});
