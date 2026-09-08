import { describe, expect, it } from "vitest";
import { committedInventoryPublicationManifestSchema, validateInventoryCutoverFullPublicationProof } from "../../domain/inventory-cutover-full-publication-proof";
import { CUTOVER_COMPLETION_NOW as NOW, completionIdentity, completionManifest, completionPublication } from "../fixtures/inventory-cutover-completion.fixture";

const MAX_AGE = 15 * 60 * 1000;
function input(evidence: unknown[] = [completionPublication()], manifest: unknown = completionManifest()) {
  return { manifest, evidence, occurredAt: NOW, maxReadbackAgeMs: MAX_AGE };
}
function codes(value: unknown) { return validateInventoryCutoverFullPublicationProof(value).blockers.map(row => row.code); }

describe("exact full cutover publication proof", () => {
  it("confirms the exact committed full revision with a fresh matching readback", () => {
    expect(validateInventoryCutoverFullPublicationProof(input())).toEqual({ blockers: [], verifiedPublicationRows: 1,
      publicationRows: [{ publicationTargetId: 1, productVariantId: 2, desiredRevision: "3", desiredQuantity: "5", observedQuantity: "5", state: "verified" }] });
  });

  it("accepts a later immutable revision with current quantity, including zero", () => {
    for (const quantity of ["0", "1", "6", "9223372036854775807"]) {
      expect(codes(input([{ ...completionPublication(), publicationId: "11", desiredRevision: "4", conservativeQuantity: quantity, observedQuantity: quantity }]))).toEqual([]);
    }
  });

  it.each([
    { desiredRevision: "2" }, { desiredRevision: "4" }, { publicationId: "11" },
    { conservativeQuantity: "6", observedQuantity: "6" },
  ])("rejects a predecessor or rewritten immutable committed revision: %#", override => {
    expect(codes(input([{ ...completionPublication(), ...override }]))).toContain("CUTOVER_FULL_PUBLICATION_NOT_CONFIRMED");
  });

  it.each(["4", "6", "0", null])("requires exact full quantity, not merely conservative exposure: %j", observedQuantity => {
    const result = validateInventoryCutoverFullPublicationProof(input([{ ...completionPublication(), observedQuantity }]));
    expect(result.blockers.map(row => row.code)).toContain("CUTOVER_FULL_PUBLICATION_NOT_CONFIRMED");
    expect(result.verifiedPublicationRows).toBe(0);
  });

  it("compares adjacent large integer revisions without floating point rounding", () => {
    const manifest = [{ ...completionManifest()[0], desired_revision: "9223372036854775806" }];
    expect(codes(input([{ ...completionPublication(), publicationId: "11", desiredRevision: "9223372036854775807" }], manifest))).toEqual([]);
    expect(codes(input([{ ...completionPublication(), desiredRevision: "9223372036854775805" }], manifest)))
      .toContain("CUTOVER_FULL_PUBLICATION_NOT_CONFIRMED");
  });

  it.each([
    ["externalInventoryItemId", "other-item"], ["publicationTargetRevision", "3"], ["channelConnectionId", 7],
    ["providerScopeType", "account"], ["externalScopeId", "other-location"],
  ])("rejects an outbox identity different from the current destination: %s", (field, value) => {
    expect(codes(input([{ ...completionPublication(), outboxIdentity: { ...completionIdentity(), [field]: value } }])))
      .toContain("CUTOVER_FULL_PUBLICATION_NOT_CONFIRMED");
  });

  it("rejects a changed target revision even when all mutable identity evidence agrees", () => {
    const identity = { ...completionIdentity(), publicationTargetRevision: "3" };
    expect(codes(input([{ ...completionPublication(), expectedIdentity: identity, observedIdentity: identity, outboxIdentity: identity }])))
      .toContain("CUTOVER_FULL_PUBLICATION_NOT_CONFIRMED");
  });

  it("supports exact dropship account identity while keeping it distinct from a channel with the same numeric ID", () => {
    const identity = { ...completionIdentity(), destinationKind: "dropship_store_connection" as const,
      channelConnectionId: null, dropshipStoreConnectionId: 3, providerScopeType: "account" as const };
    const row = { ...completionPublication(), expectedIdentity: identity, observedIdentity: identity, outboxIdentity: identity };
    expect(codes(input([row]))).toEqual([]);
    expect(codes(input([{ ...row, observedIdentity: completionIdentity() }]))).toContain("CUTOVER_PROVIDER_PROOF_INCOMPLETE");
  });

  it.each([
    { phase: "conservative" }, { targetState: "preview" }, { mappingLifecycle: "draft" }, { unexpected: true },
    { desiredRevision: "abc" }, { conservativeQuantity: "9223372036854775808" }, { publicationId: "0" },
  ])("requires a validated full live sealed row: %#", override => {
    expect(codes(input([{ ...completionPublication(), ...override }]))).toContain("CUTOVER_FULL_PUBLICATION_INCOMPLETE");
  });

  it.each([
    { state: "acknowledged" }, { acknowledgedAt: null }, { observedAt: null }, { observedIdentity: null },
    { acknowledgedAt: "2026-09-08T20:00:00.001Z" }, { observedAt: "2026-09-08T20:00:00.001Z" },
    { observedAt: "2026-09-08T19:49:59.999Z" }, { observedIdentity: { ...completionIdentity(), externalInventoryItemId: "wrong" } },
  ])("requires successful ordered nonfuture exact provider readback: %#", override => {
    const result = validateInventoryCutoverFullPublicationProof(input([{ ...completionPublication(), ...override }]));
    expect(result.blockers.map(row => row.code)).toContain("CUTOVER_PROVIDER_PROOF_INCOMPLETE");
    expect(result.verifiedPublicationRows).toBe(0);
  });

  it("accepts the freshness boundary and rejects one millisecond older", () => {
    const row = { ...completionPublication(), acknowledgedAt: new Date(NOW.getTime() - MAX_AGE - 1000), observedAt: new Date(NOW.getTime() - MAX_AGE) };
    expect(codes(input([row]))).toEqual([]);
    expect(codes(input([{ ...row, observedAt: new Date(NOW.getTime() - MAX_AGE - 1) }]))).toContain("CUTOVER_PROVIDER_PROOF_INCOMPLETE");
  });

  it.each([
    { rows: [] }, { rows: [completionPublication(), completionPublication()] }, { rows: [{ ...completionPublication(), publicationTargetId: 2 }] },
    { rows: [{ ...completionPublication(), productVariantId: 3 }] }, { rows: [{ ...completionPublication(), publicationTargetId: "1" }] },
  ])("rejects missing, duplicate or substituted expected coverage: %#", ({ rows }) => {
    expect(codes(input(rows))).toContain("CUTOVER_FULL_PUBLICATION_INCOMPLETE");
  });

  it("rejects extra evidence even when all expected rows are verified", () => {
    expect(codes(input([completionPublication(), { ...completionPublication(), publicationTargetId: 9 }]))).toContain("CUTOVER_FULL_PUBLICATION_COVERAGE_CHANGED");
    expect(codes(input([completionPublication(), null]))).toContain("CUTOVER_FULL_PUBLICATION_EVIDENCE_INVALID");
    expect(codes(input([completionPublication()], []))).toContain("CUTOVER_FULL_PUBLICATION_COVERAGE_CHANGED");
  });

  it("accepts empty coverage only with an explicit empty immutable manifest and valid proof policy", () => {
    expect(validateInventoryCutoverFullPublicationProof(input([], []))).toEqual({ blockers: [], publicationRows: [], verifiedPublicationRows: 0 });
    expect(codes(input([], undefined))).toContain("CUTOVER_FULL_PUBLICATION_INCOMPLETE");
    expect(codes({ ...input([], []), occurredAt: new Date("invalid") })).toEqual(["CUTOVER_FULL_PUBLICATION_PROOF_INPUT_INVALID"]);
    expect(codes({ ...input([], []), maxReadbackAgeMs: 0 })).toEqual(["CUTOVER_FULL_PUBLICATION_PROOF_INPUT_INVALID"]);
  });

  it.each([null, {}, { ...input(), evidence: null }, { ...input(), occurredAt: NOW.toISOString() },
    { ...input(), maxReadbackAgeMs: -1 }, { ...input(), maxReadbackAgeMs: 1.5 }, { ...input(), unexpected: true },
  ])("rejects malformed outer proof without throwing: %#", value => {
    expect(codes(value)).toEqual(["CUTOVER_FULL_PUBLICATION_PROOF_INPUT_INVALID"]);
  });

  it("bounds complete evidence and manifest arrays instead of silently truncating", () => {
    expect(codes(input(Array(100_001).fill(null)))).toEqual(["CUTOVER_FULL_PUBLICATION_PROOF_INPUT_INVALID"]);
    expect(codes(input([], Array(100_001).fill(null)))).toEqual(["CUTOVER_COMMIT_PUBLICATION_MANIFEST_INVALID"]);
  });

  it.each(["abc", "1.1", "", "01", "-1", "9223372036854775808", "9".repeat(200), 1, null])(
    "rejects malformed committed quantities %j without BigInt exceptions", desired_quantity => {
      expect(codes(input([], [{ ...completionManifest()[0], desired_quantity }]))).toEqual(["CUTOVER_COMMIT_PUBLICATION_MANIFEST_INVALID"]);
    },
  );

  it.each(["id", "desired_revision", "publication_target_revision_snapshot"])("bounds positive manifest field %s", field => {
    for (const value of ["0", "abc", "9223372036854775808", "01", 1]) {
      expect(committedInventoryPublicationManifestSchema.safeParse([{ ...completionManifest()[0], [field]: value }]).success).toBe(false);
    }
  });

  it("requires unique pairs and immutable IDs, strict row shape, and bounded integer SQL identities", () => {
    const row = completionManifest()[0];
    for (const manifest of [[row, { ...row, id: "11" }], [row, { ...row, product_variant_id: 3 }],
      [{ ...row, unexpected: true }], [{ ...row, product_variant_id: 2147483648 }], [{ ...row, publication_target_id: 1.5 }]]) {
      expect(committedInventoryPublicationManifestSchema.safeParse(manifest).success).toBe(false);
    }
    expect(committedInventoryPublicationManifestSchema.safeParse([{ ...row, desired_quantity: "9223372036854775807" }]).success).toBe(true);
  });

  it("does not mutate input and sorts exact target/SKU rows deterministically", () => {
    const rows = [completionPublication(), { ...completionPublication(), publicationId: "11", productVariantId: 1 }];
    const manifest = [...completionManifest(), { ...completionManifest()[0], id: "11", product_variant_id: 1 }];
    const value = input(rows, manifest); const before = JSON.stringify(value);
    const first = validateInventoryCutoverFullPublicationProof(value);
    expect(first.blockers).toEqual([]);
    expect(first.publicationRows.map(row => row.productVariantId)).toEqual([1, 2]);
    expect(first).toEqual(validateInventoryCutoverFullPublicationProof(value));
    expect(JSON.stringify(value)).toBe(before);
  });
});
