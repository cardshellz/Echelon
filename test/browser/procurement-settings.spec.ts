import { expect, test, type Page } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";

const settingsFixture = () => ({
  requireApproval: false,
  autoSendOnApprove: true,
  requireAcknowledgeBeforeReceive: false,
  hideIncotermsDomestic: false,
  enableShipmentTracking: true,
  autoPutawayLocation: true,
  autoCloseOnReconcile: true,
  oneClickReceiveStart: true,
  useNewPoEditor: false,
  useNewReorderCockpit: false,
  futureServerField: { preserved: true },
});
const available = ["requireApproval", "hideIncotermsDomestic", "useNewPoEditor", "useNewReorderCockpit"];
const unavailable = ["autoSendOnApprove", "requireAcknowledgeBeforeReceive", "enableShipmentTracking", "autoPutawayLocation", "autoCloseOnReconcile", "oneClickReceiveStart"];

async function setup(page: Page, canEdit = true) {
  const failures = await installFixtures(page);
  const saved = settingsFixture();
  const reads: string[] = [];
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: {
    user: { id: "settings-operator", username: "test", role: "admin" },
    permissions: canEdit ? ["purchasing:view", "inventory:adjust"] : ["purchasing:view"],
    roles: ["admin"],
  } }));
  await page.route("**/api/settings/procurement", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    reads.push(route.request().url());
    return route.fulfill({ json: saved });
  });
  return { saved, reads, failures };
}

test("only proven settings are editable and a save waits for its confirmed response", async ({ page }, testInfo) => {
  const { saved, failures } = await setup(page);
  const writes: unknown[] = [];
  let release: () => void = () => undefined;
  const responseGate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/settings/procurement", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    writes.push(route.request().postDataJSON());
    await responseGate;
    saved.requireApproval = true;
    return route.fulfill({ json: saved });
  });
  await page.goto("/settings/procurement");
  await expect(page.getByRole("heading", { name: "Procurement Settings", exact: true })).toBeVisible();
  for (const key of available) await expect(page.locator(`[data-setting="${key}"]`).getByRole("switch")).toBeEnabled();
  for (const key of unavailable) {
    const card = page.locator(`[data-setting="${key}"]`);
    await expect(card.getByRole("switch")).toBeDisabled();
    await expect(card).toContainText("Unavailable");
    await expect(card).toContainText("This option has no effect.");
  }
  await expect(page.locator('[data-setting="autoSendOnApprove"]')).toContainText("Saved preference: On");
  await expect(page.locator('[data-setting="autoSendOnApprove"]')).toContainText("does not send a purchase");
  await expect(page.locator('[data-setting="hideIncotermsDomestic"]')).toContainText("US suppliers always hide the field");
  expect(writes).toEqual([]);
  const approval = page.getByRole("switch", { name: "Require approval", exact: true });
  await approval.click();
  try {
    await expect(page.getByRole("status").filter({ hasText: "Confirming saved setting" })).toBeVisible();
    await expect(approval).not.toBeChecked();
    for (const key of available) await expect(page.locator(`[data-setting="${key}"]`).getByRole("switch")).toBeDisabled();
  } finally { release(); }
  await expect(approval).toBeChecked();
  await expect(approval).toBeEnabled();
  expect(writes).toEqual([{ key: "requireApproval", value: true }]);
  expect(saved).toEqual({ ...settingsFixture(), requireApproval: true });
  await page.screenshot({ path: testInfo.outputPath("procurement-settings-availability.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});

test("an admin with purchasing view but no settings-write capability can only inspect saved values", async ({ page }) => {
  const { failures } = await setup(page, false);
  await page.goto("/settings/procurement");
  await expect(page.getByText("Your role has read-only access to these settings.")).toBeVisible();
  await expect(page.getByRole("switch")).toHaveCount(10);
  for (const control of await page.getByRole("switch").all()) await expect(control).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Auto-send on approve", exact: true })).toBeChecked();
  // Even clicking the disabled DOM control cannot dispatch the mutation.
  await page.getByRole("switch", { name: "Require approval", exact: true }).evaluate((element) => (element as HTMLButtonElement).click());
  expect(failures).toEqual([]);
});

test("a rejected save leaves the saved value visible and refreshes authoritative state", async ({ page }) => {
  const { failures, reads } = await setup(page);
  const writes: unknown[] = [];
  await page.route("**/api/settings/procurement", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    writes.push(route.request().postDataJSON());
    return route.fulfill({ status: 403, json: { error: "Synthetic permission rejection" } });
  });
  await page.goto("/settings/procurement");
  const approval = page.getByRole("switch", { name: "Require approval", exact: true });
  await expect(approval).toBeEnabled();
  const before = reads.length;
  await approval.click();
  await expect(page.getByRole("alert").filter({ hasText: "The save was not confirmed" })).toBeVisible();
  await expect(approval).not.toBeChecked();
  await expect(approval).toBeEnabled();
  expect(reads.length).toBeGreaterThan(before);
  expect(writes).toEqual([{ key: "requireApproval", value: true }]);
  expect(failures).toEqual([]);
});

for (const outcome of ["lost response", "malformed response"] as const) {
  test(`${outcome} reloads a committed setting without sending another write`, async ({ page }) => {
    const { saved, failures } = await setup(page);
    const writes: unknown[] = [];
    await page.route("**/api/settings/procurement", (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      writes.push(route.request().postDataJSON());
      saved.requireApproval = true;
      return outcome === "lost response" ? route.abort("failed") : route.fulfill({ json: { requireApproval: true } });
    });
    await page.goto("/settings/procurement");
    const approval = page.getByRole("switch", { name: "Require approval", exact: true });
    await approval.click();
    await expect(page.getByRole("alert").filter({ hasText: "The save was not confirmed" })).toBeVisible();
    await expect(approval).toBeChecked();
    await expect(approval).toBeEnabled();
    expect(writes).toEqual([{ key: "requireApproval", value: true }]);
    expect(failures).toEqual([]);
  });
}

test("malformed settings never appear as default off controls and can be reloaded", async ({ page }) => {
  const { failures } = await setup(page);
  let valid = false;
  await page.route("**/api/settings/procurement", (route) => route.fulfill({ json: valid ? settingsFixture() : { useNewPoEditor: "true" } }));
  await page.goto("/settings/procurement");
  await expect(page.getByRole("alert").filter({ hasText: "Procurement settings could not be loaded" })).toBeVisible();
  await expect(page.getByRole("switch")).toHaveCount(0);
  valid = true;
  await page.getByRole("button", { name: "Retry settings", exact: true }).click();
  await expect(page.getByRole("switch")).toHaveCount(10);
  await expect(page.getByRole("switch", { name: "Require approval", exact: true })).toBeEnabled();
  expect(failures).toEqual([]);
});
