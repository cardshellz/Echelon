import { expect, test, type Page } from "@playwright/test";
import { setupEbayChannelPage } from "./fixtures/ebay-channel-page.fixture";

const originalRule = {
  id: 11, channel_id: 67, scope: "channel", scope_id: null as string | null, scope_label: null as string | null,
  rule_type: "percentage", value: "10.00",
  created_at: "2026-10-20T12:00:00Z", updated_at: "2026-10-20T12:00:00Z",
};
const otherRule = {
  ...originalRule, id: 12, scope: "product", scope_id: "99", scope_label: "Other product",
};

async function setup(page: Page, rules = [originalRule]) {
  const original = await setupEbayChannelPage(page);
  const state = {
    rules: rules.map(rule => ({ ...rule })),
    saves: [] as Record<string, unknown>[],
    deletes: [] as Array<{ id: number; body: unknown }>,
    rejectSave: false,
    rejectDelete: false,
    failRead: false,
    reads: 0,
  };
  await page.route("**/api/ebay/pricing-rules", async route => {
    if (route.request().method() === "GET") {
      state.reads++;
      if (state.failRead) return route.fulfill({
        status: 503, json: { error: "Saved pricing rules are temporarily unavailable." },
      });
      return route.fulfill({ json: { rules: state.rules } });
    }
    expect(route.request().method()).toBe("PUT");
    const command = route.request().postDataJSON() as Record<string, unknown>;
    state.saves.push(command);
    if (state.rejectSave) return route.fulfill({
      status: 409, json: { error: "Pricing changed. Reload before saving." },
    });
    const previous = state.rules.find(rule => rule.scope === command.scope && rule.scope_id === command.scopeId);
    const [whole, fraction = ""] = String(command.value).split(".");
    const saved = {
      id: previous?.id ?? 20, channel_id: 67,
      scope: String(command.scope), scope_id: command.scopeId as string | null,
      rule_type: String(command.ruleType), value: `${whole}.${fraction.padEnd(2, "0")}`,
    };
    state.rules = [
      ...state.rules.filter(rule => rule.id !== saved.id),
      { ...originalRule, ...previous, ...saved },
    ];
    // Production acknowledges canonical pricing data without list-only labels or timestamps.
    return route.fulfill({ json: { rule: saved } });
  });
  await page.route(/\/api\/ebay\/pricing-rules\/\d+$/, async route => {
    expect(route.request().method()).toBe("DELETE");
    const id = Number(new URL(route.request().url()).pathname.split("/").at(-1));
    state.deletes.push({ id, body: route.request().postDataJSON() });
    if (state.rejectDelete) return route.fulfill({
      status: 409, json: { error: "Pricing changed. Reload before deleting." },
    });
    state.rules = state.rules.filter(rule => rule.id !== id);
    return route.fulfill({ json: { success: true } });
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Add Rule", exact: true })).toBeEnabled();
  return { ...original, state };
}

test("pricing saves the exact decimal string and absence snapshot for a new rule", async ({ page }) => {
  const { state, errors, unexpected } = await setup(page, []);
  await page.getByRole("button", { name: "Add Rule", exact: true }).click();
  await page.getByRole("spinbutton").fill("0.29");
  await page.getByRole("button", { name: "Save pricing rule", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0]).toEqual({
    scope: "channel", scopeId: null, ruleType: "percentage", value: "0.29", expected: null,
  });
  await expect(page.getByRole("button", { name: "Add Rule", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("pricing retains the edit snapshot through a query refresh and a rejected retry", async ({ page }) => {
  const { state, errors, unexpected } = await setup(page, [originalRule, otherRule]);
  await page.getByRole("button", { name: "Add Rule", exact: true }).click();
  await page.getByRole("spinbutton").fill("19.90");

  // Deleting another displayed rule triggers the real page's pricing query
  // invalidation while this draft is open. Simulate an intervening edit to its
  // target before that refresh, without replacing the draft's original baseline.
  state.rules[0] = { ...originalRule, value: "20.00" };
  const readsBefore = state.reads;
  await page.getByRole("button", { name: "Delete Other product pricing rule", exact: true })
    .filter({ visible: true }).click();
  await expect.poll(() => state.reads).toBeGreaterThan(readsBefore);
  await expect(page.getByText("+20%", { exact: true }).filter({ visible: true })).toBeVisible();
  expect(state.deletes).toEqual([{
    id: 12, body: { expected: { id: 12, ruleType: "percentage", value: "10.00" } },
  }]);

  state.rejectSave = true;
  await page.getByRole("button", { name: "Save pricing rule", exact: true }).click();
  await expect(page.getByText("Pricing changed. Reload before saving.", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("spinbutton")).toHaveValue("19.90");
  expect(state.saves).toEqual([{
    scope: "channel", scopeId: null, ruleType: "percentage", value: "19.90",
    expected: { id: 11, ruleType: "percentage", value: "10.00" },
  }]);

  await page.getByRole("button", { name: "Save pricing rule", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(2);
  expect(state.saves[1]).toEqual(state.saves[0]);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("deleting a displayed rule sends its exact expected state", async ({ page }) => {
  const { state, errors, unexpected } = await setup(page);
  await page.getByRole("button", { name: "Delete channel pricing rule", exact: true })
    .filter({ visible: true }).click();
  await expect.poll(() => state.deletes.length).toBe(1);
  expect(state.deletes[0]).toEqual({
    id: 11, body: { expected: { id: 11, ruleType: "percentage", value: "10.00" } },
  });
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("explicit pricing reload preserves the draft and rebases only after a successful fresh read", async ({ page }) => {
  const { state, errors, unexpected } = await setup(page);
  await page.getByRole("button", { name: "Add Rule", exact: true }).click();
  await page.getByRole("combobox").filter({ hasText: "Percentage (+X%)" }).click();
  await page.getByRole("option", { name: "Fixed (+$X.XX)", exact: true }).click();
  await page.getByRole("spinbutton").fill("19.90");
  state.rules[0] = { ...originalRule, value: "20.00" };
  state.rejectSave = true;
  const save = page.getByRole("button", { name: "Save pricing rule", exact: true });
  await save.click();
  await expect(page.getByRole("alert")).toHaveText("Pricing changed. Reload before saving.");
  const reload = page.getByRole("button", { name: "Reload saved pricing rules", exact: true });

  state.failRead = true;
  await reload.click();
  await expect(page.getByRole("alert")).toHaveText("Saved pricing rules are temporarily unavailable.");
  await expect(page.getByRole("spinbutton")).toHaveValue("19.90");
  await save.click();
  await expect.poll(() => state.saves.length).toBe(2);
  expect(state.saves[1]).toEqual(state.saves[0]);
  expect(state.saves[1].expected).toEqual({ id: 11, ruleType: "percentage", value: "10.00" });

  state.failRead = false;
  await reload.click();
  await expect(page.getByRole("status").filter({ hasText: "Saved pricing rules reloaded." })).toBeVisible();
  await expect(page.getByRole("spinbutton")).toHaveValue("19.90");
  await expect(page.getByRole("combobox").filter({ hasText: "Fixed (+$X.XX)" })).toBeVisible();
  await expect(page.getByRole("combobox").filter({ hasText: "Channel (all products)" })).toBeVisible();
  state.rejectSave = false;
  await save.click();
  await expect(page.getByRole("button", { name: "Add Rule", exact: true })).toBeVisible();
  expect(state.saves[2]).toEqual({
    scope: "channel", scopeId: null, ruleType: "fixed", value: "19.90",
    expected: { id: 11, ruleType: "percentage", value: "20.00" },
  });
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("an acknowledged price remains the next edit baseline when the following read fails", async ({ page }) => {
  const { state, errors, unexpected } = await setup(page);
  await page.getByRole("button", { name: "Add Rule", exact: true }).click();
  await page.getByRole("spinbutton").fill("12.5");
  state.failRead = true;
  const readsBefore = state.reads;
  await page.getByRole("button", { name: "Save pricing rule", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add Rule", exact: true })).toBeVisible();
  await expect.poll(() => state.reads).toBeGreaterThan(readsBefore);
  await page.getByRole("button", { name: "Add Rule", exact: true }).click();
  await page.getByRole("spinbutton").fill("13.25");
  await page.getByRole("button", { name: "Save pricing rule", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(2);
  expect(state.saves[1]).toEqual({
    scope: "channel", scopeId: null, ruleType: "percentage", value: "13.25",
    expected: { id: 11, ruleType: "percentage", value: "12.50" },
  });
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("a stale delete can explicitly reload and its acknowledgement survives a failed refresh", async ({ page }) => {
  const { state, errors, unexpected } = await setup(page);
  state.rules[0] = { ...originalRule, value: "20.00" };
  state.rejectDelete = true;
  const remove = page.getByRole("button", { name: "Delete channel pricing rule", exact: true }).filter({ visible: true });
  await remove.click();
  await expect(page.getByRole("alert")).toHaveText("Pricing changed. Reload before deleting.");
  await page.getByRole("button", { name: "Reload saved pricing rules", exact: true }).click();
  await expect(page.getByText("+20%", { exact: true }).filter({ visible: true })).toBeVisible();
  state.rejectDelete = false;
  state.failRead = true;
  await remove.click();
  await expect(remove).toHaveCount(0);
  expect(state.deletes[1]).toEqual({
    id: 11, body: { expected: { id: 11, ruleType: "percentage", value: "20.00" } },
  });
  await page.getByRole("button", { name: "Add Rule", exact: true }).click();
  await page.getByRole("spinbutton").fill("3.00");
  await page.getByRole("button", { name: "Save pricing rule", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0].expected).toBeNull();
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});
