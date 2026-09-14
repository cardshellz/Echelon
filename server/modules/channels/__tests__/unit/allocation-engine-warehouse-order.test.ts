/**
 * Fixed and ceiling caps are drawn down warehouse by warehouse, so the order in
 * which the engine walks a channel's warehouses decides which warehouse's stock
 * is published per location. That order must come from the assignment
 * priority, never from database row order.
 */

import { describe, it, expect, vi } from "vitest";
import { createAllocationEngine, orderWarehouseAssignments } from "../../allocation-engine.service";
import { ALLOCATION_ERROR_CODES } from "../../allocation-engine.errors";

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
 */
function createMockDb(config: {
  activeChannels: any[];
  warehouseAssignments?: any[];
  fulfillmentWarehouses?: any[];
  allocationRules?: any[];
}) {
  const assignedChannelIds = new Set((config.warehouseAssignments ?? []).map((wa: any) => wa.channelId));
  const needsFallback = config.activeChannels.some((c: any) => !assignedChannelIds.has(c.id));
  const selectSequence: any[][] = [
    config.activeChannels,
    [],
    config.warehouseAssignments ?? [],
    ...(needsFallback ? [config.fulfillmentWarehouses ?? []] : []),
    config.allocationRules ?? [],
    [],
    [],
  ];
  let selectCallCount = 0;
  return {
    select: vi.fn(() => thenableChain(selectSequence[selectCallCount++ % selectSequence.length] ?? [])),
    insert: vi.fn(() => thenableChain([])),
    update: vi.fn(() => thenableChain([])),
    delete: vi.fn(() => thenableChain([])),
    execute: vi.fn(async () => ({ rows: [{ total_outbound: "0" }] })),
    transaction: vi.fn((fn: any) => fn({})),
  };
}

function createMockAtpService(warehouseAtp: Record<number, number>) {
  const variant = { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 20, atpBase: 20 };
  return {
    getAtpBase: vi.fn(async () => 20),
    getAtpPerVariant: vi.fn(async () => [variant]),
    getAtpPerVariantByWarehouse: vi.fn(async (_productId: number, warehouseId: number) => {
      const atp = warehouseAtp[warehouseId] ?? 0;
      return [{ ...variant, atpBase: atp, atpUnits: atp }];
    }),
  };
}

const SHOPIFY = { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 };
const CEILING_SIX = {
  id: 900, channelId: 1, productId: null, productVariantId: null,
  mode: "mirror", sharePct: null, fixedQty: null, floorAtp: 0, floorType: "units", ceilingQty: 6, eligible: true,
};

describe("orderWarehouseAssignments", () => {
  it("orders by priority descending, then warehouse id ascending, without mutating the input", () => {
    const input = [
      { warehouseId: 2, priority: 0 },
      { warehouseId: 3, priority: 5 },
      { warehouseId: 1, priority: 0 },
    ];
    const snapshot = input.map((row) => ({ ...row }));

    expect(orderWarehouseAssignments(input).map((row) => row.warehouseId)).toEqual([3, 1, 2]);
    expect(input).toEqual(snapshot);
  });

  it("treats a missing priority as the column default of zero", () => {
    expect(orderWarehouseAssignments([
      { warehouseId: 4 },
      { warehouseId: 2, priority: 1 },
      { warehouseId: 3, priority: null },
    ]).map((row) => row.warehouseId)).toEqual([2, 3, 4]);
  });

  it("refuses a priority that is not a safe integer instead of sorting unpredictably", () => {
    expect(() => orderWarehouseAssignments([{ warehouseId: 1, priority: Number.NaN }])).toThrow(
      expect.objectContaining({ code: ALLOCATION_ERROR_CODES.INPUT_INVALID, classification: "permanent" }),
    );
  });
});

describe("Allocation Engine — deterministic warehouse walk", () => {
  async function breakdownFor(assignmentsInDbOrder: any[]) {
    const db = createMockDb({
      activeChannels: [SHOPIFY],
      warehouseAssignments: assignmentsInDbOrder,
      allocationRules: [CEILING_SIX],
    });
    const engine = createAllocationEngine(db, createMockAtpService({ 1: 10, 2: 10 }));
    const result = await engine.previewProduct(7);
    return result.allocations[0];
  }

  it("draws a ceiling cap from the higher-priority warehouse first, whatever order the rows arrive in", async () => {
    const preferred = { id: 11, channelId: 1, warehouseId: 2, enabled: true, priority: 5 };
    const other = { id: 12, channelId: 1, warehouseId: 1, enabled: true, priority: 0 };

    const forward = await breakdownFor([other, preferred]);
    const reversed = await breakdownFor([preferred, other]);

    expect(forward.allocatedUnits).toBe(6);
    expect(forward.warehouseBreakdown).toEqual([
      { warehouseId: 2, qty: 6 },
      { warehouseId: 1, qty: 0 },
    ]);
    expect(reversed.warehouseBreakdown).toEqual(forward.warehouseBreakdown);
  });

  it("breaks a priority tie by warehouse id so equal priorities are still reproducible", async () => {
    const a = { id: 11, channelId: 1, warehouseId: 2, enabled: true, priority: 0 };
    const b = { id: 12, channelId: 1, warehouseId: 1, enabled: true, priority: 0 };

    const forward = await breakdownFor([a, b]);
    const reversed = await breakdownFor([b, a]);

    expect(forward.warehouseBreakdown).toEqual([
      { warehouseId: 1, qty: 6 },
      { warehouseId: 2, qty: 0 },
    ]);
    expect(reversed.warehouseBreakdown).toEqual(forward.warehouseBreakdown);
  });

  it("walks the all-warehouses fallback by warehouse id", async () => {
    const db = createMockDb({
      activeChannels: [SHOPIFY],
      warehouseAssignments: [],
      fulfillmentWarehouses: [{ id: 2 }, { id: 1 }],
      allocationRules: [CEILING_SIX],
    });
    const engine = createAllocationEngine(db, createMockAtpService({ 1: 10, 2: 10 }));

    const allocation = (await engine.previewProduct(7)).allocations[0];

    expect(allocation.warehouseScopeSource).toBe("legacy_all_active_fallback");
    expect(allocation.warehouseBreakdown).toEqual([
      { warehouseId: 1, qty: 6 },
      { warehouseId: 2, qty: 0 },
    ]);
  });
});
