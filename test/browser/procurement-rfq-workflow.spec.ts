import { reviewRfqQuantity } from "../../shared/procurement/rfq-quantity-review";
import { expect, test, type Page, type Locator } from "@playwright/test";
import { resolve } from "node:path";
import type { RfqQuoteEvidence, RfqWorkflowDetail } from "../../shared/procurement/rfq-workflow";
import { normalizePoLinePricing } from "../../shared/utils/po-line-pricing";
import { rfqCommandReceiptSchema } from "../../shared/procurement/rfq-command";
import { rfqWorkListResponseSchema, type RfqWorkListItem } from "../../shared/procurement/rfq-work-list";
import { installFixtures } from "./procurement-fixtures";

const initialVersion = "a".repeat(64);
const nextVersion = "b".repeat(64);

function workListItem(workflow: RfqWorkflowDetail): RfqWorkListItem {
  return {
    id: workflow.id, rfqNumber: workflow.rfqNumber, status: workflow.status as RfqWorkListItem["status"], vendorId: workflow.vendorId,
    vendorName: "Fictional supplier", requestNote: null, currency: workflow.currency, responseDueDate: null, createdBy: "rfq-reviewer",
    createdAt: "2026-09-07T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z", sentAt: null, respondedAt: null, cancelledAt: null,
    lineCount: workflow.lines.length, requestedPiecesTotal: workflow.lines.reduce((sum, line) => sum + line.requestedPieces, 0),
    lines: workflow.lines.map(line => ({ id: line.id, rfqId: workflow.id, recommendationLineId: line.id, recommendationRunId: 1,
      vendorProductId: line.vendorProductId, vendorSku: null, sku: line.sku, productName: line.productName, status: line.status,
      requestedPieces: line.requestedPieces, recommendedPieces: line.requestedPieces, purchaseUom: null, piecesPerPurchaseUom: null,
      quantityOverrideReason: null, allocationOverrideReason: null, allocationOverrideApprovedBy: null, allocationOverrideApprovedAt: null,
      allocationOverrideBaselinePieces: null, allocationOverrideExcessPieces: null, quotedPieces: line.latestQuote?.quotedPieces ?? null,
      quotedUnitCostMills: line.latestQuote?.quotedUnitCostMills ?? null, quoteReference: line.latestQuote?.quote.quoteReference ?? null,
      quoteValidUntil: line.latestQuote?.quote.quoteValidUntil ?? null, quotedAt: line.latestQuote?.quote.quotedAt ?? null })),
    handoff: { state: "not_started", linkedLineCount: 0, remainingLineCount: workflow.lines.length, issues: [], purchaseOrders: [] },
  };
}

async function setup(page: Page, options: { canEdit?: boolean; currency?: string; lostResponse?: boolean; list?: boolean } = {}) {
  const failures = await installFixtures(page);
  const rules = { vendorProductId: 300, minimumOrderPieces: 1, piecesPerPurchaseUom: null, packSize: 1 };
  const workflow: RfqWorkflowDetail = {
    id: 10, rfqNumber: "TEST-RFQ-10", vendorId: 5, currency: options.currency ?? "USD", status: "draft", version: initialVersion,
    lines: [{ id: 20, status: "draft", productId: 100, productVariantId: 200, warehouseId: 1, vendorProductId: 300, sku: "RFQ-CASE", productName: "Fictional RFQ product", requestedPieces: 150, quantityReview: reviewRfqQuantity({ recommendationRules: rules, currentRules: rules, quotedPieces: 150 }), latestQuote: null, purchaseOrder: null }],
  };
  const commands: Array<{ path: string; key: string; body: Record<string, unknown> }> = [];
  const secondWorkflow = structuredClone(workflow);
  secondWorkflow.id = 11; secondWorkflow.rfqNumber = "TEST-RFQ-11"; secondWorkflow.lines[0].id = 21;
  secondWorkflow.lines[0].sku = "RFQ-OTHER";
  const replays = new Map<string, unknown>();
  let lost = false;
  const controls = { actorId: "rfq-reviewer", canEdit: options.canEdit !== false, postStatus: 0, loseNext: false, malformedNext: false, listStatus: 0, hideSecond: false };
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: controls.actorId, username: "test", role: "admin" }, permissions: controls.canEdit ? ["purchasing:view", "purchasing:edit"] : ["purchasing:view"], roles: ["admin"] } }));
  await page.route("**/api/purchasing/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      // An empty recent list proves exact links are independent of pagination.
      if (path === "/api/purchasing/rfqs") {
        if (controls.listStatus) return route.fulfill({ status: controls.listStatus, json: { error: "Fixture list unavailable" } });
        const rfqs = options.list ? [workListItem(workflow), ...(controls.hideSecond ? [] : [workListItem(secondWorkflow)])] : [];
        const statusCounts: Record<string, number> = {};
        for (const rfq of rfqs) statusCounts[rfq.status] = (statusCounts[rfq.status] ?? 0) + 1;
        return route.fulfill({ json: rfqWorkListResponseSchema.parse({ rfqs, count: rfqs.length, statusCounts, limit: 25, page: { total: rfqs.length, limit: 25, offset: 0, nextOffset: null } }) });
      }
      if (path === "/api/purchasing/rfq-queue") return route.fulfill({ json: { run: null, items: [], summary: { open: 0, partiallyAllocated: 0, fullyAllocated: 0, supplierAssignmentRequired: 0, activeRfqs: 0 } } });
      if (path === "/api/purchasing/rfqs/10") return route.fulfill({ json: workflow });
      if (path === "/api/purchasing/rfqs/11") return route.fulfill({ json: secondWorkflow });
      if (path === "/api/purchasing/rfqs/10/lines/20/quotes") return route.fulfill({ json: { revisions: workflow.lines[0].latestQuote ? [workflow.lines[0].latestQuote] : [], nextBeforeRevision: null } });
      return route.fallback();
    }
    if (!["/api/purchasing/rfqs/10/lines/20/quotes", "/api/purchasing/rfqs/10/convert", "/api/purchasing/rfqs/10/release"].includes(path)) return route.fallback();
    const key = request.headers()["idempotency-key"];
    const body = request.postDataJSON() as Record<string, unknown>;
    commands.push({ path, key, body });
    if (!key) return route.fulfill({ status: 400, json: { code: "MISSING_KEY", error: "Missing command identity" } });
    expect(request.headers()["x-rfq-receipt-version"]).toBe("1");
    if (controls.postStatus) return route.fulfill({ status: controls.postStatus, json: { code: "RFQ_AUTH_REQUIRED", error: "Current purchasing permission is required." } });
    if (replays.has(key)) return route.fulfill({ json: replays.get(key) });
    const operation = path.endsWith("/quotes") ? "capture_quote" : path.endsWith("/release") ? "release" : "convert";
    const intent = { operation, rfqId: 10, ...(operation === "capture_quote" ? { lineId: 20 } : {}), payload: body };
    if (body.expectedVersion !== workflow.version) return route.fulfill({ status: 409, json: { code: "RFQ_VERSION_CONFLICT", error: "This request changed; refresh before release", details: { rfqCommandOutcome: "rejected", actorId: controls.actorId, idempotencyKey: key, intent } } });
    let response: unknown;
    if (path.endsWith("/release")) {
      workflow.status = "cancelled"; workflow.version = "e".repeat(64);
      for (const line of workflow.lines) if (!line.purchaseOrder && line.status !== "ordered") line.status = "cancelled";
      response = structuredClone(workflow);
    } else if (path.endsWith("/quotes")) {
      const quote = body.quote as RfqQuoteEvidence;
      const exact = normalizePoLinePricing(quote.pricing);
      workflow.status = "quoted";
      workflow.version = nextVersion;
      workflow.lines[0].status = "quoted";
      workflow.lines[0].latestQuote = { id: 7, rfqLineId: 20, revision: 1, fingerprint: "c".repeat(64), currency: workflow.currency, quotedPieces: exact.orderQty, quotedUnitCostMills: exact.unitCostMills, productTotalMills: exact.quotedExtendedMills, pricingRemainderMills: exact.pricingRemainderMills, quote, createdBy: "rfq-reviewer", createdAt: "2026-09-07T12:00:00Z" };
      response = structuredClone(workflow);
    } else {
      workflow.version = "d".repeat(64);
      workflow.lines[0].status = "ordered";
      workflow.lines[0].purchaseOrder = { purchaseOrderId: 99, purchaseOrderLineId: 900, quoteRevisionId: 7, poNumber: "TEST-PO-99", status: "draft" };
      response = { rfqId: 10, purchaseOrderId: 99, poNumber: "TEST-PO-99", status: "draft", lines: [{ rfqLineId: 20, quoteRevisionId: 7, purchaseOrderLineId: 900 }] };
    }
    const receipt = rfqCommandReceiptSchema.parse({ version: 1, actorId: controls.actorId, idempotencyKey: key, intent, result: response });
    replays.set(key, receipt);
    if (controls.loseNext || (options.lostResponse && !lost)) { lost = true; controls.loseNext = false; return route.abort("connectionreset"); }
    if (controls.malformedNext) { controls.malformedNext = false; return route.fulfill({ json: { ...receipt, actorId: "wrong-actor" } }); }
    return route.fulfill({ json: receipt });
  });
  await page.goto(options.list ? "/procurement/rfqs" : "/procurement/rfqs?rfqId=10");
  if (options.list) await expect(page.getByText("TEST-RFQ-10", { exact: true })).toBeVisible();
  else await expect(page.getByRole("heading", { name: /TEST-RFQ-10/ })).toBeVisible();
  return { commands, workflow, failures, controls };
}

async function capture(page: Page | Locator, options: { packaging?: boolean; recover?: boolean; waitForResult?: boolean } = {}) {
  // Radix choices are portalled outside a scoped RFQ panel.
  const portal = "page" in page ? page.page() : page;
  await page.getByRole("button", { name: "Capture quote", exact: true }).click();
  await page.getByLabel("Quoted price basis").click();
  await portal.getByRole("option", { name: "Extended product total" }).click();
  await page.getByLabel(/^Product total/).fill("100.00");
  await page.getByLabel("Supplier quote reference").fill("VENDOR-QUOTE-1");
  await page.getByLabel("Quote date", { exact: true }).fill("2026-09-07");
  await page.getByLabel("Quote note / reason for revision").fill("Final supplier quote received");
  if (options.packaging !== false) {
    await page.getByLabel("Packaging treatment").click();
    await portal.getByRole("option", { name: "Separate amount confirmed" }).click();
    await page.getByLabel(/^Total packaging/).fill("18.00");
  }
  await page.getByRole("button", { name: "Save quote revision" }).click();
  if (options.recover) await page.getByRole("button", { name: "Recover saved RFQ request", exact: true }).click();
  if (options.waitForResult === false) return;
  await expect(page.getByRole("button", { name: "Revise quote" })).toBeVisible();
}

test("captures exact economics, retries a lost response and opens the linked purchase", async ({ page }, testInfo) => {
  const { commands, failures } = await setup(page, { lostResponse: true });
  await capture(page, { recover: true });
  expect(commands).toHaveLength(2);
  expect(commands[0].key).toBe(commands[1].key);
  expect(commands[0].body).toEqual(commands[1].body);
  expect(commands[0].body).toMatchObject({ expectedVersion: initialVersion, quote: { pricing: { basis: "extended_total", quotedTotalCents: 10000, quantityPieces: 150 }, packagingCostCents: 1800 } });
  await expect(page.getByText(/Quoted product total: 100.0000 USD/)).toBeVisible();
  await page.getByRole("button", { name: "Quote history", exact: true }).click();
  await expect(page.getByText("Preserved quote revisions")).toBeVisible();
  await page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" }).check();
  await page.getByRole("button", { name: "Create draft PO (1 selected)" }).click();
  await expect(page.getByText("Draft created:")).toBeVisible();
  expect(commands.at(-1)?.body).toEqual({ expectedVersion: nextVersion, lines: [{ rfqLineId: 20, quoteRevisionId: 7 }], quantityOverrideReason: null });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("rfq-quote-purchase-link.png"), fullPage: true });
  await page.getByRole("link", { name: "TEST-PO-99", exact: true }).first().click();
  await expect(page).toHaveURL(/\/purchase-orders\/99(?:\?|$)/);
  expect(failures).toEqual([]);
});

test("requires a fresh review of changed MOQ and pack while preserving vendor quantity", async ({ page }) => {
  const { commands, workflow, failures } = await setup(page);
  await capture(page);
  await page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" }).check();
  const priorRules = workflow.lines[0].quantityReview.currentRules!;
  workflow.lines[0].quantityReview = reviewRfqQuantity({ recommendationRules: priorRules, currentRules: { ...priorRules, minimumOrderPieces: 200, packSize: 100 }, quotedPieces: 150 });
  workflow.version = "e".repeat(64);
  await page.getByRole("button", { name: "Refresh quotes", exact: true }).click();
  await expect(page.getByText("Current supplier rules: MOQ 200 · Order multiple 100 pieces.")).toBeVisible();
  await expect(page.getByText("At recommendation: MOQ 1 · Order multiple 1 pieces.")).toBeVisible();
  await expect(page.getByText(/150 pieces are below the current MOQ of 200/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create draft PO (1 selected)" })).toBeDisabled();
  await page.getByRole("button", { name: "Clear selection and review current quotes" }).click();
  await page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" }).check();
  await expect(page.getByRole("button", { name: "Create draft PO (1 selected)" })).toBeDisabled();
  const reason = "Supplier explicitly confirmed a 150-piece exception";
  await page.getByLabel("Reason for accepting the quoted quantity").fill(reason);
  await page.getByRole("button", { name: "Create draft PO (1 selected)" }).click();
  await expect(page.getByText("Draft created:")).toBeVisible();
  expect(commands.at(-1)?.body).toEqual({ expectedVersion: "e".repeat(64), lines: [{ rfqLineId: 20, quoteRevisionId: 7 }], quantityOverrideReason: reason });
  expect(workflow.lines[0].latestQuote!.quotedPieces).toBe(150);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});

test("keeps unknown packaging visible and blocks purchase selection", async ({ page }) => {
  const { commands, failures } = await setup(page);
  await capture(page, { packaging: false });
  await expect(page.getByText("Packaging review required")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" })).toBeDisabled();
  expect(commands).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("preserves foreign quote currency without displaying a dollar denomination", async ({ page }) => {
  const { failures } = await setup(page, { currency: "EUR" });
  await capture(page);
  await expect(page.getByText(/Quoted product total: 100.0000 EUR/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Quote capture and purchase-order handoff" })).not.toContainText("$");
  await expect(page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" })).toBeDisabled();
  expect(failures).toEqual([]);
});

test("view-only users can follow an exact RFQ without quote or purchase mutation controls", async ({ page }) => {
  const { commands, failures } = await setup(page, { canEdit: false });
  await expect(page.getByRole("button", { name: "Release unconverted request", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Capture quote", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Create draft PO/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Quote history", exact: true }).click();
  await expect(page.getByText("No versioned quote has been captured.", { exact: false })).toBeVisible();
  expect(commands).toEqual([]);
  expect(failures).toEqual([]);
});

test("requires renewed selection after the quote evidence changes", async ({ page }) => {
  const { workflow, commands, failures } = await setup(page);
  await capture(page);
  await page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" }).check();
  workflow.version = "e".repeat(64);
  await page.getByRole("button", { name: "Refresh quotes", exact: true }).click();
  await expect(page.getByText("The quote request changed after selection.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create draft PO (1 selected)" })).toBeDisabled();
  await page.getByRole("button", { name: "Clear selection and review current quotes" }).click();
  await expect(page.getByRole("button", { name: "Create draft PO (0 selected)" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" }).check();
  await expect(page.getByRole("button", { name: "Create draft PO (1 selected)" })).toBeEnabled();
  expect(commands).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("releases an abandoned request with a reason and same-key retry after response loss", async ({ page }, testInfo) => {
  const { commands, workflow, failures } = await setup(page, { lostResponse: true });
  const release = page.getByRole("button", { name: "Release unconverted request", exact: true });
  await expect(release).toBeDisabled();
  await page.getByLabel("Reason for releasing the request").fill("Supplier cannot fulfill this request");
  await release.click();
  await page.getByRole("button", { name: "Recover saved RFQ request", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Unconverted request reservations released" })).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual(commands[1]);
  expect(commands[0].body).toEqual({ expectedVersion: initialVersion, reason: "Supplier cannot fulfill this request" });
  expect(workflow.status).toBe("cancelled");
  await expect(release).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Capture quote", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Quote history", exact: true })).toBeVisible();
  await expect(release).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("rfq-reservation-released.png"), fullPage: true });
  expect(failures).toEqual([]);
});

test("preserves linked purchases when releasing remaining unconverted lines", async ({ page }) => {
  const { workflow, failures } = await setup(page);
  workflow.lines.push({ ...structuredClone(workflow.lines[0]), id: 21, sku: "RFQ-ORDERED", status: "ordered",
    purchaseOrder: { purchaseOrderId: 99, purchaseOrderLineId: 900, quoteRevisionId: 7, poNumber: "TEST-PO-99", status: "draft" } });
  workflow.version = nextVersion;
  await page.getByRole("button", { name: "Refresh quotes", exact: true }).click();
  await expect(page.getByRole("link", { name: "TEST-PO-99", exact: true })).toBeVisible();
  await page.getByLabel("Reason for releasing the request").fill("Remaining product no longer needed");
  await page.getByRole("button", { name: "Release unconverted request", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Unconverted request reservations released" })).toBeVisible();
  expect(workflow.lines.map((line) => line.status)).toEqual(["cancelled", "ordered"]);
  await page.getByRole("link", { name: "TEST-PO-99", exact: true }).click();
  await expect(page).toHaveURL(/\/purchase-orders\/99(?:\?|$)/);
  expect(failures).toEqual([]);
});

test("requires a fresh release review after the request changes", async ({ page }) => {
  const { workflow, commands, failures } = await setup(page);
  await page.getByLabel("Reason for releasing the request").fill("Original review reason");
  workflow.version = nextVersion;
  await page.getByRole("button", { name: "Release unconverted request", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This request changed" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh request before release", exact: true }).click();
  await expect(page.getByLabel("Reason for releasing the request")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Release unconverted request", exact: true })).toBeDisabled();
  await page.getByLabel("Reason for releasing the request").fill("Reviewed the new request state");
  await page.getByRole("button", { name: "Release unconverted request", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Unconverted request reservations released" })).toBeVisible();
  expect(commands).toHaveLength(2); expect(commands[1].key).not.toBe(commands[0].key);
  expect(commands[1].body.expectedVersion).toBe(nextVersion);
  expect(failures).toEqual([]);
});

test("shows partial sourcing reservations on the run with exact purchase and RFQ recovery links", async ({ page }) => {
  const failures = await installFixtures(page);
  await page.route("**/api/purchasing/auto-draft/runs?*", (route) => route.fulfill({ json: { limit: 20, runs: [{
    id: 501, runAt: "2026-09-07T12:00:00Z", finishedAt: "2026-09-07T12:01:00Z", status: "success", triggeredBy: "scheduler", mode: "draft_po", approvalPolicy: "all_eligible",
    itemsAnalyzed: 1, posCreated: 0, posUpdated: 0, linesAdded: 0, skippedNoVendor: 0, skippedOnOrder: 0, skippedExcluded: 0,
    actionableCount: 1, autoDraftEligibleCount: 1, autoDraftReviewRequiredCount: 0, approvalPolicyEligibleCount: 1, approvalPolicyBlockedCount: 0, draftMutationEligibleCount: 1,
    approvalPolicyDiagnostics: null, forecastDiagnostics: null, poMutationCount: 0, recommendationSamples: { actionable: [], approvalPolicyBlocked: [], skipped: [] },
    recommendationSampleCounts: { actionable: 0, approvalPolicyBlocked: 0, skipped: 0 }, recommendedActions: [],
    pendingSourcingReviews: [{ recommendationId: "100:200:30", reason: "pending_sourcing_reservation", reservedPieces: 100, suggestedPieces: 150, uncoveredPieces: 50,
      message: "Review the existing draft purchase or quote request before adding demand.", reservations: [{ productId: 100, pieces: 70, purchaseOrderId: 99, rfqId: null }, { productId: 100, pieces: 30, purchaseOrderId: null, rfqId: 10 }] }],
  }] } }));
  await page.route("**/api/purchasing/recommendation-decisions?*", (route) => route.fulfill({ json: {
    generatedAt: "2026-09-07T12:01:00Z", limit: 12, decisions: [], summary: { total: 0, active: 0, acceptedForPo: 0, poHandoffCreated: 0, deferred: 0, dismissed: 0, reviewed: 0, latestDecidedAt: null, decisionCounts: {}, kindCounts: {}, statusCounts: {} },
  } }));
  await page.goto("/procurement/runs");
  await expect(page.getByText("Existing sourcing needs review", { exact: true })).toBeVisible();
  await expect(page.getByText(/100 pieces already reserved; 50 pieces/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Review PO #99", exact: true })).toHaveAttribute("href", "/purchase-orders/99");
  await expect(page.getByRole("link", { name: "Review RFQ #10", exact: true })).toHaveAttribute("href", "/procurement/rfqs?rfqId=10");
  expect(failures).toEqual([]);
});


test("holds request release when legacy ordered history lacks a verified purchase", async ({ page }) => {
  const { workflow, failures } = await setup(page);
  workflow.lines.push({ ...structuredClone(workflow.lines[0]), id: 21, sku: "RFQ-LEGACY", status: "ordered" });
  workflow.version = nextVersion;
  await page.getByRole("button", { name: "Refresh quotes", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "no verified purchase-order link" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Release unconverted request", exact: true })).toHaveCount(0);
  expect(failures).toEqual([]);
});

for (const authStatus of [401, 403]) {
  test(`preserves a lost quote through reload and ${authStatus} until the original receipt is recovered`, async ({ page }) => {
    const { commands, controls, failures } = await setup(page, { lostResponse: true });
    await capture(page, { waitForResult: false });
    const recovery = page.getByRole("region", { name: "RFQ request recovery", exact: true });
    await expect(recovery).toBeVisible();
    const original = structuredClone(commands[0]);
    await page.reload();
    await expect(recovery).toBeVisible();
    controls.postStatus = authStatus;
    await recovery.getByRole("button", { name: "Recover saved RFQ request", exact: true }).click();
    await expect.poll(() => commands.length).toBe(2);
    await expect(recovery).toBeVisible();
    await page.reload();
    await expect(recovery).toBeVisible();
    controls.postStatus = 0;
    await recovery.getByRole("button", { name: "Recover saved RFQ request", exact: true }).click();
    await expect(recovery.getByRole("button", { name: "Recover saved RFQ request", exact: true })).toHaveCount(0);
    expect(commands).toEqual([original, original, original]);
    await expect(page.getByRole("button", { name: "Revise quote" })).toBeVisible();
    expect(failures).toEqual([]);
  });
}

for (const operation of ["convert", "release"] as const) {
  test(`recovers a committed ${operation} after reload without creating a new request`, async ({ page }) => {
    const { commands, controls, failures } = await setup(page);
    if (operation === "convert") {
      await capture(page);
      await page.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" }).check();
    } else await page.getByLabel("Reason for releasing the request").fill("Supplier cannot fulfill the remaining request");
    controls.loseNext = true;
    await page.getByRole("button", { name: operation === "convert" ? "Create draft PO (1 selected)" : "Release unconverted request", exact: true }).click();
    const recovery = page.getByRole("region", { name: "RFQ request recovery", exact: true });
    await expect(recovery).toBeVisible();
    const original = structuredClone(commands.at(-1));
    await page.reload();
    await expect(recovery).toBeVisible();
    await recovery.getByRole("button", { name: "Recover saved RFQ request", exact: true }).click();
    await expect(recovery.getByRole("button", { name: "Recover saved RFQ request", exact: true })).toHaveCount(0);
    expect(commands.at(-1)).toEqual(original);
    expect(commands.filter(command => command.path.endsWith(`/${operation}`))).toHaveLength(2);
    if (operation === "convert") await expect(page.getByRole("link", { name: "TEST-PO-99", exact: true }).first()).toBeVisible();
    else await expect(page.getByRole("button", { name: "Release unconverted request", exact: true })).toHaveCount(0);
    expect(failures).toEqual([]);
  });
}

test("retains the original actor's request while permissions or the signed-in operator change", async ({ page }) => {
  const { commands, controls, failures } = await setup(page, { lostResponse: true });
  await capture(page, { waitForResult: false });
  await expect(page.getByRole("region", { name: "RFQ request recovery", exact: true })).toBeVisible();
  const original = structuredClone(commands[0]);
  controls.canEdit = false;
  await page.reload();
  await expect(page.getByRole("button", { name: "Recover saved RFQ request", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Revise quote" })).toHaveCount(0);
  controls.actorId = "second-operator";
  controls.canEdit = true;
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: /another operator|original operator/ }).first()).toBeVisible();
  expect(commands).toEqual([original]);
  controls.actorId = "rfq-reviewer";
  await page.reload();
  await page.getByRole("button", { name: "Recover saved RFQ request", exact: true }).click();
  await expect(page.getByRole("button", { name: "Recover saved RFQ request", exact: true })).toHaveCount(0);
  expect(commands).toEqual([original, original]);
  expect(failures).toEqual([]);
});

test("recovers the original request when another RFQ is open", async ({ page }) => {
  const { commands, workflow, failures } = await setup(page, { lostResponse: true });
  await capture(page, { waitForResult: false });
  await expect(page.getByRole("region", { name: "RFQ request recovery", exact: true })).toBeVisible();
  const second = { ...structuredClone(workflow), id: 11, rfqNumber: "TEST-RFQ-11" };
  await page.route("**/api/purchasing/rfqs/11", route => route.fulfill({ json: second }));
  await page.goto("/procurement/rfqs?rfqId=11");
  await expect(page.getByRole("heading", { name: /TEST-RFQ-11/ })).toBeVisible();
  const recovery = page.getByRole("region", { name: "RFQ request recovery", exact: true });
  await expect(recovery.getByRole("link")).toHaveAttribute("href", "/procurement/rfqs?rfqId=10");
  await recovery.getByRole("button", { name: "Recover saved RFQ request", exact: true }).click();
  await expect(recovery.getByRole("button", { name: "Recover saved RFQ request", exact: true })).toHaveCount(0);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual(commands[1]);
  await expect(page.getByRole("heading", { name: /TEST-RFQ-11/ })).toBeVisible();
  expect(failures).toEqual([]);
});

test("retains a malformed success until a matching receipt is recovered", async ({ page }) => {
  const { commands, controls, failures } = await setup(page);
  controls.malformedNext = true;
  await capture(page, { waitForResult: false });
  await expect(page.getByRole("region", { name: "RFQ request recovery", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Recover saved RFQ request", exact: true }).click();
  await expect(page.getByRole("button", { name: "Recover saved RFQ request", exact: true })).toHaveCount(0);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual(commands[1]);
  expect(failures).toEqual([]);
});

test("does not dispatch a quote when its recovery cannot be saved", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "echelon:rfq-workflow:v1") throw new DOMException("Fixture storage unavailable", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  const { commands, failures } = await setup(page);
  await capture(page, { waitForResult: false });
  await expect(page.getByRole("alert").filter({ hasText: /not sent|could not be saved/ }).first()).toBeVisible();
  expect(commands).toEqual([]);
  expect(failures).toEqual([]);
});

test("keeps recovery available when the RFQ detail read is unavailable", async ({ page }) => {
  const { commands, failures } = await setup(page, { lostResponse: true });
  await capture(page, { waitForResult: false });
  await expect(page.getByRole("button", { name: "Recover saved RFQ request", exact: true })).toBeVisible();
  await page.route("**/api/purchasing/rfqs/10", route => route.fulfill({ status: 503, json: { error: "Fixture read unavailable" } }));
  await page.reload();
  await expect(page.getByRole("button", { name: "Recover saved RFQ request", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Recover saved RFQ request", exact: true }).click();
  await expect(page.getByRole("button", { name: "Recover saved RFQ request", exact: true })).toHaveCount(0);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual(commands[1]);
  expect(failures).toEqual([]);
});

async function openRecoveryHarness(page: Page) {
  await page.route("**/__rfq-recovery", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/@fs/${resolve("test/browser/fixtures/rfq-recovery-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__rfq-recovery");
  await expect(page.getByRole("region", { name: "First RFQ panel", exact: true }).getByRole("button", { name: "Capture quote", exact: true })).toBeVisible();
}

test("revoking permission closes the mutation gate of an already open quote editor", async ({ page }) => {
  const { commands, controls, failures } = await setup(page);
  await openRecoveryHarness(page);
  const panel = page.getByRole("region", { name: "First RFQ panel", exact: true });
  await panel.getByRole("button", { name: "Capture quote", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Save quote revision", exact: true })).toBeEnabled();
  controls.canEdit = false;
  await page.getByRole("button", { name: "Refresh fixture permissions", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Save quote revision", exact: true })).toBeDisabled();
  await expect(panel.getByLabel("Supplier quote reference")).toBeDisabled();
  expect(commands).toEqual([]);
  expect(failures).toEqual([]);
});

test("two mounted RFQ panels share recovery and both observe its verified completion", async ({ page }) => {
  const { commands, failures } = await setup(page, { lostResponse: true });
  await openRecoveryHarness(page);
  const first = page.getByRole("region", { name: "First RFQ panel", exact: true });
  const second = page.getByRole("region", { name: "Second RFQ panel", exact: true });
  await capture(first, { waitForResult: false });
  await expect(page.getByRole("button", { name: "Recover saved RFQ request", exact: true })).toBeVisible();
  await expect(second.getByRole("button", { name: "Revise quote", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Recover saved RFQ request", exact: true }).click();
  await expect(first.getByRole("button", { name: "Save quote revision", exact: true })).toHaveCount(0);
  await expect(second.getByRole("button", { name: "Revise quote", exact: true })).toBeEnabled();
  await first.getByRole("checkbox", { name: "Select RFQ-CASE for draft purchase order" }).check();
  await expect(first.getByRole("button", { name: "Create draft PO (1 selected)", exact: true })).toBeEnabled();
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual(commands[1]);
  expect(failures).toEqual([]);
});

test("completion in another panel preserves an unsubmitted quote draft for renewed review", async ({ page }) => {
  const { commands, failures } = await setup(page);
  await openRecoveryHarness(page);
  const first = page.getByRole("region", { name: "First RFQ panel", exact: true });
  const second = page.getByRole("region", { name: "Second RFQ panel", exact: true });
  await second.getByRole("button", { name: "Capture quote", exact: true }).click();
  await second.getByLabel("Supplier quote reference").fill("UNSUBMITTED-SECOND-DRAFT");
  await capture(first);
  await expect(first.getByRole("button", { name: "Save quote revision", exact: true })).toHaveCount(0);
  await expect(second.getByLabel("Supplier quote reference")).toHaveValue("UNSUBMITTED-SECOND-DRAFT");
  await expect(second.getByRole("button", { name: "Save quote revision", exact: true })).toBeDisabled();
  await expect(second.getByText(/Your unsaved values are retained/)).toBeVisible();
  expect(commands).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("tracking list refresh failures and disappearing rows preserve other opened RFQ drafts", async ({ page }) => {
  const { controls, commands, failures } = await setup(page, { list: true });
  await page.getByRole("button", { name: "Expand TEST-RFQ-10", exact: true }).click();
  await page.getByRole("button", { name: "Expand TEST-RFQ-11", exact: true }).click();
  const first = page.getByRole("region", { name: "Opened RFQ TEST-RFQ-10", exact: true });
  const second = page.getByRole("region", { name: "Opened RFQ TEST-RFQ-11", exact: true });
  await second.getByRole("button", { name: "Capture quote", exact: true }).click();
  await second.getByLabel("Supplier quote reference").fill("UNSENT-OTHER-RFQ");
  controls.listStatus = 503;
  await capture(first);
  await expect(page.getByRole("button", { name: "Reload quote requests", exact: true })).toBeVisible();
  await expect(second.getByLabel("Supplier quote reference")).toHaveValue("UNSENT-OTHER-RFQ");
  await expect(second.getByRole("button", { name: "Save quote revision", exact: true })).toBeDisabled();
  controls.listStatus = 0;
  controls.hideSecond = true;
  await page.getByRole("button", { name: "Reload quote requests", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "RFQs pages" })).toContainText("1–1 of 1 RFQs");
  await expect(second.getByLabel("Supplier quote reference")).toHaveValue("UNSENT-OTHER-RFQ");
  await expect(second.getByRole("button", { name: "Save quote revision", exact: true })).toBeEnabled();
  expect(commands).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("a failed detail refresh preserves unsent quote values and disables submission until recovery", async ({ page }) => {
  const { workflow, commands, failures } = await setup(page);
  await page.getByRole("button", { name: "Capture quote", exact: true }).click();
  await page.getByLabel("Supplier quote reference").fill("UNSENT-REFRESH-DRAFT");
  let broken = true;
  await page.route("**/api/purchasing/rfqs/10", route => route.fulfill(broken
    ? { status: 503, json: { error: "Fixture detail read unavailable" } } : { json: workflow }));
  await page.getByRole("button", { name: "Refresh quotes", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /refresh|load/i }).first()).toBeVisible();
  await expect(page.getByLabel("Supplier quote reference")).toHaveValue("UNSENT-REFRESH-DRAFT");
  await expect(page.getByRole("button", { name: "Save quote revision", exact: true })).toBeDisabled();
  broken = false;
  await page.getByRole("button", { name: "Refresh quotes", exact: true }).click();
  await expect(page.getByLabel("Supplier quote reference")).toHaveValue("UNSENT-REFRESH-DRAFT");
  await expect(page.getByRole("button", { name: "Save quote revision", exact: true })).toBeEnabled();
  expect(commands).toEqual([]);
  expect(failures).toEqual([]);
});
