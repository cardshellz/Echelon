import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";

const initialVersion = "a".repeat(64);
const nextVersion = "b".repeat(64);
const fixtureCost = () => ({
  id: 31, inboundShipmentId: 42, version: initialVersion, costType: "freight",
  description: "Freight charge", estimatedCents: 5000, actualCents: 4800,
  allocationMethod: "by_volume", vendorId: 7, vendorName: "Test carrier",
  performedByVendorId: null as number | null,
  performedByName: "Test forwarder", invoiceDate: "2026-09-06T12:30:00Z",
  vendorInvoiceId: null as number | null, hasInvoiceSourceReference: false,
  currency: "USD", exchangeRate: "1.0000",
});
type Cost = ReturnType<typeof fixtureCost>;
type Captured = { method: string; key: string; body: Record<string, unknown> };

async function setup(page: Page, options: { protected?: "header" | "source"; lostCreateResponse?: boolean; conflictPatch?: boolean; failRefresh?: boolean; deadCreateResponse?: boolean } = {}) {
  const failures = await installFixtures(page);
  const cost = fixtureCost();
  if (options.protected === "header") cost.vendorInvoiceId = 71;
  if (options.protected === "source") cost.hasInvoiceSourceReference = true;
  const state = { costs: [cost], commands: [] as Captured[], detailReads: 0, nextId: 32, committed: false, allowCreateRetry: false };
  const replays = new Map<string, unknown>();
  let lost = false;
  let conflicted = false;
  await page.route("**/api/inbound-shipments/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === "/api/inbound-shipments/42") {
        state.detailReads += 1;
        if (options.failRefresh && state.committed) return route.fulfill({ status: 503, json: { error: "Fixture refresh failed" } });
        return route.fulfill({ json: {
          id: 42, shipmentNumber: "TEST-SHIP-42", status: "booked", mode: "sea_fcl",
          lines: [], costs: state.costs, statusHistory: [],
        } });
      }
      if (path === "/api/inbound-shipments/42/costs") return route.fulfill({ json: state.costs });
      return route.fallback();
    }
    if (!/^\/api\/inbound-shipments\/(42\/costs|costs\/\d+)$/.test(path)) return route.fallback();
    const command = { method: request.method(), key: request.headers()["idempotency-key"], body: request.postDataJSON() as Record<string, unknown> };
    state.commands.push(command);
    if (!command.key) return route.fulfill({ status: 400, json: { error: "Idempotency key required" } });
    if (replays.has(command.key)) return route.fulfill({ json: replays.get(command.key) });
    if (options.deadCreateResponse && command.method === "POST" && !state.allowCreateRetry) {
      return route.fulfill({ status: 409, json: { error: "The command requires operator review", details: { code: "FINANCIAL_COMMAND_DEAD" } } });
    }
    if (options.conflictPatch && command.method === "PATCH" && !conflicted) {
      conflicted = true;
      state.costs[0] = { ...state.costs[0], version: nextVersion, description: "Another user updated this charge" };
      return route.fulfill({ status: 409, json: { error: "Cost changed", details: { code: "SHIPMENT_COST_VERSION_CONFLICT" } } });
    }
    let result: unknown;
    if (command.method === "POST") {
      const created = { ...fixtureCost(), ...command.body, id: state.nextId++, version: nextVersion } as Cost;
      state.costs.push(created);
      result = created;
    } else {
      const id = Number(path.split("/").at(-1));
      const existing = state.costs.find((record) => record.id === id);
      if (!existing) return route.fulfill({ status: 404, json: { error: "Cost no longer exists" } });
      if (command.body.expectedVersion !== existing.version) return route.fulfill({ status: 409, json: { error: "Cost changed", details: { code: "SHIPMENT_COST_VERSION_CONFLICT" } } });
      if (command.method === "DELETE") {
        state.costs = state.costs.filter((record) => record.id !== id);
        result = { success: true };
      } else {
        Object.assign(existing, command.body, { version: nextVersion });
        result = existing;
      }
    }
    state.committed = true;
    replays.set(command.key, result);
    if (options.lostCreateResponse && command.method === "POST" && !lost) {
      lost = true;
      return route.abort("connectionreset");
    }
    return route.fulfill({ json: result });
  });
  await page.route("**/api/vendors", (route) => route.fulfill({ json: [
    { id: 7, name: "Test carrier", code: "BILL" },
    { id: 8, name: "Test forwarder", code: "FWD" },
    { id: 9, name: "Test forwarder", code: "ALT" },
  ] }));
  await page.goto("/shipments/42?tab=costs");
  await expect(page.getByRole("heading", { name: "TEST-SHIP-42", exact: true })).toBeVisible();
  return { state, failures };
}

const editButton = (page: Page) => page.locator('button[aria-label="Edit cost"]:visible').first();
const removeButton = (page: Page) => page.locator('button[aria-label="Remove cost"]:visible').first();
const field = (page: Page, label: string) => page.getByRole("dialog").locator("div.space-y-2").filter({ has: page.locator("label", { hasText: new RegExp(`^${label}$`) }) }).locator("input").first();

for (const protectedBy of ["header", "source"] as const) {
  test(`invoice ${protectedBy} ownership permits only metadata corrections`, async ({ page }, testInfo) => {
    const { state, failures } = await setup(page, { protected: protectedBy });
    await expect(removeButton(page)).toHaveCount(0);
    await editButton(page).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/controlled by an invoice/)).toBeVisible();
    await expect(dialog.getByRole("spinbutton")).toBeDisabled();
    await expect(dialog.locator('input[type="date"]')).toBeDisabled();
    await expect(dialog.getByRole("combobox")).toHaveCount(4);
    await expect(dialog.getByRole("combobox", { name: "Performed By", exact: true })).toBeEnabled();
    for (const select of await dialog.getByRole("combobox").all()) {
      if (await select.getAttribute("aria-label") !== "Performed By") await expect(select).toBeDisabled();
    }
    await field(page, "Description").fill("Corrected freight description");
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(dialog).not.toBeVisible();
    expect(state.commands).toHaveLength(1);
    expect(state.commands[0].body).toEqual({
      description: "Corrected freight description", performedByName: "Test forwarder",
      expectedVersion: initialVersion, reason: "Updated shipment cost from shipment detail",
    });
    expect(state.costs[0].estimatedCents).toBe(5000);
    expect(state.costs[0].actualCents).toBe(4800);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`protected-${protectedBy}-cost.png`), fullPage: true });
    expect(failures).toEqual([]);
  });
}

test("lost create response retries the original key and creates one cost", async ({ page }) => {
  const { state, failures } = await setup(page, { lostCreateResponse: true });
  await page.getByRole("button", { name: "Add Cost", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add Shipment Cost", exact: true });
  await dialog.getByRole("combobox", { name: "Performed By", exact: true }).click();
  await page.getByRole("option", { name: "Test forwarder FWD", exact: true }).click();
  await dialog.getByRole("spinbutton").fill("-0.55");
  await dialog.getByRole("button", { name: "Add Cost", exact: true }).click();
  await expect(page.getByText(/request could not be completed/).first()).toBeVisible();
  await expect(dialog.getByRole("spinbutton")).toBeDisabled();
  await expect(dialog.getByRole("spinbutton")).toHaveValue("-0.55");
  page.once("dialog", (warning) => warning.accept());
  await page.reload();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Retry cost" })).toBeVisible();
  expect(state.commands).toHaveLength(1);
  await expect(page.getByRole("dialog").getByRole("spinbutton")).toBeDisabled();
  await expect(page.getByRole("dialog").getByRole("spinbutton")).toHaveValue("-0.55");
  await dialog.getByRole("button", { name: "Retry cost" }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.commands).toHaveLength(2);
  expect(state.commands[0].key).toBe(state.commands[1].key);
  expect(state.commands[0].body).toEqual(state.commands[1].body);
  expect(state.commands[1].body).toMatchObject({ performedByVendorId: 8, performedByName: "Test forwarder" });
  expect(state.costs).toHaveLength(2);
  expect(state.costs[1].actualCents).toBe(-55);
  expect(failures).toEqual([]);
});

test("billing and performer dropdowns use the same vendors with independent identities", async ({ page }, testInfo) => {
  const { state, failures } = await setup(page);
  await page.getByRole("button", { name: "Add Cost", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add Shipment Cost", exact: true });
  await dialog.getByRole("combobox", { name: "Service Provider", exact: true }).click();
  const providerWidth = await dialog.getByRole("combobox", { name: "Service Provider", exact: true }).evaluate((element) => getComputedStyle(element).width);
  await expect(page.getByRole("dialog", { name: "Service Provider vendors", exact: true })).toHaveCSS("width", providerWidth);
  await page.getByRole("option", { name: "Test carrier BILL", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Performed By", exact: true }).click();
  await page.getByRole("combobox", { name: "Performed By vendor search", exact: true }).fill("ALT");
  const performerChoices = page.getByRole("dialog", { name: "Performed By vendors", exact: true });
  const performerWidth = await dialog.getByRole("combobox", { name: "Performed By", exact: true }).evaluate((element) => getComputedStyle(element).width);
  await expect(performerChoices).toHaveCSS("width", performerWidth);
  await page.screenshot({ path: testInfo.outputPath("cost-performer-choices.png"), fullPage: true, animations: "disabled" });
  await performerChoices.getByRole("option", { name: "Test forwarder ALT", exact: true }).click();
  await expect(performerChoices).not.toBeVisible();
  await dialog.getByRole("spinbutton").fill("25.00");
  await page.screenshot({ path: testInfo.outputPath("cost-vendor-dropdowns.png"), fullPage: true, animations: "disabled" });
  await dialog.getByRole("button", { name: "Add Cost", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.commands[0].body).toMatchObject({ vendorId: 7, performedByVendorId: 9, performedByName: "Test forwarder" });
  expect(failures).toEqual([]);
});

async function expectCompleteVendorLabel(container: Locator, name: string) {
  const label = container.getByText(name, { exact: true });
  await expect(label).toBeVisible();
  const size = await label.evaluate((element) => ({
    clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
  }));
  expect(size.clientWidth).toBeGreaterThan(0);
  expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth + 1);
  expect(size.scrollHeight).toBeLessThanOrEqual(size.clientHeight + 1);
}

for (const mode of ["create", "edit"] as const) {
  test(`the ${mode} cost modal keeps long vendor names readable in fields and options`, async ({ page }, testInfo) => {
    if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 827, height: 820 });
    const { state, failures } = await setup(page);
    const roles = [
      { label: "Service Provider", id: 7, code: "BILLING-VENDOR-123456", name: "International Shipment Billing and Customs Brokerage Services — European Regional Operations" },
      { label: "Performed By", id: 8, code: "PERFORMER-CODE-12345", name: "ConsolidatedInternationalFreightHandlingAndTransportationServicesABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" },
    ];
    await page.route("**/api/vendors", (route) => route.fulfill({ json: roles.map(({ id, code, name }) => ({ id, code, name })) }));
    if (mode === "create") await page.getByRole("button", { name: "Add Cost", exact: true }).click();
    else await editButton(page).click();
    const dialog = page.getByRole("dialog", { name: mode === "create" ? "Add Shipment Cost" : "Edit Cost", exact: true });
    const viewport = page.viewportSize()!;
    const modalBox = await dialog.boundingBox();
    expect(modalBox).not.toBeNull();
    expect(modalBox!.width).toBeGreaterThanOrEqual(testInfo.project.name === "desktop" ? 700 : 300);
    expect(modalBox!.x).toBeGreaterThanOrEqual(16);
    expect(modalBox!.x + modalBox!.width).toBeLessThanOrEqual(viewport.width - 16);
    for (const role of roles) {
      const trigger = dialog.getByRole("combobox", { name: role.label, exact: true });
      await trigger.click();
      const choices = page.getByRole("dialog", { name: `${role.label} vendors`, exact: true });
      const option = choices.getByRole("option").filter({ hasText: role.name });
      await expectCompleteVendorLabel(option, role.name);
      await expectCompleteVendorLabel(option, role.code);
      const popoverBox = await choices.boundingBox();
      expect(popoverBox).not.toBeNull();
      expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
      expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(viewport.width);
      const nameBox = await option.getByText(role.name, { exact: true }).boundingBox();
      const codeBox = await option.getByText(role.code, { exact: true }).boundingBox();
      expect(nameBox!.x + nameBox!.width).toBeLessThanOrEqual(codeBox!.x + 1);
      await page.screenshot({ path: testInfo.outputPath(`${mode}-${role.id}-vendor-options.png`), fullPage: true, animations: "disabled" });
      await option.click();
      await expect(choices).not.toBeVisible();
      await expectCompleteVendorLabel(trigger, role.name);
    }
    const modalSize = await dialog.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(modalSize.scrollWidth).toBeLessThanOrEqual(modalSize.clientWidth + 1);
    await page.screenshot({ path: testInfo.outputPath(`${mode}-full-vendor-names.png`), fullPage: true, animations: "disabled" });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(state.commands).toEqual([]);
    expect(failures).toEqual([]);
  });
}


test("an invoiced cost permits performer selection while its billing vendor remains locked", async ({ page }) => {
  const { state, failures } = await setup(page, { protected: "header" });
  await editButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Edit Cost", exact: true });
  await expect(dialog.getByRole("combobox", { name: "Service Provider", exact: true })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Performed By", exact: true }).click();
  await page.getByRole("option", { name: "Test forwarder FWD", exact: true }).click();
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.commands[0].body).toMatchObject({ performedByVendorId: 8, performedByName: "Test forwarder", expectedVersion: initialVersion });
  for (const key of ["vendorId", "actualCents", "estimatedCents", "allocationMethod", "invoiceDate"]) expect(state.commands[0].body).not.toHaveProperty(key);
  expect(state.costs[0]).toMatchObject({ vendorId: 7, vendorInvoiceId: 71, performedByVendorId: 8, actualCents: 4800 });
  expect(failures).toEqual([]);
});

for (const mode of ["create", "edit"] as const) {
  for (const role of ["provider", "performer"] as const) {
    test(`quick-add while ${mode} selects only the ${role}`, async ({ page }) => {
      const { state, failures } = await setup(page);
      const newName = `New ${role}`;
      await page.route("**/api/vendors", (route) => route.request().method() === "POST"
        ? route.fulfill({ json: { id: 10, code: "NEW-VENDOR", name: newName } }) : route.fallback());
      if (mode === "create") await page.getByRole("button", { name: "Add Cost", exact: true }).click();
      else await editButton(page).click();
      const costDialog = page.getByRole("dialog", { name: mode === "create" ? "Add Shipment Cost" : "Edit Cost", exact: true });
      if (mode === "create") {
        await costDialog.getByRole("spinbutton").fill("25.00");
        await costDialog.getByRole("combobox", { name: "Service Provider", exact: true }).click();
        await page.getByRole("dialog", { name: "Service Provider vendors", exact: true }).getByRole("option", { name: "Test carrier BILL", exact: true }).click();
      }
      const label = role === "provider" ? "Service Provider" : "Performed By";
      await costDialog.getByRole("combobox", { name: label, exact: true }).click();
      await page.getByRole("dialog", { name: `${label} vendors`, exact: true }).getByRole("option", { name: "Add New Vendor", exact: true }).click();
      const createDialog = page.getByRole("dialog", { name: "Add New Vendor", exact: true });
      await createDialog.locator('input').nth(0).fill("NEW-VENDOR");
      await createDialog.locator('input').nth(1).fill(newName);
      await createDialog.getByRole("button", { name: "Create Vendor" }).click();
      await expect(createDialog).not.toBeVisible();
      await expect(costDialog.getByRole("combobox", { name: label, exact: true })).toHaveText(newName);
      if (role === "performer") await expect(costDialog.getByRole("combobox", { name: "Service Provider", exact: true })).toHaveText("Test carrier");
      else await expect(costDialog.getByRole("combobox", { name: "Performed By", exact: true })).toHaveText(mode === "edit" ? "Test forwarder" : "Select vendor...");
      await costDialog.getByRole("button", { name: mode === "create" ? "Add Cost" : "Save Changes", exact: true }).click();
      await expect(costDialog).not.toBeVisible();
      if (role === "performer") {
        expect(state.commands[0].body).toMatchObject({ performedByVendorId: 10, performedByName: newName });
        if (mode === "edit") expect(state.commands[0].body).not.toHaveProperty("vendorId");
        else expect(state.commands[0].body.vendorId).toBe(7);
      } else {
        expect(state.commands[0].body.vendorId).toBe(10);
        expect(state.commands[0].body.performedByName).toBe(mode === "edit" ? "Test forwarder" : "");
      }
      expect(failures).toEqual([]);
    });
  }
}

test("preserves a historical performer until the user explicitly clears it", async ({ page }) => {
  const { state, failures } = await setup(page);
  await editButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Edit Cost", exact: true });
  await expect(dialog.getByRole("combobox", { name: "Performed By", exact: true })).toHaveText("Test forwarder");
  await dialog.getByRole("combobox", { name: "Performed By", exact: true }).click();
  await page.getByRole("option", { name: "Clear selection", exact: true }).click();
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.commands[0].body).toMatchObject({ performedByVendorId: null, performedByName: "" });
  expect(state.costs[0].vendorId).toBe(7);
  expect(failures).toEqual([]);
});

test("reports vendor-list failures and supports an explicit retry", async ({ page }) => {
  const { state, failures } = await setup(page);
  let reads = 0;
  await page.route("**/api/vendors", (route) => ++reads === 1
    ? route.fulfill({ status: 503, json: { error: "Fixture directory failure" } })
    : route.fulfill({ json: [{ id: 8, name: "Test forwarder", code: "FWD" }] }));
  await editButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Edit Cost", exact: true });
  await dialog.getByRole("combobox", { name: "Performed By", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not load vendors." })).toBeVisible();
  await page.getByRole("option", { name: "Retry loading vendors", exact: true }).click();
  await page.getByRole("option", { name: "Test forwarder FWD", exact: true }).click();
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.commands[0].body.performedByVendorId).toBe(8);
  expect(failures).toEqual([]);
});

test("conflict preserves the draft until explicit reload and then uses a new version/key", async ({ page }, testInfo) => {
  const { state, failures } = await setup(page, { conflictPatch: true });
  await editButton(page).click();
  const dialog = page.getByRole("dialog");
  await field(page, "Description").fill("My draft description");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog.getByText(/Your draft is preserved/)).toBeVisible();
  await expect(field(page, "Description")).toHaveValue("My draft description");
  await expect(dialog.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("cost-version-conflict.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Load latest cost" }).click();
  await expect(field(page, "Description")).toHaveValue("Another user updated this charge");
  await field(page, "Description").fill("Reviewed current details");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.commands).toHaveLength(2);
  expect(state.commands[0].body.expectedVersion).toBe(initialVersion);
  expect(state.commands[1].body.expectedVersion).toBe(nextVersion);
  expect(state.commands[0].key).not.toBe(state.commands[1].key);
  expect(failures).toEqual([]);
});

test("invalid amounts stay local, and a confirmed delete carries the displayed version", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.getByRole("button", { name: "Add Cost", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("spinbutton").fill("12.345");
  await dialog.getByRole("button", { name: "Add Cost", exact: true }).click();
  await expect(page.getByText(/at most two decimal places/).first()).toBeVisible();
  expect(state.commands).toHaveLength(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  page.once("dialog", (confirmation) => confirmation.accept());
  await removeButton(page).click();
  await expect(editButton(page)).toHaveCount(0);
  expect(state.commands).toHaveLength(1);
  expect(state.commands[0].method).toBe("DELETE");
  expect(state.commands[0].body).toEqual({ expectedVersion: initialVersion, reason: "Removed shipment charge from shipment detail" });
  expect(failures).toEqual([]);
});

test("a saved cost with a failed refresh reports the confirmed save without encouraging resubmission", async ({ page }) => {
  const { state, failures } = await setup(page, { failRefresh: true });
  await editButton(page).click();
  await field(page, "Description").fill("Saved before refresh failure");
  await page.getByRole("dialog").getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByText(/cost was saved, but the view could not refresh/).first()).toBeVisible();
  expect(state.commands).toHaveLength(1);
  expect(state.costs[0].description).toBe("Saved before refresh failure");
  expect(failures).toEqual([]);
});

test("recovery storage failure blocks create dispatch explicitly", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith("echelon:shipment-cost-create:")) throw new DOMException("Fixture quota failure", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  const { state, failures } = await setup(page);
  await page.getByRole("button", { name: "Add Cost", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("spinbutton").fill("12.50");
  await dialog.getByRole("button", { name: "Add Cost", exact: true }).click();
  await expect(page.getByText(/cost was not sent because its recovery key could not be saved/).first()).toBeVisible();
  expect(state.commands).toHaveLength(0);
  await expect(dialog.getByRole("spinbutton")).toBeEnabled();
  expect(failures).toEqual([]);
});

test("a command needing operator recovery can be dismissed and reopened with its original intent", async ({ page }) => {
  const { state, failures } = await setup(page, { deadCreateResponse: true });
  await page.getByRole("button", { name: "Add Cost", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("spinbutton").fill("18.25");
  await dialog.getByRole("button", { name: "Add Cost", exact: true }).click();
  await expect(page.getByText(/requires operator review/).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("Cost creation needs review", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Costs/ })).toHaveAttribute("data-state", "active");
  await page.getByRole("button", { name: "Review pending cost", exact: true }).click();
  await expect(dialog.getByRole("spinbutton")).toHaveValue("18.25");
  await expect(dialog.getByRole("spinbutton")).toBeDisabled();
  state.allowCreateRetry = true; // Fixture represents operator re-arming the same command.
  await dialog.getByRole("button", { name: "Retry cost", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.commands).toHaveLength(2);
  expect(state.commands[0].key).toBe(state.commands[1].key);
  expect(state.commands[0].body).toEqual(state.commands[1].body);
  await expect(page.getByText("Cost creation needs review", { exact: true })).toHaveCount(0);
  expect(failures).toEqual([]);
});
