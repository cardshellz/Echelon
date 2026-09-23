import { describe, expect, it } from "vitest";
import {
  assertPreviewOrderMatches,
  assertPreviewReviewMatches,
  buildPreviewReviewInput,
  describePreviewItem,
  initialPreviewSelections,
  normalizedPreviewReference,
  PreviewAccessError,
  readPreviewQuantity,
  readPreviewResponse,
  samePreviewQuantities,
  singlePreviewParcel,
  validatePreviewSelections,
  type PreviewSelections,
} from "../../customer-return-preview";
import {
  returnPreviewReviewSchema,
  type ReturnPreviewOrder,
  type ReturnPreviewReview,
} from "@shared/returns/customer-return-preview.contract";

const order: ReturnPreviewOrder = {
  mode: "admin_preview",
  scenarioId: "split_delivered",
  orderReference: "#SAMPLE-1001",
  purchasedAt: "2026-01-01T00:00:00Z",
  evaluatedAt: "2026-02-01T00:00:00Z",
  returnWindowEndsAt: "2027-01-01T00:00:00Z",
  message: null,
  lines: [
    {
      id: "line-a",
      title: "Sleeves",
      variant: "Blue",
      sku: "SAME",
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
    const parcels = singlePreviewParcel(selections);
    const input = buildPreviewReviewInput(order, selections, parcels);
    expect(input.ok).toBe(true);
    if (!input.ok) return;
    expect(input.value.parcels).toEqual([
      {
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

  it("conserves every exact line across multiple boxes and omits zero entries", () => {
    const input = buildPreviewReviewInput(order, selections, [
      {
        key: 1,
        items: [
          { lineId: "line-a", quantity: "1" },
          { lineId: "line-b", quantity: "1" },
        ],
      },
      {
        key: 2,
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
        buildPreviewReviewInput(order, selections, [{ key: 1, items }]).ok,
      ).toBe(false);
    },
  );

  it("rejects an extra empty box rather than silently removing it", () => {
    expect(
      buildPreviewReviewInput(order, selections, [
        ...singlePreviewParcel(selections),
        { key: 2, items: [{ lineId: "line-a", quantity: "0" }] },
      ]),
    ).toEqual({
      ok: false,
      message: "Add an item to box 2, or remove that box.",
    });
  });
});

describe("customer return preview response verification", () => {
  it("keeps order and quantity verification when the standalone flow leaves scenario verification to its gateway", () => {
    expect(() =>
      assertPreviewOrderMatches(order, undefined, order.orderReference),
    ).not.toThrow();
    expect(() =>
      assertPreviewOrderMatches(order, undefined, "OTHER-ORDER"),
    ).toThrow();
    expect(() =>
      assertPreviewOrderMatches(
        { ...order, lines: [{ ...order.lines[2], eligibleQuantity: 1 }] },
        undefined,
        order.orderReference,
      ),
    ).toThrow();
  });

  it("rejects a response for another order/scenario, duplicate line IDs or impossible eligible quantities", () => {
    expect(() =>
      assertPreviewOrderMatches(order, order.scenarioId, " SAMPLE-1001 "),
    ).not.toThrow();
    expect(() =>
      assertPreviewOrderMatches(order, "in_transit", order.orderReference),
    ).toThrow();
    expect(() =>
      assertPreviewOrderMatches(order, order.scenarioId, "SAMPLE-OTHER"),
    ).toThrow();
    expect(() =>
      assertPreviewOrderMatches(
        { ...order, lines: [order.lines[0], order.lines[0]] },
        order.scenarioId,
        order.orderReference,
      ),
    ).toThrow();
    expect(() =>
      assertPreviewOrderMatches(
        { ...order, lines: [{ ...order.lines[2], eligibleQuantity: 1 }] },
        order.scenarioId,
        order.orderReference,
      ),
    ).toThrow();
  });

  it("requires the validated review to correspond to the exact submitted boxes", () => {
    const input = buildPreviewReviewInput(
      order,
      selections,
      singlePreviewParcel(selections),
    );
    if (!input.ok) throw new Error(input.message);
    const response: ReturnPreviewReview = {
      mode: "admin_preview",
      effects: "none",
      orderReference: order.orderReference,
      selectedQuantity: 3,
      refundMethod: "manual_shopify",
      parcels: [
        {
          number: 1,
          items: [
            { lineId: "line-b", title: "Sleeves", quantity: 1 },
            { lineId: "line-a", title: "Sleeves", quantity: 2 },
          ],
        },
      ],
    };
    expect(() =>
      assertPreviewReviewMatches(response, input.value),
    ).not.toThrow();
    expect(() =>
      assertPreviewReviewMatches(
        { ...response, selectedQuantity: 4 },
        input.value,
      ),
    ).toThrow();
    expect(() =>
      assertPreviewReviewMatches(
        {
          ...response,
          parcels: [
            {
              number: 1,
              items: [
                { lineId: "line-a", title: "Sleeves", quantity: 1 },
                { lineId: "line-a", title: "Sleeves", quantity: 2 },
              ],
            },
          ],
        },
        input.value,
      ),
    ).toThrow();
  });

  it.each([401, 403])(
    "classifies access failure %s before trying to read an HTML body",
    async (status) => {
      await expect(
        readPreviewResponse(
          new Response("Sign in", { status }),
          returnPreviewReviewSchema,
        ),
      ).rejects.toBeInstanceOf(PreviewAccessError);
    },
  );

  it("fails closed on malformed success JSON and exposes a bounded server error", async () => {
    await expect(
      readPreviewResponse(new Response("not JSON"), returnPreviewReviewSchema),
    ).rejects.toThrow("could not be verified");
    await expect(
      readPreviewResponse(
        new Response(
          JSON.stringify({ mode: "admin_preview", effects: "return_created" }),
        ),
        returnPreviewReviewSchema,
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
        returnPreviewReviewSchema,
      ),
    ).rejects.toThrow("Choose an available quantity.");
  });
});
