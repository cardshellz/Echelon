import { expect, test, type Page } from "@playwright/test";
import { buildPoLifecycleSummary } from "../../server/modules/procurement/purchase-order-lifecycle.service";
import { installFixtures, po } from "./procurement-fixtures";

async function cancellationFixture(
  page: Page, permissions: string[], state: { status: string; physicalStatus: string },
  { withAction = true, loseResponse = false }: { withAction?: boolean; loseResponse?: boolean } = {},
) {
  const failures = await installFixtures(page);
  let purchase = { ...po(17), ...state, financialStatus: "unbilled", lifecycle: buildPoLifecycleSummary({ id: 17, ...state }) };
  if (!withAction) purchase.lifecycle.nextActions = [];
  const calls: Array<{ path: string; body: unknown }> = [];
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: {
    user: { id: "test-user", username: "test", role: "admin" }, permissions, roles: ["admin"],
  } }));
  await page.route("**/api/purchase-orders/17", (route) => route.fulfill({ json: purchase }));
  await page.route("**/api/purchase-orders/17/workspace", (route) => route.fulfill({ json: {
    purchase: { ...purchase, currency: "USD", vendorName: "Test vendor", invoicedTotalCents: 0, paidTotalCents: 0,
      outstandingCents: 0, expectedDeliveryDate: null, confirmedDeliveryDate: null, actualDeliveryDate: null },
    shipments: [], receipts: [], invoices: [], edges: [], limitations: [],
  } }));
  await page.route("**/api/purchase-orders/17/cancel", async (route) => {
    calls.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    purchase = { ...purchase, status: "cancelled", physicalStatus: "cancelled", lifecycle: buildPoLifecycleSummary({ status: "cancelled", physicalStatus: "cancelled" }) };
    if (loseResponse) return route.abort("failed");
    await route.fulfill({ json: purchase });
  });
  await page.route("**/api/purchase-orders/17/close-short", async (route) => {
    calls.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    purchase = { ...purchase, status: "closed", physicalStatus: "short_closed", lifecycle: buildPoLifecycleSummary({ id: 17, status: "closed", physicalStatus: "short_closed" }) };
    if (loseResponse) return route.abort("failed");
    await route.fulfill({ json: purchase });
  });
  return { calls, failures };
}

for (const scenario of [
  { name: "unissued order with cancellation grant", permissions: ["purchasing:cancel"], state: { status: "approved", physicalStatus: "draft" }, label: "Cancel" },
  // Conflicting legacy/physical evidence proves the client uses the server's
  // decision and endpoint rather than reconstructing them from legacy status.
  { name: "issued physical track with approval grant", permissions: ["purchasing:approve"], state: { status: "approved", physicalStatus: "sent" }, label: "Void" },
]) {
  test(`cancellation follows canonical server action for ${scenario.name}`, async ({ page }) => {
    const fixture = await cancellationFixture(page, scenario.permissions, scenario.state);
    await page.goto("/purchase-orders/17");
    await page.getByRole("button", { name: scenario.label, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `${scenario.label} Purchase Order` });
    const confirm = dialog.getByRole("button", { name: `Confirm ${scenario.label}`, exact: true });
    await expect(confirm).toBeDisabled();
    await dialog.locator("textarea").fill("Supplier order withdrawn");
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    expect(fixture.calls).toEqual([{ path: "/api/purchase-orders/17/cancel", body: { reason: "Supplier order withdrawn" } }]);
    expect(fixture.failures).toEqual([]);
  });
}

test("an approver can close a partial PO short with a reason through the canonical action", async ({ page }) => {
  const fixture = await cancellationFixture(page, ["purchasing:approve"], { status: "partially_received", physicalStatus: "receiving" });
  await page.goto("/purchase-orders/17");
  await expect(page.getByRole("button", { name: "Close PO", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Close short", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Close Purchase Order Short" });
  const confirm = dialog.getByRole("button", { name: "Confirm close short", exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Reason *", { exact: true }).fill("   ");
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Reason *", { exact: true }).fill("  Supplier short-shipped  ");
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close short", exact: true })).toHaveCount(0);
  expect(fixture.calls).toEqual([{ path: "/api/purchase-orders/17/close-short", body: { reason: "Supplier short-shipped" } }]);
  expect(fixture.failures).toEqual([]);
});

for (const scenario of [
  { name: "create-only actor", permissions: ["purchasing:create"], withAction: true },
  { name: "missing server action", permissions: ["purchasing:approve"], withAction: false },
]) {
  test(`hides close-short for ${scenario.name}`, async ({ page }) => {
    const fixture = await cancellationFixture(page, scenario.permissions, { status: "partially_received", physicalStatus: "receiving" }, { withAction: scenario.withAction });
    await page.goto("/purchase-orders/17");
    await expect(page.getByRole("heading", { level: 1, name: "TEST-PO-17", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Close short|Close PO)$/ })).toHaveCount(0);
    expect(fixture.calls).toEqual([]);
    expect(fixture.failures).toEqual([]);
  });
}

test("a close-short conflict preserves the reason and shows the owner error", async ({ page }) => {
  const fixture = await cancellationFixture(page, ["purchasing:approve"], { status: "partially_received", physicalStatus: "receiving" });
  await page.route("**/api/purchase-orders/17/close-short", (route) => route.fulfill({ status: 409, json: { error: "Receipt state changed. Review the current PO." } }));
  await page.goto("/purchase-orders/17");
  await page.getByRole("button", { name: "Close short", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Close Purchase Order Short" });
  await dialog.getByLabel("Reason *", { exact: true }).fill("Supplier short-shipped");
  await dialog.getByRole("button", { name: "Confirm close short", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Receipt state changed. Review the current PO.");
  await expect(dialog.getByLabel("Reason *", { exact: true })).toHaveValue("Supplier short-shipped");
  expect(fixture.failures).toEqual([]);
});

test("a lost close-short response refreshes committed state and blocks another submission", async ({ page }) => {
  const fixture = await cancellationFixture(page, ["purchasing:approve"], { status: "partially_received", physicalStatus: "receiving" }, { loseResponse: true });
  await page.goto("/purchase-orders/17");
  await page.getByRole("button", { name: "Close short", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Close Purchase Order Short" });
  await dialog.getByLabel("Reason *", { exact: true }).fill("Supplier short-shipped");
  await dialog.getByRole("button", { name: "Confirm close short", exact: true }).click();
  await expect(dialog).toContainText("The saved purchase order is already closed short.");
  await expect(dialog.getByRole("button", { name: "Confirm close short", exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("Reason *", { exact: true })).toHaveValue("Supplier short-shipped");
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.failures).toEqual([]);
});

for (const scenario of [
  { name: "cancel-only actor on an issued order", permissions: ["purchasing:cancel"], state: { status: "sent", physicalStatus: "sent" }, withAction: true },
  { name: "approval-only actor on an unissued order", permissions: ["purchasing:approve"], state: { status: "approved", physicalStatus: "draft" }, withAction: true },
  { name: "missing server action despite both grants", permissions: ["purchasing:cancel", "purchasing:approve"], state: { status: "approved", physicalStatus: "draft" }, withAction: false },
]) {
  test(`hides cancellation for ${scenario.name}`, async ({ page }) => {
    const fixture = await cancellationFixture(page, scenario.permissions, scenario.state, { withAction: scenario.withAction });
    await page.goto("/purchase-orders/17");
    await expect(page.getByRole("heading", { level: 1, name: "TEST-PO-17", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Cancel|Void)( PO)?$/ })).toHaveCount(0);
    expect(fixture.calls).toEqual([]);
    expect(fixture.failures).toEqual([]);
  });
}

test("a stale permission rejected by the owner retains the cancellation reason and shows the error", async ({ page }) => {
  const fixture = await cancellationFixture(page, ["purchasing:approve"], { status: "sent", physicalStatus: "sent" });
  await page.route("**/api/purchase-orders/17/cancel", (route) => route.fulfill({ status: 403, json: {
    error: "Permission required to cancel or void this purchase order: purchasing:approve",
    details: { code: "PO_CANCEL_PERMISSION_REQUIRED", requiredPermission: "purchasing:approve" },
  } }));
  await page.goto("/purchase-orders/17");
  await page.getByRole("button", { name: "Void", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Void Purchase Order" });
  await dialog.locator("textarea").fill("Supplier order withdrawn");
  await dialog.getByRole("button", { name: "Confirm Void", exact: true }).click();
  await expect(page.getByText("Permission required to cancel or void this purchase order: purchasing:approve", { exact: true })).toBeVisible();
  await expect(dialog.locator("textarea")).toHaveValue("Supplier order withdrawn");
  expect(fixture.failures).toEqual([]);
});

test("a lost cancellation response refreshes committed state and prevents another submission", async ({ page }) => {
  const fixture = await cancellationFixture(page, ["purchasing:approve"], { status: "sent", physicalStatus: "sent" }, { loseResponse: true });
  await page.goto("/purchase-orders/17");
  await page.getByRole("button", { name: "Void", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("textarea").fill("Supplier order withdrawn");
  await dialog.getByRole("button", { name: "Confirm Void", exact: true }).click();
  await expect(dialog).toContainText("The saved purchase order is already cancelled.");
  await expect(dialog.getByRole("button", { name: /^Confirm / })).toBeDisabled();
  await expect(dialog.locator("textarea")).toHaveValue("Supplier order withdrawn");
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("button", { name: /^(Cancel|Void)( PO)?$/ })).toHaveCount(0);
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.failures).toEqual([]);
});

for (const scenario of [
  { name: "partial receipts", state: { status: "partially_received", physicalStatus: "receiving" }, showClose: false },
  { name: "conflicting physical receipt state", state: { status: "received", physicalStatus: "receiving" }, showClose: false },
  { name: "fully received goods", state: { status: "received", physicalStatus: "received" }, showClose: true },
  { name: "legacy fully received goods", state: { status: "received", physicalStatus: "draft" }, showClose: true },
]) {
  test(`ordinary close follows the server receipt gate for ${scenario.name}`, async ({ page }) => {
    const fixture = await cancellationFixture(page, ["purchasing:create", "purchasing:approve"], scenario.state);
    await page.goto("/purchase-orders/17");
    await expect(page.getByRole("heading", { level: 1, name: "TEST-PO-17", exact: true })).toBeVisible();
    const close = page.getByRole("button", { name: "Close PO", exact: true });
    if (scenario.showClose) await expect(close).toBeVisible();
    else await expect(close).toHaveCount(0);
    expect(fixture.failures).toEqual([]);
  });
}
