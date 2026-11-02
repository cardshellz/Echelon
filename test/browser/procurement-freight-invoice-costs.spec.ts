import { test, expect, type Page } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";
import { invoiceSourceFixture } from "../fixtures/invoice-source";
import { freightInvoiceContextSchema, freightInvoicePreviewSchema } from "../../shared/procurement/freight-invoice-costs";

async function setup(page: Page, options: { saved?: boolean; forbidden?: "terminal" | "middleware"; lost?: boolean; blocked?: boolean } = {}) {
  const failures = await installFixtures(page), writes: Array<{ key: string; body: unknown }> = [];
  let forbidden = options.forbidden, lost = options.lost, accepted = options.saved ?? false, measured: ReturnType<typeof freightInvoicePreviewSchema.parse>;
  const charges = [{ chargeId: 31, shipmentId: 42, label: "Ocean freight", estimatedCents: 20000, actualCents: 20000, invoiceCents: 22000 }];
  const preview = () => freightInvoicePreviewSchema.parse({
    invoiceId: 71, invoiceNumber: "FREIGHT-71", sourceVersion: "a".repeat(64), previewVersion: "b".repeat(64),
    invoiceAmountCents: 22000, paidAmountCents: 0, balanceCents: 22000,
    invoiceStatus: { before: "received", after: "approved" }, charges,
    shipmentStates: [{ shipmentId: 42, shipmentNumber: "TEST-SHIP-42", state: "applied" }],
    allocations: [{ chargeId: 31, shipmentId: 42, shipmentLineId: 11, purchaseOrderId: 17, purchaseOrderNumber: "TEST-PO-17", purchaseOrderLineId: 18,
      label: "Test goods", shippedPieces: 100, amountCents: { before: 20000, after: 22000 } }],
    impact: { lots: [], orderCosts: [{ costId: 5, orderId: 6, quantity: 1, totalMills: { before: 1000000, after: 1100000 } }], historicalCosts: [] },
    inventoryValues: [{ lotId: 7, lotNumber: "RECEIVED-GOODS", onHandUnits: 1, beforeMills: 1000000, afterMills: 1100000, reviewReason: null }], issues: [],
  });
  await page.route("**/api/vendor-invoices/71", route => route.fulfill({ json: {
    id: 71, invoiceNumber: "FREIGHT-71", inboundShipmentId: 42, sourceCapabilities: invoiceSourceFixture("shipment"),
    status: accepted ? "approved" : "received", currency: "USD", invoicedAmountCents: 22000, paidAmountCents: 0, creditedAmountCents: 0, balanceCents: 22000,
    hasSupplierCreditHistory: false, poLinks: [], lines: [{ id: 51, lineNumber: 1, freightCostId: 31, description: "Ocean freight", qtyInvoiced: 1, unitCostMills: 2200000, unitCostCents: 22000, lineTotalCents: 22000 }], attachments: [], payments: [],
  } }));
  await page.route("**/api/vendor-invoices/71/shipment-cost-review", route => route.fulfill({ json: freightInvoiceContextSchema.parse({
    invoiceId: 71, invoiceNumber: "FREIGHT-71", sourceVersion: accepted ? "c".repeat(64) : "a".repeat(64),
    canApprove: !options.blocked, blockedReason: options.blocked ? "A current Administrator must approve this update." : null, requiresChange: !accepted,
    charges, shipments: [{ id: 42, number: "TEST-SHIP-42", status: "closed" }], invoiceStatus: accepted ? "approved" : "received",
    invoiceAmountCents: 22000, paidAmountCents: 0, balanceCents: 22000,
    originalApproval: { actorId: accepted ? "administrator" : null, actorName: accepted ? "Purchasing administrator" : null, approvedAt: accepted ? "2026-11-01T12:00:00Z" : null },
    history: accepted ? [{ actorName: "Purchasing administrator", approvedAt: "2026-11-01T12:01:00Z", reason: "Checked final supplier freight bill", preview: measured ?? preview() }] : [],
  }) }));
  await page.route("**/api/vendor-invoices/71/shipment-cost-review/preview", route => {
    measured = preview(); return route.fulfill({ json: measured });
  });
  await page.route("**/api/vendor-invoices/71/shipment-cost-review/approve", route => {
    writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (forbidden) return route.fulfill({ status: 403, ...(forbidden === "terminal" ? { headers: { "Idempotency-Replayed": "false" } } : {}), json: { code: "FREIGHT_INVOICE_ADMIN_REQUIRED", error: "Administrator approval is required." } });
    accepted = true;
    if (lost) return route.abort("failed");
    return route.fulfill({ json: { approvalEventId: 421, auditEventId: 422, preview: measured } });
  });
  await page.goto("/ap-invoices/71?tab=lines&purchase=purchase%3A17%3Alines&via=shipment%3A42%3Aallocation");
  async function open() {
    await page.getByRole("button", { name: /^(Review & approve|Shipment costs)$/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  }
  await open();
  return { dialog: page.getByRole("dialog"), writes, failures, open, release: () => { forbidden = undefined; lost = false; } };
}
async function review(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByLabel("Reason / supplier reference", { exact: true })).toBeVisible();
}
async function approve(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason / supplier reference", { exact: true }).fill("Checked final freight invoice and all cost changes");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Approve & update costs", exact: true }).click();
}
test("shows before/after and posts a single reviewed invoice update", async ({ page }, info) => {
  const proof = await setup(page); await review(page);
  await expect(proof.dialog.getByRole("table")).toContainText("$200.00");
  await expect(proof.dialog.getByRole("table")).toContainText("$220.00");
  expect(proof.writes).toEqual([]);
  await proof.dialog.screenshot({ path: info.outputPath("freight-invoice-before-after.png") });
  await approve(page);
  await expect(proof.dialog.getByRole("heading", { name: "Approved cost update", exact: true })).toBeVisible();
  expect(proof.writes).toHaveLength(1); expect(proof.writes[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(proof.writes[0].body).toMatchObject({ sourceVersion: "a".repeat(64), previewVersion: "b".repeat(64), approvalConfirmed: true });
  expect(proof.failures).toEqual([]);
});
test("shows existing approval instead of offering another unchanged approval", async ({ page }) => {
  const proof = await setup(page, { saved: true });
  await expect(proof.dialog.getByText("Invoice amounts already match the saved shipment charges.", { exact: true })).toBeVisible();
  await expect(proof.dialog.getByText(/Invoice approved by Purchasing administrator/)).toBeVisible();
  await expect(proof.dialog.getByRole("button", { name: "Review changes", exact: true })).toHaveCount(0);
  expect(proof.writes).toEqual([]); expect(proof.failures).toEqual([]);
});
test("does not offer approval when current administrator authority is missing", async ({ page }) => {
  const proof = await setup(page, { blocked: true });
  await expect(proof.dialog.getByRole("status")).toContainText("A current Administrator");
  await expect(proof.dialog.getByRole("button", { name: "Review changes", exact: true })).toHaveCount(0);
  expect(proof.writes).toEqual([]);
});
test("recovers the same review and key after a committed response is lost and the page reloads", async ({ page }) => {
  const proof = await setup(page, { lost: true }); await review(page); await approve(page);
  await expect.poll(() => proof.writes.length, { timeout: 30_000 }).toBe(4);
  await expect(proof.dialog.getByRole("button", { name: "Close", exact: true }).first()).toBeEnabled({ timeout: 10_000 });
  await page.reload(); await proof.open();
  await expect(proof.dialog.getByRole("heading", { name: "Saved approval awaiting confirmation", exact: true })).toBeVisible();
  proof.release(); await proof.dialog.getByRole("button", { name: "Retry saved approval", exact: true }).click();
  await expect(proof.dialog.getByRole("heading", { name: "Approved cost update", exact: true })).toBeVisible();
  expect(new Set(proof.writes.map(row => row.key)).size).toBe(1);
  expect(proof.writes.every(row => JSON.stringify(row.body) === JSON.stringify(proof.writes[0].body))).toBe(true);
  expect(proof.failures).toEqual([]);
});
test("requires a fresh review and key after a recorded authority rejection", async ({ page }) => {
  const proof = await setup(page, { forbidden: "terminal" }); await review(page); await approve(page);
  await expect(proof.dialog.getByRole("button", { name: "Reload current costs", exact: true })).toBeVisible();
  proof.release(); await proof.dialog.getByRole("button", { name: "Reload current costs", exact: true }).click();
  await review(page); await approve(page);
  await expect(proof.dialog.getByRole("heading", { name: "Approved cost update", exact: true })).toBeVisible();
  expect(proof.writes).toHaveLength(2); expect(proof.writes[0].key).not.toBe(proof.writes[1].key); expect(proof.failures).toEqual([]);
});
test("retains an unknown permission-gated outcome until the same approval can be verified", async ({ page }) => {
  const proof = await setup(page, { forbidden: "middleware" }); await review(page); await approve(page);
  await expect(proof.dialog.getByRole("button", { name: "Retry saved approval", exact: true })).toBeEnabled();
  proof.release(); await proof.dialog.getByRole("button", { name: "Retry saved approval", exact: true }).click();
  await expect(proof.dialog.getByRole("heading", { name: "Approved cost update", exact: true })).toBeVisible();
  expect(new Set(proof.writes.map(row => row.key)).size).toBe(1); expect(proof.failures).toEqual([]);
});
test("keeps the exact PO shipment-line selection and return journey", async ({ page }) => {
  const proof = await setup(page); await review(page);
  await proof.dialog.getByText("Shipment and PO cost shares", { exact: true }).click();
  await proof.dialog.getByRole("link", { name: "TEST-PO-17", exact: true }).click();
  await expect(page).toHaveURL(/\/purchase-orders\/17\?/);
  const url = new URL(page.url()); expect(url.searchParams.get("shipmentLine")).toBe("11"); expect(url.searchParams.get("poScope")).toBe("17");
  await page.getByRole("link", { name: /Back to invoice #71/i }).click();
  await expect(page).toHaveURL(/\/ap-invoices\/71\?/);
  await page.getByRole("link", { name: /Back to shipment #42/i }).click();
  await expect(page).toHaveURL(/\/shipments\/42\?tab=allocation/);
  expect(proof.writes).toEqual([]); expect(proof.failures).toEqual([]);
});
