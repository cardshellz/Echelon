/**
 * Program finance against PostgreSQL (contract §6.4): the real repository
 * and service read the §6.4 seeded program from minimal copies of every
 * source table (fixtures/dropship-finance-fixture.ts) in an isolated
 * per-process schema, and every number the contract lists for the summary
 * is asserted. Each variant (DST day, malformed metadata, a missing table, a
 * statement timeout) gets its own schema so the base program stays as seeded.
 *
 * Only a distinct, explicitly disposable loopback database is accepted.
 */

import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FINANCE_CHECK_IDS,
  financeSummarySchema,
  type FinanceCheckId,
  type FinanceLine,
  type FinanceSectionKey,
  type FinanceSummary,
} from "../../../../../shared/dropship/program-finance";
import { signedMillsToCents } from "../../../../../shared/dropship/program-finance-money";
import { DropshipFinanceService } from "../../application/dropship-finance-service";
import { FINANCE_TABLES, type FinanceRawTables } from "../../domain/program-finance-raw";
import { classifyWaitingReason } from "../../domain/program-finance-rules";
import { FinanceRequestSemaphore, PgDropshipFinanceRepository } from "../../infrastructure/dropship-finance.repository";
import { ORDER_CTE_PARAMS, orderEconomicsCte, productsStatement, sqlRoundMills } from "../../infrastructure/dropship-finance-sql";
import {
  FINANCE_DST_ORDERS,
  FINANCE_FIXTURE_DDL,
  FINANCE_FIXTURE_DST_NOW,
  FINANCE_FIXTURE_NOW,
  FINANCE_FIXTURE_ORDERS,
  FIXTURE_LEDGER_REFERENCES,
  assertFinanceSchemaName,
  buildFinanceFixture,
  financeFixtureInsert,
  qualifyFinanceSql,
  type FinanceFixtureOptions,
} from "./fixtures/dropship-finance-fixture";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testUrl && disposable ? describe : describe.skip;

const ALL_TABLES = Object.fromEntries(FINANCE_TABLES.map((table) => [table.key, true])) as FinanceRawTables;
const CHECKS_NEEDING_A_LOOK_MTD: readonly FinanceCheckId[] = ["D6", "K2", "N1", "N2"];
/** The statement timeout the timeout variant sets on one section (see that test for why not 1ms). */
const SECTION_TIMEOUT_MS = 50;
/** Statements that would change data; the snapshot must never send one. */
const WRITE_STATEMENT = /^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|LOCK|SELECT\s+pg_advisory_lock)\b/i;

interface LogEntry {
  readonly level: "info" | "warn" | "error";
  readonly action: string;
  readonly data: Record<string, unknown>;
}

type QueryHook = (text: string, client: PoolClient) => Promise<void>;

function refuseUnsafeDatabase(url: string | undefined): asserts url is string {
  if (!url || !disposable || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(url)) {
    throw new Error("Program finance tests require a distinct, explicitly disposable PostgreSQL database.");
  }
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("Program finance tests only run against a loopback PostgreSQL database.");
  }
}

describeDatabase.sequential("Program finance summary on PostgreSQL (contract §6.4)", () => {
  const baseSchema = `dropship_finance_${process.pid}`;
  const createdSchemas = new Set<string>();
  let pool: pg.Pool;

  beforeAll(async () => {
    refuseUnsafeDatabase(testUrl);
    pool = new pg.Pool({ connectionString: testUrl, max: 4, connectionTimeoutMillis: 3000, ssl: false });
    await createSeededSchema(baseSchema);
  });

  afterAll(async () => {
    for (const schema of createdSchemas) {
      assertFinanceSchemaName(schema);
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await pool?.end();
  });

  async function createSeededSchema(schema: string, options: FinanceFixtureOptions = {}): Promise<void> {
    assertFinanceSchemaName(schema);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    createdSchemas.add(schema);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(qualifyFinanceSql(FINANCE_FIXTURE_DDL, schema));
      for (const entry of buildFinanceFixture(options)) {
        const insert = financeFixtureInsert(entry);
        await client.query(qualifyFinanceSql(insert.text, schema), insert.values);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** A fresh copy of the program for a test that changes it. */
  async function variantSchema(name: string, options: FinanceFixtureOptions = {}): Promise<string> {
    const schema = `${baseSchema}_${name}`;
    await createSeededSchema(schema, options);
    return schema;
  }

  /** The real service over the real repository, with every statement qualified into `schema`. */
  function financeService(schema: string, options: { now?: Date; beforeQuery?: QueryHook } = {}) {
    const now = options.now ?? FINANCE_FIXTURE_NOW;
    const logs: LogEntry[] = [];
    const statements: string[] = [];
    const releases: Array<boolean | Error | undefined> = [];
    const qualifyingPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (text: string, values?: unknown[]) => {
            statements.push(text);
            await options.beforeQuery?.(text, client);
            return client.query(qualifyFinanceSql(text, schema), values);
          },
          release: (destroy?: boolean | Error) => {
            releases.push(destroy);
            client.release(destroy);
          },
        } as Pick<PoolClient, "query" | "release">;
      },
    } as unknown as Pick<pg.Pool, "connect">;
    // A fixed budget clock: the request budget never runs out, so no section is skipped by timing.
    const repository = new PgDropshipFinanceRepository(qualifyingPool, {
      semaphore: new FinanceRequestSemaphore(1),
      clock: { now: () => new Date(now.getTime()) },
    });
    const record = (level: LogEntry["level"]) => (action: string, data: Record<string, unknown>) => { logs.push({ level, action, data }); };
    const service = new DropshipFinanceService({
      repository,
      clock: { now: () => new Date(now.getTime()) },
      logger: { info: record("info"), warn: record("warn"), error: record("error") },
    });
    return {
      logs,
      statements,
      releases,
      summary: (query: Record<string, string> = {}) => service.getSummary(query, { actorId: "integration-test" }),
    };
  }

  // ── reading the summary ────────────────────────────────────────────────

  function linesOf(summary: FinanceSummary, section: FinanceSectionKey): readonly FinanceLine[] {
    return (summary.sections[section] as { readonly lines: readonly FinanceLine[] }).lines;
  }

  function lineOf(summary: FinanceSummary, section: FinanceSectionKey, key: string): FinanceLine {
    const line = linesOf(summary, section).find((candidate) => candidate.key === key);
    if (!line) throw new Error(`No line ${key} in the ${section} section.`);
    return line;
  }

  /** Every line's amount by key, for one subset assertion per section. */
  function amountsOf(summary: FinanceSummary, section: FinanceSectionKey): Record<string, number | null> {
    return Object.fromEntries(linesOf(summary, section).map((line) => [line.key, line.amount]));
  }

  function countsOf(summary: FinanceSummary, section: FinanceSectionKey): Record<string, number | undefined> {
    return Object.fromEntries(linesOf(summary, section).map((line) => [line.key, line.count]));
  }

  function checkResults(summary: FinanceSummary): Record<string, string> {
    return Object.fromEntries(summary.checks.map((check) => [check.id, check.result]));
  }

  function checkOf(summary: FinanceSummary, id: FinanceCheckId) {
    const check = summary.checks.find((candidate) => candidate.id === id);
    if (!check) throw new Error(`No check ${id}.`);
    return check;
  }

  function infoLines(summary: FinanceSummary, key: string): Record<string, number | null> {
    const info = summary.info.find((candidate) => candidate.key === key);
    if (!info) throw new Error(`No info line ${key}.`);
    return Object.fromEntries(info.lines.map((line) => [line.key, line.amount]));
  }

  // ── month to date, the whole program ──────────────────────────────────

  describe("month to date, all vendors (contract §6.4 'Assertions: GET summary')", () => {
    let mtd: FinanceSummary;
    let run: ReturnType<typeof financeService>;

    beforeAll(async () => {
      run = financeService(baseSchema);
      mtd = await run.summary();
    });

    it("reads one REPEATABLE READ READ ONLY snapshot, writes nothing and returns its client", () => {
      expect(run.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(run.statements[run.statements.length - 1]).toBe("COMMIT");
      expect(run.statements.filter((text) => WRITE_STATEMENT.test(text))).toEqual([]);
      expect(run.releases).toEqual([false]);
      expect(financeSummarySchema.safeParse(mtd).success).toBe(true);
    });

    it("labels the window: Oct 1 Eastern to now, compared with Sep 1 – 5 to the same time", () => {
      expect(mtd.generatedAt).toBe("2026-10-05T13:14:00.000Z");
      expect(mtd.scope).toEqual({ vendor: null });
      expect(mtd.period).toEqual({
        preset: "mtd", fromDate: "2026-10-01", toDate: "2026-10-05", startAt: "2026-10-01T04:00:00.000Z",
        endAt: "2026-10-05T13:14:00.000Z", endsNow: true, clampedToMonthEnd: false,
      });
      expect(mtd.comparePeriod).toMatchObject({ fromDate: "2026-09-01", toDate: "2026-09-05", startAt: "2026-09-01T04:00:00.000Z", endAt: "2026-09-05T13:14:00.000Z" });
      // Oct 1–5 is after every policy era (card fee to Sep 24, pricing v1 to Sep 12, weekly collection to Sep 17).
      expect(mtd.notes).toEqual([]);
    });

    it("answer card", () => {
      expect(mtd.answer).toMatchObject({
        state: "kept", status: "ok",
        orders: 10, billed: 18_730,
        fullyCosted: { orders: 3, billed: 9730 },
        waiting: { orders: 7, billed: 9000 },
        costOfGoods: 3764, carrierLabels: 1935, poolShare: 150,
        keptOnOrders: 3881, feesCharged: 760, returnCreditsPaid: 2000,
        kept: { amount: 2641, status: "recorded" },
        marginTenths: 399, marginBps: 3989, priorMarginTenths: 404, marginChangeTenths: -5,
        centsOfEachDollar: { kept: 40, costOfGoods: 39, carrierLabels: 20, poolShare: 1 },
        barBps: { kept: 2072, costOfGoods: 2010, carrierLabels: 1033, poolShare: 80, waiting: 4805 },
        paidWithPoints: { billed: 2200, points: 2200 },
        coverage: { done: 3, total: 10 },
      });
    });

    it("answer workings: the hero's arithmetic with the page's own figures", () => {
      const operand = (lineKey: string, amount: number, operator: "none" | "plus" | "minus") => ({ lineKey, amount, unit: "cents", operator });
      expect(mtd.answer.workings).toEqual([
        { step: 1, textKey: "working.two_clocks", operands: [], result: null },
        {
          step: 2, textKey: "sales.billed_fc", result: 9730, opensMetric: "sales.billed",
          operands: [operand("sales.billed", 18_730, "none"), operand("sales.waiting", 9000, "minus")],
        },
        {
          step: 3, textKey: "sales.kept_orders", result: 3881, opensMetric: "sales.kept_orders",
          operands: [
            operand("sales.billed_fc", 9730, "none"), operand("sales.cogs", 3764, "minus"),
            operand("sales.labels", 1935, "minus"), operand("sales.pool_fc", 150, "minus"),
          ],
        },
        { step: 4, textKey: "working.cogs_basis", operands: [], result: null },
        {
          step: 5, textKey: "sales.kept", result: 2641,
          operands: [operand("sales.kept_orders", 3881, "none"), operand("sales.fees", 760, "plus"), operand("sales.return_credits_cs", 2000, "minus")],
        },
        // 3,881 / 9,730 = 39.9%; Sep 1–5: 1,050 / 2,600 = 40.4%.
        { step: 6, textKey: "working.margin_share", operands: [operand("sales.kept_orders", 3881, "none"), operand("sales.billed_fc", 9730, "none")], result: null },
        { step: 7, textKey: "working.margin_prior", operands: [operand("sales.kept_orders", 1050, "none"), operand("sales.billed_fc", 2600, "none")], result: null },
        { step: 8, textKey: "working.margin_change", operands: [], result: null },
        { step: 9, textKey: "working.not_included", operands: [], result: null },
      ]);
    });

    it("sales lines, waiting reasons and the never-charged memo", () => {
      expect(amountsOf(mtd, "sales")).toMatchObject({
        "sales.billed": 18_730,
        "sales.billed.product": 13_320,
        "sales.billed.shipping": 5410,
        "sales.billed.carrier_estimate": 4080,
        "sales.billed.markup": 930,
        "sales.billed.pool_share": 400,
        "sales.billed.paid_from_wallets": 16_530,
        "sales.billed.paid_with_points": 2200,
        "sales.waiting": 9000,
        // K, F, G (1 of 2 shipped), D + E, I, J
        "sales.waiting.cancelled_in_oms": 800,
        "sales.waiting.not_shipped": 1300,
        "sales.waiting.partly_shipped": 1500,
        "sales.waiting.shared_label": 3300,
        "sales.waiting.label_missing": 1000,
        "sales.waiting.item_cost_missing": 1100,
        "sales.billed_fc": 9730,
        "sales.cogs": 3764,
        "sales.labels": 1935,
        "sales.labels.replacement": 250,
        "sales.pool_fc": 150,
        "sales.packaging": null,
        "sales.kept_orders": 3881,
        "sales.kept_orders.on_products": 3756,
        "sales.kept_orders.on_shipping": 125,
        "sales.fees": 760,
        "sales.fees.advance": 10,
        "sales.fees.card": 300,
        "sales.fees.returns": 450,
        "sales.return_credits_cs": 2000,
        "sales.kept": 2641,
        "sales.memo.points_used": 2200,
        "sales.memo.staff_credits": 2500,
        "sales.memo.pool_credits": 1700,
        "sales.buyer_paid": 23_993,
        "sales.never_charged": 3,
        "sales.never_charged.waiting_for_payment": 1,
        "sales.never_charged.payment_time_ran_out": 1,
        "sales.never_charged.rejected": 1,
        "sales.never_charged.would_have_charged": 2500,
        "sales.label_coverage": 7,
      });
      expect(countsOf(mtd, "sales")).toMatchObject({
        "sales.billed": 10, "sales.waiting": 7, "sales.billed_fc": 3,
        "sales.waiting.cancelled_in_oms": 1, "sales.waiting.not_shipped": 1, "sales.waiting.partly_shipped": 1,
        "sales.waiting.shared_label": 2, "sales.waiting.label_missing": 1, "sales.waiting.item_cost_missing": 1,
        "sales.buyer_paid": 1,
      });
      expect(linesOf(mtd, "sales").some((line) => line.key === "sales.waiting.over_shipped")).toBe(false);
    });

    it("sales line details: shares, coverage, the one unknown buyer total and the billed prior", () => {
      expect(lineOf(mtd, "sales", "sales.kept_orders.on_products")).toMatchObject({ percentTenths: 499 });
      expect(lineOf(mtd, "sales", "sales.kept_orders.on_shipping")).toMatchObject({ percentTenths: 61 });
      expect(lineOf(mtd, "sales", "sales.label_coverage").coverage).toEqual({ done: 7, total: 8 });
      expect(lineOf(mtd, "sales", "sales.buyer_paid")).toMatchObject({ status: "partial", reasonKey: "buyer_total_unknown" });
      expect(lineOf(mtd, "sales", "sales.billed").prior).toMatchObject({ amount: 2600, change: 16_130, changeTenths: 6204, kind: "change" });
    });

    it("tiles", () => {
      expect(mtd.tiles).toMatchObject({
        billed: { amount: 18_730, status: "recorded", orders: 10, prior: { amount: 2600, change: 16_130, changeTenths: 6204, kind: "change" } },
        cashReceived: { amount: 88_300, status: "recorded", prior: { amount: 300_000, change: -211_700, changeTenths: -706, kind: "change" } },
        weOweNow: { amount: 381_110, status: "recorded", vendors: 2, onTheWay: 19_000, atEndOfPeriod: null },
        owedToUsNow: { amount: 1250, status: "recorded", vendors: 1, atEndOfPeriod: null },
      });
    });

    it("cash in: one line per rail, the walk to cash received and the memo", () => {
      expect(amountsOf(mtd, "cash")).toMatchObject({
        "cash.ach": 50_000,
        "cash.card": 10_300,
        "cash.card.fees": 300,
        "cash.usdc": 25_000,
        // The weekly collection names no rail; it is found through its funding method.
        "cash.collection": 5000,
        "cash.received_deposits": 90_300,
        "cash.pulled_back": 12_300,
        "cash.won_back": 10_300,
        "cash.received": 88_300,
        "cash.memo.on_the_way": 19_000,
        "cash.memo.stuck": 4000,
        "cash.memo.failed": 7000,
        "cash.memo.not_won_back": 2000,
        "cash.memo.staff_credits": 2500,
      });
      expect(countsOf(mtd, "cash")).toMatchObject({
        "cash.ach": 1, "cash.card": 1, "cash.usdc": 1, "cash.collection": 1, "cash.pulled_back": 2, "cash.won_back": 1,
        "cash.memo.stuck": 1, "cash.memo.failed": 1, "cash.memo.not_won_back": 1, "cash.memo.staff_credits": 1,
      });
      expect(lineOf(mtd, "cash", "cash.memo.failed").failureCode).toBe("R01");
      expect(linesOf(mtd, "cash").some((line) => line.key === "cash.unknown")).toBe(false);
      expect(infoLines(mtd, "won_disputes")).toEqual({
        "info.won_disputes.cash_returned": 10_300,
        "info.won_disputes.wallet_restored": 10_000,
        "info.won_disputes.card_fee_part": 300,
        "info.won_disputes.points_from_cash": 0,
      });
    });

    it("returns and credits", () => {
      expect(amountsOf(mtd, "returns")).toMatchObject({
        "returns.credits_cs": 2000,
        "returns.credits_cs.inspected": 1200,
        "returns.credits_cs.return_case": 800,
        "returns.credits_pool": 1700,
        "returns.credits_pool.no_inspection": 1100,
        "returns.credits_pool.inspection_fault": 600,
        "returns.fees": 450,
        "returns.fees.restocking": 350,
        "returns.fees.processing": 100,
        "returns.net": 3250,
        "returns.staff_credits": 2500,
      });
      expect(linesOf(mtd, "returns").some((line) => line.key === "returns.fees.split_not_recorded")).toBe(false);
    });

    it("owed: the walk from the opening balance closes on the wallets now", () => {
      expect(amountsOf(mtd, "owed")).toMatchObject({
        "owed.we_owe": 381_110,
        "owed.they_owe": 1250,
        "owed.on_the_way": 19_000,
        "owed.walk.opening": 302_650,
        "owed.walk.deposits": 90_000,
        "owed.walk.staff_credits": 2500,
        "owed.walk.return_credits_cs": 2000,
        "owed.walk.return_credits_pool": 1700,
        "owed.walk.disputes_won": 10_000,
        "owed.walk.orders": 16_530,
        "owed.walk.advance_fees": 10,
        "owed.walk.return_fees": 450,
        "owed.walk.disputes_taken": 12_000,
        "owed.walk.closing": 379_860,
        "owed.walk.we_owe": 381_110,
        "owed.walk.they_owe": 1250,
      });
      expect(countsOf(mtd, "owed")).toMatchObject({ "owed.we_owe": 2, "owed.they_owe": 1 });
      // The walk closes: 381,110 owed by us − 1,250 owed to us.
      expect(lineOf(mtd, "owed", "owed.walk.closing").amount).toBe(381_110 - 1250);
      expect(linesOf(mtd, "owed").some((line) => line.key === "owed.walk.unexplained")).toBe(false);
    });

    it("points: opening + given − used − expired − taken back = held = accounts = lots", () => {
      expect(amountsOf(mtd, "points")).toMatchObject({
        "points.opening": 3080,
        "points.given": 750,
        "points.given.bank": 500,
        "points.given.usdc": 250,
        "points.used": 2200,
        "points.expired": 80,
        "points.taken_back": 20,
        "points.held": 1530,
        "points.held_now": 1530,
        "points.expiry.next_30_days": 0,
        "points.expiry.days_31_to_90": 250,
        "points.expiry.later": 0,
        "points.expiry.never": 1280,
      });
      expect(checkOf(mtd, "W3")).toMatchObject({ result: "fine", examined: 3, exceptions: 0 });
    });

    it("insurance pool (signed) and claims", () => {
      expect(amountsOf(mtd, "pool")).toMatchObject({
        "pool.opening": 90,
        "pool.set_aside": 400,
        "pool.paid_out": 1700,
        "pool.paid_out.no_inspection": 1100,
        "pool.paid_out.inspection_fault": 600,
        "pool.topped_up": 300,
        "pool.closing": -910,
        "pool.claims": 900,
        "pool.record": -800,
      });
      expect(countsOf(mtd, "pool")).toMatchObject({ "pool.claims": 1 });
      expect(infoLines(mtd, "pool_record")).toEqual({ "info.pool_record.recorded": -800, "info.pool_record.worked_out": -910 });
    });

    it("products by size, the unlinked SKU, totals and rounding", () => {
      const products = mtd.sections.products;
      expect(products.status).toBe("ok");
      expect(products.top).toEqual([
        expect.objectContaining({ groupKey: "v:101", productName: "Toploaders", sizeName: "25 pack", sku: "TL-25", unitsPerVariant: 25,
          packs: 14, pieces: 350, billedForProduct: 8420, billedOnFullyCosted: 5520, costOfGoods: 3143, keptOnProduct: 2377, packsShipped: 13 }),
        expect.objectContaining({ groupKey: "v:102", productName: "Penny sleeves", sizeName: "100 pack", sku: "PS-100", unitsPerVariant: 100,
          packs: 6, pieces: 600, billedForProduct: 4400, billedOnFullyCosted: 2000, costOfGoods: 622, keptOnProduct: 1378, packsShipped: 5 }),
        expect.objectContaining({ groupKey: "sku:MYSTERY-1", productVariantId: null, sku: "MYSTERY-1",
          packs: 1, pieces: null, linesWithoutPieces: 1, billedForProduct: 500 }),
      ]);
      expect(products.others).toBeNull();
      expect(products.total).toMatchObject({ packs: 21, pieces: 950, packsFullyCosted: 11, packsShipped: 18, costOfGoods: 3764, keptOnProduct: 3756 });
      expect(products.roundingCents).toEqual({ costOfGoods: -1, keptOnProduct: 1 });
      expect(amountsOf(mtd, "products")).toMatchObject({ "products.billed": 13_320, "products.packs": 21, "products.pieces": 950 });
      expect(lineOf(mtd, "products", "products.pieces")).toMatchObject({ status: "partial", reasonKey: "pieces_not_recorded" });
    });

    it("vendors: Acme, PackRat and V14, which owes us", () => {
      const vendors = mtd.sections.vendors;
      expect(vendors.status).toBe("ok");
      // Wallet columns worked from the seeded ledger (the wallets equal it, W1–W3): Acme holds
      // 370,500 deposited − 13,630 orders − 10 − 300 + 1,100 + 1,200 − 10,000 + 10,000 − 2,000 = 356,860;
      // PackRat 30,000 − 7,000 + 600 + 800 − 150 = 24,250. Cash in leaves out the 2,500 staff credit.
      expect(vendors.top).toEqual([
        expect.objectContaining({ vendorId: 12, name: "Acme TCG", orders: 5, billed: 11_730, keptOnOrders: 2511, feesCharged: 610,
          returnCreditsPaid: 1200, kept: 1921, cashIn: 60_300, creditsToVendor: 2300, weOweNow: 356_860, theyOweNow: 0, onTheWay: 0, pointsHeld: 1280 }),
        expect.objectContaining({ vendorId: 13, name: "PackRat", orders: 5, billed: 7000, keptOnOrders: 1369, feesCharged: 150,
          returnCreditsPaid: 800, kept: 719, cashIn: 30_000, creditsToVendor: 1400, weOweNow: 24_250, theyOweNow: 0, onTheWay: 15_000, pointsHeld: 250 }),
        expect.objectContaining({ vendorId: 14, name: "Vendor #14", nameSource: "id", status: "paused", orders: 0,
          weOweNow: 0, theyOweNow: 1250, onTheWay: 4000, pointsHeld: 0 }),
      ]);
      expect(vendors.total).toMatchObject({ vendors: 3, orders: 10, billed: 18_730, keptOnOrders: 3881, kept: 2641, weOweNow: 381_110, theyOweNow: 1250 });
      expect(vendors.roundingCents).toEqual({ keptOnOrders: 1, kept: 1 });
    });

    it("checks: D6, K2, N1 and N2 need a look; the other 23 are fine", () => {
      const results = checkResults(mtd);
      expect(Object.keys(results).sort()).toEqual([...FINANCE_CHECK_IDS].sort());
      for (const id of FINANCE_CHECK_IDS) {
        expect([id, results[id]]).toEqual([id, CHECKS_NEEDING_A_LOOK_MTD.includes(id) ? "needs_a_look" : "fine"]);
      }
      // V14's deposit pending since Sep 20; J's shipped line with no cost row; K charged but cancelled; the expired hold's OMS order.
      expect(checkOf(mtd, "D6")).toMatchObject({ exceptions: 1 });
      expect(checkOf(mtd, "K2")).toMatchObject({ exceptions: 1 });
      expect(checkOf(mtd, "N1")).toMatchObject({ exceptions: 1, difference: 800 });
      expect(checkOf(mtd, "N2")).toMatchObject({ exceptions: 1 });
      expect(checkOf(mtd, "P2")).toMatchObject({ examined: FINANCE_TABLES.length, exceptions: 0 });
    });

    it("the Overview bridge ties the OMS row to what we billed", () => {
      // Worked from the seed: OMS orders on the channel ordered Oct 1–5 Eastern and not cancelled are
      // A–J (17,930) plus the expired hold's pending order 5101 (1,800). K is cancelled in OMS (−800).
      expect(infoLines(mtd, "overview_bridge")).toEqual({
        "info.overview_bridge.oms_row": 19_730,
        "info.overview_bridge.billed": 18_730,
        "info.overview_bridge.leftover_pending": 1800,
        "info.overview_bridge.cancelled_in_oms": -800,
        "info.overview_bridge.date_basis": 0,
      });
    });

    it("logs one summary line and no failure", () => {
      expect(run.logs.map((entry) => [entry.level, entry.action])).toEqual([["info", "dropship.finance.summary_served"]]);
      expect(run.logs[0].data).toMatchObject({ outcome: "served", checks_needing_look: [...CHECKS_NEEDING_A_LOOK_MTD], checks_not_run: [] });
    });
  });

  // ── other periods and scopes ──────────────────────────────────────────

  it("last month: P1 and H (the 03:30Z boundary), balances at the end, August compares as new", async () => {
    const run = financeService(baseSchema);
    const summary = await run.summary({ period: "last-month" });
    expect(summary.period).toMatchObject({ fromDate: "2026-09-01", toDate: "2026-09-30", startAt: "2026-09-01T04:00:00.000Z",
      endAt: "2026-10-01T04:00:00.000Z", endsNow: false });
    expect(summary.answer).toMatchObject({ orders: 2, billed: 4100, keptOnOrders: 1710, marginTenths: 417, fullyCosted: { orders: 2, billed: 4100 } });
    // E = {P1, H}: two packs of each size, nothing else (rows ranked by billed). KO = P1 (2,600 − 1,000 − 500 − 50 = 1,050) + H (1,500 − 500 − 300 − 40 = 660).
    expect(summary.sections.products.top.map((row) => [row.groupKey, row.packs, row.costOfGoods])).toEqual([["v:102", 2, 1000], ["v:101", 2, 500]]);
    expect(summary.tiles).toMatchObject({
      billed: { amount: 4100, prior: { amount: 0, kind: "new" } },
      weOweNow: { amount: 381_110, atEndOfPeriod: 303_900 },
      owedToUsNow: { amount: 1250, atEndOfPeriod: 1250 },
    });
    expect(amountsOf(summary, "owed")).toMatchObject({ "owed.walk.on_the_way": 54_000, "owed.walk.we_owe": 303_900, "owed.walk.they_owe": 1250 });
    expect(amountsOf(summary, "points")).toMatchObject({ "points.held": 3080 });
    expect(amountsOf(summary, "pool")).toMatchObject({ "pool.closing": 90 });
    expect(amountsOf(summary, "cash")).toMatchObject({ "cash.received_deposits": 300_000, "cash.ach": 300_000 });
    expect([...summary.notes].sort()).toEqual(["card_fee_era", "pricing_v1_era", "weekly_collection_era"]);
  });

  it("scoped to vendor 12: its orders and money only; program-wide checks say so", async () => {
    const run = financeService(baseSchema);
    const summary = await run.summary({ vendorId: "12" });
    expect(summary.scope).toEqual({ vendor: { vendorId: 12, name: "Acme TCG", nameSource: "business_name" } });
    expect(summary.answer).toMatchObject({ orders: 5, billed: 11_730, fullyCosted: { orders: 2 }, keptOnOrders: 2511 });
    const results = checkResults(summary);
    expect(results.K2).toBe("needs_a_look");
    expect(results.N2).toBe("program_wide");
    expect(results.P2).toBe("program_wide");
    expect(Object.entries(results).filter(([, result]) => result !== "fine").map(([id]) => id).sort()).toEqual(["K2", "N2", "P2"]);
    // The pool's own record is program-wide; the vendor's view leaves the bridge out.
    expect(lineOf(summary, "pool", "pool.record")).toMatchObject({ status: "unavailable", reasonKey: "program_wide" });
    expect(summary.info.some((info) => info.key === "overview_bridge")).toBe(false);
  });

  it("all time: every seeded order and nothing to compare with", async () => {
    const summary = await financeService(baseSchema).summary({ period: "all" });
    expect(summary.comparePeriod).toBeNull();
    expect(summary.period).toMatchObject({ startAt: null, endsNow: true });
    expect(summary.answer).toMatchObject({ orders: FINANCE_FIXTURE_ORDERS.length, billed: 18_730 + 4100 });
  });

  // Worked from the seed: last 30 days adds H; qtd is the month; ytd adds P1 and H; Oct 5 alone has only
  // E and F, both still waiting. D6, N1 and N2 look at now or all time, so they follow the vendor, not the
  // period; K2 follows J (Acme, Oct 2). A vendor's view reports N2 and P2 as program-wide.
  interface ScopeCase {
    readonly query: Readonly<Record<string, string>>;
    readonly state: string;
    readonly orders: number;
    readonly flagged: readonly FinanceCheckId[];
    readonly programWide: readonly FinanceCheckId[];
  }
  const SAME_AS_MTD: readonly FinanceCheckId[] = ["D6", "K2", "N1", "N2"];
  const NOW_CHECKS: readonly FinanceCheckId[] = ["D6", "N1", "N2"];
  it.each<ScopeCase>([
    { query: { period: "last-30" }, state: "kept", orders: 11, flagged: SAME_AS_MTD, programWide: [] },
    { query: { period: "qtd" }, state: "kept", orders: 10, flagged: SAME_AS_MTD, programWide: [] },
    { query: { period: "ytd" }, state: "kept", orders: 12, flagged: SAME_AS_MTD, programWide: [] },
    { query: { compare: "off" }, state: "kept", orders: 10, flagged: SAME_AS_MTD, programWide: [] },
    { query: { period: "last-month", compare: "off" }, state: "kept", orders: 2, flagged: NOW_CHECKS, programWide: [] },
    { query: { vendorId: "13" }, state: "kept", orders: 5, flagged: ["N1"], programWide: ["N2", "P2"] },
    { query: { vendorId: "14" }, state: "no_orders", orders: 0, flagged: ["D6"], programWide: ["N2", "P2"] },
    { query: { period: "last-month", vendorId: "14" }, state: "no_orders", orders: 0, flagged: ["D6"], programWide: ["N2", "P2"] },
    { query: { period: "all", vendorId: "13" }, state: "kept", orders: 5, flagged: ["N1"], programWide: ["N2", "P2"] },
    { query: { period: "custom", from: "2000-01-01", to: "2000-01-31" }, state: "no_orders", orders: 0, flagged: NOW_CHECKS, programWide: [] },
    { query: { period: "custom", from: "2026-10-05", to: "2026-10-05" }, state: "not_ready", orders: 2, flagged: NOW_CHECKS, programWide: [] },
  ])("renders $query with every section read and the expected checks flagged", async ({ query, state, orders, flagged, programWide }) => {
    const run = financeService(baseSchema);
    const summary = await run.summary({ ...query });
    expect(financeSummarySchema.safeParse(summary).success).toBe(true);
    expect(summary.answer).toMatchObject({ state, orders });
    expect(Object.values(summary.sections).map((section) => section.status)).toEqual(Object.values(summary.sections).map(() => "ok"));
    const results = checkResults(summary);
    expect(Object.keys(results).filter((id) => results[id] === "needs_a_look").sort()).toEqual([...flagged].sort());
    expect(Object.keys(results).filter((id) => results[id] === "program_wide").sort()).toEqual([...programWide].sort());
    expect(Object.values(results).filter((result) => result === "could_not_check")).toEqual([]);
    if (query.compare === "off") expect(summary.comparePeriod).toBeNull();
    expect(run.logs.filter((entry) => entry.level !== "info")).toEqual([]);
  });

  it("an unknown vendor is refused before any section runs", async () => {
    const run = financeService(baseSchema);
    await expect(run.summary({ vendorId: "99" })).rejects.toMatchObject({ code: "DROPSHIP_FINANCE_VENDOR_NOT_FOUND" });
    expect(run.statements.some((text) => text.startsWith("SAVEPOINT"))).toBe(false);
    expect(run.releases).toEqual([false]);
  });

  // ── SQL and TypeScript agree ──────────────────────────────────────────

  it("the SQL waiting reason and classifyWaitingReason agree for every seeded order", async () => {
    const text = `WITH ${orderEconomicsCte(ALL_TABLES)}
SELECT intake_id, waiting_reason, oms_cancelled, shipped_packs, ordered_packs, any_shared, labels, labels_costed, lines_cost_mismatch
FROM classified ORDER BY intake_id`;
    const bag: Record<string, unknown> = { startBound: "-infinity", endBound: "infinity", vendorId: null, intakeId: null };
    const result = await pool.query(qualifyFinanceSql(text, baseSchema), ORDER_CTE_PARAMS.map((param) => bag[param]));
    const expected = new Map(FINANCE_FIXTURE_ORDERS.map((order) => [order.intakeId, order.expectedWaitingReason]));
    expect(result.rows.map((row) => row.intake_id)).toEqual([...expected.keys()].sort((a, b) => a - b));
    for (const row of result.rows) {
      const typescript = classifyWaitingReason({
        omsCancelled: row.oms_cancelled,
        shippedPacks: BigInt(row.shipped_packs),
        orderedPacks: BigInt(row.ordered_packs),
        anyShared: row.any_shared,
        labels: BigInt(row.labels),
        labelsCosted: BigInt(row.labels_costed),
        linesCostMismatch: BigInt(row.lines_cost_mismatch),
      });
      expect({ intake: row.intake_id, sql: row.waiting_reason, typescript }).toEqual({
        intake: row.intake_id, sql: expected.get(row.intake_id), typescript: expected.get(row.intake_id),
      });
    }
  });

  it("sqlRoundMills rounds signed mills to cents exactly like signedMillsToCents", async () => {
    const mills = ["-9000000000000000049", "-151", "-150", "-149", "-51", "-50", "-49", "-1", "0", "1", "49", "50", "51", "149", "150", "151",
      "9007199254740993", "9000000000000000049"];
    const result = await pool.query(`SELECT v::text AS mills, ${sqlRoundMills("v")}::text AS cents FROM unnest($1::bigint[]) WITH ORDINALITY AS t(v, n) ORDER BY n`, [mills]);
    expect(result.rows).toEqual(mills.map((value) => ({ mills: value, cents: signedMillsToCents(BigInt(value)).toString() })));
  });

  // ── variants ──────────────────────────────────────────────────────────

  it("DST: custom Nov 1 runs 25 hours; 04:30Z on both days counts, 05:00Z on Nov 2 does not", async () => {
    const schema = await variantSchema("dst", { dstOrders: true });
    const summary = await financeService(schema, { now: FINANCE_FIXTURE_DST_NOW }).summary({ period: "custom", from: "2026-11-01", to: "2026-11-01" });
    expect(summary.period).toMatchObject({ fromDate: "2026-11-01", toDate: "2026-11-01", startAt: "2026-11-01T04:00:00.000Z",
      endAt: "2026-11-02T05:00:00.000Z", endsNow: false });
    const hours = (Date.parse(summary.period.endAt) - Date.parse(summary.period.startAt as string)) / 3_600_000;
    expect(hours).toBe(25);
    const inside = FINANCE_DST_ORDERS.filter((order) => order.key !== "DST-OUT");
    const billed = inside.reduce((sum, order) => sum + order.paidCash + order.paidPoints, 0);
    expect(summary.answer).toMatchObject({ orders: 2, billed });
    expect(lineOf(summary, "sales", "sales.waiting.not_shipped")).toMatchObject({ amount: billed, count: 2 });
  });

  it("a malformed chargedCents makes the card line partial and D7 (and D1) need a look", async () => {
    const schema = await variantSchema("charged");
    // A float where whole cents belong: metadata->>'chargedCents' reads "10300.5".
    await pool.query(qualifyFinanceSql(`UPDATE dropship.dropship_wallet_ledger
      SET metadata = metadata || '{"chargedCents": 10300.5}'::jsonb
      WHERE reference_type = $1::varchar AND reference_id = $2::varchar`, schema),
    [FIXTURE_LEDGER_REFERENCES.cardDeposit.referenceType, FIXTURE_LEDGER_REFERENCES.cardDeposit.referenceId]);
    const summary = await financeService(schema).summary();
    // The unreadable charge falls back to the credited amount (10,000), flagged partial.
    expect(lineOf(summary, "cash", "cash.card")).toMatchObject({ amount: 10_000, status: "partial", reasonKey: "metadata_malformed" });
    expect(lineOf(summary, "cash", "cash.received_deposits")).toMatchObject({ amount: 90_000, status: "partial" });
    expect(summary.tiles.cashReceived).toMatchObject({ amount: 88_000, status: "partial" });
    expect(checkOf(summary, "D7")).toMatchObject({ result: "needs_a_look", exceptions: 1 });
    expect(checkOf(summary, "D1")).toMatchObject({ result: "needs_a_look", exceptions: 1 });
  });

  it("a missing disputeAmountCents makes the pulled-back line partial", async () => {
    const schema = await variantSchema("dispute");
    await pool.query(qualifyFinanceSql(`UPDATE dropship.dropship_wallet_ledger
      SET metadata = metadata - 'disputeAmountCents'
      WHERE reference_type = $1::varchar AND reference_id = $2::varchar`, schema),
    [FIXTURE_LEDGER_REFERENCES.openDispute.referenceType, FIXTURE_LEDGER_REFERENCES.openDispute.referenceId]);
    const summary = await financeService(schema).summary();
    // Only dp_1's 10,300 can be read; dp_2 still counts as a pull-back.
    expect(lineOf(summary, "cash", "cash.pulled_back")).toMatchObject({ amount: 10_300, count: 2, status: "partial", reasonKey: "dispute_amount_missing" });
    expect(lineOf(summary, "cash", "cash.received")).toMatchObject({ amount: 90_300, status: "partial", reasonKey: "dispute_amount_missing" });
    expect(lineOf(summary, "cash", "cash.memo.not_won_back")).toMatchObject({ amount: 0, count: 1 });
    expect(checkOf(summary, "D7")).toMatchObject({ result: "needs_a_look", exceptions: 1 });
  });

  it("a missing optional table: D4 could not check, P2 lists it, the page still renders", async () => {
    const schema = await variantSchema("nousdc");
    await pool.query(qualifyFinanceSql("DROP TABLE dropship.dropship_usdc_ledger_entries", schema));
    const run = financeService(schema);
    const summary = await run.summary();
    expect(checkOf(summary, "D4")).toMatchObject({ result: "could_not_check", errorCode: "DROPSHIP_FINANCE_TABLE_MISSING" });
    expect(checkOf(summary, "P2")).toMatchObject({ result: "needs_a_look", examined: FINANCE_TABLES.length, exceptions: 1 });
    expect(summary.sections.cash.status).toBe("ok");
    expect(lineOf(summary, "cash", "cash.usdc").amount).toBe(25_000);
    expect(summary.answer).toMatchObject({ status: "ok", kept: { amount: 2641 } });
  });

  it("every optional table missing: the other SQL branches run, the page renders, only their lines and checks give way", async () => {
    const schema = await variantSchema("nooptional");
    const optional = FINANCE_TABLES.filter((table) => table.kind === "optional");
    for (const table of optional) await pool.query(qualifyFinanceSql(`DROP TABLE ${table.relation}`, schema));
    const run = financeService(schema);
    const summary = await run.summary();
    expect(financeSummarySchema.safeParse(summary).success).toBe(true);
    expect(Object.values(summary.sections).map((section) => section.status)).toEqual(Object.values(summary.sections).map(() => "ok"));
    // What needs no optional table is unchanged.
    expect(summary.answer).toMatchObject({ status: "ok", state: "kept", kept: { amount: 2641 }, keptOnOrders: 3881 });
    expect(lineOf(summary, "cash", "cash.received").amount).toBe(88_300);
    expect(lineOf(summary, "owed", "owed.walk.closing").amount).toBe(379_860);
    expect(lineOf(summary, "returns", "returns.fees").amount).toBe(450);
    const tableMissing = (section: FinanceSectionKey) => linesOf(summary, section)
      .filter((line) => line.status === "unavailable" && line.reasonKey === "table_missing" && line.errorCode === "DROPSHIP_FINANCE_TABLE_MISSING")
      .map((line) => line.key);
    expect(tableMissing("sales")).toEqual(["sales.billed.carrier_estimate", "sales.billed.markup", "sales.never_charged.would_have_charged"]);
    expect(tableMissing("returns")).toEqual(["returns.fees.restocking", "returns.fees.processing", "returns.fees.return_label"]);
    expect(tableMissing("points")).toEqual(["points.expiry.next_30_days", "points.expiry.days_31_to_90", "points.expiry.later", "points.expiry.never"]);
    expect(tableMissing("pool")).toEqual(["pool.opening", "pool.topped_up", "pool.closing", "pool.claims", "pool.record"]);
    expect(tableMissing("products")).toEqual(["products.pieces"]);
    const couldNotCheck = summary.checks.filter((check) => check.result === "could_not_check");
    expect(couldNotCheck.map((check) => [check.id, check.errorCode])).toEqual(
      ["W3", "O3", "D4", "D5", "R1", "R2"].map((id) => [id, "DROPSHIP_FINANCE_TABLE_MISSING"]));
    expect(checkOf(summary, "P2")).toMatchObject({ result: "needs_a_look", examined: FINANCE_TABLES.length, exceptions: optional.length });
    expect(summary.info.some((info) => info.key === "pool_record")).toBe(false);
  });

  it("a statement timeout in one section fails that section while the others render", async () => {
    const schema = await variantSchema("timeout");
    const products = productsStatement(ALL_TABLES).text;
    // The products statement is the only one that reads the catalog. Another session holds the
    // variants table, so the statement must wait, and a short timeout set just before it is sure to
    // fire. 50ms rather than the contract's 1ms: the limit stays in force until the ROLLBACK TO
    // SAVEPOINT that follows the failure has finished, and 1ms could cancel that too on a slow host.
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(qualifyFinanceSql("LOCK TABLE catalog.product_variants IN ACCESS EXCLUSIVE MODE", schema));
      const run = financeService(schema, {
        beforeQuery: async (text, client) => {
          if (text === products) await client.query(`SET LOCAL statement_timeout = '${SECTION_TIMEOUT_MS}ms'`);
        },
      });
      const summary = await run.summary();
      expect(summary.sections.products).toMatchObject({ status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT", lines: [] });
      for (const section of ["sales", "cash", "returns", "owed", "points", "pool", "vendors"] as const) {
        expect([section, summary.sections[section].status]).toEqual([section, "ok"]);
      }
      expect(summary.answer).toMatchObject({ status: "ok", kept: { amount: 2641 } });
      // The savepoint rollback undid the short timeout: every check after products still ran.
      expect(summary.checks.filter((check) => check.result === "could_not_check")).toEqual([]);
      const failures = run.logs.filter((entry) => entry.action === "dropship.finance.section_failed");
      expect(failures).toEqual([expect.objectContaining({
        level: "warn",
        data: expect.objectContaining({ section: "products", error_code: "DROPSHIP_FINANCE_QUERY_TIMEOUT", sql_state: "57014", error_class: "transient" }),
      })]);
      expect(run.releases).toEqual([false]);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  });
});
