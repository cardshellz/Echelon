/**
 * The Program finance summary for the contract §6.4 seeded program
 * (scratchpad finance-contract.md §6.4): "This month so far" on
 * 2026-10-05 at 9:14 AM Eastern, all vendors, compared with Sep 1 – 5.
 *
 * Every number is the one the §6.4 integration test asserts, and every
 * identity in it ties (bar = billed, kept = KO + FE − RC, the walks close,
 * the tables add up with their rounding rows). It is valid against
 * financeSummarySchema, which `financeSummaryFixture()` checks on every call,
 * so a contract change that breaks it fails loudly in every test using it.
 *
 * Shared by the model and panel tests and by the browser journey's harness,
 * which can serve `financeSummaryFixture()` as the JSON body as is: instants
 * are ISO text already.
 *
 * Each call returns a fresh object, so a test may mutate its copy.
 */

import type { z } from "zod";
import {
  FINANCE_CHECK_IDS,
  FINANCE_CONTRACT_VERSION,
  FINANCE_TIME_ZONE,
  financeLineSchema,
  financeSummarySchema,
  type FinanceCheckId,
  type FinanceSummary,
  type FinanceSummaryInput,
} from "@shared/dropship/program-finance";
import { FINANCE_CHECK_DEFINITIONS } from "@shared/dropship/program-finance-definitions";

type LineInput = z.input<typeof financeLineSchema>;
type CheckInput = FinanceSummaryInput["checks"][number];
type ProductRowInput = FinanceSummaryInput["sections"]["products"]["top"][number];
type VendorRowInput = FinanceSummaryInput["sections"]["vendors"]["top"][number];

/** The injected clock of the §6.4 run: Oct 5, 2026, 9:14 AM Eastern. */
export const FINANCE_FIXTURE_GENERATED_AT = "2026-10-05T13:14:00.000Z";
/** The checks the §6.4 seed leaves needing a look; the other 23 are fine. */
export const FINANCE_FIXTURE_CHECKS_NEEDING_A_LOOK: readonly FinanceCheckId[] = Object.freeze(["D6", "K2", "N1", "N2"]);

export function financeFixtureLine(key: string, amount: number | null, extra: Partial<LineInput> = {}): LineInput {
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

export function financeFixtureCheck(id: FinanceCheckId, overrides: Partial<CheckInput> = {}): CheckInput {
  const definition = FINANCE_CHECK_DEFINITIONS[id];
  const needsALook = FINANCE_FIXTURE_CHECKS_NEEDING_A_LOOK.includes(id);
  return {
    id,
    group: definition.group,
    result: needsALook ? "needs_a_look" : "fine",
    scope: definition.scope,
    examined: 10,
    exceptions: needsALook ? 1 : 0,
    difference: null,
    ownerLineKeys: [...definition.ownerLineKeys],
    ...overrides,
  };
}

/** The §6.4 summary as the server hands it to financeSummarySchema. */
export function financeSummaryFixtureInput(): FinanceSummaryInput {
  const line = financeFixtureLine;
  return {
    contractVersion: FINANCE_CONTRACT_VERSION,
    generatedAt: FINANCE_FIXTURE_GENERATED_AT,
    timeZone: FINANCE_TIME_ZONE,
    scope: { vendor: null },
    period: {
      preset: "mtd", fromDate: "2026-10-01", toDate: "2026-10-05",
      startAt: "2026-10-01T04:00:00.000Z", endAt: FINANCE_FIXTURE_GENERATED_AT, endsNow: true, clampedToMonthEnd: false,
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
      // Exactly what the server's answerWorkings emits for §6.4 (asserted in
      // dropship-finance.integration.test.ts "answer workings").
      workings: [
        { step: 1, textKey: "working.two_clocks", operands: [], result: null },
        {
          step: 2, textKey: "sales.billed_fc", result: 9_730, opensMetric: "sales.billed",
          operands: [
            { lineKey: "sales.billed", amount: 18_730, unit: "cents", operator: "none" },
            { lineKey: "sales.waiting", amount: 9_000, unit: "cents", operator: "minus" },
          ],
        },
        {
          step: 3, textKey: "sales.kept_orders", result: 3_881, opensMetric: "sales.kept_orders",
          operands: [
            { lineKey: "sales.billed_fc", amount: 9_730, unit: "cents", operator: "none" },
            { lineKey: "sales.cogs", amount: 3_764, unit: "cents", operator: "minus" },
            { lineKey: "sales.labels", amount: 1_935, unit: "cents", operator: "minus" },
            { lineKey: "sales.pool_fc", amount: 150, unit: "cents", operator: "minus" },
          ],
        },
        { step: 4, textKey: "working.cogs_basis", operands: [], result: null },
        {
          step: 5, textKey: "sales.kept", result: 2_641,
          operands: [
            { lineKey: "sales.kept_orders", amount: 3_881, unit: "cents", operator: "none" },
            { lineKey: "sales.fees", amount: 760, unit: "cents", operator: "plus" },
            { lineKey: "sales.return_credits_cs", amount: 2_000, unit: "cents", operator: "minus" },
          ],
        },
        {
          step: 6, textKey: "working.margin_share", result: null,
          operands: [
            { lineKey: "sales.kept_orders", amount: 3_881, unit: "cents", operator: "none" },
            { lineKey: "sales.billed_fc", amount: 9_730, unit: "cents", operator: "none" },
          ],
        },
        {
          step: 7, textKey: "working.margin_prior", result: null,
          operands: [
            { lineKey: "sales.kept_orders", amount: 1_050, unit: "cents", operator: "none" },
            { lineKey: "sales.billed_fc", amount: 2_600, unit: "cents", operator: "none" },
          ],
        },
        { step: 8, textKey: "working.margin_change", operands: [], result: null },
        { step: 9, textKey: "working.not_included", operands: [], result: null },
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
          line("sales.billed", 18_730, { count: 10, opensMetric: "sales.billed" }),
          line("sales.billed.product", 13_320),
          line("sales.billed.shipping", 5_410),
          line("sales.billed.carrier_estimate", 4_080),
          line("sales.billed.markup", 930),
          line("sales.billed.pool_share", 400),
          line("sales.billed.paid_from_wallets", 16_530),
          line("sales.billed.paid_with_points", 2_200),
          line("sales.waiting", 9_000, { operator: "minus", count: 7 }),
          line("sales.waiting.cancelled_in_oms", 800, { count: 1 }),
          line("sales.waiting.not_shipped", 1_300, { count: 1 }),
          line("sales.waiting.partly_shipped", 1_500, { count: 1 }),
          line("sales.waiting.shared_label", 3_300, { count: 2 }),
          line("sales.waiting.label_missing", 1_000, { count: 1 }),
          line("sales.waiting.item_cost_missing", 1_100, { count: 1 }),
          line("sales.billed_fc", 9_730, { operator: "equals", count: 3 }),
          line("sales.cogs", 3_764, { operator: "minus" }),
          line("sales.labels", 1_935, { operator: "minus" }),
          line("sales.labels.replacement", 250, { depth: "every_line" }),
          line("sales.pool_fc", 150, { operator: "minus" }),
          line("sales.packaging", null, { status: "not_recorded", reasonKey: "packaging_not_saved" }),
          line("sales.kept_orders", 3_881, { operator: "equals", percentTenths: 399, percentBps: 3_989 }),
          line("sales.kept_orders.on_products", 3_756, { percentTenths: 499, percentBps: 4_995 }),
          line("sales.kept_orders.on_shipping", 125, { percentTenths: 61, percentBps: 607 }),
          line("sales.fees", 760, { operator: "plus", datedBy: "posted" }),
          line("sales.fees.advance", 10, { datedBy: "posted" }),
          line("sales.fees.card", 300, { datedBy: "settled", depth: "every_line" }),
          line("sales.fees.returns", 450, { datedBy: "posted" }),
          line("sales.return_credits_cs", 2_000, { operator: "minus", datedBy: "posted" }),
          line("sales.kept", 2_641, { operator: "equals" }),
          line("sales.memo.points_used", 2_200),
          line("sales.memo.staff_credits", 2_500, { datedBy: "settled" }),
          line("sales.memo.pool_credits", 1_700, { datedBy: "posted" }),
          line("sales.memo.stripe_fees", null, { status: "not_recorded", reasonKey: "stripe_fees_not_saved", datedBy: "settled" }),
          line("sales.memo.overheads", null, { status: "not_recorded", reasonKey: "overheads_not_on_page" }),
          line("sales.buyer_paid", 23_993, { status: "partial", reasonKey: "buyer_total_unknown", count: 1 }),
          line("sales.never_charged", 3, { unit: "count", count: 3, datedBy: "received" }),
          line("sales.never_charged.waiting_for_payment", 1, { unit: "count", datedBy: "received" }),
          line("sales.never_charged.payment_time_ran_out", 1, { unit: "count", datedBy: "received" }),
          line("sales.never_charged.rejected", 1, { unit: "count", datedBy: "received" }),
          line("sales.never_charged.would_have_charged", 2_500, { datedBy: "received" }),
          line("sales.label_coverage", 7, { unit: "count", coverage: { done: 7, total: 8 } }),
        ],
      },
      products: {
        status: "ok",
        lines: [
          line("products.billed", 13_320),
          line("products.packs", 21, { unit: "count" }),
          line("products.pieces", 950, { unit: "count", status: "partial", reasonKey: "pieces_not_recorded" }),
          line("products.lines_without_pieces", 1, { unit: "count" }),
          line("products.count", 3, { unit: "count" }),
          line("products.packs_fully_costed", 11, { unit: "count", coverage: { done: 11, total: 21 } }),
          line("products.packs_shipped", 18, { unit: "count", coverage: { done: 18, total: 21 } }),
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
          line("cash.ach", 50_000, { count: 1, datedBy: "settled" }),
          line("cash.card", 10_300, { count: 1, datedBy: "settled" }),
          line("cash.card.fees", 300, { datedBy: "settled" }),
          line("cash.usdc", 25_000, { count: 1, datedBy: "settled" }),
          line("cash.usdc.chain_watcher", 25_000, { datedBy: "settled" }),
          line("cash.collection", 5_000, { count: 1, datedBy: "settled" }),
          line("cash.received_deposits", 90_300, { operator: "equals", count: 4, datedBy: "settled" }),
          line("cash.pulled_back", 12_300, { operator: "minus", count: 2, datedBy: "posted" }),
          line("cash.won_back", 10_300, { operator: "plus", count: 1, datedBy: "posted" }),
          line("cash.received", 88_300, {
            operator: "equals", datedBy: "settled",
            workings: [
              { step: 1, textKey: "cash.received_deposits", operands: [], result: 90_300, opensMetric: "cash.deposits" },
              {
                step: 2, textKey: "cash.received", result: 88_300,
                operands: [
                  { lineKey: "cash.received_deposits", amount: 90_300, unit: "cents", operator: "none" },
                  { lineKey: "cash.pulled_back", amount: 12_300, unit: "cents", operator: "minus" },
                  { lineKey: "cash.won_back", amount: 10_300, unit: "cents", operator: "plus" },
                ],
              },
            ],
          }),
          line("cash.memo.on_the_way", 19_000, { count: 2, datedBy: "now" }),
          line("cash.memo.stuck", 4_000, { count: 1, datedBy: "now" }),
          line("cash.memo.failed", 7_000, { count: 1, datedBy: "posted", failureCode: "R01" }),
          line("cash.memo.not_won_back", 2_000, { count: 1, datedBy: "posted" }),
          line("cash.memo.staff_credits", 2_500, { count: 1, datedBy: "settled" }),
          line("cash.memo.stripe_fees", null, { status: "not_recorded", reasonKey: "stripe_fees_not_saved", datedBy: "settled" }),
          line("cash.memo.usdc_moved_out", null, { status: "not_recorded", reasonKey: "usdc_moves_not_saved", datedBy: "settled" }),
        ],
      },
      returns: {
        status: "ok",
        lines: [
          line("returns.credited", 3_700, { count: 4, datedBy: "posted" }),
          line("returns.credits_cs", 2_000, { count: 2, datedBy: "posted" }),
          line("returns.credits_cs.inspected", 1_200, { datedBy: "posted" }),
          line("returns.credits_cs.return_case", 800, { datedBy: "posted" }),
          line("returns.credits_pool", 1_700, { count: 2, datedBy: "posted" }),
          line("returns.credits_pool.no_inspection", 1_100, { datedBy: "posted" }),
          line("returns.credits_pool.inspection_fault", 600, { datedBy: "posted" }),
          line("returns.fees", 450, { operator: "minus", datedBy: "posted" }),
          line("returns.fees.restocking", 350, { datedBy: "posted" }),
          line("returns.fees.processing", 100, { datedBy: "posted" }),
          line("returns.net", 3_250, { operator: "equals", datedBy: "posted" }),
          line("returns.staff_credits", 2_500, { count: 1, datedBy: "settled" }),
          line("returns.memo.order_refunds", null, { status: "not_recorded", reasonKey: "no_refund_path", datedBy: "posted" }),
          line("returns.memo.restocked_value", null, { status: "not_recorded", reasonKey: "restocked_value_not_saved", datedBy: "posted" }),
          line("returns.memo.return_label_cost", null, { status: "not_recorded", reasonKey: "return_label_cost_not_saved", datedBy: "posted" }),
        ],
      },
      owed: {
        status: "ok",
        lines: [
          line("owed.we_owe", 381_110, { count: 2, datedBy: "now" }),
          line("owed.they_owe", 1_250, { count: 1, datedBy: "now" }),
          line("owed.on_the_way", 19_000, { count: 2, datedBy: "now" }),
          line("owed.wallets", 3, { unit: "count", datedBy: "now" }),
          line("owed.history_matches", 0, { coverage: { done: 3, total: 3 }, datedBy: "now" }),
          line("owed.walk.opening", 302_650, { datedBy: "settled" }),
          line("owed.walk.deposits", 90_000, { operator: "plus", datedBy: "settled" }),
          line("owed.walk.staff_credits", 2_500, { operator: "plus", datedBy: "settled" }),
          line("owed.walk.return_credits_cs", 2_000, { operator: "plus", datedBy: "posted" }),
          line("owed.walk.return_credits_pool", 1_700, { operator: "plus", datedBy: "posted" }),
          line("owed.walk.disputes_won", 10_000, { operator: "plus", datedBy: "posted" }),
          line("owed.walk.orders", 16_530, { operator: "minus", datedBy: "posted" }),
          line("owed.walk.advance_fees", 10, { operator: "minus", datedBy: "posted" }),
          line("owed.walk.return_fees", 450, { operator: "minus", datedBy: "posted" }),
          line("owed.walk.disputes_taken", 12_000, { operator: "minus", datedBy: "posted" }),
          line("owed.walk.closing", 379_860, { operator: "equals", datedBy: "now" }),
          line("owed.walk.we_owe", 381_110, { datedBy: "now" }),
          line("owed.walk.they_owe", 1_250, { datedBy: "now" }),
        ],
      },
      points: {
        status: "ok",
        lines: [
          line("points.opening", 3_080, { unit: "points", datedBy: "posted" }),
          line("points.given", 750, { unit: "points", operator: "plus", datedBy: "posted" }),
          line("points.given.bank", 500, { unit: "points", datedBy: "posted" }),
          line("points.given.usdc", 250, { unit: "points", datedBy: "posted" }),
          line("points.used", 2_200, { unit: "points", operator: "minus", datedBy: "posted" }),
          line("points.used.billed_value", 2_200, { datedBy: "posted" }),
          line("points.expired", 80, { unit: "points", operator: "minus", datedBy: "posted" }),
          line("points.taken_back", 20, { unit: "points", operator: "minus", datedBy: "posted" }),
          line("points.held", 1_530, { unit: "points", operator: "equals", datedBy: "now" }),
          line("points.held_now", 1_530, { unit: "points", datedBy: "now" }),
          line("points.memo.from_cash", 0, { datedBy: "posted" }),
          line("points.expiry.days_31_to_90", 250, { unit: "points", datedBy: "now" }),
          line("points.expiry.never", 1_280, { unit: "points", datedBy: "now" }),
        ],
      },
      pool: {
        status: "ok",
        lines: [
          line("pool.opening", 90, { datedBy: "posted" }),
          line("pool.set_aside", 400, { operator: "plus" }),
          line("pool.paid_out", 1_700, { operator: "minus", count: 2, datedBy: "posted" }),
          line("pool.paid_out.no_inspection", 1_100, { datedBy: "posted" }),
          line("pool.paid_out.inspection_fault", 600, { datedBy: "posted" }),
          line("pool.topped_up", 300, { operator: "plus", datedBy: "posted" }),
          line("pool.closing", -910, { operator: "equals", datedBy: "now" }),
          line("pool.claims", 900, { count: 1, datedBy: "posted" }),
          line("pool.record", -800, { datedBy: "posted" }),
        ],
      },
      vendors: {
        status: "ok",
        lines: [line("vendors.ordered", 2, { unit: "count" }), line("vendors.wallets", 3, { unit: "count", datedBy: "now" })],
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
    checks: FINANCE_CHECK_IDS.map((id) => financeFixtureCheck(id)),
    info: [
      {
        key: "won_disputes", status: "recorded",
        lines: [
          line("info.won_disputes.cash_returned", 10_300, { datedBy: "posted" }),
          line("info.won_disputes.wallet_restored", 10_000, { datedBy: "posted" }),
          line("info.won_disputes.card_fee_part", 300, { datedBy: "posted" }),
          line("info.won_disputes.points_from_cash", 0, { datedBy: "posted" }),
        ],
      },
      {
        key: "pool_record", status: "recorded",
        lines: [line("info.pool_record.recorded", -800, { datedBy: "posted" }), line("info.pool_record.worked_out", -910, { datedBy: "now" })],
      },
    ],
    notes: [],
  };
}

/** The §6.4 summary as the page receives it (parsed by the shared contract). */
export function financeSummaryFixture(): FinanceSummary {
  return parseFinanceFixture(financeSummaryFixtureInput());
}

/** Parses a (possibly mutated) fixture, naming every contract issue when it no longer fits. */
export function parseFinanceFixture(input: FinanceSummaryInput): FinanceSummary {
  const parsed = financeSummarySchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`the finance summary fixture breaks the contract:\n${issues.join("\n")}`);
  }
  return parsed.data;
}
