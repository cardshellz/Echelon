import { describe, expect, it } from "vitest";

import {
  coverageGroupsFromDraftLayout,
  layoutWithSavedGroupIdentities,
  readDraftLayout,
  type DraftLayoutInput,
} from "../../application/rate-table-draft-layout";

describe("rate table draft layout helpers", () => {
  it("clears source destination-group identities for a cross-program copy", () => {
    const groups = coverageGroupsFromDraftLayout(layout(), {
      clearDestinationGroupIdentity: true,
    });

    expect(groups).toEqual([{
      destinationGroupId: null,
      destinationGroupLockVersion: null,
      name: "West Coast",
      originWarehouseId: null,
      availability: "offered",
      sortOrder: 0,
      destinations: [
        {
          destinationCountry: "US",
          destinationRegion: "CA",
          postalPrefix: null,
        },
        {
          destinationCountry: "US",
          destinationRegion: "OR",
          postalPrefix: null,
        },
        {
          destinationCountry: "US",
          destinationRegion: "CA",
          postalPrefix: "902",
        },
      ],
    }]);
  });

  it("remaps a copied layout to the saved target-program identities", () => {
    const remapped = layoutWithSavedGroupIdentities(layout(), [{
      destinationGroupId: 81,
      destinationGroupLockVersion: 4,
      name: "West Coast",
      originWarehouseId: null,
      availability: "offered",
      sortOrder: 0,
      destinations: [],
    }]);

    expect(remapped.version).toBe(2);
    expect(remapped.groups[0]).toMatchObject({
      destinationGroupId: 81,
      destinationGroupLockVersion: 4,
      name: "West Coast",
      availability: "offered",
    });
    expect(remapped.groups[0]?.bands).toEqual(layout().groups[0]?.bands);
  });

  it("returns null instead of trusting malformed metadata", () => {
    expect(readDraftLayout({
      draftLayout: {
        version: 2,
        groups: [{ name: "Missing required fields" }],
      },
    })).toBeNull();
  });
});

function layout(): DraftLayoutInput {
  return {
    version: 2,
    groups: [{
      destinationGroupId: 41,
      destinationGroupLockVersion: 2,
      name: "West Coast",
      originWarehouseId: null,
      regions: ["ca", "or"],
      zipEntries: [{ state: "ca", prefixes: ["902"] }],
      bands: [{
        maxMeasure: "453",
        rateUsd: "6.99",
        maxShipmentWeightLb: "",
      }],
      pricingModel: "weight_bands",
      baseChargeUsd: "",
      perStartedPoundUsd: "",
      availability: "offered",
    }],
  };
}
