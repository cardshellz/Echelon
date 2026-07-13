import { describe, expect, it } from "vitest";
import {
  aggregateShadowReport,
  buildCartonizeItems,
  isPackingComplete,
  normalizeWarning,
  runShadow,
  type ShadowDeps,
  type ShadowOrder,
  type ShadowOrderItem,
} from "../../application/shadow-quote.service";
import type { CartonizeBox, CartonizeCandidate, CartonizeItem } from "../../../cartonization/domain/cartonize";
import type { RateQuoteResult } from "../../application/rate-quote.service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function packingInput(overrides: Partial<CartonizeItem> = {}): CartonizeItem {
  return {
    productVariantId: 101,
    sku: "SLV-100",
    quantity: 0,
    weightGrams: 120,
    lengthMm: 100,
    widthMm: 70,
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

const BOX: CartonizeBox = {
  id: 1,
  code: "BOX-S",
  kind: "box",
  lengthMm: 300,
  widthMm: 200,
  heightMm: 150,
  tareWeightGrams: 100,
  maxWeightGrams: null,
  costCents: 50,
  fillFactorBps: 8500,
  isActive: true,
};

function fakeDeps(input: {
  orders: ShadowOrder[];
  itemsByOrder: Map<number, ShadowOrderItem[]>;
  variantIdBySku?: Map<string, number>;
  packingInputs?: Map<number, CartonizeItem>;
  boxes?: CartonizeBox[];
  quotes?: RateQuoteResult;
}): { deps: Partial<ShadowDeps>; snapshots: Array<Record<string, unknown>> } {
  const snapshots: Array<Record<string, unknown>> = [];
  const deps: Partial<ShadowDeps> = {
    loadOrders: async () => input.orders,
    loadOrderItems: async () => input.itemsByOrder,
    resolveVariantIdsBySku: async () => input.variantIdBySku ?? new Map(),
    loadPackingInputs: async () => input.packingInputs ?? new Map(),
    loadActiveBoxes: async () => input.boxes ?? [],
    quoteParcels: async () => input.quotes ?? { zone: null, quotes: [], warnings: ["no rate tables"] },
    persistSnapshot: async (row) => {
      snapshots.push(row as Record<string, unknown>);
    },
    now: () => new Date("2026-07-04T00:00:00Z"),
  };
  return { deps, snapshots };
}

const ORDER: ShadowOrder = {
  id: 7,
  orderNumber: "CS-1007",
  warehouseId: 2,
  shippingPostalCode: "96813",
  shippingCents: 599,
};

// ---------------------------------------------------------------------------
// runShadow end-to-end with injected loaders (no DB, no network)
// ---------------------------------------------------------------------------

describe("runShadow", () => {
  it("returns an empty report when there are no recent orders", async () => {
    const { deps } = fakeDeps({ orders: [], itemsByOrder: new Map() });
    const report = await runShadow({}, deps);
    expect(report).toEqual({
      ordersRun: 0,
      packingComplete: 0,
      packingFallback: 0,
      ratesFound: 0,
      ratesEmpty: 0,
      topWarnings: [],
    });
  });

  it("counts a fully-resolvable order as packingComplete and persists one shadow snapshot", async () => {
    const { deps, snapshots } = fakeDeps({
      orders: [ORDER],
      itemsByOrder: new Map([[7, [{ sku: "SLV-100", quantity: 2 }]]]),
      variantIdBySku: new Map([["SLV-100", 101]]),
      packingInputs: new Map([[101, packingInput()]]),
      boxes: [BOX],
      quotes: {
        zone: "Z4",
        quotes: [{ carrier: "USPS", serviceCode: "ga", totalCents: 899, currency: "USD", perParcelCents: [899] }],
        warnings: [],
      },
    });

    const report = await runShadow({ days: 7, limit: 50 }, deps);
    expect(report.ordersRun).toBe(1);
    expect(report.packingComplete).toBe(1);
    expect(report.packingFallback).toBe(0);
    expect(report.ratesFound).toBe(1);
    expect(report.ratesEmpty).toBe(0);

    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0];
    expect(snapshot.source).toBe("shadow");
    expect(snapshot.destinationCountry).toBe("US");
    expect(snapshot.destinationPostalCode).toBe("96813");
    expect(snapshot.resolvedZone).toBe("Z4");
    expect(snapshot.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.requestPayload).toEqual({
      orderId: 7,
      orderNumber: "CS-1007",
      items: [{ sku: "SLV-100", quantity: 2, productVariantId: 101 }],
    });
    const metadata = snapshot.metadata as Record<string, unknown>;
    expect(metadata.paidShippingCents).toBe(599);
    expect(metadata.packingComplete).toBe(true);
    expect(metadata.ratesFound).toBe(true);
    expect(metadata.originWarehouseId).toBe(2);
  });

  it("counts missing dims + empty rate tables as fallback/empty (data-readiness path)", async () => {
    const { deps, snapshots } = fakeDeps({
      orders: [ORDER],
      itemsByOrder: new Map([[7, [{ sku: "SLV-100", quantity: 1 }]]]),
      variantIdBySku: new Map([["SLV-100", 101]]),
      packingInputs: new Map([[101, packingInput({ weightGrams: null, lengthMm: null, widthMm: null, heightMm: null })]]),
      boxes: [BOX],
    });

    const report = await runShadow({}, deps);
    expect(report.packingComplete).toBe(0);
    expect(report.packingFallback).toBe(1);
    expect(report.ratesFound).toBe(0);
    expect(report.ratesEmpty).toBe(1);
    expect(report.topWarnings.length).toBeGreaterThan(0);

    const metadata = snapshots[0].metadata as Record<string, unknown>;
    expect(metadata.packingComplete).toBe(false);
    expect(metadata.ratesFound).toBe(false);
  });

  it("stubs unresolvable SKUs instead of dropping units", async () => {
    const { deps, snapshots } = fakeDeps({
      orders: [ORDER],
      itemsByOrder: new Map([[7, [{ sku: "GHOST-1", quantity: 3 }]]]),
      boxes: [BOX],
    });

    const report = await runShadow({}, deps);
    expect(report.packingFallback).toBe(1);
    expect(report.topWarnings.some((w) => w.warning.includes("not found in catalog"))).toBe(true);
    expect(snapshots[0].requestPayload).toEqual({
      orderId: 7,
      orderNumber: "CS-1007",
      items: [{ sku: "GHOST-1", quantity: 3, productVariantId: null }],
    });
  });

  it("defaults the origin warehouse when the order has none", async () => {
    const { deps, snapshots } = fakeDeps({
      orders: [{ ...ORDER, warehouseId: null }],
      itemsByOrder: new Map([[7, [{ sku: "SLV-100", quantity: 1 }]]]),
      variantIdBySku: new Map([["SLV-100", 101]]),
      packingInputs: new Map([[101, packingInput()]]),
      boxes: [BOX],
    });
    await runShadow({}, deps);
    const metadata = snapshots[0].metadata as Record<string, unknown>;
    expect(metadata.originWarehouseId).toBe(1);
  });

  it("continues the run when one order throws, counting it degraded", async () => {
    const base = fakeDeps({
      orders: [ORDER, { ...ORDER, id: 8, orderNumber: "CS-1008" }],
      itemsByOrder: new Map([
        [7, [{ sku: "SLV-100", quantity: 1 }]],
        [8, [{ sku: "SLV-100", quantity: 1 }]],
      ]),
      variantIdBySku: new Map([["SLV-100", 101]]),
      packingInputs: new Map([[101, packingInput()]]),
      boxes: [BOX],
      quotes: { zone: "Z4", quotes: [{ carrier: "USPS", serviceCode: "ga", totalCents: 899, currency: "USD", perParcelCents: [899] }], warnings: [] },
    });
    let calls = 0;
    const deps: Partial<ShadowDeps> = {
      ...base.deps,
      quoteParcels: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { zone: "Z4", quotes: [{ carrier: "USPS", serviceCode: "ga", totalCents: 899, currency: "USD", perParcelCents: [899] }], warnings: [] };
      },
    };

    const report = await runShadow({}, deps);
    expect(report.ordersRun).toBe(2);
    expect(report.ratesFound).toBe(1);
    expect(report.ratesEmpty).toBe(1);
    expect(report.topWarnings.some((w) => w.warning.includes("shadow run failed"))).toBe(true);
  });

  it("keeps running when the snapshot write fails, surfacing a warning", async () => {
    const base = fakeDeps({
      orders: [ORDER],
      itemsByOrder: new Map([[7, [{ sku: "SLV-100", quantity: 1 }]]]),
      variantIdBySku: new Map([["SLV-100", 101]]),
      packingInputs: new Map([[101, packingInput()]]),
      boxes: [BOX],
    });
    const deps: Partial<ShadowDeps> = {
      ...base.deps,
      persistSnapshot: async () => {
        throw new Error("db down");
      },
    };
    const report = await runShadow({}, deps);
    expect(report.ordersRun).toBe(1);
    expect(report.topWarnings.some((w) => w.warning.includes("snapshot persist failed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildCartonizeItems", () => {
  it("applies line quantities onto packing inputs", () => {
    const { items, warnings } = buildCartonizeItems(
      [{ sku: "SLV-100", quantity: 4 }],
      new Map([["SLV-100", 101]]),
      new Map([[101, packingInput()]]),
    );
    expect(warnings).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(4);
    expect(items[0].productVariantId).toBe(101);
  });

  it("skips non-positive quantities and stubs unknown SKUs with unique synthetic ids", () => {
    const { items, warnings } = buildCartonizeItems(
      [
        { sku: "GHOST-1", quantity: 1 },
        { sku: "GHOST-2", quantity: 2 },
        { sku: "SLV-100", quantity: 0 },
      ],
      new Map([["SLV-100", 101]]),
      new Map([[101, packingInput()]]),
    );
    expect(items).toHaveLength(2);
    expect(items[0].productVariantId).not.toBe(items[1].productVariantId);
    expect(items.every((i) => i.productVariantId < 0)).toBe(true);
    expect(warnings).toHaveLength(2);
  });
});

describe("isPackingComplete", () => {
  const parcel = {
    boxId: 1, boxCode: "BOX-S", siocProductVariantId: null,
    items: [{ productVariantId: 101, sku: "SLV-100", quantity: 1, isRider: false }],
    placements: [{
      productVariantId: 101, sku: "SLV-100", unitSequence: 1,
      orientation: "LWH",
      xMm: 0, yMm: 0, zMm: 0, lengthMm: 1, widthMm: 1, heightMm: 1,
    }],
    estWeightGrams: 100, billableWeightGrams: 100,
    lengthMm: 1, widthMm: 1, heightMm: 1, shippingGroupCode: null,
    reason: "packed fewest-parcels",
  };

  it("is true only when every parcel packed for real", () => {
    const complete: CartonizeCandidate = { strategy: "fewest-parcels", parcels: [parcel], warnings: [] };
    expect(isPackingComplete(complete)).toBe(true);
  });

  it("is false for fallback parcels, empty packings, and the fallback strategy", () => {
    const withFallback: CartonizeCandidate = {
      strategy: "fewest-parcels",
      parcels: [parcel, { ...parcel, reason: "fallback: could not verify fit" }],
      warnings: [],
    };
    expect(isPackingComplete(withFallback)).toBe(false);
    expect(isPackingComplete({ strategy: "fewest-parcels", parcels: [], warnings: [] })).toBe(false);
    expect(isPackingComplete({ strategy: "fallback", parcels: [parcel], warnings: [] })).toBe(false);
  });
});

describe("normalizeWarning", () => {
  it("collapses SKUs, ids, and weights so the same problem counts once", () => {
    expect(normalizeWarning("item SLV-100 missing dims/weight; used fallback parcel"))
      .toBe(normalizeWarning("item CASE-9 missing dims/weight; used fallback parcel"));
    expect(normalizeWarning("parcel 1 (2500g): no rate band covers this weight in zone Z4"))
      .toBe(normalizeWarning("parcel 2 (990g): no rate band covers this weight in zone Z8"));
  });

  it("leaves digit-free warnings intact", () => {
    expect(normalizeWarning("no active boxes in catalog; all boxed items degraded to fallback parcels"))
      .toBe("no active boxes in catalog; all boxed items degraded to fallback parcels");
  });
});

describe("aggregateShadowReport", () => {
  it("tallies outcomes and ranks the top 5 normalized warnings", () => {
    const outcomes = [
      { packingComplete: true, ratesFound: true, warnings: [] },
      { packingComplete: false, ratesFound: false, warnings: ["item A-1 missing dims/weight; used fallback parcel", "w-b 1", "w-c", "w-d", "w-e", "w-f"] },
      { packingComplete: false, ratesFound: false, warnings: ["item B-2 missing dims/weight; used fallback parcel"] },
      { packingComplete: false, ratesFound: true, warnings: ["item C-3 missing dims/weight; used fallback parcel"] },
    ];
    const report = aggregateShadowReport(outcomes);
    expect(report.ordersRun).toBe(4);
    expect(report.packingComplete).toBe(1);
    expect(report.packingFallback).toBe(3);
    expect(report.ratesFound).toBe(2);
    expect(report.ratesEmpty).toBe(2);
    expect(report.topWarnings).toHaveLength(5);
    expect(report.topWarnings[0]).toEqual({
      warning: "item # missing dims/weight; used fallback parcel",
      count: 3,
    });
  });
});
