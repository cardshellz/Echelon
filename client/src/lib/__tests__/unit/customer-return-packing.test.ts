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
  movePreviewPackingItems,
  previewPackingAllocations,
  previewPackingItemContext,
  previewParcelQuantityLimit,
  summarizePreviewPacking,
  type PreviewPackingMoveCommand,
  type PreviewPackingMoveItem,
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

describe("validated packing allocations", () => {
  it("accepts incomplete contents, blank zero drafts, empty boxes and nonsequential keys", () => {
    expect(
      previewPackingAllocations(selected, [box(0, { a: "" }), box(90, {})]),
    ).toEqual({
      ok: true,
      sources: [
        { lineId: "a", fromParcelKey: null, quantity: 2 },
        { lineId: "b", fromParcelKey: null, quantity: 1 },
      ],
    });
  });

  it.each([
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
      expect(previewPackingAllocations(selected, parcels)).toEqual({
        ok: false,
      });
      const before = structuredClone(parcels);
      expect(
        movePreviewPackingItems(order, selected, parcels, {
          items: [{ lineId: "a", fromParcelKey: null, quantity: 1 }],
          destination: { kind: "new" },
        }),
      ).toEqual({ kind: "invalid_context" });
      expect(parcels).toEqual(before);
    },
  );

  it.each(["-1", "1.5", "1e2", "NaN", "9007199254740992"])(
    "rejects invalid draft %s anywhere, including an unrelated line",
    (raw) => {
      expect(
        previewPackingAllocations(selected, [
          box(1, { a: "1" }),
          box(2, { b: raw }),
        ]),
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
    expect(previewPackingAllocations(entries, [box(1, {})])).toEqual({
      ok: false,
    });
  });
});

describe("atomic move and split commands", () => {
  const existing = { kind: "existing", parcelKey: 2 } as const;
  const newBox = { kind: "new" } as const;

  it("projects all positive source pools without excluding any target", () => {
    const parcels = [
      box(1, { a: "1", b: "0" }),
      box(2, { b: "1" }),
      box(3, {}),
    ];
    expect(previewPackingAllocations(selected, parcels)).toEqual({
      ok: true,
      sources: [
        { lineId: "a", fromParcelKey: null, quantity: 1 },
        { lineId: "a", fromParcelKey: 1, quantity: 1 },
        { lineId: "b", fromParcelKey: 2, quantity: 1 },
      ],
    });
    expect(previewPackingAllocations(selected, [box(1, { a: "3" })])).toEqual({
      ok: false,
    });
  });

  it("partially moves to an existing box while preserving all per-line totals and explicit sizes", () => {
    const parcels = [box(1, { a: "2", b: "1" }), box(2, {}), box(3, {})];
    const before = structuredClone(parcels);
    const result = movePreviewPackingItems(order, selected, parcels, {
      items: [{ lineId: "a", fromParcelKey: 1, quantity: 1 }],
      destination: existing,
    });
    if (result.kind !== "updated") throw new Error("Expected partial move");
    expect(result.removedParcelKeys).toEqual([]);
    expect(result.destinationParcelKey).toBe(2);
    expect(result.parcels[0].items).toEqual([
      { lineId: "a", quantity: "1" },
      { lineId: "b", quantity: "1" },
    ]);
    expect(result.parcels[1].items).toEqual([{ lineId: "a", quantity: "1" }]);
    expect(result.parcels.map((parcel) => parcel.size)).toEqual(
      parcels.map((parcel) => parcel.size),
    );
    expect(result.parcels[2]).toBe(parcels[2]);
    expect(summarizePreviewPacking(selected, result.parcels).lines).toEqual(
      summarizePreviewPacking(selected, parcels).lines,
    );
    expect(parcels).toEqual(before);
  });

  it("moves a full multi-line source into an existing box and removes only that emptied donor", () => {
    const parcels = [box(1, { a: "2", b: "1" }), box(2, {}), box(99, {})];
    const result = movePreviewPackingItems(order, selected, parcels, {
      items: [
        { lineId: "b", fromParcelKey: 1, quantity: 1 },
        { lineId: "a", fromParcelKey: 1, quantity: 2 },
      ],
      destination: existing,
    });
    if (result.kind !== "updated") throw new Error("Expected full move");
    expect(result.removedParcelKeys).toEqual([1]);
    expect(result.parcels.map((parcel) => parcel.key)).toEqual([2, 99]);
    expect(result.parcels[0].items).toEqual([
      { lineId: "a", quantity: "2" },
      { lineId: "b", quantity: "1" },
    ]);
    expect(result.parcels[1]).toBe(parcels[2]);
    expect(result.parcels[0].size).toBe(parcels[1].size);
  });

  it("previews a partial split into a new box without changing input or inheriting donor dimensions", () => {
    const parcels = [box(1, { a: "2", b: "1" })];
    const command: PreviewPackingMoveCommand = {
      items: [{ lineId: "a", fromParcelKey: 1, quantity: 1 }],
      destination: newBox,
    };
    const before = structuredClone({ order, selected, parcels, command });
    const preview = movePreviewPackingItems(order, selected, parcels, command);
    const again = movePreviewPackingItems(order, selected, parcels, command);
    expect(again).toEqual(preview);
    expect({ order, selected, parcels, command }).toEqual(before);
    if (preview.kind !== "updated") throw new Error("Expected split preview");
    expect(preview.destinationParcelKey).toBe(2);
    expect(preview.removedParcelKeys).toEqual([]);
    expect(preview.parcels[0].size).toBe(parcels[0].size);
    expect(preview.parcels[1]).toEqual({
      key: 2,
      items: [{ lineId: "a", quantity: "1" }],
      size: customPreviewParcelSize(),
    });
    // Discarding a preview (canceling) leaves the original single box intact.
    expect(parcels.length).toBe(1);
  });

  it.each([existing, newBox])(
    "combines one purchased line from multiple donors and unassigned units into $kind destination",
    (destination) => {
      const selections = [
        { lineId: "a", quantity: 5 },
        { lineId: "b", quantity: 1 },
      ];
      const parcels = [
        box(1, { a: "1", b: "1" }),
        box(2, { a: "2" }),
        box(3, { a: "1" }),
      ];
      const target =
        destination.kind === "existing"
          ? ({ kind: "existing", parcelKey: 3 } as const)
          : destination;
      const result = movePreviewPackingItems(order, selections, parcels, {
        items: [
          { lineId: "a", fromParcelKey: 1, quantity: 1 },
          { lineId: "a", fromParcelKey: 2, quantity: 2 },
          { lineId: "a", fromParcelKey: null, quantity: 1 },
        ],
        destination: target,
      });
      if (result.kind !== "updated") throw new Error("Expected combined move");
      expect(result.removedParcelKeys).toEqual([2]);
      const destinationBox = result.parcels.find(
        (parcel) => parcel.key === result.destinationParcelKey,
      )!;
      expect(destinationBox.items).toEqual([
        { lineId: "a", quantity: destination.kind === "existing" ? "5" : "4" },
      ]);
      expect(summarizePreviewPacking(selections, result.parcels).lines).toEqual(
        [
          { lineId: "a", selectedQuantity: 5, packedQuantity: 5 },
          { lineId: "b", selectedQuantity: 1, packedQuantity: 1 },
        ],
      );
    },
  );

  it("merges multiple fully emptied donors into a genuinely new box", () => {
    const result = movePreviewPackingItems(
      order,
      selected,
      [box(1, { a: "2" }), box(2, { b: "1" })],
      {
        items: [
          { lineId: "a", fromParcelKey: 1, quantity: 2 },
          { lineId: "b", fromParcelKey: 2, quantity: 1 },
        ],
        destination: newBox,
      },
    );
    if (result.kind !== "updated") throw new Error("Expected consolidation");
    expect(result.removedParcelKeys).toEqual([1, 2]);
    expect(result.destinationParcelKey).toBe(3);
    expect(result.parcels).toEqual([
      {
        key: 3,
        items: [
          { lineId: "a", quantity: "2" },
          { lineId: "b", quantity: "1" },
        ],
        size: customPreviewParcelSize(),
      },
    ]);
  });

  it.each([
    {
      selections: [{ lineId: "a", quantity: 1 }],
      parcels: [box(1, { a: "1" })],
      items: [{ lineId: "a", fromParcelKey: 1, quantity: 1 }],
    },
    {
      selections: selected,
      parcels: [box(1, { a: "2", b: "1" })],
      items: [
        { lineId: "a", fromParcelKey: 1, quantity: 2 },
        { lineId: "b", fromParcelKey: 1, quantity: 1 },
      ],
    },
  ])(
    "rejects pure reboxing without creating a box %#",
    ({ selections, parcels, items }) => {
      const before = structuredClone(parcels);
      expect(
        movePreviewPackingItems(order, selections, parcels, {
          items,
          destination: newBox,
        }),
      ).toEqual({ kind: "unchanged" });
      expect(parcels).toEqual(before);
    },
  );

  it("enforces selected-unit count on the final plan without deleting unrelated empty boxes", () => {
    const parcels = [box(1, {})];
    expect(
      movePreviewPackingItems(order, [{ lineId: "a", quantity: 1 }], parcels, {
        items: [{ lineId: "a", fromParcelKey: null, quantity: 1 }],
        destination: newBox,
      }),
    ).toEqual({ kind: "box_limit" });
    expect(parcels).toEqual([box(1, {})]);
  });

  it("allows a twentieth box but prevents a twenty-first box", () => {
    for (const count of [19, 20]) {
      const parcels = Array.from({ length: count }, (_, i) =>
        box(i + 1, { a: i === 0 ? "2" : "1" }),
      );
      const result = movePreviewPackingItems(
        order,
        [{ lineId: "a", quantity: count + 1 }],
        parcels,
        {
          items: [{ lineId: "a", fromParcelKey: 1, quantity: 1 }],
          destination: newBox,
        },
      );
      if (count === 20) expect(result).toEqual({ kind: "box_limit" });
      else {
        if (result.kind !== "updated")
          throw new Error("Expected twentieth box");
        expect(result.parcels.length).toBe(20);
      }
    }
  });

  it("evaluates the cap after donor removal without reusing a removed key", () => {
    const parcels = Array.from({ length: 20 }, (_, i) =>
      box(i + 1, { a: i < 2 ? "2" : "1" }),
    );
    const result = movePreviewPackingItems(
      order,
      [{ lineId: "a", quantity: 22 }],
      parcels,
      {
        items: [
          { lineId: "a", fromParcelKey: 1, quantity: 2 },
          { lineId: "a", fromParcelKey: 2, quantity: 1 },
        ],
        destination: newBox,
      },
    );
    if (result.kind !== "updated")
      throw new Error("Expected net-zero box growth");
    expect(result.removedParcelKeys).toEqual([1]);
    expect(result.destinationParcelKey).toBe(21);
    expect(result.parcels.length).toBe(20);
    expect(
      movePreviewPackingItems(order, [{ lineId: "a", quantity: 22 }], parcels, {
        items: [{ lineId: "a", fromParcelKey: 1, quantity: 2 }],
        destination: newBox,
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("allocates safe deterministic keys even when an existing key is at MAX_SAFE_INTEGER", () => {
    const parcels = [
      box(Number.MAX_SAFE_INTEGER, { a: "2" }),
      box(1, { b: "1" }),
    ];
    const result = movePreviewPackingItems(order, selected, parcels, {
      items: [
        { lineId: "a", fromParcelKey: Number.MAX_SAFE_INTEGER, quantity: 1 },
      ],
      destination: newBox,
    });
    if (result.kind !== "updated")
      throw new Error("Expected bounded unused key");
    expect(result.destinationParcelKey).toBe(2);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    3,
  ])("rejects invalid or unavailable quantity %s atomically", (quantity) => {
    const parcels = [box(1, { a: "2", b: "1" }), box(2, {})];
    const before = structuredClone(parcels);
    expect(
      movePreviewPackingItems(order, selected, parcels, {
        items: [
          { lineId: "b", fromParcelKey: 1, quantity: 1 },
          { lineId: "a", fromParcelKey: 1, quantity },
        ],
        destination: existing,
      }),
    ).toEqual({ kind: "invalid_quantity" });
    expect(parcels).toEqual(before);
  });

  it.each([
    { items: [], expected: "invalid_quantity" },
    {
      items: [
        { lineId: "a", fromParcelKey: 1, quantity: 1 },
        { lineId: "a", fromParcelKey: 1, quantity: 1 },
      ],
      expected: "invalid_context",
    },
    {
      items: [{ lineId: "unknown", fromParcelKey: 1, quantity: 1 }],
      expected: "invalid_context",
    },
    {
      items: [{ lineId: "a", fromParcelKey: 999, quantity: 1 }],
      expected: "invalid_context",
    },
    {
      items: [{ lineId: "a", fromParcelKey: 2, quantity: 1 }],
      expected: "invalid_context",
    },
    {
      items: [{ lineId: "a", fromParcelKey: null, quantity: 1 }],
      expected: "invalid_quantity",
    },
  ] satisfies { items: PreviewPackingMoveItem[]; expected: string }[])(
    "rejects invalid batch context %#",
    ({ items, expected }) => {
      const parcels = [box(1, { a: "2", b: "1" }), box(2, {})];
      const before = structuredClone(parcels);
      expect(
        movePreviewPackingItems(order, selected, parcels, {
          items,
          destination: existing,
        }),
      ).toEqual({ kind: expected });
      expect(parcels).toEqual(before);
    },
  );

  it("rejects stale quantities or missing destinations without applying valid earlier entries", () => {
    const parcels = [box(1, { a: "1", b: "1" }), box(2, { a: "1" })];
    const before = structuredClone(parcels);
    expect(
      movePreviewPackingItems(order, selected, parcels, {
        items: [
          { lineId: "b", fromParcelKey: 1, quantity: 1 },
          { lineId: "a", fromParcelKey: 1, quantity: 2 },
        ],
        destination: existing,
      }),
    ).toEqual({ kind: "invalid_quantity" });
    expect(
      movePreviewPackingItems(order, selected, parcels, {
        items: [{ lineId: "a", fromParcelKey: 1, quantity: 1 }],
        destination: { kind: "existing", parcelKey: 999 },
      }),
    ).toEqual({ kind: "invalid_context" });
    expect(parcels).toEqual(before);
  });

  it("rejects missing or ambiguous purchased identities", () => {
    const command: PreviewPackingMoveCommand = {
      items: [{ lineId: "a", fromParcelKey: 1, quantity: 1 }],
      destination: newBox,
    };
    for (const lines of [[order.lines[0]], [...order.lines, order.lines[0]]]) {
      expect(
        movePreviewPackingItems(
          { ...order, lines },
          selected,
          [box(1, { a: "2", b: "1" })],
          command,
        ),
      ).toEqual({ kind: "invalid_context" });
    }
  });

  it("conserves MAX_SAFE_INTEGER exactly when combining multiple pools", () => {
    const selections = [{ lineId: "a", quantity: Number.MAX_SAFE_INTEGER }];
    const result = movePreviewPackingItems(
      order,
      selections,
      [box(1, { a: String(Number.MAX_SAFE_INTEGER - 2) }), box(2, { a: "1" })],
      {
        items: [
          {
            lineId: "a",
            fromParcelKey: 1,
            quantity: Number.MAX_SAFE_INTEGER - 2,
          },
          { lineId: "a", fromParcelKey: null, quantity: 1 },
        ],
        destination: existing,
      },
    );
    if (result.kind !== "updated") throw new Error("Expected exact large move");
    expect(result.parcels).toHaveLength(1);
    expect(result.parcels[0].items).toEqual([
      { lineId: "a", quantity: String(Number.MAX_SAFE_INTEGER) },
    ]);
    expect(
      previewPackingAllocations(selections, [
        box(1, { a: String(Number.MAX_SAFE_INTEGER) }),
        box(2, { a: "1" }),
      ]),
    ).toEqual({ ok: false });
  });

  it("adds unassigned units to a missing target row without changing other boxes", () => {
    const parcels = [box(1, { a: "1", b: "1" }), box(2, {})];
    const result = movePreviewPackingItems(order, selected, parcels, {
      items: [{ lineId: "a", fromParcelKey: null, quantity: 1 }],
      destination: existing,
    });
    if (result.kind !== "updated")
      throw new Error("Expected unassigned addition");
    expect(result.parcels[0]).toBe(parcels[0]);
    expect(result.parcels[1].items).toEqual([{ lineId: "a", quantity: "1" }]);
    expect(summarizePreviewPacking(selected, result.parcels).ready).toBe(true);
  });

  it.each([null, 1])(
    "re-reads depleted source %s after a successful move",
    (fromParcelKey) => {
      const parcels =
        fromParcelKey === null
          ? [box(1, { b: "1" }), box(2, {}), box(3, {})]
          : [box(1, { a: "2", b: "1" }), box(2, {}), box(3, {})];
      const first = movePreviewPackingItems(order, selected, parcels, {
        items: [{ lineId: "a", fromParcelKey, quantity: 2 }],
        destination: existing,
      });
      if (first.kind !== "updated") throw new Error("Expected initial move");
      const before = structuredClone(first.parcels);
      expect(
        movePreviewPackingItems(order, selected, first.parcels, {
          items: [{ lineId: "a", fromParcelKey, quantity: 1 }],
          destination: { kind: "existing", parcelKey: 3 },
        }),
      ).toEqual({ kind: "invalid_quantity" });
      expect(first.parcels).toEqual(before);
    },
  );

  it.each([null, "0"])(
    "cannot move a missing or zero source allocation %#",
    (quantity) => {
      const parcels = [
        box(1, quantity === null ? { b: "1" } : { a: quantity, b: "1" }),
        box(2, { a: "2" }),
      ];
      expect(
        movePreviewPackingItems(order, selected, parcels, {
          items: [{ lineId: "a", fromParcelKey: 1, quantity: 1 }],
          destination: existing,
        }),
      ).toEqual({ kind: "invalid_quantity" });
    },
  );

  it("removes an emptied automatic donor and suggests the destination's final matching size", () => {
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
    const result = movePreviewPackingItems(
      sizedOrder,
      [{ lineId: "a", quantity: 2 }],
      parcels,
      {
        items: [{ lineId: "a", fromParcelKey: 1, quantity: 2 }],
        destination: existing,
      },
    );
    if (result.kind !== "updated")
      throw new Error("Expected reconciled destination");
    expect(result.removedParcelKeys).toEqual([1]);
    expect(result.parcels[0].size).toEqual({
      kind: "original",
      originalBoxId: "original-a",
      automatic: true,
    });
  });

  it("reconciles automatic dimensions once from final contents regardless of move-item order", () => {
    const sizedOrder = {
      ...order,
      lines: [...order.lines, { ...order.lines[0], id: "c" }],
      boxOptions: [
        {
          id: "first",
          dimensions,
          items: [
            { lineId: "a", quantity: 1 },
            { lineId: "c", quantity: 1 },
          ],
        },
        {
          id: "all",
          dimensions,
          items: [
            { lineId: "a", quantity: 1 },
            { lineId: "b", quantity: 1 },
            { lineId: "c", quantity: 1 },
          ],
        },
      ],
    };
    const selections = ["a", "b", "c"].map((lineId) => ({
      lineId,
      quantity: 1,
    }));
    const parcels: PreviewParcelDraft[] = [
      box(1, { b: "1", c: "1" }),
      {
        ...box(2, { a: "1" }),
        size: { kind: "original", originalBoxId: "first", automatic: true },
      },
    ];
    const items = [
      { lineId: "b", fromParcelKey: 1, quantity: 1 },
      { lineId: "c", fromParcelKey: 1, quantity: 1 },
    ];
    const forward = movePreviewPackingItems(sizedOrder, selections, parcels, {
      items,
      destination: existing,
    });
    const backward = movePreviewPackingItems(sizedOrder, selections, parcels, {
      items: [...items].reverse(),
      destination: existing,
    });
    expect(forward).toEqual(backward);
    if (forward.kind !== "updated")
      throw new Error("Expected final-content reconciliation");
    expect(forward.parcels[0].size).toEqual({ kind: "unselected" });
    expect(forward.parcels[0].items).toEqual(
      ["a", "b", "c"].map((lineId) => ({ lineId, quantity: "1" })),
    );
  });

  it("initializes a new box from final contents while retaining a surviving customer's explicit choice", () => {
    const sizedOrder = {
      ...order,
      boxOptions: [
        { id: "a", dimensions, items: [{ lineId: "a", quantity: 1 }] },
      ],
    };
    const parcels: PreviewParcelDraft[] = [
      {
        ...box(1, { a: "2", b: "1" }),
        size: { kind: "original", originalBoxId: "chosen", automatic: false },
      },
    ];
    const result = movePreviewPackingItems(sizedOrder, selected, parcels, {
      items: [{ lineId: "a", fromParcelKey: 1, quantity: 1 }],
      destination: newBox,
    });
    if (result.kind !== "updated")
      throw new Error("Expected suggested new size");
    expect(result.parcels[0].size).toBe(parcels[0].size);
    expect(result.parcels[1].size).toEqual({
      kind: "original",
      originalBoxId: "a",
      automatic: true,
    });
  });
});
