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

function packingRow(page: Page, boxNumber: number, lineId: string) {
  return page
    .getByTestId(`preview-box-${boxNumber}`)
    .locator(`[data-testid^="packing-item-"][data-testid$="-${lineId}"]`);
}

async function expectBoxQuantity(
  page: Page,
  boxNumber: number,
  lineId: string,
  quantity: number,
  selected: number,
) {
  const row = packingRow(page, boxNumber, lineId);
  await expect(
    row.getByText(`${quantity} of ${selected}`, { exact: true }),
  ).toBeVisible();
  await expect(row.getByText("in this box", { exact: true })).toBeVisible();
  await expect(row.getByRole("spinbutton")).toHaveCount(0);
}

async function openLineMove(page: Page, boxNumber: number, lineId: string) {
  await packingRow(page, boxNumber, lineId)
    .getByRole("button", { name: /^Move / })
    .click();
  const dialog = page.getByRole("dialog", {
    name: `Move items from Box ${boxNumber}`,
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function moveLine(
  page: Page,
  boxNumber: number,
  lineId: string,
  target: number | "new",
  quantity: number,
) {
  const dialog = await openLineMove(page, boxNumber, lineId);
  await dialog
    .getByLabel("Destination box", { exact: true })
    .selectOption(target === "new" ? "new" : { label: `Box ${target}` });
  const row = dialog.getByTestId(`move-line-${lineId}`);
  await expect(row.getByRole("checkbox")).toBeChecked();
  await row.getByRole("spinbutton").fill(String(quantity));
  await dialog
    .getByRole("button", {
      name: target === "new" ? "Create box and move" : "Move items",
      exact: true,
    })
    .click();
  await expect(dialog).toHaveCount(0);
}

async function openUnassigned(page: Page, lineId: string) {
  const row = page.getByTestId(`unassigned-item-${lineId}`);
  await row.getByRole("button", { name: /^Add .+ to a box$/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "Add items to a box",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectNoNewBoxDestination(page: Page) {
  const destination = page
    .getByRole("dialog")
    .getByLabel("Destination box", { exact: true });
  expect(
    await destination
      .locator('option[value="new"]')
      .evaluateAll((options) =>
        options.every(
          (option) => option instanceof HTMLOptionElement && option.disabled,
        ),
      ),
  ).toBe(true);
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

test("split shipments move directly from the first box into a new box without live effects", async ({
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
  await expectBoxQuantity(page, 1, "sample-line-1", 3, 3);
  await expectBoxQuantity(page, 1, "sample-line-3", 1, 1);
  await expect(
    page.getByTestId("preview-box-1").getByText("Black", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId("preview-canvas").getByText(/Option:/),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add another box", exact: true }),
  ).toHaveCount(0);
  const move = packingRow(page, 1, "sample-line-1").getByRole("button", {
    name: "Move item 1: Sample collector sleeves (100 count · Clear) from box 1",
    exact: true,
  });
  await expect(move).toBeVisible();
  await move.click();
  const dialog = page.getByRole("dialog", {
    name: "Move items from Box 1",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel("Destination box", { exact: true })
    .selectOption("new");
  const line = dialog.getByTestId("move-line-sample-line-1");
  await expect(
    line.getByRole("checkbox", {
      name: "Select item 1: Sample collector sleeves (100 count · Clear) to move",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    dialog.getByTestId("move-line-sample-line-3").getByRole("checkbox"),
  ).not.toBeChecked();
  const amount = line.getByRole("spinbutton", {
    name: "Quantity of item 1: Sample collector sleeves (100 count · Clear) to move",
    exact: true,
  });
  await expect(amount).toHaveValue("3");
  await expect(amount).toHaveAttribute("max", "3");
  await amount.fill("2");
  await expect(page.getByTestId("preview-box-2")).toHaveCount(0);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-direct-split-dialog.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Create box and move", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Box 2", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("status").getByRole("button", { name: "Undo", exact: true }),
  ).toBeVisible();
  await expectPackingLine(page, "sample-line-1", 3, 3);
  await expectPackingLine(page, "sample-line-3", 1, 1);
  await expect(totals).toContainText("2 boxes");
  await expectBoxQuantity(page, 1, "sample-line-1", 1, 3);
  await expectBoxQuantity(page, 1, "sample-line-3", 1, 1);
  await expectBoxQuantity(page, 2, "sample-line-1", 2, 3);
  await expect(packingRow(page, 2, "sample-line-3")).toHaveCount(0);
  await expectNoCustomerWeights(page);
  await expect(
    page
      .getByTestId("preview-box-2")
      .getByText("Original box size · 10 × 8 × 4 in", { exact: true }),
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
  await expectBoxQuantity(page, 2, "sample-line-1", 2, 3);
  await page
    .getByRole("button", { name: "Back to items", exact: true })
    .click();
  await expect(sleeves.getByRole("spinbutton")).toHaveValue("3");
  await sleeves.getByRole("spinbutton").fill("2");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  await expect(page.getByTestId("preview-box-2")).toHaveCount(0);
  await expectBoxQuantity(page, 1, "sample-line-1", 2, 2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(fixture.failures).toEqual([]);
});

test("one selected unit can be set aside and re-added while a real split creates a second box only on confirmation", async ({
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
  const review = page.getByRole("button", {
    name: "Review return",
    exact: true,
  });
  await expectPackingSummaryFirst(page);
  await expectBoxQuantity(page, 1, "sample-line-1", 1, 1);
  await expect(
    packingRow(page, 1, "sample-line-1").getByRole("button", {
      name: /^Move /,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Move items from box 1", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add another box", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("packing-summary-total")).toContainText(
    "1 item to return",
  );
  await packingRow(page, 1, "sample-line-1")
    .getByRole("button", {
      name: "Remove item 1: Sample collector sleeves (100 count · Clear) from box 1",
      exact: true,
    })
    .click();
  await expect(packingRow(page, 1, "sample-line-1")).toHaveCount(0);
  await expect(
    page
      .getByTestId("packing-unassigned")
      .getByRole("heading", { name: "Items to pack", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("unassigned-item-sample-line-1")).toBeVisible();
  await expect(
    page
      .getByTestId("unassigned-item-sample-line-1")
      .getByRole("button", { name: /^Add / }),
  ).toBeFocused();
  await expectPackingLine(page, "sample-line-1", 1, 0);
  await expect(review).toBeDisabled();
  const add = await openUnassigned(page, "sample-line-1");
  await add
    .getByLabel("Destination box", { exact: true })
    .selectOption({ label: "Box 1" });
  await expect(
    add.getByTestId("move-line-sample-line-1").getByRole("spinbutton"),
  ).toHaveValue("1");
  await add.getByRole("button", { name: "Move items", exact: true }).click();
  await expect(add).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Box 1", exact: true }),
  ).toBeFocused();
  await expect(page.getByTestId("unassigned-item-sample-line-1")).toHaveCount(
    0,
  );
  await expectBoxQuantity(page, 1, "sample-line-1", 1, 1);
  await expectPackingLine(page, "sample-line-1", 1, 1);
  await summary
    .getByRole("button", { name: "Change return items", exact: true })
    .click();
  await expect(itemQuantity).toHaveValue("1");
  await itemQuantity.fill("2");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  const move = packingRow(page, 1, "sample-line-1").getByRole("button", {
    name: /^Move /,
  });
  await move.focus();
  await move.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Move items from Box 1",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(move).toBeFocused();
  await move.press("Enter");
  await expect(
    dialog.getByLabel("Destination box", { exact: true }),
  ).toHaveValue("new");
  const amount = dialog
    .getByTestId("move-line-sample-line-1")
    .getByRole("spinbutton");
  await expect(amount).toHaveValue("1");
  const create = dialog.getByRole("button", {
    name: "Create box and move",
    exact: true,
  });
  for (const invalid of ["", "0", "0.5", "3"]) {
    await amount.fill(invalid);
    await expect(amount).toHaveAttribute("aria-invalid", "true");
    await expect(amount).toHaveAccessibleDescription(
      "Enter a whole number from 1 to 2.",
    );
    await expect(create).toBeDisabled();
    await expect(page.getByTestId("preview-box-2")).toHaveCount(0);
    await expect(
      packingRow(page, 1, "sample-line-1").getByText("2 of 2", { exact: true }),
    ).toHaveCount(1);
  }
  await amount.fill("2");
  await expect(create).toBeDisabled();
  await amount.fill("1");
  await expect(create).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(move).toBeFocused();
  await expect(page.getByTestId("preview-box-2")).toHaveCount(0);
  await expectBoxQuantity(page, 1, "sample-line-1", 2, 2);
  await moveLine(page, 1, "sample-line-1", "new", 1);
  await expectBoxQuantity(page, 1, "sample-line-1", 1, 2);
  await expectBoxQuantity(page, 2, "sample-line-1", 1, 2);
  await expectPackingLine(page, "sample-line-1", 2, 2);
  await enterCustomBoxDimensions(page, 1);
  await enterCustomBoxDimensions(page, 2);
  await expect(review).toBeEnabled();
  await expectNoCustomerWeights(page);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-direct-line-split.png"),
    fullPage: true,
  });
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

test("choosing a new box adjusts only the untouched whole-box default", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto(PORTAL_PATH);
  await useSampleSource(page);
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page
    .getByTestId("preview-line-sample-line-1")
    .getByRole("spinbutton")
    .fill("3");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  await moveLine(page, 1, "sample-line-1", "new", 1);
  const dialog = await openLineMove(page, 1, "sample-line-1");
  const destination = dialog.getByLabel("Destination box", { exact: true });
  const quantity = dialog
    .getByTestId("move-line-sample-line-1")
    .getByRole("spinbutton");
  await expect(destination).toHaveValue("box-2");
  await expect(quantity).toHaveValue("2");
  await destination.selectOption("new");
  await expect(quantity).toHaveValue("1");
  await expect(
    dialog.getByRole("button", { name: "Create box and move", exact: true }),
  ).toBeEnabled();
  await quantity.fill("2");
  await destination.selectOption("box-2");
  await destination.selectOption("new");
  await expect(quantity).toHaveValue("2");
  await expect(
    dialog.getByRole("button", { name: "Create box and move", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expectBoxQuantity(page, 1, "sample-line-1", 2, 3);
  await expectBoxQuantity(page, 2, "sample-line-1", 1, 3);
  await expect(page.getByTestId("preview-box-3")).toHaveCount(0);
  expect(fixture.failures).toEqual([]);
});
test("packing reaches the shared parcel cap with real contents and still permits moves between existing boxes", async ({
  page,
}) => {
  test.setTimeout(90_000);
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
  for (let count = 1; count < MAX_RETURN_FLOW_PARCELS; count += 1) {
    await moveLine(page, 1, "sample-line-1", "new", 1);
  }
  await expect(page.locator('[data-testid^="preview-box-"]')).toHaveCount(
    MAX_RETURN_FLOW_PARCELS,
  );
  await expectBoxQuantity(page, 1, "sample-line-1", 2, selectedQuantity);
  await expectPackingLine(
    page,
    "sample-line-1",
    selectedQuantity,
    selectedQuantity,
  );
  await expect(page.getByTestId("packing-summary-total")).toContainText(
    `${MAX_RETURN_FLOW_PARCELS} boxes`,
  );
  const dialog = await openLineMove(page, 1, "sample-line-1");
  await expectNoNewBoxDestination(page);
  await dialog
    .getByLabel("Destination box", { exact: true })
    .selectOption({ label: "Box 2" });
  await dialog
    .getByTestId("move-line-sample-line-1")
    .getByRole("spinbutton")
    .fill("1");
  await dialog.getByRole("button", { name: "Move items", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expectBoxQuantity(page, 1, "sample-line-1", 1, selectedQuantity);
  await expectBoxQuantity(page, 2, "sample-line-1", 2, selectedQuantity);
  await expect(page.locator('[data-testid^="preview-box-"]')).toHaveCount(
    MAX_RETURN_FLOW_PARCELS,
  );
  await expectPackingLine(
    page,
    "sample-line-1",
    selectedQuantity,
    selectedQuantity,
  );
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

test("bulk splits keep same-name purchased lines distinct and full moves can undo donor pruning exactly", async ({
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
  await expectBoxQuantity(page, 1, "sample-line-1", 2, 2);
  await expectBoxQuantity(page, 1, "sample-line-2", 1, 1);
  await expect(
    packingRow(page, 1, "sample-line-1").getByText(
      "Order item 1 · 100 count · Clear",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    packingRow(page, 1, "sample-line-2").getByText(
      "Order item 2 · 100 count · Clear",
      { exact: true },
    ),
  ).toBeVisible();
  await expectPackingSummaryFirst(page);
  await enterCustomBoxDimensions(page, 1, "12.125", "8", "4");
  const bulk = page.getByRole("button", {
    name: "Move items from box 1",
    exact: true,
  });
  await bulk.click();
  const dialog = page.getByRole("dialog", {
    name: "Move items from Box 1",
    exact: true,
  });
  await dialog
    .getByLabel("Destination box", { exact: true })
    .selectOption("new");
  const first = dialog.getByTestId("move-line-sample-line-1");
  const second = dialog.getByTestId("move-line-sample-line-2");
  await expect(first.getByRole("checkbox")).not.toBeChecked();
  await expect(second.getByRole("checkbox")).not.toBeChecked();
  const create = dialog.getByRole("button", {
    name: "Create box and move",
    exact: true,
  });
  await expect(create).toBeDisabled();
  await first
    .getByRole("checkbox", {
      name: "Select item 1: Sample collector sleeves (100 count · Clear) to move",
      exact: true,
    })
    .check();
  await first.getByRole("spinbutton").fill("1");
  await second
    .getByRole("checkbox", {
      name: "Select item 2: Sample collector sleeves (100 count · Clear) to move",
      exact: true,
    })
    .check();
  await second.getByRole("spinbutton").fill("1");
  await expect(create).toBeEnabled();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-bulk-split-dialog.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(bulk).toBeFocused();
  await expect(page.locator('[data-testid^="preview-box-"]')).toHaveCount(1);
  await expectBoxQuantity(page, 1, "sample-line-1", 2, 2);
  await expectBoxQuantity(page, 1, "sample-line-2", 1, 1);
  await expect(
    page.getByLabel("Length of box 1 in inches", { exact: true }),
  ).toHaveValue("12.125");
  expect(
    fixture.previewRequests.some((request) => request.path.endsWith("/review")),
  ).toBe(false);
  await bulk.click();
  await dialog
    .getByLabel("Destination box", { exact: true })
    .selectOption("new");
  await first.getByRole("checkbox").check();
  await first.getByRole("spinbutton").fill("1");
  await second.getByRole("checkbox").check();
  await second.getByRole("spinbutton").fill("1");
  await create.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Box 2", exact: true }),
  ).toBeFocused();
  await expectBoxQuantity(page, 1, "sample-line-1", 1, 2);
  await expect(packingRow(page, 1, "sample-line-2")).toHaveCount(0);
  await expectBoxQuantity(page, 2, "sample-line-1", 1, 2);
  await expectBoxQuantity(page, 2, "sample-line-2", 1, 1);
  await enterCustomBoxDimensions(page, 2, "11", "7", "5");
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toHaveCount(0);
  await moveLine(page, 1, "sample-line-1", 2, 1);
  await expect(page.locator('[data-testid^="preview-box-"]')).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Box 1", exact: true }),
  ).toBeFocused();
  await expectBoxQuantity(page, 1, "sample-line-1", 2, 2);
  await expectBoxQuantity(page, 1, "sample-line-2", 1, 1);
  await expect(
    page.getByLabel("Length of box 1 in inches", { exact: true }),
  ).toHaveValue("11");
  await expect(
    page.getByLabel("Width of box 1 in inches", { exact: true }),
  ).toHaveValue("7");
  await expect(
    page.getByLabel("Height of box 1 in inches", { exact: true }),
  ).toHaveValue("5");
  await page
    .getByRole("status")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect(page.locator('[data-testid^="preview-box-"]')).toHaveCount(2);
  await expectBoxQuantity(page, 1, "sample-line-1", 1, 2);
  await expect(packingRow(page, 1, "sample-line-2")).toHaveCount(0);
  await expectBoxQuantity(page, 2, "sample-line-1", 1, 2);
  await expectBoxQuantity(page, 2, "sample-line-2", 1, 1);
  await expect(
    page.getByLabel("Length of box 1 in inches", { exact: true }),
  ).toHaveValue("12.125");
  await expect(
    page.getByLabel("Width of box 1 in inches", { exact: true }),
  ).toHaveValue("8");
  await expect(
    page.getByLabel("Height of box 1 in inches", { exact: true }),
  ).toHaveValue("4");
  await expect(
    page.getByLabel("Length of box 2 in inches", { exact: true }),
  ).toHaveValue("11");
  await expect(
    page.getByLabel("Width of box 2 in inches", { exact: true }),
  ).toHaveValue("7");
  await expect(
    page.getByLabel("Height of box 2 in inches", { exact: true }),
  ).toHaveValue("5");
  await packingRow(page, 2, "sample-line-2")
    .getByRole("button", {
      name: "Remove item 2: Sample collector sleeves (100 count · Clear) from box 2",
      exact: true,
    })
    .click();
  await expect(packingRow(page, 2, "sample-line-2")).toHaveCount(0);
  await expect(
    page
      .getByTestId("unassigned-item-sample-line-2")
      .getByText("1 to pack", { exact: true }),
  ).toBeVisible();
  await expectPackingLine(page, "sample-line-1", 2, 2);
  await expectPackingLine(page, "sample-line-2", 1, 0);
  const readd = await openUnassigned(page, "sample-line-2");
  await readd
    .getByLabel("Destination box", { exact: true })
    .selectOption({ label: "Box 2" });
  await expect(
    readd.getByTestId("move-line-sample-line-2").getByRole("spinbutton"),
  ).toHaveValue("1");
  await readd.getByRole("button", { name: "Move items", exact: true }).click();
  await expect(readd).toHaveCount(0);
  await expect(page.getByTestId("unassigned-item-sample-line-2")).toHaveCount(
    0,
  );
  await expectBoxQuantity(page, 2, "sample-line-2", 1, 1);
  await expectPackingLine(page, "sample-line-1", 2, 2);
  await expectPackingLine(page, "sample-line-2", 1, 1);
  await expectNoCustomerWeights(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-split-undo-restored.png"),
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
      {
        dimensions: { lengthMm: 307.975, widthMm: 203.2, heightMm: 101.6 },
        items: [{ lineId: "sample-line-1", quantity: 1 }],
      },
      {
        dimensions: { lengthMm: 279.4, widthMm: 177.8, heightMm: 127 },
        items: [
          { lineId: "sample-line-1", quantity: 1 },
          { lineId: "sample-line-2", quantity: 1 },
        ],
      },
    ],
  });
  expect(fixture.failures).toEqual([]);
});

test("removing a populated box moves its locked contents only after confirmation", async ({
  page,
}) => {
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto(PORTAL_PATH);
  await useSampleSource(page);
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page
    .getByTestId("preview-line-sample-line-1")
    .getByRole("spinbutton")
    .fill("3");
  await page
    .getByTestId("preview-line-sample-line-3")
    .getByRole("spinbutton")
    .fill("1");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  await moveLine(page, 1, "sample-line-1", "new", 1);
  const remove = page.getByRole("button", {
    name: "Remove box 1",
    exact: true,
  });
  await remove.click();
  const dialog = page.getByRole("dialog", {
    name: "Remove Box 1",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expectNoNewBoxDestination(page);
  for (const [lineId, quantity] of [
    ["sample-line-1", "2"],
    ["sample-line-3", "1"],
  ]) {
    const row = dialog.getByTestId(`move-line-${lineId}`);
    await expect(row.getByRole("checkbox")).toBeChecked();
    await expect(row.getByRole("checkbox")).toBeDisabled();
    await expect(row.getByRole("spinbutton")).toHaveValue(quantity);
    await expect(row.getByRole("spinbutton")).toBeDisabled();
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();
  await expect(page.locator('[data-testid^="preview-box-"]')).toHaveCount(2);
  await expectBoxQuantity(page, 1, "sample-line-1", 2, 3);
  await remove.click();
  await dialog
    .getByLabel("Destination box", { exact: true })
    .selectOption({ label: "Box 2" });
  await dialog
    .getByRole("button", { name: "Remove box and move items", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-testid^="preview-box-"]')).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Box 1", exact: true }),
  ).toBeFocused();
  await expectBoxQuantity(page, 1, "sample-line-1", 3, 3);
  await expectBoxQuantity(page, 1, "sample-line-3", 1, 1);
  await expect(page.getByTestId("packing-unassigned")).toHaveCount(0);
  await expectPackingLine(page, "sample-line-1", 3, 3);
  await expectPackingLine(page, "sample-line-3", 1, 1);
  await page
    .getByRole("status")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect(page.locator('[data-testid^="preview-box-"]')).toHaveCount(2);
  await expectBoxQuantity(page, 1, "sample-line-1", 2, 3);
  await expectBoxQuantity(page, 1, "sample-line-3", 1, 1);
  await expectBoxQuantity(page, 2, "sample-line-1", 1, 3);
  expect(
    fixture.previewRequests.some((request) => request.path.endsWith("/review")),
  ).toBe(false);
  expect(fixture.failures).toEqual([]);
});

test("desktop dragging only prepares the same move dialog and rejects external or canceled drops", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Native pointer drag is covered in the desktop project.",
  );
  const fixture = await installReturnPreviewFixtures(page);
  await page.goto(PORTAL_PATH);
  await useSampleSource(page);
  await page.getByRole("button", { name: "Find order", exact: true }).click();
  await page
    .getByTestId("preview-line-sample-line-1")
    .getByRole("spinbutton")
    .fill("3");
  await page
    .getByTestId("preview-line-sample-line-2")
    .getByRole("spinbutton")
    .fill("1");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  await moveLine(page, 1, "sample-line-1", "new", 1);
  const target = page.getByTestId("preview-box-2");
  const handle = packingRow(page, 1, "sample-line-2").getByRole("button", {
    name: /^Drag /,
  });
  await expect(handle).toBeVisible();
  const external = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.setData(
      "application/x-echelon-return-item",
      JSON.stringify({ sourceParcelKey: 1, lineId: "sample-line-2" }),
    );
    return data;
  });
  await target.dispatchEvent("dragover", { dataTransfer: external });
  await target.dispatchEvent("drop", { dataTransfer: external });
  await external.dispose();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(packingRow(page, 2, "sample-line-2")).toHaveCount(0);
  await handle.dragTo(page.getByTestId("preview-box-1"));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await handle.dragTo(page.getByTestId("packing-summary"));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectBoxQuantity(page, 1, "sample-line-2", 1, 1);
  await handle.dragTo(target);
  const dialog = page.getByRole("dialog", {
    name: "Move items from Box 1",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByLabel("Destination box", { exact: true }),
  ).toHaveValue("box-2");
  await expect(
    dialog.getByTestId("move-line-sample-line-2").getByRole("checkbox"),
  ).toBeChecked();
  await expect(
    packingRow(page, 1, "sample-line-2").getByText("1 of 1", { exact: true }),
  ).toHaveCount(1);
  await expect(packingRow(page, 2, "sample-line-2")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(handle).toBeFocused();
  await handle.dragTo(target);
  await dialog.getByRole("button", { name: "Move items", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(packingRow(page, 1, "sample-line-2")).toHaveCount(0);
  await expectBoxQuantity(page, 2, "sample-line-2", 1, 1);
  const splitHandle = packingRow(page, 1, "sample-line-1").getByRole("button", {
    name: /^Drag /,
    // A successful drop opens a modal and aria-hides the native drag origin.
    includeHidden: true,
  });
  await expect(splitHandle).toBeVisible();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await splitHandle.dispatchEvent("dragstart", { dataTransfer });
  const newBox = page.getByTestId("packing-new-box-drop");
  await expect(newBox).toBeVisible();
  await newBox.dispatchEvent("dragover", { dataTransfer });
  await newBox.dispatchEvent("drop", { dataTransfer });
  await splitHandle.dispatchEvent("dragend", { dataTransfer });
  await dataTransfer.dispose();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByLabel("Destination box", { exact: true }),
  ).toHaveValue("new");
  await expect(page.getByTestId("preview-box-3")).toHaveCount(0);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-drag-new-box-confirmation.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("preview-box-3")).toHaveCount(0);
  await expect(page.getByTestId("packing-new-box-drop")).toHaveCount(0);
  await expectBoxQuantity(page, 1, "sample-line-1", 2, 3);
  await expectBoxQuantity(page, 2, "sample-line-1", 1, 3);
  await expectPackingLine(page, "sample-line-1", 3, 3);
  await expectPackingLine(page, "sample-line-2", 1, 1);
  expect(
    fixture.previewRequests.some((request) => request.path.endsWith("/review")),
  ).toBe(false);
  expect(fixture.failures).toEqual([]);
});

test.describe("touch packing controls", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("touch customers can split and cancel using visible controls without dragging", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile",
      "Touch emulation is covered once in the mobile project.",
    );
    const fixture = await installReturnPreviewFixtures(page);
    await page.goto(PORTAL_PATH);
    await useSampleSource(page);
    await page.getByRole("button", { name: "Find order", exact: true }).tap();
    await page
      .getByTestId("preview-line-sample-line-1")
      .getByRole("spinbutton")
      .fill("2");
    await page
      .getByRole("button", { name: "Continue to packing", exact: true })
      .tap();
    await expectPackingSummaryFirst(page);
    const row = packingRow(page, 1, "sample-line-1");
    await expect(
      row.getByRole("button", { name: /^Drag /, includeHidden: true }),
    ).toBeHidden();
    const move = row.getByRole("button", { name: /^Move / });
    await move.tap();
    const dialog = page.getByRole("dialog", {
      name: "Move items from Box 1",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel("Destination box", { exact: true })
      .selectOption("new");
    await expect(
      dialog.getByTestId("move-line-sample-line-1").getByRole("spinbutton"),
    ).toHaveValue("1");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).tap();
    await expect(dialog).toHaveCount(0);
    await expect(move).toBeFocused();
    await expect(page.getByTestId("preview-box-2")).toHaveCount(0);
    await move.tap();
    await dialog
      .getByRole("button", { name: "Create box and move", exact: true })
      .tap();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Box 2", exact: true }),
    ).toBeFocused();
    await expectBoxQuantity(page, 1, "sample-line-1", 1, 2);
    await expectBoxQuantity(page, 2, "sample-line-1", 1, 2);
    await expectPackingLine(page, "sample-line-1", 2, 2);
    await expectNoCustomerWeights(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("packing-touch-direct-split.png"),
      fullPage: true,
    });
    expect(fixture.failures).toEqual([]);
  });
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
  const packingItem = packingRow(page, 1, "sample-line-1");
  await expectBoxQuantity(
    page,
    1,
    "sample-line-1",
    maximumQuantity,
    maximumQuantity,
  );
  const packingCount = packingItem.getByText(
    `${maximumQuantity} of ${maximumQuantity}`,
    { exact: true },
  );
  const packingGeometry = await packingCount.evaluate((element) => {
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

  const dialog = await openLineMove(page, 1, "sample-line-1");
  await expect(
    dialog.getByLabel("Destination box", { exact: true }),
  ).toHaveValue("new");
  const amount = dialog
    .getByTestId("move-line-sample-line-1")
    .getByRole("spinbutton");
  await expect(amount).toHaveValue("1");
  await expect(amount).toHaveAttribute("max", String(maximumQuantity));
  await amount.fill(String(maximumQuantity - 1));
  await expect(amount).toHaveValue(String(maximumQuantity - 1));
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("packing-maximum-quantity-move.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Create box and move", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expectBoxQuantity(page, 1, "sample-line-1", 1, maximumQuantity);
  await expectBoxQuantity(
    page,
    2,
    "sample-line-1",
    maximumQuantity - 1,
    maximumQuantity,
  );
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
  await expectBoxQuantity(page, 1, "sample-line-1", 1, 1);
  await expect(
    page.getByRole("heading", { name: "Review your return", exact: true }),
  ).toHaveCount(0);
  expect(fixture.failures).toEqual([]);
});
