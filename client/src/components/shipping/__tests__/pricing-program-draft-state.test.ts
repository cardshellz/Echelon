import { describe, expect, it } from "vitest";
import type { RateGroup } from "../rate-table-model";
import {
  cloneRateGroups,
  groupsWithSavedLayout,
  initialDraftDirtyState,
  shouldSaveBeforeReview,
} from "../pricing-programs/draft-editor-state";

function group(): RateGroup {
  return {
    id: "group-1",
    destinationGroupId: 12,
    destinationGroupLockVersion: 3,
    sourceDestinationScopeId: 7,
    sourceDestinationScopeLockVersion: 2,
    name: "Alaska and Hawaii",
    originWarehouseId: null,
    regions: ["AK", "HI"],
    zipEntries: [{ id: "zip-1", state: "AK", prefixes: ["995"] }],
    availability: "offered",
    pricingModel: "weight_bands",
    baseChargeUsd: "",
    perStartedPoundUsd: "",
    bands: [{
      id: "band-1",
      maxMeasure: "1",
      rateUsd: "11.99",
      maxShipmentWeightLb: "",
      openEnded: false,
    }],
  };
}

describe("shipping rate draft editor state", () => {
  it.each([
    {
      input: { draftId: null, hasUnsavedInitialChanges: false },
      expected: true,
    },
    {
      input: { draftId: 42, hasUnsavedInitialChanges: true },
      expected: true,
    },
    {
      input: { draftId: 42, hasUnsavedInitialChanges: false },
      expected: false,
    },
  ])("derives the initial Save-button state: %o", ({ input, expected }) => {
    expect(initialDraftDirtyState(input)).toBe(expected);
  });

  it("does not rewrite an unchanged saved draft before review", () => {
    expect(shouldSaveBeforeReview({
      draftId: 42,
      dirty: false,
      hasServerAnalysis: true,
    })).toBe(false);
  });

  it.each([
    { draftId: null, dirty: false, hasServerAnalysis: false },
    { draftId: 42, dirty: true, hasServerAnalysis: true },
    { draftId: 42, dirty: false, hasServerAnalysis: false },
  ])("saves when persisted server truth is unavailable: %o", (input) => {
    expect(shouldSaveBeforeReview(input)).toBe(true);
  });

  it("deep-copies editable nested arrays for deterministic reset", () => {
    const original = group();
    const copy = cloneRateGroups([original]);

    copy[0].regions.push("GU");
    copy[0].zipEntries[0].prefixes.push("996");
    copy[0].bands[0].rateUsd = "14.99";

    expect(original.regions).toEqual(["AK", "HI"]);
    expect(original.zipEntries[0].prefixes).toEqual(["995"]);
    expect(original.bands[0].rateUsd).toBe("11.99");
  });

  it("applies canonical identities returned by a successful save", () => {
    const saved = groupsWithSavedLayout([group()], {
      version: 3,
      groups: [{
        destinationGroupId: 99,
        destinationGroupLockVersion: 5,
        sourceDestinationScopeId: 7,
        sourceDestinationScopeLockVersion: 2,
        name: "HIPRAK",
        originWarehouseId: null,
        regions: ["AK", "HI"],
        zipEntries: [{ state: "AK", prefixes: ["995"] }],
        availability: "offered",
        pricingModel: "weight_bands",
        bands: [{ maxMeasure: "1", rateUsd: "11.99", maxShipmentWeightLb: "" }],
      }],
    });

    expect(saved[0]).toMatchObject({
      destinationGroupId: 99,
      destinationGroupLockVersion: 5,
      name: "HIPRAK",
    });
  });
});
