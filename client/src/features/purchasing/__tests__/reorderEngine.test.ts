import { describe, expect, it } from "vitest";
import {
  ALL_CHIP_KEYS,
  DEFAULT_CHIP_SELECTION,
  addDaysToIsoDate,
  availableValueCents,
  chipMatchesItem,
  computeGroupRollup,
  computeSuggestedSpend,
  confidenceTooltip,
  daysOfSupplyDisplay,
  filterItemsByChips,
  formatIsoDateShort,
  formatMoneyCents,
  groupReorderItems,
  isOrderQueueSelection,
  isOverstocked,
  orderSoonDates,
  parseReorderEngineDeepLink,
  skippedAppendixRows,
  skippedReasonLabel,
  statusParamToChipKeys,
  statusSeverityRank,
  suggestedValueCents,
  trendDisplay,
  type ChipKey,
  type GroupableItem,
} from "../reorderEngine";

function chipItem(status: string, daysOfSupply = 10) {
  return { status, daysOfSupply };
}

function groupable(overrides: Partial<GroupableItem> = {}): GroupableItem {
  return {
    category: "Sealed - Pokemon",
    productLines: ["Prismatic Evolutions"],
    available: 10,
    suggestedOrderPieces: 0,
    estimatedCostMills: 10_000, // $1.00/piece
    estimatedCostCents: 1_000,
    currentSupply: { effectiveSupplyPieces: 100 },
    forwardDemandBasis: { adjustedReorderPoint: 50 },
    ...overrides,
  };
}

describe("chip filters (two-tier additive union)", () => {
  it("maps engine statuses onto the order-queue and watching chips", () => {
    expect(chipMatchesItem("needs_order", chipItem("stockout"))).toBe(true);
    expect(chipMatchesItem("needs_order", chipItem("order_now"))).toBe(true);
    expect(chipMatchesItem("needs_order", chipItem("order_soon"))).toBe(false);
    expect(chipMatchesItem("order_soon", chipItem("order_soon"))).toBe(true);
    expect(chipMatchesItem("on_order", chipItem("on_order"))).toBe(true);
    expect(chipMatchesItem("ok", chipItem("ok"))).toBe(true);
    expect(chipMatchesItem("stagnant", chipItem("no_movement"))).toBe(true);
  });

  it("derives Overstocked as ok status with 180 < daysOfSupply < 9999 (boundaries excluded)", () => {
    expect(isOverstocked(chipItem("ok", 181))).toBe(true);
    expect(isOverstocked(chipItem("ok", 180))).toBe(false);
    expect(isOverstocked(chipItem("ok", 9999))).toBe(false);
    expect(isOverstocked(chipItem("no_movement", 500))).toBe(false);
  });

  it("keeps the deliberate Overstocked/Healthy overlap safe via union semantics", () => {
    const overstocked = chipItem("ok", 200);
    const rows = filterItemsByChips([overstocked], new Set<ChipKey>(["ok", "overstock"]));
    expect(rows).toHaveLength(1); // union — never double-counted or excluded
  });

  it("unions selected chips and shows everything when all chips are on", () => {
    const items = [chipItem("stockout"), chipItem("order_soon"), chipItem("ok"), chipItem("no_movement")];
    expect(filterItemsByChips(items, new Set<ChipKey>(["needs_order", "order_soon"]))).toHaveLength(2);
    expect(filterItemsByChips(items, new Set<ChipKey>(ALL_CHIP_KEYS))).toHaveLength(4);
    expect(filterItemsByChips(items, new Set<ChipKey>())).toHaveLength(4);
  });

  it("recognizes the default order-queue selection", () => {
    expect(isOrderQueueSelection(new Set<ChipKey>(DEFAULT_CHIP_SELECTION))).toBe(true);
    expect(isOrderQueueSelection(new Set<ChipKey>(["needs_order"]))).toBe(false);
    expect(isOrderQueueSelection(new Set<ChipKey>(["needs_order", "order_soon", "ok"]))).toBe(false);
  });

  it("sorts statuses by severity", () => {
    const order = ["stockout", "order_now", "order_soon", "on_order", "ok", "no_movement"];
    const ranks = order.map(statusSeverityRank);
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5]);
    expect(statusSeverityRank("unknown_future_status")).toBeGreaterThan(5);
  });
});

describe("status deep-link param (new)", () => {
  it("accepts engine statuses, chip keys, and comma-separated unions", () => {
    expect(statusParamToChipKeys("stockout")).toEqual(["needs_order"]);
    expect(statusParamToChipKeys("order_now")).toEqual(["needs_order"]);
    expect(statusParamToChipKeys("order_soon,on_order")).toEqual(["order_soon", "on_order"]);
    expect(statusParamToChipKeys("no_movement")).toEqual(["stagnant"]);
    expect(statusParamToChipKeys("overstocked")).toEqual(["overstock"]);
    expect(statusParamToChipKeys("needs_order")).toEqual(["needs_order"]);
  });

  it("ignores unknown tokens and returns null when nothing usable remains", () => {
    expect(statusParamToChipKeys("stockout,garbage")).toEqual(["needs_order"]);
    expect(statusParamToChipKeys("garbage")).toBeNull();
    expect(statusParamToChipKeys("")).toBeNull();
    expect(statusParamToChipKeys(null)).toBeNull();
  });
});

describe("deep-link parsing", () => {
  it("extracts recommendationId and the status chip preselection", () => {
    const link = parseReorderEngineDeepLink(new URLSearchParams("recommendationId=324%3Aproduct%3A90&status=stockout"));
    expect(link.recommendationId).toBe("324:product:90");
    expect(link.chipSelection).toEqual(["needs_order"]);
    expect(link.hasLegacyReviewParams).toBe(false);
  });

  it("flags all four legacy review params and preserves the full query on the legacy URL", () => {
    for (const key of ["reviewQueue", "reason", "forecastAction", "candidateBand"]) {
      const link = parseReorderEngineDeepLink(new URLSearchParams(`${key}=x`));
      expect(link.hasLegacyReviewParams).toBe(true);
    }
    const params = new URLSearchParams(
      "reviewQueue=skipped&reason=no_vendor&forecastAction=verify_recent_demand&candidateBand=watch&recommendationId=1%3A2%3A3",
    );
    const link = parseReorderEngineDeepLink(params);
    expect(link.legacyUrl).toBe(`/reorder-analysis/legacy?${params.toString()}`);
  });

  it("does not raise the banner for plain or status-only links", () => {
    expect(parseReorderEngineDeepLink(new URLSearchParams("")).hasLegacyReviewParams).toBe(false);
    expect(parseReorderEngineDeepLink(new URLSearchParams("status=ok")).hasLegacyReviewParams).toBe(false);
    expect(parseReorderEngineDeepLink(new URLSearchParams("")).legacyUrl).toBe("/reorder-analysis/legacy");
  });
});

describe("order-soon date labels", () => {
  it("projects stockout at asOf + daysOfSupply and order-by inside the coverage window", () => {
    const dates = orderSoonDates("2026-07-26", { daysOfSupply: 20, leadTimeDays: 7, safetyStockDays: 7 });
    expect(dates.stockoutDate).toBe("2026-08-15"); // +20d
    expect(dates.orderByDate).toBe("2026-08-01"); // +max(0, 20-14)d
  });

  it("clamps order-by at today when supply is already inside lead + safety", () => {
    const dates = orderSoonDates("2026-07-26", { daysOfSupply: 7, leadTimeDays: 7, safetyStockDays: 7 });
    expect(dates.orderByDate).toBe("2026-07-26");
    expect(dates.stockoutDate).toBe("2026-08-02");
  });

  it("rolls calendar boundaries correctly", () => {
    expect(addDaysToIsoDate("2026-12-30", 3)).toBe("2027-01-02");
    expect(formatIsoDateShort("2026-08-04")).toBe("Aug 4");
    expect(formatIsoDateShort(null)).toBe("");
  });
});

describe("suggested spend (integer cents; engine pieces × supplier cost)", () => {
  it("prefers mills precision and rounds half-up once per line", () => {
    // 1 cent = 100 mills in this codebase (shared/utils/money.ts).
    // 4650 cents/piece = 465,000 mills; 390 pieces => $18,135.00
    expect(
      suggestedValueCents({ suggestedOrderPieces: 390, estimatedCostMills: 465_000, estimatedCostCents: 4_650 }),
    ).toBe(1_813_500);
    // mills-only precision: 1234.50 cents/piece × 3 pieces = 370,350 mills → 3,704 cents (rounded once, half-up)
    expect(
      suggestedValueCents({ suggestedOrderPieces: 3, estimatedCostMills: 123_450, estimatedCostCents: 1_235 }),
    ).toBe(3_704);
  });

  it("falls back to cents when mills are absent and reports missing cost as null", () => {
    expect(
      suggestedValueCents({ suggestedOrderPieces: 2, estimatedCostMills: null, estimatedCostCents: 150 }),
    ).toBe(300);
    expect(
      suggestedValueCents({ suggestedOrderPieces: 2, estimatedCostMills: null, estimatedCostCents: null }),
    ).toBeNull();
    expect(
      suggestedValueCents({ suggestedOrderPieces: 0, estimatedCostMills: null, estimatedCostCents: null }),
    ).toBe(0);
  });

  it("sums only costed lines and surfaces the missing-cost count", () => {
    const spend = computeSuggestedSpend([
      { suggestedOrderPieces: 10, estimatedCostMills: 10_000, estimatedCostCents: 1_000 }, // $10.00 → 1000c... (10 × $1)
      { suggestedOrderPieces: 5, estimatedCostMills: null, estimatedCostCents: null }, // missing cost
      { suggestedOrderPieces: 0, estimatedCostMills: 99_000, estimatedCostCents: 9_900 }, // no order
    ]);
    expect(spend.totalCents).toBe(1_000);
    expect(spend.skuCount).toBe(2);
    expect(spend.missingCostCount).toBe(1);
  });

  it("never counts skipped rows — the engine dual-lists them in items but their row shows a dash", () => {
    const spend = computeSuggestedSpend([
      { suggestedOrderPieces: 10, estimatedCostMills: 10_000, estimatedCostCents: 1_000 }, // active, $10
      // no_vendor rows always carry a positive suggestion (the skip ladder
      // checks zero_suggested_quantity first) — must not count.
      { suggestedOrderPieces: 40, estimatedCostMills: 10_000, estimatedCostCents: 1_000, skippedReason: "no_vendor" },
      { suggestedOrderPieces: 8, estimatedCostMills: null, estimatedCostCents: null, skippedReason: "no_vendor" },
      { suggestedOrderPieces: 5, estimatedCostMills: 10_000, estimatedCostCents: 1_000, skippedReason: "already_on_order" },
    ]);
    expect(spend.totalCents).toBe(1_000);
    expect(spend.skuCount).toBe(1);
    expect(spend.missingCostCount).toBe(0);
  });

  it("values available stock for idle-capital chips", () => {
    expect(availableValueCents(groupable({ available: 3 }))).toBe(300);
    expect(availableValueCents(groupable({ available: 0 }))).toBe(0);
    expect(
      availableValueCents(groupable({ available: 3, estimatedCostMills: null, estimatedCostCents: null })),
    ).toBe(0);
  });

  it("formats money compactly like the approved mock", () => {
    expect(formatMoneyCents(1_813_500)).toBe("$18,135");
    expect(formatMoneyCents(4_650)).toBe("$46.50");
    expect(formatMoneyCents(0)).toBe("$0");
  });
});

describe("grouping + rollups", () => {
  it("groups by category with Uncategorized fallback", () => {
    const groups = groupReorderItems(
      [groupable(), groupable({ category: null }), groupable({ category: "Supplies" })],
      "category",
    );
    expect(groups.map((group) => group.key)).toEqual(["Sealed - Pokemon", "Uncategorized", "Supplies"]);
  });

  it("duplicates a product under EACH of its product lines", () => {
    const multiLine = groupable({ productLines: ["Prismatic Evolutions", "Scarlet & Violet"] });
    const groups = groupReorderItems([multiLine, groupable({ productLines: [] })], "productLine");
    expect(groups.map((group) => group.key)).toEqual([
      "Prismatic Evolutions",
      "Scarlet & Violet",
      "No product line",
    ]);
    expect(groups[0].items).toHaveLength(1);
    expect(groups[1].items).toHaveLength(1);
  });

  it("returns one ungrouped bucket for group-by none", () => {
    const groups = groupReorderItems([groupable(), groupable()], "none");
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
  });

  it("rolls up SKU count, below-RP count (engine numbers), suggested $ and on-hand $", () => {
    const rollup = computeGroupRollup([
      groupable({
        suggestedOrderPieces: 10, // $10 suggested
        available: 2, // $2 on hand
        currentSupply: { effectiveSupplyPieces: 10 },
        forwardDemandBasis: { adjustedReorderPoint: 50 }, // below RP
      }),
      groupable({ available: 1 }), // healthy, $1 on hand
      groupable({
        // skipped rows never count toward below-RP
        skippedReason: "excluded",
        currentSupply: { effectiveSupplyPieces: 0 },
        forwardDemandBasis: { adjustedReorderPoint: 50 },
        available: 0,
      }),
    ]);
    expect(rollup.skuCount).toBe(3);
    expect(rollup.belowReorderPointCount).toBe(1);
    expect(rollup.suggestedCents).toBe(1_000);
    expect(rollup.onHandCents).toBe(300);
  });

  it("excludes skipped rows' suggestion from the rollup's suggested $ but keeps their on-hand $", () => {
    const rollup = computeGroupRollup([
      groupable({ suggestedOrderPieces: 10, available: 2 }), // $10 suggested, $2 on hand
      groupable({ suggestedOrderPieces: 40, available: 3, skippedReason: "no_vendor" }), // dash in the table
    ]);
    expect(rollup.suggestedCents).toBe(1_000);
    expect(rollup.onHandCents).toBe(500);
  });
});

describe("skipped appendix (Show excluded)", () => {
  it("drops dual-listed rows already visible in the main list and sorts the rest by SKU", () => {
    const skipped = [
      { recommendationId: "r3", sku: "ZZZ-3" }, // excluded-only row
      { recommendationId: "r1", sku: "AAA-1" }, // dual-listed, already visible
      { recommendationId: "r2", sku: "MMM-2" }, // excluded-only row
    ];
    const rows = skippedAppendixRows(skipped, new Set(["r1"]));
    expect(rows.map((row) => row.recommendationId)).toEqual(["r2", "r3"]);
  });

  it("returns everything SKU-sorted when nothing is dual-listed", () => {
    const rows = skippedAppendixRows(
      [
        { recommendationId: "b", sku: "B" },
        { recommendationId: "a", sku: "A" },
      ],
      new Set<string>(),
    );
    expect(rows.map((row) => row.sku)).toEqual(["A", "B"]);
  });
});

describe("trend + confidence display", () => {
  it("labels the ratio tooltip from period vs prior period", () => {
    const trend = trendDisplay({
      demandTrend: "rising",
      lookbackDays: 30,
      periodUsagePieces: 145,
      priorPeriodUsagePieces: 100,
    });
    expect(trend.symbol).toBe("up");
    expect(trend.tooltip).toBe("Last 30d vs prior 30d: 1.45×");
  });

  it("handles new demand (no prior window)", () => {
    const trend = trendDisplay({
      demandTrend: "new_demand",
      lookbackDays: 30,
      periodUsagePieces: 12,
      priorPeriodUsagePieces: 0,
    });
    expect(trend.symbol).toBe("up");
    expect(trend.tooltip).toContain("New demand");
  });

  it("composes the confidence tooltip from engine fields with injected clock", () => {
    const nowMs = Date.UTC(2026, 6, 26); // 2026-07-26
    const tooltip = confidenceTooltip(
      {
        demandBasis: {
          demandTrend: "rising",
          demandQuality: "normal",
          lookbackDays: 30,
          periodUsagePieces: 145,
          priorPeriodUsagePieces: 100,
          latestDemandAt: "2026-07-14T00:00:00.000Z", // 12 days before nowMs
        },
        leadTimeBasis: { leadTimeSource: "vendor_product" },
      },
      nowMs,
    );
    expect(tooltip).toBe("Rising trend (1.45×) · normal history · last sale 12d ago · vendor lead time");
  });
});

describe("days-of-supply bar", () => {
  it("marks the 9999 sentinel infinite and colors by lead/safety thresholds", () => {
    expect(daysOfSupplyDisplay({ daysOfSupply: 9999, leadTimeDays: 7, safetyStockDays: 7 }).infinite).toBe(true);
    expect(daysOfSupplyDisplay({ daysOfSupply: 5, leadTimeDays: 7, safetyStockDays: 7 }).tone).toBe("red");
    expect(daysOfSupplyDisplay({ daysOfSupply: 10, leadTimeDays: 7, safetyStockDays: 7 }).tone).toBe("amber");
    expect(daysOfSupplyDisplay({ daysOfSupply: 30, leadTimeDays: 7, safetyStockDays: 7 }).tone).toBe("green");
  });
});

describe("skip reasons", () => {
  it("labels every engine skip reason", () => {
    expect(skippedReasonLabel("excluded")).toBe("Excluded by planning policy");
    expect(skippedReasonLabel("already_on_order")).toBe("Open PO covers the gap");
    expect(skippedReasonLabel("no_vendor")).toBe("No vendor assigned");
    expect(skippedReasonLabel("not_actionable_status")).toBe("Not actionable");
    expect(skippedReasonLabel("zero_suggested_quantity")).toBe("No order needed");
    expect(skippedReasonLabel("some_future_reason")).toBe("some future reason");
    expect(skippedReasonLabel(null)).toBe("Skipped");
  });
});
