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
      // Workspace records can repeat the document name in an h3. Verify the
      // primary page title rather than whichever duplicate renders first.
      await expect(page.getByRole("heading", { name: document.heading, exact: true, level: 1 })).toBeVisible({ timeout: 5_000 });
      if (document.create) await expect.soft(page.getByRole("button", { name: document.create.label, exact: true })).toBeDisabled();
      if (document.path.startsWith("/purchase-orders/")) {
        await expect.soft(page.getByRole("button", { name: "Create Invoice", exact: true })).toHaveCount(0);
        await expect.soft(page.getByRole("button", { name: "Add invoice", exact: true })).toHaveCount(0);
      }
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
  for (const name of ["AP Dashboard", "Payments", "Supplier Credits", "Supplier Returns"]) {
    await expect(page.getByRole("link", { name, exact: true }).filter({ visible: true })).toBeVisible();
  }
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
      await expect(page.getByRole("heading", { name: "CONNECTED-PO-B", exact: true, level: 1 })).toBeVisible();
      const otherPurchaseUrl = page.url();
      await expectPurchaseAnchor(page, purchaseId);
      await page.reload();
      await expect(page.getByRole("heading", { name: "CONNECTED-PO-B", exact: true, level: 1 })).toBeVisible();
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
      await expect(page.getByRole("heading", { name: "CONNECTED-PO-A", exact: true, level: 1 })).toBeVisible();
    });
  });
}

test("a non-lead creator saves a fee-only purchase and keeps existing drafts read-only", async ({ page, backend }, info) => {
  const actor = backend.actors.find(candidate => candidate.id === "connected-creator");
  if (!actor) throw new Error("Missing connected creator actor");
  await login(page, backend, actor);
  const identity = await page.request.get(backend.url + "/api/auth/me");
  expect(identity.status(), await identity.text()).toBe(200);
  const current = await identity.json();
  expect(current.user).toMatchObject({ role: "picker" });
  expect(current.permissions).toEqual(expect.arrayContaining(["purchasing:view", "purchasing:create"]));
  expect(current.permissions).not.toContain("purchasing:edit");
  expect(current.permissions).not.toContain("inventory:view");
  await withReadOnlyEvidence(page, backend, info, async () => {
    for (const [path, label] of [["/purchase-orders", "New Purchase Order"], ["/shipments", "New Shipment"], ["/ap-invoices", "New Invoice"]]) {
      await page.goto(backend.url + path);
      await expect(page.getByRole("button", { name: label, exact: true })).toBeEnabled();
    }
    await page.goto(backend.url + "/purchase-orders/new");
    await expect(page.getByRole("heading", { name: "New Purchase Order", exact: true })).toBeVisible();
    // The editor requires a supplier before any line type can be added.
    await expect(page.getByRole("button", { name: "Add line of another type", exact: true })).toBeDisabled();
    const denied = await page.request.patch(backend.url + "/api/purchase-orders/" + backend.navigation.draftPurchaseOrderId, { data: { internalNotes: "Creator cannot edit an existing purchase" } });
    expect(denied.status(), await denied.text()).toBe(403);
    await page.goto(backend.url + "/purchase-orders/" + backend.navigation.draftPurchaseOrderId + "/edit");
    await expect(page).toHaveURL(backend.url + "/picking");
    const deniedDashboard = await page.request.get(backend.url + "/api/purchasing/dashboard");
    expect(deniedDashboard.status(), await deniedDashboard.text()).toBe(403);
    await page.goto(backend.url + "/purchasing");
    await expect(page).toHaveURL(backend.url + "/picking");
  });
  // A create grant can save a non-product PO without catalog visibility or
  // edit authority. Verify the actual command commit and its read-only return.
  const before = await backend.control<Record<string, unknown>>("navigation-state");
  await page.goto(backend.url + "/purchase-orders/new?vendor_id=5");
  await expect(page.getByRole("heading", { name: "New Purchase Order", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add line of another type", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Add line of another type", exact: true }).click();
  await page.getByRole("menuitem", { name: "Fee", exact: true }).click();
  await page.getByTestId("input-line-description-0").filter({ visible: true }).fill("Connected supplier handling fee");
  await page.getByRole("textbox", { name: "Line 1 amount", exact: true }).filter({ visible: true }).fill("12.34");
  await page.getByRole("textbox", { name: "Line 1 amount", exact: true }).filter({ visible: true }).press("Tab");
  const saved = page.waitForResponse(response => response.request().method() === "POST"
    && response.url() === backend.url + "/api/purchase-orders");
  await page.getByRole("button", { name: "Save draft", exact: true }).filter({ visible: true }).first().click();
  const committed = await saved;
  expect(committed.status(), await committed.text()).toBe(201);
  const result = await committed.json();
  expect(result).toMatchObject({ po: { vendorId: 5, status: "draft", totalCents: 1234, lineCount: 1, createdBy: "connected-creator" },
    lines: [{ lineType: "fee", description: "Connected supplier handling fee", productId: null,
      productVariantId: null, orderQty: 1, unitCostMills: 123400, lineTotalCents: 1234 }] });
  expect(result.entryCommand).toMatchObject({ action: "create", actorId: "connected-creator" });
  expect(await backend.state()).toMatchObject({ commands: [{ command_name: "procurement.purchase-order.entry",
    actor_type: "service", actor_id: "procurement.purchase-order-entry", status: "succeeded", http_status: 201, response_body: result }] });
  const purchaseId = result.po.id;
  await expect(page).toHaveURL(backend.url + "/purchase-orders/" + purchaseId);
  await expect(page.getByRole("heading", { name: result.po.poNumber, exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Line", exact: true })).toHaveCount(0);
  const readback = await page.request.get(backend.url + "/api/purchase-orders/" + purchaseId);
  expect(readback.status(), await readback.text()).toBe(200);
  expect(await readback.json()).toMatchObject({ id: purchaseId, totalCents: 1234, status: "draft", createdBy: "connected-creator",
    lines: [{ lineType: "fee", lineTotalCents: 1234, description: "Connected supplier handling fee" }] });
  const deniedSave = await page.request.put(backend.url + "/api/purchase-orders/" + purchaseId + "/draft", {
    headers: { "Idempotency-Key": "connected-creator-cannot-save-existing" }, data: {},
  });
  expect(deniedSave.status(), await deniedSave.text()).toBe(403);
  const after = await backend.control<Record<string, unknown>>("navigation-state");
  expect(after.purchaseOrderCount).toBe(Number(before.purchaseOrderCount) + 1);
  expect({ ...after, purchaseOrderCount: before.purchaseOrderCount }).toEqual(before);
  await info.attach("connected-created-fee-purchase", { body: JSON.stringify({ before, after, result }, null, 2), contentType: "application/json" });
});


test("a non-lead purchasing reader can inspect AP work without receiving payment, credit or return authority", async ({ page, backend }, info) => {
  const actor = backend.actors.find(candidate => candidate.id === "connected-picker");
  if (!actor) throw new Error("Missing connected purchasing reader");
  await login(page, backend, actor);
  await withReadOnlyEvidence(page, backend, info, async () => {
    const summary = await page.request.get(backend.url + "/api/ap/summary");
    expect(summary.status(), await summary.text()).toBe(200);
    expect(await summary.json()).toMatchObject({ totalOutstandingCents: 9_000, openInvoiceCount: 2,
      paidAllTimeCents: 0, creditedAllTimeCents: 0 });
    await proveReadAccess(page, backend, [
      { api: "/api/ap/summary", path: "/ap", heading: "Accounts Payable" },
      { api: "/api/ap-payments/work-list?limit=50&offset=0", path: "/ap-payments", heading: "AP Payments" },
      { api: "/api/supplier-credits", path: "/supplier-credits", heading: "Supplier credits" },
      { api: "/api/supplier-returns", path: "/supplier-returns", heading: "Supplier returns" },
    ]);
    for (const api of ["/api/ap-payments", "/api/supplier-credits", "/api/supplier-returns"]) {
      const denied = await page.request.post(backend.url + api, { headers: { "Idempotency-Key": "connected-reader-denied-" + api.slice(5) }, data: {} });
      expect(denied.status(), api + ": " + await denied.text()).toBe(403);
    }
    for (const [path, action] of [["/ap-payments", "Record Payment"], ["/supplier-credits", "Record supplier credit"], ["/supplier-returns", "Return accepted stock"]]) {
      await page.goto(backend.url + path);
      await expect(page.getByRole("button", { name: action, exact: true })).toHaveCount(0);
    }
    await verifyDocumentSidebar(page, true);
  });
});

test("a non-lead read-only purchaser keeps draft detail and cannot enter or mutate its editor", async ({ page, backend }, info) => {
  const actor = backend.actors.find(candidate => candidate.id === "connected-picker");
  if (!actor) throw new Error("Missing connected read-only purchaser");
  await login(page, backend, actor);
  const draftId = backend.navigation.draftPurchaseOrderId;
  await withReadOnlyEvidence(page, backend, info, async () => {
    await proveReadAccess(page, backend, [{ api: "/api/purchase-orders/" + draftId,
      path: "/purchase-orders/" + draftId, heading: "CONNECTED-DRAFT-PO" }]);
    await expect(page).toHaveURL(backend.url + "/purchase-orders/" + draftId);
    await expect(page.getByRole("button", { name: "Add Line", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "CONNECTED-DRAFT-PO", exact: true, level: 1 })).toBeVisible();
    await expect(page).toHaveURL(backend.url + "/purchase-orders/" + draftId);
    await page.goto(backend.url + "/purchase-orders");
    await page.getByText("CONNECTED-DRAFT-PO", { exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole("heading", { name: "CONNECTED-DRAFT-PO", exact: true, level: 1 })).toBeVisible();
    await expect(page).toHaveURL(backend.url + "/purchase-orders/" + draftId);
    for (const [method, path] of [["PATCH", "/api/purchase-orders/" + draftId], ["PUT", "/api/purchase-orders/" + draftId + "/draft"], ["POST", "/api/purchase-orders/" + draftId + "/lines"]]) {
      const denied = await page.request.fetch(backend.url + path, { method, headers: { "Idempotency-Key": "connected-reader-draft-denied-" + method }, data: {} });
      expect(denied.status(), path + ": " + await denied.text()).toBe(403);
    }
    await page.goto(backend.url + "/purchase-orders/" + draftId + "/edit");
    await expect(page).toHaveURL(backend.url + "/picking");
  });
});

test("a non-lead purchase editor can open an existing draft without gaining creation permission", async ({ page, backend }, info) => {
  const actor = backend.actors.find(candidate => candidate.id === "connected-editor");
  if (!actor) throw new Error("Missing connected purchase editor");
  await login(page, backend, actor);
  const identity = await page.request.get(backend.url + "/api/auth/me");
  expect(identity.status(), await identity.text()).toBe(200);
  const current = await identity.json();
  expect(current.user).toMatchObject({ role: "picker" });
  expect(current.permissions).toEqual(expect.arrayContaining(["purchasing:view", "purchasing:edit"]));
  expect(current.permissions).not.toContain("purchasing:create");
  expect(current.permissions).not.toContain("inventory:view");
  await withReadOnlyEvidence(page, backend, info, async () => {
    const draftId = backend.navigation.draftPurchaseOrderId;
    const purchase = await page.request.get(backend.url + "/api/purchase-orders/" + draftId);
    expect(purchase.status(), await purchase.text()).toBe(200);
    await page.goto(backend.url + "/purchase-orders/" + draftId + "/edit");
    await expect(page.getByRole("heading", { name: "Edit CONNECTED-DRAFT-PO", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add line of another type", exact: true })).toBeEnabled();
    const denied = await page.request.post(backend.url + "/api/purchase-orders", { headers: { "Idempotency-Key": "connected-editor-cannot-create" }, data: {} });
    expect(denied.status(), await denied.text()).toBe(403);
    await page.goto(backend.url + "/purchase-orders/new");
    await expect(page).toHaveURL(backend.url + "/picking");
  });
});

test("a non-admin with both read grants can inspect the purchasing dashboard but cannot start auto-draft", async ({ page, backend }, info) => {
  const actor = backend.actors.find(candidate => candidate.id === "connected-picker");
  if (!actor) throw new Error("Missing connected dashboard reader");
  await login(page, backend, actor);
  await withReadOnlyEvidence(page, backend, info, async () => {
    for (const path of ["/api/purchasing/dashboard", "/api/purchasing/auto-draft/runs?limit=5",
      "/api/procurement/landed-cost-health?limit=25", "/api/purchasing/supplier-setup-gaps",
      "/api/purchasing/forecast-input-gaps?limit=5", "/api/purchasing/auto-draft/stale-pos?limit=25",
      "/api/procurement/health?limit=25", "/api/purchasing/pipeline?horizonDays=30"]) {
      const response = await page.request.get(backend.url + path);
      expect(response.status(), path + ": " + await response.text()).toBe(200);
    }
    await page.goto(backend.url + "/purchasing");
    await expect(page.getByRole("heading", { name: "Purchasing Dashboard", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Daily buying review", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run Auto-Draft Now", exact: true })).toHaveCount(0);
    for (const path of ["/api/purchasing/auto-draft/run", "/api/purchasing/auto-draft-run"]) {
      const denied = await page.request.post(backend.url + path);
      expect(denied.status(), path + ": " + await denied.text()).toBe(403);
    }
    if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await expect(page.locator('a[href="/purchasing"]').filter({ visible: true })).toBeVisible();
  });
});
