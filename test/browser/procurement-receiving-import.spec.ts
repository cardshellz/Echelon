import { expect, test, type Page } from "@playwright/test";
import { installFixtures, receipt } from "./procurement-fixtures";
import { openReceivingMoreActions } from "./procurement-receiving-helpers";

type ImportMode = "ambiguous" | "existing" | "changed" | "malformed" | "lost" | "invalid_count" | "partial" | "success";
async function setup(page: Page, mode: ImportMode, options: { beforeResponse?: () => Promise<void>; startFromList?: boolean } = {}) {
  const failures = await installFixtures(page);
  const requests: Array<{ lines: Array<Record<string, unknown>> }> = [];
  const order = { ...receipt(31), sourceType: "blind", purchaseOrderId: null, inboundShipmentId: null,
    status: "draft", warehouseId: 1, receivingLocationId: null, lines: [] };
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/receiving") return route.fulfill({ json: [order, { ...order, id: 32, receiptNumber: "TEST-RECEIPT-32" }] });
    if (request.method() === "GET" && /^\/api\/receiving\/(31|32)$/.test(path)) {
      const id = Number(path.split("/").at(-1));
      return route.fulfill({ json: { ...order, id, receiptNumber: `TEST-RECEIPT-${id}` } });
    }
    if (request.method() === "GET" && path === "/api/warehouses") return route.fulfill({ json: [{ id: 1, code: "W1", name: "Main" }] });
    if (request.method() !== "POST" || path !== "/api/receiving/31/lines/bulk") return route.fallback();
    requests.push(request.postDataJSON());
    if (options.beforeResponse) await options.beforeResponse();
    if (mode === "success" || requests.length > 1) return route.fulfill({ status: 201, json: { success: true, created: 1, updated: mode === "partial" ? 1 : 0 } });
    if (mode === "lost") return route.abort("connectionreset");
    if (mode === "malformed") return route.fulfill({ status: 201, json: { success: true, created: -1 } });
    if (mode === "changed") return route.fulfill({ status: 409, json: {
      error: "Receiving lines changed while the import was being prepared. Review the current receipt and retry.",
      code: "RECEIVING_IMPORT_SNAPSHOT_CHANGED",
    } });
    if (mode === "partial") return route.fulfill({ status: 201, json: { success: true, created: 1, updated: 0, errors: ["Data row 2, SKU BAD: qty must contain a whole count"] } });
    if (mode === "invalid_count") return route.fulfill({ status: 201, json: { success: true, created: 0, updated: 0,
      errors: ["Data row 1, SKU CASE: qty must contain a whole count"] } });
    return route.fulfill({ status: 409, json: {
      error: "No lines were imported. Resolve the ambiguous CSV rows and retry.", code: "RECEIVING_IMPORT_IDENTITY_REVIEW_REQUIRED",
      rowErrors: [{ row: 1, code: mode === "existing" ? "RECEIVING_IMPORT_AMBIGUOUS_EXISTING_LINE" : "RECEIVING_IMPORT_DUPLICATE_IDENTITY",
        message: mode === "existing"
          ? "Data row 1: SKU CASE matches multiple receipt lines (7, 8). Update those lines individually."
          : "Data row 1: SKU CASE repeats data row 2 at this location. Enter one total count for this SKU/location." }],
    } });
  });
  if (options.startFromList) {
    await page.goto("/receiving");
    await page.locator("a:visible").filter({ hasText: /^TEST-RECEIPT-31$/ }).click();
  } else await page.goto("/receiving?open=31");
  await openReceivingMoreActions(page);
  await page.getByTestId("btn-import-csv").click();
  const dialog = page.getByRole("dialog", { name: "Import from CSV" });
  await expect(dialog).toBeVisible();
  return { requests, failures, dialog };
}

test("receiving duplicate CSV rejection preserves rows and permits an explicit corrected retry", async ({ page }) => {
  const { requests, failures, dialog } = await setup(page, "ambiguous");
  await expect(dialog).toContainText("total counts");
  await expect(dialog).toContainText("Separate physical lines must be edited individually");
  const csv = "sku,qty,location\nCASE,5,DOCK\ncase,7,DOCK";
  await page.getByTestId("textarea-csv").fill(csv);
  await page.getByTestId("btn-import").click();
  await expect(page.getByTestId("csv-import-error")).toContainText("No lines were imported");
  await expect(page.getByTestId("csv-import-error")).toContainText("Data row 1");
  await expect(page.getByTestId("textarea-csv")).toHaveValue(csv);
  expect(requests[0].lines.map((row) => row.qty)).toEqual(["5", "7"]);
  // The recovery message must not put a pointer-intercepting toast over the
  // same dialog's retry button (the hosted desktop failure).
  expect(await page.getByLabel("Notifications (F8)").textContent()).not.toContain("Import was not confirmed");
  await page.getByTestId("textarea-csv").fill("sku,qty,location\nCASE,12,DOCK");
  await page.getByTestId("btn-import").click();
  await expect(dialog).toBeHidden();
  expect(requests).toHaveLength(2);
  expect(requests[1].lines).toEqual([expect.objectContaining({ sku: "CASE", qty: "12", location: "DOCK" })]);
  expect(failures).toEqual([]);
});

for (const mode of ["existing", "changed", "malformed"] as const) {
  test(`receiving ${mode} response keeps CSV input and actionable recovery visible`, async ({ page }) => {
    const { failures, dialog } = await setup(page, mode);
    const csv = "sku,qty\nCASE,5";
    await page.getByTestId("textarea-csv").fill(csv);
    await page.getByTestId("btn-import").click();
    await expect(page.getByTestId("csv-import-error")).toContainText(mode === "existing" ? "Update those lines individually" : mode === "changed" ? "Review the current receipt and retry" : "may have saved");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("textarea-csv")).toHaveValue(csv);
    await expect(page.getByTestId("btn-import")).toBeEnabled();
    expect(failures).toEqual([]);
  });
}

test("receiving fractional counts reach validation unchanged and never report imported stock", async ({ page }) => {
  const { requests, failures } = await setup(page, "invalid_count");
  await page.getByTestId("textarea-csv").fill("sku,qty,damaged_qty\nCASE,1.5,12junk");
  await page.getByTestId("btn-import").click();
  await expect(page.getByRole("dialog").filter({ hasText: "Data row 1, SKU CASE" })).toBeVisible();
  expect(requests[0].lines[0]).toMatchObject({ qty: "1.5", damaged_qty: "12junk" });
  expect(failures).toEqual([]);
});

test("partial import preserves correction input and explains saved versus failed rows before explicit retry", async ({ page }) => {
  const { requests, failures, dialog } = await setup(page, "partial");
  const csv = "sku,qty\nGOOD,5\nBAD,1.5";
  await page.getByTestId("textarea-csv").fill(csv);
  await page.getByTestId("btn-import").click();
  const results = page.getByRole("dialog", { name: "Import Results" });
  await expect(results).toContainText("Saved rows: 1. Rows not imported: 1.");
  await expect(results).toContainText("it does not add the count again");
  expect(await page.getByLabel("Notifications (F8)").textContent()).not.toContain("Import partially saved");
  await page.getByTestId("btn-review-import-csv").click();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("textarea-csv")).toHaveValue(csv);
  expect(requests).toHaveLength(1);
  await page.getByTestId("textarea-csv").fill("sku,qty\nGOOD,5\nBAD,2");
  await page.getByTestId("btn-import").click();
  await expect(dialog).toBeHidden();
  expect(requests).toHaveLength(2);
  expect(requests[1].lines.map((row) => [row.sku, row.qty])).toEqual([["GOOD", "5"], ["BAD", "2"]]);
  expect(failures).toEqual([]);
});

for (const sample of [
  { name: "surplus cells", csv: "sku,qty\nCASE,1,000", message: "CSV data row 1 has 3 columns; the header has 2" },
  { name: "missing cells", csv: "sku,qty\nCASE", message: "CSV data row 1 has 1 column; the header has 2" },
  { name: "duplicate aliases", csv: "sku,qty,quantity\nCASE,1,1000", message: "CSV header repeats the 'qty' field" },
]) {
  test(`receiving CSV ${sample.name} are rejected before posting and preserve correction input`, async ({ page }) => {
    const { requests, failures, dialog } = await setup(page, "success");
    await page.getByTestId("textarea-csv").fill(sample.csv);
    await page.getByTestId("btn-import").click();
    await expect(dialog.getByRole("alert")).toContainText(sample.message);
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("textarea-csv")).toHaveValue(sample.csv);
    await expect(page.getByTestId("btn-import")).toBeEnabled();
    expect(requests).toHaveLength(0);
    await page.getByTestId("textarea-csv").fill("sku,qty\nCASE,12");
    await page.getByTestId("btn-import").click();
    await expect(dialog).toBeHidden();
    expect(requests).toHaveLength(1);
    expect(requests[0].lines).toEqual([expect.objectContaining({ sku: "CASE", qty: "12" })]);
    expect(failures).toEqual([]);
  });
}

test("pending CSV import keeps its input and failure visible through close attempts", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const { requests, failures, dialog } = await setup(page, "changed", { beforeResponse: () => pending });
  const csv = "sku,qty\nCASE,5";
  await page.getByTestId("textarea-csv").fill(csv);
  const sent = page.waitForRequest("**/api/receiving/31/lines/bulk");
  await page.getByTestId("btn-import").click();
  await sent;
  await expect(dialog.getByRole("status")).toContainText("until the result is confirmed");
  await expect(page.getByTestId("textarea-csv")).toBeDisabled();
  await expect(page.getByTestId("input-csv-file")).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog.getByRole("alert")).toContainText("Review the current receipt and retry");
  await expect(page.getByTestId("textarea-csv")).toBeEnabled();
  await expect(page.getByTestId("textarea-csv")).toHaveValue(csv);
  await page.getByTestId("btn-import").click();
  await expect(dialog).toBeHidden();
  expect(requests).toHaveLength(2);
  expect(failures).toEqual([]);
});

test("CSV drafts stay with their receipt and late import errors cannot enter a later visit", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const { requests, failures, dialog } = await setup(page, "changed", { beforeResponse: () => pending, startFromList: true });
  const originalCsv = "sku,qty\nCASE,5";
  await page.getByTestId("textarea-csv").fill(originalCsv);
  const sent = page.waitForRequest("**/api/receiving/31/lines/bulk");
  await page.getByTestId("btn-import").click();
  await sent;
  await page.goBack();
  await expect(dialog).toBeHidden();
  await page.locator("a:visible").filter({ hasText: /^TEST-RECEIPT-32$/ }).click();
  await openReceivingMoreActions(page);
  await page.getByTestId("btn-import-csv").click();
  await expect(page.getByTestId("textarea-csv")).toHaveValue("");
  release();
  // Becoming editable proves the old mutation, including onError, settled.
  await expect(page.getByTestId("textarea-csv")).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  const otherCsv = "sku,qty\nOTHER,7";
  await page.getByTestId("textarea-csv").fill(otherCsv);
  await page.goBack();
  await page.locator("a:visible").filter({ hasText: /^TEST-RECEIPT-31$/ }).click();
  await openReceivingMoreActions(page);
  await page.getByTestId("btn-import-csv").click();
  await expect(page.getByTestId("textarea-csv")).toHaveValue(originalCsv);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await page.goBack();
  await page.locator("a:visible").filter({ hasText: /^TEST-RECEIPT-32$/ }).click();
  await openReceivingMoreActions(page);
  await page.getByTestId("btn-import-csv").click();
  await expect(page.getByTestId("textarea-csv")).toHaveValue(otherCsv);
  expect(requests).toHaveLength(1);
  expect(failures).toEqual([]);
});

async function delayCsvFileRead(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeFileReader = window.FileReader;
    window.FileReader = class extends NativeFileReader {
      override readAsText(file: Blob, encoding?: string): void {
        Object.defineProperty(window, "releaseCsvFileRead", {
          configurable: true,
          value: () => new Promise<void>((resolve) => {
            this.addEventListener("loadend", () => resolve(), { once: true });
            super.readAsText(file, encoding);
          }),
        });
      }
    };
  });
}

test("a delayed CSV file read cannot populate another receipt's draft", async ({ page }) => {
  await delayCsvFileRead(page);
  const { requests, failures } = await setup(page, "success", { startFromList: true });
  await page.getByTestId("input-csv-file").setInputFiles({
    name: "receipt-31.csv", mimeType: "text/csv", buffer: Buffer.from("sku,qty\nCASE,5"),
  });
  await page.goBack();
  await page.locator("a:visible").filter({ hasText: /^TEST-RECEIPT-32$/ }).click();
  await openReceivingMoreActions(page);
  await page.getByTestId("btn-import-csv").click();
  const currentCsv = "sku,qty\nOTHER,7";
  await page.getByTestId("textarea-csv").fill(currentCsv);
  await page.evaluate(async () => {
    await (window as unknown as { releaseCsvFileRead: () => Promise<void> }).releaseCsvFileRead();
  });
  await expect(page.getByTestId("textarea-csv")).toHaveValue(currentCsv);
  expect(requests).toHaveLength(0);
  expect(failures).toEqual([]);
});

test("choosing a CSV file blocks posting the old draft until the file has loaded", async ({ page }) => {
  await delayCsvFileRead(page);
  const { requests, failures, dialog } = await setup(page, "success");
  await page.getByTestId("textarea-csv").fill("sku,qty\nOLD,2");
  const fileCsv = "sku,qty\nNEW,5";
  await page.getByTestId("input-csv-file").setInputFiles({
    name: "received.csv", mimeType: "text/csv", buffer: Buffer.from(fileCsv),
  });
  await expect(dialog.getByRole("status")).toHaveText("Reading CSV file.");
  await expect(page.getByTestId("textarea-csv")).toBeDisabled();
  await expect(page.getByTestId("input-csv-file")).toBeDisabled();
  await expect(page.getByTestId("btn-import")).toBeDisabled();
  expect(requests).toHaveLength(0);
  await page.evaluate(async () => {
    await (window as unknown as { releaseCsvFileRead: () => Promise<void> }).releaseCsvFileRead();
  });
  await expect(page.getByTestId("textarea-csv")).toHaveValue(fileCsv);
  await page.getByTestId("btn-import").click();
  await expect(dialog).toBeHidden();
  expect(requests).toHaveLength(1);
  expect(requests[0].lines).toEqual([expect.objectContaining({ sku: "NEW", qty: "5" })]);
  expect(failures).toEqual([]);
});

for (const failure of ["read error", "read exception"] as const) {
  test(`CSV ${failure} restores editable input and keeps the failure inline`, async ({ page }) => {
    await page.addInitScript((mode) => {
      const NativeFileReader = window.FileReader;
      window.FileReader = class extends NativeFileReader {
        override readAsText(): void {
          if (mode === "read exception") throw new Error("File unavailable");
          this.dispatchEvent(new Event("error"));
        }
      };
    }, failure);
    const { requests, failures, dialog } = await setup(page, "success");
    await page.getByTestId("textarea-csv").fill("sku,qty\nOLD,2");
    await page.getByTestId("input-csv-file").setInputFiles({
      name: "unreadable.csv", mimeType: "text/csv", buffer: Buffer.from("sku,qty\nNEW,5"),
    });
    await expect(dialog.getByRole("alert")).toContainText("The CSV file could not be read");
    await expect(page.getByTestId("textarea-csv")).toHaveValue("sku,qty\nOLD,2");
    await expect(page.getByTestId("textarea-csv")).toBeEnabled();
    await expect(page.getByTestId("input-csv-file")).toBeEnabled();
    expect(requests).toHaveLength(0);
    await page.getByTestId("textarea-csv").fill("sku,qty\nCORRECTED,5");
    await page.getByTestId("btn-import").click();
    await expect(dialog).toBeHidden();
    expect(requests).toHaveLength(1);
    expect(requests[0].lines).toEqual([expect.objectContaining({ sku: "CORRECTED", qty: "5" })]);
    expect(failures).toEqual([]);
  });
}
