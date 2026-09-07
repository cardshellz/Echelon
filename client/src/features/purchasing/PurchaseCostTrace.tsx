import { PurchaseCostApplications, PurchaseReceiptCostQueue, type ReceiptCostActions } from "./PurchaseCostApplications";
import React from "react";
import { Link } from "wouter";
import { ArrowUpRight, Coins } from "lucide-react";
import type { PurchaseWorkspace, PurchaseWorkspaceRecord } from "@shared/procurement/purchase-workspace";
import type { PurchaseCostTrace as CostTrace } from "@shared/procurement/purchase-cost-trace";
import type { ProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatWorkspaceDate, formatWorkspaceMoney, formatWorkspaceMills, formatWorkspaceStatus } from "./purchase-workspace-format";

interface Props {
  data: PurchaseWorkspace;
  navigation: ProcurementNavigation;
  costActions?: ReceiptCostActions;
}

function SourceLink({ record, navigation, children }: { record: PurchaseWorkspaceRecord; navigation: ProcurementNavigation; children: React.ReactNode }) {
  return <Link href={navigation.inspectHref(record)} className="inline-flex max-w-full items-center gap-1 rounded-sm text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="min-w-0 break-words">{children}</span><ArrowUpRight className="h-3 w-3 shrink-0" aria-hidden="true" /></Link>;
}

function Amount({ label, value, currency, mills = false }: { label: string; value: number | null; currency: string | null; mills?: boolean }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words font-mono text-sm">{mills ? formatWorkspaceMills(value, currency) : formatWorkspaceMoney(value, currency)}</dd></div>;
}

function Issues({ issues }: { issues: string[] }) {
  return issues.length === 0 ? null : <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-300">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>;
}

function QuoteLine({ line, purchaseOrderId, navigation }: { line: CostTrace["purchaseLines"][number]; purchaseOrderId: number; navigation: ProcurementNavigation }) {
  return <details className="rounded-lg border p-3" data-testid={`cost-quote-${line.id}`}>
    <summary className="cursor-pointer text-sm font-medium">
      <span className="break-words">{line.sku ?? `Line #${line.id}`} · {formatWorkspaceStatus(line.lineType)}</span>
      <span className="mt-1 block text-xs font-normal text-muted-foreground">{line.orderedPieces === null ? "Non-product source line" : `${line.orderedPieces.toLocaleString()} pieces ordered`} · {formatWorkspaceStatus(line.status)}</span>
    </summary>
    <div className="mt-3 space-y-3">
      <SourceLink record={{ kind: "purchase", id: purchaseOrderId }} navigation={navigation}>Purchase line #{line.id}</SourceLink>
      <dl className="grid grid-cols-2 gap-3">
        <Amount label="Recorded product quote" value={line.productCents} currency={line.currency} />
        <Amount label="Recorded packaging quote" value={line.packagingCents} currency={line.currency} />
        <Amount label="Recorded discount" value={line.discountCents} currency={line.currency} />
        <Amount label="Recorded tax" value={line.taxCents} currency={line.currency} />
        <Amount label="Recorded line total" value={line.lineTotalCents} currency={line.currency} />
        <Amount label={line.orderedPieces === null ? "Recorded unit amount" : "Product per piece"} value={line.productUnitMills} currency={line.currency} mills />
      </dl>
      <p className="text-xs text-muted-foreground">Quote basis: {formatWorkspaceStatus(line.pricingBasis)} · Source: {formatWorkspaceStatus(line.pricingSource)}{line.quoteReference ? ` · Reference: ${line.quoteReference}` : " · Reference not recorded"}.</p>
      {line.pricingRemainderMills !== null && line.pricingRemainderMills !== 0 && <p className="text-xs text-muted-foreground">Recorded quote division remainder: {formatWorkspaceMills(line.pricingRemainderMills, line.currency)}. Extended quote totals remain separate from the rounded unit price.</p>}
      {line.orderedPieces !== null && <div className="space-y-2 rounded-md bg-muted/40 p-3">
        <p className="text-sm font-medium">{line.outstandingPieces === null ? "Unreceived quantity needs review" : `${line.outstandingPieces.toLocaleString()} pieces still expected`}</p>
        <p className="break-words text-xs">Unreceived product + packaging quote: {line.unreceivedQuoteCents === null ? "Not available" : `approximately ${formatWorkspaceMoney(line.unreceivedQuoteCents, line.currency)}`}</p>
        <p className="text-xs text-muted-foreground">Arrival: {formatWorkspaceDate(line.expectedArrivalDate)}{line.arrivalDateSource ? ` · ${formatWorkspaceStatus(line.arrivalDateSource)}` : ""}. This quote preview excludes freight, tax and discounts.</p>
      </div>}
      <Issues issues={line.issues} />
    </div>
  </details>;
}

function ShipmentCharge({ charge, data, navigation }: { charge: CostTrace["shipmentCharges"][number] } & Props) {
  const shipment = data.shipments.find((row) => row.id === charge.shipmentId);
  const invoice = data.invoices.find((row) => row.id === charge.invoiceId);
  return <details className="rounded-lg border p-3" data-testid={`cost-charge-${charge.id}`}>
    <summary className="cursor-pointer text-sm font-medium">
      <span className="break-words">{formatWorkspaceStatus(charge.costType)} · {shipment?.shipmentNumber ?? `Shipment #${charge.shipmentId}`}</span>
      <span className="mt-1 block text-xs font-normal text-muted-foreground">{charge.amountEvidence === "actual_recorded" ? "Actual amount recorded" : charge.amountEvidence === "estimated" ? "Estimate only" : "Amount not recorded"} · Entire shipment charge</span>
    </summary>
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap gap-3">
        <SourceLink record={{ kind: "shipment", id: charge.shipmentId }} navigation={navigation}>Shipment charge #{charge.id}</SourceLink>
        {invoice && <SourceLink record={{ kind: "invoice", id: invoice.id }} navigation={navigation}>Invoice {invoice.invoiceNumber}</SourceLink>}
      </div>
      {charge.description && <p className="break-words text-xs">{charge.description}</p>}
      <dl className="grid grid-cols-2 gap-3">
        <Amount label="Estimate" value={charge.estimatedCents} currency={charge.currency} />
        <Amount label="Actual recorded" value={charge.actualCents} currency={charge.currency} />
      </dl>
      <p className="text-xs text-muted-foreground">Recorded charge status: {formatWorkspaceStatus(charge.recordedStatus)}. Recorded exchange rate: {charge.exchangeRate ?? "Not recorded"}. This does not establish an applied inventory value.</p>
      <div className="border-t pt-3">
        <h5 className="text-xs font-semibold">Recorded allocations to this purchase</h5>
        {charge.allocations.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">No exact purchase-line allocation recorded. The entire charge is not assigned to this purchase.</p> : <ul className="mt-2 space-y-2">{charge.allocations.map((allocation) => <li key={allocation.id} className="space-y-1 text-xs">
          <p>PO line #{allocation.purchaseOrderLineId} · Shipment line #{allocation.shipmentLineId} · Allocation #{allocation.id}</p>
          <p className="break-words font-mono">{formatWorkspaceMoney(allocation.allocatedCents, allocation.currency)}</p>
          <p className="text-muted-foreground">Basis {allocation.basisValue ?? "unknown"} / {allocation.basisTotal ?? "unknown"}. Allocation source revision is not recorded.</p>
        </li>)}</ul>}
      </div>
    </div>
  </details>;
}

export function PurchaseReceiptCostLines({ trace, receiptId, navigation, data }: { trace: CostTrace; receiptId?: number } & Props) {
  const lines = trace.receiptLines.filter((line) => receiptId === undefined || line.receiptId === receiptId);
  return <div className="space-y-2">{lines.length === 0 ? <p className="text-xs text-muted-foreground">No exact purchase-line receipt cost evidence recorded.</p> : lines.map((line) => {
    const receipt = data.receipts.find((row) => row.id === line.receiptId);
    return <details key={line.id} className="rounded-lg border p-3" data-testid={`cost-receipt-${line.id}`}>
      <summary className="cursor-pointer text-sm font-medium">
        <span className="break-words">{receipt?.receiptNumber ?? `Receipt #${line.receiptId}`} · Line #{line.id}</span>
        <span className="mt-1 block text-xs font-normal text-muted-foreground">{line.lineageEvidence === "original_receipt_proven" ? "Original receipt link verified" : line.lineageEvidence === "awaiting_posting" ? "Awaiting original posting" : "Source review required"}</span>
      </summary>
      <div className="mt-3 space-y-3">
        <SourceLink record={{ kind: "receipt", id: line.receiptId }} navigation={navigation}>Receipt line #{line.id}</SourceLink>
        <p className="text-xs">PO line #{line.purchaseOrderLineId}{line.shipmentLineId === null ? " · Exact shipment line not recorded" : ` · Shipment line #${line.shipmentLineId}`}</p>
        <p className="text-xs">Recorded receive count: {line.receivedUnits.toLocaleString()} variant units · Reversed: {line.reversedUnits.toLocaleString()} units.</p>
        <p className="text-xs text-muted-foreground">{line.frozenPiecesPerUnit === null ? "Historical pieces per variant are unknown." : `Frozen receipt unit: ${line.frozenPiecesPerUnit.toLocaleString()} pieces per variant.`}</p>
        <Issues issues={line.issues} />
        {line.postings.map((posting) => <div key={posting.id} className="space-y-3 rounded-md bg-muted/30 p-3">
          <p className="text-xs font-semibold">Receipt transaction #{posting.id}{posting.voidedAt ? " · Voided" : ""} · {formatWorkspaceDate(posting.postedAt)}</p>
          {posting.lot === null ? <p className="text-xs text-muted-foreground">Original lot reference is unavailable.</p> : <>
            <p className="break-words text-sm font-medium">{posting.lot.lotNumber} · Lot #{posting.lot.id}</p>
            <p className="text-xs text-muted-foreground">Variant #{posting.lot.variantId} · Location #{posting.lot.locationId}. Current lot quantity: {posting.lot.onHandUnits.toLocaleString()} units; reserved {posting.lot.reservedUnits.toLocaleString()}, picked {posting.lot.pickedUnits.toLocaleString()}.</p>
            <dl className="grid grid-cols-2 gap-3">
              <Amount label="Current product / variant" value={posting.lot.productUnitMills} currency={posting.lot.currency} mills />
              <Amount label="Current packaging / variant" value={posting.lot.packagingUnitMills} currency={posting.lot.currency} mills />
              <Amount label="Current landed / variant" value={posting.lot.landedUnitMills} currency={posting.lot.currency} mills />
              <Amount label="Current total / variant" value={posting.lot.totalUnitMills} currency={posting.lot.currency} mills />
            </dl>
            <p className="text-xs text-muted-foreground">Recorded provisional flag: {posting.lot.recordedProvisional ? "Yes" : "No"}. Application snapshots and sold-cost outcomes are shown separately in the recorded cost history when available.</p>
          </>}
        </div>)}
      </div>
    </details>;
  })}</div>;
}

export function PurchaseCostTrace({ data, navigation, costActions }: Props) {
  const trace = data.costTrace;
  return <Card className="min-w-0" data-testid="purchase-cost-trace">
    <CardHeader className="space-y-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 font-semibold"><Coins className="h-4 w-4" aria-hidden="true" />Cost trace</h3><Badge variant="outline">{trace?.applicationEvidence === "recorded" ? "Revision history" : "Source preview"}</Badge></div>
      <p className="text-xs text-muted-foreground">Follow quote components, shipment charges and the original receipt lots. Open any source while keeping this purchase in view.</p>
    </CardHeader>
    <CardContent className="space-y-4 p-4 pt-0">
      {!trace ? <p className="text-xs text-muted-foreground">Detailed cost evidence is unavailable from this workspace response. Refresh after the cost workspace release is available.</p> : <>
        {trace.applicationEvidence === "not_verified" && <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-300">Cost application needs verification. Source records, shipment completion and a lot's provisional flag do not prove that every component reached inventory and sold-order COGS.</p>}
        {trace.applicationHistory && <PurchaseCostApplications history={trace.applicationHistory} data={data} navigation={navigation} />}
        {trace.receiptCostRequests && <PurchaseReceiptCostQueue requests={trace.receiptCostRequests} data={data} navigation={navigation} actions={costActions} />}
        <section className="space-y-2" aria-label="Purchase quote cost sources"><h4 className="text-sm font-semibold">Quote components and expected goods</h4>{trace.purchaseLines.length === 0 ? <p className="text-xs text-muted-foreground">No purchase cost lines recorded.</p> : trace.purchaseLines.map((line) => <QuoteLine key={line.id} line={line} purchaseOrderId={data.purchase.id} navigation={navigation} />)}</section>
        <section className="space-y-2" aria-label="Purchase invoice cost evidence">
          <h4 className="text-sm font-semibold">Invoice line evidence</h4>
          {trace.invoiceLines.length === 0 ? <p className="text-xs text-muted-foreground">No invoice lines explicitly linked to these purchase lines.</p> : trace.invoiceLines.map((line) => {
            const invoice = data.invoices.find((row) => row.id === line.invoiceId);
            return <details key={line.id} className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{invoice?.invoiceNumber ?? `Invoice #${line.invoiceId}`} · Line #{line.id}</summary><div className="mt-3 space-y-3">
              <SourceLink record={{ kind: "invoice", id: line.invoiceId }} navigation={navigation}>Invoice line #{line.id}</SourceLink>
              <p className="text-xs">PO line #{line.purchaseOrderLineId} · {line.quantity.toLocaleString()} recorded invoice units · Match: {formatWorkspaceStatus(line.matchStatus)}</p>
              <dl className="grid grid-cols-2 gap-3"><Amount label="Recorded line amount" value={line.lineTotalCents} currency={invoice?.currency ?? null} /><Amount label="Recorded unit amount" value={line.unitCostMills} currency={invoice?.currency ?? null} mills /></dl>
              {line.components && <dl className="grid grid-cols-2 gap-3"><Amount label="Recorded product component" value={line.components.productMills} currency={invoice?.currency ?? null} mills /><Amount label="Recorded packaging component" value={line.components.packagingMills} currency={invoice?.currency ?? null} mills /><Amount label="Recorded adjustment" value={line.components.adjustmentMills} currency={invoice?.currency ?? null} mills /></dl>}
              <p className="text-xs text-muted-foreground">{line.componentEvidence === "unclassified" ? "Product and packaging composition is unclassified." : line.componentEvidence === "explicit_recorded" ? `Explicit component evidence recorded; packaging is ${formatWorkspaceStatus(line.components?.packagingTreatment ?? null)}.` : "Invoice component evidence needs review."} This invoice total is not added to the quote or shipment amounts.</p>
              <Issues issues={line.componentIssues ?? []} />
            </div></details>;
          })}
        </section>
        <section className="space-y-2" aria-label="Shipment charge cost evidence"><h4 className="text-sm font-semibold">Shipment charges and allocations</h4>{trace.shipmentCharges.length === 0 ? <p className="text-xs text-muted-foreground">No shipment charge sources recorded.</p> : trace.shipmentCharges.map((charge) => <ShipmentCharge key={charge.id} charge={charge} data={data} navigation={navigation} />)}</section>
        <section className="space-y-2" aria-label="Original receipt cost evidence"><h4 className="text-sm font-semibold">Original receipt lots</h4><PurchaseReceiptCostLines trace={trace} data={data} navigation={navigation} /></section>
        <details className="border-t pt-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">Cost evidence scope</summary><ul className="mt-2 list-disc space-y-2 pl-4">{trace.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></details>
      </>}
    </CardContent>
  </Card>;
}
