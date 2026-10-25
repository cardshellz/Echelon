import { voidedOwnershipFixture } from "../fixtures/invoice-source";
import { expect, test, type Page } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";
import type { ReplacementInvoiceInput } from "../../shared/procurement/invoice-replacement";

const version = "a".repeat(64), nextVersion = "b".repeat(64);
const historyRow = (id: number, status: string, replacesInvoiceId: number | null) => ({ id, invoiceNumber: "TEST-FREIGHT-71", status, replacesInvoiceId, createdAt: "2026-10-15T12:00:00.000Z" });
async function setup(page: Page, options: { permissions?: string[]; conflict?: boolean; loseResponses?: boolean; blocked?: boolean; malformed?: boolean } = {}) {
  const failures = await installFixtures(page);
  const invoice = {
    id: 71, invoiceNumber: "TEST-FREIGHT-71", status: "voided", vendorId: 2, vendorName: "Test carrier", currency: "USD", inboundShipmentId: 42,
    invoicedAmountCents: 10000, paidAmountCents: 0, balanceCents: 10000, lines: [], poLinks: [], attachments: [], payments: [],
    replacementCapability: { allowed: !options.blocked, code: options.blocked ? "AP_INVOICE_REPLACEMENT_REVIEW" : null,
      message: options.blocked ? "The freight charge membership needs review before replacement." : "This voided shipment invoice can be replaced.", expectedVersion: version, successorInvoiceId: null as number | null },
    replacementHistory: [historyRow(71, "voided", null)],
  };
  const commands: { key: string; body: ReplacementInvoiceInput }[] = [];
  const result = { invoiceId: 72, replacesInvoiceId: 71, invoiceNumber: "TEST-FREIGHT-71", status: "received", freightCostIds: [9] };
  let conflict = options.conflict ?? false, loseResponses = options.loseResponses ?? false;
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: "replacement-user", username: "test", role: "admin" }, permissions: options.permissions ?? ["purchasing:view", "purchasing:create", "purchasing:edit"], roles: ["admin"] } }));
  await page.route("**/api/vendor-invoices/71", (route) => route.fulfill({ json: options.malformed ? { ...invoice, replacementCapability: {} } : invoice }));
  await page.route("**/api/vendor-invoices/72", (route) => route.fulfill({ json: {
    ...invoice, id: 72, status: "received", replacesInvoiceId: 71,
    capabilities: { edit: { allowed: true, requiredPermission: "purchasing:edit", code: "AP_INVOICE_EDITABLE", reason: "This unapproved invoice can be edited." } },
    replacementCapability: { ...invoice.replacementCapability, allowed: false, successorInvoiceId: null, message: "Only voided shipment invoices may be replaced." },
  } }));
  await page.route("**/api/vendor-invoices/71/replacement", async (route) => {
    commands.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (conflict) {
      conflict = false; invoice.replacementCapability.expectedVersion = nextVersion;
      return route.fulfill({ status: 409, json: { error: "Invoice source changed. Reload before replacing it.", details: { code: "AP_INVOICE_REPLACEMENT_STALE" } } });
    }
    invoice.replacementCapability.allowed = false; invoice.replacementCapability.successorInvoiceId = 72;
    invoice.replacementHistory = [historyRow(71, "voided", null), historyRow(72, "received", 71)];
    if (loseResponses) return route.fulfill({ status: 503, headers: { "Retry-After": "0" }, json: { error: "Response unavailable" } });
    return route.fulfill({ status: 201, json: result });
  });
  await page.goto("/ap-invoices/71?tab=details");
  return { invoice, commands, failures, allowResponses: () => { loseResponses = false; } };
}

test("creates a received replacement, keeps the voided original and opens the same supplier number", async ({ page }, info) => {
  const { invoice, commands, failures } = await setup(page);
  const panel = page.getByRole("region", { name: "Shipment invoice replacement" });
  await page.getByLabel("Reason for replacement").fill("Correct the supplier's charge detail");
  await page.getByRole("button", { name: "Create replacement invoice", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open replacement invoice #72", exact: true })).toBeVisible();
  expect(commands).toHaveLength(1); expect(commands[0].key).toBeTruthy();
  expect(commands[0].body).toEqual({ expectedVersion: version, reason: "Correct the supplier's charge detail" });
  expect(invoice.status).toBe("voided");
  await expect(panel).toContainText("does not approve, pay, or apply inventory costs");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("invoice-replacement.png"), fullPage: true });
  await page.getByRole("link", { name: "Open replacement invoice #72", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Invoice #TEST-FREIGHT-71", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Related invoice TEST-FREIGHT-71 · record #71/ })).toBeVisible();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Invoice Number", exact: true })).toBeDisabled();
  expect(failures).toEqual([]);
});

test("preserves an unknown committed request across reload and navigation, then replays the same key", async ({ page }) => {
  const state = await setup(page, { loseResponses: true });
  await page.getByLabel("Reason for replacement").fill("Corrected carrier bill");
  await page.getByRole("button", { name: "Create replacement invoice", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry saved replacement", exact: true })).toBeEnabled();
  expect(state.commands).toHaveLength(4);
  await page.reload();
  await expect(page.getByLabel("Reason for replacement")).toHaveValue("Corrected carrier bill");
  await expect(page.getByLabel("Reason for replacement")).toBeDisabled();
  await page.goto("/shipments/42?tab=costs");
  await page.goto("/ap-invoices/71?tab=details");
  state.allowResponses();
  await page.getByRole("button", { name: "Retry saved replacement", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry saved replacement", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open replacement invoice #72", exact: true })).toBeVisible();
  expect(state.commands).toHaveLength(5);
  expect(new Set(state.commands.map((command) => command.key)).size).toBe(1);
  expect(state.commands.every((command) => JSON.stringify(command.body) === JSON.stringify(state.commands[0].body))).toBe(true);
  expect(state.failures).toEqual([]);
});

test("requires explicit reload after source conflict and retains the operator reason", async ({ page }) => {
  const { commands, failures } = await setup(page, { conflict: true });
  await page.getByLabel("Reason for replacement").fill("Check corrected document");
  await page.getByRole("button", { name: "Create replacement invoice", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Invoice source changed");
  await expect(page.getByRole("button", { name: "Create replacement invoice", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Reason for replacement")).toHaveValue("Check corrected document");
  await page.getByRole("button", { name: "Reload invoice for replacement review" }).click();
  await page.getByRole("button", { name: "Create replacement invoice", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open replacement invoice #72", exact: true })).toBeVisible();
  expect(commands.map((command) => command.body.expectedVersion)).toEqual([version, nextVersion]);
  expect(commands[0].key).not.toBe(commands[1].key); expect(failures).toEqual([]);
});

for (const permissions of [["purchasing:view"], ["purchasing:view", "purchasing:create"], ["purchasing:view", "purchasing:edit"]]) {
  test(`requires both create and edit permissions (${permissions.join(",")})`, async ({ page }) => {
    const { commands, failures } = await setup(page, { permissions });
    await expect(page.getByText("Purchasing create and edit permissions are required", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Reason for replacement")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Create replacement invoice", exact: true })).toHaveCount(0);
    expect(commands).toEqual([]); expect(failures).toEqual([]);
  });
}

test("does not offer replacement when source membership needs review", async ({ page }) => {
  const { commands, failures } = await setup(page, { blocked: true });
  await expect(page.getByText("The freight charge membership needs review before replacement.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create replacement invoice", exact: true })).toHaveCount(0);
  expect(commands).toEqual([]); expect(failures).toEqual([]);
});

test("fails closed on an unverified capability", async ({ page }) => {
  const { commands, failures } = await setup(page, { malformed: true });
  await expect(page.getByRole("alert")).toContainText("Replacement eligibility could not be verified");
  await expect(page.getByRole("button", { name: "Create replacement invoice", exact: true })).toHaveCount(0);
  expect(commands).toEqual([]); expect(failures).toEqual([]);
});

test("shipment costs show voided invoice recovery and retain the original invoice link", async ({ page }) => {
  const { failures } = await setup(page);
  await page.route("**/api/inbound-shipments/42", (route) => route.fulfill({ json: {
    id: 42, shipmentNumber: "TEST-SHIP-42", status: "closed", mode: "sea_fcl", lines: [], statusHistory: [], costs: [{
      id: 9, costType: "freight", description: "Carrier charge", estimatedCents: 10000, actualCents: 10000, vendorId: 2, vendorName: "Test carrier", vendorInvoiceId: 71,
      billingOwnership: voidedOwnershipFixture(), derivedStatus: "voided", linkedInvoice: { id: 71, invoiceNumber: "TEST-FREIGHT-71", status: "voided" },
    }],
  } }));
  await page.goto("/shipments/42?tab=costs");
  await expect(page.getByText("Voided invoice — replacement required", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Invoice", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Review invoice replacement", exact: true }).filter({ visible: true }).click();
  await expect(page.getByLabel("Reason for replacement")).toBeVisible();
  expect(failures).toEqual([]);
});
