import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { CATALOG_PATH, MARZ, openCatalog, type StubState } from "./dropship-policy-catalog-stubs";

/**
 * Helpers the Listing settings browser specs share (plan PR 10, 3.1, CI-B1), moved unchanged
 * out of dropship-policy-listing-settings-step.spec.ts so the new specs can import them: a spec
 * that imports another spec is refused by Playwright. This file is not a .spec.ts, so the
 * Dropship config does not collect it (playwright.dropship-pricing.config.ts testMatch), and
 * the browser-suite selector still owns it (scripts/ci/browser-suite-impact.mjs).
 */

export const SETUP_PATH = `${CATALOG_PATH}/setup`;
export const STORE = MARZ.storeConnectionId;
export const LISTINGS = `/api/dropship/listings/stores/${STORE}`;
export const KEY = (prefix: string) => expect.stringMatching(new RegExp(`^${prefix}:[A-Za-z0-9-]+$`));

/** Opens step 2 with the summary worked out from what the stub holds, so a save shows in it. */
export function openStep(page: Page, initial: Partial<StubState> = {}, path = SETUP_PATH) {
  return openCatalog(page, path, { liveSummary: true, ...initial });
}

export function phone(testInfo: TestInfo) {
  return testInfo.project.name === "mobile";
}

/** A row's value: the record's words from 640 px, the shorter phone words below (R:433-442, C24). */
export function rowValue(testInfo: TestInfo, wide: string, narrow: string) {
  return phone(testInfo) ? narrow : wide;
}

export function row(page: Page, field: string) {
  return page.getByTestId(`store-default-row-${field}`);
}

export function banner(page: Page) {
  return page.getByTestId("listing-settings-banner");
}

export function drawer(page: Page) {
  return page.getByTestId("product-drawer");
}

/** The drawer's main button: "Save product", or "Save" on a phone. */
export function drawerSave(page: Page) {
  return page.getByTestId("product-drawer-footer").getByRole("button", { name: /^Save( product)?$/ });
}

export function exactBox(page: Page, title: string) {
  return drawer(page).getByLabel(`Exact price for ${title}`, { exact: true });
}

export function readsOf(state: StubState, method: string, path: string) {
  return state.reads.filter((read) => read.method === method && read.path === path);
}

export async function expectNoHorizontalScroll(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

/** Waits for a sheet's enter animation, then returns its box. */
export async function settledBox(locator: Locator) {
  await locator.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

/** Full screen on a phone (R:412); a sheet on the right edge from 640 px. */
export async function expectSheetLayout(page: Page, testInfo: TestInfo, sheet: Locator) {
  const viewport = page.viewportSize()!;
  const box = await settledBox(sheet);
  if (phone(testInfo)) {
    expect(box.x).toBe(0);
    expect(Math.round(box.width)).toBe(viewport.width);
  } else {
    expect(box.x).toBeGreaterThan(0);
    expect(Math.round(box.x + box.width)).toBe(viewport.width);
  }
}

/** The element sits inside the viewport, so it can be pressed without scrolling. */
export async function expectInView(page: Page, locator: Locator) {
  const viewport = page.viewportSize()!;
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

/**
 * C3: the step reads no saved profile until an editor opens. The Price, eBay category and
 * Description editors read the pricing rules, the category rules and the description templates
 * only while they are open (PriceDefaultRow, EbayCategoryDefaultRow, DescriptionDefaultRow), and
 * nothing else on the page reads them any more (the older panels that read them on mount went in
 * Listing settings PR 12).
 */
export function expectGatedReads(state: StubState) {
  expect(readsOf(state, "GET", `${LISTINGS}/content-profile`)).toEqual([]);
  expect(readsOf(state, "GET", `${LISTINGS}/pricing-rules`)).toEqual([]);
  expect(readsOf(state, "GET", `${LISTINGS}/ebay-category-rules`)).toEqual([]);
}

/**
 * The routes Listing settings PR 12 deleted (plan 4.1, R1-R10): the three targets reads, the four listing policy
 * override routes, the vendor listing-config read and write, and the per-size store shelf write. The stub answers none
 * of them (an ask is `unexpected`); this names them, so a journey says which ones it proves nothing calls.
 */
const DELETED_ROUTE_PATH = new RegExp([
  String.raw`^/api/dropship/listings/stores/\d+/(?:pricing-rules|content-profile|ebay-category-rules)/targets$`,
  String.raw`^/api/dropship/ebay/listing-policy-overrides(?:/|$)`,
  String.raw`^/api/dropship/store-connections/\d+/listing-config$`,
  String.raw`^/api/dropship/ebay/store-category-assignments(?:/|$)`,
].join("|"));

export function expectNoDeletedRouteCalls(state: StubState) {
  expect(state.reads.filter((read) => DELETED_ROUTE_PATH.test(read.path)).map((read) => `${read.method} ${read.path}`)).toEqual([]);
}

/** Step 2 has no "Older settings" section any more (PR 12, D3, D13): no toggle, no section, no words naming it. */
export async function expectNoOlderSettings(page: Page) {
  await expect(page.getByRole("button", { name: /older settings/i })).toHaveCount(0);
  await expect(page.locator("[data-testid^='older-listing-settings']")).toHaveCount(0);
  await expect(page.getByText(/older settings/i)).toHaveCount(0);
}

export function expectNothingUnexpected(state: StubState) {
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Answers the next GET of `pathname` (the full path, no query) with a 500 once `armed()` says so, once; every other
 * request goes to the stub. The failed read never reaches the stub, so `state.reads` doesn't list it. Moved from the
 * drawer spec (10a) so the bulk spec can fail a list read the same way (10d).
 */
export async function failNextRead(page: Page, pathname: string, armed: () => boolean) {
  let failed = false;
  await page.route((url) => url.pathname === pathname, async (route) => {
    if (!failed && route.request().method() === "GET" && armed()) {
      failed = true;
      await route.fulfill({ status: 500, json: { error: { code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", message: "Read failed." } } });
      return;
    }
    await route.fallback();
  });
}

/** Opens the product's drawer from the Products tab: the name on a wide screen, the card on a phone. */
export async function openProductRow(page: Page, productId: number, name: string) {
  await page.getByTestId(`listing-settings-product-${productId}`).getByRole("button", { name: new RegExp(`^${escapeRegExp(name)}`) }).click();
  await expect(drawer(page)).toBeVisible();
}
