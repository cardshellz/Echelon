import { shipmentListItem } from "../fixtures/shipment-work-list";
import { landedCostHealthSchema } from "../../shared/procurement/landed-cost-health";
import { expect, test, type Page } from "@playwright/test";
import { buildProcurementHealthSummary } from "../../server/modules/procurement/procurement-health.service";
import { buildStaleAutoDraftPoDiagnostics } from "../../server/modules/procurement/auto-draft-po-aging.service";
import type { PoShipmentCosts } from "../../shared/procurement/po-shipment-costs";
import type { ShipmentCostReview } from "../../shared/procurement/shipment-cost-workflow";
import type { PurchaseWorkspace } from "../../shared/procurement/purchase-workspace";
import type { PurchaseCostStatus } from "../../shared/procurement/purchase-cost-status";
import { installFixtures, po } from "./procurement-fixtures";
import {
  currentAllocation, currentCostIssue, currentSourceNeedsReview, emptyDashboard, historyWorkspace,
  ordinaryPostedCosts, ordinaryPostedReview, originalCostIssue, shipmentDocument,
  postedHealth, postedOtherCostWarning, postedWithOtherProvisionalCosts, reconciledCosts, reconciledHistoryWorkspace, unresolvedHealth,
} from "../fixtures/shipment-cost-cross-screen";

interface ScreenState {
  costs: PoShipmentCosts;
  review: ShipmentCostReview;
  workspace: PurchaseWorkspace;
  health: unknown;
  failCosts: boolean;
  failReview: boolean;
  failWorkspace: boolean;
  failHealth: boolean;
  healthReads: number;
}
async function installCostScreens(page: Page) {
  const failures = await installFixtures(page);
  const state: ScreenState = {
    costs: ordinaryPostedCosts(), review: ordinaryPostedReview(), workspace: historyWorkspace(),
    health: postedHealth(), failCosts: false, failReview: false, failWorkspace: false, failHealth: false, healthReads: 0,
  };
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") return route.fallback();
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "test-user", username: "test", role: "admin" },
      roles: ["admin"], permissions: ["purchasing:view", "purchasing:approve"] } });
    if (path === "/api/purchase-orders/17") return route.fulfill({ json: { ...po(17), subtotalCents: 100000, totalCents: 100000 } });
    if (path === "/api/purchase-orders/17/shipment-costs") return route.fulfill(state.failCosts
      ? { status: 503, json: { error: "Synthetic cost summary unavailable" } } : { json: state.costs });
    if (path === "/api/purchase-orders/17/workspace") return route.fulfill(state.failWorkspace
      ? { status: 503, json: { error: "Synthetic history unavailable" } } : { json: state.workspace });
    if (path === "/api/inbound-shipments") return route.fulfill({ json: { shipments: [shipmentListItem(shipmentDocument)], total: 1, limit: 50, offset: 0, hasMore: false, costHealthItems: landedCostHealthSchema.safeParse(state.health).success ? landedCostHealthSchema.parse(state.health).items : [] } });
    if (path === "/api/inbound-shipments/42") return route.fulfill({ json: shipmentDocument });
    if (path === "/api/inbound-shipments/42/allocation-status") return route.fulfill({ json: currentAllocation });
    if (path === "/api/inbound-shipments/42/cost-review") return route.fulfill(state.failReview
      ? { status: 503, json: { error: "Synthetic cost results unavailable" } } : { json: state.review });
    if (path === "/api/procurement/landed-cost-health") {
      state.healthReads++;
      return route.fulfill(state.failHealth ? { status: 503, json: { error: "Synthetic cost health unavailable" } } : { json: state.health });
    }
    if (path === "/api/purchasing/dashboard") return route.fulfill({ json: emptyDashboard });
    if (["/api/procurement/health", "/api/purchasing/pipeline", "/api/purchasing/supplier-setup-gaps",
      "/api/purchasing/forecast-input-gaps", "/api/purchasing/auto-draft/stale-pos"].includes(path))
      return route.fulfill({ status: 503, json: { error: "Unrelated synthetic widget unavailable" } });
    return route.fallback();
  });
  return { state, failures };
}

const postedSummary = "Shipment costs are posted. No shipment cost approval is outstanding.";
const postedShipment = "Costs posted on 1 of 1 shipment lines.";

function supplierCosts(posted: boolean): PurchaseCostStatus {
  return { lines: [{ purchaseOrderId: 17, purchaseOrderLineId: 171, sku: "TEST-COST-SKU",
    components: (["product", "packaging"] as const).map(component => ({ component,
      status: posted ? "applied" : "review_required", sourceEvidence: posted ? "confirmed" : "review_required",
      sourceCurrent: true, sourceRevisionId: 11, applicationId: posted ? 22 : 21,
      issues: posted ? [] : [{ code: "INVOICE_COMPONENT_REVIEW_REQUIRED", message: "Supplier product and packaging amounts have not been recorded." }] })),
    invoices: [{ invoiceId: 71, invoiceNumber: "TEST-INV-71", lineId: 72, lineNumber: 1 }],
    receipts: [{ receiptId: 31, receiptNumber: "TEST-RCV-31", status: "closed" }],
    lots: Array.from({length:16}, (_, index) => ({ id: 901+index, lotNumber: `TEST-LOT-${901+index}`, onHandUnits: 1,
      shipmentId: 42, provisional: true, origin: index === 0 ? "receipt" : "transformation" })),
  }] };
}

test("a closed PO retains posted freight and offers direct supplier follow-ups without another approval", async ({ page }, info) => {
  const { state, failures } = await installCostScreens(page);
  state.costs = reconciledCosts().costs;
  state.costs.supplierCosts = supplierCosts(false);
  await page.route("**/api/purchase-orders/17", route => route.fulfill({ json: {
    ...po(17), status: "closed", physicalStatus: "received", subtotalCents: 100000, totalCents: 100000,
  } }));
  await page.goto("/purchase-orders/17?tab=lines");
  const closed = page.getByTestId("po-closed-summary");
  await expect(closed).toContainText("This purchase order is closed");
  await expect(closed).toContainText("They do not reopen this PO.");
  await expect(page.getByRole("button", { name: "Close PO", exact: true })).toHaveCount(0);
  await expect(page.getByText(/shipment lines have an inventory cost exception/)).toHaveCount(0);
  await page.getByRole("button", { name: "Review supplier costs", exact: true }).click();
  await expect(page.getByText("Supplier product and packaging amounts have not been recorded.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review invoice TEST-INV-71 · line 1", exact: true }))
    .toHaveAttribute("href", /costLine=72/);
  await expect(page.getByRole("button", { name: "Approve & post costs", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update shipment costs", exact: true })).toHaveCount(0);
  await closed.getByRole("button", { name: "View closure history", exact: true }).click();
  await expect(page.getByRole("tab", { name: "History", exact: true })).toHaveAttribute("data-state", "active");
  await closed.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("closed-po-cost-followups.png") });
  expect(failures).toEqual([]);
});

test("resolves supplier evidence from health and refreshes both shipments, PO receipt processing and history", async ({ page }, info) => {
  const { state, failures } = await installCostScreens(page);
  const commands: unknown[] = [];
  function reflect(posted: boolean) {
    const current = supplierCosts(posted);
    state.review.supplierCosts = current;
    state.costs.supplierCosts = current;
    state.workspace.costTrace!.currentCosts = current;
    const request = state.workspace.costTrace!.receiptCostRequests![0];
    request.currentCosts = current.lines[0];
    request.recordedState = "review_required";
    request.state = posted ? "applied" : "review_required";
    request.attempts[0].state = "review_required";
    request.attempts[0].issues = [{ code: "INVOICE_COMPONENT_REVIEW_REQUIRED", message: "Supplier amounts were missing at receipt." }];
    state.health = posted ? postedHealth() : { ...postedWithOtherProvisionalCosts(), items: [{
      ...postedWithOtherProvisionalCosts().items[0], detail: "Landed costs are posted. 16 lots need supplier product and packaging evidence.",
    }] };
  }
  reflect(false);
  const invoice = { id: 71, invoiceNumber: "TEST-INV-71", vendorId: 2, vendorName: "Test vendor", status: "approved", currency: "USD",
    invoicedAmountCents: 11800, balanceCents: 11800, paidAmountCents: 0, poLinks: [{purchaseOrderId:17,poNumber:"TEST-PO-17"}], attachments: [], payments: [],
    lines: [{ id: 72, lineNumber: 1, sku: "TEST-COST-SKU", productName: "Test product", qtyInvoiced: 100, unitCostCents: 100,
      lineTotalCents: 11800, matchStatus: "over_billed", costComponentEvidence: null as unknown, costReviewVersion: "a".repeat(64) }] };
  await page.route("**/api/vendor-invoices/71", route => route.fulfill({json:invoice}));
  await page.route("**/api/inbound-shipments/43", route => route.fulfill({json:{...shipmentDocument,id:43,shipmentNumber:"TEST-COST-43"}}));
  await page.route("**/api/inbound-shipments/43/allocation-status", route => route.fulfill({json:{...currentAllocation,shipmentId:43}}));
  await page.route("**/api/inbound-shipments/43/cost-review", route => route.fulfill({json:{...state.review,shipmentId:43}}));
  await page.route("**/api/inbound-shipments/43/invoices", route => route.fulfill({json:{invoices:[],summary:{invoiceCount:0}}}));
  await page.route("**/api/vendor-invoice-lines/72/cost-components", async route => {
    const body = route.request().postDataJSON();
    commands.push(body);
    invoice.lines[0].costComponentEvidence = { contractVersion:1, source:"operator_review", packagingTreatment:body.packagingTreatment,
      productMills:body.productMills,packagingMills:body.packagingMills,adjustmentMills:body.adjustmentMills };
    invoice.lines[0].costReviewVersion = "b".repeat(64);
    reflect(true);
    await route.fulfill({json:{id:72,costComponentEvidence:invoice.lines[0].costComponentEvidence,costReviewVersion:invoice.lines[0].costReviewVersion,
      application:{costSources:[],lotsUpdated:16,cogsRowsUpdated:1,totalCogsDeltaCents:50,costApplications:[{
        applicationId:22,status:"applied",lotsUpdated:16,cogsRowsUpdated:1,totalCogsDeltaCents:50,issues:[],replayed:false,
      }]}}});
  });
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(page.getByText("Shipment costs are posted. Supplier product and packaging costs still need review below.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review supplier costs", exact: true }).click();
  await expect(page.getByRole("region", { name: "Supplier product and packaging costs" })).toContainText("TEST-COST-SKU");
  const health = await openHealth(page, "/purchasing");
  await health.getByRole("button",{name:"Review",exact:true}).click();
  await expect(page.getByRole("tab",{name:"Cost review",exact:true})).toHaveAttribute("data-state","active");
  const supplier = page.getByRole("region",{name:"Supplier product and packaging costs"});
  await expect(supplier).toContainText("Confirm the product and packaging amounts");
  await supplier.getByText("Affected lot history (16)",{exact:true}).click();
  await expect(supplier).toContainText("TEST-LOT-916");
  await supplier.getByRole("link",{name:"Review invoice TEST-INV-71 · line 1",exact:true}).click();
  await expect(page.getByRole("dialog")).toContainText("Invoice cost breakdown");
  await page.getByLabel("Is packaging included in the product price?",{exact:true}).click();
  await page.getByRole("option",{name:"No, packaging is charged separately"}).click();
  await page.getByLabel(/^Product total/).fill("100");
  await page.getByLabel(/^Packaging total/).fill("18");
  await page.getByLabel(/^Other adjustments/).fill("0");
  await page.getByLabel("Notes / supplier invoice reference").fill("Supplier invoice amounts reviewed");
  await page.getByRole("button",{name:"Save cost review",exact:true}).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Cost evidence saved");
  await page.getByRole("button",{name:"Close review",exact:true}).click();
  await page.getByRole("link",{name:"Back to shipment #42",exact:true}).first().click();
  await expect(supplier).toContainText("Product: Posted");
  await expect(supplier).not.toContainText("Needs review");
  await page.goto("/shipments/43?tab=allocation");
  await expect(supplier).toContainText("Packaging: Posted");
  await page.goto("/purchase-orders/17?tab=lifecycle");
  const receipt = page.getByTestId("receipt-cost-request-61");
  await expect(receipt).toContainText("Current supplier costs posted");
  await expect(receipt.getByRole("button",{name:"Apply current supplier costs"})).toHaveCount(0);
  await receipt.getByText("1 recorded cost attempt",{exact:true}).click();
  await expect(receipt).toContainText("Supplier amounts were missing at receipt.");
  await expect(receipt).toContainText("A later supplier-cost application completed");
  await page.screenshot({path:info.outputPath("supplier-receipt-current-status.png"),fullPage:true});
  await openHealth(page,"/purchasing");
  await expect(page.getByText("16 lots need supplier product and packaging evidence.",{exact:false})).toHaveCount(0);
  expect(commands).toHaveLength(1);
  expect(invoice.lines[0].lineTotalCents).toBe(11800);
  expect(failures).toEqual([]);
});

test("mixed receipt history keeps supplier issues visible for lines without queue requests", async ({ page }) => {
  const { state, failures } = await installCostScreens(page);
  const covered = supplierCosts(true).lines[0];
  const legacy = { ...supplierCosts(false).lines[0], purchaseOrderLineId: 172, sku: "LEGACY-SUPPLIER-LINE",
    invoices: [{ invoiceId: 71, invoiceNumber: "TEST-INV-71", lineId: 73, lineNumber: 2 }] };
  state.workspace.costTrace!.currentCosts = { lines: [covered, legacy] };
  const request = state.workspace.costTrace!.receiptCostRequests![0];
  request.currentCosts = covered;
  request.state = "applied";
  request.recordedState = "review_required";
  await page.goto("/purchase-orders/17?tab=lifecycle");
  await expect(page.getByTestId("supplier-cost-line-171")).toHaveCount(1);
  await expect(page.getByTestId("receipt-cost-request-61")).toContainText("Current supplier costs posted");
  const outstanding = page.getByTestId("supplier-cost-line-172");
  await expect(outstanding).toContainText("LEGACY-SUPPLIER-LINE");
  await expect(outstanding).toContainText("Product: Needs review");
  await expect(outstanding.getByRole("link", { name: "Review invoice TEST-INV-71 · line 2", exact: true }))
    .toHaveAttribute("href", /costLine=73/);
  expect(failures).toEqual([]);
});

test("ordinary applied estimates stay posted on PO and shipment after navigation and reload", async ({ page }, info) => {
  const { failures } = await installCostScreens(page);
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(page.getByText(postedSummary, { exact: true })).toBeVisible();
  await expect(page.getByText(/Supplier confirmation:.*Their costs are already posted/)).toBeVisible();
  await expect(page.getByText(/Inventory costing is awaiting/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Review \d+ line/ })).toHaveCount(0);
  await page.getByRole("button", { name: "View shipments", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Shipments/ })).toHaveAttribute("data-state", "active");
  await page.goto("/shipments/42?tab=allocation&purchase=purchase%3A17%3Alines");
  const results = page.getByRole("region", { name: "Inventory cost results", exact: true });
  await expect(results).toContainText(postedShipment);
  await expect(results).toContainText("No shipment cost approval is outstanding.");
  await expect(page.getByRole("button", { name: "Update shipment costs", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(results).toContainText(postedShipment);
  await page.getByRole("link", { name: "Back to purchase #17", exact: true }).first().click();
  await expect(page.getByText(postedSummary, { exact: true })).toBeVisible();
  await expect(page.getByText(/Supplier confirmation:.*Their costs are already posted/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("ordinary-estimate-posted-po.png"), fullPage: true });
  expect(failures).toEqual([]);
});

test("a new source issue reopens review on both details instead of retaining old completion", async ({ page }) => {
  const { state, failures } = await installCostScreens(page);
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(page.getByText(postedSummary, { exact: true })).toBeVisible();
  const changed = currentSourceNeedsReview();
  state.costs = changed.costs;
  state.review = changed.review;
  await page.reload();
  await expect(page.getByText(postedSummary, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Review 1 line", exact: true }).click();
  await expect(page.getByText(currentCostIssue.message, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "View shipment cost details", exact: true }).click();
  const results = page.getByRole("region", { name: "Inventory cost results", exact: true });
  await expect(results).toContainText(currentCostIssue.message);
  await expect(results).not.toContainText(postedShipment);
  await expect(results).toContainText("Needs attention");
  expect(failures).toEqual([]);
});

test("failed current cost reads hide completion on both details and recover through their retry controls", async ({ page }) => {
  const { state, failures } = await installCostScreens(page);
  state.failCosts = true;
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(page.getByText("Shipment costs could not be loaded.", { exact: true })).toBeVisible();
  await expect(page.getByText(postedSummary, { exact: true })).toHaveCount(0);
  state.failCosts = false;
  await page.getByRole("alert").filter({ hasText: "Shipment costs could not be loaded." }).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText(postedSummary, { exact: true })).toBeVisible();
  state.failReview = true;
  await page.goto("/shipments/42?tab=allocation");
  const results = page.getByRole("region", { name: "Inventory cost results", exact: true });
  await expect(results.getByRole("alert")).toContainText("Saved cost results could not be loaded.");
  await expect(results).not.toContainText(postedShipment);
  state.failReview = false;
  await results.getByRole("button", { name: "Reload cost results", exact: true }).click();
  await expect(results).toContainText(postedShipment);
  expect(failures).toEqual([]);
});

async function openHealth(page: Page, path: "/shipments" | "/purchasing") {
  await page.goto(path);
  if (path === "/purchasing") await page.getByText("Planning and system details", { exact: false }).first().click();
  return page.getByRole("region", { name: "Landed Cost Health", exact: true });
}

for (const path of ["/shipments", "/purchasing"] as const) {
  test(`${path} keeps reconciled landed costs separate from other provisional supplier costs`, async ({ page }, info) => {
    const { state, failures } = await installCostScreens(page);
    const reconciled = reconciledCosts();
    state.costs = reconciled.costs;
    state.review = reconciled.review;
    state.health = postedWithOtherProvisionalCosts();
    const health = await openHealth(page, path);
    await expect(health).toContainText(postedOtherCostWarning);
    expect(await health.getByText(postedOtherCostWarning, { exact: true }).evaluate(element =>
      element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight),
    "The health explanation must be fully readable without clipping").toBe(true);
    await expect(health).toContainText("0 critical");
    await expect(health.getByRole("button", { name: /^Push Costs/ })).toHaveCount(0);
    await expect(health).not.toContainText("1 provisional lot(s) still linked to a closed shipment");
    await health.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Cost review", exact: true })).toHaveAttribute("data-state", "active");
    await expect(page.getByRole("region", { name: "Inventory cost results", exact: true })).toContainText(postedShipment);
    await openHealth(page, path);
    await expect(health).toContainText(postedOtherCostWarning);
    expect(state.healthReads).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await health.screenshot({ path: info.outputPath(`posted-health-${path.slice(1)}.png`) });
    expect(failures).toEqual([]);
  });

  test(`${path} keeps a new unresolved source actionable after reload`, async ({ page }) => {
    const { state, failures } = await installCostScreens(page);
    state.health = postedWithOtherProvisionalCosts();
    const health = await openHealth(page, path);
    await expect(health).toContainText(postedOtherCostWarning);
    const changed = currentSourceNeedsReview();
    state.costs = changed.costs;
    state.review = changed.review;
    state.health = unresolvedHealth();
    await openHealth(page, path);
    await expect(health).toContainText(currentCostIssue.message);
    await expect(health).not.toContainText(postedOtherCostWarning);
    await health.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Cost review", exact: true })).toHaveAttribute("data-state", "active");
    const results = page.getByRole("region", { name: "Inventory cost results", exact: true });
    await expect(results).toContainText(currentCostIssue.message);
    await expect(results).not.toContainText(postedShipment);
    expect(failures).toEqual([]);
  });

  for (const failure of ["unavailable", "invalid"] as const) {
    test(`${path} rejects ${failure} health evidence without claiming completion and retries`, async ({ page }) => {
      const { state, failures } = await installCostScreens(page);
      if (failure === "unavailable") state.failHealth = true;
      else state.health = { status: "healthy", items: [] };
      const health = await openHealth(page, path);
      await expect(health.getByRole("alert")).toContainText("Landed cost health is unavailable.");
      await expect(health).not.toContainText("0 critical");
      await expect(health.getByRole("button", { name: /^Push Costs/ })).toHaveCount(0);
      state.failHealth = false;
      state.health = postedWithOtherProvisionalCosts();
      await health.getByRole("button", { name: "Retry cost health", exact: true }).click();
      await expect(health).toContainText(postedOtherCostWarning);
      await expect(health.getByRole("alert")).toHaveCount(0);
      expect(failures).toEqual([]);
    });
  }
}

test("purchase history shows the current approval without rewriting the original unsuccessful attempt", async ({ page }, info) => {
  const { state, failures } = await installCostScreens(page);
  const reconciled = reconciledCosts();
  state.costs = reconciled.costs;
  state.review = reconciled.review;
  state.workspace = reconciledHistoryWorkspace();
  await page.goto("/purchase-orders/17?tab=lifecycle");
  const revision = page.getByTestId("cost-revision-11");
  const resolution = revision.getByTestId("cost-resolution-11");
  await expect(resolution).toContainText("Costs posted after approval");
  await expect(resolution).toContainText("$10.0000");
  await expect(resolution).toContainText("Posting #901");
  await expect(resolution).toContainText("Approval #81");
  await expect(resolution).toContainText("Test administrator");
  await expect(resolution).toContainText("Historical sale evidence reviewed and approved.");
  const application = revision.getByTestId("cost-application-21");
  await expect(application.locator(":scope > summary")).toContainText("Recorded review");
  await expect(application.locator(":scope > summary")).not.toContainText("Review required");
  await application.locator(":scope > summary").click();
  await expect(application).toContainText("Original result: Review required.");
  await expect(application).toContainText(originalCostIssue.message);
  await expect(application).toContainText(originalCostIssue.code);
  await expect(application).toContainText("Recorded by test-owner");
  await expect(revision).toContainText("Estimated");
  await revision.screenshot({ path: info.outputPath("resolved-cost-application-history.png") });
  await page.reload();
  await expect(resolution).toContainText("Approval #81");
  await expect(application.locator(":scope > summary")).toContainText("Recorded review");
  await page.getByRole("tab", { name: /^Lines/ }).click();
  await expect(page.getByText(postedSummary, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View cost postings", exact: true }).click();
  await page.getByRole("link", { name: "View shipment cost details", exact: true }).click();
  await expect(page.getByRole("region", { name: "Inventory cost results", exact: true })).toContainText(postedShipment);
  expect(failures).toEqual([]);
});

test("a later unresolved revision keeps its task active and retains prior cost application history", async ({ page }) => {
  const { state, failures } = await installCostScreens(page);
  state.workspace = reconciledHistoryWorkspace();
  await page.goto("/purchase-orders/17?tab=lifecycle");
  await expect(page.getByTestId("cost-resolution-11")).toBeVisible();
  const revisions = state.workspace.costTrace!.applicationHistory!.revisions;
  const oldRevision = revisions[0];
  oldRevision.latestRecordedSourceRevision = false;
  oldRevision.currentResolution = null;
  oldRevision.applications.forEach(application => { application.resolvedByCurrentPosting = false; });
  const latest = structuredClone(oldRevision);
  latest.id = 12;
  latest.revision = 3;
  latest.latestRecordedSourceRevision = true;
  latest.fingerprint = "c".repeat(64);
  latest.source = { ...latest.source!, revision: 3, fingerprint: "c".repeat(64) };
  latest.applications = [{ ...latest.applications[0], id: 22, issues: [currentCostIssue] }];
  revisions.unshift(latest);
  await page.reload();
  await expect(page.getByTestId("cost-resolution-11")).toHaveCount(0);
  await expect(page.getByTestId("cost-resolution-12")).toHaveCount(0);
  const application = page.getByTestId("cost-application-22");
  await expect(application.locator(":scope > summary")).toContainText("Review required");
  await application.locator(":scope > summary").click();
  await expect(application).toContainText(currentCostIssue.message);
  await page.getByTestId("cost-revision-11").locator(":scope > summary").click();
  const oldApplication = page.getByTestId("cost-application-21");
  await oldApplication.locator(":scope > summary").click();
  await expect(oldApplication).toContainText(originalCostIssue.message);
  await expect(oldApplication).toContainText("Original result: Review required.");
  expect(failures).toEqual([]);
});

test("unavailable purchase history does not reuse a posted claim and can be reloaded", async ({ page }) => {
  const { state, failures } = await installCostScreens(page);
  state.workspace = reconciledHistoryWorkspace();
  await page.goto("/purchase-orders/17?tab=lifecycle");
  await expect(page.getByTestId("cost-resolution-11")).toBeVisible();
  state.failWorkspace = true;
  await page.reload();
  await expect(page.getByTestId("cost-resolution-11")).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: /workspace|connected purchase|history/i })).toBeVisible();
  state.failWorkspace = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByTestId("cost-resolution-11")).toContainText("Costs posted after approval");
  expect(failures).toEqual([]);
});

for (const path of ["/shipments", "/purchasing"] as const) {
  test(`${path} has no landed-cost task for ordinary applied estimates`, async ({ page }) => {
    const { state, failures } = await installCostScreens(page);
    const loaded = page.waitForResponse(response => new URL(response.url()).pathname === "/api/procurement/landed-cost-health");
    const health = await openHealth(page, path);
    expect(await (await loaded).json()).toEqual(postedHealth());
    await expect(page.getByText("Loading landed cost health…", { exact: true })).toHaveCount(0);
    if (path === "/shipments") {
      await expect(health).toContainText("healthy");
      await expect(health).toContainText("0 critical");
      await expect(health.getByRole("button", { name: "Review", exact: true })).toHaveCount(0);
    } else {
      await expect(health).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: /^Push Costs/ })).toHaveCount(0);
    await page.goto("/purchase-orders/17?tab=lines");
    await expect(page.getByText(postedSummary, { exact: true })).toBeVisible();
    await expect(page.getByText(/Supplier confirmation:.*Their costs are already posted/)).toBeVisible();
    expect(state.healthReads).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
}

test("unknown cost-result statuses fail closed on PO and shipment instead of implying completion", async ({ page }) => {
  const { failures } = await installCostScreens(page);
  const unknownCosts = ordinaryPostedCosts();
  await page.route("**/api/purchase-orders/17/shipment-costs", route => route.fulfill({ json: {
    ...unknownCosts, summary: { ...unknownCosts.summary, inventoryCosting: "future_unknown_state" },
  } }));
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(page.getByText("Shipment costs could not be loaded.", { exact: true })).toBeVisible();
  await expect(page.getByText(postedSummary, { exact: true })).toHaveCount(0);
  const unknownReview = ordinaryPostedReview();
  await page.route("**/api/inbound-shipments/42/cost-review", route => route.fulfill({ json: {
    ...unknownReview, lines: [{ ...unknownReview.lines[0], application: { ...unknownReview.lines[0].application, status: "future_unknown_state" } }],
  } }));
  await page.goto("/shipments/42?tab=allocation");
  const results = page.getByRole("region", { name: "Inventory cost results", exact: true });
  await expect(results.getByRole("alert")).toContainText("Saved cost results could not be loaded.");
  await expect(results).not.toContainText(postedShipment);
  expect(failures).toEqual([]);
});

test("purchase history rejects a posted claim paired with an unsupported current issue and retries", async ({ page }) => {
  const { state, failures } = await installCostScreens(page);
  state.workspace = reconciledHistoryWorkspace();
  state.workspace.costTrace!.applicationHistory!.revisions[0].applications[0].issues = [{
    code: "COST_UNSUPPORTED_NEW_REVIEW", message: "New evidence requires a different review before completion.",
  }];
  await page.goto("/purchase-orders/17?tab=lifecycle");
  await expect(page.getByRole("alert").filter({ hasText: "The purchase workspace response could not be verified." })).toBeVisible();
  await expect(page.getByTestId("cost-resolution-11")).toHaveCount(0);
  await expect(page.getByText("Costs posted after approval", { exact: true })).toHaveCount(0);
  state.workspace = reconciledHistoryWorkspace();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByTestId("cost-resolution-11")).toContainText("Costs posted after approval");
  expect(failures).toEqual([]);
});

test("purchasing health monitor carries the same landed-cost state into the shipments overview", async ({ page }) => {
  const { state, failures } = await installCostScreens(page);
  const generatedAt = new Date("2026-10-16T12:00:00Z");
  let landedHealth: Parameters<typeof buildProcurementHealthSummary>[0]["landedCostHealth"] = postedWithOtherProvisionalCosts();
  state.health = landedHealth;
  // Use the production aggregate owner: the browser fixture does not duplicate
  // its severity or total formula while verifying the secondary dashboard panel.
  await page.route("**/api/procurement/health?*", route => route.fulfill({ json: buildProcurementHealthSummary({
    staleAutoDraftPos: buildStaleAutoDraftPoDiagnostics([], { now: generatedAt }), landedCostHealth: landedHealth, generatedAt,
  }) }));
  await openHealth(page, "/purchasing");
  const source = page.getByRole("button", { name: /Landed cost health/ });
  await expect(page.getByRole("heading", { name: "Procurement Health Monitor", exact: true })).toBeVisible();
  await expect(source).toContainText("0 critical / 1 warning");
  await source.click();
  await expect(page).toHaveURL(/\/shipments$/);
  await expect(page.getByRole("region", { name: "Landed Cost Health", exact: true })).toContainText(postedOtherCostWarning);
  await expect(page.getByRole("button", { name: /^Push Costs/ })).toHaveCount(0);
  landedHealth = unresolvedHealth();
  state.health = landedHealth;
  await openHealth(page, "/purchasing");
  await expect(source).toContainText("1 critical / 0 warning");
  await source.click();
  await expect(page.getByRole("region", { name: "Landed Cost Health", exact: true })).toContainText(currentCostIssue.message);
  expect(failures).toEqual([]);
});
