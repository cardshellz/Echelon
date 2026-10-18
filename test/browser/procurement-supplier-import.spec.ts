import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { SUPPLIER_EVIDENCE_IMPORT_HEADERS } from "../../client/src/features/supplier-catalog/supplierEvidenceImport";

const csv = [SUPPLIER_EVIDENCE_IMPORT_HEADERS.join(","),
  "TEST-10,SUP-10,per_piece,3.2500,,,REVIEWED-QUOTE,2026-10-18,2026-11-18,1,5,true"].join("\n");
function preview(sequence: number) {
  return { contractVersion: 2, generatedAt: "2026-10-18T12:00:00Z", previewHash: String(sequence).repeat(64),
    vendor: { id: 7, code: "TEST", name: "Synthetic supplier" },
    summary: { total: 1, creates: 0, updates: 1, reactivations: 0, preferredDemotions: sequence > 1 ? 1 : 0, warnings: sequence > 1 ? 1 : 0 },
    items: [{ rowNumber: 2, sku: "TEST-10", productName: "Synthetic product", variantName: null, action: "update",
      existingVendorProductId: 1, willDemoteVendorProductIds: sequence > 1 ? [2] : [], pricingBasis: "per_piece",
      quotedUnitCost: "3.2500", purchaseUom: null, piecesPerPurchaseUom: null, quoteReference: "REVIEWED-QUOTE",
      quotedAt: "2026-10-18T10:00:00Z", quoteValidUntil: "2026-11-18", quoteValidityStatus: "current",
      moqPieces: 1, leadTimeDays: 5, isPreferred: true,
      warnings: sequence > 1 ? ["1 currently preferred mapping(s) will be demoted."] : [] }] };
}
async function setup(page: Page, failure: "stale" | "unavailable" | null) {
  const state = { previews: 0, applies: [] as { key: string | undefined; hash: string }[], errors: [] as string[] };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/purchasing/supplier-evidence-import/preview") {
      state.previews++;
      return route.fulfill({ json: preview(state.previews) });
    }
    if (path === "/api/purchasing/supplier-evidence-import/apply") {
      state.applies.push({ key: route.request().headers()["idempotency-key"], hash: route.request().postDataJSON().previewHash });
      if (state.applies.length === 1 && failure) return route.fulfill({ status: failure === "stale" ? 409 : 503,
        json: failure === "stale" ? { error: "Supplier evidence changed after preview; preview the file again before applying it",
          details: { code: "SUPPLIER_EVIDENCE_PREVIEW_STALE" } } : { error: "Catalog temporarily unavailable. Retry this reviewed import." } });
      return route.fulfill({ json: { ...preview(state.previews), result: { updated: [{ vendorProductId: 1 }], created: [], skipped: [] } } });
    }
    state.errors.push(`Unexpected request ${route.request().method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });
  await page.route("**/__supplier-import-test", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/@fs/${resolve("test/browser/fixtures/procurement-supplier-import-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__supplier-import-test");
  await page.getByLabel("Verified evidence CSV").setInputFiles({ name: "synthetic-quotes.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Preview 1 row", exact: true }).click();
  await expect(page.getByText("REVIEWED-QUOTE", { exact: true })).toBeVisible();
  return state;
}
const applyButton = (page: Page) => page.getByRole("button", { name: "Apply atomically", exact: true });
const confirmation = (page: Page) => page.getByRole("checkbox");

test("stale locked import clears approval, preserves CSV and requires a fresh preview and confirmation", async ({ page }, testInfo) => {
  const state = await setup(page, "stale");
  await expect(applyButton(page)).toBeDisabled();
  await confirmation(page).check(); await applyButton(page).click();
  await expect(page.getByText("Supplier evidence was not applied", { exact: true })).toBeVisible();
  await expect(page.getByText("Supplier evidence changed after preview; preview the file again before applying it", { exact: true })).toBeVisible();
  await expect(confirmation(page)).toHaveCount(0);
  await expect(applyButton(page)).toBeDisabled();
  await expect(page.getByText("synthetic-quotes.csv", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Preview 1 row", exact: true }).click();
  await expect(page.getByText("1 currently preferred mapping(s) will be demoted.")).toBeVisible();
  await expect(confirmation(page)).not.toBeChecked();
  await expect(applyButton(page)).toBeDisabled();
  await expect.poll(() => page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("supplier-import-refreshed-review.png"), fullPage: true });
  await confirmation(page).check(); await applyButton(page).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Completed imports")).toHaveText("1");
  expect(state.applies).toHaveLength(2);
  expect(state.applies[0].key).toBeTruthy();
  expect(state.applies[1].key).not.toBe(state.applies[0].key);
  expect(state.applies.map(item => item.hash)).toEqual(["1".repeat(64), "2".repeat(64)]);
  expect(state.errors).toEqual([]);
});

test("temporary failure keeps the reviewed intent and idempotency key for retry", async ({ page }) => {
  const state = await setup(page, "unavailable");
  await confirmation(page).check(); await applyButton(page).click();
  await expect(page.getByText("Catalog temporarily unavailable. Retry this reviewed import.", { exact: true })).toBeVisible();
  await expect(confirmation(page)).toBeChecked();
  await expect(applyButton(page)).toBeEnabled();
  await expect(page.getByLabel("Completed imports")).toHaveText("0");
  await applyButton(page).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Completed imports")).toHaveText("1");
  expect(state.previews).toBe(1);
  expect(state.applies).toHaveLength(2);
  expect(state.applies[0]).toEqual(state.applies[1]);
  expect(state.errors).toEqual([]);
});

test("unchanged reviewed evidence applies once after explicit approval", async ({ page }) => {
  const state = await setup(page, null);
  await expect(applyButton(page)).toBeDisabled();
  await confirmation(page).check(); await applyButton(page).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Completed imports")).toHaveText("1");
  expect(state.applies).toHaveLength(1);
  expect(state.applies[0].hash).toBe("1".repeat(64));
  expect(state.errors).toEqual([]);
});
