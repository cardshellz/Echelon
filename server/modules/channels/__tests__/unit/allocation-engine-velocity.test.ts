/**
 * Unit Tests — Allocation Engine days-of-cover velocity and input guards.
 *
 * The engine must never publish on a failed or missing velocity read: a
 * days-of-cover rule whose velocity cannot be read fails the whole product
 * run with a classified transient error, and the reading is scoped to one run.
 */

import { describe, it, expect, vi } from "vitest";
import { createAllocationEngine, VELOCITY_LOOKBACK_DAYS } from "../../allocation-engine.service";
import { ALLOCATION_ERROR_CODES, AllocationEngineError } from "../../allocation-engine.errors";

function thenableChain(data: any[]) {
  const chain: any = {};
  chain.then = (resolve: any, reject?: any) => Promise.resolve(data).then(resolve, reject);
  chain.catch = (fn: any) => Promise.resolve(data).catch(fn);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => chain);
  return chain;
}

/**
 * Select order (see allocation-engine.test.ts): active channels, product line
 * products, [channel product lines], warehouse assignments, [fulfillment
 * warehouses], allocation rules, product overrides, variant overrides.
 * The mock repeats the sequence so one engine can run more than once.
 */
function createMockDb(config: {
  activeChannels?: any[];
  warehouseAssignments?: any[];
  fulfillmentWarehouses?: any[];
  allocationRules?: any[];
  velocityRows?: Array<{ total_outbound: string | number }>;
  velocityError?: Error;
} = {}) {
  const activeChannels = config.activeChannels ?? [];
  const assignedChannelIds = new Set((config.warehouseAssignments ?? []).map((wa: any) => wa.channelId));
  const needsFallback = activeChannels.some((c: any) => !assignedChannelIds.has(c.id));

  const selectSequence: any[][] = [
    activeChannels,
    [],
    config.warehouseAssignments ?? [],
    ...(needsFallback ? [config.fulfillmentWarehouses ?? [{ id: 1 }]] : []),
    config.allocationRules ?? [],
    [],
    [],
  ];
  let selectCallCount = 0;

  return {
    select: vi.fn(() => {
      const idx = selectCallCount % selectSequence.length;
      selectCallCount++;
      return thenableChain(selectSequence[idx] ?? []);
    }),
    insert: vi.fn(() => thenableChain([])),
    update: vi.fn(() => thenableChain([])),
    delete: vi.fn(() => thenableChain([])),
    execute: vi.fn(async () => {
      if (config.velocityError) throw config.velocityError;
      return { rows: config.velocityRows ?? [{ total_outbound: "0" }] };
    }),
    transaction: vi.fn((fn: any) => fn({})),
  };
}

function createMockAtpService(config: { variants: any[]; warehouseAtp?: Record<number, number> }) {
  const { variants, warehouseAtp = {} } = config;
  return {
    getAtpBase: vi.fn(async () => (variants.length > 0 ? variants[0].atpBase : 0)),
    getAtpPerVariant: vi.fn(async () => variants),
    getAtpPerVariantByWarehouse: vi.fn(async (_productId: number, warehouseId: number) => {
      const whAtp = warehouseAtp[warehouseId] ?? 0;
      return variants.map((v: any) => ({
        ...v,
        atpBase: whAtp,
        atpUnits: Math.floor(whAtp / v.unitsPerVariant),
      }));
    }),
  };
}

const VARIANT = { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 10, atpBase: 10 };
const SHOPIFY = { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 };
const EBAY = { id: 2, name: "eBay", provider: "ebay", status: "active", priority: 0 };

function daysRule(channelId: number | null, floorDays: number) {
  return {
    id: 500 + (channelId ?? 0),
    channelId,
    productId: null,
    productVariantId: null,
    mode: "mirror",
    sharePct: null,
    fixedQty: null,
    floorAtp: floorDays,
    floorType: "days",
    ceilingQty: null,
    eligible: true,
  };
}

/** 450 base units over the 90-day window is 5 units per day. */
const VELOCITY_ROWS = [{ total_outbound: "450" }];
const EXPECTED_AVG_DAILY_USAGE = 450 / VELOCITY_LOOKBACK_DAYS;

describe("Allocation Engine — days-of-cover velocity", () => {
  it("zeroes the channel when ATP is below the days-of-cover floor and records the reading", async () => {
    const db = createMockDb({
      activeChannels: [SHOPIFY],
      warehouseAssignments: [{ channelId: 1, warehouseId: 1, enabled: true }],
      allocationRules: [daysRule(1, 10)],
      velocityRows: VELOCITY_ROWS,
    });
    const engine = createAllocationEngine(db, createMockAtpService({ variants: [VARIANT], warehouseAtp: { 1: 10 } }));

    const result = await engine.allocateProduct(7, "test");

    // floor = ceil(10 days × 5/day) = 50 > ATP 10
    expect(result.allocations[0].allocatedUnits).toBe(0);
    expect(result.allocations[0].method).toBe("zero");
    expect(result.allocations[0].reason).toContain("days-of-cover");
    expect(result.allocations[0].velocity).toEqual({
      status: "read",
      avgDailyUsage: EXPECTED_AVG_DAILY_USAGE,
      lookbackDays: VELOCITY_LOOKBACK_DAYS,
    });
  });

  it("allocates normally when ATP covers the days-of-cover floor", async () => {
    const variant = { ...VARIANT, atpUnits: 100, atpBase: 100 };
    const db = createMockDb({
      activeChannels: [SHOPIFY],
      warehouseAssignments: [{ channelId: 1, warehouseId: 1, enabled: true }],
      allocationRules: [daysRule(1, 10)],
      velocityRows: VELOCITY_ROWS,
    });
    const engine = createAllocationEngine(db, createMockAtpService({ variants: [variant], warehouseAtp: { 1: 100 } }));

    const result = await engine.allocateProduct(7);

    expect(result.allocations[0].allocatedUnits).toBe(100);
    expect(result.allocations[0].velocity.status).toBe("read");
  });

  it("fails closed with a transient error when the velocity query throws, and writes no audit rows", async () => {
    const db = createMockDb({
      activeChannels: [SHOPIFY],
      warehouseAssignments: [{ channelId: 1, warehouseId: 1, enabled: true }],
      allocationRules: [daysRule(1, 10)],
      velocityError: new Error("relation wms.order_items does not exist"),
    });
    const engine = createAllocationEngine(db, createMockAtpService({ variants: [VARIANT], warehouseAtp: { 1: 10 } }));

    const failure = await engine.allocateProduct(7, "test").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AllocationEngineError);
    expect(failure).toMatchObject({
      code: ALLOCATION_ERROR_CODES.VELOCITY_UNAVAILABLE,
      classification: "transient",
      context: { productId: 7, lookbackDays: VELOCITY_LOOKBACK_DAYS },
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("reads velocity once per run even when several channels need it, and never across runs", async () => {
    const db = createMockDb({
      activeChannels: [SHOPIFY, EBAY],
      warehouseAssignments: [
        { channelId: 1, warehouseId: 1, enabled: true },
        { channelId: 2, warehouseId: 1, enabled: true },
      ],
      allocationRules: [daysRule(null, 3)],
      velocityRows: VELOCITY_ROWS,
    });
    const engine = createAllocationEngine(db, createMockAtpService({ variants: [VARIANT], warehouseAtp: { 1: 10 } }));

    await engine.allocateProduct(7);
    expect(db.execute).toHaveBeenCalledTimes(1);

    await engine.allocateProduct(7);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("does not read velocity when no rule needs it", async () => {
    const db = createMockDb({
      activeChannels: [SHOPIFY],
      warehouseAssignments: [{ channelId: 1, warehouseId: 1, enabled: true }],
      allocationRules: [{ ...daysRule(1, 0), floorType: "units" }],
    });
    const engine = createAllocationEngine(db, createMockAtpService({ variants: [VARIANT], warehouseAtp: { 1: 10 } }));

    const result = await engine.allocateProduct(7);

    expect(db.execute).not.toHaveBeenCalled();
    expect(result.allocations[0].velocity).toEqual({ status: "not_required" });
    expect(result.allocations[0].allocatedUnits).toBe(10);
  });

  it("rejects a velocity reading that is not a finite non-negative number as permanent", async () => {
    const db = createMockDb({
      activeChannels: [SHOPIFY],
      warehouseAssignments: [{ channelId: 1, warehouseId: 1, enabled: true }],
      allocationRules: [daysRule(1, 10)],
      velocityRows: [{ total_outbound: "not-a-number" }],
    });
    const engine = createAllocationEngine(db, createMockAtpService({ variants: [VARIANT], warehouseAtp: { 1: 10 } }));

    await expect(engine.allocateProduct(7)).rejects.toMatchObject({
      code: ALLOCATION_ERROR_CODES.VELOCITY_INVALID,
      classification: "permanent",
    });
  });

  it.each([
    { label: "no row at all", velocityRows: [] },
    { label: "a null total", velocityRows: [{ total_outbound: null as unknown as string }] },
  ])("refuses a velocity result with $label instead of reading it as zero demand", async ({ velocityRows }) => {
    const db = createMockDb({
      activeChannels: [SHOPIFY],
      warehouseAssignments: [{ channelId: 1, warehouseId: 1, enabled: true }],
      allocationRules: [daysRule(1, 10)],
      velocityRows,
    });
    const engine = createAllocationEngine(db, createMockAtpService({ variants: [VARIANT], warehouseAtp: { 1: 10 } }));

    await expect(engine.allocateProduct(7)).rejects.toMatchObject({
      code: ALLOCATION_ERROR_CODES.VELOCITY_INVALID,
      classification: "permanent",
      context: { productId: 7, totalOutbound: null },
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("persists velocity, warehouse scope, and breakdown in the audit details", async () => {
    const db = createMockDb({
      activeChannels: [SHOPIFY],
      warehouseAssignments: [],
      fulfillmentWarehouses: [{ id: 1 }, { id: 2 }],
      allocationRules: [daysRule(1, 1)],
      velocityRows: VELOCITY_ROWS,
    });
    const variant = { ...VARIANT, atpUnits: 100, atpBase: 100 };
    const engine = createAllocationEngine(db, createMockAtpService({ variants: [variant], warehouseAtp: { 1: 60, 2: 40 } }));

    const result = await engine.allocateProduct(7, "unit-test");

    expect(result.allocations[0].warehouseScopeSource).toBe("legacy_all_active_fallback");
    const insertChain = db.insert.mock.results[0]?.value;
    const [auditRows] = insertChain.values.mock.calls[0];
    expect(auditRows[0]).toMatchObject({
      productId: 7,
      channelId: 1,
      allocatedQty: 100,
      triggeredBy: "unit-test",
      details: {
        warehouseScopeSource: "legacy_all_active_fallback",
        warehouseBreakdown: [{ warehouseId: 1, qty: 60 }, { warehouseId: 2, qty: 40 }],
        velocity: { status: "read", avgDailyUsage: EXPECTED_AVG_DAILY_USAGE, lookbackDays: VELOCITY_LOOKBACK_DAYS },
      },
    });
  });
});

describe("Allocation Engine — input and rule guards", () => {
  it("rejects a variant with zero units per variant as a permanent input error", async () => {
    const db = createMockDb({
      activeChannels: [SHOPIFY],
      warehouseAssignments: [{ channelId: 1, warehouseId: 1, enabled: true }],
    });
    const engine = createAllocationEngine(db, createMockAtpService({
      variants: [{ ...VARIANT, unitsPerVariant: 0 }],
      warehouseAtp: { 1: 10 },
    }));

    await expect(engine.allocateProduct(7)).rejects.toMatchObject({
      code: ALLOCATION_ERROR_CODES.INPUT_INVALID,
      classification: "permanent",
      context: { productId: 7, productVariantId: 1, field: "unitsPerVariant" },
    });
  });

  it("rejects a share above 100 percent as a permanent rule error", async () => {
    const db = createMockDb({
      activeChannels: [SHOPIFY],
      warehouseAssignments: [{ channelId: 1, warehouseId: 1, enabled: true }],
      allocationRules: [{ ...daysRule(1, 0), floorType: "units", mode: "share", sharePct: 150 }],
    });
    const engine = createAllocationEngine(db, createMockAtpService({ variants: [VARIANT], warehouseAtp: { 1: 10 } }));

    await expect(engine.allocateProduct(7)).rejects.toMatchObject({
      code: ALLOCATION_ERROR_CODES.RULE_INVALID,
      classification: "permanent",
      context: { channelId: 1, field: "sharePct", value: 150 },
    });
  });

  it("rejects an unknown allocation mode instead of treating it as mirror", async () => {
    const db = createMockDb({
      activeChannels: [SHOPIFY],
      warehouseAssignments: [{ channelId: 1, warehouseId: 1, enabled: true }],
      allocationRules: [{ ...daysRule(1, 0), floorType: "units", mode: "priority" }],
    });
    const engine = createAllocationEngine(db, createMockAtpService({ variants: [VARIANT], warehouseAtp: { 1: 10 } }));

    await expect(engine.allocateProduct(7)).rejects.toMatchObject({
      code: ALLOCATION_ERROR_CODES.RULE_INVALID,
      context: { field: "mode", value: "priority" },
    });
  });
});
