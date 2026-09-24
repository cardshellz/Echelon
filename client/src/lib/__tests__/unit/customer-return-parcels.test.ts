import { describe, expect, it } from "vitest";
import type {
  CustomerReturnFlowOrder,
  CustomerReturnFlowReview,
} from "@shared/returns/customer-return-flow.contract";
import {
  customPreviewParcelSize,
  initialPreviewParcelSize,
  previewParcelProductWeight,
  readPreviewParcelDimensions,
  reconcilePreviewParcelSize,
  type PreviewParcelDraft,
} from "../../customer-return-parcels";
import {
  assertPreviewReviewMatches,
  buildPreviewReviewInput,
} from "../../customer-return-preview";

const dimensions = { lengthMm: 254.0123, widthMm: 203.2, heightMm: 101.6 };
const order: CustomerReturnFlowOrder = {
  sourceRevision: "a".repeat(64),
  orderReference: "1001",
  purchasedAt: "2026-01-01T00:00:00Z",
  evaluatedAt: "2026-02-01T00:00:00Z",
  returnWindowEndsAt: "2027-01-01T00:00:00Z",
  message: null,
  lines: ["a", "b"].map((id) => ({
    id,
    title: "Same product",
    variant: null,
    sku: "SAME",
    unitWeightGrams: 10.2,
    purchasedQuantity: 3,
    deliveredQuantity: 3,
    alreadyReturningQuantity: 0,
    eligibleQuantity: 3,
    message: null,
  })),
  boxOptions: [
    { id: "original-a", dimensions, items: [{ lineId: "a", quantity: 2 }] },
    {
      id: "original-b",
      dimensions: { ...dimensions, lengthMm: 304.8 },
      items: [{ lineId: "b", quantity: 3 }],
    },
  ],
};
const items = [{ lineId: "a", quantity: "2" }];
const parcel = (): PreviewParcelDraft => ({
  key: 1,
  items: structuredClone(items),
  size: initialPreviewParcelSize(order, items),
});

describe("customer return box dimensions and product-only weight", () => {
  it("defaults only one covering original box and requires a choice for ambiguity or combined contents", () => {
    expect(parcel().size).toEqual({
      kind: "original",
      originalBoxId: "original-a",
      automatic: true,
    });
    const ambiguous = {
      ...order,
      boxOptions: [
        ...order.boxOptions,
        { ...order.boxOptions[0], id: "other-a" },
      ],
    };
    expect(initialPreviewParcelSize(ambiguous, items)).toEqual({
      kind: "unselected",
    });
    expect(
      initialPreviewParcelSize(order, [
        ...items,
        { lineId: "b", quantity: "1" },
      ]),
    ).toEqual({ kind: "unselected" });
    expect(initialPreviewParcelSize(order, [])).toEqual({ kind: "unselected" });
    expect(
      initialPreviewParcelSize({ ...order, boxOptions: [] }, items),
    ).toEqual(customPreviewParcelSize());
  });

  it("preserves original millimeter precision when rounded inch fields are unchanged", () => {
    const draft = { ...parcel(), size: customPreviewParcelSize(dimensions) };
    expect(draft.size.lengthInches).toBe("10");
    expect(readPreviewParcelDimensions(order, draft)).toEqual({
      dimensions,
      originalBoxId: null,
    });
    draft.size.lengthInches = "12.125";
    expect(readPreviewParcelDimensions(order, draft).dimensions.lengthMm).toBe(
      307.975,
    );
    expect(dimensions.lengthMm).toBe(254.0123);
  });

  it("suggests a unique original size after an unselected added box receives items", () => {
    const added: PreviewParcelDraft = {
      key: 2,
      size: { kind: "unselected" },
      items: [{ lineId: "a", quantity: "0" }],
    };
    expect(reconcilePreviewParcelSize(order, added)).toBe(added);
    const packed = { ...added, items };
    expect(reconcilePreviewParcelSize(order, packed).size).toEqual({
      kind: "original",
      originalBoxId: "original-a",
      automatic: true,
    });
    const ambiguous = {
      ...order,
      boxOptions: [
        ...order.boxOptions,
        { ...order.boxOptions[0], id: "other-a" },
      ],
    };
    expect(reconcilePreviewParcelSize(ambiguous, packed)).toBe(packed);
    const combined = {
      ...added,
      items: [...items, { lineId: "b", quantity: "1" }],
    };
    expect(reconcilePreviewParcelSize(order, combined)).toBe(combined);
    expect(added.size).toEqual({ kind: "unselected" });
  });

  it.each(["", "0", "-1", "Infinity", "1e3", "12.1234"])(
    "rejects incomplete or invalid dimensions %s",
    (value) => {
      expect(() =>
        readPreviewParcelDimensions(order, {
          ...parcel(),
          size: { ...customPreviewParcelSize(dimensions), lengthInches: value },
        }),
      ).toThrow();
    },
  );

  it("invalidates automatic size coverage but preserves deliberate original and custom choices", () => {
    const changed = { ...parcel(), items: [{ lineId: "b", quantity: "1" }] };
    expect(reconcilePreviewParcelSize(order, changed).size).toEqual({
      kind: "unselected",
    });
    const explicit: PreviewParcelDraft = {
      ...changed,
      size: { kind: "original", originalBoxId: "original-a", automatic: false },
    };
    expect(reconcilePreviewParcelSize(order, explicit)).toBe(explicit);
    expect(readPreviewParcelDimensions(order, explicit).originalBoxId).toBe(
      "original-a",
    );
    const custom: PreviewParcelDraft = {
      ...changed,
      size: customPreviewParcelSize(dimensions),
    };
    expect(reconcilePreviewParcelSize(order, custom)).toBe(custom);
  });

  it("rounds the complete product-only sum once and ignores zero-quantity unknown weights", () => {
    const missing = {
      ...order,
      lines: order.lines.map((line) => ({
        ...line,
        unitWeightGrams: line.id === "b" ? null : line.unitWeightGrams,
      })),
    };
    expect(
      previewParcelProductWeight(missing, {
        items: [...items, { lineId: "b", quantity: "0" }],
      }),
    ).toEqual({ status: "ready", weightGrams: 21 });
    expect(
      previewParcelProductWeight(missing, {
        items: [...items, { lineId: "b", quantity: "1" }],
      }).status,
    ).toBe("unverified");
    expect(
      previewParcelProductWeight(order, {
        items: [{ lineId: "a", quantity: String(Number.MAX_SAFE_INTEGER) }],
      }).status,
    ).toBe("unverified");
    expect(previewParcelProductWeight(order, { items: [] }).status).toBe(
      "empty",
    );
  });

  it("blocks missing weight and verifies exact dimensions and product weight in the returned review", () => {
    const selections = [{ lineId: "a", quantity: 2, reasonCode: null }];
    const missing = {
      ...order,
      lines: order.lines.map((line) => ({ ...line, unitWeightGrams: null })),
    };
    expect(
      buildPreviewReviewInput(missing, selections, [parcel()]),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("verify the product weight"),
    });
    const input = buildPreviewReviewInput(order, selections, [parcel()]);
    if (!input.ok) throw new Error(input.message);
    expect(input.value.parcels[0]).toMatchObject({
      dimensions,
      originalBoxId: "original-a",
    });
    const review: CustomerReturnFlowReview = {
      sourceRevision: order.sourceRevision,
      effects: "none",
      orderReference: order.orderReference,
      selectedQuantity: 2,
      refundMethod: "manual_shopify",
      parcels: [
        {
          number: 1,
          dimensions,
          weightGrams: 21,
          items: [{ lineId: "a", quantity: 2, title: "Same product" }],
        },
      ],
    };
    expect(() =>
      assertPreviewReviewMatches(review, input.value, order),
    ).not.toThrow();
    expect(() =>
      assertPreviewReviewMatches(
        { ...review, parcels: [{ ...review.parcels[0], weightGrams: 22 }] },
        input.value,
        order,
      ),
    ).toThrow();
    expect(() =>
      assertPreviewReviewMatches(
        {
          ...review,
          parcels: [
            {
              ...review.parcels[0],
              dimensions: { ...dimensions, heightMm: 152.4 },
            },
          ],
        },
        input.value,
        order,
      ),
    ).toThrow();
  });
});
