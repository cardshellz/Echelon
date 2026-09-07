import { expect, test, type Page } from "playwright/test";
import { resolve } from "node:path";
import type { PricingProfile, ReviewPricingRulesInput } from "../../shared/dropship/pricing-rules";

const base = "/api/dropship/listings/stores/22/pricing-rules";
const reviewId = "cd6bca1f-54d5-484b-9638-20499dc199d0";
async function setup(page: Page) {
  const state = { profile: null as PricingProfile | null, revisionId: null as number | null,
    reviews: [] as ReviewPricingRulesInput[], applies: [] as Array<Record<string, unknown>>, changes: 0,
    abortApplyOnce: false, failReloadOnce: false, block: false, unexpected: [] as string[], errors: [] as string[] };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === base) {
      if (state.failReloadOnce && state.revisionId !== null) { state.failReloadOnce = false; return route.fulfill({ status: 503, json: { error: { message: "Synthetic reload failure" } } }); }
      return route.fulfill({ json: { revisionId: state.revisionId, profile: state.profile, updatedAt: state.revisionId ? "2026-09-07T12:00:00Z" : null } });
    }
    if (path === `${base}/targets`) return route.fulfill({ json: { total: 1, rows: [{ id: "Mailers", name: "Mailers" }] } });
    if (path === `${base}/reviews` || path === `${base}/reviews/${reviewId}`) {
      if (route.request().method() === "POST") state.reviews.push(route.request().postDataJSON());
      const input = state.reviews.at(-1)!;
      const pageNumber = Number(url.searchParams.get("page") ?? "0");
      const changedPrice = 1152;
      return route.fulfill({ json: { reviewId, reviewHash: "a".repeat(64), createdAt: "2026-09-07T12:00:00Z", page: pageNumber,
        summary: { total: 1000, changed: input.releaseFixedOverrides ? 1000 : 999, preserved: input.releaseFixedOverrides ? 0 : 1, blocked: state.block ? 1 : 0 },
        rows: Array.from({ length: 50 }, (_, index) => ({ productVariantId: pageNumber * 50 + index + 1,
          title: `Test mailer ${pageNumber * 50 + index + 1}`, sku: `TEST-${pageNumber * 50 + index + 1}`,
          previousPriceCents: 999, priceCents: state.block && index === 0 ? null : changedPrice, productCostCents: 809,
          ruleName: "Store default rule", preserved: false, issues: state.block && index === 0 ? ["pricing_basis_unavailable"] : [],
          settingRevisionId: null, evidenceHash: "b".repeat(64) })) } });
    }
    if (path === `${base}/apply`) {
      state.applies.push(route.request().postDataJSON());
      state.profile = state.reviews.at(-1)!.profile; state.revisionId = 1;
      if (state.abortApplyOnce) { state.abortApplyOnce = false; return route.abort("failed"); }
      return route.fulfill({ json: { revisionId: 1, idempotentReplay: state.applies.length > 1 } });
    }
    state.unexpected.push(path); return route.fulfill({ status: 500, json: { error: { message: "Unexpected synthetic request" } } });
  });
  await page.route("**/__pricing-rules-test", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><main id="root" style="max-width:1100px;margin:24px auto;padding:12px"></main>
    <script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-pricing-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__pricing-rules-test");
  await expect(page.getByLabel("Markup (%)", { exact: true }), JSON.stringify(state.errors)).toBeVisible();
  return state;
}
async function enterRecipe(page: Page) {
  await page.getByLabel("Markup (%)", { exact: true }).fill("30");
  await page.getByLabel("Plus flat markup (USD)", { exact: true }).fill("1.00");
}
test("reviews 1,000 listings with bounded scrolling and applies once without publishing", async ({ page }, testInfo) => {
  const state = await setup(page); await enterRecipe(page);
  await page.getByRole("button", { name: "Review pricing impact" }).click();
  await expect(page.getByText("Review all 1,000 selected listings")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(50);
  expect(state.reviews[0]).toMatchObject({ releaseFixedOverrides: false, profile: { defaultRecipe: { markupBps: 3000, flatCents: 100 } } });
  const scroll = await page.locator("table").evaluate((table) => ({ height: table.parentElement!.clientHeight, scrollHeight: table.parentElement!.scrollHeight }));
  expect(scroll.height).toBeLessThanOrEqual(320); expect(scroll.scrollHeight).toBeGreaterThan(scroll.height);
  await page.screenshot({ path: testInfo.outputPath("pricing-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Test mailer 51", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply reviewed rules to 999 listings" }).click();
  await expect(page.getByRole("status")).toContainText("Pricing rules saved");
  expect(state.applies).toHaveLength(1); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __pricingChanged: number }).__pricingChanged)).toBe(1);
});
test("keeps named groups editable and invalidates a review when the recipe changes", async ({ page }) => {
  const state = await setup(page); await enterRecipe(page);
  await page.getByRole("button", { name: "Add group rule" }).click();
  await page.getByLabel("Group name", { exact: true }).fill("Mailer group");
  await expect(page.getByText("Mailers", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Mailers", exact: true }).check();
  await page.getByRole("button", { name: "Review pricing impact" }).click();
  expect(state.reviews[0].profile.groups[0]).toMatchObject({ name: "Mailer group", scope: { type: "category", category: "Mailers" } });
  await page.getByLabel("Markup (%)", { exact: true }).first().fill("35");
  await expect(page.getByRole("button", { name: /Apply reviewed rules/ })).toHaveCount(0);
  expect(state.applies).toHaveLength(0);
});
test("blocks missing costs and preserves the same apply key after an ambiguous network failure", async ({ page }) => {
  const state = await setup(page); await enterRecipe(page); state.block = true;
  await page.getByRole("button", { name: "Review pricing impact" }).click();
  await expect(page.getByRole("button", { name: /Apply reviewed rules/ })).toBeDisabled();
  state.block = false; await page.getByRole("button", { name: "Review pricing impact" }).click();
  state.abortApplyOnce = true;
  await page.getByRole("button", { name: /Apply reviewed rules/ }).click();
  await expect(page.getByRole("alert")).toContainText("outcome was not confirmed");
  await expect(page.getByLabel("Markup (%)", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry same apply" }).click();
  await expect(page.getByRole("status")).toContainText("Pricing rules saved");
  expect(state.applies).toHaveLength(2); expect(state.applies[0]).toEqual(state.applies[1]);
});
test("uses read-only recovery when approval succeeded but refreshing failed", async ({ page }) => {
  const state = await setup(page); await enterRecipe(page);
  await page.getByRole("button", { name: "Review pricing impact" }).click(); state.failReloadOnce = true;
  await page.getByRole("button", { name: /Apply reviewed rules/ }).click();
  await expect(page.getByRole("alert")).toContainText("Rules saved, but refresh failed");
  await expect(page.getByRole("button", { name: "Retry same apply" })).toHaveCount(0);
  await page.getByRole("button", { name: "Reload saved rules" }).click();
  await expect(page.getByLabel("Markup (%)", { exact: true })).toBeEnabled();
  expect(state.applies).toHaveLength(1);
});
