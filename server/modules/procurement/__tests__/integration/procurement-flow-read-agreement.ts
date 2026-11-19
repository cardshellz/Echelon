import { expect } from "vitest";
import { invoiceWorkListQuerySchema, paymentWorkListQuerySchema } from "@shared/procurement/ap-work-list";
import { isShipmentCostLinePosted } from "@shared/procurement/shipment-cost-workflow";
import type { PoShipmentCosts } from "@shared/procurement/po-shipment-costs";
import type { PurchaseWorkspace } from "@shared/procurement/purchase-workspace";
import { FLOW_AT, type FlowCostHarness } from "./procurement-flow-cost.fixture";

export interface FlowReadAgreementExpectation {
  rfqId: number;
  purchases: ReadonlyArray<{
    id: number;
    lineId: number;
    receivedPieces: number;
    receiptIds: readonly number[];
  }>;
  shipmentLines: ReadonlyArray<{
    id: number;
    shipmentId: number;
    purchaseOrderId: number;
    purchaseOrderLineId: number;
    allocatedCents: number;
  }>;
  // The charge owner may confirm a finalized actual amount before an invoice
  // exists. This is cost-source evidence, not proof of supplier communication.
  freightEvidence: "estimated" | "confirmed";
  expectedInvoiceCount: number;
  expectedInvoiceTotalCents: number;
}

function sortedIds(ids: readonly number[]): number[] {
  return [...ids].sort((left, right) => left - right);
}

function required<T>(value: T | null | undefined, description: string): T {
  expect(value, description).not.toBeNull();
  expect(value, description).not.toBeUndefined();
  if (value == null) throw new Error(description);
  return value;
}

type PurchaseExpectation = FlowReadAgreementExpectation["purchases"][number];

function assertPurchaseReadAgreement(
  workspace: PurchaseWorkspace,
  costs: PoShipmentCosts,
  purchase: PurchaseExpectation,
  expected: FlowReadAgreementExpectation,
): void {
  const lines = expected.shipmentLines.filter(line => line.purchaseOrderId === purchase.id);
  const shipmentIds = [...new Set(lines.map(line => line.shipmentId))];
  const allocatedCents = lines.reduce((total, line) => total + line.allocatedCents, 0);
  expect(workspace.purchase.id).toBe(purchase.id);
  expect(workspace.purchase.lines).toEqual([expect.objectContaining({
    id: purchase.lineId, orderedQty: purchase.receivedPieces, receivedQty: purchase.receivedPieces,
    quantityBasis: "pieces",
  })]);
  expect(workspace.rfqOrigins).toEqual([expect.objectContaining({
    rfqId: expected.rfqId, purchaseOrderLineId: purchase.lineId, quotedPieces: purchase.receivedPieces,
  })]);
  expect(sortedIds(workspace.shipments.map(shipment => shipment.id))).toEqual(sortedIds(shipmentIds));
  // Shared shipments expose sibling receipts too. Only exact PO ownership is
  // evidence of this purchase's received quantity; never total all visible rows.
  const ownReceipts = workspace.receipts.filter(receipt => receipt.purchaseOrderId === purchase.id);
  expect(sortedIds(ownReceipts.map(receipt => receipt.id))).toEqual(sortedIds(purchase.receiptIds));
  expect(ownReceipts.every(receipt => receipt.status === "closed")).toBe(true);
  for (const shipmentId of shipmentIds) {
    expect(workspace.edges).toContainEqual({
      from: { kind: "purchase", id: purchase.id }, to: { kind: "shipment", id: shipmentId },
      relationship: "purchase_shipment",
    });
  }
  expect(costs.summary).toMatchObject({
    shipmentCount: shipmentIds.length, freightCents: allocatedCents, totalCents: allocatedCents,
    inventoryCosting: "applied", appliedLines: lines.length, pendingLines: 0, reviewLines: 0,
    estimatedCents: expected.freightEvidence === "estimated" ? allocatedCents : 0,
  });
  expect(sortedIds(costs.lines.map(line => line.lineId))).toEqual(sortedIds(lines.map(line => line.id)));
  const trace = required(workspace.costTrace, `Purchase ${purchase.id} cost trace`);
  expect(trace.applicationEvidence).toBe("recorded");
  expect(required(trace.currentCosts, `Purchase ${purchase.id} current supplier costs`))
    .toEqual(required(costs.supplierCosts, `Purchase ${purchase.id} shipment supplier costs`));
  expect(sortedIds(trace.receiptLines.map(line => line.receiptId))).toEqual(sortedIds(purchase.receiptIds));
  expect(trace.receiptLines.every(line => line.lineageEvidence === "original_receipt_proven")).toBe(true);
  expect(trace.receiptLines.reduce((total, line) => total
    + line.receivedUnits * required(line.frozenPiecesPerUnit, `Receipt line ${line.id} unit factor`), 0))
    .toBe(purchase.receivedPieces);
  const history = required(trace.applicationHistory, `Purchase ${purchase.id} application history`);
  for (const line of lines) {
    const current = required(costs.lines.find(row => row.lineId === line.id), `PO cost line ${line.id}`);
    expect(current).toMatchObject({
      shipmentId: line.shipmentId, purchaseOrderLineId: line.purchaseOrderLineId,
      status: "applied", allocatedCents: line.allocatedCents, issues: [],
    });
    const revisions = history.revisions.filter(revision => revision.shipmentLineId === line.id
      && revision.component === "landed" && revision.latestRecordedSourceRevision);
    expect(revisions, `Current landed revision for line ${line.id}`).toHaveLength(1);
    const revision = revisions[0];
    expect(revision.source).toMatchObject({ evidence: expected.freightEvidence, issue: null });
    const application = required(revision.applications.find(row => row.id === current.applicationId),
      `PO current application ${current.applicationId} is present in immutable history`);
    expect(application).toMatchObject({ status: "applied", latestRecordedApplication: true,
      evidenceState: "verified_record", issues: [] });
    const visibleShipment = required(workspace.shipments.find(row => row.id === line.shipmentId),
      `Workspace shipment ${line.shipmentId}`);
    expect(visibleShipment.lines.find(row => row.id === line.id)).toMatchObject({
      purchaseOrderId: purchase.id, purchaseOrderLineId: purchase.lineId, allocatedCostCents: line.allocatedCents,
    });
  }
}

/**
 * Read the actual operator-facing projections after the conserved-$4,610 FLOW
 * owners have settled. This is database read-model acceptance, not browser or
 * HTTP permission acceptance. The caller supplies facts from its created records.
 */
export async function assertFlowReadAgreement(
  harness: FlowCostHarness,
  expected: FlowReadAgreementExpectation,
): Promise<void> {
  // Several existing owners import server/db. Import them only after the FLOW
  // harness has fenced that module's pool to its exclusively owned local DB.
  const [{ createPurchaseWorkspaceRepository }, { createPurchaseWorkspaceService },
    { listRequestForQuotes }, { readInvoiceWorkList, readPaymentWorkList }] = await Promise.all([
    import("../../purchase-workspace.repository"), import("../../purchase-workspace.service"),
    import("../../purchasing-rfq.service"), import("../../ap-work-list.repository"),
  ]);
  const workspaceReader = createPurchaseWorkspaceService(createPurchaseWorkspaceRepository(harness.database));
  const workspaces = new Map<number, PurchaseWorkspace>();
  const poCosts = new Map<number, PoShipmentCosts>();
  for (const purchase of expected.purchases) {
    const workspace = await workspaceReader.getPurchaseWorkspace(purchase.id);
    const costs = required(await harness.purchasing.getPoShipmentCosts(purchase.id), `Purchase ${purchase.id} costs`);
    assertPurchaseReadAgreement(workspace, costs, purchase, expected);
    workspaces.set(purchase.id, workspace);
    poCosts.set(purchase.id, costs);
  }

  const rfqs = await listRequestForQuotes(harness.database, { limit: 100 });
  expect(rfqs.page.total).toBe(1);
  const rfq = required(rfqs.rfqs.find(row => row.id === expected.rfqId), "Original RFQ is discoverable");
  expect(rfq.handoff).toMatchObject({ state: "converted", linkedLineCount: expected.purchases.length,
    remainingLineCount: 0, issues: [] });
  expect(sortedIds(rfq.handoff.purchaseOrders.map(purchase => purchase.id)))
    .toEqual(sortedIds(expected.purchases.map(purchase => purchase.id)));
  for (const linked of rfq.handoff.purchaseOrders) {
    expect(linked.status).toBe(required(workspaces.get(linked.id), "Linked purchase workspace").purchase.status);
  }

  const shipmentIds = [...new Set(expected.shipmentLines.map(line => line.shipmentId))];
  const shipmentPage = await harness.shipment.getShipmentPage({ limit: 100 });
  const health = await harness.shipment.getLandedCostHealth({ limit: 250 });
  expect(shipmentPage.total).toBe(shipmentIds.length);
  expect(health.scannedShipments).toBe(shipmentIds.length);
  expect(sortedIds(shipmentPage.shipments.map(shipment => shipment.id))).toEqual(sortedIds(shipmentIds));
  for (const shipmentId of shipmentIds) {
    const lines = expected.shipmentLines.filter(line => line.shipmentId === shipmentId);
    const review = required(await harness.shipment.getCostReview(shipmentId), `Shipment ${shipmentId} review`);
    expect(sortedIds(review.lines.map(line => line.lineId))).toEqual(sortedIds(lines.map(line => line.id)));
    for (const line of lines) {
      const reviewedLine = required(review.lines.find(row => row.lineId === line.id), `Shipment cost line ${line.id}`);
      expect(isShipmentCostLinePosted(reviewedLine), `Shipment ${shipmentId} line ${line.id} is posted`).toBe(true);
      const purchaseCosts = required(poCosts.get(line.purchaseOrderId), "Linked purchase costs");
      expect(reviewedLine.application?.id).toBe(purchaseCosts.lines.find(row => row.lineId === line.id)?.applicationId);
      const supplierLine = required(review.supplierCosts?.lines.find(row => row.purchaseOrderLineId === line.purchaseOrderLineId),
        `Shipment supplier costs for purchase line ${line.purchaseOrderLineId}`);
      expect(supplierLine).toEqual(required(purchaseCosts.supplierCosts?.lines.find(row => row.purchaseOrderLineId === line.purchaseOrderLineId),
        `PO supplier costs for purchase line ${line.purchaseOrderLineId}`));
    }
    const pageRow = required(shipmentPage.shipments.find(row => row.id === shipmentId), "Shipment list row");
    expect(sortedIds(pageRow.purchaseOrders.map(purchase => purchase.id)))
      .toEqual(sortedIds([...new Set(lines.map(line => line.purchaseOrderId))]));
    const issues = health.items.filter(item => item.shipmentId === shipmentId);
    expect(shipmentPage.costHealthItems.filter(item => item.shipmentId === shipmentId)).toEqual(issues);
    // Invoice creation is independent of posting. A missing invoice must not
    // turn these already-applied amounts into another push-cost task.
    expect(issues.filter(item => item.action === "push_costs_to_lots"
      || ["posting_review_required", "finalized_not_pushed", "stale_provisional_lots"].includes(item.type))).toEqual([]);
  }
  expect((await harness.shipment.getShipmentPage({ costFilter: "ready_to_push" })).total).toBe(0);

  const invoices = await readInvoiceWorkList(invoiceWorkListQuerySchema.parse({ limit: 100 }), FLOW_AT);
  expect(invoices.total).toBe(expected.expectedInvoiceCount);
  expect(invoices.items.reduce((total, invoice) => total + invoice.invoicedAmountCents, 0))
    .toBe(expected.expectedInvoiceTotalCents);
  for (const invoice of invoices.items) {
    expect(invoice).toMatchObject({ status: "approved", paidAmountCents: 0, creditedAmountCents: 0,
      settledAmountCents: 0, balanceCents: invoice.invoicedAmountCents, settlementReviewRequired: false });
  }
  for (const workspace of workspaces.values()) {
    const linkedShipmentIds = workspace.shipments.map(shipment => shipment.id);
    const connectedInvoices = invoices.items.filter(invoice => invoice.poNumbers.includes(workspace.purchase.poNumber)
      || invoice.inboundShipmentId !== null && linkedShipmentIds.includes(invoice.inboundShipmentId));
    expect(sortedIds(workspace.invoices.map(invoice => invoice.id)))
      .toEqual(sortedIds(connectedInvoices.map(invoice => invoice.id)));
    for (const invoice of workspace.invoices) {
      const listed = required(invoices.items.find(row => row.id === invoice.id), `Invoice ${invoice.id} is discoverable`);
      expect(invoice).toMatchObject({
        status: listed.status, invoicedAmountCents: listed.invoicedAmountCents,
        paidAmountCents: listed.paidAmountCents, creditedAmountCents: listed.creditedAmountCents,
        balanceCents: listed.balanceCents, amountScope: "whole_invoice",
      });
      expect([...listed.poNumbers].sort()).toEqual(invoice.purchaseOrderIds.map(id =>
        required(workspaces.get(id), `Invoice-linked purchase ${id}`).purchase.poNumber).sort());
    }
  }
  // At these two cost checkpoints no cash has been recorded. The caller later
  // exercises settlement and replacement through the actual financial owners.
  expect(await readPaymentWorkList(paymentWorkListQuerySchema.parse({ limit: 100 })))
    .toMatchObject({ items: [], total: 0, nextOffset: null });
}
