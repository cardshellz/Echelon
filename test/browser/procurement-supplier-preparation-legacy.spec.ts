import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";

function purchaseWorkspace(purchase: Omit<ReturnType<typeof po>, "lines"> & { lines: readonly unknown[] }) {
  return { purchase: { ...purchase, currency: "USD", vendorName: "Test vendor", invoicedTotalCents: 0, paidTotalCents: 0,
    outstandingCents: 0, expectedDeliveryDate: null, confirmedDeliveryDate: null, actualDeliveryDate: null },
    shipments: [], receipts: [], invoices: [], edges: [], limitations: [] };
}

type Mode = "approved" | "pending_approval" | "preparation_failed" | "draft" | "malformed" | "unavailable";
async function setup(page: Page, mode: Mode) {
  await page.clock.setFixedTime(new Date("2026-10-18T12:00:00.000Z"));
  const failures = await installFixtures(page);
  const commands: Array<{ body: Record<string, unknown>; key: string | undefined }> = [];
  const vendor = { id: 2, code: "TEST", name: "Test vendor", country: "US", isActive: 1 };
  const product = { id: 10, sku: "TEST-PRODUCT", name: "Test catalog product", variants: [{ id: 20, sku: "TEST-EACH", name: "Each", unitsPerVariant: 1 }] };
  const status = mode === "approved" || mode === "pending_approval" ? mode : "draft";
  const purchase = { ...po(17), vendor, status, physicalStatus: "draft", updatedAt: "2026-10-18T12:00:00.000Z" };
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === "/api/settings/procurement") return route.fulfill({ json: { useNewPoEditor: false } });
      if (path === "/api/purchasing/approval-tiers") return route.fulfill({ json: { tiers: [] } });
      if (path === "/api/vendors") return route.fulfill({ json: [vendor] });
      if (path === "/api/products") return route.fulfill({ json: [product] });
      if (path === "/api/vendor-products") return route.fulfill({ json: [{
        id: 30, vendorId: 2, productId: 10, productVariantId: 20, vendorSku: "SUP-10",
        pricingBasis: "per_piece", quotedUnitCostMills: 10000, unitCostMills: 10000, unitCostCents: 100,
        moq: 1, quotedAt: "2026-10-17T12:00:00.000Z", quoteValidUntil: "2026-11-17", quoteReference: "QUOTE-10",
      }] });
      if (path === "/api/purchase-orders/17") return route.fulfill({ json: purchase });
      if (path === "/api/purchase-orders/17/workspace") return route.fulfill({ json: purchaseWorkspace(purchase) });
    }
    if (request.method() === "POST" && path === "/api/purchase-orders") {
      commands.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"] });
      if (mode === "malformed") return route.fulfill({ status: 201, json: { po: { ...purchase, id: "17" }, status, dispatch_recorded: false } });
      if (mode === "unavailable" && commands.length === 1) return route.fulfill({ status: 503, json: { error: "Creation response is unavailable. Retry the same request." } });
      if (mode === "draft") return route.fulfill({ status: 201, json: { po: purchase } });
      if (mode === "preparation_failed") return route.fulfill({ status: 201, json: { po: purchase, status, dispatch_recorded: false, sendError: "The supplier quote needs review." } });
      return route.fulfill({ status: 201, json: { po: { ...purchase, status: mode === "unavailable" ? "approved" : status },
        status: mode === "unavailable" ? "approved" : status, dispatch_recorded: false, pending_approval: status === "pending_approval" } });
    }
    return route.fallback();
  });
  await page.goto("/purchase-orders");
  await page.getByRole("button", { name: "New Purchase Order", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New Purchase Order", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("does not send it to the supplier");
  await dialog.getByRole("combobox", { name: "Vendor", exact: true }).click();
  await page.getByRole("option", { name: "TEST Test vendor" }).click();
  await dialog.getByRole("button", { name: "Add Line Item", exact: true }).click();
  await dialog.getByRole("button", { name: /Test catalog product/ }).click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog).toContainText("TEST-EACH");
  await expect(dialog.getByRole("button", { name: "Create & Review", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Create & Send", exact: true })).toHaveCount(0);
  return { dialog, commands, failures };
}

for (const mode of ["approved", "pending_approval", "preparation_failed"] as const) {
  test(`legacy create ${mode} reports saved preparation truthfully with the editor flag off`, async ({ page }, testInfo) => {
    const { dialog, commands, failures } = await setup(page, mode);
    await dialog.screenshot({ path: testInfo.outputPath("legacy-reviewed-create.png") });
    await dialog.getByRole("button", { name: "Create & Review", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/purchase-orders\/17(?:\?|$)/);
    const title = mode === "approved" ? "PO ready for supplier review" : mode === "pending_approval" ? "PO awaiting approval" : "PO saved; preparation needs attention";
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(page.getByText(/No supplier dispatch was recorded\./, { exact: false }).first()).toBeVisible();
    if (mode === "preparation_failed") await expect(page.getByText(/The supplier quote needs review\. Open the saved PO/).first()).toBeVisible();
    await expect(page.getByText("PO created (send failed)", { exact: true })).toHaveCount(0);
    await expect(page.getByText("PO created & sent", { exact: true })).toHaveCount(0);
    expect(commands).toHaveLength(1);
    expect(commands[0].body).toMatchObject({ prepare_for_supplier: true, vendorId: 2, lines: [{ productId: 10, expectedReceiveVariantId: 20 }] });
    expect(commands[0].body).not.toHaveProperty("advance_to_sent");
    expect(commands[0].key).toBeTruthy();
    expect(failures).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`legacy-${mode}.png`), fullPage: true });
  });
}

test("legacy Save Draft does not request supplier preparation", async ({ page }) => {
  const { dialog, commands, failures } = await setup(page, "draft");
  await dialog.getByRole("button", { name: "Save Draft", exact: true }).click();
  await expect(page).toHaveURL(/\/purchase-orders\/17(?:\?|$)/);
  await expect(page.getByText("TEST-PO-17 created as draft", { exact: true })).toBeVisible();
  expect(commands).toHaveLength(1);
  expect(commands[0].body.prepare_for_supplier).toBe(false);
  expect(commands[0].body).not.toHaveProperty("advance_to_sent");
  expect(failures).toEqual([]);
});

test("legacy malformed creation keeps the draft visible without false success or navigation", async ({ page }) => {
  const { dialog, commands, failures } = await setup(page, "malformed");
  await dialog.getByRole("button", { name: "Create & Review", exact: true }).click();
  await expect(page.getByText("PO save could not be verified. Reload purchase orders and check whether this PO was saved before retrying.", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("TEST-EACH");
  await expect(page).toHaveURL(/\/purchase-orders$/);
  await expect(page.getByText("PO ready for supplier review", { exact: true })).toHaveCount(0);
  expect(commands).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("legacy uncertain creation retries the same intent with the same idempotency key", async ({ page }) => {
  const { dialog, commands, failures } = await setup(page, "unavailable");
  await dialog.getByRole("button", { name: "Create & Review", exact: true }).click();
  await expect(page.getByText("Creation response is unavailable. Retry the same request.", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Create & Review", exact: true }).click();
  await expect(page).toHaveURL(/\/purchase-orders\/17(?:\?|$)/);
  await expect(page.getByText("PO ready for supplier review", { exact: true })).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect(failures).toEqual([]);
});

async function setupEditorRetry(page: Page, firstResult: "unavailable" | "malformed") {
  const failures = await installFixtures(page);
  const commands: Array<{ body: Record<string, unknown>; key: string | undefined }> = [];
  const vendor = { id: 2, code: "TEST", name: "Test vendor", country: "US", isActive: 1 };
  const draft = { ...po(17), vendor, status: "draft", physicalStatus: "draft", updatedAt: "2026-10-18T12:00:00.000Z",
    source: "manual", lines: [{ id: 9, purchaseOrderId: 17, lineType: "fee", status: "open", description: "Supplier handling fee",
      orderQty: 1, unitCostMills: 100000, unitCostCents: 1000, totalProductCostCents: 1000, packagingCostCents: 0, parentLineId: null }] };
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/vendors") return route.fulfill({ json: [vendor] });
    if (request.method() === "GET" && path === "/api/purchase-orders/17") return route.fulfill({ json: draft });
    if (request.method() === "GET" && path === "/api/purchase-orders/17/workspace") return route.fulfill({ json: purchaseWorkspace(draft) });
    if (request.method() === "PUT" && path === "/api/purchase-orders/17/draft") {
      commands.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"] });
      if (commands.length === 1 && firstResult === "unavailable") return route.fulfill({ status: 503, json: { error: "Save response is unavailable. Retry the same request." } });
      if (commands.length > 1) Object.assign(draft, { status: "approved", updatedAt: "2026-10-18T12:01:00.000Z" });
      return route.fulfill({ json: { po: { ...draft, id: commands.length === 1 ? 99 : 17, status: "approved", updatedAt: "2026-10-18T12:01:00.000Z" },
        status: "approved", pending_approval: false, dispatch_recorded: false } });
    }
    return route.fallback();
  });
  await page.goto("/purchase-orders/17/edit");
  const save = page.getByRole("button", { name: "Save & Review", exact: true }).filter({ visible: true }).first();
  await expect(save).toBeEnabled();
  await expect(page.getByRole("button", { name: "Send PDF", exact: true })).toHaveCount(0);
  return { save, commands, failures };
}

for (const firstResult of ["unavailable", "malformed"] as const) {
  test(`full editor ${firstResult} response retains the reviewed intent and retry key`, async ({ page }) => {
    const { save, commands, failures } = await setupEditorRetry(page, firstResult);
    await save.click();
    await expect(page.getByText("Preparation failed", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/purchase-orders\/17\/edit$/);
    await expect(page.getByText("PO ready for supplier review", { exact: true })).toHaveCount(0);
    await save.click();
    await expect(page.getByText("PO ready for supplier review", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/purchase-orders\/17(?:\?|$)/);
    expect(commands).toHaveLength(2);
    expect(commands[0].key).toBeTruthy();
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[1].body).toMatchObject({ prepare_for_supplier: true, expected_updated_at: "2026-10-18T12:00:00.000Z" });
    expect(failures).toEqual([]);
  });
}

test("full editor intentionally changed payload creates a different command after an uncertain save", async ({ page }) => {
  const { save, commands, failures } = await setupEditorRetry(page, "unavailable");
  await save.click();
  await expect(page.getByText("Preparation failed", { exact: true })).toBeVisible();
  await page.getByTestId("input-line-description-0").filter({ visible: true }).fill("Reviewed supplier handling fee");
  await save.click();
  await expect(page.getByText("PO ready for supplier review", { exact: true })).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1].key).not.toBe(commands[0].key);
  expect(commands[1].body).toMatchObject({ lines: [{ description: "Reviewed supplier handling fee" }] });
  expect(failures).toEqual([]);
});
