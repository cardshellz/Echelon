import { describe, expect, it } from "vitest";
import {
  listingDraftItemSchema,
  type ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import {
  applyBulkEditBatch,
  previewBulkEditBatch,
  resetBulkAttributeEdits,
  setBulkItemAttribute,
  setBulkSharedAttribute,
  undoBulkItemAttribute,
  undoBulkSharedAttribute,
  type BulkEditCommand,
} from "../bulk-edit-batch";

const empty = (): BulkEditCommand => ({ shared: {}, itemChanges: [] });
const weight = ["Orderable", "shippingWeight"];
const width = ["Visible", "dimensions", "width"];
const item = (variantId: number, overrides: Partial<ListingDraftItem> = {}) =>
  listingDraftItemSchema.parse({
    variantId,
    productType: "Card Protection",
    identifier: {
      type: "UPC",
      value: variantId === 1 ? "012345678905" : "036000291452",
    },
    attributes: {
      Orderable: { shippingWeight: variantId },
      Visible: {
        color: "Clear",
        dimensions: { width: variantId, height: 10 },
        shipsInOwnContainer: false,
      },
    },
    ...overrides,
  });

describe("bulk listing table edit batches", () => {
  it("changes shared category and applies different row characteristics after clearing old attributes", () => {
    const original = [item(1), item(2)];
    let command: BulkEditCommand = {
      shared: { productType: "Card Storage" },
      itemChanges: [],
    };
    command = setBulkItemAttribute(command, 1, weight, 0.25);
    command = setBulkItemAttribute(command, 2, weight, 2.5);
    const result = previewBulkEditBatch(original, command);
    expect(result.preview).toMatchObject({ changedCount: 2, resetCount: 2 });
    expect(result.effectiveItems.map((row) => row.attributes)).toEqual([
      { Orderable: { shippingWeight: 0.25 } },
      { Orderable: { shippingWeight: 2.5 } },
    ]);
    expect(result.effectiveItems.map((row) => row.identifier)).toEqual(
      original.map((row) => row.identifier),
    );
    expect(original).toEqual([item(1), item(2)]);
  });

  it("supports 100 selected rows with shared content and distinct weight, dimensions, and false/true packaging settings", () => {
    const rows = Array.from({ length: 100 }, (_, index) => item(index + 1));
    const command: BulkEditCommand = {
      shared: { brand: "Card Shellz" },
      itemChanges: rows.map((row, index) => ({
        variantId: row.variantId,
        patch: {
          attributeChanges: [
            { path: weight, action: "set", value: index + 0.5 },
            { path: width, action: "set", value: index },
            {
              path: ["Visible", "shipsInOwnContainer"],
              action: "set",
              value: index % 2 === 0,
            },
          ],
        },
      })),
    };
    const result = applyBulkEditBatch(rows, rows, command);
    expect(result).toHaveLength(100);
    for (const [index, row] of result.entries()) {
      expect(row).toMatchObject({
        brand: "Card Shellz",
        attributes: {
          Orderable: { shippingWeight: index + 0.5 },
          Visible: {
            dimensions: { width: index, height: 10 },
            shipsInOwnContainer: index % 2 === 0,
            color: "Clear",
          },
        },
      });
    }
  });

  it("new Apply to all replaces overlapping row overrides while preserving unrelated row fields", () => {
    let command = setBulkItemAttribute(empty(), 1, ["Visible", "dimensions"], {
      width: 5,
      height: 20,
    });
    command = setBulkItemAttribute(command, 2, weight, 0.5);
    command = setBulkSharedAttribute(command, width, 8);
    const result = previewBulkEditBatch([item(1), item(2)], command);
    expect(result.effectiveItems[0].attributes.Visible).toMatchObject({
      dimensions: { width: 8, height: 20 },
    });
    expect(result.effectiveItems[1].attributes).toMatchObject({
      Orderable: { shippingWeight: 0.5 },
      Visible: { dimensions: { width: 8, height: 10 } },
    });
  });

  it("individual edits made after Apply to all override only that row, and Undo restores the shared value", () => {
    const shared = setBulkSharedAttribute(empty(), weight, 10);
    const changed = setBulkItemAttribute(shared, 2, weight, 20);
    expect(
      previewBulkEditBatch([item(1), item(2)], changed).effectiveItems.map(
        (row) => row.attributes.Orderable,
      ),
    ).toEqual([{ shippingWeight: 10 }, { shippingWeight: 20 }]);
    const undone = undoBulkItemAttribute(changed, 2, weight);
    expect(
      previewBulkEditBatch([item(1), item(2)], undone).effectiveItems.map(
        (row) => row.attributes.Orderable,
      ),
    ).toEqual([{ shippingWeight: 10 }, { shippingWeight: 10 }]);
    expect(undoBulkSharedAttribute(undone, weight)).toEqual(empty());
  });

  it("rejects edits beneath a pending group clear instead of resurrecting unrelated original siblings", () => {
    const rows = [item(1), item(2)];
    const group = ["Visible", "dimensions"];
    const cleared = setBulkItemAttribute(empty(), 1, group, undefined);
    const before = structuredClone(cleared);
    expect(() => setBulkSharedAttribute(cleared, width, 5)).toThrow(
      "Undo the pending clear of Visible › dimensions",
    );
    expect(() => setBulkItemAttribute(cleared, 1, width, 5)).toThrow(
      "Undo the pending clear",
    );
    expect(() => undoBulkItemAttribute(cleared, 1, width)).toThrow(
      "Undo the pending clear",
    );
    expect(cleared).toEqual(before);
    expect(
      previewBulkEditBatch(rows, cleared).effectiveItems[0].attributes.Visible,
    ).not.toHaveProperty("dimensions");
    const undone = undoBulkItemAttribute(cleared, 1, group);
    expect(
      previewBulkEditBatch(rows, setBulkSharedAttribute(undone, width, 5))
        .effectiveItems[0].attributes.Visible,
    ).toMatchObject({ dimensions: { width: 5, height: 10 } });
  });

  it("clearing a cell explicitly removes only that row's value and Undo restores it", () => {
    const command = setBulkItemAttribute(empty(), 1, width, undefined);
    expect(
      previewBulkEditBatch([item(1), item(2)], command).effectiveItems[0]
        .attributes.Visible,
    ).toEqual({
      color: "Clear",
      dimensions: { height: 10 },
      shipsInOwnContainer: false,
    });
    expect(undoBulkItemAttribute(command, 1, width)).toEqual(empty());
  });

  it("category changes discard only pending attribute edits, leaving unrelated shared and row content intact", () => {
    const command: BulkEditCommand = {
      shared: {
        brand: "Shared",
        attributeChanges: [{ path: weight, action: "set", value: 5 }],
      },
      itemChanges: [
        {
          variantId: 1,
          patch: {
            title: "Item title",
            attributeChanges: [{ path: width, action: "set", value: 20 }],
          },
        },
      ],
    };
    expect(resetBulkAttributeEdits(command)).toEqual({
      shared: { brand: "Shared" },
      itemChanges: [{ variantId: 1, patch: { title: "Item title" } }],
    });
  });

  it("treats a row array as an explicit replacement without changing other items", () => {
    const rows = [
      item(1, { attributes: { Visible: { features: ["a", "b"] } } }),
      item(2, { attributes: { Visible: { features: ["c"] } } }),
    ];
    const command = setBulkItemAttribute(
      empty(),
      1,
      ["Visible", "features"],
      ["new"],
    );
    const result = previewBulkEditBatch(rows, command);
    expect(result.effectiveItems.map((row) => row.attributes)).toEqual([
      { Visible: { features: ["new"] } },
      { Visible: { features: ["c"] } },
    ]);
    expect(result.preview.items[0].changes).toEqual([
      {
        path: ["attributes", "Visible", "features"],
        before: ["a", "b"],
        after: ["new"],
      },
    ]);
  });

  it("rejects the whole batch if a selected draft changed or disappeared", () => {
    const rows = [item(1), item(2)];
    const command = setBulkItemAttribute(empty(), 1, weight, 5);
    const current = [rows[0], { ...rows[1], brand: "New operator brand" }];
    expect(() => applyBulkEditBatch(current, rows, command)).toThrow(
      /changed while bulk editing/,
    );
    expect(() => applyBulkEditBatch([rows[0]], rows, command)).toThrow(
      /no longer available/,
    );
    expect(current[0]).toEqual(rows[0]);
  });

  it("preserves newer unselected items when applying the selected rows", () => {
    const original = [item(1), item(2), item(3)];
    const latest = [
      ...original.slice(0, 2),
      { ...original[2], brand: "Unselected change" },
    ];
    const result = applyBulkEditBatch(
      latest,
      original.slice(0, 2),
      setBulkItemAttribute(empty(), 1, weight, 5),
    );
    expect(result[2]).toBe(latest[2]);
    expect(result[1]).toBe(latest[1]);
  });

  it("rejects an invalid final row atomically and disallows identifier injection", () => {
    const rows = [item(1), item(2)];
    const command: BulkEditCommand = {
      shared: {},
      itemChanges: [
        { variantId: 1, patch: { brand: "Allowed" } },
        { variantId: 2, patch: { priceOverrideCents: 0 } },
      ],
    };
    expect(() => applyBulkEditBatch(rows, rows, command)).toThrow();
    expect(rows).toEqual([item(1), item(2)]);
    expect(() =>
      setBulkItemAttribute(empty(), 1, ["Orderable", "productIdentifiers"], {
        productId: "x",
      }),
    ).toThrow(/Identifiers/);
    expect(() =>
      setBulkSharedAttribute(empty(), ["Visible", "__proto__"], "x"),
    ).toThrow();
  });

  it("rejects duplicate, unselected, oversized, readonly, and malformed commands", () => {
    const rows = [item(1), item(2)];
    const command = setBulkItemAttribute(empty(), 1, weight, 5);
    expect(() =>
      applyBulkEditBatch(rows, rows, command, { canEdit: false }),
    ).toThrow(/permission/);
    expect(() =>
      previewBulkEditBatch(rows, {
        ...command,
        itemChanges: [...command.itemChanges, ...command.itemChanges],
      }),
    ).toThrow(/only one/);
    expect(() =>
      previewBulkEditBatch(rows, setBulkItemAttribute(empty(), 3, weight, 5)),
    ).toThrow(/outside/);
    expect(() =>
      previewBulkEditBatch(
        Array.from({ length: 101 }, (_, index) => item(index + 1)),
        empty(),
      ),
    ).toThrow(/100/);
    expect(() =>
      previewBulkEditBatch(rows, {
        ...empty(),
        extra: true,
      } as BulkEditCommand),
    ).toThrow();
  });

  it("empty and effective no-op edits never enable applying a batch", () => {
    const rows = [item(1)];
    expect(previewBulkEditBatch(rows, empty()).preview.changedCount).toBe(0);
    const unchanged = setBulkItemAttribute(empty(), 1, weight, 1);
    expect(previewBulkEditBatch(rows, unchanged).preview.changedCount).toBe(0);
    expect(() => applyBulkEditBatch(rows, rows, unchanged)).toThrow(
      /at least one field/,
    );
  });

  it("a mixed category selection can keep separate row values but cannot apply ambiguous shared attributes", () => {
    const rows = [item(1), item(2, { productType: "Card Storage" })];
    expect(() =>
      previewBulkEditBatch(rows, setBulkSharedAttribute(empty(), weight, 5)),
    ).toThrow(/common listing method/);
    expect(
      previewBulkEditBatch(rows, setBulkItemAttribute(empty(), 1, weight, 5))
        .effectiveItems[1],
    ).toBe(rows[1]);
  });
});
