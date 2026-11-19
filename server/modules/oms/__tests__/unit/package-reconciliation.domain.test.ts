import { describe, expect, it } from "vitest";
import { planPackageReconciliation, type PackageReconciliationInput } from "../../package-reconciliation.domain";

const pkg = (labelId: number, providerOrderId: string, quantity: number, status: "active" | "voided" = "active") => ({
  labelId, providerOrderId, trackingNumber: `tracking-${labelId}`, status, outbound: true,
  contentsVerified: true, voidVerified: status === "voided", carrierPossession: false, contents: [{ sourceItemId: 1, quantity }],
});
const old = (labelId: number, quantity: number) => ({ physicalItemId: labelId + 100, physicalShipmentId: labelId + 200, labelId, sourceItemId: 1, quantity });
const input = (overrides: Partial<PackageReconciliationInput> = {}): PackageReconciliationInput => ({
  sources: [{ sourceItemId: 1, quantity: 3 }], labels: [pkg(1, "parent", 1, "voided"), pkg(2, "child-a", 1), pkg(3, "child-b", 1), pkg(4, "parent", 1)],
  previous: [old(1, 1), old(2, 1)], relationships: [], correction: null, ...overrides,
});

describe("complete current package reconciliation", () => {
  it("reconciles a relabel plus a new split portion without consuming an active sibling", () => {
    expect(planPackageReconciliation(input())).toMatchObject({ outcome: "ready", physicalItemIdsToRetire: [101], labelIdsToMaterialize: [3, 4],
      sourceQuantities: [{ sourceQuantity: 3, preservedQuantity: 1, retiredQuantity: 1, materializedQuantity: 2, additionalQuantity: 1, finalQuantity: 3 }] });
  });
  it("supports a single parcel with both replacement and previously unused units of the same source", () => {
    expect(planPackageReconciliation(input({ sources: [{ sourceItemId: 1, quantity: 3 }], labels: [pkg(1, "parent", 1, "voided"), pkg(4, "parent", 3)], previous: [old(1, 1)] })))
      .toMatchObject({ outcome: "ready", sourceQuantities: [{ retiredQuantity: 1, materializedQuantity: 3, additionalQuantity: 2, finalQuantity: 3 }] });
  });
  it("merges a previously allocated order and a previously unmaterialized order", () => {
    const primary = pkg(1, "parent", 15, "voided");
    const combined = { ...pkg(4, "parent", 15), contents: [{ sourceItemId: 1, quantity: 15 }, { sourceItemId: 2, quantity: 12 }] };
    expect(planPackageReconciliation(input({ sources: [{ sourceItemId: 1, quantity: 15 }, { sourceItemId: 2, quantity: 12 }], labels: [primary, combined], previous: [old(1, 15)] })))
      .toMatchObject({ outcome: "ready", physicalItemIdsToRetire: [101], sourceQuantities: [{ sourceItemId: 1, finalQuantity: 15 }, { sourceItemId: 2, additionalQuantity: 12, finalQuantity: 12 }] });
  });
  it("does not automatically discard an earlier active carrier-owned allocation", () => {
    const earlier = { ...pkg(2, "merged-order", 2), carrierPossession: true };
    const combined = { ...pkg(4, "parent", 3), contents: [{ sourceItemId: 1, quantity: 3 }, { sourceItemId: 2, quantity: 2 }] };
    expect(planPackageReconciliation(input({ sources: [{ sourceItemId: 1, quantity: 3 }, { sourceItemId: 2, quantity: 2 }],
      labels: [pkg(1, "parent", 3, "voided"), { ...earlier, contents: [{ sourceItemId: 2, quantity: 2 }] }, combined],
      previous: [old(1, 3), { ...old(2, 2), sourceItemId: 2 }] })))
      .toEqual({ outcome: "review", reason: "current_allocations_exceed_source" });
  });
  it("accepts an explicit merge contents correction without rewriting the earlier carrier status", () => {
    const earlier = { ...pkg(2, "merged-order", 2), carrierPossession: true, contents: [{ sourceItemId: 2, quantity: 2 }] };
    const combined = { ...pkg(4, "parent", 3), contents: [{ sourceItemId: 1, quantity: 3 }, { sourceItemId: 2, quantity: 2 }] };
    const command = input({ sources: [{ sourceItemId: 1, quantity: 3 }, { sourceItemId: 2, quantity: 2 }], labels: [pkg(1, "parent", 3, "voided"), earlier, combined],
      previous: [old(1, 3), { ...old(2, 2), sourceItemId: 2 }], relationships: [{ providerOrderId: "parent", mergedProviderOrderIds: ["merged-order"], parentProviderOrderId: null, evidenceHash: "a".repeat(64) }],
      correction: { kind: "confirmed_package_contents_correction", actorId: "operator", reason: "Confirmed combined parcel", previousLabelIds: [2] } });
    const before = structuredClone(command);
    expect(planPackageReconciliation(command)).toMatchObject({ outcome: "ready", physicalItemIdsToRetire: [101, 102], labelIdsToMaterialize: [4], correctedPreviousLabelIds: [2] });
    expect(command).toEqual(before);
  });
  it("requires explicit provider merge evidence for an operator correction", () => {
    expect(planPackageReconciliation(input({ correction: { kind: "confirmed_package_contents_correction", actorId: "operator", reason: "Correction", previousLabelIds: [2] } })))
      .toEqual({ outcome: "review", reason: "package_contents_correction_merge_unproven" });
  });
  it("never silently replaces a voided label with carrier possession", () => {
    const command = input();
    command.labels[0] = { ...command.labels[0], carrierPossession: true };
    expect(planPackageReconciliation(command)).toEqual({ outcome: "review", reason: "replaced_label_has_carrier_possession" });
  });
  it("waits for incomplete replacement portions", () => {
    expect(planPackageReconciliation(input({ labels: [pkg(1, "parent", 3, "voided"), pkg(4, "parent", 1)], previous: [old(1, 3)] })))
      .toEqual({ outcome: "waiting", reason: "replacement_repack_incomplete" });
  });
  it("rejects over-capacity packages and duplicate or missing source identities", () => {
    expect(planPackageReconciliation(input({ sources: [{ sourceItemId: 1, quantity: 2 }] }))).toMatchObject({ outcome: "review" });
    expect(planPackageReconciliation(input({ previous: [old(1, 1), old(1, 1)] }))).toMatchObject({ outcome: "review" });
    expect(planPackageReconciliation(input({ sources: [{ sourceItemId: 2, quantity: 3 }] }))).toMatchObject({ outcome: "review" });
  });
  it("rejects returns, unverified current contents, unknown statuses and unsafe quantities", () => {
    for (const change of [{ outbound: false }, { contentsVerified: false }, { contents: [] }]) {
      const command = input(); command.labels[2] = { ...command.labels[2], ...change };
      expect(planPackageReconciliation(command)).toMatchObject({ outcome: "review" });
    }
    for (const value of [0, -1, 1.5, 2_147_483_648]) expect(planPackageReconciliation(input({ sources: [{ sourceItemId: 1, quantity: value }] }))).toMatchObject({ outcome: "review" });
  });
  it("uses deterministic evidence hashes irrespective of package/source row order", () => {
    const command = input();
    expect(planPackageReconciliation(command)).toEqual(planPackageReconciliation({ ...command, previous: [...command.previous].reverse(), labels: [...command.labels].reverse() }));
  });
  it("recognizes an already materialized current package set", () => {
    expect(planPackageReconciliation(input({ labels: [pkg(2, "parent", 3)], previous: [old(2, 3)] }))).toMatchObject({ outcome: "unchanged", physicalItemIdsToRetire: [], labelIdsToMaterialize: [] });
  });
});
