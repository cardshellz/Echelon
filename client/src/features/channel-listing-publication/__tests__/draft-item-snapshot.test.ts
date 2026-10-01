import { describe, expect, it } from "vitest";
import {
  listingDraftItemSchema,
  type ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import {
  assertListingDraftItemUnchanged,
  listingDraftItemsFingerprint,
} from "../draft-item-snapshot";

function item(variantId: number): ListingDraftItem {
  return listingDraftItemSchema.parse({
    variantId,
    attributes: { Visible: { color: "Red", size: "Small" } },
  });
}

describe("listing draft snapshots", () => {
  it("rejects a concurrent change to the edited item", () => {
    const snapshot = item(1);
    expect(() =>
      assertListingDraftItemUnchanged(snapshot, {
        ...snapshot,
        title: "Another operator's title",
      }),
    ).toThrow("This draft item changed while editing was open");
    expect(() =>
      assertListingDraftItemUnchanged(snapshot, {
        ...snapshot,
        attributes: { Visible: { color: "Blue", size: "Small" } },
      }),
    ).toThrow("This draft item changed while editing was open");
  });

  it("ignores object property order, including nested attributes", () => {
    const snapshot = item(1);
    const reordered = {
      ...snapshot,
      attributes: { Visible: { size: "Small", color: "Red" } },
    };
    expect(() =>
      assertListingDraftItemUnchanged(snapshot, reordered),
    ).not.toThrow();
    expect(listingDraftItemsFingerprint([snapshot])).toBe(
      listingDraftItemsFingerprint([reordered]),
    );
  });

  it("allows another item to change while the selected item stays unchanged", () => {
    const snapshot = item(1);
    const currentDraft = [
      { ...item(2), title: "Updated unrelated item" },
      structuredClone(snapshot),
    ];
    expect(() =>
      assertListingDraftItemUnchanged(
        snapshot,
        currentDraft.find(
          (current) => current.variantId === snapshot.variantId,
        ),
      ),
    ).not.toThrow();
  });

  it("rejects a removed or replaced item", () => {
    expect(() => assertListingDraftItemUnchanged(item(1), undefined)).toThrow(
      "This draft item is no longer available",
    );
    expect(() => assertListingDraftItemUnchanged(item(1), item(2))).toThrow(
      "This draft item changed while editing was open",
    );
  });

  it("preserves array order and raw content differences", () => {
    const snapshot = {
      ...item(1),
      title: "Title",
      images: ["https://example.com/a.png", "https://example.com/b.png"],
    };
    expect(() =>
      assertListingDraftItemUnchanged(snapshot, {
        ...snapshot,
        images: [...snapshot.images].reverse(),
      }),
    ).toThrow("This draft item changed while editing was open");
    expect(() =>
      assertListingDraftItemUnchanged(snapshot, {
        ...snapshot,
        title: " Title ",
      }),
    ).toThrow("This draft item changed while editing was open");
  });

  it("ignores selection ordering without mutating either snapshot", () => {
    const items = [item(2), item(1)];
    const before = structuredClone(items);
    expect(listingDraftItemsFingerprint(items)).toBe(
      listingDraftItemsFingerprint([...items].reverse()),
    );
    expect(items).toEqual(before);
  });

  it("rejects malformed snapshots before recursive comparison", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      listingDraftItemsFingerprint([{ ...item(1), attributes: circular }]),
    ).toThrow();
    expect(() => listingDraftItemsFingerprint([item(1), item(1)])).toThrow(
      "Each draft variant must appear once",
    );
  });
});
