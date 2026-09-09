import { test, expect, type Page } from "playwright/test";
import { resolve } from "node:path";
import { NO_PROGRAM_CHARGES } from "../../shared/shipping/configuration";

async function setup(page: Page, mode = "") {
  const state = {
    writes: [] as Array<{ path: string; body: any }>,
    errors: [] as string[],
    fail: false,
  };
  const packaging = {
    suites: [
      { id: 1, name: "Default cartons", revision: 1, boxIds: [1] },
      { id: 2, name: "Small mailers", revision: 1, boxIds: [2] },
    ],
    assignments: [
      { channel: "dropship", warehouseId: null, suiteId: 1, revision: 1 },
    ],
    boxes: [
      { id: 1, code: "BOX", name: "Cardboard box", isActive: true },
      { id: 2, code: "MAILER", name: "Padded mailer", isActive: true },
    ],
    warehouses: [
      { id: 1, name: "Main" },
      { id: 2, name: "West" },
    ],
  };
  const data = {
    packaging,
    programs: [
      { id: 1, name: "Vendor pricing" },
      { id: 2, name: "Priority pricing" },
    ],
    assignments: [{ warehouseId: null, rateBookId: 1 }],
    serviceLevels: [
      { id: 1, name: "Standard" },
      { id: 2, name: "Expedited" },
    ],
    selectedService: { id: 1, revision: 1 },
    configuredChannelId: null,
  };
  let charges = { revision: 0, charges: NO_PROGRAM_CHARGES };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: path.endsWith("/charges")
          ? charges
          : path.endsWith("/packaging")
            ? packaging
            : data,
      });
    }
    const body = route.request().postDataJSON();
    state.writes.push({ path, body });
    if (state.fail)
      return route.fulfill({
        status: 503,
        json: { error: { message: "Please retry this request." } },
      });
    if (path.endsWith("/service"))
      data.selectedService = {
        id: body.serviceLevelId,
        revision: body.expectedRevision + 1,
      };
    if (path.endsWith("/packaging"))
      packaging.assignments.push({
        channel: body.channel,
        warehouseId: body.warehouseId,
        suiteId: body.suiteId,
        revision: body.expectedRevision + 1,
      });
    if (path.endsWith("/charges"))
      charges = { charges: body.charges, revision: body.expectedRevision + 1 };
    if (path.endsWith("/box-suites"))
      Object.assign(packaging.suites[0], body, {
        revision: body.expectedRevision + 1,
      });
    return route.fulfill({ json: {} });
  });
  await page.route("**/__shared-shipping-test*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><main id="root" style="max-width:1100px;margin:20px auto;padding:12px"></main><script type="module" src="/@fs/${resolve("test/browser/fixtures/shared-shipping-configuration-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`,
    }),
  );
  await page.goto(`/__shared-shipping-test?mode=${mode}`);
  return state;
}
test("selects shared program, warehouse suite, and service without legacy rate editors", async ({
  page,
}, info) => {
  const state = await setup(page);
  await page.getByLabel("Dropship fulfillment service").selectOption("2");
  await page.getByRole("button", { name: "Save service level" }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  expect(state.writes[0].body).toMatchObject({
    channel: "dropship",
    serviceLevelId: 2,
    expectedRevision: 1,
  });
  await page.getByLabel("Configuration scope").selectOption("2");
  await page.getByLabel("Dropship packaging suite").selectOption("2");
  await page.getByRole("button", { name: "Save suite assignment" }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].body).toMatchObject({
    channel: "dropship",
    warehouseId: 2,
    suiteId: 2,
    expectedRevision: 0,
  });
  await expect(
    page.getByText("Create rate table", { exact: true }),
  ).toHaveCount(0);
  expect(state.errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("shared-shipping.png"),
    fullPage: true,
  });
});
test("edits suite membership in a bounded dialog and shows affected assignments", async ({
  page,
}) => {
  const state = await setup(page, "suites");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toContainText(
    "Saving affects 1 channel/warehouse assignments",
  );
  await page.getByRole("checkbox", { name: "Padded mailer · MAILER" }).check();
  await page.getByRole("button", { name: "Save suite", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes[0].body.boxIds).toEqual([1, 2]);
  expect(state.errors).toEqual([]);
});
test("saves percent plus flat charges with a stable retry command", async ({
  page,
}) => {
  const state = await setup(page, "charges");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("group", { name: "markup", exact: true })
    .getByLabel("Percent")
    .fill("1.25");
  await page
    .getByRole("group", { name: "markup", exact: true })
    .getByLabel("Flat charge ($)")
    .fill("0.50");
  state.fail = true;
  await page.getByRole("button", { name: "Save charge rules" }).click();
  await expect(page.getByRole("alert")).toContainText("retry");
  state.fail = false;
  await page.getByRole("button", { name: "Save charge rules" }).click();
  await expect(
    page.getByRole("button", { name: "Edit", exact: true }),
  ).toBeVisible();
  expect(state.writes[0].body.commandId).toBe(state.writes[1].body.commandId);
  expect(state.writes[1].body.charges.markup).toMatchObject({
    bps: 125,
    fixedCents: 50,
  });
  expect(state.errors).toEqual([]);
});
