import React from "react";
import { Link } from "wouter";
import { FileText, PackageCheck, Ship, WalletCards } from "lucide-react";
import type { PurchaseWorkspace, PurchaseWorkspaceRecord } from "@shared/procurement/purchase-workspace";
import type { ProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatWorkspaceDate, formatWorkspaceMoney, formatWorkspaceStatus } from "./purchase-workspace-format";

interface OverviewProps {
  data: PurchaseWorkspace;
  navigation: ProcurementNavigation;
}

export function WorkspaceStatus({ status }: { status: string }) {
  return <Badge variant="outline" className="shrink-0 text-xs">{formatWorkspaceStatus(status)}</Badge>;
}

function RecordLink({ record, navigation, children }: {
  record: PurchaseWorkspaceRecord;
  navigation: ProcurementNavigation;
  children: React.ReactNode;
}) {
  const selected = navigation.workspace.selected;
  return (
    <Link
      href={navigation.inspectHref(record)}
      data-workspace-record={`${record.kind}:${record.id}`}
      aria-current={selected?.kind === record.kind && selected.id === record.id ? "true" : undefined}
      className="min-w-0 break-words rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:underline"
    >
      {children}
    </Link>
  );
}

function ReceiptRow({ receipt, navigation }: {
  receipt: PurchaseWorkspace["receipts"][number];
  navigation: ProcurementNavigation;
}) {
  return (
    <li className="rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <PackageCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <RecordLink record={{ kind: "receipt", id: receipt.id }} navigation={navigation}>
          {receipt.receiptNumber}
        </RecordLink>
        <WorkspaceStatus status={receipt.status} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {receipt.purchaseOrderId ? `PO #${receipt.purchaseOrderId}` : "PO link not recorded"}
        {receipt.receivedDate ? ` · Received ${formatWorkspaceDate(receipt.receivedDate)}` : " · Receipt date not recorded"}
      </p>
    </li>
  );
}

export function PurchaseLifecycleOverview({ data, navigation }: OverviewProps) {
  const { purchase, shipments, receipts, invoices } = data;
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const shipmentIds = new Set(shipments.map((shipment) => shipment.id));
  const receiptsByShipment = new Map<number, Set<number>>();
  const groupedReceiptIds = new Set<number>();
  const invoiceIds = new Set(invoices.map((invoice) => invoice.id));
  const shipmentsByInvoice = new Map<number, Set<number>>();
  const directPurchaseInvoiceIds = new Set<number>();
  for (const edge of data.edges) {
    if (edge.relationship === "shipment_receipt" && edge.from.kind === "shipment" && edge.to.kind === "receipt") {
      if (!shipmentIds.has(edge.from.id) || !receiptById.has(edge.to.id)) continue;
      const ids = receiptsByShipment.get(edge.from.id) ?? new Set<number>();
      ids.add(edge.to.id);
      receiptsByShipment.set(edge.from.id, ids);
      groupedReceiptIds.add(edge.to.id);
    }
    if (edge.relationship === "shipment_invoice" && edge.from.kind === "shipment" && edge.to.kind === "invoice") {
      if (!shipmentIds.has(edge.from.id) || !invoiceIds.has(edge.to.id)) continue;
      const ids = shipmentsByInvoice.get(edge.to.id) ?? new Set<number>();
      ids.add(edge.from.id);
      shipmentsByInvoice.set(edge.to.id, ids);
    }
    if (edge.relationship === "purchase_invoice" && edge.from.kind === "purchase" && edge.from.id === purchase.id && edge.to.kind === "invoice") {
      directPurchaseInvoiceIds.add(edge.to.id);
    }
  }
  const otherReceipts = receipts.filter((receipt) => !groupedReceiptIds.has(receipt.id));

  return (
    <div className="min-w-0 space-y-5" data-testid="purchase-workspace-records">
      <Card className="border-primary/30">
        <CardHeader className="p-4 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-base font-semibold">
              <FileText className="h-4 w-4" aria-hidden="true" />
              <RecordLink record={{ kind: "purchase", id: purchase.id }} navigation={navigation}>{purchase.poNumber}</RecordLink>
            </h3>
            <WorkspaceStatus status={purchase.status} />
          </div>
          <p className="break-words text-sm text-muted-foreground">{purchase.vendorName ?? "Supplier name not recorded"}</p>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-xs text-muted-foreground">PO total</dt><dd className="mt-1 break-words font-mono font-semibold">{formatWorkspaceMoney(purchase.totalCents, purchase.currency)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Confirmed delivery</dt><dd className="mt-1">{formatWorkspaceDate(purchase.confirmedDeliveryDate)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Goods status</dt><dd className="mt-1">{formatWorkspaceStatus(purchase.physicalStatus)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Recorded financial status</dt><dd className="mt-1">{formatWorkspaceStatus(purchase.financialStatus)}</dd></div>
          </dl>
          <p className="border-t pt-3 text-xs text-muted-foreground">
            Connected records: {shipments.length} shipment{shipments.length === 1 ? "" : "s"} · {receipts.length} receipt{receipts.length === 1 ? "" : "s"} · {invoices.length} invoice{invoices.length === 1 ? "" : "s"}
          </p>
        </CardContent>
      </Card>

      <section aria-labelledby="purchase-workspace-goods">
        <div className="mb-3">
          <h3 id="purchase-workspace-goods" className="font-semibold">Goods and deliveries</h3>
          <p className="mt-1 text-xs text-muted-foreground">Each shipment keeps its own receipts and status. Select a record to inspect it.</p>
        </div>
        {shipments.length === 0 && (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No linked shipments recorded.</p>
        )}
        <ul className="space-y-4">
          {shipments.map((shipment) => {
            const linkedReceiptIds = [...(receiptsByShipment.get(shipment.id) ?? [])];
            const includesOtherPurchases = shipment.purchaseOrderIds.some((id) => id !== purchase.id);
            return (
              <li key={shipment.id} className="relative ml-2 border-l-2 border-primary/20 pl-4">
                <div className="absolute -left-[5px] top-5 h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
                <Card>
                  <CardContent className="space-y-2 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Ship className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      <RecordLink record={{ kind: "shipment", id: shipment.id }} navigation={navigation}>{shipment.shipmentNumber}</RecordLink>
                      <WorkspaceStatus status={shipment.status} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      ETA {formatWorkspaceDate(shipment.eta)}
                      {shipment.containerNumber ? ` · Container ${shipment.containerNumber}` : ""}
                    </p>
                    {includesOtherPurchases && <p className="text-xs font-medium text-muted-foreground">Shared shipment · includes other purchase orders</p>}
                    {shipment.unlinkedLineCount > 0 && <p className="text-xs text-amber-700 dark:text-amber-400">{shipment.unlinkedLineCount} shipment line{shipment.unlinkedLineCount === 1 ? " has" : "s have"} no PO link</p>}
                  </CardContent>
                </Card>
                {linkedReceiptIds.length > 0 ? (
                  <ul className="ml-3 mt-2 space-y-2 border-l border-border pl-3" aria-label={`Receipts for shipment ${shipment.shipmentNumber}`}>
                    {linkedReceiptIds.map((id) => <ReceiptRow key={id} receipt={receiptById.get(id)!} navigation={navigation} />)}
                  </ul>
                ) : <p className="py-2 text-xs text-muted-foreground">No linked receipts recorded.</p>}
              </li>
            );
          })}
        </ul>
        {otherReceipts.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-2 text-sm font-medium">Other receipts linked to this purchase</h4>
            <ul className="space-y-2">{otherReceipts.map((receipt) => <ReceiptRow key={receipt.id} receipt={receipt} navigation={navigation} />)}</ul>
          </div>
        )}
      </section>

      <section aria-labelledby="purchase-workspace-finance">
        <h3 id="purchase-workspace-finance" className="flex items-center gap-2 font-semibold"><WalletCards className="h-4 w-4" aria-hidden="true" />Invoices and payment status</h3>
        <p className="mb-3 mt-1 text-xs text-muted-foreground">Financial records can progress before goods arrive. Amounts below cover each entire invoice.</p>
        {invoices.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No linked invoices recorded.</p>
        ) : (
          <ul className="space-y-2">
            {invoices.map((invoice) => {
              const linkedShipmentIds = [...(shipmentsByInvoice.get(invoice.id) ?? [])].sort((a, b) => a - b);
              const relationshipLabel = linkedShipmentIds.length > 0
                ? `Linked to shipment${linkedShipmentIds.length === 1 ? "" : "s"} ${linkedShipmentIds.map((id) => `#${id}`).join(", ")}`
                : directPurchaseInvoiceIds.has(invoice.id) ? "Linked to this purchase order" : "Connected invoice";
              return (
              <li key={invoice.id} className="rounded-lg border bg-card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <RecordLink record={{ kind: "invoice", id: invoice.id }} navigation={navigation}>Invoice {invoice.invoiceNumber}</RecordLink>
                  <WorkspaceStatus status={invoice.status} />
                </div>
                <p className="mt-2 break-words text-sm"><span className="text-muted-foreground">Entire invoice: </span><span className="font-mono">{formatWorkspaceMoney(invoice.invoicedAmountCents, invoice.currency)}</span></p>
                <p className="mt-1 text-xs text-muted-foreground">{new Set(invoice.purchaseOrderIds).size > 1 ? "Shared invoice · " : ""}{relationshipLabel}</p>
              </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
