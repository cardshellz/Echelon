import { describe, expect, it } from "vitest";
import {
  MAX_RETURN_FLOW_PARCELS,
  type CustomerReturnFlowOrder,
} from "@shared/returns/customer-return-flow.contract";
import {
  customPreviewParcelSize,
  type PreviewParcelDraft,
} from "../../customer-return-parcels";
import {
  changePreviewPackingQuantity,
  previewPackingItemContext,
  previewParcelQuantityLimit,
  summarizePreviewPacking,
} from "../../customer-return-packing";

const order: CustomerReturnFlowOrder = {
  sourceRevision: null,
  orderReference: "TEST",
  purchasedAt: "2026-01-01T00:00:00Z",
  evaluatedAt: "2026-02-01T00:00:00Z",
  returnWindowEndsAt: "2027-01-01T00:00:00Z",
  message: null,
  boxOptions: [],
  lines: ["a", "b"].map((id) => ({
    id,
    title: "Binder",
    variant: "1 Binder",
    sku: "SAME",
    unitWeightGrams: 850,
    purchasedQuantity: 3,
    deliveredQuantity: 3,
    alreadyReturningQuantity: 0,
    eligibleQuantity: 3,
    message: null,
  })),
};
const dimensions = { lengthMm: 406.4, widthMm: 355.6, heightMm: 101.6 };
const box = (
  key: number,
  quantities: Record<string, string>,
): PreviewParcelDraft => ({
  key,
  size: customPreviewParcelSize(dimensions),
  items: Object.entries(quantities).map(([lineId, quantity]) => ({
    lineId,
    quantity,
  })),
});
const selected = [
  { lineId: "a", quantity: 2 },
  { lineId: "b", quantity: 1 },
];

describe("packing totals and purchased-unit limits", () => {
  it("limits boxes by selected units, not distinct product lines, and retains the shared maximum", () => {
    expect(
      summarizePreviewPacking(
        [{ lineId: "a", quantity: 1 }],
        [box(1, { a: "1" })],
      ),
    ).toMatchObject({
      selectedQuantity: 1,
      packedQuantity: 1,
      maximumBoxes: 1,
      canAddBox: false,
      ready: true,
    });
    expect(
      summarizePreviewPacking(
        [{ lineId: "a", quantity: 2 }],
        [box(1, { a: "2" })],
      ),
    ).toMatchObject({ maximumBoxes: 2, canAddBox: true });
    expect(
      summarizePreviewPacking([{ lineId: "a", quantity: 200 }], []),
    ).toMatchObject({ maximumBoxes: MAX_RETURN_FLOW_PARCELS });
    expect(summarizePreviewPacking([], [])).toMatchObject({
      selectedQuantity: null,
      maximumBoxes: 0,
      canAddBox: false,
      ready: false,
    });
  });

  it("summarizes each purchased line across every box, preserving identical product identities", () => {
    const summary = summarizePreviewPacking(selected, [
      box(1, { a: "1", b: "1" }),
      box(2, { a: "1", b: "0" }),
    ]);
    expect(summary).toMatchObject({
      selectedQuantity: 3,
      packedQuantity: 3,
      ready: true,
      emptyBoxNumbers: [],
      lines: [
        { lineId: "a", selectedQuantity: 2, packedQuantity: 2 },
        { lineId: "b", selectedQuantity: 1, packedQuantity: 1 },
      ],
    });
    // Matching overall totals cannot borrow another identical purchased line's units.
    expect(
      summarizePreviewPacking(selected, [box(1, { a: "1", b: "2" })]),
    ).toMatchObject({ selectedQuantity: 3, packedQuantity: 3, ready: false });
  });

  it("requires exact quantities and a nonempty plan with no empty boxes", () => {
    expect(summarizePreviewPacking(selected, []).ready).toBe(false);
    expect(
      summarizePreviewPacking(selected, [box(1, { a: "1", b: "1" })]).ready,
    ).toBe(false);
    expect(
      summarizePreviewPacking(selected, [box(1, { a: "3", b: "1" })]).ready,
    ).toBe(false);
    expect(
      summarizePreviewPacking(selected, [
        box(1, { a: "2", b: "1" }),
        box(2, { a: "", b: "0" }),
      ]),
    ).toMatchObject({ packedQuantity: 3, ready: false, emptyBoxNumbers: [2] });
  });

  it.each(["-1", "1.5", "1e2", "NaN", "9007199254740992"])(
    "keeps invalid quantity %s unknown",
    (value) => {
      expect(
        summarizePreviewPacking(selected, [box(1, { a: value, b: "1" })]),
      ).toMatchObject({ packedQuantity: null, ready: false });
    },
  );

  it("fails closed on duplicate keys, duplicate lines, unselected items and unsafe totals", () => {
    const invalidBoxes = [
      [box(1, { a: "1" }), box(1, { a: "1", b: "1" })],
      [
        {
          ...box(1, { a: "1", b: "1" }),
          items: [
            { lineId: "a", quantity: "1" },
            { lineId: "a", quantity: "1" },
          ],
        },
      ],
      [box(1, { a: "2", b: "1", unknown: "0" })],
      [
        box(1, { a: String(Number.MAX_SAFE_INTEGER), b: "1" }),
        box(2, { a: "1" }),
      ],
    ];
    for (const parcels of invalidBoxes)
      expect(summarizePreviewPacking(selected, parcels)).toMatchObject({
        packedQuantity: null,
        ready: false,
      });
    expect(
      summarizePreviewPacking(
        [
          { lineId: "a", quantity: Number.MAX_SAFE_INTEGER },
          { lineId: "b", quantity: 1 },
        ],
        [],
      ),
    ).toMatchObject({ selectedQuantity: null, maximumBoxes: 0, ready: false });
    expect(summarizePreviewPacking([selected[0], selected[0]], []).ready).toBe(
      false,
    );
  });
});

describe("packing edits and item descriptions", () => {
  it("rejects a duplicated allocation without changing quantities or box dimensions", () => {
    const parcels = [box(1, { a: "2", b: "1" }), box(2, { a: "0", b: "0" })];
    const before = structuredClone(parcels);
    expect(previewParcelQuantityLimit(selected, parcels, 2, "a")).toBe(0);
    expect(
      changePreviewPackingQuantity(order, selected, parcels, 2, "a", "1"),
    ).toEqual({ kind: "already_assigned", maximum: 0 });
    expect(parcels).toEqual(before);
  });

  it("moves quantities explicitly by freeing a unit before adding it to another box", () => {
    const parcels = [box(1, { a: "2", b: "1" }), box(2, { a: "0", b: "0" })];
    const first = changePreviewPackingQuantity(
      order,
      selected,
      parcels,
      1,
      "a",
      "1",
    );
    if (first.kind !== "updated") throw new Error("Expected first edit");
    expect(previewParcelQuantityLimit(selected, first.parcels, 2, "a")).toBe(1);
    const second = changePreviewPackingQuantity(
      order,
      selected,
      first.parcels,
      2,
      "a",
      "1",
    );
    if (second.kind !== "updated") throw new Error("Expected second edit");
    expect(summarizePreviewPacking(selected, second.parcels).ready).toBe(true);
    expect(second.parcels.map((parcel) => parcel.size)).toEqual(
      parcels.map((parcel) => parcel.size),
    );
    expect(parcels[0].items[0].quantity).toBe("2");
  });

  it("keeps invalid drafts correctable and permits clearing a box despite other invalid drafts", () => {
    const parcels = [box(1, { a: "bad" }), box(2, { a: "bad" })];
    const clear = changePreviewPackingQuantity(
      order,
      selected,
      parcels,
      1,
      "a",
      "",
    );
    if (clear.kind !== "updated") throw new Error("Expected clear edit");
    expect(summarizePreviewPacking(selected, clear.parcels).ready).toBe(false);
    const repair = changePreviewPackingQuantity(
      order,
      selected,
      clear.parcels,
      2,
      "a",
      "2",
    );
    expect(repair.kind).toBe("updated");
    const invalid = changePreviewPackingQuantity(
      order,
      selected,
      [box(1, { a: "2" })],
      1,
      "a",
      "1.5",
    );
    if (invalid.kind !== "updated") throw new Error("Expected editable draft");
    expect(
      summarizePreviewPacking(selected, invalid.parcels).packedQuantity,
    ).toBeNull();
  });

  it("cannot edit unknown boxes or lines or use an unverifiable remaining quantity", () => {
    const parcels = [box(1, { a: "0" }), box(2, { a: "bad" })];
    expect(
      changePreviewPackingQuantity(order, selected, parcels, 999, "a", "1")
        .kind,
    ).toBe("invalid_context");
    expect(
      changePreviewPackingQuantity(order, selected, parcels, 1, "missing", "1")
        .kind,
    ).toBe("invalid_context");
    expect(
      changePreviewPackingQuantity(order, selected, parcels, 1, "a", "1").kind,
    ).toBe("invalid_context");
  });

  it("labels the purchased option without implying a return quantity, retaining distinction for identical lines", () => {
    expect(
      previewPackingItemContext({ ...order, lines: [order.lines[1]] }, "b"),
    ).toBe("Option: 1 Binder");
    expect(previewPackingItemContext(order, "b")).toBe(
      "Order item 2 · Option: 1 Binder",
    );
    expect(
      previewPackingItemContext(
        { ...order, lines: [{ ...order.lines[0], variant: null }] },
        "a",
      ),
    ).toBeNull();
    expect(() => previewPackingItemContext(order, "missing")).toThrow(
      "could not be identified",
    );
  });

  it("distinguishes identical names when blank and missing options render the same", () => {
    const absentOptions = {
      ...order,
      lines: [
        { ...order.lines[0], variant: null },
        { ...order.lines[1], variant: "" },
      ],
    };
    expect(previewPackingItemContext(absentOptions, "a")).toBe("Order item 1");
    expect(previewPackingItemContext(absentOptions, "b")).toBe("Order item 2");
  });
});
