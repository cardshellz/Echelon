import React, { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { buildCostReviewGroups, costReviewSummary, type CostReviewGroup, type CostReviewTask, type CostReviewShipmentLine } from "@shared/procurement/cost-review-tasks";
import { purchaseLineNeedsCostReview, purchaseLineInventoryEffect, type PurchaseCostStatus, type PurchaseLineCostStatus } from "@shared/procurement/purchase-cost-status";
import { noInventoryEffectLabel } from "./cost-inventory-effect-presentation";
import { formatShipmentExceptionAmount } from "@shared/procurement/shipment-cost-exception";
import { formatIntegerCents } from "@shared/utils/format-integer-cents";
import type { ProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { CostReviewDialogs, type CostReviewDialog, type OpenCostReview } from "./CostReviewDialogs";
import { ShipmentCostUpdateAction } from "./ShipmentCostUpdateAction";
import { createReceiptCostRetryClient } from "./receipt-cost-retry";

function ApplySupplierCosts({ receiptId }: { receiptId: number }) {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const [retry] = useState(() => createReceiptCostRetryClient({ generateKey: () => crypto.randomUUID() }));
  const update = useMutation({ mutationFn: () => retry(receiptId), onSettled: () => invalidatePurchaseCosts(queryClient) });
  if (!hasPermission("purchasing", "approve")) return <p className="text-xs text-muted-foreground">A purchasing approver can apply these costs.</p>;
  return <div className="space-y-2"><Button size="sm" variant="outline" disabled={update.isPending} onClick={() => update.mutate()}>{update.isPending ? "Updating costs…" : "Apply supplier costs"}</Button>
    {update.isError && <p role="alert">{update.error.message}</p>}
    {update.isSuccess && <p role="status">Cost update recorded. The current results are refreshed here.</p>}
  </div>;
}

function InvoiceTaskActions({ task, group, openReview }: { task: CostReviewTask; group: CostReviewGroup; openReview: OpenCostReview }) {
  const line = group.supplier;
  const invoices = line?.invoices.filter(invoice => task.invoiceLineId === undefined || invoice.lineId === task.invoiceLineId) ?? [];
  if (task.action === "invoice_amounts") return <>{invoices.map(invoice => <Button key={invoice.lineId} size="sm" variant="outline" onClick={() => openReview({ kind: "invoice_amounts", invoiceId: invoice.invoiceId, lineId: invoice.lineId })}>Confirm invoice</Button>)}
    {!invoices.length && <p className="text-xs">Reload costs to retrieve the invoice line before editing it.</p>}</>;
  if (task.action === "invoice_quantity") return <>{(line?.invoices ?? []).map(invoice => <Button key={invoice.lineId} size="sm" variant="outline" onClick={() => openReview({ kind: "invoice_quantity", lineId: invoice.lineId, lineNumber: invoice.lineNumber })}>Review quantities{(line?.invoices.length ?? 0) > 1 ? ` · ${invoice.invoiceNumber} line ${invoice.lineNumber}` : ""}</Button>)}</>;
  return null;
}

function TaskAction({ task, group, navigation, showShipmentUpdates, openReview }: { task: CostReviewTask; group: CostReviewGroup; navigation: ProcurementNavigation; showShipmentUpdates: boolean; openReview: OpenCostReview }) {
  const line = group.supplier;
  if (task.action === "invoice_amounts" || task.action === "invoice_quantity") return <InvoiceTaskActions task={task} group={group} openReview={openReview} />;
  if (task.action === "repair_origin" && task.lotId) return <Button size="sm" variant="outline" onClick={() => openReview({ kind: "origin", lotId: task.lotId! })}>Review receipt link</Button>;
  if (task.action === "apply_supplier" && line?.receipts[0]) return <ApplySupplierCosts receiptId={line.receipts[0].receiptId} />;
  if (task.action === "record_invoice" && line) return <Button size="sm" variant="outline" asChild><Link href={navigation.childHref(`/purchase-orders/${line.purchaseOrderId}?tab=invoices`)}>Record supplier invoice</Link></Button>;
  const shipment = task.shipment;
  if (shipment) {
    if (task.action === "measurements") return <Button size="sm" variant="outline" onClick={() => openReview({ kind: "measurements", shipmentId: shipment.shipmentId })}>Review measurements</Button>;
    if (task.action === "update_shipment") return <>
      {showShipmentUpdates ? <div className="space-y-1" data-testid={`cost-update-shipment-${shipment.shipmentId}`}><ShipmentCostUpdateAction shipmentId={shipment.shipmentId} /><p className="text-xs text-muted-foreground">Updates the whole shipment, including its other linked POs.</p></div> : <p className="text-xs text-muted-foreground">These costs update together with the other products on this shipment.</p>}
      {shipment.exceptionReview?.reconciliation?.status === "review_required" && <Button size="sm" variant="outline" onClick={() => openReview({ kind: "reconciliation", lineId: shipment.lineId, review: shipment.exceptionReview! })}>Review remaining cost</Button>}
    </>;
    if (task.action === "repair_links") return <><Button size="sm" variant="outline" onClick={() => openReview({ kind: "links", shipmentId: shipment.shipmentId, lineId: shipment.lineId, sku: shipment.sku })}>Review missing links</Button>
      {shipment.exceptionReview && <Button size="sm" variant="outline" onClick={() => openReview({ kind: "reconciliation", lineId: shipment.lineId, review: shipment.exceptionReview! })}>Review remaining cost</Button>}</>;
    if (shipment.exceptionReview && task.action === "review_history") return <Button size="sm" variant="outline" onClick={() => openReview({ kind: "reconciliation", lineId: shipment.lineId, review: shipment.exceptionReview! })}>Review history and cost</Button>;
    return <Button size="sm" variant="outline" asChild><Link href={navigation.childHref(`/shipments/${shipment.shipmentId}?tab=costs`)}>Review shipment charges</Link></Button>;
  }
  return <>{line?.receipts.map(receipt => <Button key={receipt.receiptId} size="sm" variant="outline" asChild><Link href={navigation.childHref(`/receiving?open=${receipt.receiptId}`)}>Review {receipt.receiptNumber}</Link></Button>)}
    {line?.invoices.map(invoice => <Button key={invoice.lineId} size="sm" variant="outline" asChild><Link href={navigation.childHref(`/ap-invoices/${invoice.invoiceId}?tab=lines`)}>View invoice {invoice.invoiceNumber} · line {invoice.lineNumber}</Link></Button>)}</>;
}

function CostReviewProduct({ group, navigation, showShipmentUpdates = true, updateTaskIds, openReview }: { group: CostReviewGroup; navigation: ProcurementNavigation; showShipmentUpdates?: boolean; updateTaskIds?: ReadonlySet<string>; openReview: OpenCostReview }) {
  return <article className="rounded-lg border p-3 space-y-3 min-w-0" data-testid={`cost-review-${group.key}`}>
    <div className="space-y-3" data-testid={group.supplier && purchaseLineNeedsCostReview(group.supplier) ? `supplier-cost-line-${group.supplier.purchaseOrderLineId}` : undefined}>
    <div className="flex flex-wrap items-baseline justify-between gap-1"><h4 className="font-semibold break-words">{group.sku ?? "Product without a saved SKU"}</h4>
      {group.purchaseOrderId !== null && <span className="text-xs text-muted-foreground">{group.poNumber ?? `PO #${group.purchaseOrderId}`}</span>}</div>
    {group.tasks.map(task => <div key={task.id} className="border-t pt-3 space-y-2" data-testid={`cost-task-${task.id}`}>
      <h5 className="font-medium">{task.title}</h5><p className="text-sm">{task.explanation}</p>
      {task.action === "invoice_amounts" && group.supplier?.invoices.filter(invoice => invoice.lineId === task.invoiceLineId).map(invoice => <p key={invoice.lineId} className="text-xs text-muted-foreground">Invoice {invoice.invoiceNumber} · line {invoice.lineNumber}</p>)}
      {task.facts?.map(fact => <p key={fact} className="text-sm">{fact}</p>)}
      {task.shipment && <p className="text-xs text-muted-foreground">Shipment {task.shipment.shipmentNumber ?? `#${task.shipment.shipmentId}`}{task.shipment.exceptionReview
        ? ` · Amount to resolve: ${formatShipmentExceptionAmount(task.shipment.exceptionReview.amountMills, task.shipment.exceptionReview.currency)}`
        : task.shipment.amountCents !== null && task.shipment.currency !== null ? ` · Saved shipping share: ${formatIntegerCents(task.shipment.amountCents, task.shipment.currency)}` : " · Amount impact will be shown in the review"}</p>}
      {!task.shipment && group.supplier?.reviewFacts && group.supplier.invoices.length > 0 && <p className="text-xs text-muted-foreground">Linked supplier invoice total: {group.supplier.reviewFacts.currency === null || group.supplier.reviewFacts.invoiceAmountCents === null ? "A single-currency total is unavailable" : formatIntegerCents(group.supplier.reviewFacts.invoiceAmountCents, group.supplier.reviewFacts.currency)}. Changes are shown before approval.</p>}
      <div className="flex flex-wrap items-center gap-2"><TaskAction task={task} group={group} navigation={navigation} openReview={openReview} showShipmentUpdates={showShipmentUpdates && (!updateTaskIds || updateTaskIds.has(task.id))} />
        {task.shipment && <Button size="sm" variant="ghost" asChild><Link href={navigation.childHref(`/shipments/${task.shipment.shipmentId}?tab=allocation`)}>View shipment cost details</Link></Button>}
      </div>
      {task.issues.length > 0 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Saved records and technical details</summary>
        <ul className="mt-2 list-disc pl-4 space-y-1">{task.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message}
          {issue.orderCostReview && <Link className="ml-1 text-primary underline" href={`/orders?orderId=${issue.orderCostReview.orderId}`}>Review order #{issue.orderCostReview.orderId}</Link>}</li>)}</ul>
      </details>}
    </div>)}
    {group.supplier && group.supplier.lots.length > 0 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Stock and receipt records ({group.supplier.lots.length})</summary>
      <ul className="mt-2 space-y-1">{group.supplier.lots.map(lot => <li key={lot.id}>{lot.lotNumber} · {lot.onHandUnits.toLocaleString("en-US")} units on hand · {lot.origin === "receipt" ? "Receipt linked" : lot.origin === "transformation" ? "Transfer / repacking linked" : "Original receipt link missing"}</li>)}</ul>
      <div className="mt-2 flex flex-wrap gap-3">{group.supplier.receipts.map(receipt => <Link key={receipt.receiptId} className="text-primary underline" href={navigation.childHref(`/receiving?open=${receipt.receiptId}`)}>View {receipt.receiptNumber}</Link>)}</div>
    </details>}
    </div>
  </article>;
}

function SupplierReturnCompletion({ line }: { line: PurchaseLineCostStatus }) {
  const effect = purchaseLineInventoryEffect(line);
  if (!effect) return null;
  return <div className="space-y-1"><p className="text-green-800 dark:text-green-300">{noInventoryEffectLabel}</p><p className="text-xs">No inventory change. All {effect.returnedBasePieces.toLocaleString("en-US")} base pieces were returned before acceptance.</p>
    <details className="text-xs"><summary>Return and receipt evidence</summary><p>Zero remaining source quantity; no inventory lots were created.</p></details></div>;
}

function CompletedCosts({ groups, navigation, openReview }: { groups: CostReviewGroup[]; navigation: ProcurementNavigation; openReview: OpenCostReview }) {
  const completed = groups.filter(group => (group.supplier && !purchaseLineNeedsCostReview(group.supplier)) || group.shipments.some(line => line.posted));
  if (!completed.length) return null;
  return <details className="rounded-lg border p-3 text-sm" data-testid="completed-costs"><summary className="cursor-pointer font-semibold">Completed ({completed.length} products)</summary>
    <div className="mt-3 space-y-3">{completed.map(group => <div key={group.key} className="border-t pt-3 space-y-2" data-testid={group.supplier && !purchaseLineNeedsCostReview(group.supplier) ? `supplier-cost-line-${group.supplier.purchaseOrderLineId}` : undefined}><strong>{group.sku ?? "Product"}</strong>
      {group.supplier && !purchaseLineNeedsCostReview(group.supplier) && <>
        <p className="text-green-800 dark:text-green-300">Supplier costs applied. No further approval is needed.</p>
        <SupplierReturnCompletion line={group.supplier} />
        {group.supplier.components.flatMap(component => component.postingReceipt ? [<p key={component.component} className="text-xs">{component.component === "product" ? "Product" : "Packaging"}: {formatShipmentExceptionAmount(component.postingReceipt.amountMills, group.supplier?.reviewFacts?.currency ?? "USD")} · Applied by {component.postingReceipt.actorName} · {new Date(component.postingReceipt.recordedAt).toLocaleString()}</p>] : [])}
        {group.supplier.originRepairs?.map(repair => <p key={repair.id} className="text-xs">Receipt link repaired · Approved by {repair.actorName} · {new Date(repair.recordedAt).toLocaleString()} · {repair.reason}</p>)}
        {group.supplier.originRepairs?.map(repair => <Button key={`view:${repair.id}`} size="sm" variant="outline" onClick={() => openReview({ kind: "origin", lotId: repair.lotId })}>View origin repair and approval</Button>)}
        {group.supplier.invoices.map(invoice => <Link key={invoice.lineId} className="mr-3 text-xs text-primary underline" href={navigation.childHref(`/ap-invoices/${invoice.invoiceId}?tab=lines`)}>View invoice {invoice.invoiceNumber} · line {invoice.lineNumber}</Link>)}
      </>}
      {group.shipments.filter(line => line.posted).map(line => <div key={line.lineId} className="space-y-1 text-xs"><p>Shipping costs applied · {line.shipmentNumber ?? `Shipment #${line.shipmentId}`}{line.recordedAt ? ` · ${new Date(line.recordedAt).toLocaleString()}` : ""}</p>
        <Link className="text-primary underline" href={navigation.childHref(`/shipments/${line.shipmentId}?tab=allocation`)}>View shipment cost details</Link>
        {line.exceptionReview?.reconciliation?.status === "posted" && <Button size="sm" variant="outline" onClick={() => openReview({ kind: "reconciliation", lineId: line.lineId, review: line.exceptionReview! })}>View posting and approval</Button>}
      </div>)}
    </div>)}</div>
  </details>;
}

/** Used by PO, shipment, receiving and lifecycle. Counts, grouping and wording
 * all come from the shared task projection over current posting evidence. */
export function CostReviewPanel({ supplier, shipments = [], navigation, showHeading = true, showShipmentUpdates = true }: {
  supplier?: PurchaseCostStatus; shipments?: readonly CostReviewShipmentLine[]; navigation: ProcurementNavigation; showHeading?: boolean; showShipmentUpdates?: boolean;
}) {
  const [review, setReview] = useState<CostReviewDialog | null>(null);
  const groups = buildCostReviewGroups(supplier, shipments);
  const remaining = groups.filter(group => group.tasks.length > 0);
  const updateShipments = new Set<number>(), updateTaskIds = new Set<string>();
  for (const group of remaining) for (const task of group.tasks) if (task.action === "update_shipment" && task.shipment && !updateShipments.has(task.shipment.shipmentId)) {
    updateShipments.add(task.shipment.shipmentId); updateTaskIds.add(task.id);
  }
  return <section id="supplier-cost-review" aria-label="Cost review" className="space-y-3 text-sm min-w-0">
    {showHeading && <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">Cost review</h3><p role="status" className={remaining.length ? "text-amber-800 dark:text-amber-300" : "text-green-800 dark:text-green-300"}>{costReviewSummary(groups, supplier ? "all" : "shipping")}</p></div>}
    {remaining.map(group => <CostReviewProduct key={group.key} group={group} navigation={navigation} showShipmentUpdates={showShipmentUpdates} updateTaskIds={updateTaskIds} openReview={setReview} />)}
    <CompletedCosts groups={groups} navigation={navigation} openReview={setReview} />
    {review && <CostReviewDialogs review={review} onClose={() => setReview(null)} />}
  </section>;
}
