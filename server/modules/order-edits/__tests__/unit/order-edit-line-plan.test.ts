import { describe, expect, it } from "vitest";
import { resolveOrderEditLinePlan } from "../../domain/order-edit-line-plan";

describe("protected order line quantity planning", () => {
  const originals = [{ id: "line-1", variantId: "variant-1", quantity: 1 }];
  it("preserves the original unit and combines only the requested extra units", () => {
    const input = {
      originals,
      changes: [{ lineItemId: "line-1", quantity: 2 }],
      additions: [{ variantId: "variant-1", quantity: 3 }],
      protectedLineIds: ["line-1"],
    };
    const before = structuredClone(input);
    expect(resolveOrderEditLinePlan(input)).toEqual({
      changes: [{ lineItemId: "line-1", quantity: 1 }],
      additions: [
        {
          variantId: "variant-1",
          quantity: 4,
          quantityIncreaseOfLineId: "line-1",
        },
      ],
    });
    expect(input).toEqual(before);
  });
  it.each([0, 1])(
    "keeps a protected decrease or unchanged quantity %i on the original line",
    (quantity) => {
      expect(
        resolveOrderEditLinePlan({
          originals,
          changes: [{ lineItemId: "line-1", quantity }],
          additions: [],
          protectedLineIds: ["line-1"],
        }),
      ).toEqual({
        changes: [{ lineItemId: "line-1", quantity }],
        additions: [],
      });
    },
  );
  it("uses a direct increase when the line is not protected", () => {
    expect(
      resolveOrderEditLinePlan({
        originals,
        changes: [{ lineItemId: "line-1", quantity: 2 }],
        additions: [],
        protectedLineIds: [],
      }).changes[0].quantity,
    ).toBe(2);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN])(
    "rejects invalid quantity %s",
    (quantity) => {
      expect(() =>
        resolveOrderEditLinePlan({
          originals,
          changes: [{ lineItemId: "line-1", quantity }],
          additions: [],
          protectedLineIds: ["line-1"],
        }),
      ).toThrow();
    },
  );
  it("rejects merged quantity overflow", () => {
    expect(() =>
      resolveOrderEditLinePlan({
        originals,
        changes: [{ lineItemId: "line-1", quantity: Number.MAX_SAFE_INTEGER }],
        additions: [{ variantId: "variant-1", quantity: 2 }],
        protectedLineIds: ["line-1"],
      }),
    ).toThrow();
  });
  it("rejects unknown and duplicate identities", () => {
    for (const input of [
      {
        originals,
        changes: [{ lineItemId: "other", quantity: 2 }],
        additions: [],
        protectedLineIds: [],
      },
      { originals, changes: [], additions: [], protectedLineIds: ["other"] },
      {
        originals,
        changes: [
          { lineItemId: "line-1", quantity: 2 },
          { lineItemId: "line-1", quantity: 3 },
        ],
        additions: [],
        protectedLineIds: [],
      },
      {
        originals,
        changes: [],
        additions: [
          { variantId: "variant-1", quantity: 1 },
          { variantId: "variant-1", quantity: 1 },
        ],
        protectedLineIds: [],
      },
    ])
      expect(() => resolveOrderEditLinePlan(input)).toThrow();
  });
  it("rejects ambiguous protected sources for one variant", () => {
    expect(() =>
      resolveOrderEditLinePlan({
        originals: [
          ...originals,
          { id: "line-2", variantId: "variant-1", quantity: 1 },
        ],
        changes: [
          { lineItemId: "line-1", quantity: 2 },
          { lineItemId: "line-2", quantity: 2 },
        ],
        additions: [],
        protectedLineIds: ["line-1", "line-2"],
      }),
    ).toThrow();
  });
  it("rejects a result that exceeds Shopify's bounded line connection", () => {
    expect(() =>
      resolveOrderEditLinePlan({
        originals: Array.from({ length: 250 }, (_, index) => ({
          id: `line-${index}`,
          variantId: `variant-${index}`,
          quantity: 1,
        })),
        changes: [{ lineItemId: "line-1", quantity: 2 }],
        additions: [],
        protectedLineIds: ["line-1"],
      }),
    ).toThrow();
  });
});
