import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import type { ShipmentCostException } from "../../shared/procurement/shipment-cost-exception";
import type { ReconciliationContext, ReconciliationRequest } from "../../shared/procurement/cost-reconciliation";

async function installReconciliation(
  page: Page,
  options: { viewer?: boolean; lostResponse?: boolean; stale?: boolean; missing?: boolean; posted?: boolean } = {},
) {
  const failures = await installFixtures(page);
  const review: ShipmentCostException = {
    state: "open",
    fingerprint: "b".repeat(64),
    kind: options.missing ? "missing_receipt_history" : "unexplained_quantity",
    currency: "USD",
    allocatedMills: 1000000,
    amountMills: options.missing ? 1000000 : 100001,
    lotsUpdated: options.missing ? 0 : 2,
    cogsRowsUpdated: options.missing ? 0 : 1,
    decision: null,
    issues: options.missing
      ? [{ code: "COST_HISTORICAL_LINEAGE_MISSING", message: "Synthetic receipt links missing." }]
      : [
          {
            code: "COST_UNRESOLVED_QUANTITY_RETAINED",
            message: "TEST-LOT has one unit without a recorded movement.",
            unresolvedQuantity: {
              inventoryLotId: 6,
              allocationId: 7,
              lotNumber: "TEST-LOT",
              originalQuantity: 10,
              onHandQuantityAtReview: 4,
              recordedOutflowQuantityAtReview: 5,
              quantity: 1,
              component: "landed",
              amountMills: 100001,
            },
          },
        ],
    reconciliation: {
      status: "unresolved",
      postedMills: 0,
      unassignedMills: options.missing ? 1000000 : 100001,
      destination: null,
    },
  };
  const context: ReconciliationContext = {
    lineId: 23,
    shipmentId: 42,
    sku: "TEST-PRODUCT",
    currency: "USD",
    sourceVersion: "a".repeat(64),
    sourceAmountMills: review.allocatedMills,
    sourceEvidence: options.missing ? "estimated" : "confirmed",
    historicalAmountMills: review.amountMills,
    balances: { historical_cogs: 0, inventory_variance: 0 },
    state: review.reconciliation!,
    canApprove: !options.viewer,
    blockedReason: options.viewer
      ? "A current Administrator with purchasing approval permission must approve this correction."
      : null,
    records: [
      {
        lotId: 6,
        lotNumber: "TEST-LOT",
        originalQuantity: 10,
        onHandQuantity: options.missing ? 0 : 4,
        receiptId: 8,
        receiptLineId: 9,
        quantityWithoutHistory: options.missing ? null : 1,
        explanation: options.missing
          ? "The receipt exists but its subsequent cost links are missing."
          : "One unit has no recorded movement.",
      },
    ],
    issues: review.issues,
    history: [],
  };
  const state = { review, context, keys: [] as string[], bodies: [] as ReconciliationRequest[] };
  if (options.posted) {
    state.review = { ...review, reconciliation: {
      status: "posted", destination: "historical_cogs", postedMills: review.amountMills, unassignedMills: 0,
    } };
    state.context = { ...context, state: state.review.reconciliation!,
      balances: { historical_cogs: review.amountMills, inventory_variance: 0 },
      history: [{ id: 1, destination: "historical_cogs", beforeMills: 0, afterMills: review.amountMills,
        deltaMills: review.amountMills, actorName: "Test administrator", reason: "Goods were sold; historical records reviewed.",
        recordedAt: "2026-01-01T12:00:00Z" }],
    };
  }
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          user: { id: "test-user", username: "test", role: "admin" },
          roles: ["admin"],
          permissions: ["purchasing:view", "purchasing:approve"],
        },
      });
    if (path === "/api/purchase-orders/17") return route.fulfill({ json: po(17) });
    if (path === "/api/inbound-shipments/42")
      return route.fulfill({
        json: {
          id: 42,
          shipmentNumber: "TEST-SHIP",
          status: "closed",
          mode: "sea_fcl",
          purchaseOrderId: 17,
          statusHistory: [],
          lines: [
            {
              id: 23,
              purchaseOrderId: 17,
              purchaseOrderLineId: 101,
              sku: "TEST-PRODUCT",
              productName: "Synthetic product",
              qtyShipped: 100,
              cartonCount: 10,
            },
          ],
          costs: [
            {
              id: 71,
              costType: "freight",
              actualCents: 10000,
              estimatedCents: 10000,
              currency: "USD",
              costStatus: "finalized",
            },
          ],
        },
      });
    if (path === "/api/purchase-orders/17/shipment-costs")
      return route.fulfill({
        json: {
          summary: {
            currency: "USD",
            shipmentCount: 1,
            chargeCount: 1,
            freightCents: 10000,
            dutyCents: 0,
            otherCents: 0,
            totalCents: 10000,
            poAmountCents: 100000,
            combinedCostCents: 110000,
            estimatedCents: options.missing ? 10000 : 0,
            unallocatedChargeCount: 0,
            unsupportedCurrencyCount: 0,
            appliedLines: state.review.reconciliation?.status === "posted" ? 1 : 0,
            reviewLines: state.review.reconciliation?.status === "posted" ? 0 : 1,
            pendingLines: 0,
            inventoryCosting: state.review.reconciliation?.status === "posted" ? "applied" : "review_required",
          },
          supplier: { freightCents: 0, dutyCents: 0 },
          totals: { freightCents: 10000, dutyCents: 0, combinedCostCents: 110000 },
          lines: [
            {
              lineId: 23,
              shipmentId: 42,
              shipmentNumber: "TEST-SHIP",
              shipmentStatus: "closed",
              sku: "TEST-PRODUCT",
              allocatedCents: 10000,
              status: state.review.reconciliation?.status === "posted" ? "applied" : "review_required",
              applicationId: 9,
              recordedAt: "2026-01-01T12:00:00Z",
              issues: review.issues,
              exceptionReview: state.review,
            },
          ],
        },
      });
    if (path === "/api/inbound-shipments/42/cost-review")
      return route.fulfill({
        json: {
          shipmentId: 42,
          lines: [
            {
              lineId: 23,
              sku: "TEST-PRODUCT",
              sourceIssue: null,
              exceptionReview: state.review,
              application: {
                id: 9,
                status: "review_required",
                recordedAt: "2026-01-01T12:00:00Z",
                lotsUpdated: 2,
                cogsRowsUpdated: 1,
                issues: review.issues,
              },
            },
          ],
        },
      });
    if (path === "/api/shipment-lines/23/cost-reconciliation") {
      if (req.method() === "GET") return route.fulfill({ json: state.context });
      const body = req.postDataJSON() as ReconciliationRequest;
      state.keys.push(req.headers()["idempotency-key"]);
      state.bodies.push(body);
      if (options.stale && state.keys.length === 1) {
        state.context = { ...state.context, sourceVersion: "c".repeat(64) };
        return route.fulfill({
          status: 409,
          json: {
            code: "SHIPMENT_RECONCILIATION_STALE",
            error: "The cost evidence changed. Reload the before and after.",
          },
        });
      }
      if (state.keys.length === 1 || state.keys.at(-2) !== state.keys.at(-1)) {
        const balances = {
          historical_cogs: 0,
          inventory_variance: 0,
          [body.destination]: context.historicalAmountMills,
        };
        const financial = {
          status: "posted" as const,
          postedMills: context.historicalAmountMills,
          unassignedMills: 0,
          destination: body.destination,
        };
        state.context = {
          ...state.context,
          sourceVersion: "d".repeat(64),
          balances,
          state: financial,
          history: [
            {
              id: state.keys.length,
              destination: body.destination,
              beforeMills: state.context.balances[body.destination],
              afterMills: balances[body.destination],
              deltaMills: balances[body.destination] - state.context.balances[body.destination],
              actorName: "Test administrator",
              reason: body.reason,
              recordedAt: "2026-01-01T12:00:00Z",
            },
            ...state.context.history,
          ],
        };
        state.review = { ...review, reconciliation: financial };
      }
      if (options.lostResponse && state.keys.length === 1) return route.abort("connectionreset");
      return route.fulfill({ json: { lineId: 23, shipmentId: 42, applicationId: 10, state: state.context.state } });
    }
    return route.fallback();
  });
  await page.goto("/purchase-orders/17?tab=lines");
  await page.getByRole("button", { name: options.posted ? "View completed costs" : "Review costs", exact: true }).click();
  if (options.posted) await page.getByTestId("completed-costs").locator(":scope > summary").click();
  await page.getByRole("button", { name: options.posted ? "View posting and approval" : "Review remaining cost", exact: true }).click();
  return { state, failures, dialog: page.getByRole("dialog") };
}
async function chooseInventory(dialog: ReturnType<Page["getByRole"]>) {
  await dialog.getByRole("radio", { name: /Historical inventory cost adjustment/ }).check();
  await dialog
    .getByLabel("Reason / supporting reference")
    .fill("Historical records reviewed; the missing movements cannot be attributed to sales.");
}

test("admin sees exact before/after, posts costs and reloads the saved financial result", async ({ page }, info) => {
  const { dialog, state, failures } = await installReconciliation(page);
  const approve = dialog.getByRole("button", { name: "Approve & post costs", exact: true });
  await expect(approve).toBeDisabled();
  await expect(dialog.getByText("Receipt #8 / line #9.", { exact: false })).toBeVisible();
  await chooseInventory(dialog);
  const table = dialog.getByRole("table", { name: "Cost reconciliation before and after" });
  await expect(table.getByRole("row", { name: /Unassigned cost/ })).toContainText("$10.0001");
  await expect(table.getByRole("row", { name: /Unassigned cost/ })).toContainText("$0.00");
  await expect(table.getByRole("row", { name: /Assigned to tracked/ })).toContainText("$89.9999");
  await expect(approve).toBeEnabled();
  const bounds = await approve.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await dialog.screenshot({ path: info.outputPath("cost-reconciliation-before-after.png") });
  await approve.click();
  await expect(dialog.getByText("Costs already posted", { exact: true })).toBeVisible();
  await expect(approve).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: "Approval details" })).toContainText("Test administrator");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByTestId("completed-costs").locator(":scope > summary").click();
  await expect(page.getByTestId("completed-costs")).toContainText("Shipping costs applied");
  await page.reload();
  await page.getByRole("button", { name: "View completed costs", exact: true }).click();
  await page.getByTestId("completed-costs").locator(":scope > summary").click();
  await page.getByRole("button", { name: "View posting and approval", exact: true }).click();
  await expect(dialog).toContainText("Test administrator");
  await expect(dialog).toContainText("Historical records reviewed");
  expect(state.bodies).toHaveLength(1);
  expect(Object.keys(state.bodies[0]).sort()).toEqual(["destination", "reason", "sourceVersion"]);
  expect(failures).toEqual([]);
});
test("missing receipt links show the full unassigned charge and affected receipt", async ({ page }) => {
  const { dialog, failures } = await installReconciliation(page, { missing: true });
  await chooseInventory(dialog);
  await expect(dialog.getByRole("row", { name: /Unassigned cost/ })).toContainText("$100.00");
  await expect(dialog).toContainText("subsequent cost links are missing");
  await expect(dialog).toContainText("This shipment charge is still estimated.");
  expect(failures).toEqual([]);
});
test("server authority gates posting even when the session UI says admin", async ({ page }) => {
  const { dialog, state, failures } = await installReconciliation(page, { viewer: true });
  await expect(dialog).toContainText("A current Administrator");
  await expect(dialog.getByRole("button", { name: "Approve & post costs", exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Reason / supporting reference")).toBeDisabled();
  expect(state.keys).toEqual([]);
  expect(failures).toEqual([]);
});
test("lost response locks the reviewed values and reuses the approval key", async ({ page }) => {
  const { dialog, state, failures } = await installReconciliation(page, { lostResponse: true });
  await chooseInventory(dialog);
  await dialog.getByRole("button", { name: "Approve & post costs", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("approval response was lost");
  await expect(dialog.getByLabel("Reason / supporting reference")).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry approval", exact: true }).click();
  await expect(dialog.getByText("Costs already posted", { exact: true })).toBeVisible();
  expect(state.keys).toHaveLength(2);
  expect(state.keys[1]).toBe(state.keys[0]);
  expect(state.bodies[1]).toEqual(state.bodies[0]);
  expect(failures).toEqual([]);
});
test("changed evidence requires a refreshed preview", async ({ page }) => {
  const { dialog, state, failures } = await installReconciliation(page, { stale: true });
  await chooseInventory(dialog);
  await dialog.getByRole("button", { name: "Approve & post costs", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("cost evidence changed");
  await dialog.getByRole("button", { name: "Reload review", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Approve & post costs", exact: true }).click();
  await expect(dialog.getByText("Costs already posted", { exact: true })).toBeVisible();
  expect(state.bodies[1].sourceVersion).toBe("c".repeat(64));
  expect(state.keys[1]).not.toBe(state.keys[0]);
  expect(failures).toEqual([]);
});
test("shipment allocation exposes the same reconciliation without another workflow", async ({ page }) => {
  const { dialog, failures } = await installReconciliation(page);
  await dialog.getByRole("button", { name: "Close review", exact: true }).click();
  await page.goto("/shipments/42?tab=allocation");
  const results = page.getByRole("region", { name: "Inventory cost results", exact: true });
  await results.getByRole("button", { name: "Review remaining cost", exact: true }).click();
  await chooseInventory(page.getByRole("dialog"));
  await expect(page.getByRole("table", { name: "Cost reconciliation before and after" })).toBeVisible();
  expect(failures).toEqual([]);
});

test("an already posted estimate shows its approval across the PO, shipment and modal", async ({ page }, info) => {
  const { dialog, state, failures } = await installReconciliation(page, { posted: true, missing: true });
  await expect(dialog.getByRole("heading", { name: "Shipment costs posted" })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Approval details" })).toContainText("Test administrator");
  await expect(dialog.getByRole("region", { name: "Approval details" })).toContainText("Goods were sold; historical records reviewed.");
  await expect(dialog).toContainText("No further cost approval is needed");
  await expect(dialog).toContainText("Supplier confirmation is separate from cost approval");
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Approve & post costs", exact: true })).toHaveCount(0);
  const done = dialog.getByRole("button", { name: "Done", exact: true });
  const bounds = await done.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await dialog.screenshot({ path: info.outputPath("posted-cost-approval.png") });
  await done.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Shipping costs applied", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Supplier confirmation:.*Their costs are already posted/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Update shipment costs", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Review \d+ line/ })).toHaveCount(0);
  await page.getByRole("heading", { name: "Purchase costs", exact: true }).locator("..").locator("..").locator("..")
    .screenshot({ path: info.outputPath("po-posted-costs.png") });
  await page.getByRole("link", { name: "View shipment cost details", exact: true }).click();
  const results = page.getByRole("region", { name: "Inventory cost results" });
  await expect(results).toContainText("Shipping costs applied");
  await results.getByTestId("completed-costs").locator(":scope > summary").click();
  await results.getByRole("button", { name: "View posting and approval", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Approval details" })).toContainText("Test administrator");
  await expect(dialog.getByRole("button", { name: "Approve & post costs", exact: true })).toHaveCount(0);
  expect(state.keys).toEqual([]);
  expect(failures).toEqual([]);
});

test("changing a posted destination requires explicit admin action and shows the transfer", async ({ page }) => {
  const { dialog, state, failures } = await installReconciliation(page, { posted: true });
  await dialog.getByRole("button", { name: "Change cost destination", exact: true }).click();
  await chooseInventory(dialog);
  const table = dialog.getByRole("table", { name: "Cost reconciliation before and after" });
  await expect(table.getByRole("row", { name: /Cost of goods already sold/ })).toContainText("$10.0001");
  await expect(table.getByRole("row", { name: /Cost of goods already sold/ })).toContainText("$0.00");
  await expect(table.getByRole("row", { name: /Historical inventory cost adjustment/ })).toContainText("$10.0001");
  await dialog.getByRole("button", { name: "Approve & post costs", exact: true }).click();
  await expect(dialog.getByText("Costs already posted", { exact: true })).toBeVisible();
  expect(state.bodies).toHaveLength(1);
  expect(state.bodies[0].destination).toBe("inventory_variance");
  expect(failures).toEqual([]);
});

test("a viewer sees saved approval details without controls or a permission warning", async ({ page }) => {
  const { dialog, state } = await installReconciliation(page, { posted: true, viewer: true });
  await expect(dialog.getByRole("region", { name: "Approval details" })).toBeVisible();
  await expect(dialog.getByText(/A current Administrator/)).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Change cost destination", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Approve & post costs", exact: true })).toHaveCount(0);
  expect(state.keys).toEqual([]);
});

test("a new unresolved revision restores the review task after reload", async ({ page }) => {
  const { dialog, state } = await installReconciliation(page, { posted: true });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  state.review = { ...state.review, reconciliation: { ...state.review.reconciliation!, status: "review_required", unassignedMills: 1 } };
  state.context = { ...state.context, state: state.review.reconciliation!, sourceVersion: "e".repeat(64),
    blockedReason: "Shipment costs changed. Update shipment costs, then review the new amounts." };
  await page.reload();
  await page.getByRole("button", { name: "Review costs", exact: true }).click();
  await expect(page.getByRole("button", { name: "View posting and approval", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update shipment costs", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review remaining cost", exact: true }).click();
  await expect(dialog.getByText("Costs already posted", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("alert")).toContainText("Shipment costs changed");
  expect(state.keys).toEqual([]);
});

test("a failed fresh read cannot show stale approval controls or claim completion", async ({ page }) => {
  const { dialog, state } = await installReconciliation(page, { posted: true });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.route("**/api/shipment-lines/23/cost-reconciliation", route => route.fulfill({ status: 500, json: { error: "Unavailable" } }));
  await page.getByRole("button", { name: "View posting and approval", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("history could not be loaded");
  await expect(dialog.getByText("Costs already posted", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Approve & post costs", exact: true })).toHaveCount(0);
  expect(state.keys).toEqual([]);
});
