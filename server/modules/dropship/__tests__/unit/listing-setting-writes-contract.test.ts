import { describe, expect, it } from "vitest";
import {
  MAX_SIZE_PRICES_PER_REQUEST,
  saveSizePricesInputSchema,
  saveSizePricesResponseSchema,
} from "../../../../../shared/dropship/listing-setting-writes";

const KEY = "size-prices:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const row = (productVariantId: number, fields: Record<string, unknown> = {}) =>
  ({ productVariantId, priceCents: 1_499, expectedRevisionId: null, ...fields });
const rows = (count: number) => Array.from({ length: count }, (_, index) => row(index + 1));

describe("W8 size prices input (plan PR 9, section 4.2)", () => {
  it("is bound at 200 sizes a request (plan P38)", () => {
    expect(MAX_SIZE_PRICES_PER_REQUEST).toBe(200);
  });

  it("accepts 1 and 200 distinct sizes, and leaves the input as it was", () => {
    const input = Object.freeze({ idempotencyKey: KEY, rows: Object.freeze(rows(200).map((value) => Object.freeze(value))) });
    expect(saveSizePricesInputSchema.parse(input).rows).toHaveLength(200);
    expect(saveSizePricesInputSchema.parse({ idempotencyKey: KEY, rows: [row(7, { expectedRevisionId: 12 })] }))
      .toEqual({ idempotencyKey: KEY, rows: [{ productVariantId: 7, priceCents: 1_499, expectedRevisionId: 12 }] });
  });

  it.each([
    ["no sizes", []],
    ["201 sizes", rows(201)],
    ["the same size twice", [row(7), row(7, { priceCents: 999 })]],
  ])("refuses %s", (_label, value) => {
    expect(saveSizePricesInputSchema.safeParse({ idempotencyKey: KEY, rows: value }).success).toBe(false);
  });

  it.each([
    ["a zero price", { priceCents: 0 }],
    ["a negative price", { priceCents: -100 }],
    ["a fractional price", { priceCents: 14.99 }],
    ["a price past the int4 columns", { priceCents: 2_147_483_648 }],
    ["a price as text", { priceCents: "1499" }],
    ["no price", { priceCents: null }],
    ["a zero size id", { productVariantId: 0 }],
    ["a size id past int4", { productVariantId: 2_147_483_648 }],
    ["a zero expected revision", { expectedRevisionId: 0 }],
    ["a missing expected revision", { expectedRevisionId: undefined }],
    ["a pricing mode", { pricingMode: "fixed" }],
    ["an unknown key", { note: "x" }],
  ])("refuses a row with %s", (_label, fields) => {
    expect(saveSizePricesInputSchema.safeParse({ idempotencyKey: KEY, rows: [row(7, fields)] }).success).toBe(false);
  });

  it.each([
    ["a 7-character key", "abcdefg"],
    ["a key with a space", "size prices:1"],
    ["a 201-character key", "k".repeat(201)],
    ["no key", undefined],
  ])("refuses %s (a 400, never the wrapper's fatal 500)", (_label, idempotencyKey) => {
    expect(saveSizePricesInputSchema.safeParse({ idempotencyKey, rows: [row(7)] }).success).toBe(false);
  });

  it("accepts an 8-character key, and refuses an unknown top-level key", () => {
    expect(saveSizePricesInputSchema.safeParse({ idempotencyKey: "abcdefgh", rows: [row(7)] }).success).toBe(true);
    expect(saveSizePricesInputSchema.safeParse({ idempotencyKey: KEY, rows: [row(7)], storeConnectionId: 22 }).success).toBe(false);
  });
});

describe("W8 size prices answer", () => {
  const size = (productVariantId: number, idempotentReplay: boolean) => ({ productVariantId, revisionId: productVariantId + 1_000, idempotentReplay });

  it("is changed with no replayed size, or replayed with every size replayed", () => {
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "changed", sizes: [size(1, false), size(2, false)] }).success).toBe(true);
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "replayed", sizes: [size(1, true)] }).success).toBe(true);
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "changed", sizes: [size(1, false), size(2, true)] }).success).toBe(false);
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "replayed", sizes: [size(1, false)] }).success).toBe(false);
  });

  it("names each size once, at least one and at most 200, with no other key", () => {
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "changed", sizes: [] }).success).toBe(false);
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "changed", sizes: [size(1, false), size(1, false)] }).success).toBe(false);
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "changed",
      sizes: Array.from({ length: 201 }, (_, index) => size(index + 1, false)) }).success).toBe(false);
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "changed", sizes: [size(1, false)], requestId: 4 }).success).toBe(false);
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "unchanged", sizes: [size(1, false)] }).success).toBe(false);
  });
});
