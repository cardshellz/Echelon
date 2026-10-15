import { expect, test, type Page } from "@playwright/test";
import { installQuarantineFixtures } from "./procurement-quarantine-fixtures";

async function ready(page: Page) {
  await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-31/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record quarantine", exact: true })).toBeEnabled();
}
async function location(page: Page, label: string, code: string) {
  const trigger = page.getByRole("combobox", { name: label, exact: true });
  const option = page.getByRole("option", { name: new RegExp(code) });
  await trigger.click();
  await option.click();
  await expect(trigger).toContainText(code);
  // The closing popover remains mounted during its exit animation. Wait for it
  // to leave before interacting with the checkbox immediately below the trigger.
  await expect(option).toHaveCount(0);
}
async function unknownIntake(page: Page) {
  await ready(page);
  await page.getByRole("button", { name: "Record quarantine", exact: true }).click();
  await page.getByLabel("Goods description", { exact: true }).fill("Unidentified sealed cartons");
  await page.getByLabel("Observed SKU or barcode (optional)", { exact: true }).fill("UNKNOWN-SKU");
  await page.getByLabel("Observed held quantity", { exact: true }).fill("3");
  await page.getByLabel("Observed unit", { exact: true }).fill("sealed cartons");
  await location(page, "Quarantine holding location", "HOLD-01");
  await page.getByLabel("Reason for holding", { exact: true }).fill("Unidentified delivery");
  await page.getByLabel("Observation evidence reference", { exact: true }).fill("PHOTO-101");
}
async function acceptance(page: Page) {
  await page.getByRole("button", { name: "Prepare acceptance", exact: true }).click();
  await page.getByLabel("Observed quantity to accept (sealed cartons)", { exact: true }).fill("1");
  await expect(page.getByRole("combobox", { name: "Reviewed receipt source", exact: true })).toBeEnabled();
  await page.getByRole("combobox", { name: "Reviewed receipt source", exact: true }).selectOption("7");
  await page.getByLabel("Accepted quantity in the selected receive unit", { exact: true }).fill("2");
  await location(page, "Accepted goods putaway location", "RCV-01");
  await page.getByLabel("I verified the observed quantity, product, source and exact mapping to the selected receive unit.", { exact: true }).check();
  await page.getByLabel("Resolution reason", { exact: true }).fill("Opened and counted against reviewed purchase source");
}

test("unknown goods record physical custody without a product or inventory receipt", async ({ page }) => {
  const { state, failures } = await installQuarantineFixtures(page);
  await unknownIntake(page);
  await page.getByRole("button", { name: "Record held goods", exact: true }).click();
  await expect(page.getByText("Held goods recorded in quarantine and unavailable for sale.", { exact: true })).toBeVisible();
  expect(state.commands).toHaveLength(1);
  expect(state.commands[0].body).toEqual({ kind: "unidentified", quantity: 3, unitLabel: "sealed cartons", description: "Unidentified sealed cartons",
    observedSku: "UNKNOWN-SKU", holdingLocationId: 6, condition: "unexpected", reason: "Unidentified delivery", evidenceReference: "PHOTO-101" });
  expect(state.order.lines[0].receivedQty).toBe(4);
  await expect(page.getByRole("region", { name: "Quarantine observation 41" })).toContainText("3 sealed cartons held");
  await expect(page.getByTestId("btn-complete-all")).toBeDisabled();
  expect(failures).toEqual([]);
});

test("known goods require an explicit accepted and held recount and frozen source version", async ({ page }) => {
  const { state, failures } = await installQuarantineFixtures(page);
  await ready(page);
  await page.getByRole("button", { name: "Record quarantine", exact: true }).click();
  await page.getByLabel("Goods being held", { exact: true }).selectOption("receipt_line");
  await page.getByLabel("Receipt line", { exact: true }).selectOption("7");
  await expect(page.getByLabel("Accepted receive units", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Held receive units", { exact: true })).toHaveValue("");
  await page.getByLabel("Accepted receive units", { exact: true }).fill("2");
  await page.getByLabel("Held receive units", { exact: true }).fill("2");
  await page.getByLabel("Condition", { exact: true }).selectOption("damaged");
  await location(page, "Quarantine holding location", "HOLD-01");
  await page.getByLabel("Reason for holding", { exact: true }).fill("Damaged cartons inspected");
  await page.getByLabel("Observation evidence reference", { exact: true }).fill("INSPECT-42");
  await page.getByRole("button", { name: "Record held goods", exact: true }).click();
  expect(state.commands).toHaveLength(0);
  await page.getByLabel("I recounted both groups in the recorded receive unit. Accepted goods exclude these held goods.", { exact: true }).check();
  await page.getByRole("button", { name: "Record held goods", exact: true }).click();
  await expect(page.getByText("Held goods recorded in quarantine and unavailable for sale.", { exact: true })).toBeVisible();
  expect(state.commands[0].body).toMatchObject({ kind: "receipt_line", receivingLineId: 7, expectedUnitVersion: "a".repeat(64), acceptedQty: 2, heldQty: 2, countsReviewed: true });
  await expect(page.locator('input[aria-label="Received count for line 7"]:visible')).toHaveValue("2");
  expect(failures).toEqual([]);
});

for (const mode of ["lost", "invalid"] as const) test(`${mode} quarantine response keeps the exact command and blocks ordinary mutations`, async ({ page }) => {
  const { state, failures } = await installQuarantineFixtures(page, { lostOnce: mode === "lost", invalidOnce: mode === "invalid" });
  await unknownIntake(page);
  await page.getByRole("button", { name: "Record held goods", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry saved quarantine command", exact: true })).toBeVisible();
  await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
  await expect(page.getByTestId("btn-add-line")).toBeDisabled();
  await expect(page.locator('input[aria-label="Received count for line 7"]:visible')).toBeDisabled();
  await expect(page.getByText("Held goods recorded in quarantine and unavailable for sale.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry saved quarantine command", exact: true }).click();
  await expect(page.getByText("Held goods recorded in quarantine and unavailable for sale.", { exact: true })).toBeVisible();
  expect(state.commands).toHaveLength(2);
  expect(state.commands[1]).toEqual(state.commands[0]);
  expect(state.view.observations).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("lost command survives navigation and is recovered on its original receipt only", async ({ page }) => {
  const { state, failures } = await installQuarantineFixtures(page, { lostOnce: true });
  await unknownIntake(page);
  await page.getByRole("button", { name: "Record held goods", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry saved quarantine command", exact: true })).toBeVisible();
  await page.goto("/receiving?open=32");
  await expect(page.getByRole("heading", { name: /Receipt OTHER-RECEIPT/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry saved quarantine command", exact: true })).toHaveCount(0);
  await page.goto("/receiving?open=31");
  await page.getByRole("button", { name: "Retry saved quarantine command", exact: true }).click();
  await expect(page.getByText("Held goods recorded in quarantine and unavailable for sale.", { exact: true })).toBeVisible();
  expect(state.commands).toHaveLength(2); expect(state.commands[1]).toEqual(state.commands[0]);
  expect(failures).toEqual([]);
});

test("an intake response after leaving cannot replace the next receipt", async ({ page }) => {
  const { state, failures, release } = await installQuarantineFixtures(page, { delayed: true });
  await unknownIntake(page);
  await page.getByRole("button", { name: "Record held goods", exact: true }).click();
  await expect.poll(() => state.commands.length).toBe(1);
  await page.evaluate(() => { history.pushState(null, "", "/receiving?open=32"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByRole("heading", { name: /Receipt OTHER-RECEIPT/ })).toBeVisible();
  release();
  await expect.poll(() => state.view.observations.length).toBe(1);
  await expect(page.getByRole("heading", { name: /Receipt OTHER-RECEIPT/ })).toBeVisible();
  await expect(page.getByText("Held goods recorded in quarantine and unavailable for sale.", { exact: true })).toHaveCount(0);
  await page.evaluate(() => { history.pushState(null, "", "/receiving?open=31"); dispatchEvent(new PopStateEvent("popstate")); });
  await page.getByRole("button", { name: "Retry saved quarantine command", exact: true }).click();
  await expect(page.getByText("Held goods recorded in quarantine and unavailable for sale.", { exact: true })).toBeVisible();
  expect(state.commands[1]).toEqual(state.commands[0]); expect(failures).toEqual([]);
});

test("stale source rejection requires readback before another reviewed command", async ({ page }) => {
  const { state, failures } = await installQuarantineFixtures(page, { rejected: true });
  await unknownIntake(page);
  await page.getByRole("button", { name: "Record held goods", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Receipt counts changed" })).toBeVisible();
  await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
  await page.getByRole("button", { name: "Load latest receipt and review rejected command", exact: true }).click();
  await expect(page.getByRole("button", { name: "Record quarantine", exact: true })).toBeEnabled();
  expect(state.commands).toHaveLength(1); expect(state.view.observations).toEqual([]);
  expect(state.reads).toBeGreaterThan(1); expect(failures).toEqual([]);
});

test("pending intake locks normal receipt count, warehouse and finalization controls", async ({ page }) => {
  const { state, failures, release } = await installQuarantineFixtures(page, { delayed: true });
  await unknownIntake(page);
  await page.getByRole("button", { name: "Record held goods", exact: true }).click();
  await expect.poll(() => state.commands.length).toBe(1);
  await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Receiving warehouse", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Default receiving location", exact: true })).toBeDisabled();
  await expect(page.locator('input[aria-label="Received count for line 7"]:visible')).toBeDisabled();
  release();
  await expect(page.getByText("Held goods recorded in quarantine and unavailable for sale.", { exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test("holding location choices exclude inactive, external and other-warehouse locations", async ({ page }) => {
  const { failures } = await installQuarantineFixtures(page);
  await ready(page); await page.getByRole("button", { name: "Record quarantine", exact: true }).click();
  await page.getByRole("combobox", { name: "Quarantine holding location", exact: true }).click();
  await expect(page.getByRole("option", { name: /HOLD-01/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /OTHER-01/ })).toHaveCount(0);
  await expect(page.getByRole("option", { name: /CLOSED-01/ })).toHaveCount(0);
  await expect(page.getByRole("option", { name: /EXTERNAL-01/ })).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("partial acceptance uses a reviewed source and remains held until normal receipt", async ({ page }, testInfo) => {
  const { state, failures } = await installQuarantineFixtures(page, { existing: true, closed: true });
  await ready(page); await acceptance(page);
  await page.getByRole("button", { name: "Load more receipt sources", exact: true }).click();
  await expect.poll(() => state.optionReads.length).toBe(2);
  await page.getByRole("button", { name: "Prepare receipt acceptance", exact: true }).click();
  await expect(page.getByText(/Pending acceptance prepared on PENDING-32/)).toBeVisible();
  expect(state.commands[0].body).toMatchObject({ expectedVersion: 0, observationQty: 1, acceptedVariantQty: 2,
    targetSourceReceivingLineId: 7, expectedTargetUnitVersion: "a".repeat(64), targetReceivingOrderId: null,
    productVariantId: 2, expectedUnitsPerVariant: 10, purchaseOrderLineId: 9, inboundShipmentLineId: null, putawayLocationId: 5, countConversionReviewed: true });
  await expect(page.getByRole("region", { name: "Quarantine observation 41" })).toContainText("3 sealed cartons held");
  await expect(page.getByRole("link", { name: "PENDING-32", exact: true })).toHaveAttribute("href", "/receiving?open=32");
  expect(state.view.observations[0].awaitingReceiptQty).toBe(1);
  expect(state.view.observations[0].unallocatedQty).toBe(2);
  await expect.poll(() => page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.getByTestId("receiving-quarantine-panel").screenshot({ path: testInfo.outputPath("quarantine-custody.png") });
  expect(failures).toEqual([]);
});

test("cancel pending acceptance restores unresolved custody then physical return keeps evidence", async ({ page }) => {
  const { state, failures } = await installQuarantineFixtures(page, { existing: true });
  await ready(page); await acceptance(page);
  await page.getByRole("button", { name: "Prepare receipt acceptance", exact: true }).click();
  await expect(page.getByText(/Pending acceptance prepared on TEST-RECEIPT-31/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel pending acceptance", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel pending acceptance", exact: true }).click();
  const cancelForm = page.getByRole("form", { name: "Cancel pending acceptance", exact: true });
  await cancelForm.getByLabel("Resolution reason", { exact: true }).fill("Source must be reviewed again");
  await cancelForm.getByRole("button", { name: "Cancel pending acceptance", exact: true }).click();
  await expect(page.getByText("Pending acceptance cancelled. The goods remain held in quarantine.", { exact: true })).toBeVisible();
  expect(state.commands[1].body).toMatchObject({ expectedVersion: 1, acceptanceId: 61 });
  await page.getByRole("button", { name: "Record physical return", exact: true }).click();
  const returnForm = page.getByRole("form", { name: "Record physical return", exact: true });
  await returnForm.getByLabel("Observed quantity to return (sealed cartons)", { exact: true }).fill("1");
  await returnForm.getByLabel("Physical return evidence reference", { exact: true }).fill("RETURN-DOCKET-56");
  await returnForm.getByLabel("Resolution reason", { exact: true }).fill("Collected by the supplier carrier");
  await returnForm.getByRole("button", { name: "Record physical return", exact: true }).click();
  await expect(page.getByText("Physical return recorded. This does not record a supplier credit or payment recovery.", { exact: true })).toBeVisible();
  expect(state.commands[2].body).toMatchObject({ expectedVersion: 2, observationQty: 1, evidenceReference: "RETURN-DOCKET-56" });
  expect(state.view.observations[0].physicalHeldQty).toBe(2);
  expect(failures).toEqual([]);
});

test("a target receipt shows held custody and links resolution to its originating receipt", async ({ page }) => {
  const { state, failures } = await installQuarantineFixtures(page, { existing: true, closed: true });
  await ready(page); await acceptance(page);
  await page.getByRole("button", { name: "Prepare receipt acceptance", exact: true }).click();
  await page.getByRole("link", { name: "PENDING-32", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Receipt OTHER-RECEIPT/ })).toBeVisible();
  const observation = page.getByRole("region", { name: "Quarantine observation 41" });
  await expect(observation).toContainText("3 sealed cartons held");
  await expect(observation).toContainText("Recorded on receipt #31");
  await expect(observation.getByRole("button", { name: "Prepare acceptance", exact: true })).toHaveCount(0);
  await expect(observation.getByRole("button", { name: "Cancel pending acceptance", exact: true })).toHaveCount(0);
  await observation.getByText("Custody history", { exact: true }).click();
  await expect(observation).toContainText("Observed 3 sealed cartons by receiver");
  await observation.getByRole("link", { name: "Resolve custody on receipt #31", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-31/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel pending acceptance", exact: true })).toBeEnabled();
  expect(state.commands).toHaveLength(1); expect(failures).toEqual([]);
});

test("server capabilities keep custody visible without unauthorized actions", async ({ page }) => {
  const { state, failures } = await installQuarantineFixtures(page, { existing: true, closed: true, denied: true });
  await expect(page.getByRole("region", { name: "Quarantine observation 41" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record quarantine", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Prepare acceptance", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Record physical return", exact: true })).toBeDisabled();
  expect(state.commands).toEqual([]); expect(failures).toEqual([]);
});

test("malformed source options cannot become an acceptance command", async ({ page }) => {
  const { state, failures } = await installQuarantineFixtures(page, { existing: true, optionsInvalid: true });
  await ready(page); await page.getByRole("button", { name: "Prepare acceptance", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Receipt source options were incomplete" })).toBeVisible();
  await page.getByRole("button", { name: "Prepare receipt acceptance", exact: true }).click();
  expect(state.commands).toEqual([]); expect(failures).toEqual([]);
});
