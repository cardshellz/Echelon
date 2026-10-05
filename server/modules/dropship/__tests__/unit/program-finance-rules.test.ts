import { describe, expect, it } from "vitest";
import {
  barWidths,
  buildFinancePrior,
  centsOfEachDollar,
  checkSummaryIdentities,
  classifyWaitingReason,
  financeLineEffect,
  financePolicyEraNotes,
  financeShare,
  financeVendorName,
  FINANCE_VENDOR_NAME_MAX,
  type FinanceIdentityInput,
  type FinanceOrderCostingFacts,
} from "../../domain/program-finance-rules";
import { buildFinanceSummary } from "../../domain/program-finance-statement";
import type { FinanceLine, FinanceSummary } from "../../../../../shared/dropship/program-finance";
import { fixtureContext, fixtureRaw } from "../fixtures/program-finance-raw.fixture";

const b = (value: number) => BigInt(value);

describe("classifyWaitingReason (spec §3.0 precedence, the SQL `classified` CASE)", () => {
  const costed: FinanceOrderCostingFacts = {
    omsCancelled: false, shippedPacks: b(6), orderedPacks: b(6), anyShared: false, labels: b(2), labelsCosted: b(2), linesCostMismatch: b(0),
  };

  it("is null for a fully costed order", () => {
    expect(classifyWaitingReason(costed)).toBeNull();
  });

  it.each([
    ["cancelled_in_oms", { omsCancelled: true }],
    ["not_shipped", { shippedPacks: b(0) }],
    ["partly_shipped", { shippedPacks: b(1), orderedPacks: b(2) }],
    ["over_shipped", { shippedPacks: b(3), orderedPacks: b(2) }],
    ["shared_label", { anyShared: true }],
    ["label_missing", { labelsCosted: b(1) }],
    ["item_cost_missing", { linesCostMismatch: b(1) }],
  ] as const)("finds %s", (reason, change) => {
    expect(classifyWaitingReason({ ...costed, ...change })).toBe(reason);
  });

  it("lets the first failing reason win", () => {
    // A cancelled order that never shipped is cancelled, not unshipped.
    expect(classifyWaitingReason({ ...costed, omsCancelled: true, shippedPacks: b(0) })).toBe("cancelled_in_oms");
    // Over-shipped beats a shared, uncosted label with missing item costs.
    expect(classifyWaitingReason({ ...costed, shippedPacks: b(7), anyShared: true, labelsCosted: b(0), linesCostMismatch: b(3) })).toBe("over_shipped");
    expect(classifyWaitingReason({ ...costed, shippedPacks: b(1), anyShared: true })).toBe("partly_shipped");
    expect(classifyWaitingReason({ ...costed, anyShared: true, labelsCosted: b(0) })).toBe("shared_label");
    expect(classifyWaitingReason({ ...costed, labelsCosted: b(1), linesCostMismatch: b(1) })).toBe("label_missing");
  });
});

describe("largest-remainder splits of the answer card", () => {
  it("splits each $1 of fully costed billing into 100 whole cents (contract §6.4)", () => {
    expect(centsOfEachDollar({ kept: b(3_881), costOfGoods: b(3_764), carrierLabels: b(1_935), poolShare: b(150) }, b(9_730)))
      .toEqual({ kept: b(40), costOfGoods: b(39), carrierLabels: b(20), poolShare: b(1) });
  });

  it("splits the bar into 10000 basis points of all billing", () => {
    expect(barWidths({ kept: b(3_881), costOfGoods: b(3_764), carrierLabels: b(1_935), poolShare: b(150), waiting: b(9_000) }, b(18_730)))
      .toEqual({ kept: b(2_072), costOfGoods: b(2_010), carrierLabels: b(1_033), poolShare: b(80), waiting: b(4_805) });
  });

  it("gives a tied unit to the part listed first: kept, cost of goods, labels, pool", () => {
    expect(centsOfEachDollar({ kept: b(1), costOfGoods: b(1), carrierLabels: b(1), poolShare: b(0) }, b(3)))
      .toEqual({ kept: b(34), costOfGoods: b(33), carrierLabels: b(33), poolShare: b(0) });
  });

  it("has no split for a loss, an empty base or parts that don't add up", () => {
    expect(centsOfEachDollar({ kept: b(-850), costOfGoods: b(1_500), carrierLabels: b(300), poolShare: b(50) }, b(1_000))).toBeNull();
    expect(centsOfEachDollar({ kept: b(0), costOfGoods: b(0), carrierLabels: b(0), poolShare: b(0) }, b(0))).toBeNull();
    expect(barWidths({ kept: b(1), costOfGoods: b(1), carrierLabels: b(1), poolShare: b(1), waiting: b(1) }, b(6))).toBeNull();
  });
});

describe("financeShare", () => {
  it("gives tenths and basis points from the same integers", () => {
    expect(financeShare(b(3_881), b(9_730))).toEqual({ tenths: b(399), bps: b(3_989) });
    expect(financeShare(b(-850), b(1_000))).toEqual({ tenths: b(-850), bps: b(-8_500) });
  });

  it("has no share of nothing or of a negative base", () => {
    expect(financeShare(b(5), b(0))).toEqual({ tenths: null, bps: null });
    expect(financeShare(b(5), b(-10))).toEqual({ tenths: null, bps: null });
  });
});

describe("buildFinancePrior (spec §3.3 delta rules)", () => {
  it("is absent without a comparison", () => {
    expect(buildFinancePrior(b(18_730), null)).toBeNull();
  });

  it("shows the change and its percent of a positive prior (contract §6.4 tiles)", () => {
    expect(buildFinancePrior(b(18_730), b(2_600))).toEqual({ amount: 2_600, change: 16_130, changeTenths: 6_204, changeBps: 62_038, kind: "change" });
    expect(buildFinancePrior(b(88_300), b(300_000))).toEqual({ amount: 300_000, change: -211_700, changeTenths: -706, changeBps: -7_057, kind: "change" });
  });

  it("is new when the prior is zero, and no change when nothing moved", () => {
    expect(buildFinancePrior(b(4_100), b(0))).toEqual({ amount: 0, change: 4_100, changeTenths: null, changeBps: null, kind: "new" });
    expect(buildFinancePrior(b(0), b(0))).toEqual({ amount: 0, change: 0, changeTenths: null, changeBps: null, kind: "no_change" });
    expect(buildFinancePrior(b(500), b(500))).toMatchObject({ change: 0, changeTenths: 0, kind: "no_change" });
  });

  it("gives no percent of a prior at or below zero", () => {
    expect(buildFinancePrior(b(100), b(-50))).toEqual({ amount: -50, change: 150, changeTenths: null, changeBps: null, kind: "change" });
    expect(buildFinancePrior(b(-20), b(0))).toEqual({ amount: 0, change: -20, changeTenths: null, changeBps: null, kind: "change" });
  });

  it("is unavailable when either side failed or can't be carried exactly", () => {
    expect(buildFinancePrior(b(10), "unavailable")).toEqual({ amount: null, change: null, changeTenths: null, changeBps: null, kind: "unavailable" });
    expect(buildFinancePrior(null, b(2_600))).toEqual({ amount: 2_600, change: null, changeTenths: null, changeBps: null, kind: "unavailable" });
    expect(buildFinancePrior(BigInt("90071992547409930"), b(1))?.kind).toBe("unavailable");
  });
});

describe("financeVendorName", () => {
  it("prefers the business name, then the contact name, then the id", () => {
    expect(financeVendorName(12, "Acme TCG", "Ada")).toEqual({ vendorId: 12, name: "Acme TCG", nameSource: "business_name" });
    expect(financeVendorName(13, "   ", " Pat ")).toEqual({ vendorId: 13, name: "Pat", nameSource: "contact_name" });
    expect(financeVendorName(14, null, null)).toEqual({ vendorId: 14, name: "Vendor #14", nameSource: "id" });
  });

  it("bounds a long name without splitting a character", () => {
    const long = financeVendorName(1, "x".repeat(FINANCE_VENDOR_NAME_MAX + 50), null).name;
    expect(long).toHaveLength(FINANCE_VENDOR_NAME_MAX);
    expect(long.endsWith("…")).toBe(true);
    const emoji = financeVendorName(1, `${"x".repeat(FINANCE_VENDOR_NAME_MAX - 2)}🃏🃏`, null).name;
    expect(emoji.length).toBeLessThanOrEqual(FINANCE_VENDOR_NAME_MAX);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF]…$/);
  });
});

describe("financePolicyEraNotes (spec §7, inclusive Eastern days)", () => {
  it.each([
    ["October so far", "2026-10-01", "2026-10-05", []],
    ["September", "2026-09-01", "2026-09-30", ["card_fee_era", "pricing_v1_era", "weekly_collection_era"]],
    ["the card-fee era's first day", "2026-09-16", "2026-09-16", ["card_fee_era", "weekly_collection_era"]],
    ["the card-fee era's last day", "2026-09-24", "2026-09-30", ["card_fee_era"]],
    ["the day after older pricing", "2026-09-13", "2026-09-15", ["weekly_collection_era"]],
    ["the last day of older pricing", "2026-09-12", "2026-09-12", ["pricing_v1_era", "weekly_collection_era"]],
    ["the day before the weekly collection", "2026-08-04", "2026-08-04", ["pricing_v1_era"]],
    ["the weekly collection's last day", "2026-09-17", "2026-09-17", ["card_fee_era", "weekly_collection_era"]],
  ] as const)("%s", (_label, fromDate, toDate, notes) => {
    expect(financePolicyEraNotes({ fromDate, toDate })).toEqual(notes);
  });

  it("shows every era for all time", () => {
    expect(financePolicyEraNotes({ fromDate: null, toDate: "2026-10-05" })).toEqual(["card_fee_era", "pricing_v1_era", "weekly_collection_era"]);
  });
});

describe("financeLineEffect", () => {
  it("signs a line's amount by its operator", () => {
    expect(financeLineEffect({ operator: "minus", amount: 3_764 })).toBe(b(-3_764));
    expect(financeLineEffect({ operator: "plus", amount: 760 })).toBe(b(760));
    expect(financeLineEffect({ operator: "equals", amount: -910 })).toBe(b(-910));
    expect(financeLineEffect({ operator: "none", amount: null })).toBeNull();
  });
});

// ── check P1 ────────────────────────────────────────────────────────────

function fixtureSummary(): FinanceSummary {
  return buildFinanceSummary(fixtureRaw(), fixtureContext());
}

function identityInput(summary: FinanceSummary): FinanceIdentityInput {
  return { answer: summary.answer, tiles: summary.tiles, sections: summary.sections, endsNow: summary.period.endsNow };
}

type Sections = FinanceSummary["sections"];

function lineIn(summary: FinanceSummary, section: keyof Sections, key: string): FinanceLine {
  const line = summary.sections[section].lines.find((candidate) => candidate.key === key);
  if (!line) throw new Error(`the fixture has no ${key}`);
  return line;
}

function bump(summary: FinanceSummary, section: keyof Sections, key: string): void {
  const line = lineIn(summary, section, key);
  line.amount = (line.amount as number) + 1;
}

function failingKeys(mutate: (summary: FinanceSummary) => void): string[] {
  const summary = structuredClone(fixtureSummary());
  mutate(summary);
  return checkSummaryIdentities(identityInput(summary)).exceptions.map((item) => item.detailKey).sort();
}

const MUTATIONS: readonly [string, (summary: FinanceSummary) => void, readonly string[]][] = [
  ["the bar's waiting part", (s) => { s.answer.waiting.billed += 1; }, ["identity_1_bar"]],
  ["the waiting line", (s) => bump(s, "sales", "sales.waiting"), ["identity_1_sales_fully_costed", "identity_4_waiting_billed"]],
  ["cost of goods", (s) => bump(s, "sales", "sales.cogs"), ["identity_1_sales_kept_on_orders", "identity_7_products_cogs"]],
  ["fees we charged", (s) => bump(s, "sales", "sales.fees"), ["identity_1_sales_kept"]],
  ["product billed", (s) => bump(s, "sales", "sales.billed.product"), ["identity_2_billed_parts", "identity_7_products_billed"]],
  ["our markup", (s) => bump(s, "sales", "sales.billed.markup"), ["identity_2_shipping_parts"]],
  ["paid from wallets", (s) => bump(s, "sales", "sales.billed.paid_from_wallets"), ["identity_3_paid"]],
  ["a waiting reason's orders", (s) => { lineIn(s, "sales", "sales.waiting.shared_label").count = 3; }, ["identity_4_waiting_orders"]],
  ["kept on shipping", (s) => bump(s, "sales", "sales.kept_orders.on_shipping"), ["identity_5_kept_parts"]],
  ["a deposit line", (s) => bump(s, "cash", "cash.ach"), ["identity_6_deposit_lines"]],
  ["disputes won back", (s) => bump(s, "cash", "cash.won_back"), ["identity_6_cash_received"]],
  ["a product row's billing", (s) => { s.sections.products.top[0].billedForProduct += 1; }, ["identity_7_products_rows_billed"]],
  ["the packs line", (s) => bump(s, "products", "products.packs"), ["identity_7_products_packs"]],
  ["a product row's cost", (s) => { s.sections.products.top[0].costOfGoods += 1; }, ["identity_7_products_rows_cogs"]],
  ["a product row's kept", (s) => { s.sections.products.top[0].keptOnProduct += 1; }, ["identity_7_products_rows_kept"]],
  ["the products total kept", (s) => { (s.sections.products.total as { keptOnProduct: number }).keptOnProduct += 1; },
    ["identity_7_products_kept", "identity_7_products_rows_kept"]],
  ["a vendor row's orders", (s) => { s.sections.vendors.top[0].orders += 1; }, ["identity_8_vendors_orders"]],
  ["the vendors total orders", (s) => { (s.sections.vendors.total as { orders: number }).orders += 1; }, ["identity_8_vendors_orders_total"]],
  ["a vendor row's billing", (s) => { s.sections.vendors.top[1].billed += 1; }, ["identity_8_vendors_billed"]],
  ["the vendors total billed", (s) => { (s.sections.vendors.total as { billed: number }).billed += 1; }, ["identity_8_vendors_billed_total"]],
  ["the vendors total kept on orders", (s) => { (s.sections.vendors.total as { keptOnOrders: number }).keptOnOrders += 1; },
    ["identity_8_vendors_kept_on_orders_total"]],
  ["the vendors total kept", (s) => { (s.sections.vendors.total as { kept: number }).kept += 1; }, ["identity_8_vendors_kept_total"]],
  ["the vendors kept-on-orders rounding", (s) => { s.sections.vendors.roundingCents.keptOnOrders += 1; }, ["identity_8_vendors_kept_on_orders"]],
  ["the vendors kept rounding", (s) => { s.sections.vendors.roundingCents.kept += 1; }, ["identity_8_vendors_kept"]],
  ["we owe now", (s) => { s.tiles.weOweNow.amount = (s.tiles.weOweNow.amount as number) + 1; }, ["identity_8_vendors_we_owe", "identity_8_vendors_we_owe_total"]],
  ["owed to us now", (s) => { s.tiles.owedToUsNow.amount = (s.tiles.owedToUsNow.amount as number) + 1; },
    ["identity_8_vendors_they_owe", "identity_8_vendors_they_owe_total"]],
  ["a points-given part", (s) => bump(s, "points", "points.given.bank"), ["identity_9_points_given_parts"]],
  ["points expired", (s) => bump(s, "points", "points.expired"), ["identity_9_points_walk"]],
  ["points held now", (s) => bump(s, "points", "points.held_now"), ["identity_9_points_held_now"]],
  ["pool topped up", (s) => bump(s, "pool", "pool.topped_up"), ["identity_10_pool_walk"]],
  ["a pool payout kind", (s) => bump(s, "pool", "pool.paid_out.no_inspection"), ["identity_10_pool_paid_parts"]],
  ["disputes taken from wallets", (s) => bump(s, "owed", "owed.walk.disputes_taken"), ["identity_11_owed_walk"]],
  ["the walk's they-owe split", (s) => bump(s, "owed", "owed.walk.they_owe"), ["identity_11_owed_split"]],
  ["return fees", (s) => bump(s, "returns", "returns.fees"), ["identity_12_returns_net"]],
  ["credited to vendors", (s) => bump(s, "returns", "returns.credited"), ["identity_12_returns_credited"]],
  ["points used", (s) => bump(s, "points", "points.used"), ["identity_13_points_used", "identity_9_points_walk"]],
  ["points used in billing", (s) => bump(s, "points", "points.used.billed_value"), ["identity_13_points_used_value"]],
  ["pool set aside", (s) => bump(s, "pool", "pool.set_aside"), ["identity_10_pool_walk", "identity_14_pool_set_aside"]],
];

describe("checkSummaryIdentities (check P1, contract §3)", () => {
  it("finds every identity holding on the §6.4 summary", () => {
    const report = checkSummaryIdentities(identityInput(fixtureSummary()));
    expect(report.exceptions).toEqual([]);
    const numbers = new Set(report.examined.map((item) => Number(/^identity_(\d+)_/.exec(item.detailKey)?.[1])));
    expect([...numbers].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(new Set(report.examined.map((item) => item.detailKey)).size).toBe(report.examined.length);
  });

  it.each(MUTATIONS)("trips on %s", (_label, mutate, expected) => {
    expect(failingKeys(mutate)).toEqual([...expected].sort());
  });

  it("can trip every identity it examines", () => {
    const examined = checkSummaryIdentities(identityInput(fixtureSummary())).examined.map((item) => item.detailKey);
    const tripped = new Set(MUTATIONS.flatMap(([, , expected]) => expected));
    expect(examined.filter((key) => !tripped.has(key))).toEqual([]);
  });

  it("reports the expected and found values of an exception", () => {
    const summary = structuredClone(fixtureSummary());
    bump(summary, "returns", "returns.fees");
    expect(checkSummaryIdentities(identityInput(summary)).exceptions).toEqual([
      { detailKey: "identity_12_returns_net", unit: "cents", expected: b(3_250), found: b(3_249) },
    ]);
  });

  it("leaves out identities whose figures are not on the page", () => {
    const summary = structuredClone(fixtureSummary());
    summary.sections.cash = { status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT", lines: [] };
    const markup = lineIn(summary, "sales", "sales.billed.markup");
    Object.assign(markup, { status: "partial", reasonKey: "quote_missing", amount: 1 });
    const keys = checkSummaryIdentities(identityInput(summary)).examined.map((item) => item.detailKey);
    expect(keys.filter((key) => key.startsWith("identity_6_"))).toEqual([]);
    expect(keys).not.toContain("identity_2_shipping_parts");
    expect(checkSummaryIdentities(identityInput(summary)).exceptions).toEqual([]);
  });

  it("reads a flipped operator as the negative quantity it is", () => {
    const summary = structuredClone(fixtureSummary());
    // A credit of 100 on cost of goods: "plus 100" instead of "minus".
    Object.assign(lineIn(summary, "sales", "sales.cogs"), { operator: "plus", amount: 100 });
    const keys = checkSummaryIdentities(identityInput(summary)).exceptions.map((item) => item.detailKey).sort();
    expect(keys).toEqual(["identity_1_sales_kept_on_orders", "identity_7_products_cogs"]);
    const cogs = checkSummaryIdentities(identityInput(summary)).exceptions.find((item) => item.detailKey === "identity_7_products_cogs");
    expect(cogs?.expected).toBe(b(-100));
  });

  it("only asks held points to match the wallets when the period ends now", () => {
    const summary = structuredClone(fixtureSummary());
    bump(summary, "points", "points.held_now");
    expect(checkSummaryIdentities({ ...identityInput(summary), endsNow: false }).exceptions).toEqual([]);
  });
});
