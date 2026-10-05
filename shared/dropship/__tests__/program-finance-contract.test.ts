import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  FINANCE_ANCHOR_KEYS,
  FINANCE_CHECK_IDS,
  FINANCE_CONTRACT_VERSION,
  FINANCE_INFO_LINE_KEYS,
  FINANCE_LINE_KEYS,
  FINANCE_METRIC_KEYS,
  FINANCE_NEVER_CHARGED_KINDS,
  FINANCE_SECTION_KEYS,
  FINANCE_SECTION_LINE_KEYS,
  FINANCE_TIME_ZONE,
  FINANCE_WAITING_REASONS,
  financeErrorEnvelopeSchema,
  financeLineSchema,
  financeSummaryQuerySchema,
  financeSummarySchema,
  isFinanceLineKey,
  type FinanceCheckId,
  type FinanceSummaryInput,
} from "../program-finance";
import { FINANCE_CHECK_DEFINITIONS } from "../program-finance-definitions";

type LineInput = z.input<typeof financeLineSchema>;
type CheckInput = FinanceSummaryInput["checks"][number];
type ProductRowInput = FinanceSummaryInput["sections"]["products"]["top"][number];
type VendorRowInput = FinanceSummaryInput["sections"]["vendors"]["top"][number];

const LINE_KEY_PATTERN = /^[a-z]+(\.[a-z0-9_]+){1,3}$/;
const GENERATED_AT = new Date("2026-10-05T13:14:00.000Z");

function lineOf(key: string, amount: number | null, extra: Partial<LineInput> = {}): LineInput {
  return { key, operator: "none", amount, unit: "cents", status: "recorded", datedBy: "accepted", depth: "summary", ...extra };
}

function productRow(overrides: Partial<ProductRowInput>): ProductRowInput {
  return {
    groupKey: "v:1", productVariantId: 1, productId: 1, productName: "Toploaders", sizeName: "3x4 · 25", sku: "TL-35-25",
    unitsPerVariant: 25, packs: 0, pieces: 0, linesWithoutPieces: 0, packsShipped: 0, packsFullyCosted: 0,
    billedForProduct: 0, billedOnFullyCosted: 0, costOfGoods: 0, costOfGoodsMills: "0", keptOnProduct: 0, keptTenths: null,
    ...overrides,
  };
}

const VENDOR_FIGURES_ZERO = {
  orders: 0, billed: 0, waitingOnCosts: 0, keptOnOrders: 0, feesCharged: 0, returnCreditsPaid: 0, kept: 0,
  cashIn: 0, creditsToVendor: 0, weOweNow: 0, theyOweNow: 0, onTheWay: 0, pointsHeld: 0,
};

function vendorRow(vendorId: number, name: string, overrides: Partial<VendorRowInput>): VendorRowInput {
  return { vendorId, name, nameSource: "business_name", status: "active", ...VENDOR_FIGURES_ZERO, ...overrides };
}

const NEEDS_A_LOOK: ReadonlySet<FinanceCheckId> = new Set<FinanceCheckId>(["D6", "K2", "N1", "N2"]);

function checkOf(id: FinanceCheckId): CheckInput {
  const definition = FINANCE_CHECK_DEFINITIONS[id];
  const needsALook = NEEDS_A_LOOK.has(id);
  return {
    id,
    group: definition.group,
    result: needsALook ? "needs_a_look" : "fine",
    scope: definition.scope,
    examined: 10,
    exceptions: needsALook ? 1 : 0,
    difference: null,
    ownerLineKeys: [...definition.ownerLineKeys],
  };
}

/** The contract §6.4 summary for mtd on 2026-10-05, all vendors. Every identity in it ties. */
function validSummary(): FinanceSummaryInput {
  return {
    contractVersion: FINANCE_CONTRACT_VERSION,
    generatedAt: GENERATED_AT,
    timeZone: FINANCE_TIME_ZONE,
    scope: { vendor: null },
    period: {
      preset: "mtd", fromDate: "2026-10-01", toDate: "2026-10-05",
      startAt: "2026-10-01T04:00:00.000Z", endAt: GENERATED_AT, endsNow: true, clampedToMonthEnd: false,
    },
    comparePeriod: {
      preset: "mtd", fromDate: "2026-09-01", toDate: "2026-09-05",
      startAt: "2026-09-01T04:00:00.000Z", endAt: "2026-09-05T13:14:00.000Z", endsNow: false, clampedToMonthEnd: false,
    },
    answer: {
      state: "kept", status: "ok",
      kept: { amount: 2_641, status: "recorded" },
      keptOnOrders: 3_881, feesCharged: 760, returnCreditsPaid: 2_000,
      orders: 10, billed: 18_730,
      fullyCosted: { orders: 3, billed: 9_730 },
      waiting: { orders: 7, billed: 9_000 },
      costOfGoods: 3_764, carrierLabels: 1_935, poolShare: 150,
      marginTenths: 399, marginBps: 3_989, priorMarginTenths: 404, marginChangeTenths: -5,
      centsOfEachDollar: { kept: 40, costOfGoods: 39, carrierLabels: 20, poolShare: 1 },
      barBps: { kept: 2_072, costOfGoods: 2_010, carrierLabels: 1_033, poolShare: 80, waiting: 4_805 },
      paidWithPoints: { billed: 2_200, points: 2_200 },
      coverage: { done: 3, total: 10 },
      workings: [
        { step: 1, textKey: "sales.billed", operands: [], result: 18_730, opensMetric: "sales.billed" },
        {
          step: 2, textKey: "sales.kept_orders", result: 3_881, opensMetric: "sales.kept_orders",
          operands: [
            { lineKey: "sales.billed_fc", amount: 9_730, unit: "cents", operator: "none" },
            { lineKey: "sales.cogs", amount: 3_764, unit: "cents", operator: "minus" },
            { lineKey: "sales.labels", amount: 1_935, unit: "cents", operator: "minus" },
            { lineKey: "sales.pool_fc", amount: 150, unit: "cents", operator: "minus" },
          ],
        },
        {
          step: 3, textKey: "sales.kept", result: 2_641,
          operands: [
            { lineKey: "sales.kept_orders", amount: 3_881, unit: "cents", operator: "none" },
            { lineKey: "sales.fees", amount: 760, unit: "cents", operator: "plus" },
            { lineKey: "sales.return_credits_cs", amount: 2_000, unit: "cents", operator: "minus" },
          ],
        },
        { step: 4, textKey: "working.not_included", operands: [], result: null },
      ],
    },
    tiles: {
      billed: {
        amount: 18_730, status: "recorded", orders: 10,
        prior: { amount: 2_600, change: 16_130, changeTenths: 6_204, changeBps: 62_038, kind: "change" },
      },
      cashReceived: {
        amount: 88_300, status: "recorded",
        prior: { amount: 300_000, change: -211_700, changeTenths: -706, changeBps: -7_057, kind: "change" },
      },
      weOweNow: { amount: 381_110, status: "recorded", vendors: 2, onTheWay: 19_000, atEndOfPeriod: null },
      owedToUsNow: { amount: 1_250, status: "recorded", vendors: 1, atEndOfPeriod: null },
    },
    sections: {
      sales: {
        status: "ok",
        lines: [
          lineOf("sales.billed", 18_730, { count: 10, opensMetric: "sales.billed" }),
          lineOf("sales.billed.product", 13_320),
          lineOf("sales.billed.shipping", 5_410),
          lineOf("sales.billed.carrier_estimate", 4_080),
          lineOf("sales.billed.markup", 930),
          lineOf("sales.billed.pool_share", 400),
          lineOf("sales.billed.paid_from_wallets", 16_530),
          lineOf("sales.billed.paid_with_points", 2_200),
          lineOf("sales.waiting", 9_000, { operator: "minus", count: 7 }),
          lineOf("sales.waiting.cancelled_in_oms", 800, { count: 1 }),
          lineOf("sales.waiting.not_shipped", 1_300, { count: 1 }),
          lineOf("sales.waiting.partly_shipped", 1_500, { count: 1 }),
          lineOf("sales.waiting.shared_label", 3_300, { count: 2 }),
          lineOf("sales.waiting.label_missing", 1_000, { count: 1 }),
          lineOf("sales.waiting.item_cost_missing", 1_100, { count: 1 }),
          lineOf("sales.billed_fc", 9_730, { operator: "equals", count: 3 }),
          lineOf("sales.cogs", 3_764, { operator: "minus" }),
          lineOf("sales.labels", 1_935, { operator: "minus" }),
          lineOf("sales.labels.replacement", 250, { depth: "every_line" }),
          lineOf("sales.pool_fc", 150, { operator: "minus" }),
          lineOf("sales.packaging", null, { status: "not_recorded", reasonKey: "packaging_not_saved" }),
          lineOf("sales.kept_orders", 3_881, { operator: "equals", percentTenths: 399, percentBps: 3_989 }),
          lineOf("sales.kept_orders.on_products", 3_756, { percentTenths: 499, percentBps: 4_995 }),
          lineOf("sales.kept_orders.on_shipping", 125, { percentTenths: 61, percentBps: 607 }),
          lineOf("sales.fees", 760, { operator: "plus", datedBy: "posted" }),
          lineOf("sales.fees.advance", 10, { datedBy: "posted" }),
          lineOf("sales.fees.card", 300, { datedBy: "settled", depth: "every_line" }),
          lineOf("sales.fees.returns", 450, { datedBy: "posted" }),
          lineOf("sales.return_credits_cs", 2_000, { operator: "minus", datedBy: "posted" }),
          lineOf("sales.kept", 2_641, { operator: "equals" }),
          lineOf("sales.buyer_paid", 23_993, { status: "partial", reasonKey: "buyer_total_unknown", count: 1 }),
          lineOf("sales.never_charged", 3, { unit: "count", count: 3, datedBy: "received" }),
          lineOf("sales.never_charged.waiting_for_payment", 1, { unit: "count", datedBy: "received" }),
          lineOf("sales.never_charged.payment_time_ran_out", 1, { unit: "count", datedBy: "received" }),
          lineOf("sales.never_charged.rejected", 1, { unit: "count", datedBy: "received" }),
          lineOf("sales.never_charged.would_have_charged", 2_500, { datedBy: "received" }),
          lineOf("sales.label_coverage", 7, { unit: "count", coverage: { done: 7, total: 8 } }),
        ],
      },
      products: {
        status: "ok",
        lines: [
          lineOf("products.billed", 13_320),
          lineOf("products.packs", 21, { unit: "count" }),
          lineOf("products.pieces", 950, { unit: "count", status: "partial", reasonKey: "pieces_not_recorded" }),
          lineOf("products.lines_without_pieces", 1, { unit: "count" }),
          lineOf("products.count", 3, { unit: "count" }),
          lineOf("products.packs_fully_costed", 11, { unit: "count", coverage: { done: 11, total: 21 } }),
          lineOf("products.packs_shipped", 18, { unit: "count", coverage: { done: 18, total: 21 } }),
        ],
        top: [
          productRow({ packs: 14, pieces: 350, packsShipped: 13, packsFullyCosted: 9, billedForProduct: 8_420,
            billedOnFullyCosted: 5_520, costOfGoods: 3_143, costOfGoodsMills: "314250", keptOnProduct: 2_377, keptTenths: 431 }),
          productRow({ groupKey: "v:2", productVariantId: 2, productId: 2, productName: "Penny sleeves", sizeName: "100", sku: "PS-100",
            unitsPerVariant: 100, packs: 6, pieces: 600, packsShipped: 5, packsFullyCosted: 2, billedForProduct: 4_400,
            billedOnFullyCosted: 2_000, costOfGoods: 622, costOfGoodsMills: "62150", keptOnProduct: 1_378, keptTenths: 689 }),
          productRow({ groupKey: "sku:MYSTERY-1", productVariantId: null, productId: null, productName: null, sizeName: null,
            sku: "MYSTERY-1", unitsPerVariant: null, packs: 1, pieces: null, linesWithoutPieces: 1, billedForProduct: 500 }),
        ],
        others: null,
        total: productRow({ groupKey: "total", productVariantId: null, productId: null, productName: null, sizeName: null, sku: null,
          unitsPerVariant: null, packs: 21, pieces: 950, linesWithoutPieces: 1, packsShipped: 18, packsFullyCosted: 11,
          billedForProduct: 13_320, billedOnFullyCosted: 7_520, costOfGoods: 3_764, costOfGoodsMills: "376400",
          keptOnProduct: 3_756, keptTenths: 499 }),
        roundingCents: { costOfGoods: -1, keptOnProduct: 1 },
      },
      cash: {
        status: "ok",
        lines: [
          lineOf("cash.ach", 50_000, { count: 1, datedBy: "settled" }),
          lineOf("cash.card", 10_300, { count: 1, datedBy: "settled" }),
          lineOf("cash.card.fees", 300, { datedBy: "settled" }),
          lineOf("cash.usdc", 25_000, { count: 1, datedBy: "settled" }),
          lineOf("cash.usdc.chain_watcher", 25_000, { datedBy: "settled" }),
          lineOf("cash.collection", 5_000, { count: 1, datedBy: "settled" }),
          lineOf("cash.received_deposits", 90_300, { operator: "equals", datedBy: "settled" }),
          lineOf("cash.pulled_back", 12_300, { operator: "minus", count: 2, datedBy: "posted" }),
          lineOf("cash.won_back", 10_300, { operator: "plus", count: 1, datedBy: "posted" }),
          lineOf("cash.received", 88_300, { operator: "equals", datedBy: "settled" }),
          lineOf("cash.memo.on_the_way", 19_000, { count: 2, datedBy: "now" }),
          lineOf("cash.memo.stuck", 4_000, { count: 1, datedBy: "now" }),
          lineOf("cash.memo.failed", 7_000, { count: 1, datedBy: "posted", failureCode: "R01" }),
          lineOf("cash.memo.not_won_back", 2_000, { count: 1, datedBy: "posted" }),
          lineOf("cash.memo.staff_credits", 2_500, { count: 1, datedBy: "settled" }),
          lineOf("cash.memo.stripe_fees", null, { status: "not_recorded", reasonKey: "stripe_fees_not_saved", datedBy: "settled" }),
        ],
      },
      returns: {
        status: "ok",
        lines: [
          lineOf("returns.credited", 3_700, { count: 4, datedBy: "posted" }),
          lineOf("returns.credits_cs", 2_000, { count: 2, datedBy: "posted" }),
          lineOf("returns.credits_cs.inspected", 1_200, { datedBy: "posted" }),
          lineOf("returns.credits_cs.return_case", 800, { datedBy: "posted" }),
          lineOf("returns.credits_pool", 1_700, { count: 2, datedBy: "posted" }),
          lineOf("returns.credits_pool.no_inspection", 1_100, { datedBy: "posted" }),
          lineOf("returns.credits_pool.inspection_fault", 600, { datedBy: "posted" }),
          lineOf("returns.fees", 450, { operator: "minus", datedBy: "posted" }),
          lineOf("returns.fees.restocking", 350, { datedBy: "posted" }),
          lineOf("returns.fees.processing", 100, { datedBy: "posted" }),
          lineOf("returns.net", 3_250, { operator: "equals", datedBy: "posted" }),
          lineOf("returns.staff_credits", 2_500, { count: 1, datedBy: "settled" }),
          lineOf("returns.memo.order_refunds", null, { status: "not_recorded", reasonKey: "no_refund_path", datedBy: "posted" }),
        ],
      },
      owed: {
        status: "ok",
        lines: [
          lineOf("owed.we_owe", 381_110, { count: 2, datedBy: "now" }),
          lineOf("owed.they_owe", 1_250, { count: 1, datedBy: "now" }),
          lineOf("owed.on_the_way", 19_000, { count: 2, datedBy: "now" }),
          lineOf("owed.wallets", 3, { unit: "count", datedBy: "now" }),
          lineOf("owed.history_matches", 0, { coverage: { done: 3, total: 3 }, datedBy: "now" }),
          lineOf("owed.walk.opening", 302_650, { datedBy: "settled" }),
          lineOf("owed.walk.deposits", 90_000, { operator: "plus", datedBy: "settled" }),
          lineOf("owed.walk.staff_credits", 2_500, { operator: "plus", datedBy: "settled" }),
          lineOf("owed.walk.return_credits_cs", 2_000, { operator: "plus", datedBy: "posted" }),
          lineOf("owed.walk.return_credits_pool", 1_700, { operator: "plus", datedBy: "posted" }),
          lineOf("owed.walk.disputes_won", 10_000, { operator: "plus", datedBy: "posted" }),
          lineOf("owed.walk.orders", 16_530, { operator: "minus", datedBy: "posted" }),
          lineOf("owed.walk.advance_fees", 10, { operator: "minus", datedBy: "posted" }),
          lineOf("owed.walk.return_fees", 450, { operator: "minus", datedBy: "posted" }),
          lineOf("owed.walk.disputes_taken", 12_000, { operator: "minus", datedBy: "posted" }),
          lineOf("owed.walk.closing", 379_860, { operator: "equals", datedBy: "now" }),
          lineOf("owed.walk.we_owe", 381_110, { datedBy: "now" }),
          lineOf("owed.walk.they_owe", 1_250, { datedBy: "now" }),
        ],
      },
      points: {
        status: "ok",
        lines: [
          lineOf("points.opening", 3_080, { unit: "points", datedBy: "posted" }),
          lineOf("points.given", 750, { unit: "points", operator: "plus", datedBy: "posted" }),
          lineOf("points.given.bank", 500, { unit: "points", datedBy: "posted" }),
          lineOf("points.given.usdc", 250, { unit: "points", datedBy: "posted" }),
          lineOf("points.used", 2_200, { unit: "points", operator: "minus", datedBy: "posted" }),
          lineOf("points.used.billed_value", 2_200, { datedBy: "posted" }),
          lineOf("points.expired", 80, { unit: "points", operator: "minus", datedBy: "posted" }),
          lineOf("points.taken_back", 20, { unit: "points", operator: "minus", datedBy: "posted" }),
          lineOf("points.held", 1_530, { unit: "points", operator: "equals", datedBy: "now" }),
          lineOf("points.held_now", 1_530, { unit: "points", datedBy: "now" }),
          lineOf("points.memo.from_cash", 0, { datedBy: "posted" }),
          lineOf("points.expiry.days_31_to_90", 250, { unit: "points", datedBy: "now" }),
          lineOf("points.expiry.never", 1_280, { unit: "points", datedBy: "now" }),
        ],
      },
      pool: {
        status: "ok",
        lines: [
          lineOf("pool.opening", 90, { datedBy: "posted" }),
          lineOf("pool.set_aside", 400, { operator: "plus" }),
          lineOf("pool.paid_out", 1_700, { operator: "minus", datedBy: "posted" }),
          lineOf("pool.paid_out.no_inspection", 1_100, { datedBy: "posted" }),
          lineOf("pool.paid_out.inspection_fault", 600, { datedBy: "posted" }),
          lineOf("pool.topped_up", 300, { operator: "plus", datedBy: "posted" }),
          lineOf("pool.closing", -910, { operator: "equals", datedBy: "now" }),
          lineOf("pool.claims", 900, { count: 1, datedBy: "posted" }),
          lineOf("pool.record", -800, { datedBy: "posted" }),
        ],
      },
      vendors: {
        status: "ok",
        lines: [lineOf("vendors.ordered", 2, { unit: "count" }), lineOf("vendors.wallets", 3, { unit: "count", datedBy: "now" })],
        top: [
          vendorRow(12, "Acme TCG", { orders: 5, billed: 11_730, waitingOnCosts: 3, keptOnOrders: 2_511, feesCharged: 610,
            returnCreditsPaid: 1_200, kept: 1_921, cashIn: 60_300, creditsToVendor: 2_300, weOweNow: 341_840, pointsHeld: 1_280 }),
          vendorRow(13, "PackRat", { orders: 5, billed: 7_000, waitingOnCosts: 4, keptOnOrders: 1_369, feesCharged: 150,
            returnCreditsPaid: 800, kept: 719, cashIn: 30_000, creditsToVendor: 1_400, weOweNow: 39_270, onTheWay: 15_000, pointsHeld: 250 }),
          vendorRow(14, "Vendor #14", { nameSource: "id", theyOweNow: 1_250, onTheWay: 4_000 }),
        ],
        others: null,
        total: { vendors: 3, orders: 10, billed: 18_730, waitingOnCosts: 7, keptOnOrders: 3_880, feesCharged: 760, returnCreditsPaid: 2_000,
          kept: 2_640, cashIn: 90_300, creditsToVendor: 3_700, weOweNow: 381_110, theyOweNow: 1_250, onTheWay: 19_000, pointsHeld: 1_530 },
        roundingCents: { keptOnOrders: 1, kept: 1 },
        vendorsOrdered: 2,
        wallets: 3,
      },
    },
    checks: FINANCE_CHECK_IDS.map(checkOf),
    info: [
      {
        key: "won_disputes", status: "recorded",
        lines: [
          lineOf("info.won_disputes.cash_returned", 10_300, { datedBy: "posted" }),
          lineOf("info.won_disputes.wallet_restored", 10_000, { datedBy: "posted" }),
          lineOf("info.won_disputes.card_fee_part", 300, { datedBy: "posted" }),
          lineOf("info.won_disputes.points_from_cash", 0, { datedBy: "posted" }),
        ],
      },
      {
        key: "pool_record", status: "recorded",
        lines: [lineOf("info.pool_record.recorded", -800, { datedBy: "posted" }), lineOf("info.pool_record.worked_out", -910, { datedBy: "now" })],
      },
    ],
    notes: [],
  };
}

function issuesOf(input: unknown): string[] {
  const result = financeSummarySchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

function salesLine(summary: FinanceSummaryInput, key: string): LineInput {
  const found = summary.sections.sales.lines.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`fixture has no ${key}`);
  return found;
}

describe("financeSummarySchema", () => {
  it("parses the hand-built §6.4 summary and turns Dates into ISO text", () => {
    const result = financeSummarySchema.safeParse(validSummary());
    expect(issuesOf(validSummary())).toEqual([]);
    expect(result.success && result.data.generatedAt).toBe("2026-10-05T13:14:00.000Z");
    expect(result.success && result.data.period.endAt).toBe("2026-10-05T13:14:00.000Z");
    expect(result.success && result.data.checks).toHaveLength(27);
  });

  it("refuses an amount of 1.5 cents anywhere", () => {
    const inLine = validSummary();
    salesLine(inLine, "sales.billed").amount = 1.5;
    expect(issuesOf(inLine)).toContain("sections.sales.lines.0.amount: Expected integer, received float");

    const inTile = validSummary();
    inTile.tiles.billed.amount = 1.5;
    expect(issuesOf(inTile).some((issue) => issue.startsWith("tiles.billed.amount"))).toBe(true);

    const inRow = validSummary();
    inRow.sections.vendors.top[0].kept = 1.5;
    expect(issuesOf(inRow).some((issue) => issue.startsWith("sections.vendors.top.0.kept"))).toBe(true);
  });

  it("refuses an amount past the safe integer range", () => {
    const summary = validSummary();
    summary.answer.billed = Number.MAX_SAFE_INTEGER + 1;
    expect(issuesOf(summary).some((issue) => issue.startsWith("answer.billed"))).toBe(true);
  });

  it("refuses a not recorded line that carries a number", () => {
    const summary = validSummary();
    salesLine(summary, "sales.packaging").amount = 0;
    expect(issuesOf(summary)).toContain("sections.sales.lines.20.amount: not recorded is never a number");
  });

  it("refuses a not recorded or partial line with no reason", () => {
    const notRecorded = validSummary();
    delete salesLine(notRecorded, "sales.packaging").reasonKey;
    expect(issuesOf(notRecorded)).toContain("sections.sales.lines.20.reasonKey: a not_recorded line says why");

    const partial = validSummary();
    delete salesLine(partial, "sales.buyer_paid").reasonKey;
    expect(issuesOf(partial).some((issue) => issue.endsWith("a partial line says why"))).toBe(true);
  });

  it("refuses a recorded line with no number, and an unavailable line with a number or no reason", () => {
    const recorded = validSummary();
    salesLine(recorded, "sales.cogs").amount = null;
    expect(issuesOf(recorded).some((issue) => issue.endsWith("recorded line needs an amount"))).toBe(true);

    const unavailableWithNumber = validSummary();
    Object.assign(salesLine(unavailableWithNumber, "sales.cogs"), { status: "unavailable", errorCode: "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE" });
    expect(issuesOf(unavailableWithNumber).some((issue) => issue.endsWith("unavailable is never a number"))).toBe(true);

    const unavailableWithoutReason = validSummary();
    Object.assign(salesLine(unavailableWithoutReason, "sales.cogs"), { status: "unavailable", amount: null });
    expect(issuesOf(unavailableWithoutReason).some((issue) => issue.endsWith("an unavailable line says why"))).toBe(true);

    const unavailable = validSummary();
    Object.assign(salesLine(unavailable, "sales.cogs"), { status: "unavailable", amount: null, errorCode: "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE" });
    expect(issuesOf(unavailable)).toEqual([]);
  });

  it("refuses a hero figure or tile whose status and number disagree", () => {
    const hero = validSummary();
    hero.answer.kept = { amount: 0, status: "unavailable", errorCode: "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE" };
    expect(issuesOf(hero)).toContain("answer.kept.amount: unavailable is never a number");

    const tile = validSummary();
    tile.tiles.weOweNow.amount = null;
    expect(issuesOf(tile)).toContain("tiles.weOweNow.amount: recorded line needs an amount");
  });

  it("refuses a line key the section does not list, one from another section, and a repeated key", () => {
    const unknown = validSummary();
    unknown.sections.sales.lines.push(lineOf("sales.bogus", 1));
    expect(issuesOf(unknown)).toContain("sections.sales.lines.37.key: not a sales line key");

    const foreign = validSummary();
    foreign.sections.cash.lines.push(lineOf("sales.billed", 18_730));
    expect(issuesOf(foreign)).toContain("sections.cash.lines.16.key: not a cash line key");

    const repeated = validSummary();
    repeated.sections.pool.lines.push(lineOf("pool.closing", -910));
    expect(issuesOf(repeated)).toContain("sections.pool.lines.9.key: pool line key repeated");

    const badShape = validSummary();
    badShape.sections.sales.lines.push(lineOf("Sales.Billed", 1));
    expect(issuesOf(badShape).length).toBeGreaterThan(0);
  });

  it("shows no numbers for a section that failed or was skipped, and names its code", () => {
    const failedWithLines = validSummary();
    failedWithLines.sections.cash = { ...failedWithLines.sections.cash, status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT" };
    expect(issuesOf(failedWithLines)).toContain("sections.cash.lines: a failed or skipped section shows no lines");

    const skippedWithoutCode = validSummary();
    skippedWithoutCode.sections.points = { status: "skipped", lines: [] };
    expect(issuesOf(skippedWithoutCode)).toContain("sections.points.errorCode: a failed or skipped section names its error code");

    const failedTable = validSummary();
    failedTable.sections.vendors = { ...failedTable.sections.vendors, status: "error", errorCode: "DROPSHIP_FINANCE_SCHEMA_MISMATCH", lines: [] };
    expect(issuesOf(failedTable)).toContain("sections.vendors.top: a failed or skipped section shows no rows");

    const failedCleanly = validSummary();
    failedCleanly.sections.vendors = {
      ...failedCleanly.sections.vendors, status: "error", errorCode: "DROPSHIP_FINANCE_SCHEMA_MISMATCH", lines: [], top: [], others: null, total: null,
    };
    failedCleanly.sections.cash = { status: "skipped", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED", lines: [] };
    expect(issuesOf(failedCleanly)).toEqual([]);
  });

  it("ties the answer's state to its status", () => {
    const failedButKept = validSummary();
    failedButKept.answer.status = "error";
    failedButKept.answer.errorCode = "DROPSHIP_FINANCE_QUERY_TIMEOUT";
    expect(issuesOf(failedButKept)).toContain("answer.state: the answer is unavailable exactly when its section failed");

    const unavailableWithoutCode = validSummary();
    unavailableWithoutCode.answer.status = "error";
    unavailableWithoutCode.answer.state = "unavailable";
    expect(issuesOf(unavailableWithoutCode)).toContain("answer.errorCode: a failed answer names its error code");
  });

  it("refuses cents of each dollar that miss 100 and bar widths that miss 10000", () => {
    const cents = validSummary();
    cents.answer.centsOfEachDollar = { kept: 40, costOfGoods: 39, carrierLabels: 20, poolShare: 2 };
    expect(issuesOf(cents)).toContain("answer.centsOfEachDollar: the cents of each dollar add up to 100");

    const bar = validSummary();
    bar.answer.barBps = { kept: 2_072, costOfGoods: 2_009, carrierLabels: 1_033, poolShare: 80, waiting: 4_805 };
    expect(issuesOf(bar)).toContain("answer.barBps: the bar widths add up to 10000");

    const loss = validSummary();
    loss.answer.centsOfEachDollar = null;
    loss.answer.barBps = null;
    expect(issuesOf(loss)).toEqual([]);
  });

  it("needs every check exactly once", () => {
    const missing = validSummary();
    missing.checks = missing.checks.slice(1);
    expect(issuesOf(missing)).toContain("checks: Array must contain exactly 27 element(s)");

    const repeated = validSummary();
    repeated.checks[1] = checkOf("W1");
    expect(issuesOf(repeated)).toContain("checks.1.id: check key repeated");
  });

  it("refuses an amber dot on a line the page does not have", () => {
    const summary = validSummary();
    summary.checks[0].ownerLineKeys = ["tiles.weOweNow"];
    expect(issuesOf(summary).some((issue) => issue.startsWith("checks.0.ownerLineKeys.0"))).toBe(true);
  });

  it("refuses a working step citing an unknown line", () => {
    const summary = validSummary();
    summary.answer.workings[1].operands[0].lineKey = "sales.bogus";
    expect(issuesOf(summary)).toContain("answer.workings.1.operands.0.lineKey: not a known finance line key");
  });

  it("holds information lines to their own keys", () => {
    const summary = validSummary();
    summary.info[1].lines.push(lineOf("info.won_disputes.cash_returned", 10_300));
    expect(issuesOf(summary)).toContain("info.1.lines.2.key: not a pool_record line key");

    const repeated = validSummary();
    repeated.info.push(repeated.info[0]);
    expect(issuesOf(repeated)).toContain("info.2.key: info key repeated");
  });

  it("refuses a repeated note and a comparison for all time", () => {
    const notes = validSummary();
    notes.notes = ["card_fee_era", "card_fee_era"];
    expect(issuesOf(notes)).toContain("notes.1: note key repeated");

    const allTime = validSummary();
    allTime.period = { ...allTime.period, preset: "all", fromDate: null, startAt: null };
    expect(issuesOf(allTime)).toContain("comparePeriod: all time has nothing earlier to compare with");
    allTime.comparePeriod = null;
    expect(issuesOf(allTime)).toEqual([]);
  });

  it("refuses coverage that claims more done than there are", () => {
    const summary = validSummary();
    summary.answer.coverage = { done: 11, total: 10 };
    expect(issuesOf(summary)).toContain("answer.coverage: coverage done exceeds total");
  });

  it("refuses mills that are not integer text and a failure code with spaces", () => {
    const mills = validSummary();
    mills.sections.products.top[0].costOfGoodsMills = "3142.50";
    expect(issuesOf(mills).some((issue) => issue.startsWith("sections.products.top.0.costOfGoodsMills"))).toBe(true);

    const code = validSummary();
    const failed = code.sections.cash.lines.find((candidate) => candidate.key === "cash.memo.failed");
    if (failed) failed.failureCode = "R01 insufficient funds";
    expect(issuesOf(code).some((issue) => issue.endsWith("failureCode: Invalid"))).toBe(true);
  });

  it("refuses another contract version or time zone", () => {
    expect(issuesOf({ ...validSummary(), contractVersion: 2 }).length).toBeGreaterThan(0);
    expect(issuesOf({ ...validSummary(), timeZone: "UTC" }).length).toBeGreaterThan(0);
  });

  it("carries vendor aggregate rows without a vendor id", () => {
    const summary = validSummary();
    summary.sections.vendors.others = { ...VENDOR_FIGURES_ZERO, vendors: 4 };
    expect(issuesOf(summary)).toEqual([]);
  });
});

describe("financeSummaryQuerySchema", () => {
  it("defaults to this month so far with the comparison on", () => {
    expect(financeSummaryQuerySchema.parse({})).toEqual({ period: "mtd", compare: "on" });
  });

  it("reads a vendor id and a custom range", () => {
    expect(financeSummaryQuerySchema.parse({ period: "custom", from: "2026-11-01", to: "2026-11-01", compare: "off", vendorId: "12" }))
      .toEqual({ period: "custom", from: "2026-11-01", to: "2026-11-01", compare: "off", vendorId: 12 });
  });

  it("needs from and to with custom, and only with custom", () => {
    expect(financeSummaryQuerySchema.safeParse({ period: "custom", from: "2026-10-01" }).success).toBe(false);
    expect(financeSummaryQuerySchema.safeParse({ period: "mtd", from: "2026-10-01", to: "2026-10-05" }).success).toBe(false);
    expect(financeSummaryQuerySchema.safeParse({ to: "2026-10-05" }).success).toBe(false);
  });

  it.each(["abc", "0", "012", "-1", "1.5", "2147483648", "12345678901"])("refuses vendorId %j", (vendorId) => {
    expect(financeSummaryQuerySchema.safeParse({ vendorId }).success).toBe(false);
  });

  it("accepts the largest int4 vendor id", () => {
    expect(financeSummaryQuerySchema.parse({ vendorId: "2147483647" }).vendorId).toBe(2_147_483_647);
  });

  it("refuses unknown presets, unknown keys, repeated parameters and malformed dates", () => {
    expect(financeSummaryQuerySchema.safeParse({ period: "this-month" }).success).toBe(false);
    expect(financeSummaryQuerySchema.safeParse({ metric: "sales.billed" }).success).toBe(false);
    expect(financeSummaryQuerySchema.safeParse({ period: ["mtd", "ytd"] }).success).toBe(false);
    expect(financeSummaryQuerySchema.safeParse({ compare: "maybe" }).success).toBe(false);
    expect(financeSummaryQuerySchema.safeParse({ period: "custom", from: "2026-10-1", to: "2026-10-05" }).success).toBe(false);
  });
});

describe("financeErrorEnvelopeSchema", () => {
  it("parses the envelope and keeps extra context", () => {
    const envelope = {
      error: { code: "DROPSHIP_FINANCE_BUSY", message: "Program finance is busy.", context: { classification: "transient", waitedMs: 2_000 } },
    };
    expect(financeErrorEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it("refuses a code outside the finance namespace and an unknown classification", () => {
    expect(financeErrorEnvelopeSchema.safeParse({ error: { code: "DROPSHIP_WALLET_BUSY", message: "x", context: { classification: "transient" } } }).success).toBe(false);
    expect(financeErrorEnvelopeSchema.safeParse({ error: { code: "DROPSHIP_FINANCE_BUSY", message: "x", context: { classification: "maybe" } } }).success).toBe(false);
  });
});

describe("closed key lists", () => {
  it("gives every section line key the line key shape and its section's prefix", () => {
    for (const section of FINANCE_SECTION_KEYS) {
      for (const key of FINANCE_SECTION_LINE_KEYS[section]) {
        expect(key).toMatch(LINE_KEY_PATTERN);
        expect(key.startsWith(`${section}.`)).toBe(true);
      }
    }
  });

  it("gives information lines and anchors the line key shape", () => {
    for (const key of [...Object.values(FINANCE_INFO_LINE_KEYS).flat(), ...FINANCE_ANCHOR_KEYS]) {
      expect(key).toMatch(LINE_KEY_PATTERN);
    }
  });

  it("never lists a key twice across the page", () => {
    expect(new Set(FINANCE_LINE_KEYS).size).toBe(FINANCE_LINE_KEYS.length);
    expect(FINANCE_LINE_KEYS.every(isFinanceLineKey)).toBe(true);
    expect(isFinanceLineKey("sales.bogus")).toBe(false);
  });

  it("builds a waiting line per waiting reason and a never-charged line per kind", () => {
    for (const reason of FINANCE_WAITING_REASONS) expect(FINANCE_SECTION_LINE_KEYS.sales).toContain(`sales.waiting.${reason}`);
    for (const kind of FINANCE_NEVER_CHARGED_KINDS) expect(FINANCE_SECTION_LINE_KEYS.sales).toContain(`sales.never_charged.${kind}`);
  });

  it("names a sheet per check and no metric twice", () => {
    expect(new Set(FINANCE_METRIC_KEYS).size).toBe(FINANCE_METRIC_KEYS.length);
    for (const id of FINANCE_CHECK_IDS) expect(FINANCE_METRIC_KEYS).toContain(`check.${id}`);
    expect(FINANCE_METRIC_KEYS).toHaveLength(32 + FINANCE_CHECK_IDS.length);
  });

  it("keeps each section within the per-section line bound", () => {
    for (const section of FINANCE_SECTION_KEYS) expect(FINANCE_SECTION_LINE_KEYS[section].length).toBeLessThanOrEqual(60);
  });
});
