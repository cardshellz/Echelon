import type { Page, TestInfo } from "@playwright/test";
import { test, expect, login, type Backend } from "./fixtures";

interface NavigationReadback {
  purchaseOrders: unknown[]; invoices: unknown[]; invoiceLines: unknown[]; invoicePoLinks: unknown[];
  payments: number; costApplications: number;
}

async function withReadOnlyEvidence(page: Page, backend: Backend, info: TestInfo, work: () => Promise<void>): Promise<void> {
  const before = await backend.control<NavigationReadback>("navigation-state");
  const failures: Array<{ path: string; status: number }> = [];
  const pageErrors: string[] = [];
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.origin === backend.url && url.pathname.startsWith("/api/") && response.status() >= 500) {
      failures.push({ path: url.pathname + url.search, status: response.status() });
    }
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  try { await work(); }
  finally {
    const after = await backend.control<NavigationReadback>("navigation-state");
    await info.attach("connected-navigation-evidence", {
      body: JSON.stringify({ before, after, failures, pageErrors }, null, 2), contentType: "application/json",
    });
    expect.soft(after).toEqual(before);
    expect.soft(failures, "All connected navigation APIs must complete without server errors").toEqual([]);
    expect.soft(pageErrors).toEqual([]);
  }
}

async function proveReadAccess(page: Page, backend: Backend, documents: Array<{ api: string; path: string; heading: string; create?: { api: string; label: string } }>): Promise<void> {
  for (const document of documents) {
    const response = await page.request.get(backend.url + document.api);
    expect(response.status(), document.api + ": " + await response.text()).toBe(200);
    if (document.create) {
      const denied = await page.request.post(backend.url + document.create.api, {
        headers: { "Idempotency-Key": "connected-denied-" + document.path.slice(1) }, data: {},
      });
      expect(denied.status(), await denied.text()).toBe(403);
    }
  }
  // Visit each document directly before following links, so a legacy role
  // redirect on the first screen cannot conceal the same problem on the next.
  const inaccessible: Array<{ requested: string; actual: string }> = [];
  for (const document of documents) {
    await page.goto(backend.url + document.path);
    try {
      await expect(page.getByRole("heading", { name: document.heading, exact: true })).toBeVisible({ timeout: 5_000 });
      if (document.create) await expect.soft(page.getByRole("button", { name: document.create.label, exact: true })).toBeDisabled();
    }
    catch (error) {
      if (new URL(page.url()).pathname !== new URL(document.path, backend.url).pathname) {
        inaccessible.push({ requested: document.path, actual: new URL(page.url()).pathname });
      } else { throw error; }
    }
  }
  expect(inaccessible, "The same current purchasing:view grant must admit these connected document routes").toEqual([]);
}

async function verifyDocumentSidebar(page: Page, picker: boolean): Promise<void> {
  const mobile = (page.viewportSize()?.width ?? 1280) < 768;
  if (mobile) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const procurement = page.getByRole("button", { name: "Procurement", exact: true }).filter({ visible: true });
  if (await procurement.getAttribute("aria-expanded") !== "true") await procurement.click();
  for (const name of ["Purchase Orders", "Shipments", "Receiving"]) {
    await expect(page.getByRole("link", { name, exact: true }).filter({ visible: true })).toBeVisible();
  }
  if (picker) await expect(page.getByRole("link", { name: "Demand Planner", exact: true })).toHaveCount(0);
  const payable = page.getByRole("button", { name: "Accounts Payable", exact: true }).filter({ visible: true });
  if (await payable.getAttribute("aria-expanded") !== "true") await payable.click();
  await expect(page.getByRole("link", { name: "Invoices", exact: true }).filter({ visible: true })).toBeVisible();
  if (picker) await expect(page.getByRole("link", { name: "AP Dashboard", exact: true })).toHaveCount(0);
  if (mobile) await page.keyboard.press("Escape");
}
async function expectPurchaseAnchor(page: Page, purchaseId: number): Promise<void> {
  const context = page.getByRole("navigation", { name: "Purchase context", exact: true });
  await expect(context).toBeVisible();
  const href = await context.getByRole("link").getAttribute("href");
  expect(href).not.toBeNull();
  expect(new URL(href!, page.url()).pathname).toBe("/purchase-orders/" + purchaseId);
  expect(new URL(page.url()).searchParams.get("purchase")).toMatch(new RegExp("^purchase:" + purchaseId + ":"));
}

async function followBack(page: Page, expectedUrl: string): Promise<void> {
  const back = page.getByRole("link", { name: /^Back to / }).filter({ visible: true }).first();
  const href = await back.getAttribute("href");
  expect(href).not.toBeNull();
  expect(new URL(href!, page.url()).href).toBe(expectedUrl);
  await back.click();
  await expect(page).toHaveURL(expectedUrl);
}

for (const actorId of ["connected-viewer", "connected-picker"] as const) {
  test(actorId + " follows purchase, shipment Costs and freight invoice with preserved return context", async ({ page, backend }, info) => {
    const actor = backend.actors.find(candidate => candidate.id === actorId);
    if (!actor) throw new Error("Missing connected navigation actor");
    await login(page, backend, actor);
    const { purchaseOrderIds: [purchaseId], shipmentId, freightInvoiceId } = backend.navigation;
    await withReadOnlyEvidence(page, backend, info, async () => {
      await proveReadAccess(page, backend, [
        { api: "/api/purchase-orders", path: "/purchase-orders", heading: "Purchase Orders", create: { api: "/api/purchase-orders", label: "New Purchase Order" } },
        { api: "/api/inbound-shipments?status=all&costFilter=all&limit=50&offset=0", path: "/shipments", heading: "Inbound Shipments", create: { api: "/api/inbound-shipments", label: "New Shipment" } },
        { api: "/api/vendor-invoices/work-list?limit=50&offset=0", path: "/ap-invoices", heading: "Vendor Invoices", create: { api: "/api/vendor-invoices", label: "New Invoice" } },
        { api: "/api/purchase-orders/" + purchaseId, path: "/purchase-orders/" + purchaseId + "?tab=shipments", heading: "CONNECTED-PO-A" },
        { api: "/api/inbound-shipments/" + shipmentId, path: "/shipments/" + shipmentId + "?tab=costs", heading: "CONNECTED-SHIPMENT" },
        { api: "/api/vendor-invoices/" + freightInvoiceId, path: "/ap-invoices/" + freightInvoiceId, heading: "Invoice #CONNECTED-FREIGHT-INVOICE" },
      ]);
      await page.goto(backend.url + "/purchase-orders/" + purchaseId + "?tab=shipments");
      await page.getByRole("link", { name: "Shipment CONNECTED-SHIPMENT", exact: true }).click();
      await expect(page.getByRole("heading", { name: "CONNECTED-SHIPMENT", exact: true })).toBeVisible();
      await page.getByRole("tab", { name: /^Costs \(/ }).click();
      const costsUrl = page.url();
      expect(new URL(costsUrl).searchParams.get("tab")).toBe("costs");
      await expectPurchaseAnchor(page, purchaseId);
      await page.getByRole("link", { name: "CONNECTED-FREIGHT-INVOICE", exact: true }).filter({ visible: true }).first().click();
      await expect(page.getByRole("heading", { name: "Invoice #CONNECTED-FREIGHT-INVOICE", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Details", exact: true }).click();
      const invoiceDetailsUrl = page.url();
      expect(new URL(invoiceDetailsUrl).searchParams.get("tab")).toBe("details");
      await page.reload();
      await expect(page.getByText("Invoice Details", { exact: true })).toBeVisible();
      await expectPurchaseAnchor(page, purchaseId);
      // The invoice's source link also carries the invoice Details return path.
      await page.getByRole("link", { name: /Source: Shipment/ }).click();
      await expect(page.getByRole("heading", { name: "CONNECTED-SHIPMENT", exact: true })).toBeVisible();
      await expectPurchaseAnchor(page, purchaseId);
      await followBack(page, invoiceDetailsUrl);
      await expect(page.getByText("Invoice Details", { exact: true })).toBeVisible();
      await followBack(page, costsUrl);
      await expect(page.getByRole("tab", { name: /^Costs \(/ })).toHaveAttribute("data-state", "active");
      await page.goBack();
      await expect(page).toHaveURL(invoiceDetailsUrl);
      await page.goForward();
      await expect(page).toHaveURL(costsUrl);
      await expectPurchaseAnchor(page, purchaseId);
      await verifyDocumentSidebar(page, actorId === "connected-picker");
    });
  });

  test(actorId + " follows a shared goods invoice to its other PO without replacing the original purchase anchor", async ({ page, backend }, info) => {
    const actor = backend.actors.find(candidate => candidate.id === actorId);
    if (!actor) throw new Error("Missing connected navigation actor");
    await login(page, backend, actor);
    const { purchaseOrderIds: [purchaseId, otherPurchaseId], goodsInvoiceId } = backend.navigation;
    await withReadOnlyEvidence(page, backend, info, async () => {
      await proveReadAccess(page, backend, [
        { api: "/api/purchase-orders/" + purchaseId, path: "/purchase-orders/" + purchaseId + "?tab=invoices", heading: "CONNECTED-PO-A" },
        { api: "/api/vendor-invoices/" + goodsInvoiceId, path: "/ap-invoices/" + goodsInvoiceId, heading: "Invoice #CONNECTED-GOODS-INVOICE" },
        { api: "/api/purchase-orders/" + otherPurchaseId, path: "/purchase-orders/" + otherPurchaseId, heading: "CONNECTED-PO-B" },
      ]);
      const purchaseUrl = backend.url + "/purchase-orders/" + purchaseId + "?tab=invoices";
      await page.goto(purchaseUrl);
      const invoiceRow = page.getByRole("row").filter({ hasText: "CONNECTED-GOODS-INVOICE" });
      await invoiceRow.getByRole("link", { name: "View →", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Invoice #CONNECTED-GOODS-INVOICE", exact: true })).toBeVisible();
      const invoiceUrl = page.url();
      await expectPurchaseAnchor(page, purchaseId);
      await expect(page.getByText("$75.00", { exact: true }).first()).toBeVisible();
      await page.getByRole("link", { name: "CONNECTED-PO-B", exact: true }).click();
      await expect(page.getByRole("heading", { name: "CONNECTED-PO-B", exact: true })).toBeVisible();
      const otherPurchaseUrl = page.url();
      await expectPurchaseAnchor(page, purchaseId);
      await page.reload();
      await expect(page.getByRole("heading", { name: "CONNECTED-PO-B", exact: true })).toBeVisible();
      await expectPurchaseAnchor(page, purchaseId);
      await page.goBack();
      await expect(page).toHaveURL(invoiceUrl);
      await page.goForward();
      await expect(page).toHaveURL(otherPurchaseUrl);
      await followBack(page, invoiceUrl);
      await expectPurchaseAnchor(page, purchaseId);
      // Leaving the first PO establishes its purchase anchor, which is retained on return.
      const anchoredPurchaseUrl = new URL(purchaseUrl);
      anchoredPurchaseUrl.searchParams.set("purchase", "purchase:" + purchaseId + ":invoices");
      await followBack(page, anchoredPurchaseUrl.href);
      await expect(page.getByRole("heading", { name: "CONNECTED-PO-A", exact: true })).toBeVisible();
    });
  });
}

test("a creator retains the three procurement creation launch controls", async ({ page, backend }, info) => {
  const actor = backend.actors.find(candidate => candidate.id === "connected-admin");
  if (!actor) throw new Error("Missing connected creator actor");
  await login(page, backend, actor);
  const identity = await page.request.get(backend.url + "/api/auth/me");
  expect(identity.status(), await identity.text()).toBe(200);
  expect((await identity.json()).permissions).toContain("purchasing:create");
  await withReadOnlyEvidence(page, backend, info, async () => {
    for (const [path, label] of [["/purchase-orders", "New Purchase Order"], ["/shipments", "New Shipment"], ["/ap-invoices", "New Invoice"]]) {
      await page.goto(backend.url + path);
      await expect(page.getByRole("button", { name: label, exact: true })).toBeEnabled();
    }
  });
});