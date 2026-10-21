import { expect, test, type Page } from "@playwright/test";
import { rfqWorkListResponseSchema, type RfqWorkListItem } from "../../shared/procurement/rfq-work-list";
import { installFixtures } from "./procurement-fixtures";

function item(id: number): RfqWorkListItem {
  return {
    id, rfqNumber: `TEST-RFQ-${id}`, status: id === 125 ? "quoted" : "draft", vendorId: 5, vendorName: "Fictional supplier",
    requestNote: null, currency: "USD", responseDueDate: null, createdBy: "reader",
    createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z", sentAt: null, respondedAt: null, cancelledAt: null,
    lineCount: 1, requestedPiecesTotal: 10,
    lines: [{ id, rfqId: id, recommendationLineId: id, recommendationRunId: 1, vendorProductId: 300,
      vendorSku: null, sku: `SKU-${id}`, productName: `Fictional product ${id}`, status: id === 125 ? "ordered" : "draft",
      requestedPieces: 10, recommendedPieces: 10, purchaseUom: null, piecesPerPurchaseUom: null,
      quantityOverrideReason: null, allocationOverrideReason: null, allocationOverrideApprovedBy: null,
      allocationOverrideApprovedAt: null, allocationOverrideBaselinePieces: null, allocationOverrideExcessPieces: null,
      quotedPieces: null, quotedUnitCostMills: null, quoteReference: null, quoteValidUntil: null, quotedAt: null }],
    handoff: { state: id === 125 ? "converted" : "not_started", linkedLineCount: id === 125 ? 1 : 0,
      remainingLineCount: id === 125 ? 0 : 1, issues: [],
      purchaseOrders: id === 125 ? [{ id: 99, poNumber: "TEST-PO-99", status: "cancelled" }] : [] },
  };
}

async function setup(page: Page) {
  const failures = await installFixtures(page);
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "purchasing-reader", username: "reader", role: "admin" }, permissions: ["purchasing:view"], roles: ["admin"] } }));
  await page.route("**/api/purchasing/rfq-queue", route => route.fulfill({ json: { run: null, items: [], summary: { open: 0, partiallyAllocated: 0, fullyAllocated: 0, supplierAssignmentRequired: 0, activeRfqs: 0 } } }));
  return failures;
}

function listResponse(items: RfqWorkListItem[], url: string) {
  const params = new URL(url).searchParams;
  const limit = Number(params.get("limit") ?? 25);
  const offset = Number(params.get("offset") ?? 0);
  const search = params.get("search") ?? "";
  const status = params.get("status");
  const filtered = items.filter(row => (!status || row.status === status)
    && (!search || row.rfqNumber.includes(search) || row.lines.some(line => line.sku === search)));
  const rfqs = filtered.slice(offset, offset + limit);
  const statusCounts: Record<string, number> = {};
  for (const row of rfqs) statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  return rfqWorkListResponseSchema.parse({ rfqs, count: rfqs.length, limit, statusCounts,
    page: { total: filtered.length, limit, offset, nextOffset: offset + rfqs.length < filtered.length ? offset + rfqs.length : null } });
}

test("finds RFQs beyond the newest 100 and keeps conversion provenance separate from PO status", async ({ page }, testInfo) => {
  const failures = await setup(page);
  const requests: URLSearchParams[] = [];
  const rows = Array.from({ length: 125 }, (_, index) => item(index + 1));
  await page.route("**/api/purchasing/rfqs?*", route => {
    requests.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: listResponse(rows, route.request().url()) });
  });
  await page.goto("/procurement/rfqs");
  const pages = page.getByRole("navigation", { name: "RFQs pages" });
  await expect(pages).toContainText("1–25 of 125 RFQs");
  for (const range of ["26–50", "51–75", "76–100", "101–125"]) {
    await pages.getByRole("button", { name: "Next", exact: true }).click();
    await expect(pages).toContainText(`${range} of 125 RFQs`);
  }
  await expect(page.getByText("TEST-RFQ-125", { exact: true })).toBeVisible();
  await expect(pages.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await page.getByRole("textbox", { name: "Search RFQs", exact: true }).fill("SKU-125");
  await expect(pages).toContainText("1–1 of 1 RFQs");
  expect(requests.at(-1)?.get("offset")).toBe("0");
  await expect(page.getByText("TEST-RFQ-125", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /TEST-PO-99/ })).toHaveAttribute("href", "/purchase-orders/99");
  await expect(page.getByRole("row").filter({ hasText: "TEST-RFQ-125" })).toContainText("cancelled");
  await page.getByRole("combobox", { name: "RFQ status", exact: true }).selectOption("draft");
  await expect(pages).toContainText("0 of 0 RFQs");
  await page.getByRole("textbox", { name: "Search RFQs", exact: true }).fill("");
  await expect(pages).toContainText("1–25 of 124 RFQs");
  expect(requests.at(-1)?.get("status")).toBe("draft");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("rfq-work-list.png"), fullPage: true });
  expect(failures).toEqual([]);
});

test("treats incomplete list evidence as unavailable instead of an empty work list", async ({ page }) => {
  const failures = await setup(page);
  let broken = true;
  await page.route("**/api/purchasing/rfqs?*", route => route.fulfill({ json: broken
    ? { rfqs: [], count: 0, limit: 25, statusCounts: {} }
    : listResponse([], route.request().url()) }));
  await page.goto("/procurement/rfqs");
  await expect(page.getByRole("alert").filter({ hasText: /quote-request/ }).first()).toBeVisible();
  broken = false;
  await page.getByRole("button", { name: "Reload quote requests", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "RFQs pages" })).toContainText("0 of 0 RFQs");
  expect(failures).toEqual([]);
});
