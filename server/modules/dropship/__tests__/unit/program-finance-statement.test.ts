import { describe, expect, it } from "vitest";
import {
  FINANCE_CHECK_IDS,
  FINANCE_SECTION_KEYS,
  FINANCE_SECTION_LINE_KEYS,
  financeSummarySchema,
  type FinanceLine,
  type FinanceSummary,
} from "../../../../../shared/dropship/program-finance";
import { FINANCE_LINE_DEFINITIONS } from "../../../../../shared/dropship/program-finance-definitions";
import { resolveFinancePeriod } from "../../domain/program-finance-period";
import type { FinanceRawAggregates, FinanceRawProductGroupRow, FinanceRawVendorRow } from "../../domain/program-finance-raw";
import { buildFinanceSummary, financeSummaryDiagnostics } from "../../domain/program-finance-statement";
import {
  ACME_TCG,
  FINANCE_FIXTURE_NOW,
  FINANCE_FIXTURE_TIME_ZONE,
  ZERO,
  checkCounts,
  fixtureContext,
  fixtureLedgerGroups,
  fixtureRaw,
  lastMonthContext,
  lastMonthRaw,
  ledgerGroup,
  ok,
  vendor12Raw,
  zeroOrderTotals,
} from "../fixtures/program-finance-raw.fixture";

const b = (value: number | string) => BigInt(value);
type SectionKey = keyof FinanceSummary["sections"];
type Expected = readonly [operator: FinanceLine["operator"], amount: number | null, count?: number];

function build(raw: FinanceRawAggregates = fixtureRaw(), context = fixtureContext()): FinanceSummary {
  return buildFinanceSummary(raw, context);
}

function lineOf(summary: FinanceSummary, section: SectionKey, key: string): FinanceLine {
  const line = summary.sections[section].lines.find((candidate) => candidate.key === key);
  if (!line) throw new Error(`no ${key} in ${section}: ${summary.sections[section].lines.map((l) => l.key).join(", ")}`);
  return line;
}

/** Operator, amount and (when given) count of each listed line. */
function expectLines(summary: FinanceSummary, section: SectionKey, expected: Record<string, Expected>): void {
  const actual = Object.fromEntries(Object.keys(expected).map((key) => {
    const line = lineOf(summary, section, key);
    const want = expected[key];
    return [key, want.length > 2 ? [line.operator, line.amount, line.count] : [line.operator, line.amount]];
  }));
  expect(actual).toEqual(Object.fromEntries(Object.entries(expected).map(([key, want]) => [key, [...want]])));
}

function checkResults(summary: FinanceSummary): Record<string, string> {
  return Object.fromEntries(summary.checks.map((check) => [check.id, check.result]));
}

function failedRaw(...keys: (keyof FinanceRawAggregates)[]): FinanceRawAggregates {
  const raw: Record<string, unknown> = { ...fixtureRaw() };
  for (const key of keys) raw[key] = { status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT" };
  return raw as unknown as FinanceRawAggregates;
}

describe("buildFinanceSummary: the contract §6.4 seeded program (mtd, all vendors)", () => {
  const summary = build();

  it("labels the windows and the scope", () => {
    expect(summary.generatedAt).toBe("2026-10-05T13:14:00.000Z");
    expect(summary.timeZone).toBe("America/New_York");
    expect(summary.scope).toEqual({ vendor: null });
    expect(summary.period).toEqual({
      preset: "mtd", fromDate: "2026-10-01", toDate: "2026-10-05", startAt: "2026-10-01T04:00:00.000Z",
      endAt: "2026-10-05T13:14:00.000Z", endsNow: true, clampedToMonthEnd: false,
    });
    expect(summary.comparePeriod).toMatchObject({ fromDate: "2026-09-01", toDate: "2026-09-05", endAt: "2026-09-05T13:14:00.000Z", endsNow: false });
    expect(summary.notes).toEqual([]);
  });

  it("answers what we kept", () => {
    expect(summary.answer).toMatchObject({
      state: "kept", status: "ok",
      orders: 10, billed: 18_730,
      fullyCosted: { orders: 3, billed: 9_730 },
      waiting: { orders: 7, billed: 9_000 },
      costOfGoods: 3_764, carrierLabels: 1_935, poolShare: 150,
      keptOnOrders: 3_881, feesCharged: 760, returnCreditsPaid: 2_000,
      kept: { amount: 2_641, status: "recorded" },
      marginTenths: 399, marginBps: 3_989, priorMarginTenths: 404, marginChangeTenths: -5,
      centsOfEachDollar: { kept: 40, costOfGoods: 39, carrierLabels: 20, poolShare: 1 },
      barBps: { kept: 2_072, costOfGoods: 2_010, carrierLabels: 1_033, poolShare: 80, waiting: 4_805 },
      paidWithPoints: { billed: 2_200, points: 2_200 },
      coverage: { done: 3, total: 10 },
    });
  });

  it("walks through the working of the answer with the real figures", () => {
    const steps = summary.answer.workings;
    expect(steps.map((step) => step.textKey)).toEqual([
      "working.two_clocks", "sales.billed_fc", "sales.kept_orders", "working.cogs_basis", "sales.kept",
      "working.margin_share", "working.margin_prior", "working.margin_change", "working.not_included",
    ]);
    expect(steps.map((step) => step.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(steps[2]).toEqual({
      step: 3, textKey: "sales.kept_orders", result: 3_881, opensMetric: "sales.kept_orders",
      operands: [
        { lineKey: "sales.billed_fc", amount: 9_730, unit: "cents", operator: "none" },
        { lineKey: "sales.cogs", amount: 3_764, unit: "cents", operator: "minus" },
        { lineKey: "sales.labels", amount: 1_935, unit: "cents", operator: "minus" },
        { lineKey: "sales.pool_fc", amount: 150, unit: "cents", operator: "minus" },
      ],
    });
    expect(steps[4].operands.map((operand) => [operand.lineKey, operand.operator, operand.amount])).toEqual([
      ["sales.kept_orders", "none", 3_881], ["sales.fees", "plus", 760], ["sales.return_credits_cs", "minus", 2_000],
    ]);
    expect(steps[6].operands.map((operand) => operand.amount)).toEqual([1_050, 2_600]);
  });

  it("builds the Sales statement", () => {
    expectLines(summary, "sales", {
      "sales.billed": ["none", 18_730, 10],
      "sales.billed.product": ["none", 13_320],
      "sales.billed.shipping": ["none", 5_410],
      "sales.billed.carrier_estimate": ["none", 4_080],
      "sales.billed.markup": ["none", 930],
      "sales.billed.pool_share": ["none", 400],
      "sales.billed.paid_from_wallets": ["none", 16_530],
      "sales.billed.paid_with_points": ["none", 2_200],
      "sales.waiting": ["minus", 9_000, 7],
      "sales.waiting.cancelled_in_oms": ["none", 800, 1],
      "sales.waiting.not_shipped": ["none", 1_300, 1],
      "sales.waiting.partly_shipped": ["none", 1_500, 1],
      "sales.waiting.shared_label": ["none", 3_300, 2],
      "sales.waiting.label_missing": ["none", 1_000, 1],
      "sales.waiting.item_cost_missing": ["none", 1_100, 1],
      "sales.billed_fc": ["equals", 9_730, 3],
      "sales.cogs": ["minus", 3_764],
      "sales.labels": ["minus", 1_935],
      "sales.labels.replacement": ["none", 250],
      "sales.pool_fc": ["minus", 150],
      "sales.kept_orders": ["equals", 3_881],
      "sales.kept_orders.on_products": ["none", 3_756],
      "sales.kept_orders.on_shipping": ["none", 125],
      "sales.fees": ["plus", 760],
      "sales.fees.advance": ["none", 10],
      "sales.fees.card": ["none", 300],
      "sales.fees.returns": ["none", 450],
      "sales.return_credits_cs": ["minus", 2_000],
      "sales.kept": ["equals", 2_641],
      "sales.memo.points_used": ["none", 2_200],
      "sales.memo.staff_credits": ["none", 2_500],
      "sales.memo.pool_credits": ["none", 1_700],
      "sales.buyer_paid": ["none", 23_993, 1],
      "sales.never_charged": ["none", 3, 3],
      "sales.never_charged.waiting_for_payment": ["none", 1],
      "sales.never_charged.payment_time_ran_out": ["none", 1],
      "sales.never_charged.rejected": ["none", 1],
      "sales.never_charged.would_have_charged": ["none", 2_500],
      "sales.label_coverage": ["none", 7],
    });
    expect(lineOf(summary, "sales", "sales.kept_orders")).toMatchObject({ percentTenths: 399, percentBps: 3_989 });
    expect(lineOf(summary, "sales", "sales.kept_orders.on_products").percentTenths).toBe(499);
    expect(lineOf(summary, "sales", "sales.kept_orders.on_shipping").percentTenths).toBe(61);
    expect(lineOf(summary, "sales", "sales.label_coverage").coverage).toEqual({ done: 7, total: 8 });
    expect(lineOf(summary, "sales", "sales.buyer_paid")).toMatchObject({ status: "partial", reasonKey: "buyer_total_unknown" });
    expect(lineOf(summary, "sales", "sales.packaging")).toMatchObject({ amount: null, status: "not_recorded", reasonKey: "packaging_not_saved" });
    expect(lineOf(summary, "sales", "sales.never_charged").datedBy).toBe("received");
    expect(lineOf(summary, "sales", "sales.fees").datedBy).toBe("posted");
    expect(lineOf(summary, "sales", "sales.fees.card").datedBy).toBe("settled");
    expect(lineOf(summary, "sales", "sales.billed").prior).toEqual(summary.tiles.billed.prior);
  });

  it("fills the four tiles", () => {
    expect(summary.tiles).toEqual({
      billed: { amount: 18_730, status: "recorded", orders: 10,
        prior: { amount: 2_600, change: 16_130, changeTenths: 6_204, changeBps: 62_038, kind: "change" } },
      cashReceived: { amount: 88_300, status: "recorded",
        prior: { amount: 300_000, change: -211_700, changeTenths: -706, changeBps: -7_057, kind: "change" } },
      weOweNow: { amount: 381_110, status: "recorded", vendors: 2, onTheWay: 19_000, atEndOfPeriod: null },
      owedToUsNow: { amount: 1_250, status: "recorded", vendors: 1, atEndOfPeriod: null },
    });
  });

  it("builds Cash in", () => {
    expectLines(summary, "cash", {
      "cash.ach": ["none", 50_000, 1],
      "cash.card": ["none", 10_300, 1],
      "cash.card.fees": ["none", 300],
      "cash.usdc": ["none", 25_000, 1],
      "cash.usdc.chain_watcher": ["none", 25_000],
      "cash.collection": ["none", 5_000, 1],
      "cash.received_deposits": ["equals", 90_300],
      "cash.pulled_back": ["minus", 12_300, 2],
      "cash.won_back": ["plus", 10_300, 1],
      "cash.received": ["equals", 88_300],
      "cash.memo.on_the_way": ["none", 19_000, 2],
      "cash.memo.stuck": ["none", 4_000, 1],
      "cash.memo.failed": ["none", 7_000, 1],
      "cash.memo.not_won_back": ["none", 2_000, 1],
      "cash.memo.staff_credits": ["none", 2_500, 1],
    });
    expect(lineOf(summary, "cash", "cash.memo.failed").failureCode).toBe("R01");
    expect(lineOf(summary, "cash", "cash.received").workings?.[0].operands.map((operand) => [operand.lineKey, operand.operator, operand.amount]))
      .toEqual([["cash.received_deposits", "none", 90_300], ["cash.pulled_back", "minus", 12_300], ["cash.won_back", "plus", 10_300]]);
    // Rails with no deposit in the period are left out; Stripe's fees are never a number.
    expect(summary.sections.cash.lines.map((line) => line.key)).not.toContain("cash.unknown");
    expect(lineOf(summary, "cash", "cash.memo.stripe_fees")).toMatchObject({ status: "not_recorded", amount: null });
    expect(lineOf(summary, "cash", "cash.memo.auto_top_ups")).toMatchObject({ amount: 0, depth: "every_line" });
  });

  it("reports won disputes at the disputed amount, with the difference explained", () => {
    expect(summary.info.find((info) => info.key === "won_disputes")).toEqual({
      key: "won_disputes", status: "recorded",
      lines: [
        expect.objectContaining({ key: "info.won_disputes.cash_returned", amount: 10_300 }),
        expect.objectContaining({ key: "info.won_disputes.wallet_restored", amount: 10_000 }),
        expect.objectContaining({ key: "info.won_disputes.card_fee_part", amount: 300 }),
        expect.objectContaining({ key: "info.won_disputes.points_from_cash", amount: 0 }),
      ],
    });
  });

  it("builds Returns and credits", () => {
    expectLines(summary, "returns", {
      "returns.credited": ["none", 3_700, 4],
      "returns.credits_cs": ["none", 2_000, 2],
      "returns.credits_cs.inspected": ["none", 1_200],
      "returns.credits_cs.return_case": ["none", 800],
      "returns.credits_pool": ["none", 1_700, 2],
      "returns.credits_pool.no_inspection": ["none", 1_100],
      "returns.credits_pool.inspection_fault": ["none", 600],
      "returns.fees": ["minus", 450],
      "returns.fees.restocking": ["none", 350],
      "returns.fees.processing": ["none", 100],
      "returns.net": ["equals", 3_250],
      "returns.staff_credits": ["none", 2_500, 1],
    });
    expect(lineOf(summary, "returns", "returns.memo.order_refunds")).toMatchObject({ status: "not_recorded", reasonKey: "no_refund_path" });
  });

  it("walks what we owe from the period start to now", () => {
    expectLines(summary, "owed", {
      "owed.we_owe": ["none", 381_110, 2],
      "owed.they_owe": ["none", 1_250, 1],
      "owed.on_the_way": ["none", 19_000, 2],
      "owed.wallets": ["none", 3],
      "owed.history_matches": ["none", 0],
      "owed.walk.opening": ["none", 302_650],
      "owed.walk.deposits": ["plus", 90_000],
      "owed.walk.staff_credits": ["plus", 2_500],
      "owed.walk.return_credits_cs": ["plus", 2_000],
      "owed.walk.return_credits_pool": ["plus", 1_700],
      "owed.walk.disputes_won": ["plus", 10_000],
      "owed.walk.orders": ["minus", 16_530],
      "owed.walk.advance_fees": ["minus", 10],
      "owed.walk.return_fees": ["minus", 450],
      "owed.walk.disputes_taken": ["minus", 12_000],
      "owed.walk.closing": ["equals", 379_860],
      "owed.walk.we_owe": ["none", 381_110],
      "owed.walk.they_owe": ["none", 1_250],
    });
    expect(lineOf(summary, "owed", "owed.history_matches").coverage).toEqual({ done: 3, total: 3 });
    const keys = summary.sections.owed.lines.map((line) => line.key);
    for (const absent of ["owed.walk.other", "owed.walk.unexplained", "owed.walk.on_the_way"]) expect(keys).not.toContain(absent);
  });

  it("walks the points", () => {
    expectLines(summary, "points", {
      "points.opening": ["none", 3_080],
      "points.given": ["plus", 750],
      "points.given.bank": ["none", 500],
      "points.given.usdc": ["none", 250],
      "points.used": ["minus", 2_200],
      "points.used.billed_value": ["none", 2_200],
      "points.expired": ["minus", 80],
      "points.taken_back": ["minus", 20],
      "points.held": ["equals", 1_530],
      "points.held_now": ["none", 1_530],
      "points.expiry.days_31_to_90": ["none", 250],
      "points.expiry.never": ["none", 1_280],
    });
    expect(lineOf(summary, "points", "points.held").unit).toBe("points");
    expect(lineOf(summary, "points", "points.used.billed_value").unit).toBe("cents");
    expect(lineOf(summary, "points", "points.expiry.next_30_days")).toMatchObject({ amount: 0, depth: "every_line" });
  });

  it("works out the insurance pool, which may be below zero", () => {
    expectLines(summary, "pool", {
      "pool.opening": ["none", 90],
      "pool.set_aside": ["plus", 400],
      "pool.paid_out": ["minus", 1_700],
      "pool.paid_out.no_inspection": ["none", 1_100],
      "pool.paid_out.inspection_fault": ["none", 600],
      "pool.topped_up": ["plus", 300],
      "pool.closing": ["equals", -910],
      "pool.claims": ["none", 900, 1],
      "pool.record": ["none", -800],
    });
    expect(summary.info.find((info) => info.key === "pool_record")?.lines.map((line) => line.amount)).toEqual([-800, -910]);
  });

  it("lists products by size with the rounding rows", () => {
    const products = summary.sections.products;
    expect(products.top.map((row) => [row.groupKey, row.packs, row.pieces, row.billedForProduct, row.billedOnFullyCosted, row.costOfGoods, row.keptOnProduct, row.packsShipped]))
      .toEqual([
        ["v:1", 14, 350, 8_420, 5_520, 3_143, 2_377, 13],
        ["v:2", 6, 600, 4_400, 2_000, 622, 1_378, 5],
        ["sku:MYSTERY-1", 1, null, 500, 0, 0, 0, 0],
      ]);
    expect(products.top[2]).toMatchObject({ productVariantId: null, linesWithoutPieces: 1, keptTenths: null });
    expect(products.top[0]).toMatchObject({ productName: "Toploaders", costOfGoodsMills: "314250", keptTenths: 431 });
    expect(products.others).toBeNull();
    expect(products.total).toMatchObject({
      groupKey: "total", packs: 21, pieces: 950, packsFullyCosted: 11, packsShipped: 18,
      billedForProduct: 13_320, costOfGoods: 3_764, costOfGoodsMills: "376400", keptOnProduct: 3_756,
    });
    expect(products.roundingCents).toEqual({ costOfGoods: -1, keptOnProduct: 1 });
    expectLines(summary, "products", {
      "products.billed": ["none", 13_320],
      "products.packs": ["none", 21],
      "products.pieces": ["none", 950],
      "products.lines_without_pieces": ["none", 1],
      "products.count": ["none", 3],
      "products.packs_fully_costed": ["none", 11],
      "products.packs_shipped": ["none", 18],
    });
    expect(lineOf(summary, "products", "products.pieces")).toMatchObject({ status: "partial", reasonKey: "pieces_not_recorded" });
    expect(lineOf(summary, "products", "products.packs_fully_costed").coverage).toEqual({ done: 11, total: 21 });
    expect(lineOf(summary, "products", "products.packs_shipped").coverage).toEqual({ done: 18, total: 21 });
  });

  it("lists vendors by what we kept, with the page as the totals row", () => {
    const vendors = summary.sections.vendors;
    expect(vendors.top.map((row) => [row.name, row.orders, row.billed, row.keptOnOrders, row.feesCharged, row.returnCreditsPaid, row.kept, row.weOweNow, row.theyOweNow]))
      .toEqual([
        ["Acme TCG", 5, 11_730, 2_511, 610, 1_200, 1_921, 356_860, 0],
        ["PackRat", 5, 7_000, 1_369, 150, 800, 719, 24_250, 0],
        ["Vendor #14", 0, 0, 0, 0, 0, 0, 0, 1_250],
      ]);
    expect(vendors.top[2].nameSource).toBe("id");
    expect(vendors.total).toMatchObject({ vendors: 3, orders: 10, billed: 18_730, keptOnOrders: 3_881, kept: 2_641, weOweNow: 381_110, theyOweNow: 1_250 });
    expect(vendors.roundingCents).toEqual({ keptOnOrders: 1, kept: 1 });
    expect([vendors.vendorsOrdered, vendors.wallets, vendors.others]).toEqual([2, 3, null]);
  });

  it("runs all 27 checks: D6, K2, N1 and N2 need a look", () => {
    expect(summary.checks.map((check) => check.id)).toEqual([...FINANCE_CHECK_IDS]);
    const needALook = summary.checks.filter((check) => check.result === "needs_a_look").map((check) => check.id);
    expect(needALook).toEqual(["D6", "K2", "N1", "N2"]);
    expect(summary.checks.filter((check) => check.result === "fine")).toHaveLength(23);
    const p1 = summary.checks.find((check) => check.id === "P1");
    expect(p1).toMatchObject({ result: "fine", exceptions: 0, difference: null, group: "page" });
    expect(p1?.examined).toBeGreaterThanOrEqual(14);
    expect(summary.checks.find((check) => check.id === "P2")).toMatchObject({ result: "fine", examined: 30, exceptions: 0 });
    expect(summary.checks.find((check) => check.id === "W1")?.ownerLineKeys).toContain("tiles.we_owe_now");
  });

  it("explains the Overview dashboard's different total", () => {
    expect(summary.info.find((info) => info.key === "overview_bridge")?.lines.map((line) => [line.key, line.amount])).toEqual([
      ["info.overview_bridge.oms_row", 18_930],
      ["info.overview_bridge.billed", 18_730],
      ["info.overview_bridge.leftover_pending", 1_000],
      ["info.overview_bridge.cancelled_in_oms", -800],
      ["info.overview_bridge.date_basis", 0],
    ]);
  });

  it("emits every section's lines in statement order, with the registry's unit and link", () => {
    for (const section of FINANCE_SECTION_KEYS) {
      const order: readonly string[] = FINANCE_SECTION_LINE_KEYS[section];
      const indexes = summary.sections[section].lines.map((line) => order.indexOf(line.key));
      expect(indexes.every((index) => index >= 0)).toBe(true);
      expect([...indexes].sort((x, y) => x - y)).toEqual(indexes);
      for (const line of summary.sections[section].lines) {
        const definition = FINANCE_LINE_DEFINITIONS[line.key as keyof typeof FINANCE_LINE_DEFINITIONS];
        expect([line.key, line.unit]).toEqual([line.key, definition.unit]);
        expect([line.key, line.opensMetric]).toEqual([line.key, definition.opensMetric]);
      }
    }
  });

  it("is deterministic and leaves the raw aggregates as they were", () => {
    const raw = fixtureRaw();
    const before = structuredClone(raw);
    const first = buildFinanceSummary(raw, fixtureContext());
    expect(raw).toEqual(before);
    expect(buildFinanceSummary(raw, fixtureContext())).toEqual(first);
    expect(financeSummarySchema.safeParse(first).success).toBe(true);
  });

  it("tells the service what to log", () => {
    expect(financeSummaryDiagnostics(summary)).toEqual({
      sectionStatuses: { answer: "ok", sales: "ok", products: "ok", cash: "ok", returns: "ok", owed: "ok", points: "ok", pool: "ok", vendors: "ok" },
      checksNeedingLook: ["D6", "K2", "N1", "N2"],
      checksNotRun: [],
      outOfRange: [],
    });
  });
});

describe("buildFinanceSummary: one vendor's view (summary?vendorId=12)", () => {
  const summary = build(vendor12Raw(), fixtureContext(ACME_TCG));

  it("scopes every number to the vendor", () => {
    expect(summary.scope.vendor).toEqual(ACME_TCG);
    expect(summary.answer).toMatchObject({
      orders: 5, billed: 11_730, fullyCosted: { orders: 2, billed: 7_530 }, keptOnOrders: 2_511, feesCharged: 610,
      returnCreditsPaid: 1_200, kept: { amount: 1_921 },
    });
    expect(summary.tiles.weOweNow).toMatchObject({ amount: 356_860, vendors: 1 });
    expect(summary.tiles.owedToUsNow).toMatchObject({ amount: 0, vendors: 0 });
    expect(summary.sections.vendors.top.map((row) => row.vendorId)).toEqual([12]);
    expect(summary.sections.vendors.roundingCents).toEqual({ keptOnOrders: 0, kept: 0 });
  });

  it("reads program-wide checks and pool figures as program-wide", () => {
    expect(checkResults(summary)).toMatchObject({ K2: "needs_a_look", N2: "program_wide", P2: "program_wide", P1: "fine", D6: "fine" });
    for (const key of ["pool.opening", "pool.topped_up", "pool.closing", "pool.record"]) {
      expect(lineOf(summary, "pool", key)).toMatchObject({ amount: null, status: "unavailable", reasonKey: "program_wide" });
    }
    expectLines(summary, "pool", { "pool.set_aside": ["plus", 220], "pool.paid_out": ["minus", 1_100] });
    expect(summary.info.map((info) => info.key)).toEqual(["won_disputes"]);
  });
});

describe("buildFinanceSummary: a period that ended (last month)", () => {
  const summary = build(lastMonthRaw(), lastMonthContext());

  it("counts September's orders, H included by its Eastern day", () => {
    expect(summary.period).toMatchObject({ fromDate: "2026-09-01", toDate: "2026-09-30", endsNow: false, endAt: "2026-10-01T04:00:00.000Z" });
    expect(summary.answer).toMatchObject({ billed: 4_100, keptOnOrders: 1_710, marginTenths: 417, priorMarginTenths: null, marginChangeTenths: null });
    expect(summary.tiles.billed.prior).toMatchObject({ amount: 0, change: 4_100, kind: "new" });
    expectLines(summary, "cash", { "cash.received_deposits": ["equals", 300_000] });
  });

  it("shows balances right now beside the balances at the end of the period", () => {
    expect(summary.tiles.weOweNow).toMatchObject({ amount: 381_110, atEndOfPeriod: 303_900 });
    expect(summary.tiles.owedToUsNow).toMatchObject({ amount: 1_250, atEndOfPeriod: 1_250 });
    expectLines(summary, "owed", {
      "owed.walk.opening": ["none", 6_750],
      "owed.walk.deposits": ["plus", 300_000],
      "owed.walk.orders": ["minus", 4_100],
      "owed.walk.closing": ["equals", 302_650],
      "owed.walk.we_owe": ["none", 303_900],
      "owed.walk.they_owe": ["none", 1_250],
      "owed.walk.on_the_way": ["none", 54_000],
    });
    expect(lineOf(summary, "owed", "owed.walk.closing").datedBy).toBe("end_of_period");
    expect(lineOf(summary, "points", "points.held")).toMatchObject({ amount: 3_080, datedBy: "end_of_period" });
    expect(lineOf(summary, "pool", "pool.closing")).toMatchObject({ amount: 90, datedBy: "end_of_period" });
    expect(checkResults(summary).P1).toBe("fine");
  });

  it("notes the three policy eras September touches", () => {
    expect(summary.notes).toEqual(["card_fee_era", "pricing_v1_era", "weekly_collection_era"]);
  });
});

describe("buildFinanceSummary: failures stay inside their section", () => {
  it("shows a failed ledger statement as errors and unavailable lines while the rest renders", () => {
    const summary = build(failedRaw("ledger"));
    for (const section of ["cash", "returns", "points"] as const) {
      expect(summary.sections[section]).toEqual({ status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT", lines: [] });
    }
    expect(summary.answer).toMatchObject({ state: "unavailable", status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT", kept: { amount: null, status: "unavailable" } });
    expect(summary.sections.sales.status).toBe("ok");
    expect(lineOf(summary, "sales", "sales.billed").amount).toBe(18_730);
    for (const key of ["sales.fees", "sales.return_credits_cs", "sales.kept"]) {
      expect(lineOf(summary, "sales", key)).toMatchObject({ amount: null, status: "unavailable", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT" });
    }
    expect(lineOf(summary, "owed", "owed.we_owe").amount).toBe(381_110);
    expect(lineOf(summary, "owed", "owed.walk.closing")).toMatchObject({ status: "unavailable", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT" });
    expect(lineOf(summary, "pool", "pool.paid_out").status).toBe("unavailable");
    expect(lineOf(summary, "pool", "pool.set_aside").amount).toBe(400);
    expect(summary.tiles.cashReceived).toEqual({ amount: null, status: "unavailable", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT", prior: null });
    expect(summary.tiles.billed.amount).toBe(18_730);
    expect(checkResults(summary).P1).toBe("fine");
    expect(financeSummaryDiagnostics(summary).sectionStatuses).toMatchObject({ answer: "error", cash: "error", sales: "ok" });
  });

  it("shows a statement the budget skipped, and a check that could not run", () => {
    const raw = fixtureRaw();
    const summary = build({
      ...raw,
      products: { status: "skipped", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED" },
      checks: { ...raw.checks, K3: { status: "skipped", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED" } },
    });
    expect(summary.sections.products).toEqual({
      status: "skipped", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED", lines: [], top: [], others: null, total: null,
      roundingCents: { costOfGoods: 0, keptOnProduct: 0 },
    });
    expect(summary.checks.find((check) => check.id === "K3")).toMatchObject({
      result: "could_not_check", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED", examined: 0, exceptions: 0, difference: null,
    });
    expect(financeSummaryDiagnostics(summary).checksNotRun).toEqual([{ id: "K3", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED" }]);
  });

  it("fails the answer, the Sales row and the Billed tile when the orders statement fails", () => {
    const summary = build(failedRaw("orders", "disputes", "wallets", "vendors", "pool", "neverCharged", "bridge"));
    expect(summary.answer.state).toBe("unavailable");
    expect(summary.sections.sales).toEqual({ status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT", lines: [] });
    expect(summary.tiles.billed).toEqual({ amount: null, status: "unavailable", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT", orders: 0, prior: null });
    expect(summary.tiles.weOweNow.status).toBe("unavailable");
    expect(lineOf(summary, "cash", "cash.won_back")).toMatchObject({ status: "unavailable", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT" });
    expect(lineOf(summary, "points", "points.held_now").status).toBe("unavailable");
    expect(summary.sections.owed.status).toBe("error");
    expect(summary.info.find((info) => info.key === "overview_bridge")?.status).toBe("unavailable");
  });

  it("marks the comparison unavailable when its statement failed", () => {
    const summary = build({ ...fixtureRaw(), compareOrders: { status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT" } });
    expect(summary.tiles.billed.prior).toEqual({ amount: null, change: null, changeTenths: null, changeBps: null, kind: "unavailable" });
    expect(summary.answer.priorMarginTenths).toBeNull();
  });
});

describe("buildFinanceSummary: periods with nothing, or not enough, to show", () => {
  function emptyRaw(): FinanceRawAggregates {
    const raw = fixtureRaw();
    return {
      ...raw,
      orders: ok({ totals: zeroOrderTotals(), byReason: [] }),
      compareOrders: ok({ totals: zeroOrderTotals(), byReason: [] }),
      products: ok({
        totals: { packs: ZERO, pieces: null, linesWithoutPieces: ZERO, packsShipped: ZERO, packsFc: ZERO, billedProduct: ZERO,
          billedProductFc: ZERO, cogsMillsFc: ZERO, unlinkedCogsMillsFc: ZERO },
        groups: [],
      }),
      neverCharged: ok([]),
      ledger: ok({ groups: [], firstFailureCode: null }),
      disputes: ok({ won: [], notWonBack: { disputes: ZERO, disputedCents: ZERO } }),
      returnFees: ok([]),
      wallets: ok([]),
      pool: ok({ setAsideBeforeStart: ZERO, setAsideP: ZERO, toppedUpBeforeStart: ZERO, toppedUpP: ZERO, recordedLedgerAtEnd: ZERO, claims: [] }),
      bridge: ok({ omsRow: ZERO, notAccepted: ZERO, notAcceptedOrders: ZERO }),
      vendors: ok([]),
    };
  }

  it("says no orders, never 'not recorded', in an empty period", () => {
    const summary = build(emptyRaw());
    expect(summary.answer).toMatchObject({
      state: "no_orders", orders: 0, billed: 0, kept: { amount: 0, status: "recorded" }, marginTenths: null, marginBps: null,
      centsOfEachDollar: null, barBps: null, coverage: { done: 0, total: 0 },
    });
    expect(summary.tiles.billed).toMatchObject({ amount: 0, prior: { kind: "no_change" } });
    expect(summary.tiles.cashReceived).toMatchObject({ amount: 0, prior: { kind: "no_change" } });
    expect(lineOf(summary, "sales", "sales.kept_orders")).toMatchObject({ amount: 0, status: "recorded", percentTenths: null });
    expect(summary.sections.products).toMatchObject({ status: "ok", top: [], others: null, total: null });
    expect(lineOf(summary, "products", "products.pieces")).toMatchObject({ amount: 0, status: "recorded" });
    expect(summary.sections.vendors).toMatchObject({ top: [], total: null, vendorsOrdered: 0, wallets: 0 });
    expect(lineOf(summary, "pool", "pool.closing").amount).toBe(0);
    expect(summary.info.map((info) => info.key)).toEqual(["overview_bridge", "pool_record"]);
    expect(checkResults(summary).P1).toBe("fine");
  });

  it("says not ready when no order is fully costed yet", () => {
    const raw = emptyRaw();
    const summary = build({
      ...raw,
      orders: ok({
        totals: { ...zeroOrderTotals(), orders: b(2), billed: b(2_000), productBilled: b(1_500), shippingBilled: b(500), poolAll: b(40), paidCash: b(2_000) },
        byReason: [{ reason: "not_shipped", orders: b(2), billed: b(2_000) }],
      }),
    });
    expect(summary.answer).toMatchObject({
      state: "not_ready", fullyCosted: { orders: 0, billed: 0 }, waiting: { orders: 2, billed: 2_000 }, keptOnOrders: 0,
      marginTenths: null, centsOfEachDollar: null,
      barBps: { kept: 0, costOfGoods: 0, carrierLabels: 0, poolShare: 0, waiting: 10_000 },
      coverage: { done: 0, total: 2 },
    });
  });

  it("shows a loss signed, with no split of each dollar", () => {
    const raw = emptyRaw();
    const summary = build({
      ...raw,
      orders: ok({
        totals: {
          ...zeroOrderTotals(), orders: b(1), fcOrders: b(1), billed: b(1_000), billedFc: b(1_000), productBilled: b(600),
          productBilledFc: b(600), shippingBilled: b(400), shippingNetPoolFc: b(350), poolAll: b(50), poolFc: b(50),
          paidCash: b(1_000), cogsMillsFc: b(150_000), labelsFc: b(300), coverageLabels: b(1), coverageLabelsCosted: b(1),
        },
        byReason: [],
      }),
    });
    expect(summary.answer).toMatchObject({
      state: "loss", keptOnOrders: -850, kept: { amount: -850 }, marginTenths: -850, marginBps: -8_500,
      centsOfEachDollar: null, barBps: null,
    });
    expectLines(summary, "sales", {
      "sales.kept_orders": ["equals", -850],
      "sales.kept_orders.on_products": ["none", -900],
      "sales.kept_orders.on_shipping": ["none", 50],
      "sales.kept": ["equals", -850],
    });
  });
});

describe("buildFinanceSummary: numbers the contract can't carry", () => {
  const unsafe = b("1152921504606846976"); // 2^60

  it("withholds an unsafe total as unavailable, never as $0.00", () => {
    const raw = fixtureRaw();
    const orders = raw.orders.status === "ok" ? raw.orders.data : null;
    const summary = build({ ...raw, orders: ok({ ...(orders as NonNullable<typeof orders>), totals: { ...(orders as NonNullable<typeof orders>).totals, billed: unsafe } }) });
    expect(lineOf(summary, "sales", "sales.billed")).toMatchObject({
      amount: null, status: "unavailable", errorCode: "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE", reasonKey: "amount_out_of_range",
    });
    expect(summary.tiles.billed).toMatchObject({ amount: null, status: "unavailable", errorCode: "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE" });
    expect(summary.answer).toMatchObject({ state: "unavailable", status: "error", errorCode: "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE" });
    // Everything that does not need the unsafe total still shows.
    expect(lineOf(summary, "sales", "sales.billed_fc").amount).toBe(9_730);
    expect(financeSummaryDiagnostics(summary).outOfRange).toEqual(expect.arrayContaining(["answer", "tiles.billed", "sales.billed", "sales.waiting"]));
  });

  it("fails a table section whose row can't be carried", () => {
    const raw = fixtureRaw();
    const products = raw.products.status === "ok" ? raw.products.data : null;
    const groups = (products as NonNullable<typeof products>).groups.map((group, index) => (index === 0 ? { ...group, billedProduct: unsafe } : group));
    const summary = build({ ...raw, products: ok({ ...(products as NonNullable<typeof products>), groups }) });
    expect(summary.sections.products).toMatchObject({ status: "error", errorCode: "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE", top: [], total: null });
    expect(financeSummaryDiagnostics(summary).outOfRange).toContain("sections.products");
  });

  it("fails the vendors table on a negative points balance (bad data)", () => {
    const raw = fixtureRaw();
    const rows = (raw.vendors.status === "ok" ? raw.vendors.data : []).map((row) => (row.vendorId === 13 ? { ...row, points: b(-1) } : row));
    expect(build({ ...raw, vendors: ok(rows) }).sections.vendors).toMatchObject({ status: "error", errorCode: "DROPSHIP_FINANCE_DATA_INVALID" });
  });
});

describe("buildFinanceSummary: missing tables and partly recorded figures", () => {
  it("marks only the lines that need a missing optional table", () => {
    const raw = fixtureRaw();
    const summary = build({ ...raw, tables: { ...raw.tables, quotes: false, lots: false, claims: false, settlements: false, variants: false, audit: false } });
    for (const [section, key] of [
      ["sales", "sales.billed.carrier_estimate"], ["sales", "sales.billed.markup"], ["sales", "sales.never_charged.would_have_charged"],
      ["points", "points.expiry.never"], ["pool", "pool.claims"], ["returns", "returns.fees.restocking"], ["products", "products.pieces"],
    ] as const) {
      expect(lineOf(summary, section, key)).toMatchObject({
        amount: null, status: "unavailable", errorCode: "DROPSHIP_FINANCE_TABLE_MISSING", reasonKey: "table_missing",
      });
    }
    expect(summary.checks.find((check) => check.id === "P2")).toMatchObject({ result: "needs_a_look", exceptions: 6 });
    expect(checkResults(summary).P1).toBe("fine");
  });

  it("keeps the pool's worked-out balance unavailable without the pool ledger", () => {
    const raw = fixtureRaw();
    const summary = build({ ...raw, tables: { ...raw.tables, pool_ledger: false } });
    expect(lineOf(summary, "pool", "pool.closing")).toMatchObject({ status: "unavailable", reasonKey: "table_missing" });
    expect(lineOf(summary, "pool", "pool.paid_out").amount).toBe(1_700);
    expect(summary.info.map((info) => info.key)).not.toContain("pool_record");
  });

  it("marks malformed deposit details and missing dispute amounts as partial", () => {
    const groups = fixtureLedgerGroups().map((group) => {
      if (group.cashLine === "stripe_card") return { ...group, malformedP: b(1) };
      if (group.type === "funding_reversal") return { ...group, disputeMissingP: b(1) };
      return group;
    });
    const summary = build({ ...fixtureRaw(), ledger: ok({ groups, firstFailureCode: "R01" }) });
    expect(lineOf(summary, "cash", "cash.card")).toMatchObject({ status: "partial", reasonKey: "metadata_malformed", amount: 10_300 });
    expect(lineOf(summary, "cash", "cash.ach").status).toBe("recorded");
    expect(lineOf(summary, "cash", "cash.pulled_back")).toMatchObject({ status: "partial", reasonKey: "dispute_amount_missing" });
    expect(lineOf(summary, "cash", "cash.received").status).toBe("partial");
    expect(lineOf(summary, "sales", "sales.fees").status).toBe("partial");
    expect(summary.answer.kept).toEqual({ amount: 2_641, status: "partial" });
    expect(summary.tiles.cashReceived.status).toBe("partial");
  });

  it("marks a won dispute with no paired pull-back as partial", () => {
    const raw = fixtureRaw();
    const disputes = {
      won: [{ inP: true, inCompare: false, reinstatedId: 21, restoredCents: b(10_000), reversalId: null, disputedCents: null, creditCents: null, fromCashCents: null }],
      notWonBack: { disputes: b(1), disputedCents: b(2_000) },
    };
    const summary = build({ ...raw, disputes: ok(disputes) });
    expect(lineOf(summary, "cash", "cash.won_back")).toMatchObject({ amount: 0, count: 1, status: "partial", reasonKey: "reversal_not_paired" });
    expect(summary.info.find((info) => info.key === "won_disputes")?.status).toBe("partial");
  });

  it("shows what the walk can't explain, and entries nothing should write", () => {
    const groups = [
      ...fixtureLedgerGroups(),
      ledgerGroup({ vendorId: 12, type: "manual_adjustment", status: "settled", nP: b(1), amountP: b(-25), amountBeforeEnd: b(-25) }),
      // A settled entry whose settle time differs from its post time: in the balance, not in the period's movements.
      ledgerGroup({ vendorId: 13, type: "return_credit", status: "settled", referenceType: "dropship_rma", amountBeforeEnd: b(40) }),
    ];
    const summary = build({ ...fixtureRaw(), ledger: ok({ groups, firstFailureCode: "R01" }) });
    expectLines(summary, "owed", {
      "owed.walk.other": ["minus", 25],
      "owed.walk.unexplained": ["plus", 40],
      "owed.walk.closing": ["equals", 379_875],
    });
    expect(checkResults(summary).P1).toBe("fine");
  });

  it("flips the operator of a negative cost and leaves an over-shipped coverage off", () => {
    const raw = fixtureRaw();
    const orders = raw.orders.status === "ok" ? raw.orders.data : null;
    const products = raw.products.status === "ok" ? raw.products.data : null;
    const summary = build({
      ...raw,
      orders: ok({ ...(orders as NonNullable<typeof orders>), totals: { ...(orders as NonNullable<typeof orders>).totals, labelsFc: b(-15) } }),
      products: ok({ ...(products as NonNullable<typeof products>), totals: { ...(products as NonNullable<typeof products>).totals, packsShipped: b(22) } }),
    });
    expect(lineOf(summary, "sales", "sales.labels")).toMatchObject({ operator: "plus", amount: 15 });
    expect(lineOf(summary, "products", "products.packs_shipped").coverage).toBeUndefined();
    expect(lineOf(summary, "products", "products.packs_shipped").amount).toBe(22);
  });
});

describe("buildFinanceSummary: long tables", () => {
  it("names the top five and adds up the rest", () => {
    const raw = fixtureRaw();
    const group = (index: number): FinanceRawProductGroupRow => ({
      groupKey: `v:${100 + index}`, productVariantId: 100 + index, productId: 100 + index, productName: `P${index}`, sizeName: null, sku: null,
      unitsPerVariant: b(10), packs: b(1), pieces: b(10), linesWithoutPieces: ZERO, packsShipped: b(1), packsFc: b(1),
      billedProduct: b(100 * (index + 1)), billedProductFc: b(100 * (index + 1)), cogsMillsFc: b(2_550),
    });
    const groups = Array.from({ length: 7 }, (_, index) => group(index));
    const summary = build({
      ...raw,
      products: ok({
        totals: { packs: b(7), pieces: b(70), linesWithoutPieces: ZERO, packsShipped: b(7), packsFc: b(7), billedProduct: b(2_800),
          billedProductFc: b(2_800), cogsMillsFc: b(17_850), unlinkedCogsMillsFc: b(149) },
        groups,
      }),
    });
    const products = summary.sections.products;
    expect(products.top.map((row) => row.groupKey)).toEqual(["v:106", "v:105", "v:104", "v:103", "v:102"]);
    expect(products.others).toMatchObject({ groupKey: "others", packs: 2, billedForProduct: 300, costOfGoods: 52, costOfGoodsMills: "5100", keptOnProduct: 248 });
    // Seven rows of 26¢ (25.50 rounded up) = 182; the total rounds 17,999 mills once to 180, the unlinked 149 to 1.
    expect(products.total).toMatchObject({ costOfGoods: 180, costOfGoodsMills: "17999", keptOnProduct: 2_620 });
    expect(products.roundingCents).toEqual({ costOfGoods: -3, keptOnProduct: 3 });
    expect(lineOf(summary, "products", "products.cogs_unlinked").amount).toBe(1);
  });

  it("adds up the vendors after the top five", () => {
    const raw = fixtureRaw();
    const vendor = (vendorId: number, kept: number): FinanceRawVendorRow => ({
      vendorId, businessName: `V${vendorId}`, contactName: null, status: "active", orders: b(1), billed: b(1_000), waiting: ZERO,
      billedFc: b(1_000), cogsMillsFc: ZERO, labelsFc: b(1_000 - kept), poolFc: ZERO, fees: ZERO, creditsCs: ZERO, creditsAll: ZERO,
      cashIn: ZERO, available: b(10), pending: ZERO, points: ZERO,
    });
    const rows = [vendor(1, 50), vendor(2, 90), vendor(3, 10), vendor(4, 90), vendor(5, 70), vendor(6, 30), vendor(7, 20)];
    const summary = build({ ...raw, vendors: ok(rows) });
    expect(summary.sections.vendors.top.map((row) => row.vendorId)).toEqual([2, 4, 5, 1, 6]);
    expect(summary.sections.vendors.others).toMatchObject({ vendors: 2, orders: 2, kept: 30, weOweNow: 20 });
    expect(summary.sections.vendors.total).toMatchObject({ vendors: 7, orders: 7 });
  });
});

describe("buildFinanceSummary: guards", () => {
  it("refuses bounds from the database that differ from the page's windows", () => {
    const raw = fixtureRaw();
    expect(() => build({ ...raw, bounds: { ...raw.bounds, startAt: new Date("2026-10-01T05:00:00.000Z") } }))
      .toThrowError(expect.objectContaining({ code: "DROPSHIP_FINANCE_INTERNAL_ERROR" }));
    const period = resolveFinancePeriod("mtd", undefined, undefined, FINANCE_FIXTURE_NOW, FINANCE_FIXTURE_TIME_ZONE);
    expect(() => build(raw, { generatedAt: new Date("2026-10-05T13:15:00.000Z"), period: period.current, comparePeriod: period.compare, vendor: null }))
      .toThrowError(expect.objectContaining({ code: "DROPSHIP_FINANCE_INTERNAL_ERROR" }));
  });

  it("drops the comparison when Compare is off", () => {
    const period = resolveFinancePeriod("mtd", undefined, undefined, FINANCE_FIXTURE_NOW, FINANCE_FIXTURE_TIME_ZONE);
    const raw = fixtureRaw();
    const summary = build({ ...raw, bounds: { ...raw.bounds, compareStartAt: null, compareEndAt: null } },
      { generatedAt: FINANCE_FIXTURE_NOW, period: period.current, comparePeriod: null, vendor: null });
    expect(summary.comparePeriod).toBeNull();
    expect(summary.tiles.billed.prior).toBeNull();
    expect(summary.tiles.cashReceived.prior).toBeNull();
    expect(summary.answer.priorMarginTenths).toBeNull();
    expect(summary.answer.workings.map((step) => step.textKey)).not.toContain("working.margin_prior");
  });

  it("reports a summary that would break its contract, by path only", () => {
    const raw = fixtureRaw();
    const rows = (raw.vendors.status === "ok" ? raw.vendors.data : []).map((row) => (row.vendorId === 14 ? { ...row, vendorId: 0 } : row));
    let thrown: unknown;
    try {
      build({ ...raw, vendors: ok(rows) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "DROPSHIP_FINANCE_CONTRACT_VIOLATION" });
    const issues = (thrown as { context: { issues: { path: string }[] } }).context.issues;
    expect(issues.map((issue) => issue.path)).toContain("sections.vendors.top.2.vendorId");
    expect(JSON.stringify(issues)).not.toContain("1250");
  });

  it("reports a missing SQL check as one that could not run", () => {
    const raw = fixtureRaw();
    const { N2: _dropped, ...checks } = raw.checks;
    const summary = build({ ...raw, checks: { ...checks, W2: checkCounts(3, 2, -40) } });
    expect(summary.checks.find((check) => check.id === "N2")).toMatchObject({ result: "could_not_check", errorCode: "DROPSHIP_FINANCE_INTERNAL_ERROR" });
    expect(summary.checks.find((check) => check.id === "W2")).toMatchObject({ result: "needs_a_look", exceptions: 2, difference: 40 });
  });
});
