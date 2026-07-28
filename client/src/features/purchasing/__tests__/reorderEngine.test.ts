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

// ---------------------------------------------------------------------------
// Order Builder (PR 3)
// ---------------------------------------------------------------------------

import {
  AUTO_DECISION_NOTE,
  NEEDS_SUPPLIER_GROUP_KEY,
  buildAcceptedForPoDecisionBody,
  buildCreatePoItemBody,
  buildRfqLineBody,
  confirmPrimaryLabel,
  controlAckKey,
  decisionNoteForSubmit,
  exceedReasonValid,
  exceedsSuggestion,
  firstUnmetConfirmRequirement,
  orderBarSummary,
  orderBuilderGroups,
  orderIncrementPieces,
  orderLineValueCents,
  poLineFlagged,
  removeOrderLine,
  rfqBaselinePieces,
  rfqLineNeedsApproval,
  rfqLineNeedsReason,
  setOrderLineExceedReason,
  setOrderLinePieces,
  snapPiecesUpToCase,
  toggleOrderLine,
  type ConfirmPoLineInput,
  type ConfirmRfqLineInput,
  type OrderLineState,
  type OrderableItem,
} from "../reorderEngine";

function orderable(overrides: Partial<OrderableItem> = {}): OrderableItem {
  return {
    recommendationId: "10:100:30",
    sku: "PKM-151",
    preferredVendorId: 7,
    preferredVendorName: "GTS Distribution",
    suggestedOrderPieces: 72,
    estimatedCostMills: 41_250, // $4.125/piece
    estimatedCostCents: 4_125,
    ...overrides,
  };
}

describe("order builder — case increment + snap-up", () => {
  it("mirrors the engine's increment rule: quoted case pack, then pack_size, then 1", () => {
    expect(orderIncrementPieces({ piecesPerPurchaseUom: 36, packSize: 12 })).toBe(36);
    expect(orderIncrementPieces({ piecesPerPurchaseUom: 1, packSize: 12 })).toBe(12);
    expect(orderIncrementPieces({ piecesPerPurchaseUom: null, packSize: 12 })).toBe(12);
    expect(orderIncrementPieces({ piecesPerPurchaseUom: null, packSize: null })).toBe(1);
    expect(orderIncrementPieces({ piecesPerPurchaseUom: null })).toBe(1);
  });

  it("snaps edits UP to a full case; zero means skip; garbage collapses to zero", () => {
    expect(snapPiecesUpToCase(1, 36)).toBe(36);
    expect(snapPiecesUpToCase(36, 36)).toBe(36);
    expect(snapPiecesUpToCase(37, 36)).toBe(72);
    expect(snapPiecesUpToCase(0, 36)).toBe(0);
    expect(snapPiecesUpToCase(-5, 36)).toBe(0);
    expect(snapPiecesUpToCase(Number.NaN, 36)).toBe(0);
    expect(snapPiecesUpToCase(17, 1)).toBe(17);
  });
});

describe("order builder — selection transitions (pure, no mutation)", () => {
  it("toggles a line on with the suggested pieces and off again", () => {
    const empty = new Map<string, OrderLineState>();
    const added = toggleOrderLine(empty, "r1", 72);
    expect(added.get("r1")).toEqual({ pieces: 72, exceedReason: "" });
    expect(empty.size).toBe(0); // input untouched
    const removed = toggleOrderLine(added, "r1", 72);
    expect(removed.has("r1")).toBe(false);
    expect(added.has("r1")).toBe(true);
  });

  it("edits pieces and reasons without touching other lines and ignores unknown ids", () => {
    let selection = toggleOrderLine(new Map(), "r1", 72);
    selection = toggleOrderLine(selection, "r2", 10);
    selection = setOrderLinePieces(selection, "r1", 108);
    selection = setOrderLineExceedReason(selection, "r1", "MOQ top-off");
    expect(selection.get("r1")).toEqual({ pieces: 108, exceedReason: "MOQ top-off" });
    expect(selection.get("r2")).toEqual({ pieces: 10, exceedReason: "" });
    expect(setOrderLinePieces(selection, "ghost", 5).has("ghost")).toBe(false);
    expect(setOrderLinePieces(selection, "r1", -3).get("r1")!.pieces).toBe(0);
    expect(removeOrderLine(selection, "r2").has("r2")).toBe(false);
  });
});

describe("order builder — vendor grouping", () => {
  it("groups selected lines by vendor in item order and isolates no-vendor lines", () => {
    const items = [
      orderable({ recommendationId: "a", preferredVendorId: 7, preferredVendorName: "GTS" }),
      orderable({ recommendationId: "b", preferredVendorId: 9, preferredVendorName: "Southern Hobby" }),
      orderable({ recommendationId: "c", preferredVendorId: 7, preferredVendorName: "GTS" }),
      orderable({ recommendationId: "d", preferredVendorId: null, preferredVendorName: null }),
      orderable({ recommendationId: "e", preferredVendorId: 9 }), // not selected
    ];
    let selection = new Map<string, OrderLineState>();
    for (const id of ["a", "b", "c", "d"]) selection = toggleOrderLine(selection, id, 10);
    const { vendorGroups, needsSupplier } = orderBuilderGroups(items, selection);
    expect(vendorGroups.map((group) => group.vendorId)).toEqual([7, 9]);
    expect(vendorGroups[0].lines.map((line) => line.recommendationId)).toEqual(["a", "c"]);
    expect(needsSupplier.map((line) => line.recommendationId)).toEqual(["d"]);
    expect(NEEDS_SUPPLIER_GROUP_KEY).toBe("needs_supplier");
  });
});

describe("order builder — money (integer cents)", () => {
  it("prices lines from mills and rolls up the bar summary honestly", () => {
    const priced = orderable({ recommendationId: "a" });
    const costless = orderable({
      recommendationId: "b",
      sku: "NO-COST",
      estimatedCostMills: null,
      estimatedCostCents: null,
    });
    expect(orderLineValueCents(priced, 72)).toBe(29_700); // 72 × 4125 mills = 297000 mills → 29700¢
    expect(orderLineValueCents(priced, 0)).toBe(0);
    expect(orderLineValueCents(costless, 10)).toBeNull();
    let selection = toggleOrderLine(new Map(), "a", 72);
    selection = toggleOrderLine(selection, "b", 10);
    expect(orderBarSummary([priced, costless], selection)).toEqual({
      lineCount: 2,
      totalCents: 29_700,
      missingCostCount: 1,
    });
  });
});

describe("order builder — override evidence rules", () => {
  it("flags exceed vs suggestion (PO) and any change vs run baseline (RFQ)", () => {
    expect(exceedsSuggestion(73, 72)).toBe(true);
    expect(exceedsSuggestion(72, 72)).toBe(false);
    expect(exceedsSuggestion(10, 72)).toBe(false);
    expect(rfqBaselinePieces(40, 72)).toBe(40);
    expect(rfqBaselinePieces(null, 72)).toBe(72);
    expect(rfqBaselinePieces(undefined, 72)).toBe(72);
    // RFQ: reductions ALSO need a reason (server: quantityChanged), approval only above.
    expect(rfqLineNeedsReason(40, 72)).toBe(true);
    expect(rfqLineNeedsReason(72, 72)).toBe(false);
    expect(rfqLineNeedsApproval(73, 72)).toBe(true);
    expect(rfqLineNeedsApproval(40, 72)).toBe(false);
    expect(exceedReasonValid("ab")).toBe(false);
    expect(exceedReasonValid("  MOQ ")).toBe(true);
  });

  it("marks PO lines flagged on controls or sourcing exceptions", () => {
    expect(poLineFlagged(1, 72, 72)).toBe(true);
    expect(poLineFlagged(0, 73, 72)).toBe(true);
    expect(poLineFlagged(0, 72, 72)).toBe(false);
  });

  it("resolves the decision note risk-proportionally, never sending a sub-minimum note", () => {
    expect(decisionNoteForSubmit("", false)).toEqual({ ok: true, note: AUTO_DECISION_NOTE });
    expect(decisionNoteForSubmit("   ", false)).toEqual({ ok: true, note: AUTO_DECISION_NOTE });
    expect(decisionNoteForSubmit("Restock for August preorders", true)).toEqual({
      ok: true,
      note: "Restock for August preorders",
    });
    expect(decisionNoteForSubmit("", true).ok).toBe(false);
    expect(decisionNoteForSubmit("too short", true).ok).toBe(false); // 9 chars
    expect(decisionNoteForSubmit("short", false).ok).toBe(false); // 1–9 chars is never sendable
  });
});

describe("order builder — confirm gating", () => {
  const poLine = (overrides: Partial<ConfirmPoLineInput> = {}): ConfirmPoLineInput => ({
    recommendationId: "r1",
    sku: "PKM-151",
    pieces: 72,
    suggestedOrderPieces: 72,
    exceedReason: "",
    controls: [],
    ...overrides,
  });
  const rfqLine = (overrides: Partial<ConfirmRfqLineInput> = {}): ConfirmRfqLineInput => ({
    recommendationId: "r9",
    sku: "OP-05",
    pieces: 100,
    baselinePieces: 100,
    exceedReason: "",
    ...overrides,
  });
  const base = {
    poLines: [] as ConfirmPoLineInput[],
    rfqLines: [] as ConfirmRfqLineInput[],
    acknowledgedControlKeys: new Set<string>(),
    approvedExceptionIds: new Set<string>(),
    note: "",
  };

  it("walks requirements in mock order: control acks → exceptions → note", () => {
    const flagged = poLine({
      pieces: 108,
      exceedReason: "Freight break at 108",
      controls: [{ code: "cost_stale", label: "Vendor cost unverified" }],
    });
    expect(firstUnmetConfirmRequirement({ ...base, poLines: [flagged] })).toBe(
      "Acknowledge “Vendor cost unverified” for PKM-151",
    );
    const acked = new Set([controlAckKey("r1", "cost_stale")]);
    expect(firstUnmetConfirmRequirement({ ...base, poLines: [flagged], acknowledgedControlKeys: acked })).toBe(
      "Approve the sourcing exception for PKM-151",
    );
    const approved = new Set(["r1"]);
    expect(
      firstUnmetConfirmRequirement({
        ...base,
        poLines: [flagged],
        acknowledgedControlKeys: acked,
        approvedExceptionIds: approved,
      }),
    ).toBe("Decision note needs at least 10 characters");
    expect(
      firstUnmetConfirmRequirement({
        ...base,
        poLines: [flagged],
        acknowledgedControlKeys: acked,
        approvedExceptionIds: approved,
        note: "August restock ahead of set rotation",
      }),
    ).toBeNull();
  });

  it("requires a stage-1 reason before the exception approval can even be offered", () => {
    const exceeding = poLine({ pieces: 108, exceedReason: "" });
    expect(firstUnmetConfirmRequirement({ ...base, poLines: [exceeding] })).toContain(
      "Enter a reason (at least 3 characters)",
    );
  });

  it("lets clean PO lines through with a blank note (auto-note path)", () => {
    expect(firstUnmetConfirmRequirement({ ...base, poLines: [poLine()] })).toBeNull();
  });

  it("gates RFQ lines on the run baseline: reason for any change, approval above", () => {
    const reduced = rfqLine({ pieces: 60, baselinePieces: 100 });
    expect(firstUnmetConfirmRequirement({ ...base, rfqLines: [reduced] })).toContain(
      "changing the run baseline on OP-05",
    );
    const above = rfqLine({ pieces: 140, baselinePieces: 100, exceedReason: "Bundle promo" });
    expect(firstUnmetConfirmRequirement({ ...base, rfqLines: [above] })).toBe(
      "Approve the sourcing exception for OP-05",
    );
    expect(
      firstUnmetConfirmRequirement({
        ...base,
        rfqLines: [above],
        approvedExceptionIds: new Set(["r9"]),
      }),
    ).toBeNull(); // RFQ-only orders need no decision note
  });
});

describe("order builder — button label", () => {
  it("names exactly what will be created", () => {
    expect(confirmPrimaryLabel(1, 0)).toBe("Create 1 draft PO");
    expect(confirmPrimaryLabel(2, 0)).toBe("Create 2 draft POs");
    expect(confirmPrimaryLabel(2, 1)).toBe("Create 2 draft POs · 1 RFQ");
    expect(confirmPrimaryLabel(0, 3)).toBe("Create 3 RFQs");
    expect(confirmPrimaryLabel(0, 0)).toBe("Nothing to order");
  });
});

describe("order builder — server payload assembly", () => {
  it("builds the accepted_for_po decision with the FULL strict evidence contract", () => {
    const body = buildAcceptedForPoDecisionBody(
      "10:100:30",
      { kind: "quality_review_required", controlCodes: ["cost_stale", "thin_history"] },
      "Manual order via Order Builder",
    );
    expect(body).toEqual({
      recommendationId: "10:100:30",
      kind: "quality_review_required",
      decision: "accepted_for_po",
      note: "Manual order via Order Builder",
      confirmDecision: true,
      acknowledgeAutomationEligibilityUnchanged: true,
      reviewedControlCodes: ["cost_stale", "thin_history"],
    });
  });

  it("attaches create-po override evidence only above the suggestion", () => {
    expect(
      buildCreatePoItemBody({
        recommendationId: "r1",
        kind: "held_by_policy",
        pieces: 72,
        suggestedOrderPieces: 72,
        exceedReason: "stale reason from an earlier edit",
      }),
    ).toEqual({ recommendationId: "r1", kind: "held_by_policy", requestedPieces: 72 });
    expect(
      buildCreatePoItemBody({
        recommendationId: "r1",
        kind: "held_by_policy",
        pieces: 108,
        suggestedOrderPieces: 72,
        exceedReason: " Freight break at 108 ",
      }),
    ).toEqual({
      recommendationId: "r1",
      kind: "held_by_policy",
      requestedPieces: 108,
      quantityOverrideReason: "Freight break at 108",
      allocationOverrideApproved: true,
    });
    // Reductions carry NO evidence — the PO handoff schema rejects it.
    expect(
      buildCreatePoItemBody({
        recommendationId: "r1",
        kind: "skipped",
        pieces: 36,
        suggestedOrderPieces: 72,
        exceedReason: "irrelevant",
      }),
    ).toEqual({ recommendationId: "r1", kind: "skipped", requestedPieces: 36 });
  });

  it("builds RFQ lines against the run baseline and fails closed on missing evidence", () => {
    const clean = buildRfqLineBody({
      recommendationLineId: 55,
      vendorId: 7,
      pieces: 100,
      remainingPieces: 100,
      exceedReason: "",
      exceptionApproved: false,
    });
    expect(clean).toEqual({
      ok: true,
      line: {
        recommendationLineId: 55,
        vendorId: 7,
        requestedPieces: 100,
        quantityOverrideReason: null,
        allocationOverrideApproved: false,
      },
    });
    const above = buildRfqLineBody({
      recommendationLineId: 55,
      vendorId: 7,
      pieces: 140,
      remainingPieces: 100,
      exceedReason: " Bundle promo ",
      exceptionApproved: true,
    });
    expect(above).toEqual({
      ok: true,
      line: {
        recommendationLineId: 55,
        vendorId: 7,
        requestedPieces: 140,
        quantityOverrideReason: "Bundle promo",
        allocationOverrideApproved: true,
      },
    });
    expect(
      buildRfqLineBody({
        recommendationLineId: 55,
        vendorId: 7,
        pieces: 140,
        remainingPieces: 100,
        exceedReason: "ok",
        exceptionApproved: true,
      }).ok,
    ).toBe(false); // reason too short
    expect(
      buildRfqLineBody({
        recommendationLineId: 55,
        vendorId: 7,
        pieces: 140,
        remainingPieces: 100,
        exceedReason: "Bundle promo",
        exceptionApproved: false,
      }).ok,
    ).toBe(false); // approval missing
    expect(
      buildRfqLineBody({
        recommendationLineId: 55,
        vendorId: 7,
        pieces: 0,
        remainingPieces: 100,
        exceedReason: "",
        exceptionApproved: false,
      }).ok,
    ).toBe(false); // zero pieces = skip, never submit
    // Reduction: reason required, approval NOT sent (service rejects a stray true).
    const reduced = buildRfqLineBody({
      recommendationLineId: 55,
      vendorId: 7,
      pieces: 60,
      remainingPieces: 100,
      exceedReason: "Budget cap",
      exceptionApproved: false,
    });
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      expect(reduced.line.quantityOverrideReason).toBe("Budget cap");
      expect(reduced.line.allocationOverrideApproved).toBe(false);
    }
  });
});
