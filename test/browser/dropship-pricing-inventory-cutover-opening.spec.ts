import { createHash } from "node:crypto";
import { resolve } from "node:path";
import Papa from "papaparse";
import { expect, test, type Page } from "playwright/test";
import type { OpeningSaveRequest, OpeningVerification } from "../../shared/types/inventory-cutover-opening";
import { openingAssessment, openingSaved, openingSource } from
  "../../server/modules/inventory-planning/__tests__/fixtures/inventory-cutover-opening-interface.fixture";

// This panel uses the already registered shared harness. The prefix keeps the
// inventory journey inside the browser configuration's explicit testMatch.
type CsvRow = Record<string, string>;
type DownloadedCsv = { name: string; text: string };

function editCsv(csv: string, change: (rows: CsvRow[]) => void): string {
  const parsed = Papa.parse<CsvRow>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: header => header.replace(/^\uFEFF/, ""),
  });
  expect(parsed.errors).toEqual([]);
  change(parsed.data);
  return Papa.unparse({ fields: parsed.meta.fields ?? [], data: parsed.data });
}

async function downloadCsv(page: Page, buttonName: string): Promise<DownloadedCsv> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: buttonName, exact: true }).click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return { name: download.suggestedFilename(), text: Buffer.concat(chunks).toString("utf8") };
}

async function setup(page: Page) {
  const source = openingSource();
  const sourceText = JSON.stringify(source);
  const chunks = Array.from({ length: Math.ceil(sourceText.length / 32_768) }, (_, index) =>
    sourceText.slice(index * 32_768, (index + 1) * 32_768));
  const captureId = "11111111-1111-4111-8111-111111111111";
  const state = {
    captures: [] as Array<{ idempotencyKey: string }>,
    previews: [] as OpeningVerification[],
    saves: [] as OpeningSaveRequest[],
    unexpected: [] as string[],
    errors: [] as string[],
  };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1"
    ? route.continue() : route.abort());
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/inventory-planning/admin/cutover-opening/captures") {
      state.captures.push(request.postDataJSON() as { idempotencyKey: string });
      return route.fulfill({ status: 202, json: { id: captureId, state: "complete", stage: "complete",
        createdAt: "2026-09-09T12:00:00.000Z", completedAt: "2026-09-09T12:00:01.000Z",
        chunkCount: chunks.length, errorCode: null } });
    }
    const chunkMatch = path.match(/^\/api\/inventory-planning\/admin\/cutover-opening\/captures\/([^/]+)\/chunks\/(\d+)$/);
    if (request.method() === "GET" && chunkMatch?.[1] === captureId) {
      const index = Number(chunkMatch[2]);
      if (index >= 0 && index < chunks.length) {
        return route.fulfill({ json: { captureId, index, text: chunks[index] } });
      }
    }
    if (request.method() === "POST" && path === "/api/inventory-planning/admin/cutover-opening/preview") {
      state.previews.push(request.postDataJSON() as OpeningVerification);
      return route.fulfill({ json: openingAssessment() });
    }
    if (request.method() === "POST" && path === "/api/inventory-planning/admin/cutover-opening/verify") {
      state.saves.push(request.postDataJSON() as OpeningSaveRequest);
      return route.fulfill({ status: 201, json: openingSaved() });
    }
    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: { code: "UNEXPECTED_REQUEST", message: "Unexpected synthetic request" } } });
  });
  await page.route("**/__inventory-cutover-opening-test**", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
      <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
      <body><main id="root" style="max-width:1100px;margin:24px auto;padding:12px"></main>
      <script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/shared-shipping-configuration-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`,
  }));
  await page.goto("/__inventory-cutover-opening-test?mode=inventory-opening");
  await expect(page.getByText("Verify current inventory and open orders", { exact: true }), JSON.stringify(state.errors)).toBeVisible();
  return state;
}

test("imports all three operator CSVs, previews and saves immutable opening evidence", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Capture current recorded data", exact: true }).click();

  const stockButton = page.getByRole("button", { name: "Download stock and lot counts CSV", exact: true });
  await expect(stockButton).toBeEnabled();
  const stockDownload = await downloadCsv(page, "Download stock and lot counts CSV");
  const orderDownload = await downloadCsv(page, "Download open-order review CSV");
  const allocationDownload = await downloadCsv(page, "Download lot ownership CSV");
  expect(stockDownload.name).toBe(`inventory-opening-stock-and-lots-${"a".repeat(12)}.csv`);
  expect(orderDownload.name).toBe(`inventory-opening-open-orders-${"a".repeat(12)}.csv`);
  expect(allocationDownload.name).toBe(`inventory-opening-lot-ownership-${"a".repeat(12)}.csv`);
  expect(stockDownload.text).toContain("sku,warehouse,bin");
  expect(orderDownload.text).toContain("external_order_id");
  expect(allocationDownload.text).toContain("available_original_cost_ids");

  const stock = editCsv(stockDownload.text, ([row]) => {
    row.enter_verified_on_hand = "20";
    row.enter_verified_reserved = "3";
    row.enter_verified_picked = "2";
  });
  const orders = editCsv(orderDownload.text, ([row]) => {
    row.enter_verified_remaining = "6";
    row.enter_verified_physical_reserved = "3";
    row.enter_verified_physical_picked = "2";
  });
  const allocations = editCsv(allocationDownload.text, ([row]) => {
    row.enter_verified_reserved = "3";
    row.enter_verified_picked = "2";
    row.enter_original_cost_ids_or_all = "ALL";
  });
  const expectedEvidenceHash = createHash("sha256")
    .update(JSON.stringify({ stock, orders, allocations })).digest("hex");

  await page.getByLabel("Use independently verified current lot custody", { exact: false }).check();
  await page.getByLabel("Count or review reference", { exact: true }).fill("Warehouse count COUNT-2026-09-13");
  await page.getByLabel("Review completed at", { exact: true }).fill("2026-09-09T12:00");
  const expectedVerifiedAt = await page.evaluate(() => new Date("2026-09-09T12:00").toISOString());
  const fileInput = page.getByLabel("Completed inventory verification spreadsheets", { exact: true });
  await fileInput.setInputFiles([
    { name: orderDownload.name, mimeType: "text/csv", buffer: Buffer.from(orders) },
    { name: allocationDownload.name, mimeType: "text/csv", buffer: Buffer.from(allocations) },
    { name: stockDownload.name, mimeType: "text/csv", buffer: Buffer.from(stock) },
  ]);
  await expect.poll(() => fileInput.evaluate((input: HTMLInputElement) => ({
    value: input.value,
    fileCount: input.files?.length ?? -1,
  }))).toEqual({ value: "", fileCount: 0 });
  await expect(page.getByText("Imported 1 positions, 1 lots and 1 order lines.", { exact: true })).toBeVisible();

  const previewButton = page.getByRole("button", { name: "Preview verified opening", exact: true });
  await expect(previewButton).toBeDisabled();
  await page.getByLabel("I independently verified these quantities", { exact: false }).check();
  await previewButton.click();
  await expect(page.getByText("Verification is consistent and can be saved for later cutover review.", { exact: false })).toBeVisible();

  await page.getByLabel("Reason for saving this verification", { exact: true })
    .fill("Reviewed independent current evidence");
  await page.getByRole("button", { name: "Save verified opening — no activation", exact: true }).click();
  await expect(page.getByText("Verification 7 is saved as immutable evidence.", { exact: false })).toBeVisible();

  expect(state.captures).toHaveLength(1);
  expect(state.captures[0].idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(state.previews).toHaveLength(1);
  expect(state.previews[0]).toMatchObject({
    contractVersion: "inventory_cutover_opening_v2",
    verificationReference: "Warehouse count COUNT-2026-09-13",
    verificationEvidenceHash: expectedEvidenceHash,
    verifiedAt: expectedVerifiedAt,
    reservationBasis: "verified_current_lot_custody",
    levels: [{ id: 10, variantQty: "20", reservedQty: "3", pickedQty: "2", packedQty: "0" }],
    lots: [{ id: 4, onHandQty: "20", reservedQty: "3", pickedQty: "2" }],
    owners: [{ orderId: 1, orderItemId: 11, remainingQty: "6", reservedQty: "3", pickedQty: "2",
      allocations: [{ inventoryLevelId: 10, lots: [{ inventoryLotId: 4, reservedQty: "3", pickedQty: "2", originalCostIds: [9] }] }] }],
  });
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0]).toMatchObject({
    verification: state.previews[0],
    reason: "Reviewed independent current evidence",
  });
  expect(state.saves[0].idempotencyKey).toMatch(/^opening:[0-9a-f-]{36}$/i);
  expect(await page.evaluate(() => (window as unknown as { __inventoryOpeningChanged: number }).__inventoryOpeningChanged)).toBe(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});
