import { describe, expect, it } from "vitest";
import { planLabelReplacement } from "../../label-replacement-plan.domain";
import { MAX_LABEL_REPLACEMENT_ITEMS, scopeLabelReplacementPredecessors, type LabelReplacementScopeInput } from "../../label-replacement-scope.domain";

describe("channel-independent label replacement package scope", () => {
  const previous = [1, 2, 3, 4].map(id => ({
    sourceItemId: 100, physicalItemId: id, physicalShipmentId: id + 10,
    providerOrderId: `provider-split-${id}`, labelStatus: "voided" as const,
  }));
  const input: LabelReplacementScopeInput = { providerOrderId: "provider-split-2", sourceItemIds: [100], previous };

  it.each([1, 2, 3, 4])("selects only split package %s even though all packages share source and quantity", id => {
    expect(scopeLabelReplacementPredecessors({ ...input, providerOrderId: `provider-split-${id}` }))
      .toEqual({ outcome: "scoped", physicalItemIds: [id] });
  });
  it("does not change identity when evidence arrives in a different order", () => {
    const frozen = Object.freeze(previous.map(item => Object.freeze({ ...item })));
    expect(scopeLabelReplacementPredecessors({ ...input, previous: [...frozen].reverse() }))
      .toEqual(scopeLabelReplacementPredecessors(input));
    expect(frozen).toEqual(previous);
  });
  it("does not borrow a voided sibling while the exact predecessor still awaits a void", () => {
    const result = scopeLabelReplacementPredecessors({ ...input,
      previous: previous.map(item => item.physicalItemId === 2 ? { ...item, labelStatus: "active" } : item) });
    expect(result).toEqual({ outcome: "scoped", physicalItemIds: [2] });
    expect(planLabelReplacement({ labelId: 1, candidates: [{ labelId: 1, providerOrderId: 'provider-split-2', contents: [{ sourceItemId: 100, quantity: 1 }] }],
      previous: [{ ...previous[1], quantity: 1, labelStatus: "active", carrierPossession: false }] }))
      .toMatchObject({ outcome: "waiting", reason: "awaiting_replaced_label_void" });
  });
  it("does not treat a different source under the same WMS header as a competitor", () => {
    expect(scopeLabelReplacementPredecessors({ ...input, sourceItemIds: [200] }))
      .toEqual({ outcome: "scoped", physicalItemIds: [] });
  });
  it("preserves the whole selected package, including another line requiring coverage proof", () => {
    expect(scopeLabelReplacementPredecessors({ ...input, previous: [...previous,
      { ...previous[1], physicalItemId: 20, sourceItemId: 200 }] }))
      .toEqual({ outcome: "scoped", physicalItemIds: [2, 20] });
  });
  it("supports combined orders with distinct source identities even when the provider order changes", () => {
    expect(scopeLabelReplacementPredecessors({ providerOrderId: "combined-order", sourceItemIds: [100, 200],
      previous: [previous[0], { ...previous[1], sourceItemId: 200 }] }))
      .toEqual({ outcome: "scoped", physicalItemIds: [1, 2] });
  });
  it.each([null, "new-provider-order"])("does not invent a pairing when provider lineage is %s", providerOrderId => {
    const result = scopeLabelReplacementPredecessors({ ...input, providerOrderId });
    expect(result).toEqual({ outcome: "scoped", physicalItemIds: [1, 2, 3, 4] });
    expect(planLabelReplacement({ labelId: 1, candidates: [{ labelId: 1, providerOrderId, contents: [{ sourceItemId: 100, quantity: 1 }] }],
      previous: previous.map(item => ({ ...item, quantity: 1, carrierPossession: false })) }))
      .toEqual({ outcome: "waiting", reason: "replacement_repack_incomplete" });
  });
  it("ignores an active sibling only after identifying the matching voided lineage", () => {
    expect(scopeLabelReplacementPredecessors({ ...input, previous: [...previous,
      { ...previous[1], physicalItemId: 30, physicalShipmentId: 40, labelStatus: "active" }] }))
      .toEqual({ outcome: "scoped", physicalItemIds: [2] });
  });
  it.each([
    { ...input, providerOrderId: " " },
    { ...input, providerOrderId: "x".repeat(101) },
    { ...input, sourceItemIds: [] },
    { ...input, sourceItemIds: [0] },
    { ...input, sourceItemIds: [100, 100] },
    { ...input, previous: [...previous, previous[0]] },
    { ...input, previous: [{ ...previous[0], physicalItemId: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...input, previous: [...previous, { ...previous[0], physicalItemId: 99, providerOrderId: "conflicting" }] },
    { ...input, previous: [...previous, { ...previous[0], physicalItemId: 99, labelStatus: "active" as const }] },
    { ...input, previous: Array.from({ length: MAX_LABEL_REPLACEMENT_ITEMS + 1 }, (_, index) => ({
      ...previous[0], physicalItemId: index + 1, physicalShipmentId: index + 1 })) },
  ])("rejects invalid, conflicting, or truncated candidate evidence %#", invalid => {
    expect(scopeLabelReplacementPredecessors(invalid)).toEqual({ outcome: "review", reason: "invalid_replacement_scope" });
  });
});
