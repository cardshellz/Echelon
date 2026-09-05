import React, { useEffect, useRef } from "react";
import { Link } from "wouter";
import { ArrowLeft, ExternalLink, Search, X } from "lucide-react";
import type { PurchaseWorkspace, PurchaseWorkspaceRecord } from "@shared/procurement/purchase-workspace";
import type { ProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { WorkspaceStatus } from "./PurchaseLifecycleOverview";
import { formatWorkspaceDate, formatWorkspaceMoney, formatWorkspaceStatus } from "./purchase-workspace-format";

export type ResolvedWorkspaceRecord =
  | { kind: "purchase"; record: PurchaseWorkspace["purchase"] }
  | { kind: "shipment"; record: PurchaseWorkspace["shipments"][number] }
  | { kind: "receipt"; record: PurchaseWorkspace["receipts"][number] }
  | { kind: "invoice"; record: PurchaseWorkspace["invoices"][number] };

export function resolveWorkspaceRecord(data: PurchaseWorkspace, selection: PurchaseWorkspaceRecord | null): ResolvedWorkspaceRecord | null {
  if (!selection) return null;
  switch (selection.kind) {
    case "purchase": return data.purchase.id === selection.id ? { kind: "purchase", record: data.purchase } : null;
    case "shipment": {
      const record = data.shipments.find((row) => row.id === selection.id);
      return record ? { kind: "shipment", record } : null;
    }
    case "receipt": {
      const record = data.receipts.find((row) => row.id === selection.id);
      return record ? { kind: "receipt", record } : null;
    }
    case "invoice": {
      const record = data.invoices.find((row) => row.id === selection.id);
      return record ? { kind: "invoice", record } : null;
    }
  }
}

function recordTitle(selection: ResolvedWorkspaceRecord): string {
  switch (selection.kind) {
    case "purchase": return selection.record.poNumber;
    case "shipment": return `Shipment ${selection.record.shipmentNumber}`;
    case "receipt": return `Receipt ${selection.record.receiptNumber}`;
    case "invoice": return `Invoice ${selection.record.invoiceNumber}`;
  }
}

function canonicalRecordHref(selection: ResolvedWorkspaceRecord): string {
  switch (selection.kind) {
    case "purchase": return `/purchase-orders/${selection.record.id}?tab=lines`;
    case "shipment": return `/shipments/${selection.record.id}`;
    case "receipt": return `/receiving?open=${selection.record.id}`;
    case "invoice": return `/ap-invoices/${selection.record.id}`;
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm">{children}</dd></div>;
}

function PurchaseReadView({ purchase }: { purchase: PurchaseWorkspace["purchase"] }) {
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-4">
        <Field label="Supplier">{purchase.vendorName ?? "Not recorded"}</Field>
        <Field label="PO total">{formatWorkspaceMoney(purchase.totalCents, purchase.currency)}</Field>
        <Field label="Goods status">{formatWorkspaceStatus(purchase.physicalStatus)}</Field>
        <Field label="Recorded financial status">{formatWorkspaceStatus(purchase.financialStatus)}</Field>
        <Field label="Expected delivery">{formatWorkspaceDate(purchase.expectedDeliveryDate)}</Field>
        <Field label="Confirmed delivery">{formatWorkspaceDate(purchase.confirmedDeliveryDate)}</Field>
        <Field label="Actual delivery">{formatWorkspaceDate(purchase.actualDeliveryDate)}</Field>
      </dl>
      <section className="space-y-2 border-t pt-4" aria-label="Purchase order lines">
        <h4 className="text-sm font-semibold">Purchase lines</h4>
        {purchase.lines.length === 0 ? <p className="text-sm text-muted-foreground">No lines recorded.</p> : (
          <div className="max-h-80 overflow-auto rounded-md border">
            <Table>
              <TableHeader><TableRow><TableHead>SKU / line</TableHead><TableHead className="text-right">Ordered</TableHead><TableHead className="text-right">Received</TableHead><TableHead className="text-right">Cancelled</TableHead></TableRow></TableHeader>
              <TableBody>{purchase.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell><span className="font-mono text-xs">{line.sku ?? `Line #${line.id}`}</span><p className="text-xs text-muted-foreground">{line.productName ?? formatWorkspaceStatus(line.lineType)}</p></TableCell>
                  <TableCell className="text-right text-xs">{line.quantityBasis === "pieces" ? `${line.orderedQty.toLocaleString()} pcs` : "Not applicable"}</TableCell>
                  <TableCell className="text-right text-xs">{line.quantityBasis !== "pieces" ? "Not applicable" : line.receivedQty === null ? "Not recorded" : `${line.receivedQty.toLocaleString()} pcs`}</TableCell>
                  <TableCell className="text-right text-xs">{line.quantityBasis !== "pieces" ? "Not applicable" : line.cancelledQty === null ? "Not recorded" : `${line.cancelledQty.toLocaleString()} pcs`}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

function ShipmentReadView({ shipment, purchaseOrderId, navigation }: { shipment: PurchaseWorkspace["shipments"][number]; purchaseOrderId: number; navigation: ProcurementNavigation }) {
  return (
    <div className="space-y-4">
      <p className="rounded-md border bg-muted/40 p-3 text-xs">The currency basis of shipment cost totals is unavailable here. Review the recorded charges and allocations in the full shipment cost view.</p>
      <Button asChild variant="outline" size="sm"><Link href={navigation.childHref(`/shipments/${shipment.id}?tab=costs`)}><ExternalLink className="h-4 w-4" aria-hidden="true" />View shipment costs</Link></Button>
      <dl className="grid grid-cols-2 gap-4">
        <Field label="Transport mode">{formatWorkspaceStatus(shipment.mode)}</Field>
        <Field label="Container">{shipment.containerNumber ?? "Not recorded"}</Field>
        <Field label="Shipment ETA">{formatWorkspaceDate(shipment.eta)}</Field>
        <Field label="Delivered date">{formatWorkspaceDate(shipment.deliveredDate)}</Field>
      </dl>
      <section className="space-y-2 border-t pt-4" aria-label="Shipment line links">
        <h4 className="text-sm font-semibold">Shipment lines</h4>
        <p className="text-xs text-muted-foreground">Each line shows its recorded shipment quantity and purchase order links.</p>
        {shipment.lines.length === 0 ? <p className="text-sm text-muted-foreground">No lines recorded.</p> : (
          <div className="max-h-80 overflow-auto rounded-md border">
            <Table>
              <TableHeader><TableRow><TableHead>SKU / line</TableHead><TableHead>PO link</TableHead><TableHead className="text-right">Recorded qty</TableHead></TableRow></TableHeader>
              <TableBody>{shipment.lines.map((line) => {
                const conflicting = line.purchaseOrderId !== null && line.purchaseOrderLinePurchaseOrderId !== null && line.purchaseOrderId !== line.purchaseOrderLinePurchaseOrderId;
                const linkedId = line.purchaseOrderId ?? line.purchaseOrderLinePurchaseOrderId;
                return (
                  <TableRow key={line.id}>
                    <TableCell className="font-mono text-xs">{line.sku ?? `Line #${line.id}`}</TableCell>
                    <TableCell className="text-xs">
                      {conflicting ? <span className="text-amber-700 dark:text-amber-400">Conflicting links: #{line.purchaseOrderId} / #{line.purchaseOrderLinePurchaseOrderId}</span> : linkedId === null ? "Not linked" : `${linkedId === purchaseOrderId ? "This PO" : `PO #${linkedId}`}`}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{line.qtyShipped.toLocaleString()}</TableCell>
                  </TableRow>
                );
              })}</TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

function ReceiptReadView({ receipt }: { receipt: PurchaseWorkspace["receipts"][number] }) {
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-4">
        <Field label="Recorded purchase order">{receipt.purchaseOrderId ? `PO #${receipt.purchaseOrderId}` : "Not recorded"}</Field>
        <Field label="Recorded shipment">{receipt.inboundShipmentId ? `Shipment #${receipt.inboundShipmentId}` : "Not recorded"}</Field>
        <Field label="Expected receipt">{formatWorkspaceDate(receipt.expectedDate)}</Field>
        <Field label="Received date">{formatWorkspaceDate(receipt.receivedDate)}</Field>
        <Field label="Closed date">{formatWorkspaceDate(receipt.closedDate)}</Field>
      </dl>
      <p className="rounded-md border bg-muted/40 p-3 text-xs">The receipt status is shown as recorded. Open the full receipt for line quantities, posting details and reversals; this summary does not establish that inventory is available for sale.</p>
    </div>
  );
}

function InvoiceReadView({ invoice, purchaseOrderId, navigation }: {
  invoice: PurchaseWorkspace["invoices"][number];
  purchaseOrderId: number;
  navigation: ProcurementNavigation;
}) {
  return (
    <div className="space-y-4">
      <p className="rounded-md border bg-muted/40 p-3 text-xs">Invoice totals and payment status cover the entire invoice. The recorded allocation to this purchase order is shown separately.</p>
      <dl className="grid grid-cols-2 gap-4">
        <Field label="Entire invoice amount">{formatWorkspaceMoney(invoice.invoicedAmountCents, invoice.currency)}</Field>
        <Field label="Paid against entire invoice">{formatWorkspaceMoney(invoice.paidAmountCents, invoice.currency)}</Field>
        <Field label="Entire invoice balance">{formatWorkspaceMoney(invoice.balanceCents, invoice.currency)}</Field>
        <Field label="Allocated to this PO">{formatWorkspaceMoney(invoice.allocatedToPurchaseCents, invoice.currency)}</Field>
        <Field label="Invoice date">{formatWorkspaceDate(invoice.invoiceDate)}</Field>
        <Field label="Due date">{formatWorkspaceDate(invoice.dueDate)}</Field>
      </dl>
      {invoice.purchaseOrderIds.length > 0 && (
        <section className="space-y-2 border-t pt-4" aria-label="Purchase orders linked to invoice">
          <h4 className="text-sm font-semibold">Linked purchase orders</h4>
          <div className="flex flex-wrap gap-3 text-sm">
            {invoice.purchaseOrderIds.map((id) => (
              <Link key={id} href={id === purchaseOrderId ? navigation.inspectHref({ kind: "purchase", id }) : navigation.childHref(`/purchase-orders/${id}?tab=lifecycle`)} className="inline-flex items-center gap-1 rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {id === purchaseOrderId ? "This purchase order" : `PO #${id}`}
                {id !== purchaseOrderId && <ExternalLink className="h-3 w-3" aria-label="Opens full purchase order" />}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function PurchaseRecordInspector({ data, navigation }: { data: PurchaseWorkspace; navigation: ProcurementNavigation }) {
  const selected = navigation.workspace.invalid ? null : resolveWorkspaceRecord(data, navigation.workspace.selected);
  const missing = navigation.workspace.invalid || (navigation.workspace.selected !== null && selected === null);
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousSelection = useRef("");
  const selectionKey = navigation.workspace.invalid ? "invalid" : navigation.workspace.selected ? `${navigation.workspace.selected.kind}:${navigation.workspace.selected.id}` : "";
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = selectionKey;
    if (!selectionKey) {
      if (previous) document.querySelector<HTMLAnchorElement>(`[data-workspace-record="${previous}"]`)?.focus();
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
    if (window.matchMedia("(max-width: 1023px)").matches) panelRef.current?.scrollIntoView({ block: "start" });
  }, [selectionKey]);

  const related = new Map<string, ResolvedWorkspaceRecord>();
  if (selected) {
    for (const edge of data.edges) {
      const matches = (record: PurchaseWorkspaceRecord) => record.kind === selected.kind && record.id === selected.record.id;
      const other = matches(edge.from) ? edge.to : matches(edge.to) ? edge.from : null;
      const record = resolveWorkspaceRecord(data, other);
      if (record) related.set(`${record.kind}:${record.record.id}`, record);
    }
  }

  return (
    <Card ref={panelRef} tabIndex={-1} role="region" aria-labelledby="purchase-record-inspector-title" className="min-w-0 scroll-mt-4 self-start focus:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:sticky lg:top-4" data-testid="purchase-record-inspector">
      <CardHeader className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
          <span className="text-xs font-medium text-muted-foreground">Following {data.purchase.poNumber}</span>
          {(selected || missing) && <Button asChild size="sm" variant="ghost"><Link href={navigation.closeInspectorHref()}><X className="h-4 w-4" aria-hidden="true" />Close inspector</Link></Button>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 ref={headingRef} tabIndex={-1} id="purchase-record-inspector-title" className="min-w-0 break-words text-base font-semibold focus:outline-none">{selected ? recordTitle(selected) : missing ? "Record unavailable in this purchase" : "Inspect a connected record"}</h3>
          {selected && <WorkspaceStatus status={selected.record.status} />}
        </div>
        {(selected || missing) && (
          <div className="flex flex-wrap items-center gap-2">
            {navigation.workspace.trail.length > 0 && <Button asChild variant="outline" size="sm"><Link href={navigation.inspectorBackHref()}><ArrowLeft className="h-4 w-4" aria-hidden="true" />Previous record</Link></Button>}
            {selected && <Button asChild variant="outline" size="sm"><Link href={navigation.childHref(canonicalRecordHref(selected))}><ExternalLink className="h-4 w-4" aria-hidden="true" />Open full record</Link></Button>}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        {missing ? <p role="alert" className="text-sm text-muted-foreground">This selection is invalid or is not among the records returned for this purchase. Close the inspector or select a connected record.</p> : selected ? (
          <>
            {selected.kind === "purchase" && <PurchaseReadView purchase={selected.record} />}
            {selected.kind === "shipment" && <ShipmentReadView shipment={selected.record} purchaseOrderId={data.purchase.id} navigation={navigation} />}
            {selected.kind === "receipt" && <ReceiptReadView receipt={selected.record} />}
            {selected.kind === "invoice" && <InvoiceReadView invoice={selected.record} purchaseOrderId={data.purchase.id} navigation={navigation} />}
            {related.size > 0 && <section className="space-y-2 border-t pt-4" aria-label="Connected records"><h4 className="text-sm font-semibold">Connected records</h4><ul className="space-y-2">{[...related.values()].map((record) => <li key={`${record.kind}:${record.record.id}`}><Link href={navigation.inspectHref({ kind: record.kind, id: record.record.id })} className="rounded-sm text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{recordTitle(record)}</Link></li>)}</ul></section>}
          </>
        ) : <div className="space-y-3 py-8 text-center text-sm text-muted-foreground"><Search className="mx-auto h-6 w-6" aria-hidden="true" /><p>Select a shipment, receipt, invoice or the purchase order.</p><p>The purchase stays open while you follow connected records.</p></div>}
      </CardContent>
    </Card>
  );
}
