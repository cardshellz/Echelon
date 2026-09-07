import { expect, test, type Page } from "@playwright/test";
import type { InvoiceCostReview, InvoiceCostReviewResult } from "../../shared/procurement/invoice-cost-review";
import { installFixtures } from "./procurement-fixtures";

const version = "a".repeat(64), nextVersion = "b".repeat(64);

async function setup(page: Page, options: { canApprove?: boolean; currency?: string; lostResponse?: boolean; stale?: boolean; needsReview?: boolean } = {}) {
  const failures = await installFixtures(page);
  const invoice = { id: 71, invoiceNumber: "TEST-INV-71", vendorId: 2, vendorName: "Test supplier", status: "received", currency: options.currency ?? "USD",
    invoicedAmountCents: 11800, balanceCents: 11800, paidAmountCents: 0, poLinks: [], attachments: [], payments: [],
    lines: [{ id: 72, lineNumber: 1, sku: "REVIEW-SKU", productName: "Synthetic product", qtyInvoiced: 150, unitCostCents: 67,
      unitCostMills: 6667, lineTotalCents: 11800, matchStatus: "matched", costComponentEvidence: null as unknown, costReviewVersion: version }] };
  const commands: Array<{ key: string; body: InvoiceCostReview }> = [];
  const replays = new Map<string, InvoiceCostReviewResult>();
  let lost = false, stale = options.stale ?? false;
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: "cost-reviewer", username: "test", role: "admin" }, permissions: options.canApprove === false ? ["purchasing:view"] : ["purchasing:view", "purchasing:approve"], roles: ["admin"] } }));
  await page.route("**/api/vendor-invoices/71", (route) => route.fulfill({ json: invoice }));
  await page.route("**/api/vendor-invoice-lines/72/cost-components", async (route) => {
    const request = route.request(), key = request.headers()["idempotency-key"], body = request.postDataJSON() as InvoiceCostReview;
    commands.push({ key, body });
    if (stale) { stale = false; invoice.lines[0].costReviewVersion = nextVersion; return route.fulfill({ status: 409, json: { error: "Invoice line changed. Refresh and review the current amounts.", details: { code: "INVOICE_COST_REVIEW_STALE" } } }); }
    if (replays.has(key)) return route.fulfill({ json: replays.get(key) });
    const evidence = { contractVersion: 1 as const, packagingTreatment: body.packagingTreatment, productMills: body.productMills, packagingMills: body.packagingMills, adjustmentMills: body.adjustmentMills, source: "operator_review" as const };
    const response: InvoiceCostReviewResult = { id: 72, costComponentEvidence: evidence, costReviewVersion: nextVersion,
      application: options.needsReview ? { costSources: [], lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0,
        costApplications: [{ applicationId: 1, status: "review_required", lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0, replayed: false,
          issues: [{ code: "INVOICE_COMPONENT_TOTAL_REVIEW", message: "The signed adjustment needs a supported cost disposition." }] }] } : null };
    invoice.lines[0].costComponentEvidence = evidence; invoice.lines[0].costReviewVersion = nextVersion;
    replays.set(key, response);
    if (options.lostResponse && !lost) { lost = true; return route.abort("connectionreset"); }
    return route.fulfill({ json: response });
  });
  await page.goto("/ap-invoices/71?tab=lines");
  await page.getByRole("button", { name: "Review costs for REVIEW-SKU" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  return { commands, invoice, failures };
}

async function fill(page: Page, options: { product?: string; packaging?: string; adjustment?: string } = {}) {
  await page.getByLabel("Packaging treatment", { exact: true }).click();
  await page.getByRole("option", { name: "Separate amount confirmed" }).click();
  await page.getByLabel(/^Extended product cost/).fill(options.product ?? "100.0000");
  await page.getByLabel(/^Extended packaging cost/).fill(options.packaging ?? "18.0000");
  await page.getByLabel(/^Other adjustments/).fill(options.adjustment ?? "0");
  await page.getByLabel("Review reason / supplier reference").fill("Final supplier breakdown reviewed");
}

test("reviews unknown amounts, retries a lost acknowledgement and preserves the invoice", async ({ page }, testInfo) => {
  const { commands, invoice, failures } = await setup(page, { lostResponse: true });
  await expect(page.getByLabel(/^Extended product cost/)).toHaveValue("");
  await expect(page.getByLabel(/^Extended packaging cost/)).toHaveValue("");
  await expect(page.getByLabel(/^Other adjustments/)).toHaveValue("");
  await expect(page.getByText("Component amounts are unknown.", { exact: false })).toBeVisible();
  await fill(page);
  await page.getByRole("button", { name: "Save cost review", exact: true }).click();
  await expect(page.getByText("Cost evidence saved. The invoice line total is unchanged.")).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual(commands[1]);
  expect(commands[0].key).toBeTruthy();
  expect(commands[0].body).toMatchObject({ expectedVersion: version, productMills: 1_000_000, packagingMills: 180_000, adjustmentMills: 0 });
  expect(invoice.lines[0].lineTotalCents).toBe(11800);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("invoice-cost-review.png"), fullPage: true });
  expect(failures).toEqual([]);
});

test("requires exact reconciliation and explicit packaging treatment before saving", async ({ page }) => {
  const { commands, failures } = await setup(page);
  await fill(page, { adjustment: "-0.0001" });
  await page.getByRole("button", { name: "Save cost review", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("exactly");
  expect(commands).toEqual([]);
  await page.getByLabel(/^Other adjustments/).fill("0");
  await page.getByLabel("Packaging treatment", { exact: true }).click();
  await page.getByRole("option", { name: "Included in product amount" }).click();
  await page.getByRole("button", { name: "Save cost review", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("zero");
  expect(commands).toEqual([]);
  expect(failures).toEqual([]);
});

test("preserves signed adjustments and distinguishes evidence saved from application review", async ({ page }) => {
  const { commands, failures } = await setup(page, { needsReview: true });
  await fill(page, { product: "101.0375", packaging: "17.9625", adjustment: "-1" });
  await page.getByRole("button", { name: "Save cost review", exact: true }).click();
  await expect(page.getByText("Further cost review is required", { exact: false })).toBeVisible();
  await expect(page.getByText("The signed adjustment needs a supported cost disposition.")).toBeVisible();
  expect(commands[0].body).toMatchObject({ productMills: 1_010_375, packagingMills: 179_625, adjustmentMills: -10_000 });
  expect(failures).toEqual([]);
});

test("keeps the reviewed snapshot on a stale response and requires explicit reload", async ({ page }) => {
  const { commands, failures } = await setup(page, { stale: true });
  await fill(page);
  await page.getByRole("button", { name: "Save cost review", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Invoice line changed");
  await expect(page.getByLabel(/^Extended product cost/)).toHaveValue("100.0000");
  await expect(page.getByRole("button", { name: "Save cost review", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Discard review and reload invoice" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Review costs for REVIEW-SKU" }).click();
  await fill(page);
  await page.getByRole("button", { name: "Save cost review", exact: true }).click();
  await expect(page.getByText("Cost evidence saved. The invoice line total is unchanged.")).toBeVisible();
  expect(commands.map((command) => command.body.expectedVersion)).toEqual([version, nextVersion]);
  expect(commands[0].key).not.toBe(commands[1].key);
  expect(failures).toEqual([]);
});

test("view permission permits inspection and approval permission gates the command", async ({ page }) => {
  const { commands, failures } = await setup(page, { canApprove: false });
  await expect(page.getByText("Purchasing approval permission is required", { exact: false })).toBeVisible();
  await expect(page.getByLabel(/^Extended product cost/)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save cost review", exact: true })).toHaveCount(0);
  expect(commands).toEqual([]); expect(failures).toEqual([]);
});

test("keeps non-USD evidence read only with its actual currency", async ({ page }) => {
  const { commands, failures } = await setup(page, { currency: "EUR" });
  await expect(page.getByRole("dialog")).toContainText("118.00 EUR");
  await expect(page.getByRole("dialog")).not.toContainText("$");
  await expect(page.getByRole("button", { name: "Save cost review", exact: true })).toHaveCount(0);
  expect(commands).toEqual([]); expect(failures).toEqual([]);
});
