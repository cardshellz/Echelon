import { describe, expect, it } from "vitest";
import { planLabelReplacement, type LabelReplacementPlanInput } from "../../label-replacement-plan.domain";

const prior = (id: number, quantity: number, order = String(id), source = 1) => ({ physicalItemId: id,
  physicalShipmentId: id, sourceItemId: source, quantity, providerOrderId: order,
  labelStatus: "voided" as const, carrierPossession: false });
const label = (id: number, quantity: number, order = String(id), source = 1) => ({ labelId: id,
  providerOrderId: order, contents: [{ sourceItemId: source, quantity }] });
describe("conserving label repack plans", () => {
  it("waits for the second half then splits a two-unit package atomically", () => {
    const previous = [prior(1, 2)];
    expect(planLabelReplacement({ labelId: 10, previous, candidates: [label(10, 1, '1')] }))
      .toEqual({ outcome: 'waiting', reason: 'replacement_repack_incomplete' });
    const candidates = [label(10, 1, '1'), label(11, 1)];
    for (const labelId of [10, 11]) expect(planLabelReplacement({ labelId, previous, candidates }))
      .toEqual({ outcome: 'transfer', physicalItemIds: [1], labelIds: [10, 11] });
  });
  it("merges two voided portions even when the merged label retains one provider order ID", () => {
    expect(planLabelReplacement({ labelId: 10, previous: [prior(1, 1), prior(2, 1)], candidates: [label(10, 2, '1')] }))
      .toEqual({ outcome: 'transfer', physicalItemIds: [1, 2], labelIds: [10] });
  });
  it("isolates exact relabels from independently identified sibling packages", () => {
    expect(planLabelReplacement({ labelId: 10, previous: [prior(1, 1), prior(2, 1)],
      candidates: [label(10, 1, '1'), label(11, 1, '2')] }))
      .toEqual({ outcome: 'transfer', physicalItemIds: [1], labelIds: [10] });
  });
  it("does not treat two claims for one unit as a repack", () => {
    expect(planLabelReplacement({ labelId: 10, previous: [prior(1, 1)], candidates: [label(10, 1), label(11, 1)] }))
      .toEqual({ outcome: 'review', reason: 'multiple_active_replacement_candidates' });
  });
  it("covers every source in the old package before transferring any", () => {
    const previous = [prior(1, 1), { ...prior(2, 1, '1', 2), physicalShipmentId: 1 }];
    expect(planLabelReplacement({ labelId: 10, previous, candidates: [label(10, 1, '1')] }))
      .toEqual({ outcome: 'waiting', reason: 'replacement_repack_incomplete' });
    expect(planLabelReplacement({ labelId: 10, previous, candidates: [label(10, 1, '1'), label(11, 1, '2', 2)] }))
      .toEqual({ outcome: 'transfer', physicalItemIds: [1, 2], labelIds: [10, 11] });
  });
  it("never borrows a unit from an active or dispatched sibling", () => {
    expect(planLabelReplacement({ labelId: 10, previous: [prior(1, 1), { ...prior(2, 1), labelStatus: 'active' }],
      candidates: [label(10, 2, '1')] })).toMatchObject({ outcome: 'review' });
    expect(planLabelReplacement({ labelId: 10, previous: [{ ...prior(1, 2), carrierPossession: true }],
      candidates: [label(10, 2, '1')] })).toMatchObject({ outcome: 'review' });
  });
  it("allows a newly combined distinct source without transferring unrelated units", () => {
    expect(planLabelReplacement({ labelId: 10, previous: [prior(1, 1)], candidates: [{ ...label(10, 1),
      contents: [{ sourceItemId: 1, quantity: 1 }, { sourceItemId: 2, quantity: 1 }] }] }))
      .toEqual({ outcome: 'transfer', physicalItemIds: [1], labelIds: [10] });
  });
  it('waits for a late void and rejects duplicate allocation evidence', () => {
    const previous = [{ ...prior(1, 2), labelStatus: 'active' as const }];
    const candidate = label(10, 2, '1');
    expect(planLabelReplacement({ labelId: 10, previous, candidates: [candidate] })).toMatchObject({ outcome: 'waiting', reason: 'awaiting_replaced_label_void' });
    expect(planLabelReplacement({ labelId: 10, previous: [previous[0], previous[0]], candidates: [candidate] })).toMatchObject({ outcome: 'review' });
    expect(planLabelReplacement({ labelId: 10, previous, candidates: [candidate, candidate] })).toMatchObject({ outcome: 'review' });
    expect(planLabelReplacement({ labelId: 10, previous, candidates: [{ ...candidate, contents: [...candidate.contents, ...candidate.contents] }] })).toMatchObject({ outcome: 'review' });
  });
  it('keeps every source in a multi-package connected repack', () => {
    const previous = [prior(1, 2, 'old-a', 1), prior(2, 2, 'old-b', 2), { ...prior(3, 1, 'old-b', 3), physicalShipmentId: 2 }];
    const candidates = [{ ...label(10, 1, 'old-a', 1), contents: [{ sourceItemId: 1, quantity: 1 }, { sourceItemId: 2, quantity: 1 }] },
      label(11, 1, 'old-a', 1), { ...label(12, 1, 'old-b', 2), contents: [{ sourceItemId: 2, quantity: 1 }, { sourceItemId: 3, quantity: 1 }] }];
    expect(planLabelReplacement({ labelId: 10, previous, candidates })).toEqual({ outcome: 'transfer', physicalItemIds: [1, 2, 3], labelIds: [10, 11, 12] });
  });
  it("is independent of event/row order and does not mutate input", () => {
    const input: LabelReplacementPlanInput = { labelId: 11, previous: [prior(2, 1), prior(1, 2)],
      candidates: [label(11, 1, '1'), label(10, 1, '1'), label(12, 1, '2')] };
    const snapshot = structuredClone(input);
    expect(planLabelReplacement(input)).toEqual(planLabelReplacement({ ...input,
      candidates: [...input.candidates].reverse(), previous: [...input.previous].reverse() }));
    expect(input).toEqual(snapshot);
  });
  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER])("rejects invalid quantities %s", quantity => {
    expect(planLabelReplacement({ labelId: 10, previous: [prior(1, 1)], candidates: [label(10, quantity)] }))
      .toMatchObject({ outcome: 'review' });
  });
});
