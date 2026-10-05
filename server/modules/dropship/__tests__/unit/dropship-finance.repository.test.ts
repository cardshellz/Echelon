import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

import { resolveFinancePeriod, type FinanceLocalWindow } from "../../domain/program-finance-period";
import { FINANCE_TABLES, type FinanceRawTables, type FinanceTableKey } from "../../domain/program-finance-raw";
import type { FinanceSummaryReadRequest } from "../../application/dropship-finance-service";
import type { FinanceBudgetClock } from "../../infrastructure/dropship-finance-read-transaction";
import {
  FINANCE_BUSY_CODE,
  FinanceRequestSemaphore,
  PgDropshipFinanceRepository,
  mapCheckCounts,
  mapLedgerGroups,
  mapOrders,
  mapProducts,
  mapVendors,
  mapWallets,
} from "../../infrastructure/dropship-finance.repository";
import {
  FINANCE_CHECK_SQL,
  FINANCE_FIRST_FAILURE_CODE,
  FINANCE_ISO_PLUS_INFINITY,
  FINANCE_LEDGER_GROUPS,
  FINANCE_NOT_WON_BACK,
  FINANCE_OVERVIEW_BRIDGE,
  FINANCE_POOL_CLAIMS,
  FINANCE_Q0,
  FINANCE_VENDOR_LOOKUP,
  FINANCE_WON_DISPUTES,
  checkCountsSql,
  neverChargedStatement,
  ordersStatement,
  poolStatement,
  productsStatement,
  returnFeesStatement,
  vendorsStatement,
  walletsStatement,
  type FinanceSqlStatement,
} from "../../infrastructure/dropship-finance-sql";

const NOW = new Date("2026-10-05T13:14:00.000Z");
const TZ = "America/New_York";
const mtd = resolveFinancePeriod("mtd", null, null, NOW, TZ);
const lastMonth = resolveFinancePeriod("last-month", null, null, NOW, TZ);

const START_BOUND = "2026-10-01 04:00:00+00";
const CMP_START_BOUND = "2026-09-01 04:00:00+00";
const CMP_END_BOUND = "2026-09-05 13:14:00+00";
const CONTROL = /^(BEGIN|SET LOCAL|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK|COMMIT)/;

function allTables(overrides: Partial<Record<FinanceTableKey, boolean>> = {}): FinanceRawTables {
  return { ...Object.fromEntries(FINANCE_TABLES.map((table) => [table.key, true])), ...overrides } as FinanceRawTables;
}

function q0Row(window: FinanceLocalWindow, compare: FinanceLocalWindow | null, tables: FinanceRawTables) {
  return {
    start_at: window.startAt,
    start_bound: window.startAt ? START_BOUND : "-infinity",
    end_at: window.endAt,
    end_bound: window.endsNow ? "infinity" : "2026-10-01 04:00:00+00",
    cmp_start_at: compare?.startAt ?? null,
    cmp_start_bound: compare ? CMP_START_BOUND : null,
    cmp_end_at: compare?.endAt ?? null,
    cmp_end_bound: compare ? CMP_END_BOUND : null,
    ...Object.fromEntries(FINANCE_TABLES.map((table) => [`t_${table.key}`, tables[table.key]])),
  };
}

interface Call {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface Fake {
  readonly calls: Call[];
  readonly release: ReturnType<typeof vi.fn>;
  readonly pool: Pick<Pool, "connect">;
  /** The statements a section ran (control statements left out). */
  statements(): Call[];
}

interface FakeOptions {
  readonly window?: FinanceLocalWindow;
  readonly compare?: FinanceLocalWindow | null;
  readonly tables?: FinanceRawTables;
  readonly vendor?: Record<string, unknown> | null;
  /** Return rows for a statement, or throw to fail it; undefined falls back to the defaults. */
  readonly respond?: (text: string, values: readonly unknown[]) => Record<string, unknown>[] | undefined;
  readonly fail?: (text: string) => Error | null;
}

function fakePool(options: FakeOptions = {}): Fake {
  const window = options.window ?? mtd.current;
  const compare = options.compare === undefined ? mtd.compare : options.compare;
  const tables = options.tables ?? allTables();
  const calls: Call[] = [];
  const release = vi.fn();
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });
    const error = options.fail?.(text);
    if (error) throw error;
    if (CONTROL.test(text)) return { rows: [] };
    const custom = options.respond?.(text, values);
    if (custom) return { rows: custom };
    if (text.includes("to_regclass(")) return { rows: [q0Row(window, compare, tables)] };
    if (text.includes("FROM dropship.dropship_vendors v\nWHERE v.id")) {
      return { rows: options.vendor === null ? [] : [options.vendor ?? { vendor_id: 12, business_name: "Acme TCG", contact_name: null }] };
    }
    if (text.includes("AS examined")) return { rows: [{ examined: "3", exceptions: "0", difference: null }] };
    return { rows: [] };
  });
  const client = { query, release } as unknown as PoolClient;
  return {
    calls,
    release,
    pool: { connect: vi.fn(async () => client) } as unknown as Pick<Pool, "connect">,
    statements: () => calls.filter((call) => !CONTROL.test(call.text)),
  };
}

function request(overrides: Partial<FinanceSummaryReadRequest> = {}): FinanceSummaryReadRequest {
  return { period: mtd.current, comparePeriod: mtd.compare, now: NOW, vendorId: null, ...overrides };
}

function repositoryFor(fake: Fake, options: { clock?: FinanceBudgetClock; semaphore?: FinanceRequestSemaphore; busyWaitMs?: number } = {}) {
  return new PgDropshipFinanceRepository(fake.pool, { semaphore: options.semaphore ?? new FinanceRequestSemaphore(2), ...options });
}

const sectionNames = (outcomes: readonly { name: string }[]) => outcomes.map((outcome) => outcome.name);

describe("PgDropshipFinanceRepository.readSummary", () => {
  it("runs Q0, then every section in its own savepoint, in order, the bridge and K3 last, then commits", async () => {
    const fake = fakePool();
    const read = await repositoryFor(fake).readSummary(request());

    expect(fake.calls.slice(0, 3).map((call) => call.text)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SET LOCAL statement_timeout = '8s'",
      "SET LOCAL TIME ZONE 'UTC'",
    ]);
    expect(fake.calls[3].text).toBe(FINANCE_Q0.text);
    expect(fake.calls.at(-1)?.text).toBe("COMMIT");
    expect(fake.release).toHaveBeenCalledWith(false);
    // Every statement after Q0 sits between its own SAVEPOINT and RELEASE.
    const afterQ0 = fake.calls.slice(4, -1).map((call) => call.text);
    let open: string | null = null;
    for (const text of afterQ0) {
      const savepoint = /^SAVEPOINT (fin_\d+)$/.exec(text);
      const released = /^RELEASE SAVEPOINT (fin_\d+)$/.exec(text);
      if (savepoint) { expect(open).toBeNull(); open = savepoint[1]; continue; }
      if (released) { expect(released[1]).toBe(open); open = null; continue; }
      expect(open).not.toBeNull();
    }
    expect(sectionNames(read.statements)).toEqual([
      "orders", "compare_orders", "products", "never_charged", "ledger", "disputes", "return_fees", "wallets", "pool", "vendors",
      "check_W1", "check_W2", "check_W3", "check_W4", "check_O1", "check_O2", "check_O3", "check_O4", "check_O5", "check_O6",
      "check_D1", "check_D2", "check_D3", "check_D4", "check_D5", "check_D6", "check_D7", "check_K1", "check_K2",
      "check_R1", "check_R2", "check_N1", "check_N2", "check_N3", "overview_bridge", "check_K3",
    ]);
    expect(read.statements.every((outcome) => outcome.status === "ok")).toBe(true);
    expect(read.vendor).toBeNull();
    expect(Object.keys(read.raw.checks).sort()).toEqual(FINANCE_CHECK_SQL.map((check) => check.id).sort());
    expect(read.raw.bridge).toMatchObject({ status: "ok" });
  });

  it("passes the local bounds and the injected clock to Q0, and Q0's bounds to every later statement", async () => {
    const fake = fakePool();
    const read = await repositoryFor(fake).readSummary(request());
    const statements = fake.statements();

    expect(statements[0].values).toEqual([
      "2026-10-01T00:00:00.000", "2026-10-06T00:00:00.000", NOW.toISOString(), "2026-09-01T00:00:00.000", "2026-09-05T09:14:00.000",
    ]);
    const orders = statements.filter((call) => call.text === ordersStatement(allTables()).text);
    // A period that ends now has an open upper bound (contract C6); the comparison runs on its own bounds.
    expect(orders.map((call) => call.values)).toEqual([[START_BOUND, "infinity", null, null], [CMP_START_BOUND, CMP_END_BOUND, null, null]]);
    const ledger = statements.find((call) => call.text === FINANCE_LEDGER_GROUPS.text);
    expect(ledger?.values).toEqual([START_BOUND, "infinity", CMP_START_BOUND, CMP_END_BOUND, null, "2026-10-01T04:00:00.000Z", FINANCE_ISO_PLUS_INFINITY, NOW.toISOString()]);
    const bridge = statements.find((call) => call.text === FINANCE_OVERVIEW_BRIDGE.text);
    expect(bridge?.values).toEqual(["2026-10-01T00:00:00.000", "infinity"]);
    // K3 looks at every order accepted before now − 14 days.
    expect(statements.at(-1)?.values).toEqual(["-infinity", "2026-09-21T13:14:00.000Z", null, null]);
    expect(read.raw.bounds).toEqual({ startAt: mtd.current.startAt, endAt: NOW, compareStartAt: mtd.compare?.startAt, compareEndAt: mtd.compare?.endAt });
  });

  it("closes a past period on its own end bound and sends no comparison when there is none", async () => {
    const fake = fakePool({ window: lastMonth.current, compare: null });
    const read = await repositoryFor(fake).readSummary(request({ period: lastMonth.current, comparePeriod: null }));
    const statements = fake.statements();

    expect(statements[0].values).toEqual(["2026-09-01T00:00:00.000", "2026-10-01T00:00:00.000", NOW.toISOString(), null, null]);
    expect(sectionNames(read.statements)).not.toContain("compare_orders");
    expect(read.raw.compareOrders).toBeNull();
    const ledger = statements.find((call) => call.text === FINANCE_LEDGER_GROUPS.text);
    expect(ledger?.values).toEqual([START_BOUND, "2026-10-01 04:00:00+00", null, null, null, "2026-09-01T04:00:00.000Z", "2026-10-01T04:00:00.000Z", NOW.toISOString()]);
    const bridge = statements.find((call) => call.text === FINANCE_OVERVIEW_BRIDGE.text);
    expect(bridge?.values).toEqual(["2026-09-01T00:00:00.000", "2026-10-01T00:00:00.000"]);
  });

  it("scopes every statement to the vendor, looks the vendor up, and leaves out the program-only reads", async () => {
    const fake = fakePool();
    const read = await repositoryFor(fake).readSummary(request({ vendorId: 12 }));
    const statements = fake.statements();

    expect(statements[1]).toEqual({ text: FINANCE_VENDOR_LOOKUP.text, values: [12] });
    expect(read.vendor).toEqual({ vendorId: 12, businessName: "Acme TCG", contactName: null });
    expect(sectionNames(read.statements)).not.toContain("check_N2");
    expect(sectionNames(read.statements)).not.toContain("overview_bridge");
    expect(read.raw.bridge).toBeNull();
    expect(read.raw.checks.N2).toBeUndefined();
    const orders = statements.find((call) => call.text === ordersStatement(allTables()).text);
    expect(orders?.values).toEqual([START_BOUND, "infinity", 12, null]);
    expect(statements.find((call) => call.text === FINANCE_LEDGER_GROUPS.text)?.values[4]).toBe(12);
  });

  it("refuses an unknown vendor before reading anything else, and rolls back", async () => {
    const fake = fakePool({ vendor: null });
    await expect(repositoryFor(fake).readSummary(request({ vendorId: 999 })))
      .rejects.toMatchObject({ code: "DROPSHIP_FINANCE_VENDOR_NOT_FOUND", context: { vendorId: 999 } });
    expect(fake.statements()).toHaveLength(2);
    expect(fake.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rolls a failing section back to its savepoint and still reads every other section", async () => {
    const products = productsStatement(allTables()).text;
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const fake = fakePool({ fail: (text) => (text === products ? timeout : null) });
    const read = await repositoryFor(fake).readSummary(request());

    expect(read.raw.products).toEqual({ status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT" });
    expect(read.raw.orders.status).toBe("ok");
    expect(read.raw.vendors.status).toBe("ok");
    expect(fake.calls.map((call) => call.text)).toContain("ROLLBACK TO SAVEPOINT fin_3");
    expect(read.statements.find((outcome) => outcome.name === "products")).toMatchObject({ status: "error", sqlState: "57014" });
    expect(fake.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("skips every later section once the request budget is spent", async () => {
    let now = NOW.getTime();
    const clock: FinanceBudgetClock = { now: () => new Date(now) };
    const vendorsSql = vendorsStatement(allTables()).text;
    const fake = fakePool({
      respond: (text) => {
        // The vendors read takes 21s: everything after it is over budget.
        if (text === vendorsSql) now += 21_000;
        return undefined;
      },
    });
    const read = await repositoryFor(fake, { clock }).readSummary(request());

    expect(read.raw.vendors.status).toBe("ok");
    expect(read.raw.checks.W1).toEqual({ status: "skipped", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED" });
    expect(read.raw.checks.K3).toEqual({ status: "skipped", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED" });
    expect(read.raw.bridge).toEqual({ status: "skipped", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED" });
    expect(fake.statements().at(-1)?.text).toBe(vendorsSql);
    expect(fake.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("skips the ledger section when the budget runs out between its two statements, and never sends the second", async () => {
    let now = NOW.getTime();
    const clock: FinanceBudgetClock = { now: () => new Date(now) };
    const fake = fakePool({
      respond: (text) => {
        // Q4 takes 21s: the first-failure query that follows it in the same section is over budget.
        if (text === FINANCE_LEDGER_GROUPS.text) now += 21_000;
        return undefined;
      },
    });
    const read = await repositoryFor(fake, { clock }).readSummary(request());

    expect(read.raw.ledger).toEqual({ status: "skipped", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED" });
    expect(read.raw.disputes).toEqual({ status: "skipped", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED" });
    expect(fake.statements().map((call) => call.text)).not.toContain(FINANCE_FIRST_FAILURE_CODE.text);
    expect(fake.statements().at(-1)?.text).toBe(FINANCE_LEDGER_GROUPS.text);
    expect(read.statements.find((outcome) => outcome.name === "ledger")).toMatchObject({ status: "skipped", durationMs: 21_000 });
    expect(fake.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("starts the budget before the wait for a slot: a request that waited past it runs Q0 and skips every section", async () => {
    let now = NOW.getTime();
    const clock: FinanceBudgetClock = { now: () => new Date(now) };
    const semaphore = new FinanceRequestSemaphore(1);
    const hold = await semaphore.acquire(10);
    const fake = fakePool();
    const pending = repositoryFor(fake, { clock, semaphore, busyWaitMs: 60_000 }).readSummary(request());
    // The request waits for the slot while 21s pass on the budget clock.
    now += 21_000;
    hold();
    const read = await pending;

    expect(fake.statements().map((call) => call.text)).toEqual([FINANCE_Q0.text]);
    expect(read.statements.length).toBeGreaterThan(0);
    expect(read.statements.every((outcome) => outcome.status === "skipped" && outcome.errorCode === "DROPSHIP_FINANCE_BUDGET_EXCEEDED")).toBe(true);
    expect(semaphore.inUse()).toBe(0);
  });

  it("fails a section whose core table is missing without sending its SQL", async () => {
    const tables = allTables({ ledger: false });
    const fake = fakePool({ tables });
    const read = await repositoryFor(fake).readSummary(request());
    const tableMissing = { status: "error", errorCode: "DROPSHIP_FINANCE_TABLE_MISSING" };

    expect(read.raw.ledger).toEqual(tableMissing);
    expect(read.raw.disputes).toEqual(tableMissing);
    expect(read.raw.vendors).toEqual(tableMissing);
    expect(read.raw.checks.W1).toEqual(tableMissing);
    expect(read.raw.tables.ledger).toBe(false);
    expect(fake.statements().some((call) => call.text === FINANCE_LEDGER_GROUPS.text)).toBe(false);
    expect(read.raw.wallets.status).toBe("ok");
  });

  it("leaves an optional table's join out, so only its lines and checks go missing", async () => {
    const tables = allTables({ quotes: false, usdc: false, lots: false });
    const fake = fakePool({ tables });
    const read = await repositoryFor(fake).readSummary(request());
    const ordersCall = fake.statements().find((call) => call.text.includes("GROUPING(c.waiting_reason)"));

    expect(ordersCall?.text).not.toContain("dropship_shipping_quote_snapshots");
    // Q0 names every table in to_regclass; no other statement may read a missing one.
    expect(fake.statements().slice(1).some((call) => call.text.includes("dropship_wallet_rewards_lots"))).toBe(false);
    expect(read.raw.orders.status).toBe("ok");
    expect(read.raw.checks.O3).toEqual({ status: "error", errorCode: "DROPSHIP_FINANCE_TABLE_MISSING" });
    expect(read.raw.checks.D4).toEqual({ status: "error", errorCode: "DROPSHIP_FINANCE_TABLE_MISSING" });
    expect(read.raw.checks.W3).toEqual({ status: "error", errorCode: "DROPSHIP_FINANCE_TABLE_MISSING" });
  });

  it("fails a section whose sums are not integer text with DATA_INVALID", async () => {
    const fake = fakePool({
      respond: (text) => (text.includes("GROUPING(c.waiting_reason)") ? [{ is_total: true, waiting_reason: null, orders: "1.5" }] : undefined),
    });
    const read = await repositoryFor(fake).readSummary(request());
    expect(read.raw.orders).toEqual({ status: "error", errorCode: "DROPSHIP_FINANCE_DATA_INVALID" });
    expect(read.raw.products.status).toBe("ok");
  });

  it("returns a destroyed client to nobody when the rollback after a Q0 failure fails", async () => {
    const fake = fakePool({
      fail: (text) => {
        if (text.includes("to_regclass(")) return Object.assign(new Error("connection lost"), { code: "08006" });
        if (text === "ROLLBACK") return Object.assign(new Error("connection lost"), { code: "08006" });
        return null;
      },
    });
    await expect(repositoryFor(fake).readSummary(request())).rejects.toMatchObject({ code: "DROPSHIP_FINANCE_DB_UNAVAILABLE" });
    expect(fake.release).toHaveBeenCalledWith(true);
  });
});

describe("FinanceRequestSemaphore (contract C13)", () => {
  it("lets two requests in, refuses a third after the wait, and hands a freed slot to a waiter", async () => {
    vi.useFakeTimers();
    try {
      const semaphore = new FinanceRequestSemaphore(2);
      const first = await semaphore.acquire(2_000);
      await semaphore.acquire(2_000);
      expect(semaphore.inUse()).toBe(2);

      const refused = semaphore.acquire(2_000).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await refused).toMatchObject({ code: FINANCE_BUSY_CODE });

      const waiting = semaphore.acquire(2_000);
      first();
      first(); // releasing twice frees one slot only
      const third = await waiting;
      expect(semaphore.inUse()).toBe(2);
      third();
      expect(semaphore.inUse()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a request as busy when the repository's slots are taken, without connecting", async () => {
    const semaphore = new FinanceRequestSemaphore(1);
    const hold = await semaphore.acquire(10);
    const fake = fakePool();
    await expect(repositoryFor(fake, { semaphore, busyWaitMs: 5 }).readSummary(request())).rejects.toMatchObject({ code: FINANCE_BUSY_CODE });
    expect(fake.calls).toHaveLength(0);
    hold();
  });

  it("frees the slot when the read fails", async () => {
    const semaphore = new FinanceRequestSemaphore(1);
    const fake = fakePool({ fail: (text) => (text.includes("to_regclass(") ? new Error("boom") : null) });
    await expect(repositoryFor(fake, { semaphore }).readSummary(request())).rejects.toMatchObject({ code: "DROPSHIP_FINANCE_INTERNAL_ERROR" });
    expect(semaphore.inUse()).toBe(0);
  });
});

describe("row mapping", () => {
  it("parses numeric text into BigInt and maps NULL sums to zero", () => {
    const orders = mapOrders([
      { is_total: true, waiting_reason: null, orders: "10", fc_orders: "3", billed: "18730", billed_fc: null, cogs_mills_fc: "376400" },
      { is_total: false, waiting_reason: "shared_label", orders: "2", billed: "3300" },
      { is_total: false, waiting_reason: null, orders: "3", billed: "9730" },
    ]);
    expect(orders.totals.orders).toBe(BigInt(10));
    expect(orders.totals.billedFc).toBe(BigInt(0));
    expect(orders.totals.cogsMillsFc).toBe(BigInt(376400));
    expect(orders.byReason).toEqual([{ reason: "shared_label", orders: BigInt(2), billed: BigInt(3300) }]);
  });

  it("keeps an exact sum beyond the safe range for the builder to withhold", () => {
    const orders = mapOrders([{ is_total: true, billed: "9007199254740993" }]);
    expect(orders.totals.billed).toBe(BigInt("9007199254740993"));
  });

  it("refuses text that is not an integer, an unknown waiting reason and a non-boolean flag", () => {
    expect(() => mapOrders([{ is_total: true, billed: "1e3" }])).toThrow(/DATA_INVALID: billed/);
    expect(() => mapOrders([{ is_total: false, waiting_reason: "lost_in_space", orders: "1" }])).toThrow(/DATA_INVALID: waiting_reason/);
    expect(() => mapOrders([{ is_total: "yes" }])).toThrow(/DATA_INVALID: is_total/);
  });

  it("keeps NULL where it means not known: pieces, the wallet of a vendor without one, a check's difference", () => {
    const products = mapProducts([
      { is_total: true, packs: "1", pieces: null, lines_without_pieces: "1", unlinked_cogs_mills_fc: "0" },
      { is_total: false, group_key: "sku:MYSTERY-1", product_variant_id: null, sku: "MYSTERY-1", units_per_variant: null, packs: "1" },
    ]);
    expect(products.totals.pieces).toBeNull();
    expect(products.groups[0]).toMatchObject({ groupKey: "sku:MYSTERY-1", productVariantId: null, unitsPerVariant: null, packs: BigInt(1) });
    const [vendor] = mapVendors([{ vendor_id: 14, business_name: null, contact_name: null, status: "paused", available: null, pending: null, points: null }]);
    expect(vendor).toMatchObject({ vendorId: 14, available: null, pending: null, points: null, orders: BigInt(0) });
    expect(mapCheckCounts([{ examined: "3", exceptions: "1", difference: null }])).toEqual({ examined: BigInt(3), exceptions: BigInt(1), difference: null });
  });

  it("maps the ledger groups' cash line and flags, and refuses an unknown cash line", () => {
    const [group] = mapLedgerGroups([{ vendor_id: 13, type: "funding", status: "settled", reference_type: null, cash_line: "collection",
      rewards_rail: null, auto_reload: null, auto_reload_reason: null, chain_watcher: false, n_p: "1", charged_p: "5000" }]);
    expect(group).toMatchObject({ vendorId: 13, cashLine: "collection", chainWatcher: false, nP: BigInt(1), chargedP: BigInt(5000), amountP: BigInt(0) });
    expect(() => mapLedgerGroups([{ vendor_id: 13, type: "funding", status: "settled", cash_line: "paypal" }])).toThrow(/cash_line/);
  });

  it("maps the wallets' expiry buckets", () => {
    const [wallet] = mapWallets([{ wallet_id: 2, vendor_id: 13, available: "24250", pending: "15000", points: "250", exp_30: "0", exp_90: "250", exp_later: "0", never: "0" }]);
    expect(wallet).toEqual({ walletId: 2, vendorId: 13, available: BigInt(24250), pending: BigInt(15000), points: BigInt(250),
      expiresNext30Days: BigInt(0), expiresDays31To90: BigInt(250), expiresLater: BigInt(0), neverExpires: BigInt(0) });
  });
});

// ── SQL text (contract §6.2) ────────────────────────────────────────────

function everyStatement(): { name: string; statement: FinanceSqlStatement }[] {
  const variants = [allTables(), allTables(Object.fromEntries(FINANCE_TABLES.filter((t) => t.kind === "optional").map((t) => [t.key, false])))];
  const out: { name: string; statement: FinanceSqlStatement }[] = [
    { name: "Q0", statement: FINANCE_Q0 },
    { name: "vendor", statement: FINANCE_VENDOR_LOOKUP },
    { name: "Q4", statement: FINANCE_LEDGER_GROUPS },
    { name: "Q4b", statement: FINANCE_FIRST_FAILURE_CODE },
    { name: "Q5a", statement: FINANCE_WON_DISPUTES },
    { name: "Q5b", statement: FINANCE_NOT_WON_BACK },
    { name: "Q8b", statement: FINANCE_POOL_CLAIMS },
    { name: "Q9", statement: FINANCE_OVERVIEW_BRIDGE },
  ];
  variants.forEach((tables, index) => {
    out.push(
      { name: `Q1#${index}`, statement: ordersStatement(tables) },
      { name: `Q2#${index}`, statement: productsStatement(tables) },
      { name: `Q3#${index}`, statement: neverChargedStatement(tables) },
      { name: `Q6#${index}`, statement: returnFeesStatement(tables) },
      { name: `Q7#${index}`, statement: walletsStatement(tables) },
      { name: `Q8#${index}`, statement: poolStatement(tables) },
      { name: `VENDORS#${index}`, statement: vendorsStatement(tables) },
    );
    for (const endsNow of [true, false]) {
      for (const check of FINANCE_CHECK_SQL) {
        const built = check.build({ tables, endsNow });
        out.push({ name: `${check.id}#${index}${endsNow ? "now" : ""}`, statement: { ...built, text: checkCountsSql(built.text) } });
      }
    }
  });
  return out;
}

describe("finance SQL text", () => {
  const statements = everyStatement();
  const allText = statements.map((entry) => entry.statement.text).join("\n");

  it("joins and costs the way the contract fixes them", () => {
    expect(allText).toContain("wo.source = 'oms' AND wo.oms_fulfillment_order_id = econ.oms_order_id::text");
    expect(allText).toContain("COALESCE(NULLIF(oic.total_cost_mills, 0), oic.total_cost_cents::bigint * 100)");
    expect(allText).toContain("os.status IN ('shipped', 'returned', 'lost')");
    expect(allText).toContain("COALESCE(l.metadata->>'rail', fm.rail, 'unknown')");
  });

  it("casts every OMS and WMS money column to bigint where it is read", () => {
    const uncast = [...allText.matchAll(/\b(ol|oo|os|os2|oic|osi|oi)\.([a-z_]+_cents)\b(?!::bigint)/g)].map((match) => match[0]);
    expect(uncast).toEqual([]);
  });

  it("never uses the known bad package join, an advisory lock, a write, or the database clock", () => {
    expect(allText).not.toMatch(/os2?\.order_id\s*=\s*[\w.]*oms_order_id/);
    expect(allText).not.toMatch(/pg_advisory/i);
    expect(allText).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO|COPY\s+[\w."]+\s+(FROM|TO)|ALTER\s+(TABLE|SCHEMA)|CREATE\s+(TEMP|TABLE|INDEX|SCHEMA)|DROP\s+(TABLE|SCHEMA|INDEX)|GRANT\s+\w+\s+ON|FOR\s+(NO\s+KEY\s+)?UPDATE|FOR\s+SHARE)\b/i,
    );
    expect(allText).not.toMatch(/\bnow\s*\(|current_date|current_timestamp|transaction_timestamp|clock_timestamp|statement_timestamp|localtimestamp/i);
    expect(allText).not.toMatch(/CASE\s+WHEN\s+\$\d+\s*(=|<>|IN\s*\()/);
  });

  it.each(statements.map((entry) => [entry.name, entry.statement] as const))("%s binds exactly its parameters, each cast to one type", (_name, statement) => {
    const uses = [...statement.text.matchAll(/\$(\d+)(?!\d)(::([a-z]+))?/g)];
    const highest = uses.reduce((max, use) => Math.max(max, Number(use[1])), 0);
    expect(highest).toBe(statement.params.length);
    const typesByParam = new Map<string, Set<string>>();
    for (const use of uses) {
      expect(use[3], `$${use[1]} is used without a cast`).toBeDefined();
      typesByParam.set(use[1], (typesByParam.get(use[1]) ?? new Set()).add(use[3]));
    }
    for (let index = 1; index <= statement.params.length; index += 1) {
      expect(typesByParam.get(String(index))?.size, `$${index} is not used, or used with two types`).toBe(1);
    }
  });
});
