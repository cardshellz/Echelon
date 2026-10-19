import { expect, test, type Page } from "@playwright/test";
import type {
  OriginRepairContext,
  OriginRepairSummary,
} from "../../shared/procurement/cost-origin-repair";
import type { PurchaseCostStatus } from "../../shared/procurement/purchase-cost-status";
import { installFixtures, po } from "./procurement-fixtures";
import {
  ordinaryPostedCosts,
  ordinaryPostedReview,
  historyWorkspace,
  shipmentDocument,
  currentAllocation,
  emptyDashboard,
  postedHealth,
} from "../fixtures/shipment-cost-cross-screen";

const summary: OriginRepairSummary = {
  receivedUnits: 10,
  basePieces: 500,
  stockQuantityChange: 0,
  components: [
    {
      component: "product",
      lotBeforeMills: 250000,
      lotAfterMills: 250000,
      historicalBeforeMills: 0,
      historicalAfterMills: 250000,
      orderCostDeltaCents: 0,
      lotsUpdated: 3,
    },
    {
      component: "packaging",
      lotBeforeMills: 50000,
      lotAfterMills: 50000,
      historicalBeforeMills: 0,
      historicalAfterMills: 50000,
      orderCostDeltaCents: 0,
      lotsUpdated: 3,
    },
    {
      component: "landed",
      lotBeforeMills: 0,
      lotAfterMills: 123400,
      historicalBeforeMills: 123400,
      historicalAfterMills: 123400,
      orderCostDeltaCents: 0,
      lotsUpdated: 1,
    },
  ],
};
async function install(page: Page, admin = true, loseResponse = false) {
  const failures = await installFixtures(page);
  let posted = false;
  const commands: unknown[] = [];
  const context = (): OriginRepairContext => ({
    lotId: 901,
    lotNumber: "TEST-JULY-LOT",
    sku: "TEST-COST-SKU",
    purchaseOrderId: 17,
    purchaseOrderLineId: 171,
    receiptId: 31,
    receiptNumber: "TEST-JULY-RECEIPT",
    receiptLineId: 32,
    receivedUnits: 10,
    onHandUnits: 0,
    sourceVersion: (posted ? "b" : "a").repeat(64),
    invoice: { id: 71, lineId: 72, amountMills: 1500000 },
    suggested: {
      unitsPerCase: 50,
      productMills: 1250000,
      packagingMills: 250000,
    },
    canApprove: admin,
    blockedReason: !admin
      ? "An active Administrator with purchasing approval permission must approve this repair."
      : posted
        ? "Already repaired."
        : null,
    approval: posted
      ? {
          id: 1,
          actorName: "Test Administrator",
          recordedAt: "2026-10-18T15:00:00.000Z",
          reason: "Supplier and receipt verified; goods were sold.",
          destination: "historical_cogs",
          summary,
        }
      : null,
  });
  const costs = (): PurchaseCostStatus => ({
    lines: [
      {
        purchaseOrderId: 17,
        purchaseOrderLineId: 171,
        sku: "TEST-COST-SKU",
        components: (["product", "packaging"] as const).map((component) => ({
          component,
          status: posted ? "applied" : "review_required",
          sourceEvidence: posted ? "confirmed" : "review_required",
          sourceCurrent: true,
          sourceRevisionId: 11,
          applicationId: posted ? 22 : 21,
          issues: posted
            ? []
            : [
                {
                  code: "COST_HISTORICAL_LINEAGE_MISSING",
                  message: "Receipt cost origin is missing.",
                },
              ],
        })),
        lots: [
          {
            id: 901,
            lotNumber: "TEST-JULY-LOT",
            onHandUnits: 0,
            shipmentId: 42,
            provisional: false,
            origin: posted ? "receipt" : "unproven",
          },
        ],
        invoices: [
          {
            invoiceId: 71,
            invoiceNumber: "TEST-INV",
            lineId: 72,
            lineNumber: 5,
          },
        ],
        receipts: [
          {
            receiptId: 31,
            receiptNumber: "TEST-JULY-RECEIPT",
            status: "closed",
          },
        ],
        originRepairs: posted ? [{ ...context().approval!, lotId: 901 }] : [],
      },
    ],
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/inventory-lots/901/cost-origin-repair")) {
      if (route.request().method() === "GET")
        return route.fulfill({ json: context() });
      const body = route.request().postDataJSON();
      if (path.endsWith("/preview"))
        return route.fulfill({
          json: {
            sourceVersion: body.sourceVersion,
            previewVersion: "c".repeat(64),
            summary,
          },
        });
      commands.push(body);
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      posted = true;
      if (loseResponse) return route.abort("failed");
      return route.fulfill({ json: context() });
    }
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: "test-user",
            username: "test",
            role: admin ? "admin" : "lead",
          },
          permissions: admin
            ? ["purchasing:view", "purchasing:approve"]
            : ["purchasing:view"],
          roles: admin ? ["admin"] : ["lead"],
        },
      });
    if (path === "/api/purchase-orders/17")
      return route.fulfill({ json: po(17) });
    if (path === "/api/purchase-orders/17/shipment-costs")
      return route.fulfill({
        json: { ...ordinaryPostedCosts(), supplierCosts: costs() },
      });
    if (path === "/api/purchase-orders/17/workspace") {
      const workspace = historyWorkspace();
      workspace.costTrace!.currentCosts = costs();
      const request = workspace.costTrace!.receiptCostRequests![0];
      request.currentCosts = costs().lines[0];
      request.recordedState = "review_required";
      request.state = posted ? "applied" : "review_required";
      return route.fulfill({ json: workspace });
    }
    if (/^\/api\/inbound-shipments\/(42|43)$/.test(path))
      return route.fulfill({
        json: { ...shipmentDocument, id: Number(path.split("/").at(-1)) },
      });
    if (/^\/api\/inbound-shipments\/(42|43)\/cost-review$/.test(path))
      return route.fulfill({
        json: {
          ...ordinaryPostedReview(),
          shipmentId: Number(path.split("/")[3]),
          supplierCosts: costs(),
        },
      });
    if (/^\/api\/inbound-shipments\/(42|43)\/allocation-status$/.test(path))
      return route.fulfill({
        json: { ...currentAllocation, shipmentId: Number(path.split("/")[3]) },
      });
    if (path === "/api/procurement/landed-cost-health")
      return route.fulfill({ json: postedHealth() });
    if (path === "/api/purchasing/dashboard")
      return route.fulfill({ json: emptyDashboard });
    // Unrelated dashboard reads must not inherit the generic [] fixture shape.
    if (["/api/procurement/health", "/api/purchasing/pipeline", "/api/purchasing/supplier-setup-gaps",
      "/api/purchasing/forecast-input-gaps", "/api/purchasing/auto-draft/stale-pos"].includes(path))
      return route.fulfill({ status: 503, json: { error: "Unrelated synthetic widget unavailable" } });
    return route.fallback();
  });
  await page.goto("/purchase-orders/17?tab=lifecycle");
  await page
    .getByRole("button", { name: "Repair historical cost origin", exact: true })
    .first()
    .click();
  return { failures, commands };
}
test("admin repairs origin with visible before/after and sees the approval across PO, both shipments and receipt history", async ({
  page,
}, info) => {
  // This single approval journey reloads seven screens. Keep each assertion's
  // timeout unchanged while allowing the full journey to finish on CI workers.
  test.slow();
  const { failures, commands } = await install(page);
  const dialog = page.getByRole("dialog");
  await expect(page.getByLabel("Pieces per case")).toHaveValue("50");
  await expect(page.getByLabel("Invoice product amount ($)")).toHaveValue(
    "125.0000",
  );
  await page
    .getByLabel("Reason / supporting reference")
    .fill("Supplier and receipt verified; goods were sold.");
  await dialog.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Review before and after" }).click();
  await expect(dialog).toContainText("500 pieces");
  await expect(dialog.getByRole("table")).toContainText("25.00");
  await expect(dialog.getByRole("table")).toContainText("12.34");
  await expect(dialog.getByRole("table")).toBeInViewport();
  await expect(
    dialog.getByText("TEST-COST-SKU · TEST-JULY-LOT", { exact: true }),
  ).toBeInViewport();
  const approve = page.getByRole("button", {
    name: "Approve repair & post costs",
  });
  await expect(approve).toBeInViewport();
  await page.screenshot({
    path: info.outputPath("origin-repair-before-after.png"),
  });
  await approve.click();
  await expect(dialog).toContainText("Test Administrator");
  await expect(dialog).toContainText("This repair is posted.");
  await expect(
    dialog.getByRole("button", { name: "Approve repair & post costs" }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Close review", exact: true })
    .click();
  await expect(page.getByTestId("receipt-cost-request-61")).toContainText(
    "Current supplier costs posted",
  );
  for (const id of [42, 43]) {
    await page.goto(`/shipments/${id}?tab=allocation`);
    const supplier = page.getByRole("region", {
      name: "Supplier product and packaging costs",
    });
    await expect(supplier).toContainText("Product: Posted");
    await expect(supplier).toContainText("Origin repaired");
    await supplier
      .getByRole("button", { name: "View origin repair and approval" })
      .click();
    await expect(dialog).toContainText(
      "Supplier and receipt verified; goods were sold.",
    );
    await dialog
      .getByRole("button", { name: "Close review", exact: true })
      .click();
  }
  await page.goto("/purchase-orders/17?tab=history");
  const approvals = page.getByRole("region", {
    name: "Receipt cost repair approvals",
  });
  await expect(approvals).toContainText("Test Administrator");
  await expect(approvals).toContainText(
    "Supplier and receipt verified; goods were sold.",
  );
  await expect(approvals.getByRole("table")).toContainText("25.00");
  await expect(approvals.getByRole("table")).toContainText("Before");
  await expect(approvals.getByRole("table")).toContainText("After");
  await page.goto("/receiving?open=31");
  const receiptCosts = page.getByRole("region", {
    name: "Receipt supplier cost status",
  });
  await expect(receiptCosts).toContainText("Product: Posted");
  await expect(receiptCosts).toContainText("Packaging: Posted");
  await expect(receiptCosts).toContainText("Test Administrator");
  await expect(
    receiptCosts.getByRole("button", {
      name: "Repair historical cost origin",
      exact: true,
    }),
  ).toHaveCount(0);
  await receiptCosts
    .getByRole("button", { name: "View origin repair and approval" })
    .click();
  await expect(page.getByRole("dialog").last()).toContainText(
    "Test Administrator",
  );
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  // Another receipt on this shipment must not inherit this receipt's approval.
  await page.goto("/receiving?open=32");
  await expect(receiptCosts).toContainText(
    "No supplier cost lines are linked to this receipt.",
  );
  await expect(
    receiptCosts.getByText("Product: Posted", { exact: true }),
  ).toHaveCount(0);
  const healthLoaded = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/procurement/landed-cost-health",
  );
  await page.goto("/purchasing");
  expect(await (await healthLoaded).json()).toEqual(postedHealth());
  await expect(page.getByRole("heading", { name: "Purchasing Dashboard", exact: true })).toBeVisible();
  await expect(
    page.getByText("Receipt cost origin is missing.", { exact: true }),
  ).toHaveCount(0);
  expect(commands).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("receipt cost read failures stay explicit and can be retried", async ({
  page,
}) => {
  const { failures } = await install(page);
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  let failed = true;
  await page.route("**/api/inbound-shipments/42/cost-review", (route) =>
    failed
      ? route.fulfill({ status: 503, json: { error: "Unavailable" } })
      : route.fallback(),
  );
  await page.goto("/receiving?open=31");
  const receiptCosts = page.getByRole("region", {
    name: "Receipt supplier cost status",
  });
  await expect(receiptCosts.getByRole("alert")).toContainText(
    "Current receipt costs could not be loaded.",
  );
  await expect(
    receiptCosts.getByText("Product: Posted", { exact: true }),
  ).toHaveCount(0);
  failed = false;
  await receiptCosts
    .getByRole("button", { name: "Reload receipt costs" })
    .click();
  await expect(
    receiptCosts.getByRole("button", { name: "Repair historical cost origin" }),
  ).toBeVisible();
  expect(failures).toEqual([]);
});
test("read-only user sees the actual admin requirement", async ({ page }) => {
  const { commands } = await install(page, false);
  await expect(page.getByRole("dialog")).toContainText(
    "An active Administrator with purchasing approval permission",
  );
  await expect(
    page.getByRole("button", { name: "Review before and after" }),
  ).toHaveCount(0);
  expect(commands).toEqual([]);
});
test("lost approval response reloads the committed approval without submitting again", async ({
  page,
}) => {
  const { commands } = await install(page, true, true);
  await page
    .getByLabel("Reason / supporting reference")
    .fill("Supplier and receipt verified; goods were sold.");
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Review before and after" }).click();
  await page
    .getByRole("button", { name: "Approve repair & post costs" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Test Administrator");
  await expect(
    page.getByRole("button", { name: "Approve repair & post costs" }),
  ).toHaveCount(0);
  expect(commands).toHaveLength(1);
});
