import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import type { ShipmentCostException, ShipmentExceptionDecision, ShipmentExceptionRequest } from "../../shared/procurement/shipment-cost-exception";

async function installException(page: Page, options: { viewer?: boolean; lostResponse?: boolean; stale?: boolean } = {}) {
  const failures = await installFixtures(page);
  const review: ShipmentCostException = { state: "open", fingerprint: "b".repeat(64), kind: "unexplained_quantity", currency: "USD",
    allocatedMills: 28279900, amountMills: 520608, lotsUpdated: 34, cogsRowsUpdated: 326, decision: null,
    issues: [{ code: "COST_UNRESOLVED_QUANTITY_RETAINED", message: "LEGACY-CASE has four units with no recorded movement.",
      unresolvedQuantity: { inventoryLotId: 3364, allocationId: 11, lotNumber: "LEGACY-CASE", originalQuantity: 220,
        onHandQuantityAtReview: 157, recordedOutflowQuantityAtReview: 59, quantity: 4, component: "landed", amountMills: 520608 } }] };
  const state = { review, keys: [] as string[], bodies: [] as ShipmentExceptionRequest[], saved: null as ShipmentExceptionDecision | null, version: "a".repeat(64),
    history: [] as (ShipmentExceptionDecision & { amountMills: number; currency: string })[] };
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "test-user", username: "test", role: "admin" },
      roles: ["admin"], permissions: ["purchasing:view", "purchasing:approve"] } });
    if (path === "/api/purchase-orders/17") return route.fulfill({ json: po(17) });
    if (path === "/api/inbound-shipments/42") return route.fulfill({ json: {
      id: 42, shipmentNumber: "TEST-SEA-42", status: "closed", mode: "sea_fcl", purchaseOrderId: 17, statusHistory: [],
      lines: [{ id: 141, purchaseOrderId: 17, purchaseOrderLineId: 101, sku: "TEST-PRODUCT", productName: "Test product", qtyShipped: 2200000, cartonCount: 220 }],
      costs: [{ id: 71, costType: "freight", actualCents: 282799, estimatedCents: 282799, currency: "USD", costStatus: "finalized" }],
    } });
    if (path === "/api/purchase-orders/17/shipment-costs") return route.fulfill({ json: {
      summary: { currency: "USD", shipmentCount: 1, chargeCount: 1, freightCents: 282799, dutyCents: 0, otherCents: 0,
        totalCents: 282799, poAmountCents: 6465550, combinedCostCents: 6748349, estimatedCents: 0,
        unallocatedChargeCount: 0, unsupportedCurrencyCount: 0, appliedLines: 0, reviewLines: 1, pendingLines: 0, inventoryCosting: "review_required" },
      supplier: { freightCents: 0, dutyCents: 0 }, totals: { freightCents: 282799, dutyCents: 0, combinedCostCents: 6748349 },
      lines: [{ lineId: 141, shipmentId: 42, shipmentNumber: "TEST-SEA-42", shipmentStatus: "closed", sku: "TEST-PRODUCT",
        allocatedCents: 282799, status: "review_required", applicationId: 9, recordedAt: "2026-10-15T12:00:00Z", issues: review.issues, exceptionReview: state.review }],
    } });
    if (path === "/api/inbound-shipments/42/cost-review") return route.fulfill({ json: { shipmentId: 42,
      lines: [{ lineId: 141, sku: "TEST-PRODUCT", sourceIssue: null, exceptionReview: state.review,
        application: { id: 9, status: "review_required", recordedAt: "2026-10-15T12:00:00Z", lotsUpdated: 34, cogsRowsUpdated: 326, issues: review.issues } }] } });
    if (path === "/api/shipment-lines/141/cost-exception") {
      if (req.method() === "GET") return route.fulfill({ json: { shipmentId: 42, lineId: 141, sku: "TEST-PRODUCT", sourceVersion: state.version,
        canApprove: !options.viewer, blockedReason: options.viewer ? "A current Administrator with purchasing approval permission must approve this decision." : null, review: state.review, history: state.history } });
      const body = req.postDataJSON() as ShipmentExceptionRequest;
      state.keys.push(req.headers()["idempotency-key"]); state.bodies.push(body);
      if (options.stale && state.keys.length === 1) {
        state.version = "c".repeat(64);
        return route.fulfill({ status: 409, json: { code: "SHIPMENT_EXCEPTION_STALE", error: "The cost evidence changed. Reload and review the new before and after values." } });
      }
      if (state.keys.length === 1 || state.keys.at(-2) !== state.keys.at(-1)) {
        state.saved = { id: state.keys.length, action: body.action,
          fingerprint: review.fingerprint, actorId: "test-admin", actorName: "Test administrator", reason: body.reason, recordedAt: "2026-10-15T12:00:00Z" };
        state.history.unshift({ ...state.saved, amountMills: review.amountMills, currency: review.currency });
      }
      state.review = { ...review, state: body.action === "accept" ? "accepted" : "open", decision: state.saved };
      if (options.lostResponse && state.keys.length === 1) return route.abort("connectionreset");
      return route.fulfill({ json: { lineId: 141, shipmentId: 42, decision: state.saved } });
    }
    return route.fallback();
  });
  await page.goto("/purchase-orders/17?tab=lines");
  await page.getByRole("button", { name: "Review 1 line", exact: true }).click();
  await page.getByRole("button", { name: "Review exception", exact: true }).click();
  return { state, failures, dialog: page.getByRole("dialog") };
}

test("an admin reviews exact before/after, accepts, reloads and reopens without editing charges", async ({ page }, info) => {
  const { state, failures, dialog } = await installException(page);
  await expect(dialog.getByRole("table", { name: "Exception before and after" })).toBeVisible();
  await expect(dialog.getByText("$52.0608", { exact: true })).toHaveCount(2);
  await expect(dialog.getByText("$2,827.99", { exact: true })).toHaveCount(2);
  const approve = dialog.getByRole("button", { name: "Accept historical difference", exact: true });
  await expect(approve).toBeDisabled();
  await dialog.getByLabel("Reason / supporting reference").fill("Reviewed historic movements; original evidence is unavailable.");
  await expect(approve).toBeEnabled();
  const bounds = await approve.boundingBox(); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await dialog.screenshot({ path: info.outputPath("historical-difference-before-after.png") });
  await approve.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Historical difference accepted", { exact: true })).toBeVisible();
  await expect(page.getByTestId("po-freight-summary-card")).toContainText("$2,827.99");
  await expect(page.getByText(/1 historical inventory difference is accepted/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "View accepted differences", exact: true }).click();
  await page.getByRole("button", { name: "Review decision", exact: true }).click();
  await dialog.getByText("Decision history (1)", { exact: true }).click();
  await expect(dialog).toContainText("Reviewed historic movements; original evidence is unavailable.");
  await dialog.getByLabel("Reason / supporting reference").fill("New supplier documentation needs review.");
  await dialog.getByRole("button", { name: "Reopen exception", exact: true }).click();
  await expect(page.getByText("Inventory history exception", { exact: true })).toBeVisible();
  expect(state.bodies.map(body => body.action)).toEqual(["accept", "reopen"]);
  expect(state.bodies.every(body => Object.keys(body).sort().join(",") === "action,reason,sourceVersion")).toBe(true);
  expect(failures).toEqual([]);
});

test("server approval authority controls the dialog even when session UI says admin", async ({ page }) => {
  const { dialog, state, failures } = await installException(page, { viewer: true });
  await expect(dialog).toContainText("A current Administrator with purchasing approval permission must approve this decision.");
  await expect(dialog.getByRole("button", { name: "Accept historical difference", exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Reason / supporting reference")).toBeDisabled();
  expect(state.keys).toEqual([]); expect(failures).toEqual([]);
});

test("a lost approval response locks the request and retries the same reviewed values", async ({ page }) => {
  const { dialog, state, failures } = await installException(page, { lostResponse: true });
  await dialog.getByLabel("Reason / supporting reference").fill("Missing records investigated with operations.");
  await dialog.getByRole("button", { name: "Accept historical difference", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("approval response was lost");
  await expect(dialog.getByLabel("Reason / supporting reference")).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry approval", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.keys).toHaveLength(2); expect(state.keys[1]).toBe(state.keys[0]); expect(state.bodies[1]).toEqual(state.bodies[0]);
  expect(failures).toEqual([]);
});

test("stale approval requires a refreshed preview before another confirmation", async ({ page }) => {
  const { dialog, state, failures } = await installException(page, { stale: true });
  await dialog.getByLabel("Reason / supporting reference").fill("Historical evidence reviewed with the warehouse.");
  await dialog.getByRole("button", { name: "Accept historical difference", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("cost evidence changed");
  await dialog.getByRole("button", { name: "Reload review", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Accept historical difference", exact: true }).click();
  await expect(dialog).toHaveCount(0); expect(state.bodies[1].sourceVersion).toBe("c".repeat(64));
  expect(state.keys[1]).not.toBe(state.keys[0]); expect(failures).toEqual([]);
});

test("the same exception and admin action are available directly on the shipment", async ({ page }) => {
  const { dialog, failures } = await installException(page);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto("/shipments/42?tab=allocation");
  const results = page.getByRole("region", { name: "Inventory cost results", exact: true });
  await expect(results).toContainText("$52.0608 remains separate");
  await results.getByRole("button", { name: "Review exception", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("table", { name: "Exception before and after" })).toBeVisible();
  expect(failures).toEqual([]);
});
