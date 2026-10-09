import { test, expect } from "@playwright/test";
import { pickCorrectionSchema, type PickCorrection } from "../../shared/pick-corrections";
import { resolve } from "node:path";

const path = "/__pick-corrections";
test.beforeEach(async ({ page }) => {
  await page.route("**/__pick-corrections**", route => route.fulfill({ contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
    </head><body><div id="root"></div><script type="module" src="/@fs/${resolve("test/browser/fixtures/pick-corrections-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
});
function correction(): PickCorrection {
  return pickCorrectionSchema.parse({ id: 1, orderId: 42, orderItemId: 80, orderNumber: "#63085", sku: "P5", name: "Pack of five",
    barcode: "12345", location: "A-01", declaredQuantity: 3, pickedQuantity: 1, revision: 1,
    state: "confirmation_required", answer: null, assignedPickerId: null, reviewReason: null,
    updatedAt: new Date("2026-10-09T12:00:00.000Z") });
}

test("Yes/No only, No survives refresh, partial scans preserve the earlier pick", async ({ page }) => {
  let item = correction();
  const writes: Array<Record<string, unknown>> = [];
  await page.route("**/api/picking/corrections**", async route => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: item.state === "resolved" ? [] : [item] });
    const command = request.postDataJSON(); writes.push(command);
    if (request.url().endsWith("/answer")) item = { ...item, answer: command.answer, state: "picking_required", assignedPickerId: "picker", revision: 2 };
    else if (command.barcode !== item.barcode) return route.fulfill({ status: 409, json: { error: "That barcode does not match the item that needs picking." } });
    else item = { ...item, pickedQuantity: command.pickedQuantity,
      state: command.pickedQuantity === 3 ? "resolved" : "picking_required" };
    await route.fulfill({ json: item });
  });
  await page.goto(path);
  const prompt = page.getByRole("alertdialog");
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole("button")).toHaveText(["Yes", "No"]);
  await page.screenshot({ path: test.info().outputPath("missing-pick-confirmation.png"), animations: "disabled" });
  const bounds = await prompt.boundingBox();
  const viewport = page.viewportSize()!;
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
  await prompt.getByRole("button", { name: "No", exact: true }).click();
  await expect(prompt).not.toBeVisible();
  expect(item.pickedQuantity).toBe(1);
  await page.reload();
  await expect(page.getByRole("alertdialog")).not.toBeVisible();
  await expect(page.getByText("2 still need a pick record")).toBeVisible();
  await page.getByLabel("Scan item barcode or SKU").fill("WRONG");
  await page.getByRole("button", { name: "Record corrective pick" }).click();
  await expect(page.getByRole("alert")).toContainText("does not match");
  await page.getByLabel("Scan item barcode or SKU").fill("12345");
  await page.getByRole("button", { name: "Record corrective pick" }).click();
  await expect(page.getByText("1 still need a pick record")).toBeVisible();
  await page.getByLabel("Scan item barcode or SKU").fill("12345");
  await page.getByRole("button", { name: "Record corrective pick" }).click();
  await expect(page.getByRole("status")).toContainText("Finish any box or label changes in ShipStation");
  expect(writes.map(command => command.pickedQuantity ?? command.answer)).toEqual(["no", 2, 2, 3]);
});

test("Yes uses confirmation, not a new barcode scan or a shipping command", async ({ page }) => {
  let item = correction(); const writes: unknown[] = [];
  await page.route("**/api/picking/corrections**", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: item.state === "resolved" ? [] : [item] });
    writes.push(route.request().postDataJSON());
    item = { ...item, state: "resolved", answer: "yes", pickedQuantity: 3, revision: 3 };
    await route.fulfill({ json: item });
  });
  await page.goto(path);
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Pick record corrected");
  expect(writes).toEqual([expect.objectContaining({ answer: "yes", expectedRevision: 1 })]);
  await expect(page.getByLabel("Scan item barcode or SKU")).toHaveCount(0);
});

test("a saved Yes awaiting inventory recovery stays off the picker after reload", async ({ page }) => {
  let item = correction();
  const writes: Array<{ path: string; body: unknown }> = [];
  await page.route("**/api/picking/corrections**", async route => {
    const request = route.request();
    if (request.method() === "GET") {
      // readPickCorrections excludes saved Yes answers; the system retries their inventory record.
      return route.fulfill({ json: item.answer === "yes" ? [] : [item] });
    }
    writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    item = { ...item, state: "picking_required", answer: "yes", assignedPickerId: "picker",
      reviewReason: "Shipping already deducted units; inventory review is required.", revision: 3 };
    return route.fulfill({ status: 500, json: { code: "CORRECTIVE_PICK_NOT_SAVED",
      error: "The correction remains open. Refresh it to see the inventory review details." } });
  });
  await page.goto(path);
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(item).toMatchObject({ answer: "yes", state: "picking_required", pickedQuantity: 1 });
  expect(writes).toEqual([{ path: "/api/picking/corrections/1/answer",
    body: { commandId: expect.any(String), answer: "yes", expectedRevision: 1 } }]);

  const reloadedCorrections = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/picking/corrections" && response.request().method() === "GET");
  await page.reload();
  expect(await (await reloadedCorrections).json()).toEqual([]);
  await expect(page.getByRole("heading", { name: "Picking queue", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Pick corrections" })).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry recording confirmed pick" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(writes).toHaveLength(1);
});

test("an invalid correction response shows a load error instead of pick actions", async ({ page }) => {
  const { updatedAt: _updatedAt, ...invalidCorrection } = correction();
  await page.route("**/api/picking/corrections", route => route.fulfill({ json: [invalidCorrection] }));
  await page.goto(path);
  await expect(page.getByRole("alert")).toContainText("Pick corrections could not be loaded.");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Yes", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Record corrective pick" })).toHaveCount(0);
});

test("read-only users cannot answer or make corrective picks", async ({ page }) => {
  await page.route("**/api/picking/corrections", route => route.fulfill({ json: [correction()] }));
  await page.goto(`${path}?readonly=1`);
  await expect(page.getByRole("region", { name: "Pick corrections" })).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
});
