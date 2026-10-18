import { expect, test, type Page } from "@playwright/test";
import { installFixtures, receipt } from "./procurement-fixtures";

type ImportMode = "ambiguous" | "existing" | "changed" | "malformed" | "lost" | "invalid_count" | "partial";
async function setup(page: Page, mode: ImportMode) {
  const failures = await installFixtures(page);
  const requests: Array<{ lines: Array<Record<string, unknown>> }> = [];
  const order = { ...receipt(31), sourceType: "blind", purchaseOrderId: null, inboundShipmentId: null,
    status: "draft", warehouseId: 1, receivingLocationId: null, lines: [] };
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/receiving/31") return route.fulfill({ json: order });
    if (request.method() === "GET" && path === "/api/warehouses") return route.fulfill({ json: [{ id: 1, code: "W1", name: "Main" }] });
    if (request.method() !== "POST" || path !== "/api/receiving/31/lines/bulk") return route.fallback();
    requests.push(request.postDataJSON());
    if (requests.length > 1) return route.fulfill({ status: 201, json: { success: true, created: 1, updated: mode === "partial" ? 1 : 0 } });
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
  await page.goto("/receiving?open=31");
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
  await page.getByTestId("textarea-csv").fill("sku,qty,location\nCASE,12,DOCK");
  await page.getByTestId("btn-import").click();
  await expect(dialog).toBeHidden();
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
    const { requests, failures, dialog } = await setup(page, "ambiguous");
    await page.getByTestId("textarea-csv").fill(sample.csv);
    await page.getByTestId("btn-import").click();
    await expect(page.getByLabel("Notifications (F8)").getByText(sample.message, { exact: false })).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("textarea-csv")).toHaveValue(sample.csv);
    await expect(page.getByTestId("btn-import")).toBeEnabled();
    expect(requests).toHaveLength(0);
    expect(failures).toEqual([]);
  });
}
