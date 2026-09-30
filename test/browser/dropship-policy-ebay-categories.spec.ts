import { expect, test, type Page, type Route } from "playwright/test";
import { resolve } from "node:path";
import type { EbayCategoryOption, EbayCategoryRulesProfile, EbayCategoryRulesState } from "../../shared/dropship/ebay-category-rules";

const rulesPath = "/api/dropship/listings/stores/22/ebay-category-rules";
const categoriesPath = "/api/dropship/listings/stores/22/ebay-categories";

const COLLECTIBLES: EbayCategoryOption = { categoryId: "1", categoryName: "Collectibles", path: ["Collectibles"], leaf: false };
const CARD_SUPPLIES: EbayCategoryOption = { categoryId: "261328", categoryName: "Card Supplies", path: ["Collectibles", "Card Supplies"], leaf: false };
const SLEEVES: EbayCategoryOption = { categoryId: "183435", categoryName: "Card Sleeves", path: ["Collectibles", "Card Supplies", "Card Sleeves"], leaf: true };
const TOPLOADERS: EbayCategoryOption = { categoryId: "183436", categoryName: "Toploaders", path: ["Collectibles", "Card Supplies", "Toploaders"], leaf: true };

type Behaviour = "ok" | "abort_once" | "conflict" | "permission";

async function setup(page: Page, options: { saveBehaviour?: Behaviour; searchBehaviour?: Behaviour } = {}) {
  const state = {
    saved: { revisionId: null, profile: null, updatedAt: null } as EbayCategoryRulesState,
    reviews: [] as unknown[], saves: [] as unknown[], searches: [] as string[], browses: [] as Array<string | null>,
    saveBehaviour: options.saveBehaviour ?? "ok", searchBehaviour: options.searchBehaviour ?? "ok",
    unexpected: [] as string[], errors: [] as string[],
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === rulesPath && method === "GET") return route.fulfill({ json: state.saved });
    if (path === `${rulesPath}/targets`) {
      return route.fulfill({ json: { total: 1, rows: [{ id: "Toploaders", name: "Toploaders" }] } });
    }
    if (path === `${rulesPath}/review` && method === "POST") {
      const reviewBody = request.postDataJSON() as { draft: { rules: Array<{ id: string }> } };
      state.reviews.push(reviewBody);
      return route.fulfill({ json: {
        expectedRevisionId: state.saved.revisionId, selectedCount: 800, changedCount: 800, unchangedCount: 0,
        withoutCategoryBefore: 12, withoutCategoryAfter: 0, bySource: { rule: 300, store_default: 500, catalog: 0, none: 0 },
        byRule: reviewBody.draft.rules.map((rule) => ({ ruleId: rule.id, matched: 300 })),
        byCategory: [{ categoryId: SLEEVES.categoryId, categoryName: SLEEVES.categoryName, count: 500 },
          { categoryId: TOPLOADERS.categoryId, categoryName: TOPLOADERS.categoryName, count: 300 }],
        otherCategoriesCount: 0, changes: [],
      } });
    }
    if (path === rulesPath && method === "PUT") {
      const body = request.postDataJSON();
      state.saves.push(body);
      if (state.saveBehaviour === "conflict") {
        return route.fulfill({ status: 409, json: { error: { code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT",
          message: "The eBay category rules changed since you opened them." } } });
      }
      state.saved = { revisionId: 1, updatedAt: "2026-09-30T12:00:00.000Z", profile: profileFrom(body.draft) };
      if (state.saveBehaviour === "abort_once") { state.saveBehaviour = "ok"; return route.abort("failed"); }
      return route.fulfill({ json: { state: state.saved, idempotentReplay: state.saves.length > 1 } });
    }
    if (path === `${categoriesPath}/search`) {
      const query = url.searchParams.get("q") ?? "";
      state.searches.push(query);
      if (state.searchBehaviour === "permission") {
        return route.fulfill({ status: 403, json: { error: { code: "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED",
          message: "Your eBay connection needs a refresh.", context: { storeConnectionId: 22, retryable: false } } } });
      }
      const categories = /toploader/i.test(query) ? [TOPLOADERS] : [SLEEVES, CARD_SUPPLIES];
      return route.fulfill({ json: { categories } });
    }
    if (path === categoriesPath) {
      const parentId = url.searchParams.get("parentId");
      state.browses.push(parentId);
      if (parentId === null) return route.fulfill({ json: { parent: null, children: [COLLECTIBLES] } });
      if (parentId === COLLECTIBLES.categoryId) return route.fulfill({ json: { parent: COLLECTIBLES, children: [CARD_SUPPLIES] } });
      if (parentId === CARD_SUPPLIES.categoryId) return route.fulfill({ json: { parent: CARD_SUPPLIES, children: [SLEEVES, TOPLOADERS] } });
    }
    state.unexpected.push(`${method} ${path}${url.search}`);
    return route.fulfill({ status: 500, json: { error: { message: "Unexpected synthetic request" } } });
  });
  await page.route("**/__ebay-categories-test", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><main id="root" style="max-width:1100px;margin:24px auto;padding:12px"></main>
    <script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-ebay-categories-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__ebay-categories-test");
  await expect(page.getByRole("heading", { name: "eBay categories" }), JSON.stringify(state.errors)).toBeVisible();
  return state;
}

/** What the fake server stores: eBay's names come from the fixture categories, never from the browser. */
function profileFrom(draft: { defaultCategoryId: string | null; rules: Array<{ id: string; name: string; scope: never; categoryId: string }> }): EbayCategoryRulesProfile {
  const byId = new Map([SLEEVES, TOPLOADERS].map((category) => [category.categoryId, { categoryId: category.categoryId, categoryName: category.categoryName, path: category.path }]));
  return {
    version: 1,
    defaultCategory: draft.defaultCategoryId ? byId.get(draft.defaultCategoryId)! : null,
    rules: draft.rules.map((rule) => ({ id: rule.id, name: rule.name, scope: rule.scope, category: byId.get(rule.categoryId)! })),
  };
}

async function counters(page: Page) {
  return page.evaluate(() => {
    const value = window as unknown as { __saveStarted?: number; __saveSettled?: number; __previewRefreshed?: number };
    return { started: value.__saveStarted ?? 0, settled: value.__saveSettled ?? 0, refreshed: value.__previewRefreshed ?? 0 };
  });
}

async function pickStoreDefaultBySearch(page: Page) {
  await page.getByRole("button", { name: "Choose a store default" }).click();
  await page.getByLabel("Search eBay categories").fill("sleeves");
  const results = page.getByRole("list", { name: "eBay categories" });
  await expect(results.getByText("Card Sleeves", { exact: true })).toBeVisible();
  // Only final categories can be used; the others open one level down.
  const supplies = results.getByRole("listitem").filter({ hasText: "Card Supplies" }).filter({ hasNotText: "Card Sleeves" });
  await expect(supplies.getByRole("button", { name: "Open" })).toBeVisible();
  await expect(supplies.getByRole("button", { name: "Use this category" })).toHaveCount(0);
  await results.getByRole("listitem").filter({ hasText: "Card Sleeves" }).getByRole("button", { name: "Use this category" }).click();
  await expect(page.getByText("Collectibles › Card Supplies › Card Sleeves").first()).toBeVisible();
}

async function addToploaderRule(page: Page) {
  await page.getByRole("button", { name: "Add rule" }).click();
  await page.getByRole("checkbox", { name: "Toploaders", exact: true }).check();
  // Ticking a catalog category names an unnamed rule after it.
  await expect(page.getByLabel("Rule name")).toHaveValue("Toploaders");
  await page.getByRole("button", { name: "Choose eBay category" }).click();
  // The picker opens already searching eBay for the rule's name.
  const results = page.getByRole("list", { name: "eBay categories" });
  await expect(results.getByText("#183436", { exact: false })).toBeVisible();
  await results.getByRole("button", { name: "Use this category" }).click();
}

test("sets a store default and a category rule, reviews the change, and saves once with category numbers only", async ({ page }, testInfo) => {
  const state = await setup(page);
  await expect(page.getByText("None. Listings no rule covers use the Card Shellz category for their product type (recommended).")).toBeVisible();
  await pickStoreDefaultBySearch(page);
  await addToploaderRule(page);
  expect(state.searches).toEqual(["sleeves", "Toploaders"]);

  await page.getByRole("button", { name: "Review changes" }).click();
  await expect(page.getByText("800 of 800 selected listings change eBay category.")).toBeVisible();
  await expect(page.getByText("12 listings without an eBay category now get one.")).toBeVisible();
  await expect(page.getByText("1. Toploaders: 300 listings")).toBeVisible();
  expect(state.reviews).toHaveLength(1);
  const reviewed = state.reviews[0] as { expectedRevisionId: null; draft: { defaultCategoryId: string; rules: Array<Record<string, unknown>> } };
  expect(reviewed.expectedRevisionId).toBeNull();
  expect(reviewed.draft.defaultCategoryId).toBe("183435");
  expect(reviewed.draft.rules).toEqual([{ id: expect.stringMatching(/^rule_[A-Za-z0-9_-]+$/), name: "Toploaders",
    scope: { type: "category", category: "Toploaders" }, categoryId: "183436" }]);
  // Nothing is written until the vendor confirms the review.
  expect(state.saves).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("ebay-category-review.png"), fullPage: true });

  await page.getByRole("button", { name: "Confirm and save" }).click();
  await expect(page.getByRole("status")).toContainText("eBay categories saved and the listing preview refreshed.");
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0]).toMatchObject({ expectedRevisionId: null, draft: reviewed.draft, idempotencyKey: expect.stringMatching(/^ebay-category-rules:/) });
  expect(await counters(page)).toEqual({ started: 1, settled: 1, refreshed: 1 });
  await expect(page.getByText("No unsaved changes.")).toBeVisible();
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("retries an unconfirmed save with the same key and body", async ({ page }) => {
  const state = await setup(page, { saveBehaviour: "abort_once" });
  await pickStoreDefaultBySearch(page);
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Confirm and save" }).click();
  await expect(page.getByRole("alert")).toContainText("The save was not confirmed.");
  // An unconfirmed save is settled by retrying it, never by editing over it.
  await expect(page.getByRole("button", { name: "Back to editing" })).toBeDisabled();
  await page.getByRole("button", { name: "Retry the same save" }).click();
  await expect(page.getByRole("status")).toContainText("eBay categories saved");
  expect(state.saves).toHaveLength(2);
  expect(state.saves[1]).toEqual(state.saves[0]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("keeps the draft when the saved categories changed elsewhere, and reload shows what is saved", async ({ page }) => {
  const state = await setup(page, { saveBehaviour: "conflict" });
  await pickStoreDefaultBySearch(page);
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Confirm and save" }).click();
  await expect(page.getByRole("alert")).toContainText("Your saved eBay categories changed in another window. Your draft is kept here");
  await expect(page.getByText("Collectibles › Card Supplies › Card Sleeves").first()).toBeVisible();
  state.saved = { revisionId: 4, updatedAt: "2026-09-30T12:00:00.000Z", profile: { version: 1, rules: [],
    defaultCategory: { categoryId: TOPLOADERS.categoryId, categoryName: TOPLOADERS.categoryName, path: TOPLOADERS.path } } };
  await page.getByRole("button", { name: "Reload saved categories" }).click();
  await expect(page.getByText("Collectibles › Card Supplies › Toploaders")).toBeVisible();
  await expect(page.getByText("No unsaved changes.")).toBeVisible();
  expect(state.saves).toHaveLength(1);
  expect(await counters(page)).toEqual({ started: 1, settled: 1, refreshed: 0 });
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("tells the vendor to refresh the eBay connection instead of showing an empty search", async ({ page }) => {
  const state = await setup(page, { searchBehaviour: "permission" });
  await page.getByRole("button", { name: "Choose a store default" }).click();
  await page.getByLabel("Search eBay categories").fill("sleeves");
  await expect(page.getByRole("alert")).toContainText("Your eBay connection needs a refresh.");
  await expect(page.getByRole("button", { name: "Refresh eBay authorization for Test store" })).toBeVisible();
  expect(state.searches).toEqual(["sleeves"]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("browses eBay's tree level by level down to a final category", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Choose a store default" }).click();
  await page.getByRole("tab", { name: "Browse all categories" }).click();
  const list = page.getByRole("list", { name: "eBay categories" });
  await list.getByRole("listitem").filter({ hasText: "Collectibles" }).getByRole("button", { name: "Open" }).click();
  await list.getByRole("listitem").filter({ hasText: "Card Supplies" }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("navigation", { name: "eBay category path" })).toContainText("Card Supplies");
  await list.getByRole("listitem").filter({ hasText: "Toploaders" }).getByRole("button", { name: "Use this category" }).click();
  await expect(page.getByText("Collectibles › Card Supplies › Toploaders")).toBeVisible();
  expect(state.browses).toEqual([null, "1", "261328"]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});
