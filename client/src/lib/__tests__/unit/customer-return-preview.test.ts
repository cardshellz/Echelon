import { describe, expect, it } from "vitest";
import {
  assertReturnFlowOrderMatches,
  assertPreviewReviewMatches,
  buildPreviewReviewInput,
  describePreviewItem,
  initialPreviewSelections,
  normalizedPreviewReference,
  PreviewAccessError,
  ReturnSourceChangedError,
  readPreviewQuantity,
  readPreviewResponse,
  samePreviewQuantities,
  singlePreviewParcel,
  validatePreviewSelections,
  type PreviewSelections,
} from "../../customer-return-preview";
import {
  customerReturnFlowOrderSchema,
  customerReturnFlowReviewSchema,
  type CustomerReturnFlowOrder,
  type CustomerReturnFlowReview,
} from "@shared/returns/customer-return-flow.contract";
import { customPreviewParcelSize } from "../../customer-return-parcels";

const dimensions = { lengthMm: 254, widthMm: 203.2, heightMm: 152.4 };
const customSize = customPreviewParcelSize(dimensions);

const order: CustomerReturnFlowOrder = {
  sourceRevision: null,
  orderReference: "#SAMPLE-1001",
  purchasedAt: "2026-01-01T00:00:00Z",
  evaluatedAt: "2026-02-01T00:00:00Z",
  returnWindowEndsAt: "2027-01-01T00:00:00Z",
  message: null,
  boxOptions: [
    {
      id: "box-1",
      dimensions,
      items: [
        { lineId: "line-a", quantity: 3 },
        { lineId: "line-b", quantity: 1 },
      ],
    },
  ],
  lines: [
    {
      id: "line-a",
      title: "Sleeves",
      variant: "Blue",
      sku: "SAME",
      unitWeightGrams: 10.2,
      purchasedQuantity: 3,
      deliveredQuantity: 3,
      alreadyReturningQuantity: 1,
      eligibleQuantity: 2,
      message: null,
    },
    {
      id: "line-b",
      title: "Sleeves",
      variant: "Blue",
      sku: "SAME",
      unitWeightGrams: 20,
      purchasedQuantity: 1,
      deliveredQuantity: 1,
      alreadyReturningQuantity: 0,
      eligibleQuantity: 1,
      message: null,
    },
    {
      id: "line-c",
      title: "Box",
      variant: null,
      sku: null,
      unitWeightGrams: null,
      purchasedQuantity: 1,
      deliveredQuantity: 0,
      alreadyReturningQuantity: 0,
      eligibleQuantity: 0,
      message: "On its way",
    },
  ],
};
const selections: PreviewSelections = [
  { lineId: "line-a", quantity: 2, reasonCode: null },
  { lineId: "line-b", quantity: 1, reasonCode: null },
];

describe("customer return preview drafts", () => {
  it("distinguishes identical lines with original order ordinals even when only the second is selected", () => {
    expect(describePreviewItem(order, "line-a")).toEqual({
      context: "Item 1 · Blue",
      accessibleName: "item 1: Sleeves (Blue)",
    });
    const selectedSubset = [selections[1]];
    expect(
      selectedSubset.map((item) => describePreviewItem(order, item.lineId)),
    ).toEqual([
      {
        context: "Item 2 · Blue",
        accessibleName: "item 2: Sleeves (Blue)",
      },
    ]);
    expect(describePreviewItem(order, "line-c")).toEqual({
      context: "Item 3",
      accessibleName: "item 3: Box",
    });
    expect(() => describePreviewItem(order, "unknown")).toThrow(
      "could not be identified",
    );
  });

  it("normalizes an optional # and whitespace without changing meaningful reference characters", () => {
    expect(normalizedPreviewReference("  #  SAMPLE-001  ")).toBe("SAMPLE-001");
    expect(normalizedPreviewReference("001")).toBe("001");
  });

  it("starts unselected with genuinely optional reasons and keeps identical SKU lines distinct", () => {
    const drafts = initialPreviewSelections(order);
    expect(drafts).toHaveLength(3);
    expect(
      drafts.every(
        (draft) => draft.quantity === "0" && draft.reasonCode === null,
      ),
    ).toBe(true);
    const updated = drafts.map((draft, index) => ({
      ...draft,
      quantity: index === 0 ? "2" : index === 1 ? "1" : "0",
    }));
    expect(validatePreviewSelections(order, updated)).toEqual({
      ok: true,
      value: selections,
    });
    expect(drafts[0].quantity).toBe("0");
  });

  it.each(["-1", "1.5", "1e2", "NaN", "Infinity", "9007199254740992", " 2 "])(
    "rejects invalid quantity %s",
    (value) => {
      expect(readPreviewQuantity(value)).toBeNull();
    },
  );

  it("treats blank as zero but prevents an empty return, unavailable units, and duplicate identities", () => {
    expect(readPreviewQuantity("")).toBe(0);
    const drafts = initialPreviewSelections(order);
    expect(validatePreviewSelections(order, drafts).ok).toBe(false);
    expect(
      validatePreviewSelections(order, [{ ...drafts[2], quantity: "1" }]).ok,
    ).toBe(false);
    expect(
      validatePreviewSelections(order, [{ ...drafts[0], quantity: "3" }]).ok,
    ).toBe(false);
    expect(
      validatePreviewSelections(order, [
        { ...drafts[0], quantity: "1" },
        { ...drafts[0], quantity: "1" },
      ]).ok,
    ).toBe(false);
  });

  it("preserves a packing draft through reason edits and equivalent quantity formatting", () => {
    const before = [{ lineId: "line-a", quantity: "1", reasonCode: null }];
    expect(
      samePreviewQuantities(before, [
        { ...before[0], quantity: "01", reasonCode: "damaged" },
      ]),
    ).toBe(true);
    expect(
      samePreviewQuantities(before, [{ ...before[0], quantity: "2" }]),
    ).toBe(false);
    expect(
      samePreviewQuantities(before, [{ ...before[0], quantity: "1.5" }]),
    ).toBe(false);
  });

  it("defaults all selected lines to one box independently of outbound packages", () => {
    const parcels = singlePreviewParcel(selections, order);
    const input = buildPreviewReviewInput(order, selections, parcels);
    expect(input.ok).toBe(true);
    if (!input.ok) return;
    expect(input.value.parcels).toEqual([
      {
        dimensions,
        originalBoxId: "box-1",
        items: [
          { lineId: "line-a", quantity: 2 },
          { lineId: "line-b", quantity: 1 },
        ],
      },
    ]);
    expect(
      input.value.selections.every(
        (selection) => selection.reasonCode === null,
      ),
    ).toBe(true);
  });

  it("carries the exact source revision into review instead of recomputing it in the browser", () => {
    const sourceRevision = "a".repeat(64);
    const result = buildPreviewReviewInput(
      { ...order, sourceRevision },
      selections,
      singlePreviewParcel(selections, order),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceRevision).toBe(sourceRevision);
    expect(result.value).not.toHaveProperty("scenarioId");
  });

  it("conserves every exact line across multiple boxes and omits zero entries", () => {
    const input = buildPreviewReviewInput(order, selections, [
      {
        key: 1,
        size: customSize,
        items: [
          { lineId: "line-a", quantity: "1" },
          { lineId: "line-b", quantity: "1" },
        ],
      },
      {
        key: 2,
        size: customSize,
        items: [
          { lineId: "line-a", quantity: "1" },
          { lineId: "line-b", quantity: "0" },
        ],
      },
    ]);
    expect(input.ok).toBe(true);
    if (!input.ok) return;
    expect(input.value.parcels[1].items).toEqual([
      { lineId: "line-a", quantity: 1 },
    ]);
  });

  it.each([
    [
      { lineId: "line-a", quantity: "1" },
      { lineId: "line-b", quantity: "1" },
    ],
    [
      { lineId: "line-a", quantity: "3" },
      { lineId: "line-b", quantity: "1" },
    ],
    [
      { lineId: "line-a", quantity: "2" },
      { lineId: "line-b", quantity: "0" },
    ],
    [
      { lineId: "line-a", quantity: "2" },
      { lineId: "line-b", quantity: "1" },
      { lineId: "unknown", quantity: "0" },
    ],
    [
      { lineId: "line-a", quantity: "1" },
      { lineId: "line-a", quantity: "1" },
      { lineId: "line-b", quantity: "1" },
    ],
    [
      { lineId: "line-a", quantity: "9007199254740992" },
      { lineId: "line-b", quantity: "1" },
    ],
  ])(
    "rejects underpacking, overpacking, unknown or duplicated identities",
    (...items) => {
      expect(
        buildPreviewReviewInput(order, selections, [
          { key: 1, items, size: customSize },
        ]).ok,
      ).toBe(false);
    },
  );

  it("rejects an extra empty box rather than silently removing it", () => {
    expect(
      buildPreviewReviewInput(order, selections, [
        ...singlePreviewParcel(selections, order),
        {
          key: 2,
          size: customSize,
          items: [{ lineId: "line-a", quantity: "0" }],
        },
      ]),
    ).toEqual({
      ok: false,
      message: "Add an item to box 2, or remove that box.",
    });
  });
});

describe("customer return preview response verification", () => {
  it("retains unknown return history while allowing a different verified line", () => {
    const unknownHistory = customerReturnFlowOrderSchema.parse({
      ...order,
      lines: order.lines.map((line, index) =>
        index === 0
          ? { ...line, alreadyReturningQuantity: null, eligibleQuantity: 0 }
          : line,
      ),
    });
    expect(unknownHistory.lines[0].alreadyReturningQuantity).toBeNull();
    expect(() =>
      assertReturnFlowOrderMatches(unknownHistory, order.orderReference),
    ).not.toThrow();
    const drafts = initialPreviewSelections(unknownHistory);
    expect(
      validatePreviewSelections(
        unknownHistory,
        drafts.map((draft, index) => ({
          ...draft,
          quantity: index === 1 ? "1" : "0",
        })),
      ),
    ).toEqual({
      ok: true,
      value: [{ lineId: "line-b", quantity: 1, reasonCode: null }],
    });
    expect(() =>
      assertReturnFlowOrderMatches(
        {
          ...unknownHistory,
          lines: [{ ...unknownHistory.lines[0], eligibleQuantity: 1 }],
        },
        order.orderReference,
      ),
    ).toThrow("could not be verified");
  });

  it("accepts provider title and variant bounds in orders and review without truncation", () => {
    const title = "T".repeat(1000);
    const variant = "V".repeat(1000);
    const result = customerReturnFlowOrderSchema.parse({
      ...order,
      lines: [{ ...order.lines[0], title, variant }],
    });
    expect(result.lines[0]).toMatchObject({ title, variant });
    for (const field of ["title", "variant"] as const) {
      expect(
        customerReturnFlowOrderSchema.safeParse({
          ...result,
          lines: [{ ...result.lines[0], [field]: "X".repeat(1001) }],
        }).success,
      ).toBe(false);
    }
    const review: CustomerReturnFlowReview = {
      sourceRevision: null,
      effects: "none",
      orderReference: order.orderReference,
      selectedQuantity: 1,
      refundMethod: "manual_shopify",
      parcels: [
        {
          number: 1,
          dimensions,
          weightGrams: 11,
          items: [{ lineId: "line-a", title, quantity: 1 }],
        },
      ],
    };
    expect(
      customerReturnFlowReviewSchema.parse(review).parcels[0].items[0].title,
    ).toBe(title);
    expect(
      customerReturnFlowReviewSchema.safeParse({
        ...review,
        parcels: [
          {
            number: 1,
            dimensions,
            weightGrams: 11,
            items: [{ lineId: "line-a", title: "T".repeat(1001), quantity: 1 }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps order and quantity verification when the standalone flow uses a source-neutral order", () => {
    expect(() =>
      assertReturnFlowOrderMatches(order, order.orderReference),
    ).not.toThrow();
    expect(() => assertReturnFlowOrderMatches(order, "OTHER-ORDER")).toThrow();
    expect(() =>
      assertReturnFlowOrderMatches(
        { ...order, lines: [{ ...order.lines[2], eligibleQuantity: 1 }] },
        order.orderReference,
      ),
    ).toThrow();
  });

  it("rejects a response for another order, duplicate line IDs or impossible eligible quantities", () => {
    expect(() =>
      assertReturnFlowOrderMatches(order, " SAMPLE-1001 "),
    ).not.toThrow();
    expect(() => assertReturnFlowOrderMatches(order, "SAMPLE-OTHER")).toThrow();
    expect(() =>
      assertReturnFlowOrderMatches(
        { ...order, lines: [order.lines[0], order.lines[0]] },
        order.orderReference,
      ),
    ).toThrow();
    expect(() =>
      assertReturnFlowOrderMatches(
        { ...order, lines: [{ ...order.lines[2], eligibleQuantity: 1 }] },
        order.orderReference,
      ),
    ).toThrow();
  });

  it("requires the validated review to correspond to the exact submitted boxes", () => {
    const input = buildPreviewReviewInput(
      order,
      selections,
      singlePreviewParcel(selections, order),
    );
    if (!input.ok) throw new Error(input.message);
    const response: CustomerReturnFlowReview = {
      sourceRevision: null,
      effects: "none",
      orderReference: order.orderReference,
      selectedQuantity: 3,
      refundMethod: "manual_shopify",
      parcels: [
        {
          number: 1,
          dimensions,
          weightGrams: 41,
          items: [
            { lineId: "line-b", title: "Sleeves", quantity: 1 },
            { lineId: "line-a", title: "Sleeves", quantity: 2 },
          ],
        },
      ],
    };
    expect(() =>
      assertPreviewReviewMatches(response, input.value, order),
    ).not.toThrow();
    expect(() =>
      assertPreviewReviewMatches(
        { ...response, sourceRevision: "a".repeat(64) },
        input.value,
        order,
      ),
    ).toThrow();
    expect(() =>
      assertPreviewReviewMatches(
        { ...response, selectedQuantity: 4 },
        input.value,
        order,
      ),
    ).toThrow();
    expect(() =>
      assertPreviewReviewMatches(
        {
          ...response,
          parcels: [
            {
              number: 1,
              dimensions,
              weightGrams: 41,
              items: [
                { lineId: "line-a", title: "Sleeves", quantity: 1 },
                { lineId: "line-a", title: "Sleeves", quantity: 2 },
              ],
            },
          ],
        },
        input.value,
        order,
      ),
    ).toThrow();
  });

  it.each([401, 403])(
    "classifies access failure %s before trying to read an HTML body",
    async (status) => {
      await expect(
        readPreviewResponse(
          new Response("Sign in", { status }),
          customerReturnFlowReviewSchema,
        ),
      ).rejects.toBeInstanceOf(PreviewAccessError);
    },
  );

  it("fails closed on malformed success JSON and exposes a bounded server error", async () => {
    await expect(
      readPreviewResponse(
        new Response("not JSON"),
        customerReturnFlowReviewSchema,
      ),
    ).rejects.toThrow("could not be verified");
    await expect(
      readPreviewResponse(
        new Response(
          JSON.stringify({ mode: "admin_preview", effects: "return_created" }),
        ),
        customerReturnFlowReviewSchema,
      ),
    ).rejects.toThrow("could not be verified");
    await expect(
      readPreviewResponse(
        new Response(
          JSON.stringify({
            error: { message: "Choose an available quantity." },
          }),
          { status: 409 },
        ),
        customerReturnFlowReviewSchema,
      ),
    ).rejects.toThrow("Choose an available quantity.");
  });

  it("classifies only the known stale-review response as a source change", async () => {
    await expect(
      readPreviewResponse(
        new Response(
          JSON.stringify({
            error: {
              code: "RETURN_LIVE_REVIEW_CHANGED",
              message: "Provider-specific details must not be displayed.",
            },
          }),
          { status: 409 },
        ),
        customerReturnFlowReviewSchema,
      ),
    ).rejects.toBeInstanceOf(ReturnSourceChangedError);
    await expect(
      readPreviewResponse(
        new Response(
          JSON.stringify({
            error: {
              code: "RETURN_LIVE_REVIEW_CHANGED",
              message: "Provider-specific details must not be displayed.",
            },
          }),
          { status: 503 },
        ),
        customerReturnFlowReviewSchema,
      ),
    ).rejects.not.toBeInstanceOf(ReturnSourceChangedError);
  });
});
