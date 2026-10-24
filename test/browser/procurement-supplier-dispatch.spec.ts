import { purchaseEntryFixture, purchasingAuthFixture } from "./procurement-purchase-order-entry-fixtures";
import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";

const REVIEWED_AT = "2026-10-18T12:00:00.000Z";
const SAVED_AT = "2026-10-18T12:01:00.000Z";
type Mode = "sent" | "pending" | "malformed" | "stale" | "delayed" | "prepare" | "prepare_delayed" | "approved_prepare";
async function setup(page: Page, mode: Mode) {
  const failures = await installFixtures(page);
  const purchases = new Map([17, 99].map((id) => [id, { ...po(id), status: mode.startsWith("prepare") ? "draft" : "approved", physicalStatus: "draft", updatedAt: REVIEWED_AT, sentToVendorAt: null as string | null,
    ...(mode === "approved_prepare" ? { autoDraftActionPlan: {
      primaryAction: { id: "send_to_vendor", label: "Prepare for supplier", detail: "Review the approved supplier document.", severity: "info" },
      checklist: [], context: { lineCount: 0, openExceptionCount: 0, availableLifecycleActionIds: ["send_to_vendor"] },
    } } : {}),
  }]));
  const commands: Array<{ id: number; body: unknown }> = [];
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: purchasingAuthFixture });
    if (mode.startsWith("prepare") && path === "/api/settings/procurement") return route.fulfill({ json: { useNewPoEditor: false } });
    const match = /^\/api\/purchase-orders\/(17|99)(\/send|\/send-to-vendor|\/workspace)?$/.exec(path);
    if (path === "/api/purchase-orders/17/document") return route.fulfill({ json: { html: "<html><body>Reviewed supplier PO TEST-PO-17</body></html>" } });
    if (!match) return route.fallback();
    const id = Number(match[1]), purchase = purchases.get(id)!;
    if (request.method() === "GET" && match[2] === "/workspace") return route.fulfill({ json: {
      purchase: { ...purchase, currency: "USD", vendorName: "Test vendor", invoicedTotalCents: 0, paidTotalCents: 0, outstandingCents: 0,
        expectedDeliveryDate: null, confirmedDeliveryDate: null, actualDeliveryDate: null }, shipments: [], receipts: [], invoices: [], edges: [], limitations: [],
    } });
    if (request.method() === "GET" && !match[2]) return route.fulfill({ json: purchase });
    if (request.method() !== "POST" || !["/send", "/send-to-vendor"].includes(match[2])) return route.fallback();
    commands.push({ id, body: request.postData() ? request.postDataJSON() : null });
    if (mode === "delayed" || mode === "prepare_delayed") await gate;
    if (mode.startsWith("prepare")) {
      Object.assign(purchase, { status: "approved", physicalStatus: "draft", updatedAt: SAVED_AT });
      return route.fulfill({ json: purchaseEntryFixture(request, "prepare", id, purchase) });
    }
    if (mode === "malformed") return route.fulfill({ json: { ...purchase, status: "sent", physicalStatus: "sent", sentToVendorAt: null } });
    if (mode === "stale") return route.fulfill({ status: 409, json: {
      error: "The PO changed after it was reviewed. Reload and review the current document before recording supplier dispatch.", details: { code: "PO_DISPATCH_REVIEW_STALE" },
    } });
    Object.assign(purchase, mode === "pending" ? { status: "pending_approval", physicalStatus: "draft", updatedAt: SAVED_AT }
      : { status: "sent", physicalStatus: "sent", sentToVendorAt: SAVED_AT, updatedAt: SAVED_AT });
    return route.fulfill({ json: purchase });
  });
  await page.goto(mode === "approved_prepare" ? "/purchase-orders/17?tab=lines" : "/purchase-orders/17");
  await expect(page.getByRole("heading", { name: "TEST-PO-17", level: 1, exact: true })).toBeVisible();
  return { failures, commands, release };
}
async function openConfirm(page: Page) {
  await page.getByRole("button", { name: "Record external send", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Record an external supplier send" });
  await expect(dialog).toContainText("TEST-PO-17");
  await expect(dialog).toContainText("does not send an email");
  return dialog;
}
async function navigate(page: Page, id: number) {
  await page.evaluate((target) => { history.pushState(null, "", `/purchase-orders/${target}`); dispatchEvent(new PopStateEvent("popstate")); }, id);
  await expect(page.getByRole("heading", { name: `TEST-PO-${id}`, level: 1, exact: true })).toBeVisible();
}

test("external send requires a separate attestation bound to the displayed PO version", async ({ page }) => {
  const { failures, commands } = await setup(page, "sent");
  const dialog = await openConfirm(page);
  expect(commands).toHaveLength(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(commands).toHaveLength(0);
  await openConfirm(page);
  await dialog.getByRole("button", { name: "Confirm external send", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("External send recorded", { exact: true })).toBeVisible();
  expect(commands).toEqual([{ id: 17, body: { confirmedSentExternally: true, expectedUpdatedAt: REVIEWED_AT } }]);
  expect(failures).toEqual([]);
});

test("renewed approval never reports supplier dispatch as recorded", async ({ page }) => {
  const { failures } = await setup(page, "pending");
  const dialog = await openConfirm(page);
  await dialog.getByRole("button", { name: "Confirm external send", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Supplier dispatch was not recorded. Review the current approval requirements before continuing.", { exact: true })).toBeVisible();
  await expect(page.getByText("External send recorded", { exact: true })).toHaveCount(0);
  expect(failures).toEqual([]);
});

for (const mode of ["malformed", "stale"] as const) {
  test(`external send ${mode} result keeps recovery visible and never claims success`, async ({ page }) => {
    const { failures } = await setup(page, mode);
    const dialog = await openConfirm(page);
    await dialog.getByRole("button", { name: "Confirm external send", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(mode === "malformed" ? "could not be verified" : "changed after it was reviewed");
    await expect(page.getByText("External send recorded", { exact: true })).toHaveCount(0);
    expect(failures).toEqual([]);
  });
}

test("navigation clears an unsubmitted send attestation instead of applying it to another PO", async ({ page }) => {
  const { commands, failures } = await setup(page, "sent");
  const dialog = await openConfirm(page);
  await navigate(page, 99);
  await expect(dialog).toBeHidden();
  expect(commands).toEqual([]);
  await page.getByRole("button", { name: "Record external send", exact: true }).first().click();
  await expect(dialog).toContainText("TEST-PO-99");
  expect(failures).toEqual([]);
});

test("late external-send response cannot close or announce success on a different PO", async ({ page }) => {
  const { commands, failures, release } = await setup(page, "delayed");
  const dialog = await openConfirm(page);
  await dialog.getByRole("button", { name: "Confirm external send", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  await navigate(page, 99);
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Record external send", exact: true }).first().click();
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/purchase-orders/17/send");
  release(); await (await response).finished();
  await expect(dialog).toContainText("TEST-PO-99");
  await expect(page.getByText("External send recorded", { exact: true })).toHaveCount(0);
  expect(commands.map((command) => command.id)).toEqual([17]);
  expect(failures).toEqual([]);
});

test("preparing supplier review opens the document without claiming or recording external dispatch", async ({ page }) => {
  const { commands, failures } = await setup(page, "prepare");
  await page.getByRole("button", { name: "Prepare for supplier", exact: true }).first().click();
  await expect(page.getByText("PO ready for supplier review", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Purchase Order — TEST-PO-17" })).toBeVisible();
  await expect(page.getByText("External send recorded", { exact: true })).toHaveCount(0);
  expect(commands).toEqual([{ id: 17, body: {} }]);
  expect(failures).toEqual([]);
});

test("approved PO preparation action reviews the existing document without recording external dispatch", async ({ page }) => {
  const { commands, failures } = await setup(page, "approved_prepare");
  const nextAction = page.getByRole("region", { name: "Auto-draft next action", exact: true });
  await nextAction.getByRole("button", { name: "Prepare for supplier", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Purchase Order — TEST-PO-17", exact: true })).toBeVisible();
  await expect(page.frameLocator("#po-doc-iframe").getByText("Reviewed supplier PO TEST-PO-17", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Record an external supplier send", exact: true })).toHaveCount(0);
  await expect(page.getByText("External send recorded", { exact: true })).toHaveCount(0);
  expect(commands).toEqual([]);
  expect(failures).toEqual([]);
});

test("late preparation response cannot open a document on another purchase", async ({ page }) => {
  const { commands, failures, release } = await setup(page, "prepare_delayed");
  await page.getByRole("button", { name: "Prepare for supplier", exact: true }).first().click();
  await expect.poll(() => commands.length).toBe(1);
  await navigate(page, 99);
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/purchase-orders/17/send-to-vendor");
  release(); await (await response).finished();
  await expect(page.getByRole("dialog", { name: /Purchase Order/ })).toHaveCount(0);
  await expect(page.getByText("PO ready for supplier review", { exact: true })).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("editor Save and Review prepares the saved PO without an automatic send claim", async ({ page }) => {
  const failures = await installFixtures(page);
  let saved = false;
  const requests: Record<string, unknown>[] = [];
  const vendor = { id: 2, code: "TEST", name: "Test vendor", isActive: 1 };
  const draft = { ...po(17), status: "draft", physicalStatus: "draft", updatedAt: REVIEWED_AT, vendor,
    source: "manual", lines: [{ id: 9, purchaseOrderId: 17, lineType: "fee", status: "open", description: "Supplier handling fee",
      orderQty: 1, unitCostMills: 100000, unitCostCents: 1000, totalProductCostCents: 1000, packagingCostCents: 0, parentLineId: null }] };
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: purchasingAuthFixture });
    if (request.method() === "GET" && path === "/api/vendors") return route.fulfill({ json: [vendor] });
    if (request.method() === "GET" && path === "/api/purchase-orders/17") return route.fulfill({ json: saved ? { ...draft, status: "approved", updatedAt: SAVED_AT } : draft });
    if (request.method() === "PUT" && path === "/api/purchase-orders/17/draft") {
      const body = request.postDataJSON(); requests.push(body); saved = true;
      return route.fulfill({ json: purchaseEntryFixture(request, "save-draft", 17, { po: { ...draft, status: "approved", updatedAt: SAVED_AT }, status: "approved", pdf: null, pending_approval: false, dispatch_recorded: false }) });
    }
    return route.fallback();
  });
  await page.goto("/purchase-orders/17/edit");
  await expect(page.getByRole("button", { name: "Save & Send PDF", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save & Review", exact: true, includeHidden: true })).toHaveCount(2);
  const save = page.getByRole("button", { name: "Save & Review", exact: true }).filter({ visible: true }).first();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("heading", { name: "TEST-PO-17", level: 1, exact: true })).toBeVisible();
  await expect(page.getByText("PO ready for supplier review", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ prepare_for_supplier: true, expected_updated_at: REVIEWED_AT });
  expect(requests[0]).not.toHaveProperty("advance_to_sent");
  await expect(page.getByText(/PO (created|updated) and sent to vendor/)).toHaveCount(0);
  expect(failures).toEqual([]);
});
