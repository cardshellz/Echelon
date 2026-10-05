import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { join, resolve } from "node:path";
import type { FinanceSummaryInput } from "../../shared/dropship/program-finance";
import {
  financeFixtureLine,
  financeSummaryFixtureInput,
  parseFinanceFixture,
} from "../../client/src/pages/__tests__/fixtures/dropship-finance-summary.fixture";

// Journeys for the Dropship "Program finance" tab (part 1, the rollup). The
// real panel runs under the app's query client; the only API it may call is
// GET /api/dropship/admin/finance/summary, which every test stubs with the
// §6.4 seeded program (the shared fixture) or a variant derived from it.
// Every variant goes through the shared contract before it is served, so a
// journey can never pass on a response the real page would refuse.

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

const PAGE_PATH = "/dropship";
const SUMMARY_PATH = "/api/dropship/admin/finance/summary";
const HARNESS_FILE = "test/browser/fixtures/dropship-finance-harness.tsx";
const ALL_ROWS = "open=sales,products,cash,returns,owed,points,pool,vendors,checks";
/** Set to a directory to keep the review screenshots (default view, Sales open, How drawer). */
const SCREENSHOT_DIR = process.env.FINANCE_SCREENSHOT_DIR ?? null;

// ── responses ────────────────────────────────────────────────────────────

interface Reply {
  readonly status: number;
  readonly json: unknown;
}

type Responder = (query: URLSearchParams, index: number) => Reply | Promise<Reply>;

/** A summary as the server sends it: checked against the contract first, then served as JSON. */
function ok(input: FinanceSummaryInput): Reply {
  parseFinanceFixture(input);
  return { status: 200, json: input };
}

function failure(status: number, code: string, classification: "transient" | "permanent" | "fatal", message: string): Reply {
  return { status, json: { error: { code, message, context: { classification } } } };
}

function salesLine(input: FinanceSummaryInput, key: string) {
  const line = input.sections.sales.lines.find((candidate) => candidate.key === key);
  if (!line) throw new Error(`the fixture has no ${key} line`);
  return line;
}

/**
 * Last month (Sep 1 – 30), when no return credit was paid: what we kept is
 * $38.81 + $7.60 = $46.41. Only the figures the rollup shows for it change,
 * and they still tie (the hero, the bridge, the Sales lines, the workings).
 */
function lastMonth(input: FinanceSummaryInput): FinanceSummaryInput {
  const kept = 4_641;
  input.period = {
    preset: "last-month", fromDate: "2026-09-01", toDate: "2026-09-30",
    startAt: "2026-09-01T04:00:00.000Z", endAt: "2026-10-01T04:00:00.000Z", endsNow: false, clampedToMonthEnd: false,
  };
  input.comparePeriod = {
    preset: "last-month", fromDate: "2026-08-01", toDate: "2026-08-31",
    startAt: "2026-08-01T04:00:00.000Z", endAt: "2026-09-01T04:00:00.000Z", endsNow: false, clampedToMonthEnd: false,
  };
  input.answer.returnCreditsPaid = 0;
  input.answer.kept = { amount: kept, status: "recorded" };
  salesLine(input, "sales.return_credits_cs").amount = 0;
  salesLine(input, "sales.kept").amount = kept;
  input.answer.workings = input.answer.workings.map((step) => {
    if (step.textKey !== "sales.kept") return step;
    return {
      ...step,
      result: kept,
      operands: step.operands.map((operand) => operand.lineKey === "sales.return_credits_cs" ? { ...operand, amount: 0 } : operand),
    };
  });
  // September overlaps all three policy eras (spec §7).
  input.notes = ["card_fee_era", "pricing_v1_era", "weekly_collection_era"];
  return input;
}

/** compare=off: the server sends no earlier window and no deltas. */
function withoutCompare(input: FinanceSummaryInput): FinanceSummaryInput {
  input.comparePeriod = null;
  input.tiles.billed.prior = null;
  input.tiles.cashReceived.prior = null;
  input.answer.priorMarginTenths = null;
  input.answer.marginChangeTenths = null;
  return input;
}

const VENDOR_NAMES: Readonly<Record<number, string>> = { 12: "Acme TCG", 13: "PackRat" };

function forVendor(input: FinanceSummaryInput, vendorId: number): FinanceSummaryInput {
  input.scope = { vendor: { vendorId, name: VENDOR_NAMES[vendorId] ?? `Vendor #${vendorId}`, nameSource: VENDOR_NAMES[vendorId] ? "business_name" : "id" } };
  return input;
}

/** The stub server: answers the way the real route does for the period, compare and vendor asked for. */
function programResponder(query: URLSearchParams): Reply {
  let input = financeSummaryFixtureInput();
  if (query.get("period") === "last-month") input = lastMonth(input);
  if (query.get("compare") === "off") input = withoutCompare(input);
  const vendorId = query.get("vendorId");
  if (vendorId !== null) input = forVendor(input, Number(vendorId));
  return ok(input);
}

/** The Cash in section's savepoint failed; the rest of the summary is fine (spec §7 "Per section"). */
function withFailedCash(input: FinanceSummaryInput): FinanceSummaryInput {
  input.sections.cash = { status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT", lines: [] };
  input.tiles.cashReceived = { amount: null, status: "unavailable", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT", prior: null };
  return input;
}

/** Costs ran over what we billed: the panel test's loss program (spec §7 "Loss"). */
function asLoss(input: FinanceSummaryInput): FinanceSummaryInput {
  Object.assign(input.answer, {
    state: "loss", kept: { amount: -21_240, status: "recorded" }, keptOnOrders: -212, feesCharged: 0, returnCreditsPaid: 21_028,
    orders: 2, billed: 2_000, fullyCosted: { orders: 1, billed: 1_000 }, waiting: { orders: 1, billed: 1_000 },
    costOfGoods: 900, carrierLabels: 262, poolShare: 50, marginTenths: -212, marginBps: -2_120, marginChangeTenths: null,
    centsOfEachDollar: null, barBps: null, paidWithPoints: { billed: 0, points: 0 }, coverage: { done: 1, total: 2 },
  });
  return input;
}

/**
 * Ten orders accepted, none fully costed yet (spec §3.2 "FC empty, E
 * non-empty"), as the server builds it: no margin or ¢ split, and the bar is
 * all "not yet fully costed".
 */
function asNotReady(input: FinanceSummaryInput): FinanceSummaryInput {
  Object.assign(input.answer, {
    state: "not_ready", kept: { amount: -1_240, status: "recorded" }, keptOnOrders: 0, feesCharged: 760, returnCreditsPaid: 2_000,
    orders: 10, billed: 18_730, fullyCosted: { orders: 0, billed: 0 }, waiting: { orders: 10, billed: 18_730 },
    costOfGoods: 0, carrierLabels: 0, poolShare: 0, marginTenths: null, marginBps: null, priorMarginTenths: null, marginChangeTenths: null,
    centsOfEachDollar: null, barBps: { kept: 0, costOfGoods: 0, carrierLabels: 0, poolShare: 0, waiting: 10_000 },
    coverage: { done: 0, total: 10 }, workings: [],
  });
  return input;
}

/** Two "every line" lines that are zero: Summary depth hides them, Every line shows them (spec §3.4 A). */
function withZeroEveryLineLines(input: FinanceSummaryInput): FinanceSummaryInput {
  salesLine(input, "sales.labels.replacement").amount = 0;
  const cash = input.sections.cash;
  if (cash.status !== "ok") throw new Error("the fixture's cash section is ok");
  const chainWatcher = cash.lines.findIndex((line) => line.key === "cash.usdc.chain_watcher");
  cash.lines.splice(chainWatcher + 1, 0, financeFixtureLine("cash.usdc.staff_confirmed", 0, { datedBy: "settled", depth: "every_line" }));
  return input;
}

function deferred<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    release = resolvePromise;
  });
  return { promise, release };
}

// ── the page ─────────────────────────────────────────────────────────────

interface Harness {
  /** The query string of every summary request, in order. */
  readonly requests: string[];
  readonly unexpected: string[];
  readonly errors: string[];
}

/** Chromium logs every non-2xx response as a console error; the journeys that ask for one expect it. */
const FAILED_RESOURCE_LOG = /^Failed to load resource: the server responded with a status of \d{3}/;

async function setup(page: Page, options: { respond?: Responder; search?: string } = {}): Promise<Harness> {
  const harness: Harness = { requests: [], unexpected: [], errors: [] };
  const respond = options.respond ?? programResponder;
  page.on("pageerror", (error) => harness.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !FAILED_RESOURCE_LOG.test(message.text())) harness.errors.push(message.text());
  });
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === SUMMARY_PATH && method === "GET") {
      const index = harness.requests.length;
      harness.requests.push(url.search);
      const reply = await respond(url.searchParams, index);
      return route.fulfill({ status: reply.status, json: reply.json });
    }
    harness.unexpected.push(`${method} ${url.pathname}`);
    return route.fulfill({ status: 500, json: { error: { message: "Unexpected request" } } });
  });
  // The panel writes /dropship?tab=finance&…; serving the harness at that path keeps its pushState links on this page.
  await page.route((url) => url.pathname === PAGE_PATH, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><div id="root"></div>
    <script type="module" src="/@fs/${resolve(process.cwd(), HARNESS_FILE).replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto(`${PAGE_PATH}?${options.search ?? "tab=finance"}`);
  return harness;
}

function expectClean(harness: Harness) {
  expect(harness.unexpected).toEqual([]);
  expect(harness.errors).toEqual([]);
}

async function expectNoHorizontalPageScroll(page: Page) {
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.inner);
}

/** A full-page review screenshot, from the top (so the sticky bar sits at the top) with every animation finished. */
async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  if (SCREENSHOT_DIR === null) return;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}-${testInfo.project.name}.png`), fullPage: true, animations: "disabled" });
}

function urlParams(page: Page): URLSearchParams {
  return new URL(page.url()).searchParams;
}

const isMobile = (testInfo: TestInfo) => testInfo.project.name === "mobile";

/** One statement table's rows as [operator column, row header label (with its screen-reader word), amount]. */
async function statementRows(page: Page, sectionTestId: string, tableIndex = 0): Promise<string[][]> {
  return page.getByTestId(sectionTestId).locator("table").nth(tableIndex).evaluate((table) =>
    [...table.querySelectorAll(":scope > tbody > tr")].map((row) => {
      const cells = [...row.children];
      const label = row.querySelector("th > span:first-child")?.textContent ?? "";
      return [cells[0]?.textContent ?? "", label, cells.at(-1)?.textContent ?? ""];
    }));
}

async function choosePeriod(page: Page, label: string) {
  await page.getByRole("combobox", { name: "Period" }).click();
  await page.getByRole("option", { name: label }).click();
}

/** The Compare switch sits in the bar on a wide screen and in the ⋯ menu on a phone (spec §2.2). */
async function toggleCompare(page: Page, testInfo: TestInfo, name: RegExp) {
  if (isMobile(testInfo)) {
    await page.getByRole("button", { name: "More period options" }).click();
    await page.getByRole("menuitemcheckbox", { name }).click();
  } else {
    await page.getByRole("switch", { name }).click();
  }
}

// ── journeys ─────────────────────────────────────────────────────────────

test("month to date leads with what we kept, the bar's exact amounts and four tiles, with no sideways scroll", async ({ page }, testInfo) => {
  const harness = await setup(page);
  const bar = page.getByTestId("finance-period-bar");
  await expect(page.getByTestId("finance-hero")).toHaveText("$26.41");
  expect(harness.requests).toEqual(["?period=mtd"]);

  await expect(page.getByRole("combobox", { name: "Period" })).toHaveText("This month so far");
  await expect(bar).toContainText("Oct 1 – 5, 2026");
  await expect(bar.getByTestId("finance-as-of")).toHaveText("Numbers as of 9:14 AM ET");
  await expect(bar.getByRole("button", { name: "4 need a look" })).toBeVisible();

  const answer = page.getByTestId("finance-answer");
  await expect(answer.getByRole("heading", { name: "What we kept" })).toBeVisible();
  await expect(answer).toContainText("before packaging, Stripe fees and overheads");
  await expect(answer).toContainText("39.9% of what we billed on fully costed orders");
  await expect(answer).toContainText("−0.5 pts vs Sep 1 – 5");
  const meter = answer.getByRole("meter", { name: "Costs complete" });
  await expect(meter).toHaveAttribute("aria-valuenow", "3");
  await expect(meter).toHaveAttribute("aria-valuemax", "10");
  await expect(meter).toHaveAttribute("aria-valuetext", "3 of 10 orders");
  await expect(answer).toContainText("Costs complete on 3 of 10 orders");
  await expect(answer).toContainText("7 orders ($90.00) count once their costs are recorded");
  await expect(answer).toContainText("$22.00 of what we billed was paid with points: no cash came in for it");

  await expect(answer.getByRole("img")).toHaveAttribute("aria-label",
    "Of each dollar billed on 3 fully costed orders: 40 cents kept, 39 cents cost of goods, 20 cents carrier labels, 1 cent insurance pool share; 7 orders, 90 dollars, not yet fully costed");
  const legendRows = page.getByTestId("finance-bar-legend").locator("tbody tr");
  const legend = [
    ["Kept on orders", "40¢", "$38.81"],
    ["Cost of goods", "39¢", "$37.64"],
    ["Carrier labels", "20¢", "$19.35"],
    ["Insurance pool share (set aside)", "1¢", "$1.50"],
    ["Not yet fully costed · 7 orders", "·", "$90.00"],
  ];
  await expect(legendRows).toHaveCount(legend.length);
  for (const [index, cells] of legend.entries()) await expect(legendRows.nth(index).locator("th, td")).toHaveText(cells);
  await expect(page.getByTestId("finance-bridge")).toHaveText("$38.81 kept on orders + $7.60 fees we charged − $20.00 return credits we paid = $26.41 kept");

  const tiles: Record<string, readonly string[]> = {
    billed: ["Billed to vendors", "$187.30", "+$161.30 (+620.4%) vs Sep 1 – 5", "10 orders"],
    cash_received: ["Cash received", "$883.00", "−$2,117.00 (−70.6%) vs Sep 1 – 5", "after disputes · before Stripe's fees"],
    we_owe_now: ["We owe vendors · now", "$3,811.10", "2 vendors", "$190.00 on the way, not yet cash"],
    owed_to_us_now: ["Vendors owe us · now", "$12.50", "1 vendor below zero"],
  };
  for (const [key, texts] of Object.entries(tiles)) {
    const tile = page.getByTestId(`finance-tile-${key}`);
    for (const text of texts) await expect(tile).toContainText(text);
  }

  // Every detail row starts closed: titles and one amount each, nothing opened.
  await expect(page.getByTestId("finance-detail-sales")).toContainText("$26.41 kept");
  await expect(page.getByTestId("finance-checks")).toHaveCount(0);
  await expectNoHorizontalPageScroll(page);
  await screenshot(page, testInfo, "default");
  expectClean(harness);
});

test("opening Sales and what we kept lists the statement in order, with each operator also said in words", async ({ page }, testInfo) => {
  const harness = await setup(page);
  const sales = page.getByTestId("finance-detail-sales");
  await sales.getByRole("button", { name: /Sales and what we kept/ }).click();
  await expect.poll(() => urlParams(page).get("open")).toBe("sales");

  expect(await statementRows(page, "finance-detail-sales")).toEqual([
    ["", "Billed to vendors · 10 orders", "$187.30"],
    ["−", "minus Not yet fully costed · 7 orders", "$90.00"],
    ["=", "equals Billed on fully costed orders · 3 orders", "$97.30"],
    ["−", "minus Cost of goods (what the products cost us)", "$37.64"],
    ["−", "minus Carrier labels", "$19.35"],
    ["−", "minus Insurance pool share (set aside, not ours to keep)", "$1.50"],
    ["", "Packaging", "Not recorded"],
    ["=", "equals Kept on orders · 39.9%", "$38.81"],
    ["+", "plus Fees we charged · day posted", "$7.60"],
    ["−", "minus Return credits we paid (not from the pool) · day posted", "$20.00"],
    ["=", "equals What we kept", "$26.41"],
  ]);
  await expect(sales.getByText("day accepted", { exact: true })).toBeVisible();
  await expect(sales).toContainText("product $133.20 · shipping $54.10 (carrier estimate $40.80 · our markup $9.30 · insurance pool share $4.00)");
  await expect(sales).toContainText("paid from wallets $165.30 · paid with points $22.00 (2,200 points)");
  await expect(sales).toContainText("advance fees $0.10 · card fees $3.00 · return fees $4.50");
  await expect(sales).toContainText("Not taken off what we kept: paid with points $22.00 · staff wallet credits $25.00");
  await expect(sales).toContainText("Label cost recorded on 7 of 8 packages shipped for orders accepted Oct 1 – 5");
  // The not-recorded packaging line explains itself behind its ⓘ, never as $0.00.
  await expect(sales.getByRole("button", { name: "Why packaging is not recorded" })).toBeVisible();

  await expectNoHorizontalPageScroll(page);
  await screenshot(page, testInfo, "sales-open");
  expect(harness.requests).toEqual(["?period=mtd"]);
  expectClean(harness);
});

test("Every line shows the zero lines Summary hides, without asking the server again", async ({ page }) => {
  const harness = await setup(page, { respond: () => ok(withZeroEveryLineLines(financeSummaryFixtureInput())), search: "tab=finance&open=sales,cash" });
  const sales = page.getByTestId("finance-detail-sales");
  const cash = page.getByTestId("finance-detail-cash");
  await expect(sales).toContainText("Carrier labels");
  await expect(sales).not.toContainText("of which replacement packages");
  await expect(cash).toContainText("found on chain automatically $250.00");
  await expect(cash).not.toContainText("confirmed by staff");

  await page.getByRole("radio", { name: "Every line" }).click();
  await expect.poll(() => urlParams(page).get("depth")).toBe("all");
  await expect(sales).toContainText("of which replacement packages $0.00");
  await expect(cash).toContainText("found on chain automatically $250.00 · confirmed by staff $0.00");

  await page.getByRole("radio", { name: "Summary" }).click();
  await expect.poll(() => urlParams(page).get("depth")).toBeNull();
  await expect(sales).not.toContainText("of which replacement packages");
  expect(harness.requests).toEqual(["?period=mtd"]);
  expectClean(harness);
});

test("the How drawer for What we kept shows the server's steps in order, and Back or Esc closes it", async ({ page }, testInfo) => {
  const harness = await setup(page);
  await page.getByRole("button", { name: /^What we kept, 26 dollars and 41 cents, .*opens how it was worked out$/ }).click();
  await expect.poll(() => urlParams(page).get("how")).toBe("answer.kept");
  const drawer = page.getByRole("dialog", { name: "What we kept" });
  await expect(drawer).toBeVisible();
  const body = drawer.getByTestId("finance-how-body");
  await expect(body.locator("p").first()).toHaveText("$26.41");
  await expect(body.locator("ol > li > p:first-child > span:last-child")).toHaveText([
    "Orders count on the day we accepted them. Money counts on the day it moved. Eastern time.",
    "Billed on fully costed orders",
    "Kept on orders",
    "Cost of goods is today's cost of the stock each order used, oldest stock first.",
    "What we kept",
    "Kept on orders as a share of what we billed on fully costed orders",
    "The same share for the comparison period, measured as of now",
    "Change in that share, in points",
    "Not included: packaging, Stripe's fees and overheads, which Echelon does not record. Points used are shown beside what we kept, not taken off.",
  ]);
  const lastSum = body.locator("ol > li").nth(4).locator("tbody tr");
  const expected = [
    ["", "Kept on orders", "$38.81"],
    ["+", "plus Fees we charged", "$7.60"],
    ["−", "minus Return credits we paid (not from the pool)", "$20.00"],
    ["=", "equals What we kept", "$26.41"],
  ];
  await expect(lastSum).toHaveCount(expected.length);
  for (const [index, cells] of expected.entries()) await expect(lastSum.nth(index).locator("td, th")).toHaveText(cells);
  await screenshot(page, testInfo, "how");

  // Opening pushed a history entry: Back closes the drawer and keeps the page.
  await page.goBack();
  await expect(drawer).toBeHidden();
  expect(urlParams(page).get("how")).toBeNull();
  await expect(page.getByTestId("finance-hero")).toHaveText("$26.41");

  await page.getByTestId("finance-hero").click();
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect.poll(() => urlParams(page).get("how")).toBeNull();
  expect(harness.requests).toEqual(["?period=mtd"]);
  expectClean(harness);
});

test("changing the period blanks to skeletons, then shows only the new period's numbers", async ({ page }) => {
  const held = deferred<void>();
  const harness = await setup(page, {
    respond: async (query) => {
      if (query.get("period") === "last-month") await held.promise;
      return programResponder(query);
    },
  });
  await expect(page.getByTestId("finance-hero")).toHaveText("$26.41");

  await choosePeriod(page, "Last month");
  await expect.poll(() => urlParams(page).get("period")).toBe("last-month");
  await expect.poll(() => harness.requests).toEqual(["?period=mtd", "?period=last-month"]);
  // While the new numbers load, nothing from month to date stays on screen under the new label.
  await expect(page.getByRole("combobox", { name: "Period" })).toHaveText("Last month");
  await expect(page.getByTestId("finance-loading")).toBeVisible();
  await expect(page.getByTestId("finance-answer")).toHaveCount(0);
  await expect(page.getByTestId("finance-tiles")).toHaveCount(0);
  const financePage = page.getByTestId("finance-page");
  await expect(financePage).not.toContainText(/\$\d/);
  await expect(financePage).not.toContainText("Oct 1 – 5");
  await expect(page.getByTestId("finance-period-bar")).toContainText("Checking…");
  await expect(page.getByTestId("finance-as-of")).toHaveCount(0);
  // The live region no longer names the period whose numbers were blanked.
  await expect(page.getByTestId("finance-announcement")).toHaveText("");

  held.release();
  await expect(page.getByTestId("finance-hero")).toHaveText("$46.41");
  await expect(page.getByTestId("finance-period-bar")).toContainText("Sep 1 – 30, 2026");
  await expect(page.getByTestId("finance-bridge")).toHaveText("$38.81 kept on orders + $7.60 fees we charged − $0.00 return credits we paid = $46.41 kept");
  await expect(page.getByTestId("finance-notes")).toContainText("Card top-ups carried a 3% fee from Sep 16 to Sep 24, 2026.");
  await expect(page.getByTestId("finance-announcement")).toHaveText("Numbers updated for Sep 1 – 30.");
  await expect(financePage).not.toContainText("$26.41");
  expectClean(harness);
});

test("turning Compare off asks without the earlier period and hides every delta", async ({ page }, testInfo) => {
  const harness = await setup(page);
  const answer = page.getByTestId("finance-answer");
  const tiles = page.getByTestId("finance-tiles");
  await expect(answer).toContainText("−0.5 pts vs Sep 1 – 5");
  await expect(tiles).toContainText("+$161.30 (+620.4%) vs Sep 1 – 5");

  await toggleCompare(page, testInfo, /^Compare with Sep 1 – 5/);
  await expect.poll(() => urlParams(page).get("compare")).toBe("off");
  await expect.poll(() => harness.requests).toEqual(["?period=mtd", "?period=mtd&compare=off"]);
  await expect(page.getByTestId("finance-hero")).toHaveText("$26.41");
  await expect(answer).toContainText("39.9% of what we billed on fully costed orders");
  await expect(answer).not.toContainText(" vs ");
  await expect(tiles).not.toContainText(" vs ");
  await expect(tiles).toContainText("$187.30");
  if (!isMobile(testInfo)) {
    await expect(page.getByRole("switch", { name: "Compare with the period before" })).toHaveAttribute("aria-checked", "false");
  }

  await toggleCompare(page, testInfo, /^Compare with the period before/);
  await expect.poll(() => urlParams(page).get("compare")).toBeNull();
  await expect(tiles).toContainText("+$161.30 (+620.4%) vs Sep 1 – 5");
  expectClean(harness);
});

test("clicking a vendor in the Vendors row scopes the whole page; the chip takes it back to all vendors", async ({ page }) => {
  const harness = await setup(page, { search: "tab=finance&open=vendors" });
  const vendors = page.getByTestId("finance-detail-vendors");
  await expect(vendors).toContainText("Total · 3 vendors");

  await vendors.getByRole("button", { name: "Show Acme TCG's view: this page for Acme TCG only" }).click();
  await expect.poll(() => urlParams(page).get("vendor")).toBe("12");
  await expect.poll(() => harness.requests).toEqual(["?period=mtd", "?period=mtd&vendorId=12"]);
  const bar = page.getByTestId("finance-period-bar");
  await expect(bar).toContainText("Vendor: Acme TCG");
  await expect(page.getByTestId("finance-answer").getByRole("heading", { name: "What we kept from Acme TCG" })).toBeVisible();
  await expect(page.getByTestId("finance-tile-billed")).toContainText("Billed to Acme TCG");
  // A vendor's own view has no Vendors row.
  await expect(page.getByTestId("finance-detail-vendors")).toHaveCount(0);
  await expectNoHorizontalPageScroll(page);

  await bar.getByRole("button", { name: "Remove Vendor: Acme TCG: show all vendors" }).click();
  await expect.poll(() => urlParams(page).get("vendor")).toBeNull();
  await expect(bar).not.toContainText("Vendor:");
  await expect(page.getByTestId("finance-answer").getByRole("heading", { name: "What we kept", exact: true })).toBeVisible();
  await expect(page.getByTestId("finance-detail-vendors")).toContainText("Total · 3 vendors");
  expectClean(harness);
});

test("a section that failed shows its own error while the other rows render, and Try again brings it back", async ({ page }) => {
  const harness = await setup(page, {
    respond: (_query, index) => ok(index === 0 ? withFailedCash(financeSummaryFixtureInput()) : financeSummaryFixtureInput()),
    search: "tab=finance&open=sales,cash",
  });
  const cash = page.getByTestId("finance-detail-cash");
  await expect(cash).toContainText("Couldn't work out cash in: DROPSHIP_FINANCE_QUERY_TIMEOUT.");
  await expect(page.getByTestId("finance-tile-cash_received")).toContainText("Unavailable");
  // The other rows and the answer render as usual.
  await expect(page.getByTestId("finance-hero")).toHaveText("$26.41");
  expect((await statementRows(page, "finance-detail-sales")).at(-1)).toEqual(["=", "equals What we kept", "$26.41"]);
  await expect(page.getByTestId("finance-detail-returns")).toContainText("$37.00 credited");
  await expect(page.getByTestId("finance-page-error")).toHaveCount(0);

  await cash.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => harness.requests.length).toBe(2);
  expect((await statementRows(page, "finance-detail-cash")).at(-1)).toEqual(["=", "equals Cash received · before Stripe's fees", "$883.00"]);
  await expect(page.getByTestId("finance-tile-cash_received")).toContainText("$883.00");
  expectClean(harness);
});

test("a 503 is retried, then shows the page error card with no numbers, and Try again loads them", async ({ page }) => {
  const harness = await setup(page, {
    respond: (_query, index) => index < 3
      ? failure(503, "DROPSHIP_FINANCE_QUERY_TIMEOUT", "transient", "The finance query timed out.")
      : ok(financeSummaryFixtureInput()),
  });
  const card = page.getByTestId("finance-page-error");
  await expect(card).toHaveAttribute("role", "alert");
  await expect(card.locator("p")).toHaveText(
    "Couldn't load program finance for this month so far. Nothing is shown so older numbers can't be mistaken for current ones. (DROPSHIP_FINANCE_QUERY_TIMEOUT)",
  );
  // A transient failure is tried three times in all (1s, then 2s, apart) before the card shows.
  expect(harness.requests).toEqual(["?period=mtd", "?period=mtd", "?period=mtd"]);
  await expect(page.getByTestId("finance-page")).not.toContainText(/\$\d/);
  await expect(page.getByTestId("finance-answer")).toHaveCount(0);

  await card.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("finance-hero")).toHaveText("$26.41");
  await expect(card).toHaveCount(0);
  expect(harness.requests).toHaveLength(4);
  expectClean(harness);
});

test("a loss reads Loss with a true minus, and the bar shows how far costs ran over what we billed", async ({ page }) => {
  const harness = await setup(page, { respond: () => ok(asLoss(financeSummaryFixtureInput())) });
  const answer = page.getByTestId("finance-answer");
  const hero = page.getByTestId("finance-hero");
  await expect(hero).toHaveText("−$212.40");
  // U+2212, never a hyphen; red with an icon and the word, not colour alone.
  expect(await hero.textContent()).not.toContain("-");
  await expect(hero.locator("span").first()).toHaveClass(/text-red-700/);
  await expect(hero.locator("svg")).toHaveCount(1);
  await expect(answer.getByText("Loss", { exact: true })).toBeVisible();
  await expect(answer).toContainText("−21.2% of what we billed on fully costed orders");
  await expect(answer).toContainText("Costs ran $2.12 over what we billed");
  await expect(answer.getByRole("img")).toHaveAttribute("aria-label",
    "Costs ran $2.12 over what we billed on 1 fully costed order; 1 order, 10 dollars, not yet fully costed");
  // A loss has no "of each $1" split.
  await expect(page.getByTestId("finance-bar-legend")).not.toContainText("¢");
  await expect(page.getByTestId("finance-bar-legend").locator("tbody tr").first().locator("th, td")).toHaveText(["Kept on orders", "", "−$2.12"]);
  await expect(page.getByTestId("finance-bridge")).toHaveText("−$2.12 kept on orders + $0.00 fees we charged − $210.28 return credits we paid = −$212.40 kept");
  await expectNoHorizontalPageScroll(page);
  expectClean(harness);
});

test("before any order is fully costed the card says Not ready yet and the bar is all not-yet-costed", async ({ page }) => {
  const harness = await setup(page, { respond: () => ok(asNotReady(financeSummaryFixtureInput())) });
  const answer = page.getByTestId("finance-answer");
  await expect(answer.getByTestId("finance-answer-headline")).toHaveText("Not ready yet");
  await expect(answer).toContainText("Costs are recorded when items are picked and labels are bought. 0 of 10 orders so far.");
  await expect(page.getByTestId("finance-hero")).toHaveCount(0);
  await expect(answer).not.toContainText("of what we billed on fully costed orders");
  await expect(answer).toContainText("10 orders · $187.30 billed");
  await expect(answer.getByRole("img")).toHaveAttribute("aria-label", "10 orders, 187 dollars and 30 cents, not yet fully costed");
  // Nothing is costed yet, so no part of the bar is a kept, cost or label amount, and no kept total is worked out.
  const legendRows = page.getByTestId("finance-bar-legend").locator("tbody tr");
  await expect(legendRows).toHaveCount(1);
  await expect(legendRows.first().locator("th, td")).toHaveText(["Not yet fully costed · 10 orders", "", "$187.30"]);
  await expect(page.getByTestId("finance-bridge")).toHaveCount(0);
  await expect(page.getByTestId("finance-page")).not.toContainText("kept on orders +");
  expectClean(harness);
});

/** Where the Checks row's title sits against the sticky period bar's bottom edge. */
async function checksTitleOffset(page: Page): Promise<number | null> {
  const [barBox, titleBox] = await Promise.all([
    page.getByTestId("finance-period-bar").boundingBox(),
    page.getByTestId("finance-detail-checks").getByRole("button", { name: /^Checks/ }).boundingBox(),
  ]);
  return barBox && titleBox ? Math.round(titleBox.y - (barBox.y + barBox.height)) : null;
}

test("the checks chip opens the Checks row and brings it up just under the sticky bar, with the checks that need a look", async ({ page }) => {
  const harness = await setup(page);
  const chip = page.getByTestId("finance-period-bar").getByRole("button", { name: "4 need a look" });
  await chip.click();
  await expect.poll(() => urlParams(page).get("open")).toBe("checks");
  const checks = page.getByTestId("finance-checks");
  await expect(checks).toBeVisible();
  await expect(checks).toContainText("Needs a look · No deposit has waited more than 7 days, and every deposit has a way paid");
  await expect(checks).toContainText("Needs a look · Cost-of-goods rows add up, and every picked or shipped line has a cost");
  await expect(checks).toContainText("Needs a look · No accepted order was cancelled in OMS while the vendor stays charged");
  // Groups with nothing to look at stay folded.
  await expect(checks.getByRole("button", { name: /^Wallets/ })).toHaveAttribute("aria-expanded", "false");
  await expect(checks.getByRole("button", { name: /^Deposits/ })).toHaveAttribute("aria-expanded", "true");

  // The row's title sits just under the bar (never behind it), with the list in view below it.
  // On a phone the bar wraps to several lines, so a fixed scroll margin would hide the title.
  await expect.poll(() => checksTitleOffset(page)).toBeGreaterThanOrEqual(0);
  await expect.poll(() => checksTitleOffset(page)).toBeLessThanOrEqual(24);
  await expect(checks.getByText("Every check runs on the same snapshot as the numbers above.")).toBeInViewport();

  // From the top again, the chip brings the already open row back up the same way.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => checksTitleOffset(page)).toBeGreaterThan(24);
  await chip.click();
  await expect.poll(() => checksTitleOffset(page)).toBeLessThanOrEqual(24);
  await expect.poll(() => checksTitleOffset(page)).toBeGreaterThanOrEqual(0);
  expect(urlParams(page).get("open")).toBe("checks");
  await expectNoHorizontalPageScroll(page);
  expectClean(harness);
});

test("with every row open at every line, the page still never scrolls sideways", async ({ page }) => {
  const harness = await setup(page, { search: `tab=finance&${ALL_ROWS}&depth=all` });
  await expect(page.getByTestId("finance-checks")).toBeVisible();
  await expect(page.getByTestId("finance-detail-owed")).toContainText("Owed now");
  await expectNoHorizontalPageScroll(page);
  expectClean(harness);
});

