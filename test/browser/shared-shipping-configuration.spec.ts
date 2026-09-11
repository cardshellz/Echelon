import { test, expect, type Page } from "playwright/test";
import { resolve } from "node:path";
import type { ChannelPackagingPolicy } from "../../shared/shipping/packaging-policy";
import {
  NO_PROGRAM_CHARGES,
  type PackagingConfiguration,
  type DropshipSharedShippingConfig,
} from "../../shared/shipping/configuration";

async function setup(page: Page, mode = "") {
  const state = {
    writes: [] as Array<{ path: string; body: any }>,
    errors: [] as string[],
    fail: false,
  };
  const packaging: PackagingConfiguration = {
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
  const data: DropshipSharedShippingConfig = {
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
  if (mode === "warehouse100")
    packaging.warehouses = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `Warehouse ${String(i + 1).padStart(3, "0")}`,
    }));
  const availability = new Map<number, number[]>([
    [1, [1, 2]],
    [2, [1, 2]],
  ]);
  const warehouseRevisions = new Map<number, number>();
  let catalogBoxes = [
    {
      id: 1,
      code: "WHITE",
      name: "Plain shipper",
      kind: "box",
      lengthMm: 200,
      widthMm: 150,
      heightMm: 100,
      outerLengthMm: null,
      outerWidthMm: null,
      outerHeightMm: null,
      tareWeightGrams: 20,
      maxWeightGrams: null,
      costCents: 25,
      fillFactorBps: 10000,
      isActive: true,
      branding: "unclassified",
      availabilityReviewed: false,
      configurationRevision: 1,
      warehouseIds: [1],
    },
  ];
  let policies: ChannelPackagingPolicy[] = [
    {
      channelId: 11,
      revision: 1,
      defaultSuiteId: 1,
      requirement: "any",
      overrides: [],
    },
    {
      channelId: 12,
      revision: 1,
      defaultSuiteId: 2,
      requirement: "any",
      overrides: [],
    },
  ];
  const policyOverview = () => ({
    channels: [
      {
        id: 11,
        name: "Dropship OMS",
        provider: "manual",
        status: "active",
        legacyProfile: "dropship",
      },
      {
        id: 12,
        name: "Main Shopify",
        provider: "shopify",
        status: "active",
        legacyProfile: "shopify",
      },
    ],
    policies,
    warehouses: packaging.warehouses.map((w) => ({
      ...w,
      packagingRevision: warehouseRevisions.get(w.id) ?? 0,
    })),
    boxes: packaging.boxes.map((b) => ({
      ...b,
      branding: b.id === 1 ? "unbranded" : "branded",
      availabilityReviewed: true,
      warehouseIds: availability.get(b.id) ?? [],
    })),
    suites: packaging.suites.map((s) => ({
      ...s,
      archived: s.archived ?? false,
    })),
    pricing: [],
    warehouseAssignments: [],
  });
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
        json: path.endsWith("/config")
          ? {
              boxes: catalogBoxes,
              warehouses: packaging.warehouses.map((w) => ({
                ...w,
                code: w.name.toUpperCase(),
              })),
            }
          : path.endsWith("/packaging-policies")
            ? policyOverview()
            : path.endsWith("/charges")
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
    if (path.endsWith("/catalog-boxes/branding")) {
      catalogBoxes = catalogBoxes.map((b) =>
        body.boxes.some((item: { id: number }) => item.id === b.id)
          ? {
              ...b,
              branding: body.branding,
              configurationRevision: b.configurationRevision + 1,
            }
          : b,
      );
      return route.fulfill({
        json: { changed: body.boxes.length, skipped: 0 },
      });
    }
    if (path.endsWith("/warehouse-packaging/availability")) {
      for (const b of body.boxIds) {
        const ids = new Set(availability.get(b) ?? []);
        for (const w of body.warehouses) {
          if (body.available) ids.add(w.id);
          else ids.delete(w.id);
        }
        availability.set(b, [...ids]);
      }
      for (const w of body.warehouses)
        warehouseRevisions.set(w.id, w.revision + 1);
      return route.fulfill({
        json: {
          changed: body.boxIds.length * body.warehouses.length,
          skipped: 0,
        },
      });
    }
    if (path.endsWith("/warehouse-packaging/suites")) {
      const policy = policies.find((p) => p.channelId === body.channelId)!;
      let changed = 0;
      for (const id of body.warehouseIds) {
        if (
          policy.overrides.some((o) => o.warehouseId === id) &&
          !body.replaceExisting
        )
          continue;
        policy.overrides = policy.overrides.filter((o) => o.warehouseId !== id);
        if (body.suiteId)
          policy.overrides.push({ warehouseId: id, suiteId: body.suiteId });
        changed++;
      }
      policy.revision++;
      return route.fulfill({
        json: { changed, skipped: body.warehouseIds.length - changed },
      });
    }
    if (path.endsWith("/catalog-boxes")) {
      catalogBoxes = catalogBoxes.map((b) =>
        b.id === body.id
          ? {
              ...b,
              ...body,
              configurationRevision: body.expectedRevision + 1,
              availabilityReviewed: true,
            }
          : b,
      );
      return route.fulfill({ json: { box: catalogBoxes[0] } });
    }
    if (path.endsWith("/service"))
      data.selectedService = {
        id: body.serviceLevelId,
        revision: body.expectedRevision + 1,
      };
    if (path.endsWith("/packaging-policies")) {
      policies = policies.filter((p) => p.channelId !== body.channelId);
      policies.push({
        channelId: body.channelId,
        revision: body.expectedRevision + 1,
        defaultSuiteId: body.defaultSuiteId,
        requirement: body.requirement,
        overrides: body.overrides,
      });
    }
    if (path.endsWith("/program")) {
      data.assignments = data.assignments.filter(
        (a) => a.warehouseId !== body.warehouseId,
      );
      data.assignments.push({
        warehouseId: body.warehouseId,
        rateBookId: body.rateBookId,
      });
    }
    if (path.endsWith("/program/reset"))
      data.assignments = data.assignments.filter(
        (a) => a.warehouseId !== body.warehouseId,
      );
    if (path.endsWith("/packaging/reset") || path.endsWith("/assignment/reset"))
      packaging.assignments = packaging.assignments.filter(
        (a) => a.channel !== body.channel || a.warehouseId !== body.warehouseId,
      );
    if (path.endsWith("/packaging") || path.endsWith("/assignment")) {
      packaging.assignments = packaging.assignments.filter(
        (a) => a.channel !== body.channel || a.warehouseId !== body.warehouseId,
      );
      packaging.assignments.push({
        channel: body.channel,
        warehouseId: body.warehouseId,
        suiteId: body.suiteId,
        revision: body.expectedRevision + 1,
      });
    }
    if (path.endsWith("/charges"))
      charges = { charges: body.charges, revision: body.expectedRevision + 1 };
    if (path.endsWith("/box-suites")) {
      const current = packaging.suites.find((s) => s.id === body.id);
      if (current)
        Object.assign(current, body, { revision: body.expectedRevision + 1 });
      else
        packaging.suites.push({
          ...body,
          id: Math.max(...packaging.suites.map((s) => s.id)) + 1,
          revision: 1,
        });
    }
    if (path.endsWith("/box-suites/status"))
      Object.assign(packaging.suites.find((s) => s.id === body.id)!, {
        archived: body.archived,
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
test("saves program changes, reloads them, and preserves another warehouse", async ({
  page,
}) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Edit West pricing program" }).click();
  await expect(page.getByLabel("Dropship pricing program")).toHaveValue(
    "inherit",
  );
  await page.getByLabel("Dropship pricing program").selectOption("2");
  await page.getByRole("button", { name: "Save program", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const west = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Edit West packaging", exact: true }),
  });
  const main = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Edit Main packaging", exact: true }),
  });
  await expect(west).toContainText("Priority pricing");
  await expect(main).toContainText("Vendor pricing");
  await page.reload();
  await expect(west).toContainText("Priority pricing");
  await page.getByRole("button", { name: "Edit West pricing program" }).click();
  await expect(page.getByLabel("Dropship pricing program")).toHaveValue("2");
  await expect(
    page.getByRole("button", { name: "Save program", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Dropship pricing program").selectOption("inherit");
  await page.getByRole("button", { name: "Save program", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(west).toContainText("Vendor pricing");
  expect(state.writes.map((w) => w.path)).toEqual([
    "/api/dropship/admin/shipping/shared/program",
    "/api/dropship/admin/shipping/shared/program/reset",
  ]);
});

test("keeps failed program edits and retries the same command", async ({
  page,
}) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Edit West pricing program" }).click();
  await page.getByLabel("Dropship pricing program").selectOption("2");
  state.fail = true;
  await page.getByRole("button", { name: "Save program", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Please retry",
  );
  await expect(page.getByLabel("Dropship pricing program")).toHaveValue("2");
  state.fail = false;
  await page.getByRole("button", { name: "Save program", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes).toHaveLength(2);
  expect(state.writes[0].body.commandId).toBe(state.writes[1].body.commandId);
});

test("keeps concrete channels separate and blocks graphic boxes for white-label configuration", async ({
  page,
}) => {
  const state = await setup(page, "assignments");
  await page.getByRole("button", { name: "Edit default" }).click();
  await page.getByLabel("Branding requirement").selectOption("unbranded");
  await page.getByRole("button", { name: "Save packaging" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Edit default" }).click();
  await page.getByLabel("Assigned box suite").selectOption("2");
  await expect(page.getByRole("dialog")).toContainText(
    "branded or unclassified",
  );
  await expect(
    page.getByRole("button", { name: "Save packaging" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByLabel("Fulfillment configuration").selectOption("12");
  await expect(
    page.getByRole("row").filter({
      has: page.getByRole("link", { name: "Edit West packaging" }),
    }),
  ).toContainText("Small mailers");
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body.channelId).toBe(11);
  expect(state.errors).toEqual([]);
});

test("failed packaging saves retain the editor and reuse the command ID", async ({
  page,
}) => {
  const state = await setup(page, "assignments");
  await page.getByRole("button", { name: "Edit default" }).click();
  await page.getByLabel("Assigned box suite").selectOption("2");
  state.fail = true;
  await page.getByRole("button", { name: "Save packaging" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "retry",
  );
  state.fail = false;
  await page.getByRole("button", { name: "Save packaging" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes[0].body.commandId).toBe(state.writes[1].body.commandId);
});

test("supports duplicate, archive and restore without an assignment form in suites", async ({
  page,
}, info) => {
  await setup(page, "suites");
  await expect(
    page.getByRole("button", { name: "Save assignment" }),
  ).toHaveCount(0);
  const mailer = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Small mailers", exact: true }),
  });
  await mailer.getByRole("button", { name: "Duplicate" }).click();
  await expect(page.getByLabel("Suite name")).toHaveValue("Small mailers copy");
  await page.getByRole("button", { name: "Save suite" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const copy = page.getByRole("article").filter({
    has: page.getByRole("heading", {
      name: "Small mailers copy",
      exact: true,
    }),
  });
  await copy.getByRole("button", { name: "Archive", exact: true }).click();
  await page
    .getByRole("button", { name: "Archive suite", exact: true })
    .click();
  await expect(copy).toHaveCount(0);
  await page.getByLabel("Show archived suites").check();
  await copy.getByRole("button", { name: "Restore", exact: true }).click();
  await page
    .getByRole("button", { name: "Restore suite", exact: true })
    .click();
  await page.getByLabel("Show archived suites").uncheck();
  await expect(copy).toBeVisible();
  await page.screenshot({
    path: info.outputPath("box-suites.png"),
    fullPage: true,
  });
});

test("edits assignment from its warehouse and resets to the displayed default", async ({
  page,
}, info) => {
  const state = await setup(page, "warehouse");
  const west = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "West", exact: true }) });
  await west.getByRole("button", { name: "Assign suite", exact: true }).click();
  await page
    .getByLabel("Fulfillment program", { exact: true })
    .selectOption("11");
  await page.getByLabel("Suite", { exact: true }).selectOption("2");
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(west).toContainText("Small mailers");
  await expect(west).toContainText("Warehouse assignment");
  await west.getByRole("button", { name: "Assign suite", exact: true }).click();
  await page
    .getByLabel("Fulfillment program", { exact: true })
    .selectOption("11");
  await page.getByLabel("Replace existing warehouse assignments").check();
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(west).toContainText("Default cartons");
  expect(state.writes[0].body.replaceExisting).toBe(false);
  expect(state.writes[1].body).toMatchObject({
    warehouseIds: [2],
    suiteId: null,
    replaceExisting: true,
  });
  await page.screenshot({
    path: info.outputPath("packaging-assignments.png"),
    fullPage: true,
  });
});

test("selects warehouse suite and service without legacy rate editors", async ({
  page,
}, info) => {
  const state = await setup(page);
  await page.getByLabel("Dropship fulfillment service").selectOption("2");
  await page.getByRole("button", { name: "Save service level" }).click();
  await expect(page.getByRole("status")).toContainText("saved");
  expect(state.writes[0].body).toMatchObject({
    channel: "dropship",
    serviceLevelId: 2,
    expectedRevision: 1,
  });
  await expect(
    page.getByRole("link", { name: "Edit West packaging" }),
  ).toHaveAttribute("href", "/warehouse/packaging?channelId=11");
  expect(state.writes).toHaveLength(1);
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
  await page.getByRole("checkbox", { name: /MAILER · Padded mailer/ }).check();
  await page.getByRole("button", { name: "Save suite", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes[0].body.boxIds).toEqual([1, 2]);
  expect(state.errors).toEqual([]);
});
test("catalog edits never submit warehouse availability", async ({
  page,
}, info) => {
  const state = await setup(page, "catalog");
  await expect(
    page.getByRole("columnheader", { name: "Warehouses", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Edit WHITE box" }).click();
  await page.getByLabel("Packaging branding").selectOption("unbranded");
  await expect(
    page.getByText("Stocked warehouses", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes[0]).toMatchObject({
    path: "/api/shipping/admin/catalog-boxes",
    body: {
      id: 1,
      branding: "unbranded",
      expectedRevision: 1,
      lengthMm: 200,
      widthMm: 150,
      heightMm: 100,
    },
  });
  expect(state.writes[0].body).not.toHaveProperty("warehouseIds");
  await expect(page.getByText("Availability needs review")).toHaveCount(0);
  await expect(
    page
      .getByRole("table")
      .getByText("White label / unbranded", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit WHITE box" }).click();
  await expect(page.getByLabel("Packaging branding")).toHaveValue("unbranded");
  await expect(page.getByRole("dialog").getByRole("checkbox")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("box-catalog-review.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(state.errors).toEqual([]);
});

test("box measurements round trip in inches while inside, outside and fill stay separate", async ({ page }, info) => {
  const state = await setup(page, "catalog");
  await page.getByRole("button", { name: "Edit WHITE box" }).click();
  await page.getByLabel("Inner length (in)", { exact: true }).fill("8");
  await page.getByLabel("Inner width (in)", { exact: true }).fill("6");
  await page.getByLabel("Inner height (in)", { exact: true }).fill("4.001");
  await page.getByLabel("Outer length", { exact: true }).fill("8.25");
  await page.getByLabel("Outer width", { exact: true }).fill("6.25");
  await page.getByLabel("Outer height", { exact: true }).fill("4.25");
  await page.getByLabel("Fill factor (%)", { exact: true }).fill("85");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes[0].body).toMatchObject({ lengthMm: 203.2, widthMm: 152.4, heightMm: 101.6254,
    outerLengthMm: 209.55, outerWidthMm: 158.75, outerHeightMm: 107.95, fillFactorBps: 8500 });
  await expect(page.getByText("8 × 6 × 4.001 in", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit WHITE box" }).click();
  await expect(page.getByLabel("Inner length (in)", { exact: true })).toHaveValue("8");
  await expect(page.getByLabel("Inner height (in)", { exact: true })).toHaveValue("4.001");
  await expect(page.getByLabel("Outer length", { exact: true })).toHaveValue("8.25");
  await expect(page.getByLabel("Fill factor (%)", { exact: true })).toHaveValue("85");
  await page.screenshot({ path: info.outputPath("precise-box-dimensions.png"), fullPage: true, animations: "disabled" });
  await page.getByLabel("Name", { exact: true }).fill("Renamed without remeasuring");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes[1].body).toMatchObject({ lengthMm: 203.2, widthMm: 152.4, heightMm: 101.6254,
    outerLengthMm: 209.55, outerWidthMm: 158.75, outerHeightMm: 107.95, fillFactorBps: 8500, expectedRevision: 2 });
  await page.getByRole("button", { name: "Edit WHITE box" }).click();
  await page.getByLabel("Outer length", { exact: true }).fill("7.9");
  await page.getByRole("button", { name: "Save Changes" }).click();
  // Match the visible description, not Radix's longer live-region announcement.
  await expect(page.getByText("Enter all three outer dimensions, each at least as large as its inner dimension.", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.errors).toEqual([]);
});

test("bulk branding reviews selected catalog items and refreshes the table", async ({
  page,
}) => {
  const state = await setup(page, "catalog");
  await page
    .getByLabel("Filter branding", { exact: true })
    .selectOption("unclassified");
  await page
    .getByRole("button", { name: "Select all 1 matching", exact: true })
    .click();
  await page.getByLabel("Set selected branding").selectOption("unbranded");
  await expect(page.getByRole("dialog")).toContainText(
    "Warehouse availability and suite membership will not change",
  );
  await page
    .getByRole("button", { name: "Save branding", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes[0].body).toMatchObject({
    boxes: [{ id: 1, revision: 1 }],
    branding: "unbranded",
  });
  expect(state.writes[0].body).not.toHaveProperty("warehouseIds");
});

test("bulk availability covers 100 warehouses with review, stable retry, and bounded rendering", async ({
  page,
}, info) => {
  const state = await setup(page, "warehouse100");
  await expect(page.getByRole("article")).toHaveCount(25);
  await page
    .getByRole("button", { name: "Select all 100 matching warehouses" })
    .click();
  await page
    .getByRole("button", { name: "Update available packaging" })
    .click();
  await page.getByLabel("Choose from", { exact: true }).selectOption("1");
  await page.getByRole("button", { name: "Select all matching boxes" }).click();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "1 packaging types at 100 warehouses",
  );
  state.fail = true;
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("retry");
  state.fail = false;
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes[0].body.commandId).toBe(state.writes[1].body.commandId);
  expect(state.writes[1].body.warehouses).toHaveLength(100);
  expect(state.writes[1].body).toMatchObject({
    boxIds: [1],
    sourceSuite: { id: 1, revision: 1 },
    available: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(state.errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("warehouse-packaging.png"),
    fullPage: false,
    animations: "disabled",
  });
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
