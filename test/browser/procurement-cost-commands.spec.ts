import { expect, test, type Page, type Route } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";

const initialVersion = "a".repeat(64);
const nextVersion = "b".repeat(64);
const fixtureCost = () => ({
  id: 31, inboundShipmentId: 42, version: initialVersion, costType: "freight",
  description: "Freight charge", estimatedCents: 5000, actualCents: 4800,
  allocationMethod: "by_volume", vendorId: 7, vendorName: "Test carrier",
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
  await page.route("**/api/vendors", (route) => route.fulfill({ json: [{ id: 7, name: "Test carrier" }] }));
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
    await expect(dialog.getByRole("combobox")).toHaveCount(3);
    for (const select of await dialog.getByRole("combobox").all()) await expect(select).toBeDisabled();
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
  const dialog = page.getByRole("dialog");
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
  expect(state.costs).toHaveLength(2);
  expect(state.costs[1].actualCents).toBe(-55);
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
