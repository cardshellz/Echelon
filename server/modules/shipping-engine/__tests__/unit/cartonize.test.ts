import { describe, expect, it } from "vitest";
import {
  cartonize,
  type CartonizeBox,
  type CartonizeItem,
} from "../../domain/cartonize";

function box(overrides: Partial<CartonizeBox> & Pick<CartonizeBox, "id" | "code" | "lengthMm" | "widthMm" | "heightMm">): CartonizeBox {
  return {
    kind: "box",
    tareWeightGrams: 50,
    maxWeightGrams: 20000,
    costCents: 40,
    fillFactorBps: 8500,
    isActive: true,
    ...overrides,
  };
}

function item(overrides: Partial<CartonizeItem> & Pick<CartonizeItem, "productVariantId">): CartonizeItem {
  return {
    sku: `SKU-${overrides.productVariantId}`,
    quantity: 1,
    weightGrams: 100,
    lengthMm: 100,
    widthMm: 80,
    heightMm: 20,
    shippingGroupCode: "protection",
    shipsInOwnContainer: false,
    riderEligible: false,
    riderVoidCm3: null,
    riderVoidMaxWeightGrams: null,
    riderVoidMaxItems: null,
    ...overrides,
  };
}

const SMALL = box({ id: 1, code: "S", lengthMm: 150, widthMm: 100, heightMm: 50 });
const MEDIUM = box({ id: 2, code: "M", lengthMm: 250, widthMm: 200, heightMm: 100 });
const LARGE = box({ id: 3, code: "L", lengthMm: 450, widthMm: 350, heightMm: 250 });
const BOXES = [SMALL, MEDIUM, LARGE];

function firstCandidate(items: CartonizeItem[], boxes = BOXES, options = {}) {
  return cartonize(items, boxes, options).candidates[0];
}

describe("cartonize", () => {
  it("puts a single small item in the smallest box that fits", () => {
    const c = firstCandidate([item({ productVariantId: 1 })]);
    expect(c.parcels).toHaveLength(1);
    expect(c.parcels[0].boxCode).toBe("S");
    expect(c.parcels[0].estWeightGrams).toBe(150);
  });

  it("consolidates multiple SKUs of the same group into one box", () => {
    const c = firstCandidate([
      item({ productVariantId: 1, quantity: 3 }),
      item({ productVariantId: 2, quantity: 2, lengthMm: 90, widthMm: 60, heightMm: 15, weightGrams: 60 }),
    ]);
    expect(c.parcels).toHaveLength(1);
    expect(c.parcels[0].items).toHaveLength(2);
  });

  it("keeps different shipping groups in separate parcels", () => {
    const c = firstCandidate([
      item({ productVariantId: 1, shippingGroupCode: "protection" }),
      item({ productVariantId: 2, shippingGroupCode: "storage_boxes" }),
    ]);
    expect(c.parcels).toHaveLength(2);
    const groups = c.parcels.map((p) => p.shippingGroupCode).sort();
    expect(groups).toEqual(["protection", "storage_boxes"]);
  });

  it("splits quantity across boxes when the weight cap binds", () => {
    const heavy = item({ productVariantId: 1, quantity: 10, weightGrams: 3000 });
    const c = firstCandidate([heavy], [box({ id: 9, code: "W", lengthMm: 400, widthMm: 300, heightMm: 200, maxWeightGrams: 10000, tareWeightGrams: 100 })]);
    const total = c.parcels.reduce((s, p) => s + p.items.reduce((q, l) => q + l.quantity, 0), 0);
    expect(total).toBe(10);
    expect(c.parcels.length).toBeGreaterThan(1);
    for (const p of c.parcels) {
      expect(p.estWeightGrams).toBeLessThanOrEqual(10000);
    }
  });

  it("respects the volume fill factor", () => {
    const bulky = item({ productVariantId: 1, quantity: 2, lengthMm: 140, widthMm: 90, heightMm: 40, weightGrams: 100 });
    const c = firstCandidate([bulky], [SMALL, MEDIUM]);
    expect(c.parcels[0].boxCode).toBe("M");
  });

  it("ships SIOC items as their own parcels, one per unit", () => {
    const c = firstCandidate([
      item({ productVariantId: 1, quantity: 2, shipsInOwnContainer: true, lengthMm: 500, widthMm: 400, heightMm: 300, weightGrams: 14000, shippingGroupCode: "storage_boxes" }),
      item({ productVariantId: 2 }),
    ]);
    const sioc = c.parcels.filter((p) => p.siocProductVariantId === 1);
    expect(sioc).toHaveLength(2);
    expect(sioc[0].boxId).toBeNull();
    expect(c.parcels.filter((p) => p.boxId != null)).toHaveLength(1);
  });

  it("absorbs a rider-only parcel into SIOC void space and eliminates it", () => {
    const c = firstCandidate([
      item({
        productVariantId: 1, shipsInOwnContainer: true, shippingGroupCode: "storage_boxes",
        lengthMm: 400, widthMm: 300, heightMm: 300, weightGrams: 5000,
        riderVoidCm3: 2000, riderVoidMaxWeightGrams: 500, riderVoidMaxItems: 5,
      }),
      item({ productVariantId: 2, quantity: 3, riderEligible: true, lengthMm: 100, widthMm: 70, heightMm: 10, weightGrams: 50 }),
    ]);
    expect(c.parcels).toHaveLength(1);
    const host = c.parcels[0];
    expect(host.siocProductVariantId).toBe(1);
    const riders = host.items.filter((l) => l.isRider);
    expect(riders).toHaveLength(1);
    expect(riders[0].quantity).toBe(3);
    expect(host.estWeightGrams).toBe(5150);
  });

  it("does NOT absorb riders when the donor parcel is not eliminated whole", () => {
    const c = firstCandidate([
      item({
        productVariantId: 1, shipsInOwnContainer: true, shippingGroupCode: "storage_boxes",
        lengthMm: 400, widthMm: 300, heightMm: 300, weightGrams: 5000,
        riderVoidCm3: 100, riderVoidMaxWeightGrams: 100, riderVoidMaxItems: 1,
      }),
      item({ productVariantId: 2, quantity: 12, riderEligible: true, lengthMm: 100, widthMm: 70, heightMm: 10, weightGrams: 50 }),
    ]);
    expect(c.parcels).toHaveLength(2);
    expect(c.parcels.every((p) => p.items.every((l) => !l.isRider))).toBe(true);
  });

  it("does not absorb riders when the parcel mixes rider and non-rider items", () => {
    const c = firstCandidate([
      item({
        productVariantId: 1, shipsInOwnContainer: true, shippingGroupCode: "storage_boxes",
        lengthMm: 400, widthMm: 300, heightMm: 300, weightGrams: 5000,
        riderVoidCm3: 5000, riderVoidMaxWeightGrams: 5000, riderVoidMaxItems: 50,
      }),
      item({ productVariantId: 2, quantity: 2, riderEligible: true, lengthMm: 100, widthMm: 70, heightMm: 10, weightGrams: 50 }),
      item({ productVariantId: 3, quantity: 1, riderEligible: false }),
    ]);
    expect(c.parcels).toHaveLength(2);
  });

  it("can disable the rider pass", () => {
    const c = firstCandidate([
      item({
        productVariantId: 1, shipsInOwnContainer: true, shippingGroupCode: "storage_boxes",
        lengthMm: 400, widthMm: 300, heightMm: 300, weightGrams: 5000,
        riderVoidCm3: 2000, riderVoidMaxWeightGrams: 500, riderVoidMaxItems: 5,
      }),
      item({ productVariantId: 2, quantity: 3, riderEligible: true, lengthMm: 100, widthMm: 70, heightMm: 10, weightGrams: 50 }),
    ], BOXES, { allowRiders: false });
    expect(c.parcels).toHaveLength(2);
  });

  it("degrades to a fallback parcel with a warning when dims are missing", () => {
    const c = firstCandidate([item({ productVariantId: 1, lengthMm: null })]);
    expect(c.parcels).toHaveLength(1);
    expect(c.parcels[0].reason).toContain("fallback");
    expect(c.warnings.some((w) => w.includes("missing dims"))).toBe(true);
  });

  it("never throws with an empty box catalog", () => {
    const c = firstCandidate([item({ productVariantId: 1 })], []);
    expect(c.parcels).toHaveLength(1);
    expect(c.warnings.some((w) => w.includes("no active boxes"))).toBe(true);
  });

  it("uses a fallback parcel when an item fits no box", () => {
    const c = firstCandidate([item({ productVariantId: 1, lengthMm: 900, widthMm: 900, heightMm: 900 })]);
    expect(c.parcels).toHaveLength(1);
    expect(c.parcels[0].reason).toContain("fallback");
  });

  it("computes billable weight from dimensional weight when it exceeds actual", () => {
    const light = item({ productVariantId: 1, weightGrams: 10, lengthMm: 140, widthMm: 90, heightMm: 40 });
    const c = firstCandidate([light], [SMALL]);
    expect(c.parcels[0].billableWeightGrams).toBeGreaterThan(c.parcels[0].estWeightGrams);
  });

  it("returns distinct candidates when strategies produce different packings", () => {
    const result = cartonize(
      [
        item({ productVariantId: 1, quantity: 4, lengthMm: 140, widthMm: 90, heightMm: 45, weightGrams: 400 }),
        item({ productVariantId: 2, quantity: 4, lengthMm: 200, widthMm: 150, heightMm: 90, weightGrams: 900 }),
      ],
      BOXES,
    );
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    for (const candidate of result.candidates) {
      const total = candidate.parcels.reduce((s, p) => s + p.items.reduce((q, l) => q + l.quantity, 0), 0);
      expect(total).toBe(8);
    }
  });

  it("downsizes an oversized greedy box to the smallest that fits", () => {
    const c = firstCandidate([item({ productVariantId: 1, weightGrams: 60, lengthMm: 90, widthMm: 60, heightMm: 15 })]);
    expect(c.parcels[0].boxCode).toBe("S");
  });

  it("ignores zero-quantity lines", () => {
    const c = firstCandidate([item({ productVariantId: 1, quantity: 0 })]);
    expect(c.parcels).toHaveLength(0);
  });
});
