import { describe, expect, it } from "vitest";
import { assertUnpublishedListingGroup, planUnpublishedListingTarget } from "../../domain/unpublished-listing-target";

function members() {
  return ["CASE", "PACK"].map(sku => ({ sku, inventoryItemExists: true, groupKeys: [] as string[],
    offers: [{ id: `offer-${sku}`, sku, state: "unpublished" as const, hasListing: false }] }));
}

describe("shared unpublished listing preparation policy", () => {
  it("reuses unpublished offers without pretending an absent group is published", () => {
    const selected = members();
    const before = structuredClone(selected);
    const target = planUnpublishedListingTarget({ requiresGroup: true, members: selected, plannedGroupKey: "PRODUCT" })!;
    expect(target).toEqual({ groupKey: "PRODUCT", skus: ["CASE", "PACK"], allowMissingGroup: true });
    expect(() => assertUnpublishedListingGroup(target, null)).not.toThrow();
    expect(selected).toEqual(before);
  });
  it("requires an explicit preparation target for an ungrouped multi-variant product", () => {
    expect(() => planUnpublishedListingTarget({ requiresGroup: true, members: members() })).toThrow(expect.objectContaining({ code: "GROUP_REQUIRED" }));
  });
  it("supports absent inventory/offer resources and mixed progress in one saved preparation", () => {
    const selected = members(); selected[1].inventoryItemExists = false; selected[1].offers = [];
    expect(planUnpublishedListingTarget({ requiresGroup: true, members: selected })).toBeNull();
    expect(planUnpublishedListingTarget({ requiresGroup: true, members: selected, plannedGroupKey: "PRODUCT" })).toMatchObject({ allowMissingGroup: true });
  });
  it.each(["published", "listing", "foreign SKU", "multiple offers"])("does not authorize preparation for %s", fault => {
    const selected = members();
    if (fault === "published") Object.assign(selected[1].offers[0], { state: "published" });
    if (fault === "listing") selected[1].offers[0].hasListing = true;
    if (fault === "foreign SKU") selected[1].offers[0].sku = "FOREIGN";
    if (fault === "multiple offers") selected[1].offers.push({ ...selected[1].offers[0], id: "extra" });
    expect(planUnpublishedListingTarget({ requiresGroup: true, members: selected, plannedGroupKey: "PRODUCT" })).toBeNull();
  });
  it("rejects duplicate offer identities even when the group is absent", () => {
    const selected = members(); selected[1].offers[0].id = selected[0].offers[0].id;
    expect(() => planUnpublishedListingTarget({ requiresGroup: true, members: selected, plannedGroupKey: "PRODUCT" }))
      .toThrow(expect.objectContaining({ code: "MEMBER_IDENTITY_DUPLICATE" }));
  });
  it("rejects another group and validates complete existing group membership", () => {
    const selected = members(); selected[0].groupKeys = ["OTHER"];
    expect(() => planUnpublishedListingTarget({ requiresGroup: true, members: selected, plannedGroupKey: "PRODUCT" }))
      .toThrow(expect.objectContaining({ code: "GROUP_CHANGED" }));
    const target = planUnpublishedListingTarget({ requiresGroup: true, members: members(), plannedGroupKey: "PRODUCT" })!;
    for (const actual of [["CASE"], ["CASE", "PACK", "FOREIGN"], ["CASE", "CASE"]])
      expect(() => assertUnpublishedListingGroup(target, actual)).toThrow(expect.objectContaining({ code: "GROUP_MEMBERSHIP_MISMATCH" }));
    expect(() => assertUnpublishedListingGroup(target, ["PACK", "CASE"])).not.toThrow();
  });
  it("requires a group referenced by observed inventory to exist", () => {
    const selected = members(); selected[0].groupKeys = ["PRODUCT"];
    const target = planUnpublishedListingTarget({ requiresGroup: true, members: selected, plannedGroupKey: "PRODUCT" })!;
    expect(target.allowMissingGroup).toBe(false);
    expect(() => assertUnpublishedListingGroup(target, null)).toThrow(expect.objectContaining({ code: "GROUP_MEMBERSHIP_MISMATCH" }));
  });
  it("keeps ungrouped channels ungrouped and rejects an inconsistent target", () => {
    expect(planUnpublishedListingTarget({ requiresGroup: false, members: members().slice(0, 1), plannedGroupKey: null }))
      .toEqual({ groupKey: null, skus: ["CASE"], allowMissingGroup: false });
    expect(() => planUnpublishedListingTarget({ requiresGroup: false, members: members().slice(0, 1), plannedGroupKey: "PRODUCT" }))
      .toThrow(expect.objectContaining({ code: "GROUP_CHANGED" }));
  });
  it("supports channels whose multi-variant listings do not require a separate group resource", () => {
    expect(planUnpublishedListingTarget({ requiresGroup: false, members: members(), plannedGroupKey: null }))
      .toEqual({ groupKey: null, skus: ["CASE", "PACK"], allowMissingGroup: false });
  });
  it("can resume a saved explicit group containing just one variant", () => {
    expect(planUnpublishedListingTarget({ requiresGroup: true, members: members().slice(0, 1), plannedGroupKey: "PRODUCT" }))
      .toEqual({ groupKey: "PRODUCT", skus: ["CASE"], allowMissingGroup: true });
  });
  it("validates empty and malformed selections at the boundary", () => {
    expect(() => planUnpublishedListingTarget({ requiresGroup: true, members: [], plannedGroupKey: "PRODUCT" })).toThrow();
    expect(() => planUnpublishedListingTarget({ requiresGroup: true, members: members(), plannedGroupKey: " " })).toThrow();
  });
});
