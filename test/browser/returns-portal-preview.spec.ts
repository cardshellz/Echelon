import { expect, test, type Page } from "@playwright/test";
import {
  installReturnPreviewFixtures,
  PREVIEW_API,
} from "./returns-preview-fixtures";
import {
  CUSTOMER_RETURN_PORTAL_PATH as PORTAL_PATH,
  CUSTOMER_RETURN_PORTAL_ACCESS_PATH as ACCESS_PATH,
  CUSTOMER_RETURN_PORTAL_LEGACY_PATH as LEGACY_PATH,
} from "../../shared/returns/customer-return-portal-paths";

async function expectStandalone(page: Page) {
  await expect(page).toHaveTitle(/Card Shellz/i);
  await expect(page.getByText("Echelon", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            returnPreviewPwaRegistrations: string[];
          }
        ).returnPreviewPwaRegistrations,
    ),
  ).toEqual([]);
}

async function showTestingControls(page: Page) {
  const selector = page.getByLabel("Sample order", { exact: true });
  if (!(await selector.isVisible())) {
    await page.getByText("Testing controls", { exact: true }).click();
  }
  await expect(selector).toBeVisible();
}

async function signIn(page: Page) {
  await page
    .getByLabel("Admin username", { exact: true })
    .fill("fixture-owner");
  await page
    .getByLabel("Password", { exact: true })
    .fill("fictional-test-password");
  await page
    .getByRole("button", { name: "Sign in to test", exact: true })
    .click();
}

test("split shipments can be reviewed in two boxes without live effects", async ({
  page,
}, testInfo) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto(PORTAL_PATH);
  await expect(page.getByTestId("preview-canvas")).toBeVisible();
  await expectStandalone(page);
  await expect(page.getByText("CARD SHELLZ", { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("Sample order", { exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByTestId("preview-canvas").getByText("Preview", { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("standalone-portal.png"),
    fullPage: true,
  });
  await page
    .getByLabel("Order number", { exact: true })
    .fill("  # TEST-1001  ");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  const sleeves = page.getByTestId("preview-line-sample-line-1");
  const storage = page.getByTestId("preview-line-sample-line-3");
  await sleeves.getByRole("spinbutton").fill("3");
  await storage.getByRole("spinbutton").fill("1");
  await page.screenshot({
    path: testInfo.outputPath("item-selection.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add another box", exact: true })
    .click();
  await page
    .getByLabel(
      "Quantity of item 1: Sample collector sleeves (100 count · Clear) in box 1",
      { exact: true },
    )
    .fill("1");
  await page
    .getByLabel(
      "Quantity of item 1: Sample collector sleeves (100 count · Clear) in box 2",
      { exact: true },
    )
    .fill("2");
  await page
    .getByRole("button", { name: "Review return", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Back to packing", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Review your return", exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Get return labels", exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .getByTestId("preview-canvas")
      .getByText(/Preview only|Sample orders only/),
  ).toHaveCount(0);
  const reviews = fixture.previewRequests.filter(
    (request) => request.path === `${PREVIEW_API}/review`,
  );
  expect(reviews).toHaveLength(1);
  expect(reviews[0].body).toMatchObject({
    selections: [
      { lineId: "sample-line-1", quantity: 3, reasonCode: null },
      { lineId: "sample-line-3", quantity: 1, reasonCode: null },
    ],
    parcels: [
      {
        items: [
          { lineId: "sample-line-1", quantity: 1 },
          { lineId: "sample-line-3", quantity: 1 },
        ],
      },
      { items: [{ lineId: "sample-line-1", quantity: 2 }] },
    ],
  });
  await page.screenshot({
    path: testInfo.outputPath("return-review.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Back to packing", exact: true })
    .click();
  await expect(
    page.getByLabel(
      "Quantity of item 1: Sample collector sleeves (100 count · Clear) in box 2",
      { exact: true },
    ),
  ).toHaveValue("2");
  await page
    .getByRole("button", { name: "Back to items", exact: true })
    .click();
  await expect(sleeves.getByRole("spinbutton")).toHaveValue("3");
  await sleeves.getByRole("spinbutton").fill("2");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  await expect(page.getByTestId("preview-box-2")).toHaveCount(0);
  await expect(
    page.getByLabel(
      "Quantity of item 1: Sample collector sleeves (100 count · Clear) in box 1",
      { exact: true },
    ),
  ).toHaveValue("2");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(fixture.failures).toEqual([]);
});

test("changing scenario clears selections and shipped items cannot be returned", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto(PORTAL_PATH);
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page
    .getByTestId("preview-line-sample-line-1")
    .getByRole("spinbutton")
    .fill("2");
  await showTestingControls(page);
  await page
    .getByLabel("Sample order", { exact: true })
    .selectOption("in_transit");
  await expect(page.getByLabel("Order number", { exact: true })).toHaveValue(
    "TEST-1003",
  );
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await expect(
    page.getByText("These items have not been delivered yet.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue to packing", exact: true }),
  ).toBeDisabled();
  await showTestingControls(page);
  await page
    .getByLabel("Sample order", { exact: true })
    .selectOption("partially_delivered");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  const quantity = page
    .getByTestId("preview-line-sample-line-1")
    .getByRole("spinbutton");
  await expect(quantity).toHaveValue("0");
  await expect(quantity).toHaveAttribute("max", "1");
  expect(fixture.failures).toEqual([]);
});

test("a server denial clears the customer canvas and allows a fresh retry", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  let denied = true;
  await page.route(`**${PREVIEW_API}`, (route) =>
    route.fulfill(
      denied
        ? {
            status: 403,
            json: { error: { message: "Administrator access is required." } },
          }
        : { json: fixture.service.getState() },
    ),
  );
  await page.goto(PORTAL_PATH);
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
  await expect(page.getByText(/Admin access is required/)).toBeVisible();
  denied = false;
  await page.getByRole("button", { name: /try again|retry/i }).click();
  await expect(page.getByTestId("preview-canvas")).toBeVisible();
  await page.route(`**${PREVIEW_API}/order`, (route) =>
    route.fulfill({
      status: 403,
      json: { error: { message: "Administrator access is required." } },
    }),
  );
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
  await expect(page.getByText(/Admin access is required/)).toBeVisible();
  expect(fixture.failures).toEqual([]);
});

test("non-admin staff cannot render the preview or read its API", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page, "lead");
  await page.goto(PORTAL_PATH);
  await expect(page).toHaveURL(new RegExp(PORTAL_PATH + "$"));
  await expect(
    page.getByRole("region", { name: "Portal access status" }),
  ).toBeVisible();
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
  await expectStandalone(page);
  expect(fixture.previewRequests).toEqual([
    { path: PREVIEW_API, method: "GET", body: null },
  ]);
  expect(fixture.failures).toEqual([]);
});

test("a malformed response cannot produce a review or stale sample order", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.route(`**${PREVIEW_API}/order`, (route) =>
    route.fulfill({
      json: {
        ...fixture.service.lookup({
          scenarioId: "split_delivered",
          orderReference: "TEST-1001",
        }),
        scenarioId: "partially_delivered",
      },
    }),
  );
  await page.goto(PORTAL_PATH);
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await expect(
    page.getByText(/sample order response could not be verified/i),
  ).toBeVisible();
  await expect(page.getByTestId("preview-line-sample-line-1")).toHaveCount(0);
  expect(
    fixture.previewRequests.filter(
      (request) => request.path === `${PREVIEW_API}/review`,
    ),
  ).toEqual([]);
  expect(fixture.failures).toEqual([]);
});

test("an old order response cannot replace a newly selected scenario", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  let release!: () => void;
  let received!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route(`**${PREVIEW_API}/order`, async (route) => {
    const body = route.request().postDataJSON();
    if (body.scenarioId === "split_delivered") {
      received();
      await pending;
    }
    await route.fulfill({ json: fixture.service.lookup(body) });
  });
  await page.goto(PORTAL_PATH);
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await requested;
  await showTestingControls(page);
  await page
    .getByLabel("Sample order", { exact: true })
    .selectOption("in_transit");
  release();
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await expect(
    page.getByText("Order #TEST-1003", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Order #TEST-1001", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Continue to packing", exact: true }),
  ).toBeDisabled();
  expect(fixture.failures).toEqual([]);
});

test("same-name purchased lines remain distinguishable by sight and accessible name", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto(PORTAL_PATH);
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page
    .getByLabel(
      "Return quantity for item 1: Sample collector sleeves (100 count · Clear)",
      { exact: true },
    )
    .fill("2");
  await page
    .getByLabel(
      "Return quantity for item 2: Sample collector sleeves (100 count · Clear)",
      { exact: true },
    )
    .fill("1");
  await page
    .getByLabel(
      "Reason for returning item 2: Sample collector sleeves (100 count · Clear) (optional)",
      { exact: true },
    )
    .selectOption("ordered_by_mistake");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  await expect(
    page.getByLabel(
      "Quantity of item 1: Sample collector sleeves (100 count · Clear) in box 1",
      { exact: true },
    ),
  ).toHaveValue("2");
  await expect(
    page.getByLabel(
      "Quantity of item 2: Sample collector sleeves (100 count · Clear) in box 1",
      { exact: true },
    ),
  ).toHaveValue("1");
  await page
    .getByRole("button", { name: "Review return", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review your return", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Item 1 · 100 count · Clear", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Item 2 · 100 count · Clear", { exact: true }),
  ).toBeVisible();
  const reviews = fixture.previewRequests.filter(
    (request) => request.path === `${PREVIEW_API}/review`,
  );
  expect(reviews[0].body).toMatchObject({
    selections: [
      { lineId: "sample-line-1", quantity: 2, reasonCode: null },
      {
        lineId: "sample-line-2",
        quantity: 1,
        reasonCode: "ordered_by_mistake",
      },
    ],
  });
  expect(fixture.failures).toEqual([]);
});

test("the legacy shortcut redirects to the standalone customer portal", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto(LEGACY_PATH);
  await expect(page).toHaveURL(new RegExp(PORTAL_PATH + "$"));
  await expect(page.getByTestId("preview-canvas")).toBeVisible();
  await expectStandalone(page);
  expect(fixture.failures).toEqual([]);
});

test("an anonymous visitor sees only the private access gate", async ({
  page,
}, testInfo) => {
  const fixture = await installReturnPreviewFixtures(page, { role: null });
  await page.goto(PORTAL_PATH);
  await expect(page).toHaveURL(new RegExp(ACCESS_PATH + "$"));
  await expect(
    page.getByRole("heading", { name: "Private testing access", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Admin username", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
  await expect(page.getByLabel("Sample order", { exact: true })).toHaveCount(0);
  await expectStandalone(page);
  await page.screenshot({
    path: testInfo.outputPath("private-access-gate.png"),
    fullPage: true,
  });
  expect(fixture.previewRequests).toEqual([]);
  expect(fixture.failures).toEqual([]);
});

test("admin sign-in waits for fresh authorization then redirects only to the fixed portal root", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page, {
    role: null,
    loginRole: "admin",
  });
  let release!: () => void;
  let received!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    received = resolve;
  });
  const stateRequests: string[] = [];
  await page.route(`**${PREVIEW_API}`, async (route) => {
    stateRequests.push(route.request().method());
    received();
    await pending;
    await route.fulfill({ json: fixture.service.getState() });
  });
  await page.goto(`${ACCESS_PATH}?returnTo=/picking&redirect=/returns/cases`);
  await signIn(page);
  await requested;
  await expect(page).toHaveURL(new RegExp(ACCESS_PATH + "\\?"));
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  release();
  await expect(page).toHaveURL(new RegExp(PORTAL_PATH + "$"));
  await expect(page.getByTestId("preview-canvas")).toBeVisible();
  await expectStandalone(page);
  expect(stateRequests.length).toBeGreaterThanOrEqual(2);
  expect(
    fixture.authRequests.filter(
      (request) => request.path === "/api/auth/login",
    ),
  ).toHaveLength(1);
  expect(
    fixture.authRequests.filter((request) => request.path === "/api/auth/me")
      .length,
  ).toBeGreaterThanOrEqual(3);
  expect(fixture.failures).toEqual([]);
});

test("signing in as non-admin staff stays at the access gate", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page, {
    role: null,
    loginRole: "lead",
  });
  await page.goto(ACCESS_PATH);
  await signIn(page);
  await expect(page.getByRole("alert")).toContainText(
    "Admin access is required",
  );
  await expect(page).toHaveURL(new RegExp(ACCESS_PATH + "$"));
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Retry current account", exact: true }),
  ).toBeVisible();
  await expectStandalone(page);
  expect(fixture.previewRequests).toEqual([
    { path: PREVIEW_API, method: "GET", body: null },
  ]);
  expect(fixture.failures).toEqual([]);
});

for (const failure of ["malformed", "unavailable", "network"] as const) {
  test(`${failure} authorization response cannot open the portal after successful login`, async ({
    page,
  }) => {
    const fixture = await installReturnPreviewFixtures(page, {
      role: null,
      loginRole: "admin",
    });
    let rejectState = true;
    await page.route(`**${PREVIEW_API}`, (route) => {
      if (!rejectState)
        return route.fulfill({ json: fixture.service.getState() });
      if (failure === "network") return route.abort("failed");
      if (failure === "unavailable")
        return route.fulfill({
          status: 503,
          json: {
            error: { message: "Private testing is temporarily unavailable." },
          },
        });
      return route.fulfill({
        json: { ...fixture.service.getState(), customerAccess: "enabled" },
      });
    });
    await page.goto(ACCESS_PATH);
    await signIn(page);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(ACCESS_PATH + "$"));
    await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    await expectStandalone(page);
    rejectState = false;
    await page
      .getByRole("button", { name: "Retry current account", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(PORTAL_PATH + "$"));
    await expect(page.getByTestId("preview-canvas")).toBeVisible();
    expect(
      fixture.authRequests.filter(
        (request) => request.path === "/api/auth/login",
      ),
    ).toHaveLength(1);
    expect(fixture.failures).toEqual([]);
  });
}

test("retrying the current account uses fresh authority instead of its cached role", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page, { role: "lead" });
  await page.goto(ACCESS_PATH);
  await expect(page.getByRole("alert")).toContainText(
    "Admin access is required",
  );
  fixture.setRole("admin");
  await page
    .getByRole("button", { name: "Retry current account", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(PORTAL_PATH + "$"));
  await expect(page.getByTestId("preview-canvas")).toBeVisible();
  expect(
    fixture.authRequests.filter(
      (request) => request.path === "/api/auth/login",
    ),
  ).toHaveLength(0);
  expect(fixture.failures).toEqual([]);
});

test("a rejected sign-in clears the password and never starts order access", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page, {
    role: null,
    loginRole: null,
  });
  await page.goto(ACCESS_PATH);
  await signIn(page);
  await expect(page.getByRole("alert")).toContainText("Sign-in failed");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(ACCESS_PATH + "$"));
  expect(fixture.previewRequests).toEqual([]);
  fixture.setLoginRole("admin");
  await signIn(page);
  await expect(page).toHaveURL(new RegExp(PORTAL_PATH + "$"));
  await expect(page.getByTestId("preview-canvas")).toBeVisible();
  expect(fixture.failures).toEqual([]);
});

for (const routeCase of [
  { path: "/RETURN-PORTAL/ACCESS", role: null, accessGate: true },
  { path: "/return-portal/", role: "admin", accessGate: false },
] as const) {
  test(`${routeCase.path} retains the standalone shell and suppresses service worker registration`, async ({
    page,
  }) => {
    const fixture = await installReturnPreviewFixtures(page, {
      role: routeCase.role,
    });
    await page.goto(routeCase.path);
    if (routeCase.accessGate) {
      await expect(
        page.getByRole("heading", {
          name: "Private testing access",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
      expect(fixture.previewRequests).toEqual([]);
    } else {
      await expect(page.getByTestId("preview-canvas")).toBeVisible();
    }
    await expectStandalone(page);
    expect(fixture.failures).toEqual([]);
  });
}
