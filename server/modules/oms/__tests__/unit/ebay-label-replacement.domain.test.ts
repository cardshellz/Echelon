import { describe, expect, it } from "vitest";
import { decideEbayLabelReplacement } from "../../ebay-label-replacement.domain";

describe("eBay label replacement quantity authority", () => {
  const contents = [{ sourceItemId: 1, quantity: 2 }, { sourceItemId: 2, quantity: 1 }];
  const previous = [{ sourceItemId: 1, quantity: 2, physicalItemId: 20, labelStatus: "voided" as const, carrierPossession: false }];
  it("transfers the original allocation while admitting a newly combined order", () => {
    expect(decideEbayLabelReplacement({ contents, previous })).toEqual({ outcome: "transfer", physicalItemIds: [20] });
  });
  it("supports two previously allocated orders", () => {
    expect(decideEbayLabelReplacement({ contents, previous: [...previous,
      { ...previous[0], sourceItemId: 2, quantity: 1, physicalItemId: 21 }] })).toEqual({ outcome: "transfer", physicalItemIds: [20, 21] });
  });
  it("waits for a late void rather than guessing that an overlapping label replaces another", () => {
    expect(decideEbayLabelReplacement({ contents, previous: [{ ...previous[0], labelStatus: "active" }] })).toMatchObject({ outcome: "waiting" });
  });
  it.each([
    { ...previous[0], carrierPossession: true },
    { ...previous[0], quantity: 1 },
    { ...previous[0], sourceItemId: 99 },
    { ...previous[0], quantity: 0 },
    { ...previous[0], quantity: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects unsafe predecessor evidence %j", prior => {
    expect(decideEbayLabelReplacement({ contents, previous: [prior] })).toMatchObject({ outcome: "review" });
  });
  it("rejects ambiguous split allocations and duplicate sources", () => {
    expect(decideEbayLabelReplacement({ contents, previous: [...previous, previous[0]] })).toMatchObject({ outcome: "review" });
    expect(decideEbayLabelReplacement({ contents: [...contents, contents[0]], previous })).toMatchObject({ outcome: "review" });
  });
  it("rejects matching quantities that exceed safe integer precision", () => {
    const quantity = Number.MAX_SAFE_INTEGER + 1;
    expect(decideEbayLabelReplacement({ contents: [{ sourceItemId: 1, quantity }],
      previous: [{ ...previous[0], quantity }] })).toEqual({ outcome: "review", reason: "invalid_replacement_evidence" });
  });
});
