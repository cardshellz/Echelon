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
import { customerReturnLiveReviewInputSchema } from "../../shared/returns/customer-return-live.contract";
import { MAX_RETURN_FLOW_PARCELS } from "../../shared/returns/customer-return-flow.contract";

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
  const selector = page.getByLabel("Order source", { exact: true });
  if (!(await selector.isVisible())) {
    await page.getByText("Testing controls", { exact: true }).click();
  }
  await expect(selector).toBeVisible();
}

async function useSampleSource(page: Page) {
  await showTestingControls(page);
  await page.getByLabel("Order source", { exact: true }).selectOption("sample");
  await expect(page.getByLabel("Order number", { exact: true })).toHaveValue(
    "TEST-1001",
  );
  await page.getByText("Testing controls", { exact: true }).click();
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

async function expectNoCustomerWeights(page: Page) {
  const canvas = page.getByTestId("preview-canvas");
  await expect(canvas.getByText(/\b(?:weight|lb|lbs|oz|grams)\b/i)).toHaveCount(
    0,
  );
  await expect(canvas.getByLabel(/weight/i)).toHaveCount(0);
}

async function expectPackingLine(
  page: Page,
  lineId: string,
  selected: number,
  packed: number | "Check",
) {
  const row = page.getByTestId(`packing-summary-line-${lineId}`);
  await expect(row.getByRole("cell")).toHaveText([
    String(selected),
    String(packed),
  ]);
}

async function expectPackingSummaryFirst(page: Page) {
  const summary = page.getByTestId("packing-summary");
  await expect(
    summary.getByRole("heading", { name: "Items to return", exact: true }),
  ).toBeVisible();
  await expect(summary.getByRole("columnheader")).toHaveText([
    "Product",
    "To return",
    "In boxes",
  ]);
  expect(
    await summary.evaluate((element) => {
      const firstBox = document.querySelector('[data-testid="preview-box-1"]');
      return (
        firstBox !== null &&
        Boolean(
          element.compareDocumentPosition(firstBox) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ) &&
        element.getBoundingClientRect().bottom <=
          firstBox.getBoundingClientRect().top
      );
    }),
  ).toBe(true);
}

async function openBoxItems(page: Page, boxNumber: number) {
  await page
    .getByRole("button", {
      name: `Add or move items to box ${boxNumber}`,
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: `Add items to Box ${boxNumber}`,
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function transferBoxItems(
  page: Page,
  targetBox: number,
  source: number | "unassigned",
  lineId: string,
  quantity: number,
) {
  const dialog = await openBoxItems(page, targetBox);
  const row = dialog.getByTestId(`packing-source-${source}-${lineId}`);
  await expect(row).toBeVisible();
  await expect(row.getByRole("spinbutton")).toHaveValue("1");
  await row.getByRole("spinbutton").fill(String(quantity));
  await row
    .getByRole("button", {
      name: source === "unassigned" ? "Add to box" : "Move to box",
      exact: true,
    })
    .click();
  await expect(dialog).toHaveCount(0);
}

async function enterCustomBoxDimensions(
  page: Page,
  number: number,
  length = "12",
  width = "10",
  height = "6",
) {
  const box = page.getByTestId(`preview-box-${number}`);
  const change = box.getByRole("button", {
    name: `Change size for box ${number}`,
    exact: true,
  });
  if (await change.isVisible()) await change.click();
  const size = box.getByLabel(`Box size for box ${number}`, { exact: true });
  if (await size.isVisible()) await size.selectOption("custom");
  await box
    .getByLabel(`Length of box ${number} in inches`, { exact: true })
    .fill(length);
  await box
    .getByLabel(`Width of box ${number} in inches`, { exact: true })
    .fill(width);
  await box
    .getByLabel(`Height of box ${number} in inches`, { exact: true })
    .fill(height);
}

/** Existing journeys explicitly supply their actual box size when no unique original fits. */
async function reviewPackedReturn(page: Page) {
  const boxes = page.locator('[data-testid^="preview-box-"]');
  for (let index = 0; index < (await boxes.count()); index += 1) {
    const number = index + 1;
    const size = boxes
      .nth(index)
      .getByLabel(`Box size for box ${number}`, { exact: true });
    const length = boxes
      .nth(index)
      .getByLabel(`Length of box ${number} in inches`, { exact: true });
    if (
      ((await size.isVisible()) && (await size.inputValue()) === "") ||
      ((await length.isVisible()) && (await length.inputValue()) === "")
    ) {
      await enterCustomBoxDimensions(page, number);
    }
  }
  await page
    .getByRole("button", { name: "Review return", exact: true })
    .click();
}

test("split shipments can be reviewed in two boxes without live effects", async ({
  page,
}, testInfo) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto(PORTAL_PATH);
  await useSampleSource(page);
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
    animations: "disabled",
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
    animations: "disabled",
    path: testInfo.outputPath("item-selection.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  const summary = page.getByTestId("packing-summary");
  const totals = page.getByTestId("packing-summary-total");
  await expectPackingSummaryFirst(page);
  await expect(totals).toContainText("4 items to return");
  await expect(totals).toContainText("1 box");
  await expect(
    summary.getByText("All items are in boxes", { exact: true }),
  ).toBeVisible();
  await expectPackingLine(page, "sample-line-1", 3, 3);
  await expectPackingLine(page, "sample-line-3", 1, 1);
  await expect(
    page.getByTestId("preview-box-1").getByText("Black", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId("preview-canvas").getByText(/Option:/),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add another box", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByTestId("preview-box-2").locator('[data-testid^="packing-item-"]'),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Box size for box 1", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByLabel("Box size for box 2", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Review return", exact: true }),
  ).toBeDisabled();
  const dialog = await openBoxItems(page, 2);
  const source = dialog.getByTestId("packing-source-1-sample-line-1");
  await expect(
    source.getByText("From Box 1 · 3 available", { exact: true }),
  ).toBeVisible();
  const sourceQuantity = source.getByRole("spinbutton", {
    name: "Quantity of item 1: Sample collector sleeves (100 count · Clear) to add from box 1",
    exact: true,
  });
  await expect(sourceQuantity).toHaveValue("1");
  await expect(sourceQuantity).toHaveAttribute("max", "3");
  await sourceQuantity.fill("2");
  await source
    .getByRole("button", { name: "Move to box", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Add or move items to box 2",
      exact: true,
    }),
  ).toBeFocused();
  await expectPackingLine(page, "sample-line-1", 3, 3);
  await expectPackingLine(page, "sample-line-3", 1, 1);
  await expect(totals).toContainText("2 boxes");
  await expect(
    page.getByTestId("packing-item-1-sample-line-1").getByRole("spinbutton"),
  ).toHaveValue("1");
  await expect(
    page.getByTestId("packing-item-1-sample-line-3").getByRole("spinbutton"),
  ).toHaveValue("1");
  await expect(
    page.getByTestId("packing-item-2-sample-line-1").getByRole("spinbutton"),
  ).toHaveValue("2");
  await expect(page.getByTestId("packing-item-2-sample-line-3")).toHaveCount(0);
  await expectNoCustomerWeights(page);
  await expect(
    page
      .getByTestId("preview-box-2")
      .getByText("Original box size · 10 × 8 × 4 in", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Change size for box 2", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-contents-summary-first.png"),
    fullPage: true,
  });
  await reviewPackedReturn(page);
  await expect(
    page.getByRole("button", { name: "Back to packing", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Review your return", exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Get return labels", exact: true }),
  ).toBeDisabled();
  await expectNoCustomerWeights(page);
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
    animations: "disabled",
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

test("a single selected unit cannot be duplicated and changed selections can be split safely", async ({
  page,
}, testInfo) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto(PORTAL_PATH);
  await useSampleSource(page);
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  const itemQuantity = page
    .getByTestId("preview-line-sample-line-1")
    .getByRole("spinbutton");
  await itemQuantity.fill("1");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  const summary = page.getByTestId("packing-summary");
  const totals = page.getByTestId("packing-summary-total");
  const lineSummary = page.getByTestId("packing-summary-line-sample-line-1");
  const addBox = page.getByRole("button", {
    name: "Add another box",
    exact: true,
  });
  const review = page.getByRole("button", {
    name: "Review return",
    exact: true,
  });
  await expect(addBox).toBeDisabled();
  await expect(page.locator('[data-testid^="preview-box-"]')).toHaveCount(1);
  await expect(totals).toContainText("1 item to return");
  await expect(totals).toContainText("1 box");
  await expectPackingLine(page, "sample-line-1", 1, 1);
  const firstItem = page.getByTestId("packing-item-1-sample-line-1");
  const secondItem = page.getByTestId("packing-item-2-sample-line-1");
  await expect(firstItem.getByRole("spinbutton")).toHaveAccessibleDescription(
    "1 of 1 added to this box.",
  );
  await expect(firstItem.getByText("of 1", { exact: true })).toBeVisible();
  await expect(
    firstItem.getByText("added to this box", { exact: true }),
  ).toBeVisible();
  await expectNoCustomerWeights(page);
  await summary.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-summary-single-unit.png"),
  });
  await summary
    .getByRole("button", { name: "Change return items", exact: true })
    .click();
  await expect(itemQuantity).toHaveValue("1");
  await itemQuantity.fill("2");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  const firstQuantity = page.getByLabel(
    "Quantity of item 1: Sample collector sleeves (100 count · Clear) in box 1",
    { exact: true },
  );
  const secondQuantity = page.getByLabel(
    "Quantity of item 1: Sample collector sleeves (100 count · Clear) in box 2",
    { exact: true },
  );
  await expect(firstQuantity).toHaveValue("2");
  await expect(firstQuantity).toHaveAccessibleDescription(
    "2 of 2 added to this box.",
  );
  await expect(addBox).toBeEnabled();
  await addBox.click();
  await expect(addBox).toBeDisabled();
  await page.getByRole("button", { name: "Remove box 2", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your boxes", exact: true }),
  ).toBeFocused();
  await addBox.click();
  await expect(secondItem).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(review).toBeDisabled();
  await expect(
    summary.getByText(
      "Box 2 is empty. Add items or remove it before continuing.",
      { exact: true },
    ),
  ).toBeVisible();
  await firstQuantity.fill("0.5");
  await expect(firstQuantity).toHaveValue("0.5");
  await expect(firstQuantity).toHaveAccessibleDescription(
    "Enter a whole number of items for this box.",
  );
  await expect(review).toBeDisabled();
  await expectPackingLine(page, "sample-line-1", 2, "Check");
  await expect(
    summary.getByText("Check the item quantities before continuing.", {
      exact: true,
    }),
  ).toBeVisible();
  await firstQuantity.fill("");
  await expect(firstQuantity).toBeFocused();
  await expect(firstItem).toBeVisible();
  await expectPackingLine(page, "sample-line-1", 2, 0);
  await expect(firstQuantity).toHaveAccessibleDescription(
    "0 of 2 added to this box.",
  );
  await firstQuantity.press("Tab");
  await expect(
    page.getByRole("button", {
      name: "Add or move items to box 1",
      exact: true,
    }),
  ).toBeFocused();
  await transferBoxItems(page, 1, "unassigned", "sample-line-1", 1);
  await expectPackingLine(page, "sample-line-1", 2, 1);
  await expect(
    lineSummary.getByText("1 still to add to a box.", { exact: true }),
  ).toBeVisible();
  await expect(secondItem).toHaveCount(0);
  const dialog = await openBoxItems(page, 2);
  const unassigned = dialog.getByTestId(
    "packing-source-unassigned-sample-line-1",
  );
  await expect(
    unassigned.getByText("Not in a box · 1 available", { exact: true }),
  ).toBeVisible();
  const quantity = unassigned.getByRole("spinbutton", {
    name: "Quantity of item 1: Sample collector sleeves (100 count · Clear) to add from items not in a box",
    exact: true,
  });
  await expect(quantity).toHaveValue("1");
  await expect(quantity).toHaveAttribute("max", "1");
  await unassigned
    .getByRole("button", { name: "Add to box", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(firstQuantity).toHaveAttribute("max", "1");
  await expect(secondQuantity).toHaveAttribute("max", "1");
  await expect(firstQuantity).toHaveAccessibleDescription(
    "1 of 2 added to this box. 1 in other boxes",
  );
  await expect(secondQuantity).toHaveAccessibleDescription(
    "1 of 2 added to this box. 1 in other boxes",
  );
  await expect(firstItem.getByText("of 2", { exact: true })).toBeVisible();
  await expect(secondItem.getByText("of 2", { exact: true })).toBeVisible();
  await firstQuantity.fill("2");
  await expect(firstQuantity).toHaveValue("1");
  await expect(page.getByRole("alert")).toContainText(
    "Up to 1 can go in this box",
  );
  await expect(page.getByRole("alert")).toContainText("Add or move items");
  await page.getByRole("button", { name: "Remove box 2", exact: true }).click();
  await expect(firstQuantity).toHaveAttribute("max", "2");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await addBox.click();
  await transferBoxItems(page, 2, "unassigned", "sample-line-1", 1);
  await expectPackingLine(page, "sample-line-1", 2, 2);
  await firstQuantity.fill("");
  await firstQuantity.fill("1");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(totals).toContainText("2 items to return");
  await expect(totals).toContainText("2 boxes");
  await enterCustomBoxDimensions(page, 1);
  await enterCustomBoxDimensions(page, 2);
  await expect(review).toBeEnabled();
  await expectNoCustomerWeights(page);
  await secondItem.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-quantity-context.png"),
  });
  await summary.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-summary-split-units.png"),
  });
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-summary-split-flow.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await reviewPackedReturn(page);
  await expect(
    page.getByRole("heading", { name: "Review your return", exact: true }),
  ).toBeVisible();
  expect(
    fixture.previewRequests.find(
      (request) => request.path === `${PREVIEW_API}/review`,
    )?.body,
  ).toMatchObject({
    selections: [{ lineId: "sample-line-1", quantity: 2, reasonCode: null }],
    parcels: [
      { items: [{ lineId: "sample-line-1", quantity: 1 }] },
      { items: [{ lineId: "sample-line-1", quantity: 1 }] },
    ],
  });
  expect(fixture.failures).toEqual([]);
});
test("packing never adds more boxes than the shared parcel limit", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  const selectedQuantity = MAX_RETURN_FLOW_PARCELS + 1;
  const order = fixture.liveOrder();
  await page.route(`**${PREVIEW_API}/live/order`, (route) =>
    route.fulfill({
      json: {
        ...order,
        boxOptions: [],
        lines: order.lines.map((line, index) =>
          index === 0
            ? {
                ...line,
                purchasedQuantity: selectedQuantity,
                deliveredQuantity: selectedQuantity,
                eligibleQuantity: selectedQuantity,
              }
            : line,
        ),
      },
    }),
  );
  await page.goto(PORTAL_PATH);
  await page.getByLabel("Order number", { exact: true }).fill("LIVE-1001");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page
    .getByTestId("preview-line-sample-line-1")
    .getByRole("spinbutton")
    .fill(String(selectedQuantity));
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  const addBox = page.getByRole("button", {
    name: "Add another box",
    exact: true,
  });
  for (let count = 1; count < MAX_RETURN_FLOW_PARCELS; count += 1) {
    await addBox.click();
  }
  await expect(page.locator('[data-testid^="preview-box-"]')).toHaveCount(
    MAX_RETURN_FLOW_PARCELS,
  );
  await expect(addBox).toBeDisabled();
  await expect(page.getByTestId("packing-summary-total")).toContainText(
    `${selectedQuantity} items to return`,
  );
  await expect(page.getByTestId("packing-summary-total")).toContainText(
    `${MAX_RETURN_FLOW_PARCELS} boxes`,
  );
  await expect(
    page.getByRole("button", { name: "Review return", exact: true }),
  ).toBeDisabled();
  expect(
    fixture.previewRequests.some(
      (request) => request.path === `${PREVIEW_API}/live/review`,
    ),
  ).toBe(false);
  expect(fixture.failures).toEqual([]);
});

test("changing scenario clears selections and shipped items cannot be returned", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto(PORTAL_PATH);
  await useSampleSource(page);
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
  await useSampleSource(page);
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
  await useSampleSource(page);
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
  await useSampleSource(page);
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

test("same-name purchased lines stay distinct through transfers, removal, and unassigned re-add", async ({
  page,
}, testInfo) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto(PORTAL_PATH);
  await useSampleSource(page);
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
  const first = page.getByTestId("packing-item-1-sample-line-1");
  const sameName = page.getByTestId("packing-item-1-sample-line-2");
  await expect(first.getByRole("spinbutton")).toHaveAccessibleName(
    "Quantity of item 1: Sample collector sleeves (100 count · Clear) in box 1",
  );
  await expect(sameName.getByRole("spinbutton")).toHaveAccessibleName(
    "Quantity of item 2: Sample collector sleeves (100 count · Clear) in box 1",
  );
  await expect(
    first.getByText("Order item 1 · 100 count · Clear", { exact: true }),
  ).toBeVisible();
  await expect(
    sameName.getByText("Order item 2 · 100 count · Clear", { exact: true }),
  ).toBeVisible();
  await expectPackingSummaryFirst(page);
  await page
    .getByRole("button", { name: "Add another box", exact: true })
    .click();
  await expect(
    page.getByTestId("preview-box-2").locator('[data-testid^="packing-item-"]'),
  ).toHaveCount(0);
  const dialog = await openBoxItems(page, 2);
  await expect(dialog.locator('[data-testid^="packing-source-"]')).toHaveCount(
    2,
  );
  await expect(
    dialog.getByTestId("packing-source-unassigned-sample-line-1"),
  ).toHaveCount(0);
  await expect(
    dialog.getByTestId("packing-source-unassigned-sample-line-2"),
  ).toHaveCount(0);
  const source = dialog.getByTestId("packing-source-1-sample-line-1");
  const otherSource = dialog.getByTestId("packing-source-1-sample-line-2");
  const amount = source.getByRole("spinbutton", {
    name: "Quantity of item 1: Sample collector sleeves (100 count · Clear) to add from box 1",
    exact: true,
  });
  await expect(otherSource.getByRole("spinbutton")).toHaveAccessibleName(
    "Quantity of item 2: Sample collector sleeves (100 count · Clear) to add from box 1",
  );
  await expect(
    source.getByText("From Box 1 · 2 available", { exact: true }),
  ).toBeVisible();
  await expect(
    otherSource.getByText("From Box 1 · 1 available", { exact: true }),
  ).toBeVisible();
  await expect(amount).toHaveValue("1");
  await expect(amount).toHaveAttribute("max", "2");
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-add-or-move-picker.png"),
    fullPage: true,
  });
  const move = source.getByRole("button", { name: "Move to box", exact: true });
  for (const invalid of ["", "0", "0.5", "3"]) {
    await amount.fill(invalid);
    await expect(move).toBeDisabled();
    await expect(
      source.getByText("Enter a whole number from 1 to 2.", { exact: true }),
    ).toBeVisible();
    await expect(first.locator('input[type="number"]')).toHaveValue("2");
    await expect(sameName.locator('input[type="number"]')).toHaveValue("1");
    await expect(
      page
        .getByTestId("preview-box-2")
        .locator('[data-testid^="packing-item-"]'),
    ).toHaveCount(0);
  }
  await amount.fill("1");
  await expect(move).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Add or move items to box 2",
      exact: true,
    }),
  ).toBeFocused();
  await expect(first.locator('input[type="number"]')).toHaveValue("2");
  await expect(sameName.locator('input[type="number"]')).toHaveValue("1");
  await expectPackingLine(page, "sample-line-1", 2, 2);
  await expectPackingLine(page, "sample-line-2", 1, 1);
  expect(
    fixture.previewRequests.some((request) => request.path.endsWith("/review")),
  ).toBe(false);

  await transferBoxItems(page, 2, 1, "sample-line-2", 1);
  await expect(sameName).toHaveCount(0);
  await expect(first.locator('input[type="number"]')).toHaveValue("2");
  const moved = page.getByTestId("packing-item-2-sample-line-2");
  await expect(moved.getByRole("spinbutton")).toHaveValue("1");
  await expect(page.getByTestId("packing-item-2-sample-line-1")).toHaveCount(0);
  await moved
    .getByRole("button", {
      name: "Remove item 2: Sample collector sleeves (100 count · Clear) from box 2",
      exact: true,
    })
    .click();
  await expect(moved).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Add or move items to box 2",
      exact: true,
    }),
  ).toBeFocused();
  await expectPackingLine(page, "sample-line-1", 2, 2);
  await expectPackingLine(page, "sample-line-2", 1, 0);
  await transferBoxItems(page, 2, "unassigned", "sample-line-2", 1);
  await expect(moved.getByRole("spinbutton")).toHaveValue("1");
  await transferBoxItems(page, 2, 1, "sample-line-1", 1);
  await expect(first.getByRole("spinbutton")).toHaveValue("1");
  const split = page.getByTestId("packing-item-2-sample-line-1");
  await expect(split.getByRole("spinbutton")).toHaveValue("1");
  await split.getByRole("spinbutton").fill("0");
  await expect(split.getByRole("spinbutton")).toBeFocused();
  await expect(split).toBeVisible();
  await expectPackingLine(page, "sample-line-1", 2, 1);
  const readd = await openBoxItems(page, 2);
  await expect(split).toHaveCount(0);
  const unassigned = readd.getByTestId(
    "packing-source-unassigned-sample-line-1",
  );
  await expect(
    unassigned.getByText("Not in a box · 1 available", { exact: true }),
  ).toBeVisible();
  await unassigned
    .getByRole("button", { name: "Add to box", exact: true })
    .click();
  await expect(readd).toHaveCount(0);
  await expect(split.getByRole("spinbutton")).toHaveValue("1");
  await expect(sameName).toHaveCount(0);
  await expectPackingLine(page, "sample-line-1", 2, 2);
  await expectPackingLine(page, "sample-line-2", 1, 1);
  await expect(page.getByTestId("packing-summary-total")).toContainText(
    "3 items to return",
  );
  await expect(page.getByTestId("packing-summary-total")).toContainText(
    "2 boxes",
  );
  await expectNoCustomerWeights(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-positive-contents-only.png"),
    fullPage: true,
  });
  await reviewPackedReturn(page);
  await expect(
    page.getByRole("heading", { name: "Review your return", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Item 1 · 100 count · Clear", { exact: true }),
  ).toHaveCount(2);
  await expect(
    page.getByText("Item 2 · 100 count · Clear", { exact: true }),
  ).toBeVisible();
  const reviews = fixture.previewRequests.filter(
    (request) => request.path === `${PREVIEW_API}/review`,
  );
  expect(reviews).toHaveLength(1);
  expect(reviews[0].body).toMatchObject({
    selections: [
      { lineId: "sample-line-1", quantity: 2, reasonCode: null },
      {
        lineId: "sample-line-2",
        quantity: 1,
        reasonCode: "ordered_by_mistake",
      },
    ],
    parcels: [
      { items: [{ lineId: "sample-line-1", quantity: 1 }] },
      {
        items: [
          { lineId: "sample-line-1", quantity: 1 },
          { lineId: "sample-line-2", quantity: 1 },
        ],
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
    animations: "disabled",
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

test("live order lookup is the default and a review carries the selected shop and original revision", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto(PORTAL_PATH);
  await expect(page.getByLabel("Order number", { exact: true })).toHaveValue(
    "",
  );
  await showTestingControls(page);
  await expect(page.getByLabel("Order source", { exact: true })).toHaveValue(
    "live",
  );
  await expect(page.getByLabel("Shopify shop", { exact: true })).toHaveValue(
    "36",
  );
  await expect(page.getByLabel("Shopify shop", { exact: true })).toBeDisabled();
  await expect(
    page
      .getByTestId("preview-canvas")
      .getByLabel("Shopify shop", { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Order number", { exact: true }).fill(" # LIVE-1001 ");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page
    .getByTestId("preview-line-sample-line-1")
    .getByRole("spinbutton")
    .fill("1");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  await reviewPackedReturn(page);
  await expect(
    page.getByRole("heading", { name: "Review your return", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Get return labels", exact: true }),
  ).toBeDisabled();
  const review = fixture.previewRequests.find(
    (request) => request.path === `${PREVIEW_API}/live/review`,
  );
  expect(review?.body).toMatchObject({
    channelId: 36,
    orderReference: "#LIVE-1001",
    sourceRevision: fixture.liveOrder().sourceRevision,
    selections: [{ lineId: "sample-line-1", quantity: 1, reasonCode: null }],
  });
  expect(
    fixture.previewRequests.filter(
      (request) =>
        request.path === `${PREVIEW_API}/order` ||
        request.path === `${PREVIEW_API}/review`,
    ),
  ).toEqual([]);
  expect(fixture.failures).toEqual([]);
});

test("the full maximum available quantity remains readable without horizontal overflow", async ({
  page,
}, testInfo) => {
  const fixture = await installReturnPreviewFixtures(page);
  const order = fixture.liveOrder();
  const maximumQuantity = Number.MAX_SAFE_INTEGER;
  await page.route(`**${PREVIEW_API}/live/order`, (route) =>
    route.fulfill({
      json: {
        ...order,
        boxOptions: [],
        lines: [
          {
            ...order.lines[0],
            unitWeightGrams: 1,
            purchasedQuantity: maximumQuantity,
            deliveredQuantity: maximumQuantity,
            alreadyReturningQuantity: 0,
            eligibleQuantity: maximumQuantity,
            message: null,
          },
        ],
      },
    }),
  );
  await page.goto(PORTAL_PATH);
  await page.getByLabel("Order number", { exact: true }).fill("LIVE-1001");
  await page.getByRole("button", { name: "Find order", exact: true }).click();

  const line = page.getByTestId("preview-line-sample-line-1");
  const denominator = line.getByText(`/ ${maximumQuantity}`, { exact: true });
  await expect(line.getByRole("spinbutton")).toHaveAttribute(
    "max",
    String(maximumQuantity),
  );
  await denominator.scrollIntoViewIfNeeded();
  await expect(denominator).toBeVisible();
  await expect(denominator).toHaveText(`/ ${maximumQuantity}`);
  const geometry = await denominator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const bounds = element.getBoundingClientRect();
    const fragments = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    // A text Range includes clipped glyphs. Checking every fragment catches
    // ellipsis/overflow clipping even when textContent still has all digits.
    const tolerance = 1;
    return {
      hasText: fragments.length > 0,
      allTextFits: fragments.every(
        (rect) =>
          rect.left >= bounds.left - tolerance &&
          rect.right <= bounds.right + tolerance &&
          rect.top >= bounds.top - tolerance &&
          rect.bottom <= bounds.bottom + tolerance,
      ),
    };
  });
  expect(geometry).toEqual({ hasText: true, allTextFits: true });
  expect(
    await line.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await line.getByRole("spinbutton").fill(String(maximumQuantity));
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  const packingItem = page.getByTestId("packing-item-1-sample-line-1");
  const packingQuantity = packingItem.getByRole("spinbutton");
  const packingDenominator = packingItem.getByText(`of ${maximumQuantity}`, {
    exact: true,
  });
  await expect(packingQuantity).toHaveAttribute("max", String(maximumQuantity));
  await expect(packingQuantity).toHaveAccessibleDescription(
    `${maximumQuantity} of ${maximumQuantity} added to this box.`,
  );
  expect(
    await packingItem.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .getByTestId("preview-canvas")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await packingItem.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-maximum-quantity-context.png"),
  });
  await packingQuantity.fill("1");
  await expect(packingQuantity).toHaveAccessibleDescription(
    `1 of ${maximumQuantity} added to this box.`,
  );
  await packingDenominator.scrollIntoViewIfNeeded();
  await expect(packingDenominator).toBeVisible();
  await expect(packingDenominator).toHaveText(`of ${maximumQuantity}`);
  const packingGeometry = await packingDenominator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const bounds = element.getBoundingClientRect();
    const fragments = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    const tolerance = 1;
    return {
      hasText: fragments.length > 0,
      allTextFits: fragments.every(
        (rect) =>
          rect.left >= bounds.left - tolerance &&
          rect.right <= bounds.right + tolerance &&
          rect.top >= bounds.top - tolerance &&
          rect.bottom <= bounds.bottom + tolerance,
      ),
    };
  });
  expect(packingGeometry).toEqual({ hasText: true, allTextFits: true });
  expect(
    await packingItem.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Add another box", exact: true })
    .click();
  await expect(page.getByTestId("packing-item-2-sample-line-1")).toHaveCount(0);
  const dialog = await openBoxItems(page, 2);
  const unassigned = dialog.getByTestId(
    "packing-source-unassigned-sample-line-1",
  );
  const amount = unassigned.getByRole("spinbutton");
  await expect(amount).toHaveValue("1");
  await expect(amount).toHaveAttribute("max", String(maximumQuantity - 1));
  await expect(
    unassigned.getByText(`Not in a box · ${maximumQuantity - 1} available`, {
      exact: true,
    }),
  ).toBeVisible();
  await amount.fill(String(maximumQuantity - 1));
  await expect(amount).toHaveValue(String(maximumQuantity - 1));
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-maximum-quantity-picker.png"),
    fullPage: true,
  });
  await unassigned
    .getByRole("button", { name: "Add to box", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByTestId("packing-item-2-sample-line-1").getByRole("spinbutton"),
  ).toHaveValue(String(maximumQuantity - 1));
  await expect(packingQuantity).toHaveValue("1");
  await expectPackingLine(
    page,
    "sample-line-1",
    maximumQuantity,
    maximumQuantity,
  );
  await expectNoCustomerWeights(page);
  expect(
    await page
      .getByTestId("preview-canvas")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(fixture.failures).toEqual([]);
});

test("one matching original box defaults its dimensions and custom edits survive Back and reason changes", async ({
  page,
}, testInfo) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto(PORTAL_PATH);
  await page.getByLabel("Order number", { exact: true }).fill("LIVE-1001");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  const item = page.getByTestId("preview-line-sample-line-2");
  await item.getByRole("spinbutton").fill("1");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  const box = page.getByTestId("preview-box-1");
  await expect(
    box.getByText("Original box size · 10 × 8 × 4 in", { exact: true }),
  ).toBeVisible();
  await expectNoCustomerWeights(page);
  await expect(box.getByRole("spinbutton", { name: /weight/i })).toHaveCount(0);
  await page.getByTestId("preview-canvas").screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-original-size.png"),
  });
  await enterCustomBoxDimensions(page, 1, "12.125", "8", "4");
  await page.getByTestId("preview-canvas").screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-custom-size.png"),
  });
  await reviewPackedReturn(page);
  await expect(
    page.getByRole("heading", { name: "Review your return", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("12.125 × 8 × 4 in", {
      exact: true,
    }),
  ).toBeVisible();
  await expectNoCustomerWeights(page);
  const review = fixture.previewRequests.find(
    (request) => request.path === `${PREVIEW_API}/live/review`,
  );
  expect(review?.body).toMatchObject({
    parcels: [
      {
        originalBoxId: null,
        dimensions: { lengthMm: 307.975, widthMm: 203.2, heightMm: 101.6 },
      },
    ],
  });
  await page
    .getByRole("button", { name: "Back to packing", exact: true })
    .click();
  await expect(
    box.getByLabel("Length of box 1 in inches", { exact: true }),
  ).toHaveValue("12.125");
  await page
    .getByRole("button", { name: "Back to items", exact: true })
    .click();
  await item.getByRole("combobox").selectOption("damaged");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  await expect(
    box.getByLabel("Length of box 1 in inches", { exact: true }),
  ).toHaveValue("12.125");
  expect(fixture.failures).toEqual([]);
});

test("multiple original boxes require an explicit size choice", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto(PORTAL_PATH);
  await page.getByLabel("Order number", { exact: true }).fill("LIVE-1001");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page
    .getByTestId("preview-line-sample-line-1")
    .getByRole("spinbutton")
    .fill("1");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  const box = page.getByTestId("preview-box-1");
  const size = box.getByLabel("Box size for box 1", { exact: true });
  await expect(size).toHaveValue("");
  await expect(
    box.getByRole("button", { name: "Change size for box 1", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Review return", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Choose a box size");
  expect(
    fixture.previewRequests.some(
      (request) => request.path === `${PREVIEW_API}/live/review`,
    ),
  ).toBe(false);
  await size.selectOption("original:sample-box-1-1");
  await reviewPackedReturn(page);
  await expect(
    page.getByRole("heading", { name: "Review your return", exact: true }),
  ).toBeVisible();
  expect(
    fixture.previewRequests.find(
      (request) => request.path === `${PREVIEW_API}/live/review`,
    )?.body,
  ).toMatchObject({
    parcels: [
      {
        originalBoxId: "sample-box-1-1",
        dimensions: { lengthMm: 254, widthMm: 203.2, heightMm: 101.6 },
      },
    ],
  });
  expect(fixture.failures).toEqual([]);
});

test("missing original dimensions require custom dimensions before review", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.route(`**${PREVIEW_API}/live/order`, (route) =>
    route.fulfill({
      json: {
        ...fixture.liveOrder(),
        boxOptions: [],
      },
    }),
  );
  await page.goto(PORTAL_PATH);
  await page.getByLabel("Order number", { exact: true }).fill("LIVE-1001");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page
    .getByTestId("preview-line-sample-line-2")
    .getByRole("spinbutton")
    .fill("1");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  const box = page.getByTestId("preview-box-1");
  await expect(
    box.getByLabel("Length of box 1 in inches", { exact: true }),
  ).toHaveValue("");
  await expect(
    box.getByLabel("Box size for box 1", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Review return", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Enter the length, width, and height",
  );
  expect(
    fixture.previewRequests.some(
      (request) => request.path === `${PREVIEW_API}/live/review`,
    ),
  ).toBe(false);
  await enterCustomBoxDimensions(page, 1, "11", "9", "5");
  await reviewPackedReturn(page);
  await expect(
    page.getByRole("heading", { name: "Review your return", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("11 × 9 × 5 in", { exact: true })).toBeVisible();
  await expectNoCustomerWeights(page);
  expect(
    fixture.previewRequests.find(
      (request) => request.path === `${PREVIEW_API}/live/review`,
    )?.body,
  ).toMatchObject({
    parcels: [
      {
        originalBoxId: null,
        dimensions: { lengthMm: 279.4, widthMm: 228.6, heightMm: 127 },
      },
    ],
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(fixture.failures).toEqual([]);
});

test("missing product weight cannot be edited or reviewed as zero", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  const order = fixture.liveOrder();
  await page.route(`**${PREVIEW_API}/live/order`, (route) =>
    route.fulfill({
      json: {
        ...order,
        boxOptions: [],
        lines: order.lines.map((line, index) =>
          index === 0 ? { ...line, unitWeightGrams: null } : line,
        ),
      },
    }),
  );
  await page.goto(PORTAL_PATH);
  await page.getByLabel("Order number", { exact: true }).fill("LIVE-1001");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page
    .getByTestId("preview-line-sample-line-1")
    .getByRole("spinbutton")
    .fill("1");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  const box = page.getByTestId("preview-box-1");
  await expect(
    box.getByText(
      "We cannot prepare this box for return yet. Please contact support for help.",
      { exact: true },
    ),
  ).toBeVisible();
  await expectNoCustomerWeights(page);
  await expect(
    box.getByLabel("Length of box 1 in inches", { exact: true }),
  ).toHaveValue("");
  await enterCustomBoxDimensions(page, 1);
  await expect(
    page.getByRole("button", { name: "Review return", exact: true }),
  ).toBeDisabled();
  await expect(box.getByRole("spinbutton", { name: /weight/i })).toHaveCount(0);
  expect(
    fixture.previewRequests.some(
      (request) => request.path === `${PREVIEW_API}/live/review`,
    ),
  ).toBe(false);
  expect(fixture.failures).toEqual([]);
});

for (const mismatch of ["dimensions", "weight"] as const) {
  test(`a review with changed ${mismatch} cannot display a successful return plan`, async ({
    page,
  }) => {
    const fixture = await installReturnPreviewFixtures(page);
    await page.route(`**${PREVIEW_API}/live/review`, (route) => {
      const input = customerReturnLiveReviewInputSchema.parse(
        route.request().postDataJSON(),
      );
      const checked = fixture.service.review({
        scenarioId: "split_delivered",
        orderReference: "TEST-1001",
        selections: input.selections,
        parcels: input.parcels,
      });
      return route.fulfill({
        json: {
          ...checked,
          mode: "admin_live",
          sourceRevision: input.sourceRevision,
          orderReference: input.orderReference,
          parcels: checked.parcels.map((parcel, index) =>
            index !== 0
              ? parcel
              : mismatch === "weight"
                ? { ...parcel, weightGrams: parcel.weightGrams + 1 }
                : {
                    ...parcel,
                    dimensions: {
                      ...parcel.dimensions,
                      lengthMm: parcel.dimensions.lengthMm + 25.4,
                    },
                  },
          ),
        },
      });
    });
    await page.goto(PORTAL_PATH);
    await page.getByLabel("Order number", { exact: true }).fill("LIVE-1001");
    await page.getByRole("button", { name: "Find order", exact: true }).click();
    await page
      .getByTestId("preview-line-sample-line-2")
      .getByRole("spinbutton")
      .fill("1");
    await page
      .getByRole("button", { name: "Continue to packing", exact: true })
      .click();
    await reviewPackedReturn(page);
    await expect(page.getByRole("alert")).toContainText(
      "did not match your boxes",
    );
    await expect(
      page.getByRole("heading", { name: "Review your return", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByTestId("preview-box-1")).toBeVisible();
    expect(fixture.failures).toEqual([]);
  });
}

test("an unavailable live catalog stays visible and sample orders require an explicit switch", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.route(`**${PREVIEW_API}/live`, (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: { message: "Shopify shops are temporarily unavailable." },
      },
    }),
  );
  await page.goto(PORTAL_PATH);
  await expect(page.getByRole("alert")).toContainText(
    "Shopify shops are temporarily unavailable",
  );
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
  await showTestingControls(page);
  await expect(page.getByLabel("Order source", { exact: true })).toHaveValue(
    "live",
  );
  await page.getByLabel("Order source", { exact: true }).selectOption("sample");
  await expect(page.getByLabel("Order number", { exact: true })).toHaveValue(
    "TEST-1001",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(fixture.failures).toEqual([]);
});

test("an empty live shop catalog keeps the private source controls available", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page, { shops: [] });
  await page.goto(PORTAL_PATH);
  await expect(
    page.getByText("No Shopify shops are available for live testing.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
  await useSampleSource(page);
  await expect(page.getByTestId("preview-canvas")).toBeVisible();
  expect(fixture.failures).toEqual([]);
});

test("multiple shops require a staff selection and switching shops discards the old order", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page, {
    shops: [
      { channelId: 36, name: "Fixture shop A" },
      { channelId: 37, name: "Fixture shop B" },
    ],
  });
  await page.goto(PORTAL_PATH);
  await expect(
    page.getByText(
      "Choose a Shopify shop in Testing controls to find an order.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
  await showTestingControls(page);
  await expect(page.getByLabel("Shopify shop", { exact: true })).toHaveValue(
    "",
  );
  await page.getByLabel("Shopify shop", { exact: true }).selectOption("36");
  await page.getByLabel("Order number", { exact: true }).fill("LIVE-1001");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page
    .getByTestId("preview-line-sample-line-1")
    .getByRole("spinbutton")
    .fill("1");
  await page.getByLabel("Shopify shop", { exact: true }).selectOption("37");
  await expect(page.getByLabel("Order number", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.getByTestId("preview-line-sample-line-1")).toHaveCount(0);
  await page.getByLabel("Order number", { exact: true }).fill("LIVE-1001");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await expect(
    page.getByTestId("preview-line-sample-line-1").getByRole("spinbutton"),
  ).toHaveValue("0");
  expect(
    fixture.previewRequests
      .filter((request) => request.path === `${PREVIEW_API}/live/order`)
      .map((request) => request.body),
  ).toEqual([
    { channelId: 36, orderReference: "LIVE-1001" },
    { channelId: 37, orderReference: "LIVE-1001" },
  ]);
  expect(fixture.failures).toEqual([]);
});

test("a stale live review clears old quantities and requires a fresh order lookup", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.route(`**${PREVIEW_API}/live/review`, (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "RETURN_LIVE_REVIEW_CHANGED",
          message: "Availability changed.",
        },
      },
    }),
  );
  await page.goto(PORTAL_PATH);
  await page.getByLabel("Order number", { exact: true }).fill("LIVE-1001");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page
    .getByTestId("preview-line-sample-line-1")
    .getByRole("spinbutton")
    .fill("1");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  await reviewPackedReturn(page);
  await expect(page.getByRole("alert")).toContainText(
    "return availability changed",
  );
  await expect(page.getByLabel("Order number", { exact: true })).toHaveValue(
    "LIVE-1001",
  );
  await expect(page.getByTestId("preview-line-sample-line-1")).toHaveCount(0);
  await expect(page.getByTestId("preview-box-1")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Review your return", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await expect(
    page.getByTestId("preview-line-sample-line-1").getByRole("spinbutton"),
  ).toHaveValue("0");
  expect(fixture.failures).toEqual([]);
});

test("unknown return history blocks only its item while another item can be reviewed", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  const order = fixture.liveOrder();
  const message =
    "These quantities need verification before a return can be started.";
  await page.route(`**${PREVIEW_API}/live/order`, (route) =>
    route.fulfill({
      json: {
        ...order,
        lines: order.lines.map((line, index) =>
          index === 0
            ? {
                ...line,
                alreadyReturningQuantity: null,
                eligibleQuantity: 0,
                message,
              }
            : line,
        ),
      },
    }),
  );
  await page.goto(PORTAL_PATH);
  await page.getByLabel("Order number", { exact: true }).fill("LIVE-1001");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  const unknown = page.getByTestId("preview-line-sample-line-1");
  const available = page.getByTestId("preview-line-sample-line-2");
  await expect(
    unknown.getByText("Return history needs verification", { exact: true }),
  ).toBeVisible();
  await expect(unknown.getByText(message, { exact: true })).toBeVisible();
  await expect(unknown.getByText(/0 already in a return/)).toHaveCount(0);
  await expect(unknown.getByRole("spinbutton")).toBeDisabled();
  await expect(available.getByRole("spinbutton")).toBeEnabled();
  await available.getByRole("spinbutton").fill("1");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  await reviewPackedReturn(page);
  await expect(
    page.getByRole("heading", { name: "Review your return", exact: true }),
  ).toBeVisible();
  const request = fixture.previewRequests.find(
    (entry) => entry.path === `${PREVIEW_API}/live/review`,
  );
  expect(request?.body).toMatchObject({
    selections: [{ lineId: "sample-line-2", quantity: 1, reasonCode: null }],
    parcels: [{ items: [{ lineId: "sample-line-2", quantity: 1 }] }],
  });
  expect(fixture.failures).toEqual([]);
});

test("unverified delivery stays unavailable with customer-safe explanation", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  const order = fixture.liveOrder();
  const message =
    "We can't confirm delivery yet. Our team needs to verify it before you can return this item.";
  await page.route(`**${PREVIEW_API}/live/order`, (route) =>
    route.fulfill({
      json: {
        ...order,
        lines: order.lines.map((line) => ({
          ...line,
          deliveredQuantity: 0,
          eligibleQuantity: 0,
          message,
        })),
      },
    }),
  );
  await page.goto(PORTAL_PATH);
  await page.getByLabel("Order number", { exact: true }).fill("LIVE-1001");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  const line = page.getByTestId("preview-line-sample-line-1");
  await expect(line.getByText(message, { exact: true })).toBeVisible();
  await expect(line.getByRole("spinbutton")).toBeDisabled();
  await expect(line.getByText(/0 confirmed delivered/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue to packing", exact: true }),
  ).toBeDisabled();
  expect(fixture.failures).toEqual([]);
});

test("a live source outage during review preserves packing but never shows a successful review", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.route(`**${PREVIEW_API}/live/review`, (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          message:
            "Order availability is temporarily unavailable. Please try again.",
        },
      },
    }),
  );
  await page.goto(PORTAL_PATH);
  await page.getByLabel("Order number", { exact: true }).fill("LIVE-1001");
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page
    .getByTestId("preview-line-sample-line-1")
    .getByRole("spinbutton")
    .fill("1");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  await reviewPackedReturn(page);
  await expect(page.getByRole("alert")).toContainText(
    "temporarily unavailable",
  );
  await expect(
    page.getByTestId("preview-box-1").getByRole("spinbutton"),
  ).toHaveValue("1");
  await expect(
    page.getByRole("heading", { name: "Review your return", exact: true }),
  ).toHaveCount(0);
  expect(fixture.failures).toEqual([]);
});
