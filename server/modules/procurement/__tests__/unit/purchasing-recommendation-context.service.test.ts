import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {
    execute: vi.fn(),
    select: vi.fn(),
  },
}));

vi.mock("../../../../db", () => ({ db: mocks.db }));
vi.mock("../../../../storage/base", () => ({
  products: {},
  reorderExclusionRules: {},
}));

import { loadPurchasingRecommendationContext } from "../../purchasing-recommendation-context.service";
import { generatePurchasingRecommendations } from "../../purchasing-recommendation.engine";

function selectChain(rows: unknown[]) {
  const chain: any = {
    from: vi.fn(() => chain),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function primeContextQueries(options: {
  settingsRows?: unknown[];
  ruleRows?: unknown[];
  productMetaRows?: unknown[];
}) {
  // loadPurchasingRecommendationContext issues, in evaluation order:
  //   1. db.execute(settings defaults query)
  //   2. db.select().from(reorderExclusionRules)
  //   3. db.execute(active-product meta query)
  mocks.db.execute
    .mockResolvedValueOnce({ rows: options.settingsRows ?? [] })
    .mockResolvedValueOnce({ rows: options.productMetaRows ?? [] });
  mocks.db.select.mockImplementation(() => selectChain(options.ruleRows ?? []));
}

describe("loadPurchasingRecommendationContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns defaults, exclusionRules, and productMetaById keyed by numeric product id", async () => {
    primeContextQueries({
      settingsRows: [
        { key: "default_lead_time_days", value: "4" },
        { key: "default_safety_stock_days", value: "3" },
      ],
      ruleRows: [{ id: 1, field: "category", value: "dropship" }],
      productMetaRows: [
        {
          id: "20",
          category: "Dropship",
          brand: null,
          product_type: null,
          sku: "DROP-1",
          tags: null,
          reorder_excluded: false,
        },
      ],
    });

    const context = await loadPurchasingRecommendationContext();

    expect(context.defaults).toEqual({ leadTimeDays: 4, safetyStockDays: 3 });
    expect(context.exclusionRules).toEqual([{ id: 1, field: "category", value: "dropship" }]);
    expect(context.productMetaById.get(20)).toMatchObject({ sku: "DROP-1", category: "Dropship" });
    // Regression guard: the engine reads options.exclusionRules. Callers spread
    // this context straight into the engine options, so a differently named key
    // (the old `rules`) is silently dropped and rule-based exclusions are ignored.
    expect(context).not.toHaveProperty("rules");
  });

  it("applies a category exclusion rule when the loaded context is spread into the engine", async () => {
    primeContextQueries({
      ruleRows: [{ id: 1, field: "category", value: "dropship" }],
      productMetaRows: [
        {
          id: 20,
          category: "Dropship",
          brand: null,
          product_type: null,
          sku: "DROP-1",
          tags: null,
          reorder_excluded: false,
        },
        {
          id: 21,
          category: "singles",
          brand: null,
          product_type: null,
          sku: "KEEP-1",
          tags: null,
          reorder_excluded: false,
        },
      ],
    });

    const context = await loadPurchasingRecommendationContext();
    // Spread the EXACT loader output, mirroring every production call site
    // (routes, health summary, snapshot analysis, auto-draft job).
    const result = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): deterministic relative to fixture demand.
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [
        {
          product_id: 20,
          base_sku: "DROP-1",
          product_name: "Dropship Item",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 30,
          order_uom_units: 1,
        },
        {
          product_id: 21,
          base_sku: "KEEP-1",
          product_name: "Kept Item",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 30,
          order_uom_units: 1,
        },
      ],
      ...context,
    });

    expect(result.items.map((item) => item.sku)).toEqual(["KEEP-1"]);
    expect(result.summary.excludedCount).toBe(1);
    expect(result.skippedItems[0]).toMatchObject({
      productId: 20,
      skippedReason: "excluded",
    });
  });
});
