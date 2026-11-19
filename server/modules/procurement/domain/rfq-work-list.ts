import { rfqHandoffSchema, type RfqHandoff, type RfqWorkListHeader, type RfqWorkListLine } from "@shared/procurement/rfq-work-list";

export interface RfqHandoffLinkEvidence {
  id: number; rfqId: number; rfqLineId: number; quoteRevisionId: number; purchaseOrderId: number; purchaseOrderLineId: number;
  actualRfqId: number | null; quoteRfqId: number | null; quoteRfqLineId: number | null; quoteCurrency: string | null;
  actualPurchaseOrderId: number | null; purchaseOrderVendorId: number | null; poNumber: string | null; purchaseOrderStatus: string | null;
}

/** A conversion is established only by the retained quote -> request line ->
 * purchase line chain. Current PO quantity/status may legitimately change after
 * conversion; preserve that provenance and display the current PO status. */
export function summarizeRfqHandoff(header: RfqWorkListHeader, lines: readonly RfqWorkListLine[], links: readonly RfqHandoffLinkEvidence[]): RfqHandoff {
  const issues = new Map<string, string>();
  const byLine = new Map(lines.map(line => [line.id, line]));
  const linked = new Set<number>();
  const purchaseOrders = new Map<number, RfqHandoff["purchaseOrders"][number]>();
  const counts = new Map<number, number>();
  const purchaseLineCounts = new Map<number, number>();
  for (const link of links) {
    counts.set(link.rfqLineId, (counts.get(link.rfqLineId) ?? 0) + 1);
    purchaseLineCounts.set(link.purchaseOrderLineId, (purchaseLineCounts.get(link.purchaseOrderLineId) ?? 0) + 1);
  }
  for (const link of links) {
    const line = byLine.get(link.rfqLineId);
    if (!line || link.rfqId !== header.id || link.actualRfqId !== header.id
      || link.quoteRfqId !== header.id || link.quoteRfqLineId !== link.rfqLineId || link.quoteCurrency !== header.currency
      || link.actualPurchaseOrderId !== link.purchaseOrderId || link.purchaseOrderVendorId !== header.vendorId
      || !link.poNumber || !link.purchaseOrderStatus || line.status !== "ordered"
      || counts.get(link.rfqLineId) !== 1 || purchaseLineCounts.get(link.purchaseOrderLineId) !== 1) {
      issues.set("RFQ_PURCHASE_LINK_REVIEW_REQUIRED", "A recorded conversion has missing or conflicting request, quote or purchase-line evidence. Review the original conversion.");
      continue;
    }
    linked.add(line.id);
    purchaseOrders.set(link.purchaseOrderId, { id: link.purchaseOrderId, poNumber: link.poNumber, status: link.purchaseOrderStatus });
  }
  if (lines.some(line => line.status === "ordered" && !linked.has(line.id))) {
    issues.set("RFQ_ORDERED_LINE_UNVERIFIED", "An ordered request line has no verified purchase-order link. Review its original purchase evidence.");
  }
  const active = ["draft", "sent", "partially_quoted", "quoted"].includes(header.status);
  const remainingLineCount = active ? lines.filter(line => !linked.has(line.id) && ["draft", "sent", "quoted", "accepted"].includes(line.status)).length : 0;
  return rfqHandoffSchema.parse({
    state: issues.size > 0 ? "review_required" : linked.size === 0 ? "not_started" : linked.size === lines.length ? "converted" : "partially_converted",
    linkedLineCount: linked.size, remainingLineCount,
    issues: [...issues].map(([code, message]) => ({ code, message })),
    purchaseOrders: [...purchaseOrders.values()].sort((left, right) => left.id - right.id),
  });
}
