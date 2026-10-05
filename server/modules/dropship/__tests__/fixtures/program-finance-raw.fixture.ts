/**
 * The contract §6.4 seeded program as the raw aggregates its SQL returns,
 * written out by hand from the §6.4 tables (orders A–K, H, P1; the V12, V13
 * and V14 ledgers; pool, claims and intakes). The expected numbers in the
 * statement test come from the contract's own list, worked out
 * independently by scratchpad/f3/fixture.py and ledger.py.
 *
 * Clock 2026-10-05T13:14:00Z; "this month so far", compared with
 * Sep 1 – 5 (to 9:14 AM). Every builder returns a fresh object, so a test
 * may change one field without touching another test's fixture.
 */

import type { FinanceVendorName } from "../../../../../shared/dropship/program-finance";
import { resolveFinancePeriod } from "../../domain/program-finance-period";
import {
  FINANCE_TABLES,
  type FinanceRawAggregates,
  type FinanceRawCheckCounts,
  type FinanceRawChecks,
  type FinanceRawLedgerGroup,
  type FinanceRawOrderTotals,
  type FinanceRawResult,
  type FinanceRawTables,
  type FinanceRawVendorRow,
  type FinanceSqlCheckId,
} from "../../domain/program-finance-raw";
import type { FinanceSummaryContext } from "../../domain/program-finance-statement";

export const FINANCE_FIXTURE_NOW = new Date("2026-10-05T13:14:00.000Z");
export const FINANCE_FIXTURE_TIME_ZONE = "America/New_York";

const b = (value: number | string) => BigInt(value);
export const ZERO = b(0);

export function ok<T>(data: T): FinanceRawResult<T> {
  return { status: "ok", data };
}

export function allTables(): FinanceRawTables {
  return Object.fromEntries(FINANCE_TABLES.map((table) => [table.key, true])) as FinanceRawTables;
}

export function zeroOrderTotals(): FinanceRawOrderTotals {
  return {
    orders: ZERO, fcOrders: ZERO, billed: ZERO, billedFc: ZERO, productBilled: ZERO, productBilledFc: ZERO,
    shippingBilled: ZERO, shippingNetPoolFc: ZERO, quoteBase: ZERO, quoteMarkup: ZERO, quoteDunnage: ZERO,
    ordersWithoutQuote: ZERO, poolAll: ZERO, poolFc: ZERO, paidCash: ZERO, paidPoints: ZERO, cogsMillsFc: ZERO,
    labelsFc: ZERO, replacementLabelsFc: ZERO, coverageLabels: ZERO, coverageLabelsCosted: ZERO,
    buyerPaid: ZERO, buyerUnknown: ZERO,
  };
}

/** A Q4 group with every amount zero; pass only what the group holds. */
export function ledgerGroup(
  key: Pick<FinanceRawLedgerGroup, "vendorId" | "type" | "status"> & Partial<FinanceRawLedgerGroup>,
): FinanceRawLedgerGroup {
  return {
    referenceType: null, cashLine: null, rewardsRail: null, autoReload: null, autoReloadReason: null, chainWatcher: null,
    nP: ZERO, amountP: ZERO, chargedP: ZERO, cardFeeP: ZERO, disputeP: ZERO, disputeMissingP: ZERO, fromCashP: ZERO,
    malformedP: ZERO, nCmp: ZERO, amountCmp: ZERO, chargedCmp: ZERO, disputeCmp: ZERO, amountBeforeStart: ZERO,
    amountBeforeEnd: ZERO, nPendingNow: ZERO, amountPendingNow: ZERO, nStale: ZERO, amountStale: ZERO,
    amountPendingAtEnd: ZERO, nFailedP: ZERO, amountFailedP: ZERO, failedWithoutTime: ZERO,
    ...key,
  };
}

export function checkCounts(examined: number, exceptions = 0, difference: number | null = null): FinanceRawResult<FinanceRawCheckCounts> {
  return ok({ examined: b(examined), exceptions: b(exceptions), difference: difference === null ? null : b(difference) });
}

/** §6.4: D6, K2, N1 and N2 need a look; every other SQL check is fine. */
export function fixtureChecks(): FinanceRawChecks {
  const counts: Record<FinanceSqlCheckId, FinanceRawResult<FinanceRawCheckCounts>> = {
    W1: checkCounts(3), W2: checkCounts(3), W3: checkCounts(3), W4: checkCounts(3),
    O1: checkCounts(10), O2: checkCounts(10), O3: checkCounts(10), O4: checkCounts(10), O5: checkCounts(10), O6: checkCounts(10),
    D1: checkCounts(1), D2: checkCounts(3), D3: checkCounts(2), D4: checkCounts(1), D5: checkCounts(1),
    // V14's ACH 4,000 pending since 09-20.
    D6: checkCounts(3, 1),
    D7: checkCounts(8),
    K1: checkCounts(10),
    // J shipped with no cost row.
    K2: checkCounts(10, 1),
    K3: checkCounts(0),
    R1: checkCounts(3), R2: checkCounts(1),
    // K cancelled in OMS after the vendor was charged.
    N1: checkCounts(1, 1),
    // The expired hold's OMS order is still pending/pending.
    N2: checkCounts(1, 1),
    N3: checkCounts(40),
  };
  return counts;
}

/** Q1 over Oct 1 – 5: A, B, C fully costed; D, E, F, G, I, J, K waiting. H (Sep 30 23:30 ET) is outside. */
export function fixtureOrderTotals(): FinanceRawOrderTotals {
  return {
    orders: b(10), fcOrders: b(3),
    billed: b(18_730), billedFc: b(9_730),
    productBilled: b(13_320), productBilledFc: b(7_520),
    shippingBilled: b(5_410),
    // (910 − 50) + (600 − 50) + (700 − 50)
    shippingNetPoolFc: b(2_060),
    quoteBase: b(4_080), quoteMarkup: b(930), quoteDunnage: ZERO, ordersWithoutQuote: ZERO,
    poolAll: b(400), poolFc: b(150),
    paidCash: b(16_530), paidPoints: b(2_200),
    // A 4×47,400 + 2×47,300; B 2×31,075; C 10,050 + 2×10,000
    cogsMillsFc: b(376_400),
    // A 685 + replacement 250, B 520, C 480
    labelsFc: b(1_935), replacementLabelsFc: b(250),
    // A1, A2, B1, C1, ss:9001 (D and E), G1, I1 (no cost), J1
    coverageLabels: b(8), coverageLabelsCosted: b(7),
    buyerPaid: b(23_993), buyerUnknown: b(1),
  };
}

/** Q1c over Sep 1 – 5 (to 9:14 AM): P1 alone. */
export function fixtureCompareTotals(): FinanceRawOrderTotals {
  return {
    ...zeroOrderTotals(),
    orders: b(1), fcOrders: b(1), billed: b(2_600), billedFc: b(2_600),
    productBilled: b(2_000), productBilledFc: b(2_000), shippingBilled: b(600), shippingNetPoolFc: b(550),
    quoteBase: b(450), quoteMarkup: b(100), poolAll: b(50), poolFc: b(50), paidCash: b(2_600),
    cogsMillsFc: b(100_000), labelsFc: b(500), coverageLabels: b(1), coverageLabelsCosted: b(1),
  };
}

const V12 = 12;
const V13 = 13;
const V14 = 14;

/** Q4 over the §6.4 ledgers, one group per (vendor, type, status, reference type, way paid, …). */
export function fixtureLedgerGroups(): FinanceRawLedgerGroup[] {
  return [
    // V12: ACH 8,000 (08-01), 300,000 (09-02, in the compare window) and 50,000 (settled 10-01 12:00).
    ledgerGroup({ vendorId: V12, type: "funding", status: "settled", referenceType: "stripe_payment_intent", cashLine: "stripe_ach",
      nP: b(1), amountP: b(50_000), chargedP: b(50_000), nCmp: b(1), amountCmp: b(300_000), chargedCmp: b(300_000),
      amountBeforeStart: b(308_000), amountBeforeEnd: b(358_000) }),
    ledgerGroup({ vendorId: V12, type: "rewards_earned", status: "settled", referenceType: "wallet_funding_rewards", rewardsRail: "stripe_ach",
      nP: b(1), amountP: b(500), nCmp: b(1), amountCmp: b(3_000), amountBeforeStart: b(3_080), amountBeforeEnd: b(3_580) }),
    // P1 (compare window), H (10-01 03:30Z, before the start), then A, J, B, F.
    ledgerGroup({ vendorId: V12, type: "order_debit", status: "settled", referenceType: "order_intake",
      nP: b(4), amountP: b(-9_530), nCmp: b(1), amountCmp: b(-2_600), amountBeforeStart: b(-4_100), amountBeforeEnd: b(-13_630) }),
    ledgerGroup({ vendorId: V12, type: "rewards_expired", status: "settled", referenceType: "wallet_rewards_lot",
      nP: b(1), amountP: b(-80), amountBeforeEnd: b(-80) }),
    // Card 10,000 credited, 10,300 charged, 300 card fee.
    ledgerGroup({ vendorId: V12, type: "funding", status: "settled", referenceType: "stripe_payment_intent", cashLine: "stripe_card",
      nP: b(1), amountP: b(10_000), chargedP: b(10_300), cardFeeP: b(300), amountBeforeEnd: b(10_000) }),
    // A 400 and E 1,800 paid with points.
    ledgerGroup({ vendorId: V12, type: "rewards_spent", status: "settled", referenceType: "order_intake_rewards",
      nP: b(2), amountP: b(-2_200), amountBeforeEnd: b(-2_200) }),
    ledgerGroup({ vendorId: V12, type: "advance_fee", status: "settled", referenceType: "order_intake_advance_fee",
      nP: b(1), amountP: b(-10), amountBeforeEnd: b(-10) }),
    ledgerGroup({ vendorId: V12, type: "insurance_pool_credit", status: "settled", referenceType: "dropship_rma_no_inspection",
      nP: b(1), amountP: b(1_100), amountBeforeEnd: b(1_100) }),
    ledgerGroup({ vendorId: V12, type: "return_credit", status: "settled", referenceType: "dropship_rma",
      nP: b(1), amountP: b(1_200), amountBeforeEnd: b(1_200) }),
    ledgerGroup({ vendorId: V12, type: "return_fee", status: "settled", referenceType: "dropship_rma",
      nP: b(1), amountP: b(-300), amountBeforeEnd: b(-300) }),
    ledgerGroup({ vendorId: V12, type: "funding", status: "settled", referenceType: "admin_manual_wallet_credit", cashLine: "manual",
      nP: b(1), amountP: b(2_500), chargedP: b(2_500), amountBeforeEnd: b(2_500) }),
    // dp_1 (−10,000, disputed 10,300) and dp_2 (−2,000, disputed 2,000).
    ledgerGroup({ vendorId: V12, type: "funding_reversal", status: "settled", referenceType: "stripe_dispute",
      nP: b(2), amountP: b(-12_000), disputeP: b(12_300), amountBeforeEnd: b(-12_000) }),
    ledgerGroup({ vendorId: V12, type: "funding_reinstated", status: "settled", referenceType: "stripe_dispute_reinstated",
      nP: b(1), amountP: b(10_000), amountBeforeEnd: b(10_000) }),
    ledgerGroup({ vendorId: V12, type: "rewards_reversed", status: "settled", referenceType: "stripe_dispute",
      nP: b(1), amountP: b(-20), amountBeforeEnd: b(-20) }),
    // V13: G, K, I, C, D.
    ledgerGroup({ vendorId: V13, type: "order_debit", status: "settled", referenceType: "order_intake",
      nP: b(5), amountP: b(-7_000), amountBeforeEnd: b(-7_000) }),
    // ACH 7,000 failed 10-03 (R01).
    ledgerGroup({ vendorId: V13, type: "funding", status: "failed", referenceType: "stripe_payment_intent", cashLine: "stripe_ach",
      nFailedP: b(1), amountFailedP: b(7_000) }),
    // The retired weekly collection: no rail on the entry, stripe_ach on its funding method.
    ledgerGroup({ vendorId: V13, type: "funding", status: "settled", referenceType: "stripe_payment_intent", cashLine: "collection",
      nP: b(1), amountP: b(5_000), chargedP: b(5_000), amountBeforeEnd: b(5_000) }),
    ledgerGroup({ vendorId: V13, type: "funding", status: "settled", referenceType: "usdc_base_transaction", cashLine: "usdc_base", chainWatcher: true,
      nP: b(1), amountP: b(25_000), chargedP: b(25_000), amountBeforeEnd: b(25_000) }),
    ledgerGroup({ vendorId: V13, type: "rewards_earned", status: "settled", referenceType: "wallet_funding_rewards", rewardsRail: "usdc_base",
      nP: b(1), amountP: b(250), amountBeforeEnd: b(250) }),
    // I: carrier fault found on inspection, paid by the pool.
    ledgerGroup({ vendorId: V13, type: "insurance_pool_credit", status: "settled", referenceType: "dropship_rma",
      nP: b(1), amountP: b(600), amountBeforeEnd: b(600) }),
    // ACH 15,000 on the way since 10-04.
    ledgerGroup({ vendorId: V13, type: "funding", status: "pending", referenceType: "stripe_payment_intent", cashLine: "stripe_ach",
      nPendingNow: b(1), amountPendingNow: b(15_000), amountPendingAtEnd: b(15_000) }),
    ledgerGroup({ vendorId: V13, type: "return_credit", status: "settled", referenceType: "return_case_vendor_settlement",
      nP: b(1), amountP: b(800), amountBeforeEnd: b(800) }),
    ledgerGroup({ vendorId: V13, type: "return_fee", status: "settled", referenceType: "return_case_vendor_settlement",
      nP: b(1), amountP: b(-150), amountBeforeEnd: b(-150) }),
    // V14: a return fee on 08-20 and ACH 4,000 on the way since 09-20 (stuck).
    ledgerGroup({ vendorId: V14, type: "return_fee", status: "settled", referenceType: "dropship_rma",
      amountBeforeStart: b(-1_250), amountBeforeEnd: b(-1_250) }),
    ledgerGroup({ vendorId: V14, type: "funding", status: "pending", referenceType: "stripe_payment_intent", cashLine: "stripe_ach",
      nPendingNow: b(1), amountPendingNow: b(4_000), nStale: b(1), amountStale: b(4_000), amountPendingAtEnd: b(4_000) }),
  ];
}

export function fixtureVendorRows(): FinanceRawVendorRow[] {
  return [
    { vendorId: V12, businessName: "Acme TCG", contactName: "Ada", status: "active", orders: b(5), billed: b(11_730), waiting: b(3),
      billedFc: b(7_530), cogsMillsFc: b(346_350), labelsFc: b(1_455), poolFc: b(100), fees: b(610), creditsCs: b(1_200),
      creditsAll: b(2_300), cashIn: b(60_300), available: b(356_860), pending: ZERO, points: b(1_280) },
    { vendorId: V13, businessName: "PackRat", contactName: null, status: "active", orders: b(5), billed: b(7_000), waiting: b(4),
      billedFc: b(2_200), cogsMillsFc: b(30_050), labelsFc: b(480), poolFc: b(50), fees: b(150), creditsCs: b(800),
      creditsAll: b(1_400), cashIn: b(30_000), available: b(24_250), pending: b(15_000), points: b(250) },
    { vendorId: V14, businessName: null, contactName: "  ", status: "active", orders: ZERO, billed: ZERO, waiting: ZERO,
      billedFc: ZERO, cogsMillsFc: ZERO, labelsFc: ZERO, poolFc: ZERO, fees: ZERO, creditsCs: ZERO,
      creditsAll: ZERO, cashIn: ZERO, available: b(-1_250), pending: b(4_000), points: ZERO },
  ];
}

/** The §6.4 summary snapshot for mtd at FINANCE_FIXTURE_NOW, all vendors. */
export function fixtureRaw(): FinanceRawAggregates {
  return {
    tables: allTables(),
    bounds: {
      startAt: new Date("2026-10-01T04:00:00.000Z"),
      endAt: FINANCE_FIXTURE_NOW,
      compareStartAt: new Date("2026-09-01T04:00:00.000Z"),
      compareEndAt: new Date("2026-09-05T13:14:00.000Z"),
    },
    orders: ok({
      totals: fixtureOrderTotals(),
      byReason: [
        { reason: "cancelled_in_oms", orders: b(1), billed: b(800) },
        { reason: "not_shipped", orders: b(1), billed: b(1_300) },
        { reason: "partly_shipped", orders: b(1), billed: b(1_500) },
        { reason: "shared_label", orders: b(2), billed: b(3_300) },
        { reason: "label_missing", orders: b(1), billed: b(1_000) },
        { reason: "item_cost_missing", orders: b(1), billed: b(1_100) },
      ],
    }),
    compareOrders: ok({ totals: fixtureCompareTotals(), byReason: [] }),
    products: ok({
      totals: {
        packs: b(21), pieces: b(950), linesWithoutPieces: b(1), packsShipped: b(18), packsFc: b(11),
        billedProduct: b(13_320), billedProductFc: b(7_520), cogsMillsFc: b(376_400), unlinkedCogsMillsFc: ZERO,
      },
      groups: [
        { groupKey: "sku:MYSTERY-1", productVariantId: null, productId: null, productName: null, sizeName: null, sku: "MYSTERY-1",
          unitsPerVariant: null, packs: b(1), pieces: null, linesWithoutPieces: b(1), packsShipped: ZERO, packsFc: ZERO,
          billedProduct: b(500), billedProductFc: ZERO, cogsMillsFc: ZERO },
        { groupKey: "v:2", productVariantId: 2, productId: 2, productName: "Penny sleeves", sizeName: "100", sku: "PS-100",
          unitsPerVariant: b(100), packs: b(6), pieces: b(600), linesWithoutPieces: ZERO, packsShipped: b(5), packsFc: b(2),
          billedProduct: b(4_400), billedProductFc: b(2_000), cogsMillsFc: b(62_150) },
        { groupKey: "v:1", productVariantId: 1, productId: 1, productName: "Toploaders", sizeName: "3x4 · 25", sku: "TL-35-25",
          unitsPerVariant: b(25), packs: b(14), pieces: b(350), linesWithoutPieces: ZERO, packsShipped: b(13), packsFc: b(9),
          billedProduct: b(8_420), billedProductFc: b(5_520), cogsMillsFc: b(314_250) },
      ],
    }),
    neverCharged: ok([
      { kind: "waiting_for_payment", orders: b(1), buyerTotal: b(2_700), buyerUnknown: ZERO, wouldHaveCharged: b(2_500) },
      { kind: "payment_time_ran_out", orders: b(1), buyerTotal: b(1_200), buyerUnknown: ZERO, wouldHaveCharged: null },
      { kind: "rejected", orders: b(1), buyerTotal: ZERO, buyerUnknown: b(1), wouldHaveCharged: null },
    ]),
    ledger: ok({ groups: fixtureLedgerGroups(), firstFailureCode: "R01" }),
    disputes: ok({
      won: [{ inP: true, inCompare: false, reinstatedId: 21, restoredCents: b(10_000), reversalId: 20,
        disputedCents: b(10_300), creditCents: b(10_000), fromCashCents: ZERO }],
      notWonBack: { disputes: b(1), disputedCents: b(2_000) },
    }),
    returnFees: ok([
      { referenceType: "dropship_rma", feeRows: b(1), feeCents: b(300), restocking: b(200), processing: b(100), returnLabel: ZERO, splitNotRecorded: ZERO },
      { referenceType: "return_case_vendor_settlement", feeRows: b(1), feeCents: b(150), restocking: b(150), processing: ZERO, returnLabel: ZERO, splitNotRecorded: ZERO },
    ]),
    wallets: ok([
      { walletId: 1, vendorId: V12, available: b(356_860), pending: ZERO, points: b(1_280),
        expiresNext30Days: ZERO, expiresDays31To90: ZERO, expiresLater: ZERO, neverExpires: b(1_280) },
      { walletId: 2, vendorId: V13, available: b(24_250), pending: b(15_000), points: b(250),
        expiresNext30Days: ZERO, expiresDays31To90: b(250), expiresLater: ZERO, neverExpires: ZERO },
      { walletId: 3, vendorId: V14, available: b(-1_250), pending: b(4_000), points: ZERO,
        expiresNext30Days: ZERO, expiresDays31To90: ZERO, expiresLater: ZERO, neverExpires: ZERO },
    ]),
    pool: ok({
      // P1 50 + H 40 before Oct 1; the no-inspection payout row −1,100 and a 300 replenishment in the pool's own record.
      setAsideBeforeStart: b(90), setAsideP: b(400), toppedUpBeforeStart: ZERO, toppedUpP: b(300), recordedLedgerAtEnd: b(-800),
      claims: [{ status: "pending_approval", claims: b(1), asked: b(900) }],
    }),
    // The OMS rows of A–J (K is cancelled) plus the expired hold's pending OMS order of 1,000.
    bridge: ok({ omsRow: b(18_930), notAccepted: b(1_000), notAcceptedOrders: b(1) }),
    vendors: ok(fixtureVendorRows()),
    checks: fixtureChecks(),
  };
}

/** The service's context for fixtureRaw(): the resolved mtd windows at the fixture clock. */
export function fixtureContext(vendor: FinanceVendorName | null = null): FinanceSummaryContext {
  const period = resolveFinancePeriod("mtd", undefined, undefined, FINANCE_FIXTURE_NOW, FINANCE_FIXTURE_TIME_ZONE);
  return { generatedAt: FINANCE_FIXTURE_NOW, period: period.current, comparePeriod: period.compare, vendor };
}

// ── the same program seen from vendor 12 (Acme TCG) ─────────────────────

/** Q1 for V12 over Oct 1 – 5: A and B fully costed; E (shared label), F (not shipped), J (no cost row) waiting. */
function vendor12OrderTotals(): FinanceRawOrderTotals {
  return {
    orders: b(5), fcOrders: b(2), billed: b(11_730), billedFc: b(7_530),
    productBilled: b(8_720), productBilledFc: b(6_020), shippingBilled: b(3_010), shippingNetPoolFc: b(1_410),
    quoteBase: b(2_310), quoteMarkup: b(480), quoteDunnage: ZERO, ordersWithoutQuote: ZERO,
    poolAll: b(220), poolFc: b(100), paidCash: b(9_530), paidPoints: b(2_200),
    cogsMillsFc: b(346_350), labelsFc: b(1_455), replacementLabelsFc: b(250),
    coverageLabels: b(5), coverageLabelsCosted: b(5), buyerPaid: b(15_545), buyerUnknown: ZERO,
  };
}

/** `summary?vendorId=12`: every vendor-scoped statement filtered to Acme TCG; no Overview bridge, no N2. */
export function vendor12Raw(): FinanceRawAggregates {
  const program = fixtureRaw();
  const { N2: _programOnly, ...checks } = fixtureChecks();
  return {
    ...program,
    orders: ok({
      totals: vendor12OrderTotals(),
      byReason: [
        { reason: "not_shipped", orders: b(1), billed: b(1_300) },
        { reason: "shared_label", orders: b(1), billed: b(1_800) },
        { reason: "item_cost_missing", orders: b(1), billed: b(1_100) },
      ],
    }),
    products: ok({
      totals: {
        packs: b(12), pieces: b(525), linesWithoutPieces: ZERO, packsShipped: b(11), packsFc: b(8),
        billedProduct: b(8_720), billedProductFc: b(6_020), cogsMillsFc: b(346_350), unlinkedCogsMillsFc: ZERO,
      },
      groups: [
        { groupKey: "v:1", productVariantId: 1, productId: 1, productName: "Toploaders", sizeName: "3x4 · 25", sku: "TL-35-25",
          unitsPerVariant: b(25), packs: b(9), pieces: b(225), linesWithoutPieces: ZERO, packsShipped: b(9), packsFc: b(6),
          billedProduct: b(5_920), billedProductFc: b(4_020), cogsMillsFc: b(284_200) },
        { groupKey: "v:2", productVariantId: 2, productId: 2, productName: "Penny sleeves", sizeName: "100", sku: "PS-100",
          unitsPerVariant: b(100), packs: b(3), pieces: b(300), linesWithoutPieces: ZERO, packsShipped: b(2), packsFc: b(2),
          billedProduct: b(2_800), billedProductFc: b(2_000), cogsMillsFc: b(62_150) },
      ],
    }),
    neverCharged: ok([
      { kind: "waiting_for_payment", orders: b(1), buyerTotal: b(2_700), buyerUnknown: ZERO, wouldHaveCharged: b(2_500) },
      { kind: "rejected", orders: b(1), buyerTotal: ZERO, buyerUnknown: b(1), wouldHaveCharged: null },
    ]),
    ledger: ok({ groups: fixtureLedgerGroups().filter((group) => group.vendorId === V12), firstFailureCode: null }),
    returnFees: ok([
      { referenceType: "dropship_rma", feeRows: b(1), feeCents: b(300), restocking: b(200), processing: b(100), returnLabel: ZERO, splitNotRecorded: ZERO },
    ]),
    wallets: ok([
      { walletId: 1, vendorId: V12, available: b(356_860), pending: ZERO, points: b(1_280),
        expiresNext30Days: ZERO, expiresDays31To90: ZERO, expiresLater: ZERO, neverExpires: b(1_280) },
    ]),
    // The pool's own ledger is program-wide; the repository may still return it, the builder must not show it.
    pool: ok({ setAsideBeforeStart: b(90), setAsideP: b(220), toppedUpBeforeStart: ZERO, toppedUpP: b(300), recordedLedgerAtEnd: b(-800), claims: [] }),
    bridge: null,
    vendors: ok(fixtureVendorRows().filter((row) => row.vendorId === V12)),
    checks: { ...checks, D6: checkCounts(1), N1: checkCounts(0) },
  };
}

export const ACME_TCG: FinanceVendorName = { vendorId: V12, name: "Acme TCG", nameSource: "business_name" };

// ── last month (September), a period that ended before now ──────────────

/** `summary?period=last-month` at the fixture clock: P1 and H accepted, compared with an August without orders. */
export function lastMonthRaw(): FinanceRawAggregates {
  const program = fixtureRaw();
  const totals: FinanceRawOrderTotals = {
    orders: b(2), fcOrders: b(2), billed: b(4_100), billedFc: b(4_100),
    productBilled: b(3_000), productBilledFc: b(3_000), shippingBilled: b(1_100), shippingNetPoolFc: b(1_010),
    quoteBase: b(830), quoteMarkup: b(180), quoteDunnage: ZERO, ordersWithoutQuote: ZERO,
    poolAll: b(90), poolFc: b(90), paidCash: b(4_100), paidPoints: ZERO,
    cogsMillsFc: b(150_000), labelsFc: b(800), replacementLabelsFc: ZERO,
    coverageLabels: b(2), coverageLabelsCosted: b(2), buyerPaid: ZERO, buyerUnknown: b(2),
  };
  return {
    ...program,
    bounds: {
      startAt: new Date("2026-09-01T04:00:00.000Z"),
      endAt: new Date("2026-10-01T04:00:00.000Z"),
      compareStartAt: new Date("2026-08-01T04:00:00.000Z"),
      compareEndAt: new Date("2026-09-01T04:00:00.000Z"),
    },
    orders: ok({ totals, byReason: [] }),
    compareOrders: ok({ totals: zeroOrderTotals(), byReason: [] }),
    products: ok({
      totals: {
        packs: b(4), pieces: b(250), linesWithoutPieces: ZERO, packsShipped: b(4), packsFc: b(4),
        billedProduct: b(3_000), billedProductFc: b(3_000), cogsMillsFc: b(150_000), unlinkedCogsMillsFc: ZERO,
      },
      groups: [
        { groupKey: "v:2", productVariantId: 2, productId: 2, productName: "Penny sleeves", sizeName: "100", sku: "PS-100",
          unitsPerVariant: b(100), packs: b(2), pieces: b(200), linesWithoutPieces: ZERO, packsShipped: b(2), packsFc: b(2),
          billedProduct: b(2_000), billedProductFc: b(2_000), cogsMillsFc: b(100_000) },
        { groupKey: "v:1", productVariantId: 1, productId: 1, productName: "Toploaders", sizeName: "3x4 · 25", sku: "TL-35-25",
          unitsPerVariant: b(25), packs: b(2), pieces: b(50), linesWithoutPieces: ZERO, packsShipped: b(2), packsFc: b(2),
          billedProduct: b(1_000), billedProductFc: b(1_000), cogsMillsFc: b(50_000) },
      ],
    }),
    neverCharged: ok([]),
    ledger: ok({
      firstFailureCode: null,
      groups: [
        // 8,000 settled in August (compare), 300,000 in September, 50,000 still on the way at Oct 1 04:00Z.
        ledgerGroup({ vendorId: V12, type: "funding", status: "settled", referenceType: "stripe_payment_intent", cashLine: "stripe_ach",
          nP: b(1), amountP: b(300_000), chargedP: b(300_000), nCmp: b(1), amountCmp: b(8_000), chargedCmp: b(8_000),
          amountBeforeStart: b(8_000), amountBeforeEnd: b(308_000), amountPendingAtEnd: b(50_000) }),
        ledgerGroup({ vendorId: V12, type: "rewards_earned", status: "settled", referenceType: "wallet_funding_rewards", rewardsRail: "stripe_ach",
          nP: b(1), amountP: b(3_000), nCmp: b(1), amountCmp: b(80), amountBeforeStart: b(80), amountBeforeEnd: b(3_080) }),
        // P1 (09-03) and H (10-01 03:30Z, still September in Eastern time).
        ledgerGroup({ vendorId: V12, type: "order_debit", status: "settled", referenceType: "order_intake",
          nP: b(2), amountP: b(-4_100), amountBeforeEnd: b(-4_100) }),
        ledgerGroup({ vendorId: V13, type: "funding", status: "pending", referenceType: "stripe_payment_intent", cashLine: "stripe_ach",
          nPendingNow: b(1), amountPendingNow: b(15_000) }),
        ledgerGroup({ vendorId: V14, type: "return_fee", status: "settled", referenceType: "dropship_rma",
          nCmp: b(1), amountCmp: b(-1_250), amountBeforeStart: b(-1_250), amountBeforeEnd: b(-1_250) }),
        ledgerGroup({ vendorId: V14, type: "funding", status: "pending", referenceType: "stripe_payment_intent", cashLine: "stripe_ach",
          nPendingNow: b(1), amountPendingNow: b(4_000), nStale: b(1), amountStale: b(4_000), amountPendingAtEnd: b(4_000) }),
      ],
    }),
    disputes: ok({ won: [], notWonBack: { disputes: ZERO, disputedCents: ZERO } }),
    returnFees: ok([]),
    pool: ok({ setAsideBeforeStart: ZERO, setAsideP: b(90), toppedUpBeforeStart: ZERO, toppedUpP: ZERO, recordedLedgerAtEnd: ZERO, claims: [] }),
    bridge: ok({ omsRow: b(4_100), notAccepted: ZERO, notAcceptedOrders: ZERO }),
    vendors: ok([
      { vendorId: V12, businessName: "Acme TCG", contactName: "Ada", status: "active", orders: b(2), billed: b(4_100), waiting: ZERO,
        billedFc: b(4_100), cogsMillsFc: b(150_000), labelsFc: b(800), poolFc: b(90), fees: ZERO, creditsCs: ZERO,
        creditsAll: ZERO, cashIn: b(300_000), available: b(356_860), pending: ZERO, points: b(1_280) },
      ...fixtureVendorRows().filter((row) => row.vendorId !== V12).map((row) => ({ ...row, orders: ZERO, billed: ZERO, waiting: ZERO,
        billedFc: ZERO, cogsMillsFc: ZERO, labelsFc: ZERO, poolFc: ZERO, fees: ZERO, creditsCs: ZERO, creditsAll: ZERO, cashIn: ZERO })),
    ]),
  };
}

export function lastMonthContext(): FinanceSummaryContext {
  const period = resolveFinancePeriod("last-month", undefined, undefined, FINANCE_FIXTURE_NOW, FINANCE_FIXTURE_TIME_ZONE);
  return { generatedAt: FINANCE_FIXTURE_NOW, period: period.current, comparePeriod: period.compare, vendor: null };
}
