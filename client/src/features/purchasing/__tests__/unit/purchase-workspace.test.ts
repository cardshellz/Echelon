import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { purchaseWorkspaceSchema, type PurchaseWorkspace } from "@shared/procurement/purchase-workspace";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { loadPurchaseWorkspace, purchaseWorkspaceQueryOptions, PurchaseLifecycleWorkspaceView } from "../../PurchaseLifecycleWorkspace";
import { resolveWorkspaceRecord } from "../../PurchaseRecordInspector";
import { formatWorkspaceMoney } from "../../purchase-workspace-format";

export function workspaceFixture(): PurchaseWorkspace {
  return purchaseWorkspaceSchema.parse({
    purchase: {
      id: 17, poNumber: "PO-0017", status: "sent", physicalStatus: "in_transit", financialStatus: "paid", currency: "USD",
      vendorName: "Example Supplier", totalCents: 1800000, invoicedTotalCents: 1800000, paidTotalCents: 1800000, outstandingCents: 0,
      expectedDeliveryDate: "2026-10-04T12:00:00Z", confirmedDeliveryDate: null, actualDeliveryDate: null,
      lines: [
        { id: 1, sku: "SKU-A", productName: "Example product", lineType: "product", orderedQty: 100, receivedQty: 10, cancelledQty: 0, quantityBasis: "pieces" },
        { id: 2, sku: null, productName: "Freight charge", lineType: "charge", orderedQty: 1, receivedQty: null, cancelledQty: null, quantityBasis: "not_applicable" },
      ],
    },
    shipments: [
      { id: 42, shipmentNumber: "SHIP-0042", status: "in_transit", mode: "sea_fcl", containerNumber: "EXAMPLE-42", eta: "2026-10-01T12:00:00Z", deliveredDate: null, estimatedTotalCostCents: 240000, actualTotalCostCents: null, amountScope: "whole_shipment", purchaseOrderIds: [17, 99], unlinkedLineCount: 1, lines: [
        { id: 421, purchaseOrderId: 17, purchaseOrderLineId: 1, purchaseOrderLinePurchaseOrderId: 17, sku: "SKU-A", qtyShipped: 90, allocatedCostCents: 120000 },
        { id: 422, purchaseOrderId: 99, purchaseOrderLineId: 991, purchaseOrderLinePurchaseOrderId: 99, sku: "SKU-B", qtyShipped: 400, allocatedCostCents: 100000 },
        { id: 423, purchaseOrderId: 17, purchaseOrderLineId: 992, purchaseOrderLinePurchaseOrderId: 99, sku: "SKU-C", qtyShipped: 4, allocatedCostCents: null },
        { id: 424, purchaseOrderId: null, purchaseOrderLineId: null, purchaseOrderLinePurchaseOrderId: null, sku: "SKU-D", qtyShipped: 6, allocatedCostCents: null },
      ] },
      { id: 43, shipmentNumber: "SHIP-CANCELLED", status: "cancelled", mode: null, containerNumber: null, eta: null, deliveredDate: null, estimatedTotalCostCents: null, actualTotalCostCents: 0, amountScope: "whole_shipment", purchaseOrderIds: [17], unlinkedLineCount: 0, lines: [] },
    ],
    receipts: [
      { id: 31, receiptNumber: "RCPT-DRAFT", status: "draft", purchaseOrderId: 17, inboundShipmentId: 42, expectedDate: null, receivedDate: null, closedDate: null },
      { id: 32, receiptNumber: "RCPT-OTHER-PO", status: "closed", purchaseOrderId: 99, inboundShipmentId: 42, expectedDate: null, receivedDate: "2026-09-01T12:00:00Z", closedDate: "2026-09-01T13:00:00Z" },
      { id: 33, receiptNumber: "RCPT-DIRECT", status: "cancelled", purchaseOrderId: 17, inboundShipmentId: null, expectedDate: null, receivedDate: null, closedDate: null },
    ],
    invoices: [
      { id: 71, invoiceNumber: "INV-SHARED", status: "paid", currency: "USD", invoiceDate: "2026-08-01T12:00:00Z", dueDate: null, inboundShipmentId: 42, invoicedAmountCents: 2300000, paidAmountCents: 2300000, balanceCents: 0, amountScope: "whole_invoice", allocatedToPurchaseCents: null, purchaseOrderIds: [17, 99] },
      { id: 72, invoiceNumber: "INV-CREDIT", status: "received", currency: "USD", invoiceDate: null, dueDate: null, inboundShipmentId: null, invoicedAmountCents: -1234, paidAmountCents: 0, balanceCents: -1234, amountScope: "whole_invoice", allocatedToPurchaseCents: -1234, purchaseOrderIds: [17] },
    ],
    edges: [
      { from: { kind: "purchase", id: 17 }, to: { kind: "shipment", id: 42 }, relationship: "purchase_shipment" },
      { from: { kind: "purchase", id: 17 }, to: { kind: "shipment", id: 43 }, relationship: "purchase_shipment" },
      { from: { kind: "purchase", id: 17 }, to: { kind: "receipt", id: 31 }, relationship: "purchase_receipt" },
      { from: { kind: "purchase", id: 17 }, to: { kind: "receipt", id: 33 }, relationship: "purchase_receipt" },
      { from: { kind: "shipment", id: 42 }, to: { kind: "receipt", id: 31 }, relationship: "shipment_receipt" },
      { from: { kind: "shipment", id: 42 }, to: { kind: "receipt", id: 32 }, relationship: "shipment_receipt" },
      { from: { kind: "shipment", id: 42 }, to: { kind: "invoice", id: 71 }, relationship: "shipment_invoice" },
      { from: { kind: "purchase", id: 17 }, to: { kind: "invoice", id: 71 }, relationship: "purchase_invoice" },
      { from: { kind: "purchase", id: 17 }, to: { kind: "invoice", id: 72 }, relationship: "purchase_invoice" },
    ],
    limitations: ["Shipment and invoice totals cover the entire document."],
  });
}

function renderWorkspace(search: string, data = workspaceFixture()): string {
  function Page() {
    const navigation = useProcurementNavigation();
    return createElement(PurchaseLifecycleWorkspaceView, { data, navigation });
  }
  return renderToStaticMarkup(createElement(Router, { ssrPath: "/purchase-orders/17", ssrSearch: search }, createElement(Page)));
}

describe("purchase lifecycle workspace rendering", () => {
  it("keeps the purchase visible and branches shared shipments to their real receipt records", () => {
    const markup = renderWorkspace("tab=lifecycle");
    expect(markup).toContain("Following PO-0017");
    expect(markup).toContain("Connected records: 2 shipments · 3 receipts · 2 invoices");
    expect(markup).toContain("Recorded financial status");
    expect(markup).toContain('aria-label="Receipts for shipment SHIP-0042"');
    expect(markup).toContain("RCPT-DRAFT");
    expect(markup).toContain("RCPT-OTHER-PO");
    expect(markup).toContain("PO #99");
    expect(markup).toContain("Other receipts linked to this purchase");
    expect(markup).toContain("RCPT-DIRECT");
    expect(markup).toContain("SHIP-CANCELLED");
    expect(markup).toContain("Financial records can progress before goods arrive.");
    expect(markup).not.toContain('role="dialog"');
  });

  it("shows an entire shared invoice separately from its unknown PO allocation", () => {
    const markup = renderWorkspace("tab=lifecycle&inspect=invoice:71");
    expect(markup).toContain("Entire invoice amount");
    expect(markup).toContain("$23,000.00");
    expect(markup).toContain("Allocated to this PO");
    expect(markup).toContain("Not recorded");
    expect(markup).toContain("Paid against entire invoice");
    expect(markup).toContain("Open full record");
    expect(markup).toContain("inspect=shipment%3A42");
    expect(markup).not.toContain("Record Payment");
  });

  it.each([{ purchaseOrderIds: [] }, { purchaseOrderIds: [99] }, { purchaseOrderIds: [99, 99] }])("labels cost-only invoice shipment edges without inventing a PO or shared invoice link ($purchaseOrderIds)", ({ purchaseOrderIds }) => {
    const data = workspaceFixture();
    data.invoices = [{ ...data.invoices[0], inboundShipmentId: null, purchaseOrderIds }];
    data.edges = data.edges.filter((edge) => edge.to.kind !== "invoice" || (edge.relationship === "shipment_invoice" && edge.to.id === 71));
    const markup = renderWorkspace("tab=lifecycle", data);
    expect(markup).toContain("Linked to shipment #42");
    expect(markup).not.toMatch(/Linked to (?:this )?purchase order/);
    expect(markup).not.toContain("Shared invoice");
  });

  it("does not assign the PO currency to a shared shipment or hide conflicting lineage", () => {
    const markup = renderWorkspace("tab=lifecycle&inspect=shipment:42");
    expect(markup).toContain("View shipment costs");
    expect(markup).toContain("currency basis of shipment cost totals is unavailable");
    expect(markup).not.toContain("2,400.00");
    expect(markup).toContain("Conflicting links: #17 / #99");
    expect(markup).toContain("Recorded qty");
    expect(markup).toContain("Not linked");
  });

  it("shows record status without asserting posting or sale availability", () => {
    const markup = renderWorkspace("tab=lifecycle&inspect=receipt:32");
    expect(markup).toContain("Receipt RCPT-OTHER-PO");
    expect(markup).toContain("Closed date");
    expect(markup).toContain("does not establish that inventory is available for sale");
    expect(markup).not.toContain("Finalize &amp; Update Inventory");
  });

  it("does not show non-product order lines as pieces", () => {
    const markup = renderWorkspace("tab=lifecycle&inspect=purchase:17");
    expect(markup).toContain("100 pcs");
    expect(markup).toContain("Not applicable");
    expect(markup).not.toContain(">1 pcs<");
  });

  it.each(["invoice:999", "shipment:invalid", "purchase:99"])("shows an unavailable inspector for %s without silently replacing the record", (selection) => {
    const markup = renderWorkspace(`tab=lifecycle&inspect=${selection}`);
    expect(markup).toContain("Record unavailable in this purchase");
    expect(markup).toContain("Close inspector");
    expect(markup).not.toContain("Open full record");
  });

  it("resolves records by both kind and id and preserves signed invoice credits", () => {
    const data = workspaceFixture();
    expect(resolveWorkspaceRecord(data, { kind: "shipment", id: 71 })).toBeNull();
    expect(renderWorkspace("tab=lifecycle&inspect=invoice:72")).toContain("-$12.34");
  });
});

describe("purchase workspace read boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses only the scoped read endpoint and forwards request cancellation", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(workspaceFixture()), { status: 200 }));
    vi.stubGlobal("fetch", request);
    const controller = new AbortController();
    expect((await loadPurchaseWorkspace(17, controller.signal)).purchase.id).toBe(17);
    expect(request).toHaveBeenCalledWith("/api/purchase-orders/17/workspace", { credentials: "include", signal: controller.signal });
  });

  it("refreshes a mounted workspace when a same-page command invalidates its purchase", async () => {
    let responseData = workspaceFixture();
    const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify(responseData)));
    vi.stubGlobal("fetch", request);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: "always" },
      },
    });
    const options = purchaseWorkspaceQueryOptions(17);
    const observer = new QueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await queryClient.fetchQuery(options);
      expect(observer.getCurrentResult().data?.invoices).toHaveLength(2);
      expect(request).toHaveBeenCalledTimes(1);

      const newInvoice = { ...responseData.invoices[0], id: 73, invoiceNumber: "INV-CREATED-WHILE-OPEN" };
      responseData = { ...responseData, invoices: [...responseData.invoices, newInvoice] };
      await queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders/99"] });
      expect(request).toHaveBeenCalledTimes(1);

      // This is the existing invalidation issued by PO header commands. The
      // observer stays subscribed, matching a lifecycle tab that never unmounts.
      await queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders/17"] });
      expect(observer.getCurrentResult().data?.invoices.map((invoice) => invoice.invoiceNumber)).toContain("INV-CREATED-WHILE-OPEN");
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it.each([401, 403, 404, 503])("rejects an unsuccessful %s response instead of showing empty records", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })));
    await expect(loadPurchaseWorkspace(17)).rejects.toThrow();
  });

  it("offers source-record tabs when the bounded workspace is too large", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: "PURCHASE_WORKSPACE_TOO_LARGE" }),
      { status: 422 },
    )));
    await expect(loadPurchaseWorkspace(17)).rejects.toThrow("This purchase has too many connected records for this view. Use the Shipments, Receipts and Invoices tabs to inspect source records.");
  });

  it("rejects validly shaped data for a different purchase", async () => {
    const data = workspaceFixture();
    data.purchase.id = 99;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(data))));
    await expect(loadPurchaseWorkspace(17)).rejects.toThrow("could not be verified");
  });

  it("rejects invalid financial data and invalid identity without making a request", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...workspaceFixture(), invoices: [{ id: 71, invoicedAmountCents: 1.5 }] })));
    vi.stubGlobal("fetch", request);
    await expect(loadPurchaseWorkspace(0)).rejects.toThrow("invalid purchase order ID");
    expect(request).not.toHaveBeenCalled();
    await expect(loadPurchaseWorkspace(17)).rejects.toThrow("could not be verified");
  });
});

describe("workspace money formatting", () => {
  it("keeps unknown, zero, signed credits and other currencies distinct", () => {
    expect(formatWorkspaceMoney(null, "USD")).toBe("Not recorded");
    expect(formatWorkspaceMoney(0, "USD")).toBe("$0.00");
    expect(formatWorkspaceMoney(-1234, "USD")).toBe("-$12.34");
    expect(formatWorkspaceMoney(1234, "EUR")).toBe("12.34 EUR");
    expect(formatWorkspaceMoney(1234, null)).toBe("12.34 (currency not recorded)");
  });

  it("formats the largest safe integer without floating-point rounding and rejects unsafe amounts", () => {
    expect(formatWorkspaceMoney(Number.MAX_SAFE_INTEGER, "USD")).toBe("$90,071,992,547,409.91");
    expect(() => formatWorkspaceMoney(1.5, "USD")).toThrow(RangeError);
    expect(() => formatWorkspaceMoney(Number.MAX_SAFE_INTEGER + 1, "USD")).toThrow(RangeError);
  });
});
