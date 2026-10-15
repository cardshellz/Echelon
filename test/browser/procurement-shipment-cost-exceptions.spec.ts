import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import type { ShipmentCostException } from "../../shared/procurement/shipment-cost-exception";
import type { ReconciliationContext, ReconciliationRequest } from "../../shared/procurement/cost-reconciliation";

async function installReconciliation(
  page: Page,
  options: { viewer?: boolean; lostResponse?: boolean; stale?: boolean; missing?: boolean } = {},
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
            estimatedCents: 0,
            unallocatedChargeCount: 0,
            unsupportedCurrencyCount: 0,
            appliedLines: 0,
            reviewLines: 1,
            pendingLines: 0,
            inventoryCosting: "review_required",
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
              status: "review_required",
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
  await page.getByRole("button", { name: "Review 1 line", exact: true }).click();
  await page.getByRole("button", { name: "Reconcile costs", exact: true }).click();
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
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Costs reconciled", { exact: true })).toBeVisible();
  await expect(page.getByText(/Costs reconciled on 1 shipment line/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "View reconciled costs", exact: true }).click();
  await page.getByRole("button", { name: "View reconciliation", exact: true }).click();
  await dialog.getByText("Posted adjustments (1)", { exact: true }).click();
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
  await expect(dialog).toHaveCount(0);
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
  await expect(dialog).toHaveCount(0);
  expect(state.bodies[1].sourceVersion).toBe("c".repeat(64));
  expect(state.keys[1]).not.toBe(state.keys[0]);
  expect(failures).toEqual([]);
});
test("shipment allocation exposes the same reconciliation without another workflow", async ({ page }) => {
  const { dialog, failures } = await installReconciliation(page);
  await dialog.getByRole("button", { name: "Close review", exact: true }).click();
  await page.goto("/shipments/42?tab=allocation");
  const results = page.getByRole("region", { name: "Inventory cost results", exact: true });
  await results.getByRole("button", { name: "Reconcile costs", exact: true }).click();
  await chooseInventory(page.getByRole("dialog"));
  await expect(page.getByRole("table", { name: "Cost reconciliation before and after" })).toBeVisible();
  expect(failures).toEqual([]);
});
