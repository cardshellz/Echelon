import { expect, test } from "@playwright/test";
import { installReturnPreviewFixtures, PREVIEW_API } from "./returns-preview-fixtures";

test("split shipments can be reviewed in two boxes without live effects", async ({ page }, testInfo) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto("/returns/portal-preview");
  await expect(page.getByTestId("preview-canvas")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("admin-preview.png"), fullPage: true });
  await page.getByLabel("Order number", { exact: true }).fill("  # TEST-1001  ");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  const sleeves = page.getByTestId("preview-line-sample-line-1");
  const storage = page.getByTestId("preview-line-sample-line-3");
  await sleeves.getByRole("spinbutton").fill("3");
  await storage.getByRole("spinbutton").fill("1");
  await page.screenshot({ path: testInfo.outputPath("item-selection.png"), fullPage: true });
  await page.getByRole("button", { name: "Continue to packing", exact: true }).click();
  await page.getByRole("button", { name: "Add another box", exact: true }).click();
  await page.getByLabel("Quantity of item 1: Sample collector sleeves (100 count · Clear) in box 1", { exact: true }).fill("1");
  await page.getByLabel("Quantity of item 1: Sample collector sleeves (100 count · Clear) in box 2", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Review return", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to packing", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review your return", exact: true })).toBeInViewport();
  const reviews = fixture.previewRequests.filter(request => request.path === `${PREVIEW_API}/review`);
  expect(reviews).toHaveLength(1);
  expect(reviews[0].body).toMatchObject({
    selections: [
      { lineId: "sample-line-1", quantity: 3, reasonCode: null },
      { lineId: "sample-line-3", quantity: 1, reasonCode: null },
    ],
    parcels: [
      { items: [{ lineId: "sample-line-1", quantity: 1 }, { lineId: "sample-line-3", quantity: 1 }] },
      { items: [{ lineId: "sample-line-1", quantity: 2 }] },
    ],
  });
  await page.screenshot({ path: testInfo.outputPath("return-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Back to packing", exact: true }).click();
  await expect(page.getByLabel("Quantity of item 1: Sample collector sleeves (100 count · Clear) in box 2", { exact: true })).toHaveValue("2");
  await page.getByRole("button", { name: "Back to items", exact: true }).click();
  await expect(sleeves.getByRole("spinbutton")).toHaveValue("3");
  await sleeves.getByRole("spinbutton").fill("2");
  await page.getByRole("button", { name: "Continue to packing", exact: true }).click();
  await expect(page.getByTestId("preview-box-2")).toHaveCount(0);
  await expect(page.getByLabel("Quantity of item 1: Sample collector sleeves (100 count · Clear) in box 1", { exact: true })).toHaveValue("2");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(fixture.failures).toEqual([]);
});

test("changing scenario clears selections and shipped items cannot be returned", async ({ page }) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto("/returns/portal-preview");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page.getByTestId("preview-line-sample-line-1").getByRole("spinbutton").fill("2");
  await page.getByLabel("Sample order", { exact: true }).selectOption("in_transit");
  await expect(page.getByLabel("Order number", { exact: true })).toHaveValue("TEST-1003");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await expect(page.getByText("These items have not been delivered yet.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to packing", exact: true })).toBeDisabled();
  await page.getByLabel("Sample order", { exact: true }).selectOption("partially_delivered");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  const quantity = page.getByTestId("preview-line-sample-line-1").getByRole("spinbutton");
  await expect(quantity).toHaveValue("0");
  await expect(quantity).toHaveAttribute("max", "1");
  expect(fixture.failures).toEqual([]);
});

test("a server denial clears the customer canvas and allows a fresh retry", async ({ page }) => {
  const fixture = await installReturnPreviewFixtures(page);
  let denied = true;
  await page.route(`**${PREVIEW_API}`, route => route.fulfill(denied
    ? { status: 403, json: { error: { message: "Administrator access is required." } } }
    : { json: fixture.service.getState() }));
  await page.goto("/returns/portal-preview");
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
  await expect(page.getByText(/Admin access is required/)).toBeVisible();
  denied = false;
  await page.getByRole("button", { name: /try again|retry/i }).click();
  await expect(page.getByTestId("preview-canvas")).toBeVisible();
  await page.route(`**${PREVIEW_API}/order`, route => route.fulfill({
    status: 403, json: { error: { message: "Administrator access is required." } },
  }));
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
  await expect(page.getByText(/Admin access is required/)).toBeVisible();
  expect(fixture.failures).toEqual([]);
});

test("non-admin staff cannot render the preview or read its API", async ({ page }) => {
  const fixture = await installReturnPreviewFixtures(page, "lead");
  await page.goto("/returns/portal-preview");
  await expect(page).toHaveURL(/\/picking$/);
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
  expect(fixture.previewRequests).toEqual([]);
  expect(fixture.failures).toEqual([]);
});

test("a malformed response cannot produce a review or stale sample order", async ({ page }) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.route(`**${PREVIEW_API}/order`, route => route.fulfill({ json: {
    ...fixture.service.lookup({ scenarioId: "split_delivered", orderReference: "TEST-1001" }),
    scenarioId: "partially_delivered",
  } }));
  await page.goto("/returns/portal-preview");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await expect(page.getByText(/sample order response could not be verified/i)).toBeVisible();
  await expect(page.getByTestId("preview-line-sample-line-1")).toHaveCount(0);
  expect(fixture.previewRequests.filter(request => request.path === `${PREVIEW_API}/review`)).toEqual([]);
  expect(fixture.failures).toEqual([]);
});

test("an old order response cannot replace a newly selected scenario", async ({ page }) => {
  const fixture = await installReturnPreviewFixtures(page);
  let release!: () => void;
  let received!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { received = resolve; });
  await page.route(`**${PREVIEW_API}/order`, async route => {
    const body = route.request().postDataJSON();
    if (body.scenarioId === "split_delivered") {
      received();
      await pending;
    }
    await route.fulfill({ json: fixture.service.lookup(body) });
  });
  await page.goto("/returns/portal-preview");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await requested;
  await page.getByLabel("Sample order", { exact: true }).selectOption("in_transit");
  release();
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await expect(page.getByText("Order #TEST-1003", { exact: true })).toBeVisible();
  await expect(page.getByText("Order #TEST-1001", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue to packing", exact: true })).toBeDisabled();
  expect(fixture.failures).toEqual([]);
});

test("same-name purchased lines remain distinguishable by sight and accessible name", async ({ page }) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto("/returns/portal-preview");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page.getByLabel("Return quantity for item 1: Sample collector sleeves (100 count · Clear)", { exact: true }).fill("2");
  await page.getByLabel("Return quantity for item 2: Sample collector sleeves (100 count · Clear)", { exact: true }).fill("1");
  await page.getByLabel("Reason for returning item 2: Sample collector sleeves (100 count · Clear) (optional)", { exact: true }).selectOption("ordered_by_mistake");
  await page.getByRole("button", { name: "Continue to packing", exact: true }).click();
  await expect(page.getByLabel("Quantity of item 1: Sample collector sleeves (100 count · Clear) in box 1", { exact: true })).toHaveValue("2");
  await expect(page.getByLabel("Quantity of item 2: Sample collector sleeves (100 count · Clear) in box 1", { exact: true })).toHaveValue("1");
  await page.getByRole("button", { name: "Review return", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your return", exact: true })).toBeVisible();
  await expect(page.getByText("Item 1 · 100 count · Clear", { exact: true })).toBeVisible();
  await expect(page.getByText("Item 2 · 100 count · Clear", { exact: true })).toBeVisible();
  const reviews = fixture.previewRequests.filter(request => request.path === `${PREVIEW_API}/review`);
  expect(reviews[0].body).toMatchObject({ selections: [
    { lineId: "sample-line-1", quantity: 2, reasonCode: null },
    { lineId: "sample-line-2", quantity: 1, reasonCode: "ordered_by_mistake" },
  ] });
  expect(fixture.failures).toEqual([]);
});
