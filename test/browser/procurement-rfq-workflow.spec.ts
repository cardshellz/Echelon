import { reviewRfqQuantity } from "../../shared/procurement/rfq-quantity-review";
import { expect, test, type Page } from "@playwright/test";
import type { RfqQuoteEvidence, RfqWorkflowDetail } from "../../shared/procurement/rfq-workflow";
import { normalizePoLinePricing } from "../../shared/utils/po-line-pricing";
import { installFixtures } from "./procurement-fixtures";

const initialVersion = "a".repeat(64);
const nextVersion = "b".repeat(64);

async function setup(page: Page, options: { canEdit?: boolean; currency?: string; lostResponse?: boolean } = {}) {
  const failures = await installFixtures(page);
  const rules = { vendorProductId: 300, minimumOrderPieces: 1, piecesPerPurchaseUom: null, packSize: 1 };
  const workflow: RfqWorkflowDetail = {
    id: 10, rfqNumber: "TEST-RFQ-10", vendorId: 5, currency: options.currency ?? "USD", status: "draft", version: initialVersion,
    lines: [{ id: 20, status: "draft", productId: 100, productVariantId: 200, warehouseId: 1, vendorProductId: 300, sku: "RFQ-CASE", productName: "Fictional RFQ product", requestedPieces: 150, quantityReview: reviewRfqQuantity({ recommendationRules: rules, currentRules: rules, quotedPieces: 150 }), latestQuote: null, purchaseOrder: null }],
  };
  const commands: Array<{ path: string; key: string; body: Record<string, unknown> }> = [];
  const replays = new Map<string, unknown>();
  let lost = false;
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: "rfq-reviewer", username: "test", role: "admin" }, permissions: options.canEdit === false ? ["inventory:view"] : ["inventory:view", "purchasing:edit"], roles: ["admin"] } }));
  await page.route("**/api/purchasing/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      // An empty recent list proves exact links are independent of pagination.
      if (path === "/api/purchasing/rfqs") return route.fulfill({ json: { rfqs: [], count: 0, statusCounts: {}, limit: 25 } });
      if (path === "/api/purchasing/rfq-queue") return route.fulfill({ json: { run: null, items: [], summary: { open: 0, partiallyAllocated: 0, fullyAllocated: 0, supplierAssignmentRequired: 0, activeRfqs: 0 } } });
      if (path === "/api/purchasing/rfqs/10") return route.fulfill({ json: workflow });
      if (path === "/api/purchasing/rfqs/10/lines/20/quotes") return route.fulfill({ json: { revisions: workflow.lines[0].latestQuote ? [workflow.lines[0].latestQuote] : [], nextBeforeRevision: null } });
      return route.fallback();
    }
    if (!["/api/purchasing/rfqs/10/lines/20/quotes", "/api/purchasing/rfqs/10/convert"].includes(path)) return route.fallback();
    const key = request.headers()["idempotency-key"];
    const body = request.postDataJSON() as Record<string, unknown>;
    commands.push({ path, key, body });
    if (!key) return route.fulfill({ status: 400, json: { code: "MISSING_KEY", error: "Missing command identity" } });
    if (replays.has(key)) return route.fulfill({ json: replays.get(key) });
    let response: unknown;
    if (path.endsWith("/quotes")) {
      const quote = body.quote as RfqQuoteEvidence;
      const exact = normalizePoLinePricing(quote.pricing);
      workflow.status = "quoted";
      workflow.version = nextVersion;
      workflow.lines[0].status = "quoted";
      workflow.lines[0].latestQuote = { id: 7, rfqLineId: 20, revision: 1, fingerprint: "c".repeat(64), currency: workflow.currency, quotedPieces: exact.orderQty, quotedUnitCostMills: exact.unitCostMills, productTotalMills: exact.quotedExtendedMills, pricingRemainderMills: exact.pricingRemainderMills, quote, createdBy: "rfq-reviewer", createdAt: "2026-09-07T12:00:00Z" };
      response = structuredClone(workflow);
    } else {
      workflow.version = "d".repeat(64);
      workflow.lines[0].status = "ordered";
      workflow.lines[0].purchaseOrder = { purchaseOrderId: 99, purchaseOrderLineId: 900, quoteRevisionId: 7, poNumber: "TEST-PO-99", status: "draft" };
      response = { rfqId: 10, purchaseOrderId: 99, poNumber: "TEST-PO-99", status: "draft", lines: [{ rfqLineId: 20, quoteRevisionId: 7, purchaseOrderLineId: 900 }] };
    }
    replays.set(key, response);
    if (options.lostResponse && !lost) { lost = true; return route.abort("connectionreset"); }
    return route.fulfill({ json: response });
  });
  await page.goto("/procurement/rfqs?rfqId=10");
  await expect(page.getByRole("heading", { name: /TEST-RFQ-10/ })).toBeVisible();
  return { commands, workflow, failures };
}

async function capture(page: Page, options: { packaging?: boolean } = {}) {
  await page.getByRole("button", { name: "Capture quote", exact: true }).click();
  await page.getByLabel("Quoted price basis").click();
  await page.getByRole("option", { name: "Extended product total" }).click();
  await page.getByLabel(/^Product total/).fill("100.00");
  await page.getByLabel("Supplier quote reference").fill("VENDOR-QUOTE-1");
  await page.getByLabel("Quote date", { exact: true }).fill("2026-09-07");
  await page.getByLabel("Quote note / reason for revision").fill("Final supplier quote received");
  if (options.packaging !== false) {
    await page.getByLabel("Packaging treatment").click();
    await page.getByRole("option", { name: "Separate amount confirmed" }).click();
    await page.getByLabel(/^Total packaging/).fill("18.00");
  }
  await page.getByRole("button", { name: "Save quote revision" }).click();
  await expect(page.getByRole("button", { name: "Revise quote" })).toBeVisible();
}

test("captures exact economics, retries a lost response and opens the linked purchase", async ({ page }, testInfo) => {
  const { commands, failures } = await setup(page, { lostResponse: true });
  await capture(page);
  expect(commands).toHaveLength(2);
  expect(commands[0].key).toBe(commands[1].key);
  expect(commands[0].body).toEqual(commands[1].body);
  expect(commands[0].body).toMatchObject({ expectedVersion: initialVersion, quote: { pricing: { basis: "extended_total", quotedTotalCents: 10000, quantityPieces: 150 }, packagingCostCents: 1800 } });
  await expect(page.getByText(/Quoted product total: 100.0000 USD/)).toBeVisible();
  await page.getByRole("button", { name: "Quote history", exact: true }).click();
  await expect(page.getByText("Preserved quote revisions")).toBeVisible();
  await page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" }).check();
  await page.getByRole("button", { name: "Create draft PO (1 selected)" }).click();
  await expect(page.getByText("Draft created:")).toBeVisible();
  expect(commands.at(-1)?.body).toEqual({ expectedVersion: nextVersion, lines: [{ rfqLineId: 20, quoteRevisionId: 7 }], quantityOverrideReason: null });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("rfq-quote-purchase-link.png"), fullPage: true });
  await page.getByRole("link", { name: "TEST-PO-99", exact: true }).first().click();
  await expect(page).toHaveURL(/\/purchase-orders\/99(?:\?|$)/);
  expect(failures).toEqual([]);
});

test("requires a fresh review of changed MOQ and pack while preserving vendor quantity", async ({ page }) => {
  const { commands, workflow, failures } = await setup(page);
  await capture(page);
  await page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" }).check();
  const priorRules = workflow.lines[0].quantityReview.currentRules!;
  workflow.lines[0].quantityReview = reviewRfqQuantity({ recommendationRules: priorRules, currentRules: { ...priorRules, minimumOrderPieces: 200, packSize: 100 }, quotedPieces: 150 });
  workflow.version = "e".repeat(64);
  await page.getByRole("button", { name: "Refresh quotes", exact: true }).click();
  await expect(page.getByText("Current supplier rules: MOQ 200 · Order multiple 100 pieces.")).toBeVisible();
  await expect(page.getByText("At recommendation: MOQ 1 · Order multiple 1 pieces.")).toBeVisible();
  await expect(page.getByText(/150 pieces are below the current MOQ of 200/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create draft PO (1 selected)" })).toBeDisabled();
  await page.getByRole("button", { name: "Clear selection and review current quotes" }).click();
  await page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" }).check();
  await expect(page.getByRole("button", { name: "Create draft PO (1 selected)" })).toBeDisabled();
  const reason = "Supplier explicitly confirmed a 150-piece exception";
  await page.getByLabel("Reason for accepting the quoted quantity").fill(reason);
  await page.getByRole("button", { name: "Create draft PO (1 selected)" }).click();
  await expect(page.getByText("Draft created:")).toBeVisible();
  expect(commands.at(-1)?.body).toEqual({ expectedVersion: "e".repeat(64), lines: [{ rfqLineId: 20, quoteRevisionId: 7 }], quantityOverrideReason: reason });
  expect(workflow.lines[0].latestQuote!.quotedPieces).toBe(150);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});

test("keeps unknown packaging visible and blocks purchase selection", async ({ page }) => {
  const { commands, failures } = await setup(page);
  await capture(page, { packaging: false });
  await expect(page.getByText("Packaging review required")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" })).toBeDisabled();
  expect(commands).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("preserves foreign quote currency without displaying a dollar denomination", async ({ page }) => {
  const { failures } = await setup(page, { currency: "EUR" });
  await capture(page);
  await expect(page.getByText(/Quoted product total: 100.0000 EUR/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Quote capture and purchase-order handoff" })).not.toContainText("$");
  await expect(page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" })).toBeDisabled();
  expect(failures).toEqual([]);
});

test("view-only users can follow an exact RFQ without quote or purchase mutation controls", async ({ page }) => {
  const { commands, failures } = await setup(page, { canEdit: false });
  await expect(page.getByRole("button", { name: "Capture quote", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Create draft PO/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Quote history", exact: true }).click();
  await expect(page.getByText("No versioned quote has been captured.", { exact: false })).toBeVisible();
  expect(commands).toEqual([]);
  expect(failures).toEqual([]);
});

test("requires renewed selection after the quote evidence changes", async ({ page }) => {
  const { workflow, commands, failures } = await setup(page);
  await capture(page);
  await page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" }).check();
  workflow.version = "e".repeat(64);
  await page.getByRole("button", { name: "Refresh quotes", exact: true }).click();
  await expect(page.getByText("The quote request changed after selection.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create draft PO (1 selected)" })).toBeDisabled();
  await page.getByRole("button", { name: "Clear selection and review current quotes" }).click();
  await expect(page.getByRole("button", { name: "Create draft PO (0 selected)" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" }).check();
  await expect(page.getByRole("button", { name: "Create draft PO (1 selected)" })).toBeEnabled();
  expect(commands).toHaveLength(1);
  expect(failures).toEqual([]);
});