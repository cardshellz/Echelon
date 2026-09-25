import { describe, expect, it } from "vitest";
import {
  MAX_RETURN_FLOW_LINES,
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
  previewPackingSources,
  previewParcelQuantityLimit,
  summarizePreviewPacking,
  transferPreviewPackingQuantity,
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
    ).toBe("1 Binder");
    expect(previewPackingItemContext(order, "b")).toBe(
      "Order item 2 · 1 Binder",
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

describe("positive packing sources", () => {
  it("offers only unassigned units and positive quantities in other boxes, preserving purchased-line identities", () => {
    const parcels = [
      box(1, { a: "1", b: "0" }),
      box(2, {}),
      box(3, { a: "0", b: "1" }),
    ];
    expect(previewPackingSources(selected, parcels, 2)).toEqual({
      ok: true,
      sources: [
        { lineId: "a", fromParcelKey: null, quantity: 1 },
        { lineId: "a", fromParcelKey: 1, quantity: 1 },
        { lineId: "b", fromParcelKey: 3, quantity: 1 },
      ],
    });
    expect(previewPackingSources(selected, parcels, 1)).toEqual({
      ok: true,
      sources: [
        { lineId: "a", fromParcelKey: null, quantity: 1 },
        { lineId: "b", fromParcelKey: 3, quantity: 1 },
      ],
    });
    expect(
      previewPackingSources(selected, [box(1, { a: "2", b: "1" })], 1),
    ).toEqual({ ok: true, sources: [] });
  });

  it("accepts incomplete contents, blank zero drafts, empty boxes and nonsequential keys", () => {
    expect(
      previewPackingSources(selected, [box(0, { a: "" }), box(90, {})], 90),
    ).toEqual({
      ok: true,
      sources: [
        { lineId: "a", fromParcelKey: null, quantity: 2 },
        { lineId: "b", fromParcelKey: null, quantity: 1 },
      ],
    });
  });

  it.each([
    ["missing target", [box(2, {})]],
    ["duplicate keys", [box(1, {}), box(1, {})]],
    [
      "duplicate items",
      [
        {
          ...box(1, {}),
          items: [
            { lineId: "a", quantity: "0" },
            { lineId: "a", quantity: "0" },
          ],
        },
      ],
    ],
    ["unknown zero item", [box(1, { unknown: "0" })]],
    [
      "overallocated line with otherwise matching grand total",
      [box(1, { a: "1", b: "2" })],
    ],
    ["overallocated across boxes", [box(1, { a: "1" }), box(2, { a: "2" })]],
    ["unsafe key", [box(Number.MAX_SAFE_INTEGER + 1, {})]],
    ["negative key", [box(-1, {}), box(1, {})]],
    ["fractional key", [box(1.5, {}), box(1, {})]],
    [
      "too many boxes",
      Array.from({ length: MAX_RETURN_FLOW_PARCELS + 1 }, (_, i) =>
        box(i + 1, {}),
      ),
    ],
    [
      "too many items",
      [
        {
          ...box(1, {}),
          items: Array.from({ length: MAX_RETURN_FLOW_LINES + 1 }, () => ({
            lineId: "a",
            quantity: "0",
          })),
        },
      ],
    ],
  ] satisfies [string, PreviewParcelDraft[]][])(
    "rejects %s",
    (_label, parcels) => {
      expect(previewPackingSources(selected, parcels, 1)).toEqual({
        ok: false,
      });
      const before = structuredClone(parcels);
      expect(
        transferPreviewPackingQuantity(order, selected, parcels, {
          lineId: "a",
          fromParcelKey: null,
          toParcelKey: 1,
          quantity: 1,
        }),
      ).toEqual({ kind: "invalid_context" });
      expect(parcels).toEqual(before);
    },
  );

  it.each(["-1", "1.5", "1e2", "NaN", "9007199254740992"])(
    "rejects invalid draft %s anywhere, including an unrelated line",
    (raw) => {
      expect(
        previewPackingSources(
          selected,
          [box(1, { a: "1" }), box(2, { b: raw })],
          1,
        ),
      ).toEqual({ ok: false });
    },
  );

  it.each([
    [],
    [selected[0], selected[0]],
    [{ lineId: "a", quantity: 0 }],
    [{ lineId: "a", quantity: -1 }],
    [{ lineId: "a", quantity: 1.5 }],
    [{ lineId: "a", quantity: Number.MAX_SAFE_INTEGER + 1 }],
    [
      { lineId: "a", quantity: Number.MAX_SAFE_INTEGER },
      { lineId: "b", quantity: 1 },
    ],
    [{ lineId: "", quantity: 1 }],
    [{ lineId: "x".repeat(256), quantity: 1 }],
    Array.from({ length: MAX_RETURN_FLOW_LINES + 1 }, (_, i) => ({
      lineId: String(i),
      quantity: 1,
    })),
  ])("rejects malformed or unsafe selections %#", (...entries) => {
    expect(previewPackingSources(entries, [box(1, {})], 1)).toEqual({
      ok: false,
    });
  });
});

describe("atomic packing transfers", () => {
  it("partially moves then fully moves a source, preserving every line's packed total and original state", () => {
    const parcels = [
      box(1, { a: "2", b: "1" }),
      box(2, { a: "0" }),
      box(3, {}),
    ];
    const before = structuredClone(parcels);
    const partial = transferPreviewPackingQuantity(order, selected, parcels, {
      lineId: "a",
      fromParcelKey: 1,
      toParcelKey: 2,
      quantity: 1,
    });
    if (partial.kind !== "updated") throw new Error("Expected partial move");
    expect(partial.parcels[0].items).toEqual([
      { lineId: "a", quantity: "1" },
      { lineId: "b", quantity: "1" },
    ]);
    expect(partial.parcels[1].items).toEqual([{ lineId: "a", quantity: "1" }]);
    expect(partial.parcels[2]).toBe(parcels[2]);
    expect(summarizePreviewPacking(selected, partial.parcels).lines).toEqual(
      summarizePreviewPacking(selected, parcels).lines,
    );
    const full = transferPreviewPackingQuantity(
      order,
      selected,
      partial.parcels,
      {
        lineId: "a",
        fromParcelKey: 1,
        toParcelKey: 2,
        quantity: 1,
      },
    );
    if (full.kind !== "updated") throw new Error("Expected remaining move");
    expect(full.parcels[0].items[0].quantity).toBe("0");
    expect(full.parcels[1].items[0].quantity).toBe("2");
    expect(summarizePreviewPacking(selected, full.parcels).lines).toEqual(
      summarizePreviewPacking(selected, parcels).lines,
    );
    expect(parcels).toEqual(before);
    expect(partial.parcels[0].items[0].quantity).toBe("1");
  });

  it("adds only truly unassigned units to an absent target entry", () => {
    const parcels = [box(1, { a: "1", b: "1" }), box(2, {})];
    const result = transferPreviewPackingQuantity(order, selected, parcels, {
      lineId: "a",
      fromParcelKey: null,
      toParcelKey: 2,
      quantity: 1,
    });
    if (result.kind !== "updated") throw new Error("Expected addition");
    expect(result.parcels[1].items).toEqual([{ lineId: "a", quantity: "1" }]);
    expect(result.parcels[0]).toBe(parcels[0]);
    expect(summarizePreviewPacking(selected, result.parcels).ready).toBe(true);
    expect(previewPackingSources(selected, result.parcels, 2)).toEqual({
      ok: true,
      sources: [
        { lineId: "a", fromParcelKey: 1, quantity: 1 },
        { lineId: "b", fromParcelKey: 1, quantity: 1 },
      ],
    });
  });

  it.each([null, 1])(
    "rejects stale source availability for source %s",
    (fromParcelKey) => {
      const parcels =
        fromParcelKey === null
          ? [box(1, { b: "1" }), box(2, {}), box(3, {})]
          : [box(1, { a: "2", b: "1" }), box(2, {}), box(3, {})];
      const first = transferPreviewPackingQuantity(order, selected, parcels, {
        lineId: "a",
        fromParcelKey,
        toParcelKey: 2,
        quantity: 2,
      });
      if (first.kind !== "updated")
        throw new Error("Expected initial allocation");
      const before = structuredClone(first.parcels);
      expect(
        transferPreviewPackingQuantity(order, selected, first.parcels, {
          lineId: "a",
          fromParcelKey,
          toParcelKey: 3,
          quantity: 1,
        }),
      ).toEqual({ kind: "invalid_quantity" });
      expect(first.parcels).toEqual(before);
    },
  );

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    3,
  ])(
    "rejects invalid or unavailable amount %s without mutation",
    (quantity) => {
      const parcels = [box(1, { a: "2", b: "1" }), box(2, {})];
      const before = structuredClone(parcels);
      expect(
        transferPreviewPackingQuantity(order, selected, parcels, {
          lineId: "a",
          fromParcelKey: 1,
          toParcelKey: 2,
          quantity,
        }),
      ).toEqual({ kind: "invalid_quantity" });
      expect(parcels).toEqual(before);
    },
  );

  it.each([
    { lineId: "a", fromParcelKey: 1, toParcelKey: 1 },
    { lineId: "a", fromParcelKey: 999, toParcelKey: 2 },
    { lineId: "a", fromParcelKey: 1, toParcelKey: 999 },
    { lineId: "unknown", fromParcelKey: 1, toParcelKey: 2 },
  ])("rejects missing or identical transfer context %#", (transfer) => {
    const parcels = [box(1, { a: "2", b: "1" }), box(2, {})];
    const before = structuredClone(parcels);
    expect(
      transferPreviewPackingQuantity(order, selected, parcels, {
        ...transfer,
        quantity: 1,
      }),
    ).toEqual({ kind: "invalid_context" });
    expect(parcels).toEqual(before);
  });

  it("rejects missing or ambiguous purchased order-line identities even with valid allocations", () => {
    const parcels = [box(1, { a: "2", b: "1" }), box(2, {})];
    for (const lines of [
      [order.lines[0]],
      [order.lines[0], order.lines[0], order.lines[1]],
    ]) {
      expect(
        transferPreviewPackingQuantity({ ...order, lines }, selected, parcels, {
          lineId: "a",
          fromParcelKey: 1,
          toParcelKey: 2,
          quantity: 1,
        }),
      ).toEqual({ kind: "invalid_context" });
    }
  });

  it("rejects missing or zero source allocations without taking units from another purchased line", () => {
    for (const source of [box(1, { b: "1" }), box(1, { a: "0", b: "1" })]) {
      expect(
        transferPreviewPackingQuantity(
          order,
          selected,
          [source, box(2, { a: "2" })],
          {
            lineId: "a",
            fromParcelKey: 1,
            toParcelKey: 2,
            quantity: 1,
          },
        ),
      ).toEqual({ kind: "invalid_quantity" });
    }
  });

  it("conserves exact safe-integer boundaries and rejects overflow instead of rounding", () => {
    const selections = [{ lineId: "a", quantity: Number.MAX_SAFE_INTEGER }];
    const parcels = [
      box(1, { a: String(Number.MAX_SAFE_INTEGER - 1) }),
      box(2, { a: "1" }),
    ];
    const result = transferPreviewPackingQuantity(order, selections, parcels, {
      lineId: "a",
      fromParcelKey: 1,
      toParcelKey: 2,
      quantity: Number.MAX_SAFE_INTEGER - 1,
    });
    if (result.kind !== "updated")
      throw new Error("Expected exact boundary move");
    expect(result.parcels[0].items[0].quantity).toBe("0");
    expect(result.parcels[1].items[0].quantity).toBe(
      String(Number.MAX_SAFE_INTEGER),
    );
    expect(
      summarizePreviewPacking(selections, result.parcels).packedQuantity,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      previewPackingSources(
        selections,
        [box(1, { a: String(Number.MAX_SAFE_INTEGER) }), box(2, { a: "1" })],
        2,
      ),
    ).toEqual({ ok: false });
  });

  it("reconciles automatic dimensions for both the emptied source and newly populated target", () => {
    const sizedOrder = {
      ...order,
      boxOptions: [
        { id: "original-a", dimensions, items: [{ lineId: "a", quantity: 2 }] },
      ],
    };
    const parcels: PreviewParcelDraft[] = [
      {
        ...box(1, { a: "2" }),
        size: {
          kind: "original",
          originalBoxId: "original-a",
          automatic: true,
        },
      },
      { ...box(2, {}), size: { kind: "unselected" } },
    ];
    const before = structuredClone(parcels);
    const result = transferPreviewPackingQuantity(
      sizedOrder,
      [{ lineId: "a", quantity: 2 }],
      parcels,
      {
        lineId: "a",
        fromParcelKey: 1,
        toParcelKey: 2,
        quantity: 2,
      },
    );
    if (result.kind !== "updated")
      throw new Error("Expected dimension reconciliation");
    expect(result.parcels[0].size).toEqual({ kind: "unselected" });
    expect(result.parcels[1].size).toEqual({
      kind: "original",
      originalBoxId: "original-a",
      automatic: true,
    });
    expect(parcels).toEqual(before);
  });

  it("preserves explicit original and custom dimensions, even after emptying or adding contents", () => {
    const parcels: PreviewParcelDraft[] = [
      {
        ...box(1, { a: "2", b: "1" }),
        size: { kind: "original", originalBoxId: "chosen", automatic: false },
      },
      box(2, {}),
    ];
    const result = transferPreviewPackingQuantity(order, selected, parcels, {
      lineId: "a",
      fromParcelKey: 1,
      toParcelKey: 2,
      quantity: 2,
    });
    if (result.kind !== "updated")
      throw new Error("Expected explicit-size move");
    expect(result.parcels.map((parcel) => parcel.size)).toEqual(
      parcels.map((parcel) => parcel.size),
    );
  });
});
