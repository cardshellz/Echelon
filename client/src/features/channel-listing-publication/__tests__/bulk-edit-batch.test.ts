import { describe, expect, it } from "vitest";
import {
  listingDraftItemSchema,
  saveListingDraftSchema,
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
  bulkEditCommandSchema,
  setBulkItemField,
  undoBulkItemField,
  setBulkSharedField,
  setBulkSharedContext,
  type BulkEditCommand,
} from "../bulk-edit-batch";
import { parseBulkGridField } from "../bulk-grid-state";

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
  it("keeps pending attributes on an unchanged typed row when a shared category fills missing rows", () => {
    const rows = [item(1), item(2, { productType: "", attributes: {} })];
    const original = setBulkItemAttribute(empty(), 1, weight, 0.25);
    const command = setBulkSharedContext(
      rows,
      original,
      "productType",
      "Card Protection",
    );
    const result = previewBulkEditBatch(rows, command);
    expect(result.effectiveItems[0].attributes).toEqual({
      ...rows[0].attributes,
      Orderable: { shippingWeight: 0.25 },
    });
    expect(result.effectiveItems[1]).toMatchObject({
      productType: "Card Protection",
      attributes: {},
    });
    expect(original.itemChanges[0].patch.attributeChanges).toHaveLength(1);
    expect(
      setBulkSharedContext(rows, command, "productType", "Card Protection"),
    ).toEqual(command);
  });
  it("clears only changed row contexts and shared attributes when switching a shared category", () => {
    const rows = [item(1), item(2)];
    let command = setBulkSharedAttribute(empty(), weight, 1.5);
    command = setBulkItemField(command, 1, "productType", "Card Protection");
    command = setBulkItemAttribute(command, 1, width, 9);
    command = setBulkItemAttribute(command, 2, width, 8);
    const next = setBulkSharedContext(
      rows,
      command,
      "productType",
      "Card Storage",
    );
    expect(next.shared.attributeChanges).toBeUndefined();
    expect(
      next.itemChanges.find((change) => change.variantId === 1)?.patch
        .attributeChanges,
    ).toHaveLength(1);
    expect(
      next.itemChanges.find((change) => change.variantId === 2),
    ).toBeUndefined();
    expect(
      previewBulkEditBatch(rows, next).effectiveItems.map(
        (row) => row.productType,
      ),
    ).toEqual(["Card Protection", "Card Storage"]);
  });
  it.each(["identifier first", "category first"])(
    "retains a selected row's GTIN and category through the save payload (%s)",
    (order) => {
      const selected = item(1, {
        productType: "",
        identifier: null,
        attributes: {},
      });
      const unselected = item(2, {
        productType: "",
        identifier: null,
        attributes: {},
      });
      const current = [selected, unselected];
      const identifier = parseBulkGridField(
        "identifier",
        "00012345678905",
        "GTIN",
      );
      let command = empty();
      const chooseCategory = (previous: BulkEditCommand) =>
        resetBulkAttributeEdits({
          ...previous,
          shared: { ...previous.shared, productType: "Card Protection" },
        });
      if (order === "identifier first") {
        command = setBulkItemField(
          command,
          selected.variantId,
          "identifier",
          identifier,
        );
        command = chooseCategory(command);
      } else {
        command = chooseCategory(command);
        command = setBulkItemField(
          command,
          selected.variantId,
          "identifier",
          identifier,
        );
      }
      const next = applyBulkEditBatch(
        current,
        [structuredClone(selected)],
        command,
      );
      const savedInput = saveListingDraftSchema.parse({
        expectedRevision: 4,
        items: next,
      });
      expect(savedInput.items[0]).toMatchObject({
        variantId: 1,
        productType: "Card Protection",
        identifier: { type: "GTIN", value: "00012345678905" },
      });
      expect(savedInput.items[1]).toEqual(unselected);
      expect(current).toEqual([selected, unselected]);
      // A successful editor rebase clears the command, not the saved row values.
      expect(
        previewBulkEditBatch([savedInput.items[0]], empty()).effectiveItems[0],
      ).toEqual(savedInput.items[0]);
    },
  );
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

  it("edits one row's identifier without permitting shared identifier copying or changing another row", () => {
    const rows = [item(1), item(2)];
    const identifier = { type: "GTIN" as const, value: "00012345678905" };
    const command = setBulkItemField(empty(), 1, "identifier", identifier);
    const result = applyBulkEditBatch(rows, rows, command);
    expect(result[0].identifier).toEqual(identifier);
    expect(result[1]).toBe(rows[1]);
    expect(rows[0].identifier).toEqual(item(1).identifier);
    expect(undoBulkItemField(command, 1, "identifier")).toEqual(empty());
    expect(
      bulkEditCommandSchema.safeParse({
        shared: { identifier },
        itemChanges: [],
      }).success,
    ).toBe(false);
    expect(() =>
      setBulkSharedField(empty(), "identifier" as never, identifier),
    ).toThrow(/cannot be copied/);
    expect(() => setBulkItemField(empty(), 1, "sku" as never, "NEW")).toThrow(
      /cannot be changed/,
    );
    expect(() => setBulkItemField(empty(), 1, "identifier", undefined)).toThrow(
      /identifier/,
    );
  });

  it("column content defaults preserve row overrides unless replacement is explicit", () => {
    const rows = [item(1), item(2)];
    const individual = setBulkItemField(empty(), 1, "brand", "Individual");
    const defaults = setBulkSharedField(individual, "brand", "Column default");
    expect(
      previewBulkEditBatch(rows, defaults).effectiveItems.map(
        (row) => row.brand,
      ),
    ).toEqual(["Individual", "Column default"]);
    expect(
      previewBulkEditBatch(
        rows,
        undoBulkItemField(defaults, 1, "brand"),
      ).effectiveItems.map((row) => row.brand),
    ).toEqual(["Column default", "Column default"]);
    const replaced = setBulkSharedField(
      defaults,
      "brand",
      "Replace all",
      "replace-all",
    );
    expect(
      previewBulkEditBatch(rows, replaced).effectiveItems.map(
        (row) => row.brand,
      ),
    ).toEqual(["Replace all", "Replace all"]);
    expect(replaced.itemChanges).toEqual([]);
  });

  it("preserves row attribute overrides when updating a column default in preserve mode", () => {
    const rows = [item(1), item(2)];
    const row = setBulkItemAttribute(empty(), 1, weight, 2);
    const defaults = setBulkSharedAttribute(
      row,
      weight,
      5,
      "preserve-overrides",
    );
    expect(
      previewBulkEditBatch(rows, defaults).effectiveItems.map(
        (row) => row.attributes.Orderable,
      ),
    ).toEqual([{ shippingWeight: 2 }, { shippingWeight: 5 }]);
    const changed = setBulkSharedAttribute(
      defaults,
      weight,
      10,
      "preserve-overrides",
    );
    expect(
      previewBulkEditBatch(rows, changed).effectiveItems.map(
        (row) => row.attributes.Orderable,
      ),
    ).toEqual([{ shippingWeight: 2 }, { shippingWeight: 10 }]);
    expect(
      previewBulkEditBatch(
        rows,
        undoBulkItemAttribute(changed, 1, weight),
      ).effectiveItems.map((row) => row.attributes.Orderable),
    ).toEqual([{ shippingWeight: 10 }, { shippingWeight: 10 }]);
  });

  it("keeps explicit per-row inheritance independent of a shared fixed price and content override", () => {
    const rows = [item(1), item(2)];
    let command = setBulkSharedField(empty(), "priceOverrideCents", 1599);
    command = setBulkItemField(command, 1, "priceOverrideCents", null);
    command = setBulkSharedField(command, "title", "Shared title");
    command = setBulkItemField(command, 2, "title", null);
    command = setBulkItemField(command, 1, "identifier", null);
    const result = previewBulkEditBatch(rows, command).effectiveItems;
    expect(result.map((row) => row.priceOverrideCents)).toEqual([null, 1599]);
    expect(result.map((row) => row.title)).toEqual(["Shared title", null]);
    expect(result.map((row) => row.identifier)).toEqual([
      null,
      rows[1].identifier,
    ]);
  });

  it("resolves final row context once so an original-type override preserves original attributes", () => {
    const rows = [
      item(1, { productType: "Type B" }),
      item(2, { productType: "Type B" }),
    ];
    let command: BulkEditCommand = {
      shared: { productType: "Type A" },
      itemChanges: [],
    };
    command = setBulkItemField(command, 1, "productType", "Type B");
    const result = previewBulkEditBatch(rows, command);
    expect(result.effectiveItems[0]).toBe(rows[0]);
    expect(result.effectiveItems[1]).toMatchObject({
      productType: "Type A",
      attributes: {},
    });
    expect(result.preview.resetCount).toBe(1);
    expect(() =>
      previewBulkEditBatch(
        rows,
        setBulkSharedAttribute(command, weight, 4, "preserve-overrides"),
      ),
    ).toThrow(/common listing method/);
  });

  it("per-row context changes clear only pending schema attributes, retaining content and identifiers", () => {
    let command = setBulkItemAttribute(empty(), 1, weight, 3);
    command = setBulkItemField(command, 1, "title", "Custom title");
    command = setBulkItemField(command, 1, "identifier", null);
    command = setBulkItemField(command, 1, "productType", "New type");
    expect(command.itemChanges[0].patch).toEqual({
      title: "Custom title",
      identifier: null,
      productType: "New type",
    });
    expect(
      undoBulkItemField(command, 1, "productType").itemChanges[0].patch,
    ).toEqual({ title: "Custom title", identifier: null });
  });

  it.each([
    ["method", "create", "create"],
    ["productType", "Card Protection", "  Card Protection  "],
  ] as const)(
    "preserves pending attributes when setting the same normalized %s",
    (field, value, repeated) => {
      let command = setBulkItemField(empty(), 1, field, value);
      command = setBulkItemAttribute(command, 1, weight, 0);
      command = setBulkItemField(command, 1, "title", "Pending title");
      const before = structuredClone(command);
      const result = setBulkItemField(command, 1, field, repeated);
      expect(result).toEqual(before);
      expect(command).toEqual(before);
      expect(result.itemChanges[0].patch.attributeChanges).toEqual([
        { path: weight, action: "set", value: 0 },
      ]);
    },
  );

  it.each(["method", "productType"] as const)(
    "does not discard attributes when undoing an absent %s override",
    (field) => {
      let command = setBulkItemAttribute(empty(), 1, weight, 3);
      command = setBulkItemField(command, 1, "title", "Pending title");
      const before = structuredClone(command);
      expect(undoBulkItemField(command, 1, field)).toEqual(before);
      expect(undoBulkItemField(command, 2, field)).toEqual(before);
      expect(command).toEqual(before);
    },
  );

  it.each([
    ["method", "create", "match"],
    ["productType", "Card Protection", "Card Storage"],
  ] as const)(
    "still clears schema-bound edits when changing or undoing a pending %s override",
    (field, first, next) => {
      let command = setBulkItemField(empty(), 1, field, first);
      command = setBulkItemAttribute(command, 1, weight, 3);
      command = setBulkItemField(command, 1, "identifier", null);
      const before = structuredClone(command);
      expect(
        setBulkItemField(command, 1, field, next).itemChanges[0].patch,
      ).toEqual({
        [field]: next,
        identifier: null,
      });
      expect(undoBulkItemField(command, 1, field).itemChanges[0].patch).toEqual(
        {
          identifier: null,
        },
      );
      expect(command).toEqual(before);
    },
  );
});
