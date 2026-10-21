import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po, receipt } from "./procurement-fixtures";
import { costLinkRepair } from "../fixtures/cost-link-repair";
import {
  correctionContext,
  correctionInput,
  correctionSummary,
} from "../fixtures/quantity-correction";

async function install(
  page: Page,
  {
    admin = true,
    loseResponse = false,
    shipmentEdit = false,
    missingHistory = false,
    repairLinks = false,
    linksAlreadyReviewed = false,
  } = {},
) {
  const failures = await installFixtures(page);
  let posted = false,
    lost = false;
  const commands: Array<{ key: string | undefined; body: unknown }> = [];
  const shipmentSummary = {
    ...correctionSummary,
    purpose: "shipment" as const,
    receipts: correctionSummary.receipts.map((row) => ({
      ...row,
      receivedPieces: row.afterPieces,
      piecesPerUnit: row.afterPiecesPerUnit,
    })),
    poReceivedPieces: { before: 2000, after: 2000 },
    poRemainingPieces: { before: 0, after: 0 },
  };
  const { receipts: _, ...shipmentInput } = correctionInput;
  const reviewSummary = repairLinks
    ? { ...correctionSummary, costLinkRepair }
    : missingHistory
      ? {
          ...correctionSummary,
          shipmentCostReview: {
            beforeUnassignedMills: 500000,
            afterUnassignedMills: 500000,
            needsHistoryReview: true,
            affectedLots: [
              {
                lotId: 501,
                lotNumber: "RECEIPT-TRANSFER-LOT",
                receiptId: 31,
                receivedUnits: 2,
                onHandUnits: 0,
              },
            ],
          },
          costResults: [
            {
              component: "landed" as const,
              shipmentId: 42,
              status: "review_required" as const,
              lotsUpdated: 0,
              orderCostsUpdated: 0,
              orderCostDeltaCents: 0,
              issues: [
                {
                  code: linksAlreadyReviewed
                    ? "COST_UNRESOLVED_QUANTITY_RETAINED"
                    : "COST_HISTORICAL_LINEAGE_MISSING",
                  message: linksAlreadyReviewed
                    ? "Three packs still have no recorded destination. Their cost remains unassigned."
                    : "The recorded transfer is missing its cost link.",
                  ...(linksAlreadyReviewed
                    ? { costLinksAlreadyReviewed: true as const }
                    : {}),
                },
              ],
            },
          ],
        }
      : correctionSummary;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (missingHistory && path === "/api/purchase-orders/17/shipment-costs")
      return route.fulfill({
        json: {
          summary: {
            currency: "USD",
            shipmentCount: 1,
            chargeCount: 1,
            freightCents: 5000,
            dutyCents: 0,
            otherCents: 0,
            totalCents: 5000,
            poAmountCents: 20000,
            combinedCostCents: 25000,
            estimatedCents: 0,
            unallocatedChargeCount: 0,
            unsupportedCurrencyCount: 0,
            appliedLines: 0,
            reviewLines: 1,
            pendingLines: 0,
            inventoryCosting: "review_required",
          },
          supplier: { freightCents: 0, dutyCents: 0 },
          totals: {
            freightCents: 5000,
            dutyCents: 0,
            combinedCostCents: 25000,
          },
          lines: [
            {
              lineId: 1,
              purchaseOrderLineId: 171,
              shipmentId: 42,
              shipmentNumber: "TEST-SHIP-42",
              shipmentStatus: "closed",
              sku: "TEST-SKU",
              allocatedCents: 5000,
              status: "review_required",
              applicationId: 1,
              recordedAt: "2026-09-01T12:00:00.000Z",
              issues: reviewSummary.costResults[0].issues,
            },
          ],
        },
      });
    if (path === "/api/purchase-orders/17")
      return route.fulfill({ json: { ...po(17), status: "received" } });
    if (path === "/api/purchase-orders/17/quantity-corrections")
      return route.fulfill({
        json: [
          {
            shipmentLineId: 1,
            shipmentNumber: "TEST-SHIP-42",
            sku: "TEST-SKU",
            shippedPieces: posted ? 2000 : 200,
          },
        ],
      });
    if (
      path === "/api/shipment-lines/1/quantity-correction/preview" ||
      path === "/api/shipment-lines/1/shipment-edit/preview"
    ) {
      const { previewVersion: _, ...expected } = shipmentEdit
        ? shipmentInput
        : correctionInput;
      expect(request.postDataJSON()).toEqual(
        repairLinks ? { ...expected, repairCostLinks: true } : expected,
      );
      return route.fulfill({
        json: {
          sourceVersion: "a".repeat(64),
          previewVersion: "b".repeat(64),
          summary: shipmentEdit ? shipmentSummary : reviewSummary,
        },
      });
    }
    if (
      [
        "/api/shipment-lines/1/quantity-correction",
        "/api/receiving-lines/32/quantity-correction",
        "/api/shipment-lines/1/shipment-edit",
      ].includes(path)
    ) {
      if (request.method() === "POST") {
        commands.push({
          key: request.headers()["idempotency-key"],
          body: request.postDataJSON(),
        });
        posted = true;
        if (loseResponse && !lost) {
          lost = true;
          return route.abort();
        }
      }
      const current = correctionContext(posted);
      if (posted && (missingHistory || repairLinks))
        current.history[0].summary = reviewSummary;
      if (shipmentEdit) {
        current.receipts = correctionContext(true).receipts;
        if (posted) current.history[0].summary = shipmentSummary;
      }
      return route.fulfill({
        json: {
          ...current,
          canApprove: admin,
          blockedReason: admin
            ? null
            : "An active Administrator must approve this correction.",
        },
      });
    }
    if (path === "/api/inbound-shipments/42")
      return route.fulfill({
        json: {
          id: 42,
          shipmentNumber: "TEST-SHIP-42",
          status: "closed",
          mode: "air",
          lines: [
            {
              id: 1,
              inboundShipmentId: 42,
              purchaseOrderId: 17,
              purchaseOrderLineId: 171,
              sku: "TEST-SKU",
              productName: "Test product",
              qtyShipped: posted ? 2000 : 200,
              cartonCount: 2,
            },
          ],
          costs: [],
          statusHistory: [],
          purchaseOrders: [{ id: 17, poNumber: "TEST-PO-17" }],
        },
      });
    if (path === "/api/receiving/31")
      return route.fulfill({
        json: {
          ...receipt(31),
          purchaseOrderId: 17,
          lines: [
            {
              id: 32,
              receivingOrderId: 31,
              inboundShipmentLineId: 1,
              purchaseOrderLineId: 171,
              productVariantId: 200,
              sku: "TEST-SKU",
              productName: "Test product",
              expectedQty: 2,
              receivedQty: 2,
              damagedQty: 0,
              reversedQty: 0,
              status: "complete",
              unitsPerVariantSnapshot: posted || shipmentEdit ? 1000 : 100,
              unitVersion: (posted ? "c" : "a").repeat(64),
              updatedAt: "2026-09-01T12:00:00.000Z",
            },
          ],
        },
      });
    return route.fallback();
  });
  return { failures, commands };
}
async function openFromReceipt(page: Page) {
  await page.goto("/receiving?open=31");
  await page
    .getByRole("button", { name: "Correct received quantities", exact: true })
    .click();
}
async function review(page: Page, combined = false) {
  const dialog = page.getByRole("dialog").last();
  await dialog.getByLabel("Shipment TEST-SHIP-42").fill("2000");
  await dialog.getByLabel(/TEST-RECEIPT-31/).fill("2000");
  await dialog
    .getByLabel("Reason / document reference")
    .fill(correctionInput.reason);
  await dialog.getByRole("checkbox", { name: /^I checked/ }).check();
  await dialog
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", {
      name: combined ? "Approve shipment and receipt" : "Approve correction",
      exact: true,
    }),
  ).toBeEnabled();
  return dialog;
}
test("a receipt correction and its saved approval are visible from shipment and receipt", async ({
  page,
}, info) => {
  const { failures, commands } = await install(page);
  await openFromReceipt(page);
  const dialog = await review(page);
  await expect(dialog.getByRole("table")).toContainText("$0.250000");
  await expect(dialog.getByRole("table")).toContainText("$0.025000");
  const approve = dialog.getByRole("button", {
    name: "Approve correction",
    exact: true,
  });
  await expect(approve).toBeInViewport();
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({
    path: info.outputPath("quantity-correction-preview.png"),
  });
  await approve.click();
  await expect(dialog).toContainText("Quantity correction approved and saved");
  await expect(dialog).toContainText("Test Administrator");
  await expect(
    dialog.getByRole("button", { name: "Approve correction", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  expect(commands).toHaveLength(1);
  expect(commands[0].body).toEqual(correctionInput);
  for (const url of ["/shipments/42?tab=lines", "/receiving?open=31"]) {
    await page.goto(url);
    await page
      .getByRole("button", {
        name: url.startsWith("/shipments")
          ? "Edit shipment"
          : "Correct received quantities",
        exact: true,
      })
      .filter({ visible: true })
      .first()
      .click();
    const view = page.getByRole("dialog").last();
    await expect(view.getByLabel("Shipment TEST-SHIP-42")).toHaveValue("2000");
    if (url.startsWith("/shipments")) {
      await expect(view).toContainText("2,000 pieces received (saved)");
      await expect(view.getByLabel(/TEST-RECEIPT-31/)).toHaveCount(0);
    } else await expect(view.getByLabel(/TEST-RECEIPT-31/)).toHaveValue("2000");
    await view.getByText("Previous corrections and approvals (1)").click();
    await expect(view).toContainText("Test Administrator");
  }
  expect(failures).toEqual([]);
});
for (const entry of ["receipt", "combined"] as const)
  test(`a lost response from ${entry} retries the same approval and prevents document switching`, async ({
    page,
  }) => {
    const { commands, failures } = await install(page, { loseResponse: true });
    if (entry === "receipt") await openFromReceipt(page);
    else await openCombinedFromShipment(page);
    const dialog = await review(page, entry === "combined");
    await dialog
      .getByRole("button", {
        name:
          entry === "combined"
            ? "Approve shipment and receipt"
            : "Approve correction",
        exact: true,
      })
      .click();
    const retry = dialog.getByRole("button", {
      name: "Retry same approval",
      exact: true,
    });
    await expect(retry).toBeEnabled();
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }).first(),
    ).toBeDisabled();
    await dialog
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Edit quantities", exact: true }),
    ).toHaveCount(0);
    await retry.click();
    await expect(dialog).toContainText(
      entry === "combined"
        ? "Shipment and receipt correction approved and saved"
        : "Quantity correction approved and saved",
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
    expect(failures).toEqual([]);
  });
test("view access does not expose approval to a non-admin", async ({
  page,
}) => {
  const { commands } = await install(page, { admin: false });
  await openFromReceipt(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("An active Administrator must approve");
  await expect(
    dialog.getByRole("button", { name: "Review changes", exact: true }),
  ).toBeDisabled();
  expect(commands).toEqual([]);
});

test("shipment edit reviews and saves shipped pieces while the correct receipt stays read-only", async ({
  page,
}, info) => {
  const { commands, failures } = await install(page, { shipmentEdit: true });
  await page.goto("/shipments/42?tab=lines");
  await expect(
    page.getByRole("button", {
      name: "Correct received quantities",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Edit shipment", exact: true })
    .click();
  const dialog = page.getByRole("dialog").last();
  await expect(dialog).toContainText("2,000 pieces received (saved)");
  await expect(dialog.getByLabel(/TEST-RECEIPT-31/)).toHaveCount(0);
  await expect(
    dialog.getByRole("link", { name: "TEST-RECEIPT-31" }),
  ).toHaveAttribute("href", "/receiving?open=31");
  await dialog.getByLabel("Shipment TEST-SHIP-42").fill("2000");
  await dialog
    .getByLabel("Reason / document reference")
    .fill(correctionInput.reason);
  await dialog.getByRole("checkbox", { name: /^I checked/ }).check();
  await dialog
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const row = dialog
    .getByRole("row")
    .filter({ hasText: "Receipt TEST-RECEIPT-31 pieces" });
  await expect(row).toHaveText(/2,000.*2,000/);
  const approve = dialog.getByRole("button", {
    name: "Approve shipment edit",
    exact: true,
  });
  await expect(approve).toBeInViewport();
  await page.screenshot({
    path: info.outputPath("shipment-edit-before-after.png"),
  });
  await approve.click();
  await expect(dialog).toContainText("Shipment edit approved and saved");
  await expect(dialog).toContainText("Test Administrator");
  const { receipts: _, ...expected } = correctionInput;
  expect(commands).toHaveLength(1);
  expect(commands[0].body).toEqual(expected);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  if (info.project.name === "mobile") {
    await expect(
      page.getByText("2,000 pieces", { exact: true }).filter({ visible: true }),
    ).toBeVisible();
  } else await expect(page.getByRole("table").first()).toContainText("2,000");
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(
    page.getByRole("button", {
      name: "Correct received quantities",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(failures).toEqual([]);
});

async function openCombinedFromShipment(page: Page) {
  await page.goto("/shipments/42?tab=lines");
  await page
    .getByRole("button", { name: "Edit shipment", exact: true })
    .click();
  const dialog = page.getByRole("dialog").last();
  await dialog
    .getByRole("checkbox", {
      name: "Also correct received quantities",
      exact: true,
    })
    .check();
  return dialog;
}

test("PO cost warnings open the affected shipment's combined history repair directly", async ({
  page,
}) => {
  const { commands, failures } = await install(page, { missingHistory: true });
  await page.goto("/purchase-orders/17?tab=lines");
  await page
    .getByRole("button", { name: "Review 1 line", exact: true })
    .click();
  await page
    .getByRole("link", {
      name: "Review transfer and repacking links",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog").last();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", {
      name: "Also correct received quantities",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", {
      name: "Restore missing transfer and repacking cost links",
      exact: true,
    }),
  ).toBeChecked();
  await expect(dialog.getByLabel(/TEST-RECEIPT-31/)).toBeVisible();
  expect(commands).toEqual([]);
  expect(failures).toEqual([]);
});

test("remaining stock gaps stay visible without asking for the same history approval again", async ({
  page,
}) => {
  const { commands, failures } = await install(page, {
    missingHistory: true,
    linksAlreadyReviewed: true,
  });
  await page.goto("/purchase-orders/17?tab=lines");
  await page
    .getByRole("button", { name: "Review 1 line", exact: true })
    .click();
  await expect(
    page.getByText(
      "Three packs still have no recorded destination. Their cost remains unassigned.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/Transfer and repacking links have already been reviewed/),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "Review transfer and repacking links",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(commands).toEqual([]);
  expect(failures).toEqual([]);
});

test("one approval restores reviewed transfer and repacking links with quantity and cost before/after", async ({
  page,
}, info) => {
  const { commands, failures } = await install(page, { repairLinks: true });
  const dialog = await openCombinedFromShipment(page);
  await dialog.getByLabel("Shipment TEST-SHIP-42").fill("2000");
  await dialog.getByLabel(/TEST-RECEIPT-31/).fill("2000");
  await dialog
    .getByLabel("Reason / document reference")
    .fill(correctionInput.reason);
  await dialog
    .getByRole("checkbox", { name: /^I checked the receipt/ })
    .check();
  await dialog
    .getByRole("checkbox", {
      name: /Restore missing transfer and repacking cost links/,
    })
    .check();
  await dialog
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(dialog).toContainText("Recorded warehouse transfer");
  await expect(dialog).toContainText("Recorded case opened into packs");
  await expect(dialog).toContainText("Movements #802, #803");
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await expect(dialog).toContainText("New expense postings: 0");
  await expect(dialog).toContainText("STORAGE-LOT: 1 CASE unit");
  await dialog.getByText("Cost before and after for 1 lots").click();
  const orderRow = dialog
    .getByRole("row")
    .filter({ hasText: "Linked order costs (1 records)" });
  await expect(orderRow).toContainText("$1.00");
  await expect(orderRow).toContainText("$3.50");
  const approve = dialog.getByRole("button", {
    name: "Approve shipment and receipt",
    exact: true,
  });
  await expect(approve).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /I verified.*transfer/ }).check();
  await expect(approve).toBeEnabled();
  await expect(approve).toBeInViewport();
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.screenshot({
    path: info.outputPath("cost-link-repair-preview.png"),
  });
  await approve.click();
  await expect(dialog).toContainText("Cost links restored");
  await expect(dialog).toContainText("Test Administrator");
  expect(commands).toHaveLength(1);
  expect(commands[0].body).toEqual({
    ...correctionInput,
    repairCostLinks: true,
    costLinksConfirmed: true,
  });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await openFromReceipt(page);
  await page
    .getByRole("dialog")
    .last()
    .getByText("Previous corrections and approvals (1)")
    .click();
  await expect(page.getByRole("dialog").last()).toContainText(
    "Cost links restored",
  );
  expect(failures).toEqual([]);
});

test("shipment and receipt stay in one draft, review and administrator approval", async ({
  page,
}, info) => {
  const { commands, failures } = await install(page);
  await page.goto("/shipments/42?tab=lines");
  await page
    .getByRole("button", { name: "Edit shipment", exact: true })
    .click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByLabel("Shipment TEST-SHIP-42").fill("2000");
  await dialog
    .getByLabel("Reason / document reference")
    .fill(correctionInput.reason);
  const link = dialog.getByRole("link", {
    name: "TEST-RECEIPT-31",
    exact: true,
  });
  await expect(link).toHaveAttribute("target", "_blank");
  const popupPromise = page.waitForEvent("popup");
  await link.click();
  const receiptTab = await popupPromise;
  // Page-local API fixtures must also be installed in the inspection tab.
  const receiptFixture = await install(receiptTab);
  await receiptTab.reload();
  await expect(
    receiptTab.getByRole("heading", { name: /Receipt TEST-RECEIPT-31/ }),
  ).toBeVisible();
  expect(receiptFixture.failures).toEqual([]);
  await receiptTab.close();
  await expect(dialog.getByLabel("Shipment TEST-SHIP-42")).toHaveValue("2000");
  const include = dialog.getByRole("checkbox", {
    name: "Also correct received quantities",
    exact: true,
  });
  await include.check();
  const received = dialog.getByLabel(/TEST-RECEIPT-31/);
  await expect(received).toHaveValue("2000");
  await received.fill("1800");
  await dialog.getByLabel("Shipment TEST-SHIP-42").fill("2200");
  await expect(received).toHaveValue("1800");
  await include.uncheck();
  await expect(received).toHaveCount(0);
  await include.check();
  await expect(received).toHaveValue("1800");
  await dialog.getByLabel("Shipment TEST-SHIP-42").fill("2000");
  await received.fill("2000");
  await expect(dialog.getByLabel("Reason / document reference")).toHaveValue(
    correctionInput.reason,
  );
  await dialog
    .getByRole("checkbox", { name: /^I checked the receipt/ })
    .check();
  await dialog
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  for (const label of [
    "Shipment pieces",
    "Receipt TEST-RECEIPT-31 pieces",
    "PO received pieces",
  ]) {
    await expect(dialog.getByRole("row").filter({ hasText: label })).toHaveText(
      /200.*2,000/,
    );
  }
  await expect(
    dialog
      .getByRole("row")
      .filter({ hasText: "Received units · TEST-RECEIPT-31" }),
  ).toHaveText(/2.*2/);
  await dialog
    .getByRole("button", { name: "Edit quantities", exact: true })
    .click();
  await expect(received).toHaveValue("2000");
  await expect(dialog.getByLabel("Reason / document reference")).toHaveValue(
    correctionInput.reason,
  );
  await dialog
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const approve = dialog.getByRole("button", {
    name: "Approve shipment and receipt",
    exact: true,
  });
  await expect(approve).toBeInViewport();
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({
    path: info.outputPath("combined-shipment-receipt-preview.png"),
  });
  await approve.click();
  await expect(dialog).toContainText(
    "Shipment and receipt correction approved and saved",
  );
  await expect(dialog).toContainText("Test Administrator");
  expect(commands).toHaveLength(1);
  expect(commands[0].body).toEqual(correctionInput);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await openFromReceipt(page);
  await expect(
    page
      .getByRole("dialog")
      .last()
      .getByLabel(/TEST-RECEIPT-31/),
  ).toHaveValue("2000");
  expect(failures).toEqual([]);
});

test("missing stock history allows one combined approval without an expense choice and remains visible after saving", async ({
  page,
}, info) => {
  const { failures, commands } = await install(page, { missingHistory: true });
  await page.goto("/shipments/42");
  await page
    .getByRole("button", { name: "Edit shipment", exact: true })
    .click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByLabel("Also correct received quantities").check();
  await review(page, true);
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await expect(dialog).not.toContainText(
    "Where does the unlinked historical cost belong?",
  );
  await expect(dialog).toContainText(
    "Quantity correction is ready for approval.",
  );
  await expect(dialog).toContainText("RECEIPT-TRANSFER-LOT");
  await expect(
    dialog
      .getByRole("row")
      .filter({ hasText: "Shipment costs not yet assigned" }),
  ).toContainText("$50.0000");
  await page.screenshot({
    path: info.outputPath("correction-without-expense-preview.png"),
  });
  await dialog
    .getByRole("button", { name: "Approve shipment and receipt", exact: true })
    .click();
  await expect(dialog).toContainText(
    "Shipment and receipt correction approved and saved",
  );
  await expect(dialog).toContainText("Test Administrator");
  await expect(dialog).toContainText(
    "The quantities are saved. Some costs still need their stock history linked.",
  );
  expect(commands).toHaveLength(1);
  expect(commands[0].body).toEqual(correctionInput);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await openFromReceipt(page);
  await page
    .getByRole("dialog")
    .last()
    .getByText("Previous corrections and approvals (1)")
    .click();
  await expect(page.getByRole("dialog").last()).toContainText(
    "Shipment costs not yet assigned",
  );
  expect(failures).toEqual([]);
});
