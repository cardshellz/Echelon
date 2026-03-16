/**
 * Unit Tests — Allocation Engine (Parallel Percentage Model)
 *
 * Tests the three-layer parallel allocation:
 *   Layer 1: Warehouse → Channel scoping
 *   Layer 2: Allocation rules (mirror/share/fixed, floor/ceiling/eligible)
 *   Layer 3: Independent parallel ATP calculation
 *
 * Uses mocked DB and ATP service.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAllocationEngine } from "../../allocation-engine.service";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

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
 * The allocation engine makes these DB queries in order:
 * 1. Active channels
 * 2. Product line products
 * 3. Channel product lines (ONLY if productLineRows non-empty)
 * 4. Warehouse assignments
 * 5. Fulfillment warehouses (ONLY if some channels have no assignments)
 * 6. Allocation rules
 */
function createMockDb(config: {
  activeChannels?: any[];
  productLineRows?: any[];
  channelLineRows?: any[];
  warehouseAssignments?: any[];
  fulfillmentWarehouses?: any[];
  allocationRules?: any[];
} = {}) {
  let selectCallCount = 0;

  const selectSequence: any[][] = [
    config.activeChannels ?? [],       // 1: active channels
    config.productLineRows ?? [],      // 2: product line products
  ];

  if ((config.productLineRows ?? []).length > 0) {
    selectSequence.push(config.channelLineRows ?? []); // 3: channel product lines (conditional)
  }

  selectSequence.push(config.warehouseAssignments ?? []); // 4: warehouse assignments

  // 5: fulfillment warehouses — only queried if channels need defaults
  const activeChannels = config.activeChannels ?? [];
  const assignedChannelIds = new Set(
    (config.warehouseAssignments ?? []).map((wa: any) => wa.channelId),
  );
  const channelsNeedingDefault = activeChannels.filter(
    (c: any) => !assignedChannelIds.has(c.id),
  );
  if (channelsNeedingDefault.length > 0) {
    selectSequence.push(
      config.fulfillmentWarehouses ?? [{ id: 1 }, { id: 2 }], // default fallback
    );
  }

  selectSequence.push(config.allocationRules ?? []); // 6: allocation rules

  return {
    select: vi.fn(() => {
      const idx = selectCallCount;
      selectCallCount++;
      return thenableChain(selectSequence[idx] ?? []);
    }),
    insert: vi.fn(() => thenableChain([])),
    update: vi.fn(() => thenableChain([])),
    delete: vi.fn(() => thenableChain([])),
    transaction: vi.fn((fn: any) => fn({
      select: vi.fn(() => thenableChain([])),
      insert: vi.fn(() => thenableChain([])),
    })),
  };
}

function createMockAtpService(config: {
  /** Global variants (from getAtpPerVariant) */
  variants: any[];
  /** Per-warehouse ATP in base units: { warehouseId: atpBase } */
  warehouseAtp?: Record<number, number>;
}) {
  const { variants, warehouseAtp = {} } = config;
  const globalAtpBase = variants.length > 0 ? variants[0].atpBase : 0;

  return {
    getAtpBase: vi.fn(async () => globalAtpBase),
    getAtpPerVariant: vi.fn(async () => variants),
    getAtpPerVariantByWarehouse: vi.fn(async (_productId: number, warehouseId: number) => {
      const whAtp = warehouseAtp[warehouseId] ?? 0;
      return variants.map((v: any) => ({
        ...v,
        atpBase: whAtp,
        atpUnits: Math.floor(whAtp / v.unitsPerVariant),
      }));
    }),
    getAtpBaseByWarehouse: vi.fn(async (_productId: number, warehouseId: number) => {
      return warehouseAtp[warehouseId] ?? 0;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Allocation Engine (Parallel Model)", () => {
  // -----------------------------------------------------------------------
  // Layer 1: Warehouse scoping
  // -----------------------------------------------------------------------

  describe("warehouse scoping", () => {
    it("should scope ATP to assigned warehouses per channel", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1500, atpBase: 1500 },
      ];
      const channels = [
        { id: 36, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
        { id: 37, name: "Shopify-Canada", provider: "shopify", status: "active", priority: 0 },
      ];
      // Shopify-US → LEON (1) + RTE-19 (2), Shopify-CA → SM-CA (35)
      const warehouseAssignments = [
        { channelId: 36, warehouseId: 1, enabled: true },
        { channelId: 36, warehouseId: 2, enabled: true },
        { channelId: 37, warehouseId: 35, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = {
        1: 800,   // LEON
        2: 200,   // RTE-19
        35: 500,  // SM-CA
      };

      const db = createMockDb({ activeChannels: channels, warehouseAssignments });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      // Shopify-US sees LEON + RTE-19 = 800 + 200 = 1000
      const shopifyAlloc = result.allocations.find(a => a.channelId === 36);
      expect(shopifyAlloc?.allocatedUnits).toBe(1000);
      expect(shopifyAlloc?.method).toBe("mirror");

      // Shopify-CA sees SM-CA only = 500
      const caAlloc = result.allocations.find(a => a.channelId === 37);
      expect(caAlloc?.allocatedUnits).toBe(500);
      expect(caAlloc?.method).toBe("mirror");
    });

    it("should fall back to all fulfillment warehouses when no assignments exist", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 36, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
      ];
      const fulfillmentWarehouses = [{ id: 1 }, { id: 2 }, { id: 34 }];
      const warehouseAtp: Record<number, number> = { 1: 400, 2: 300, 34: 300 };

      const db = createMockDb({
        activeChannels: channels,
        warehouseAssignments: [],
        fulfillmentWarehouses,
      });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      const alloc = result.allocations.find(a => a.channelId === 36);
      // All fulfillment warehouses: 400 + 300 + 300 = 1000
      expect(alloc?.allocatedUnits).toBe(1000);
    });
  });

  // -----------------------------------------------------------------------
  // Layer 2: Allocation rules — mirror/share/fixed
  // -----------------------------------------------------------------------

  describe("allocation modes", () => {
    it("should mirror 100% of warehouse-scoped ATP by default", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
        { id: 2, name: "eBay", provider: "ebay", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
        { channelId: 2, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 1000 };

      const db = createMockDb({ activeChannels: channels, warehouseAssignments });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      // Both channels independently see 100% — parallel, not serial
      const shopify = result.allocations.find(a => a.channelId === 1);
      const ebay = result.allocations.find(a => a.channelId === 2);
      expect(shopify?.allocatedUnits).toBe(1000);
      expect(ebay?.allocatedUnits).toBe(1000);
      expect(shopify?.method).toBe("mirror");
      expect(ebay?.method).toBe("mirror");
    });

    it("should apply share percentage independently per channel", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
        { id: 2, name: "Shopify-CA", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
        { channelId: 2, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 1000 };
      const allocationRules = [
        { channelId: 1, productId: null, productVariantId: null, mode: "mirror", sharePct: null, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: true },
        { channelId: 2, productId: null, productVariantId: null, mode: "share", sharePct: 90, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: true },
      ];

      const db = createMockDb({ activeChannels: channels, warehouseAssignments, allocationRules });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      const shopify = result.allocations.find(a => a.channelId === 1);
      expect(shopify?.allocatedUnits).toBe(1000);
      expect(shopify?.method).toBe("mirror");

      const ca = result.allocations.find(a => a.channelId === 2);
      expect(ca?.allocatedUnits).toBe(900); // 90% of 1000
      expect(ca?.method).toBe("share");
    });

    it("should apply fixed quantity allocation", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 1000 };
      const allocationRules = [
        { channelId: 1, productId: null, productVariantId: null, mode: "fixed", sharePct: null, fixedQty: 200, floorAtp: 0, ceilingQty: null, eligible: true },
      ];

      const db = createMockDb({ activeChannels: channels, warehouseAssignments, allocationRules });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      const alloc = result.allocations.find(a => a.channelId === 1);
      expect(alloc?.allocatedUnits).toBe(200);
      expect(alloc?.method).toBe("fixed");
    });

    it("should cap fixed qty at available ATP", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 50, atpBase: 50 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 50 };
      const allocationRules = [
        { channelId: 1, productId: null, productVariantId: null, mode: "fixed", sharePct: null, fixedQty: 200, floorAtp: 0, ceilingQty: null, eligible: true },
      ];

      const db = createMockDb({ activeChannels: channels, warehouseAssignments, allocationRules });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      expect(result.allocations[0].allocatedUnits).toBe(50);
    });
  });

  // -----------------------------------------------------------------------
  // Rule scoping — most specific wins
  // -----------------------------------------------------------------------

  describe("rule scoping (most specific wins)", () => {
    it("should use product-level override over channel default", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 1000 };
      const allocationRules = [
        // Channel default: mirror
        { channelId: 1, productId: null, productVariantId: null, mode: "mirror", sharePct: null, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: true },
        // Product override: share 50%
        { channelId: 1, productId: 1, productVariantId: null, mode: "share", sharePct: 50, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: true },
      ];

      const db = createMockDb({ activeChannels: channels, warehouseAssignments, allocationRules });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      expect(result.allocations[0].allocatedUnits).toBe(500);
      expect(result.allocations[0].method).toBe("share");
    });

    it("should use variant-level override over product and channel defaults", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 1000 };
      const allocationRules = [
        // Channel default: mirror
        { channelId: 1, productId: null, productVariantId: null, mode: "mirror", sharePct: null, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: true },
        // Product override: share 50%
        { channelId: 1, productId: 1, productVariantId: null, mode: "share", sharePct: 50, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: true },
        // Variant override: fixed 75
        { channelId: 1, productId: 1, productVariantId: 1, mode: "fixed", sharePct: null, fixedQty: 75, floorAtp: 0, ceilingQty: null, eligible: true },
      ];

      const db = createMockDb({ activeChannels: channels, warehouseAssignments, allocationRules });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      expect(result.allocations[0].allocatedUnits).toBe(75);
      expect(result.allocations[0].method).toBe("fixed");
    });
  });

  // -----------------------------------------------------------------------
  // Floor and ceiling controls
  // -----------------------------------------------------------------------

  describe("floor and ceiling", () => {
    it("should zero out when ATP is below floor threshold", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 10, atpBase: 10 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 10 };
      const allocationRules = [
        { channelId: 1, productId: null, productVariantId: null, mode: "mirror", sharePct: null, fixedQty: null, floorAtp: 50, ceilingQty: null, eligible: true },
      ];

      const db = createMockDb({ activeChannels: channels, warehouseAssignments, allocationRules });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      expect(result.allocations[0].allocatedUnits).toBe(0);
      expect(result.allocations[0].method).toBe("zero");
      expect(result.allocations[0].reason).toContain("Floor triggered");
    });

    it("should cap at ceiling quantity", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 1000 };
      const allocationRules = [
        { channelId: 1, productId: null, productVariantId: null, mode: "mirror", sharePct: null, fixedQty: null, floorAtp: 0, ceilingQty: 300, eligible: true },
      ];

      const db = createMockDb({ activeChannels: channels, warehouseAssignments, allocationRules });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      expect(result.allocations[0].allocatedUnits).toBe(300);
      expect(result.allocations[0].reason).toContain("ceiling capped");
    });
  });

  // -----------------------------------------------------------------------
  // Eligibility gate
  // -----------------------------------------------------------------------

  describe("eligibility", () => {
    it("should block product from channel when eligible=false at product level", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "eBay", provider: "ebay", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 1000 };
      const allocationRules = [
        { channelId: 1, productId: 1, productVariantId: null, mode: "mirror", sharePct: null, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: false },
      ];

      const db = createMockDb({ activeChannels: channels, warehouseAssignments, allocationRules });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      expect(result.allocations[0].allocatedUnits).toBe(0);
      expect(result.allocations[0].method).toBe("zero");
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].reason).toContain("ineligible");
    });

    it("should block individual variant when eligible=false at variant level", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
        { productVariantId: 2, sku: "TL-50", name: "50ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 1000 };
      const allocationRules = [
        // Channel default: mirror
        { channelId: 1, productId: null, productVariantId: null, mode: "mirror", sharePct: null, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: true },
        // Block variant 2 specifically
        { channelId: 1, productId: 1, productVariantId: 2, mode: "mirror", sharePct: null, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: false },
      ];

      const db = createMockDb({ activeChannels: channels, warehouseAssignments, allocationRules });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      const v1 = result.allocations.find(a => a.productVariantId === 1);
      const v2 = result.allocations.find(a => a.productVariantId === 2);
      expect(v1?.allocatedUnits).toBe(1000);
      expect(v2?.allocatedUnits).toBe(0);
      expect(v2?.method).toBe("zero");
    });
  });

  // -----------------------------------------------------------------------
  // Product line gates
  // -----------------------------------------------------------------------

  describe("product line gates", () => {
    it("should block channels not assigned to the product's line", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
        { id: 2, name: "eBay", provider: "ebay", status: "active", priority: 0 },
      ];
      const productLineRows = [{ productLineId: 100 }];
      const channelLineRows = [{ channelId: 1, productLineId: 100 }];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
        { channelId: 2, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 1000 };

      const db = createMockDb({
        activeChannels: channels,
        productLineRows,
        channelLineRows,
        warehouseAssignments,
      });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      const shopify = result.allocations.find(a => a.channelId === 1);
      expect(shopify?.allocatedUnits).toBe(1000);

      const ebay = result.allocations.find(a => a.channelId === 2);
      expect(ebay).toBeUndefined();
      expect(result.blocked.some(b => b.channelId === 2)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Parallel independence
  // -----------------------------------------------------------------------

  describe("parallel independence (no drawdown)", () => {
    it("channels should NOT consume from each other's pool", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 10 },
        { id: 2, name: "eBay", provider: "ebay", status: "active", priority: 5 },
        { id: 3, name: "Amazon", provider: "amazon", status: "active", priority: 1 },
      ];
      // All share the same warehouse
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
        { channelId: 2, warehouseId: 1, enabled: true },
        { channelId: 3, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 1000 };

      const db = createMockDb({ activeChannels: channels, warehouseAssignments });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      // All three channels see the same 1000 — independent, parallel views
      for (const ch of [1, 2, 3]) {
        const alloc = result.allocations.find(a => a.channelId === ch);
        expect(alloc?.allocatedUnits).toBe(1000);
      }
    });

    it("share percentages are applied independently (can exceed 100% total)", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
        { id: 2, name: "eBay", provider: "ebay", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
        { channelId: 2, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 1000 };
      const allocationRules = [
        { channelId: 1, productId: null, productVariantId: null, mode: "share", sharePct: 80, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: true },
        { channelId: 2, productId: null, productVariantId: null, mode: "share", sharePct: 80, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: true },
      ];

      const db = createMockDb({ activeChannels: channels, warehouseAssignments, allocationRules });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      // Both get 80% independently — 800 + 800 = 1600 total exposure. That's the model.
      const shopify = result.allocations.find(a => a.channelId === 1);
      const ebay = result.allocations.find(a => a.channelId === 2);
      expect(shopify?.allocatedUnits).toBe(800);
      expect(ebay?.allocatedUnits).toBe(800);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-variant + unitsPerVariant
  // -----------------------------------------------------------------------

  describe("multi-variant allocation", () => {
    it("should handle unitsPerVariant > 1 correctly", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-50", name: "50ct", unitsPerVariant: 50, atpUnits: 20, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 1000 };

      const db = createMockDb({ activeChannels: channels, warehouseAssignments });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      const alloc = result.allocations.find(a => a.channelId === 1);
      expect(alloc?.allocatedUnits).toBe(20); // 1000 / 50 = 20
      expect(alloc?.allocatedBase).toBe(1000);
    });

    it("should floor partial variant units with share percentage", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-50", name: "50ct", unitsPerVariant: 50, atpUnits: 20, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify-CA", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 35, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 35: 530 };
      const allocationRules = [
        { channelId: 1, productId: null, productVariantId: null, mode: "share", sharePct: 90, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: true },
      ];

      const db = createMockDb({ activeChannels: channels, warehouseAssignments, allocationRules });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      const alloc = result.allocations[0];
      // 90% of 530 = 477 base → 477 / 50 = 9 variant units (floored)
      expect(alloc.allocatedUnits).toBe(9);
      expect(alloc.allocatedBase).toBe(450); // 9 * 50
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("should return empty result when no variants exist", async () => {
      const db = createMockDb();
      const atp = createMockAtpService({ variants: [] });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      expect(result.allocations).toHaveLength(0);
      expect(result.totalAtpBase).toBe(0);
    });

    it("should return empty result when no active channels exist", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const db = createMockDb({ activeChannels: [] });
      const atp = createMockAtpService({ variants });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      expect(result.allocations).toHaveLength(0);
    });

    it("should handle zero ATP gracefully", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 0, atpBase: 0 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 0 };

      const db = createMockDb({ activeChannels: channels, warehouseAssignments });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      const alloc = result.allocations.find(a => a.channelId === 1);
      expect(alloc?.allocatedUnits).toBe(0);
    });

    it("should not fail when audit logging throws", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 100, atpBase: 100 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 100 };

      const db = createMockDb({ activeChannels: channels, warehouseAssignments });
      db.insert = vi.fn(() => { throw new Error("DB connection lost"); });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      expect(result.allocations.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Convenience methods
  // -----------------------------------------------------------------------

  describe("getAllocatedQty", () => {
    it("should return allocated units for a specific variant+channel", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 1, warehouseId: 1, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 1000 };

      const db = createMockDb({ activeChannels: channels, warehouseAssignments });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const qty = await engine.getAllocatedQty(1, 1, 1);
      expect(qty).toBe(1000);
    });

    it("should return 0 for non-existent variant+channel combo", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const db = createMockDb({ activeChannels: [] });
      const atp = createMockAtpService({ variants });
      const engine = createAllocationEngine(db, atp);

      const qty = await engine.getAllocatedQty(1, 999, 999);
      expect(qty).toBe(0);
    });
  });

  describe("allocateAndGetSyncTargets", () => {
    it("should group allocations by channel for sync", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 36, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
        { id: 37, name: "Shopify-CA", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 36, warehouseId: 1, enabled: true },
        { channelId: 37, warehouseId: 35, enabled: true },
      ];
      const warehouseAtp: Record<number, number> = { 1: 1000, 35: 500 };
      const allocationRules = [
        { channelId: 37, productId: null, productVariantId: null, mode: "share", sharePct: 90, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: true },
      ];

      const db = createMockDb({ activeChannels: channels, warehouseAssignments, allocationRules });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const { syncTargets } = await engine.allocateAndGetSyncTargets(1);

      expect(syncTargets).toHaveLength(2);

      const shopify = syncTargets.find(t => t.channelId === 36);
      expect(shopify?.variantAllocations[0].allocatedUnits).toBe(1000);

      const ca = syncTargets.find(t => t.channelId === 37);
      expect(ca?.variantAllocations[0].allocatedUnits).toBe(450); // 90% of 500
    });
  });

  // -----------------------------------------------------------------------
  // Real-world scenario: Card Shellz US + CA channels
  // -----------------------------------------------------------------------

  describe("real-world: US + CA channel split", () => {
    it("should scope US to LEON+RTE-19 and CA to SM-CA with 90% share", async () => {
      const variants = [
        { productVariantId: 10, sku: "CS-TL-25", name: "25ct Toploaders", unitsPerVariant: 25, atpUnits: 40, atpBase: 2000 },
        { productVariantId: 11, sku: "CS-TL-100", name: "100ct Toploaders", unitsPerVariant: 100, atpUnits: 10, atpBase: 2000 },
      ];
      const channels = [
        { id: 36, name: "Shopify", provider: "shopify", status: "active", priority: 0 },
        { id: 37, name: "Shopify-Canada", provider: "shopify", status: "active", priority: 0 },
      ];
      const warehouseAssignments = [
        { channelId: 36, warehouseId: 1, enabled: true },  // LEON
        { channelId: 36, warehouseId: 2, enabled: true },  // RTE-19
        { channelId: 37, warehouseId: 35, enabled: true }, // SM-CA
      ];
      const warehouseAtp: Record<number, number> = {
        1: 1200,  // LEON
        2: 800,   // RTE-19
        35: 600,  // SM-CA
      };
      const allocationRules = [
        // US: mirror (default)
        { channelId: 36, productId: null, productVariantId: null, mode: "mirror", sharePct: null, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: true },
        // CA: 90% share
        { channelId: 37, productId: null, productVariantId: null, mode: "share", sharePct: 90, fixedQty: null, floorAtp: 0, ceilingQty: null, eligible: true },
      ];

      const db = createMockDb({ activeChannels: channels, warehouseAssignments, allocationRules });
      const atp = createMockAtpService({ variants, warehouseAtp });
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      // US: LEON (1200) + RTE-19 (800) = 2000 base, mirror = 2000
      const us25 = result.allocations.find(a => a.channelId === 36 && a.productVariantId === 10);
      expect(us25?.allocatedUnits).toBe(80); // 2000 / 25
      const us100 = result.allocations.find(a => a.channelId === 36 && a.productVariantId === 11);
      expect(us100?.allocatedUnits).toBe(20); // 2000 / 100

      // CA: SM-CA (600) base, 90% = 540 base
      const ca25 = result.allocations.find(a => a.channelId === 37 && a.productVariantId === 10);
      expect(ca25?.allocatedUnits).toBe(21); // floor(540 / 25) = 21
      const ca100 = result.allocations.find(a => a.channelId === 37 && a.productVariantId === 11);
      expect(ca100?.allocatedUnits).toBe(5); // floor(540 / 100) = 5
    });
  });
});
