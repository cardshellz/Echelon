import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  DollarSign,
  FileText,
  Mail,
  Package,
  Pencil,
  Plus,
  Send,
  Ship,
  Truck,
  AlertTriangle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  computePoLinearStageStates,
  computeShipmentDeliverySteps,
  type PoLinearStageState,
} from "@/features/purchasing/po-linear-workspace-helpers";
import type { usePoFinancialEvidence } from "@/features/purchasing/PoFinancialEvidence";
import type { usePoShipmentCosts } from "@/features/purchasing/use-po-shipment-costs";
import type { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { useToast } from "@/hooks/use-toast";
import { financialCommandFetchJson } from "@/lib/financial-command";
import { apiRequest } from "@/lib/queryClient";
import {
  formatLandedCostPerPiece,
  projectPoLineLandedCosts,
} from "@shared/procurement/po-line-landed-cost";
import type { PurchaseLineShipping } from "@shared/procurement/purchase-line-shipping";
import { formatIntegerCents } from "@shared/utils/format-integer-cents";
import { formatCents, formatLineUnitCost } from "./po-detail-types-and-helpers";

interface RelatedShipmentItem {
  id: number;
  number: string;
  status: string;
}

interface RelatedReceiptItem {
  id: number;
  number: string;
  status: string;
}

export interface PoLinearLifecycleStagesProps {
  po: any;
  poId: number;
  lines: any[];
  shippingByLine: Map<number, PurchaseLineShipping>;
  linkedShipments: RelatedShipmentItem[];
  linkedReceipts: RelatedReceiptItem[];
  invoices: any[];
  financialEvidence: ReturnType<typeof usePoFinancialEvidence>;
  financialCompletionSupported: boolean;
  financialReviewRequired: boolean;
  shipmentCosts: ReturnType<typeof usePoShipmentCosts>;
  procurementNavigation: ReturnType<typeof useProcurementNavigation>;
  setActiveTab: (tab: string) => void;
  // Permissions & capability gates
  canEditHeader: boolean;
  canCreatePurchasing: boolean;
  hasPurchasingEdit: boolean;
  isSoloMode: boolean;
  useNewPoEditor: boolean;
  canSendPoToVendor: boolean;
  entryBlocked: boolean;
  canPreparePurchaseEntry: boolean;
  sendToVendorPending: boolean;
  onSendToVendor: () => void;
  canSendPo: boolean;
  onOpenEmailDialog: () => void;
  canAcknowledgePo: boolean;
  onOpenAckDialog: () => void;
  canMarkPoShipped: boolean;
  markShippedPending: boolean;
  onMarkShipped: () => void;
  canMarkPoInTransit: boolean;
  markInTransitPending: boolean;
  onMarkInTransit: () => void;
  canMarkPoArrived: boolean;
  markArrivedPending: boolean;
  onMarkArrived: () => void;
  onOpenCreateShipmentDialog: () => void;
  canCreateReceiptForPo: boolean;
  onOpenReceivePicker: () => void;
  onOpenCreateInvoiceDialog: () => Promise<void>;
}

function stageBadgeStyles(state: PoLinearStageState): string {
  switch (state) {
    case "done":
      return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300";
    case "current":
      return "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300";
    case "attention":
      return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
    case "upcoming":
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

function StageStateIcon({ state }: { state: PoLinearStageState }) {
  if (state === "done") return <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" aria-hidden="true" />;
  if (state === "attention") return <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" aria-hidden="true" />;
  if (state === "current") return <div className="h-3.5 w-3.5 rounded-full bg-blue-600 ring-4 ring-blue-600/20 shrink-0" aria-hidden="true" />;
  return <Circle className="h-4 w-4 text-muted-foreground/50 shrink-0" aria-hidden="true" />;
}

export function PoLinearLifecycleStages(props: PoLinearLifecycleStagesProps) {
  const {
    po,
    poId,
    lines,
    shippingByLine,
    linkedShipments,
    linkedReceipts,
    invoices,
    financialEvidence,
    financialCompletionSupported,
    financialReviewRequired,
    shipmentCosts,
    procurementNavigation,
    setActiveTab,
    canEditHeader,
    canCreatePurchasing,
    hasPurchasingEdit,
    isSoloMode,
    useNewPoEditor,
    canSendPoToVendor,
    entryBlocked,
    canPreparePurchaseEntry,
    sendToVendorPending,
    onSendToVendor,
    canSendPo,
    onOpenEmailDialog,
    canAcknowledgePo,
    onOpenAckDialog,
    canMarkPoShipped,
    markShippedPending,
    onMarkShipped,
    canMarkPoInTransit,
    markInTransitPending,
    onMarkInTransit,
    canMarkPoArrived,
    markArrivedPending,
    onMarkArrived,
    onOpenCreateShipmentDialog,
    canCreateReceiptForPo,
    onOpenReceivePicker,
    onOpenCreateInvoiceDialog,
  } = props;

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [linesExpanded, setLinesExpanded] = useState(() => lines.length <= 8);
  const [fastForwardingShipmentId, setFastForwardingShipmentId] = useState<number | null>(null);

  const totalOrderedPieces = lines.reduce(
    (sum: number, l: any) => sum + (Number(shippingByLine.get(l.id)?.line.orderedPieces ?? l.orderQty) || 0),
    0,
  );
  const totalReceivedPieces = lines.reduce(
    (sum: number, l: any) => sum + (Number(shippingByLine.get(l.id)?.line.receivedPieces ?? l.receivedQty) || 0),
    0,
  );
  const activeShipments = linkedShipments.filter((s) => s.status !== "cancelled");
  const allShipmentsDeliveredOrLater =
    activeShipments.length > 0 &&
    activeShipments.every((s) => ["delivered", "costing", "closed"].includes(s.status));

  const activeInvoices = invoices.filter((inv: any) => inv.status !== "voided");
  const stages = computePoLinearStageStates({
    poStatus: po.status,
    physicalStatus: po.physicalStatus,
    linesCount: lines.length,
    totalOrderedPieces,
    totalReceivedPieces,
    linkedShipmentsCount: activeShipments.length,
    allShipmentsDeliveredOrLater,
    financialCompletionSupported,
    financialReviewRequired,
    linkedInvoicesCount: activeInvoices.length,
    inventoryCostingStatus: shipmentCosts.data?.summary.inventoryCosting,
    costReviewLinesCount: shipmentCosts.data?.summary.reviewLines ?? 0,
    unallocatedChargeCount: shipmentCosts.data?.summary.unallocatedChargeCount ?? 0,
  });

  const stageMap = new Map(stages.map((s) => [s.id, s]));
  const landedCosts = projectPoLineLandedCosts({ poHeader: po, poLines: lines, costs: shipmentCosts.data });
  const landedByLine = new Map(
    landedCosts.status === "complete"
      ? landedCosts.lines.map((line) => [line.purchaseOrderLineId, line])
      : [],
  );
  const currency = shipmentCosts.data?.summary.currency ?? po.currency ?? "USD";

  const openDraftOrActiveReceipts = linkedReceipts.filter((r) => ["draft", "open"].includes(r.status));
  const receivePct =
    totalOrderedPieces > 0
      ? Math.min(100, Math.round((totalReceivedPieces / totalOrderedPieces) * 100))
      : 0;

  async function fastForwardShipmentDelivered(shipment: RelatedShipmentItem) {
    if (!hasPurchasingEdit || fastForwardingShipmentId !== null) return;
    const steps = computeShipmentDeliverySteps(shipment.status);
    if (steps.length === 0) return;
    setFastForwardingShipmentId(shipment.id);
    try {
      for (const endpoint of steps) {
        if (endpoint === "book" || endpoint === "in-transit") {
          await financialCommandFetchJson(`/api/inbound-shipments/${shipment.id}/${endpoint}`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
        } else {
          await apiRequest("POST", `/api/inbound-shipments/${shipment.id}/${endpoint}`, {});
        }
      }
      await Promise.all([
        queryClient.invalidateQueries({
          predicate: (q) =>
            typeof q.queryKey[0] === "string" &&
            (q.queryKey[0].startsWith(`/api/purchase-orders/${poId}`) ||
              q.queryKey[0].startsWith(`/api/inbound-shipments/${shipment.id}`) ||
              q.queryKey[0] === "/api/inbound-shipments"),
        }),
      ]);
      toast({
        title: "Shipment marked delivered",
        description: `${shipment.number} is now at dock and ready for receiving.`,
      });
    } catch (err: any) {
      toast({
        title: "Could not advance shipment automatically",
        description: err?.message || "Open the shipment to check line setup or measurements.",
        variant: "destructive",
      });
    } finally {
      setFastForwardingShipmentId(null);
    }
  }

  return (
    <div className="space-y-3 min-w-0" data-testid="po-linear-lifecycle">
      {/* Compact 5-Stage Linear Stepper Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {stages.map((stage) => (
          <a
            key={stage.id}
            href={`#po-stage-${stage.id}`}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors hover:bg-muted/50 min-w-0 ${
              stage.state === "current"
                ? "border-blue-400 bg-blue-50/40 dark:bg-blue-950/20"
                : stage.state === "attention"
                  ? "border-amber-400 bg-amber-50/40 dark:bg-amber-950/20"
                  : "bg-card"
            }`}
          >
            <StageStateIcon state={stage.state} />
            <div className="min-w-0">
              <div className="font-semibold truncate">
                {stage.stepNumber}. {stage.title}
              </div>
              <div className="text-[11px] text-muted-foreground truncate">{stage.badgeLabel}</div>
            </div>
          </a>
        ))}
      </div>

      {/* STAGE 1: ORDER & QUOTE + INLINE LINES */}
      <Card id="po-stage-order" data-testid="po-stage-order" className="min-w-0">
        <CardContent className="p-4 space-y-3 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <StageStateIcon state={stageMap.get("order")!.state} />
              <span className="font-semibold text-sm">1. Order &amp; Supplier Dispatch</span>
              <Badge variant="outline" className={`text-xs ${stageBadgeStyles(stageMap.get("order")!.state)}`}>
                {stageMap.get("order")!.badgeLabel}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {lines.length} line{lines.length === 1 ? "" : "s"} · {totalOrderedPieces.toLocaleString()} pcs ordered
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canEditHeader && po.status === "draft" && useNewPoEditor && (
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/purchase-orders/${poId}/edit`}>
                    <Pencil className="h-3.5 w-3.5 mr-1.5" />
                    Edit Lines in Composer
                  </Link>
                </Button>
              )}
              {canSendPoToVendor && po.status === "draft" && isSoloMode && (
                <Button
                  size="sm"
                  onClick={onSendToVendor}
                  disabled={entryBlocked || !canPreparePurchaseEntry || sendToVendorPending}
                >
                  <Send className="h-3.5 w-3.5 mr-1.5" />
                  {sendToVendorPending ? "Preparing..." : "Prepare & Review PO"}
                </Button>
              )}
              {canSendPo && po.status === "approved" && (
                <Button size="sm" onClick={onOpenEmailDialog}>
                  <Mail className="h-3.5 w-3.5 mr-1.5" />
                  Email PO &amp; Mark Sent
                </Button>
              )}
              {canAcknowledgePo && (
                <Button size="sm" variant="outline" onClick={onOpenAckDialog}>
                  Record Vendor Ack
                </Button>
              )}
              {lines.length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-xs"
                  onClick={() => setLinesExpanded((prev) => !prev)}
                >
                  {linesExpanded ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5 mr-1" />
                      Hide items
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5 mr-1" />
                      Show {lines.length} items
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>

          {linesExpanded && lines.length > 0 && (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30">
                    <TableHead className="text-xs">SKU / Item</TableHead>
                    <TableHead className="text-right text-xs">Ordered</TableHead>
                    <TableHead className="text-right text-xs">Received</TableHead>
                    <TableHead className="text-right text-xs">Quote / pc</TableHead>
                    <TableHead className="text-right text-xs">Landed / pc</TableHead>
                    <TableHead className="text-right text-xs">Supplier Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line: any) => {
                    const shipInfo = shippingByLine.get(line.id);
                    const ordered = Number(shipInfo?.line.orderedPieces ?? line.orderQty) || 0;
                    const received = Number(shipInfo?.line.receivedPieces ?? line.receivedQty) || 0;
                    const landedLine = landedByLine.get(line.id);
                    const landedUnitDisplay = landedLine
                      ? (formatLandedCostPerPiece(landedLine.totalCents, landedLine.pieces, currency) ?? "—")
                      : "—";
                    return (
                      <TableRow key={line.id}>
                        <TableCell className="py-2 max-w-[240px]">
                          <div className="font-mono text-xs font-medium truncate">{line.sku || line.lineType || "—"}</div>
                          <div className="text-xs text-muted-foreground truncate">{line.productName || line.description || "—"}</div>
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-xs tabular-nums">
                          {ordered.toLocaleString()}
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-xs tabular-nums">
                          <span className={received >= ordered && ordered > 0 ? "text-emerald-600 font-medium" : ""}>
                            {received.toLocaleString()}
                          </span>
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-xs tabular-nums">
                          {formatLineUnitCost(line)}
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-xs tabular-nums font-medium">
                          {landedUnitDisplay}
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-xs tabular-nums">
                          {formatCents(line.lineTotalCents)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* STAGE 2 & 3 SIDE-BY-SIDE ON WIDE SCREENS, LINEAR STACK ON COMPACT */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 min-w-0">
        {/* STAGE 2: DEPOSITS, BILLS & PAYMENTS */}
        <Card id="po-stage-bills" data-testid="po-stage-bills" className="min-w-0">
          <CardContent className="p-4 space-y-3 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <StageStateIcon state={stageMap.get("bills")!.state} />
                <span className="font-semibold text-sm">2. Deposits, Bills &amp; Payments</span>
                <Badge variant="outline" className={`text-xs ${stageBadgeStyles(stageMap.get("bills")!.state)}`}>
                  {stageMap.get("bills")!.badgeLabel}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canCreatePurchasing &&
                  ["approved", "sent", "acknowledged", "partially_received", "received", "closed"].includes(po.status) && (
                    <Button size="sm" variant="outline" onClick={() => void onOpenCreateInvoiceDialog()}>
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Record Vendor Bill
                    </Button>
                  )}
                <Button size="sm" variant="ghost" className="text-xs" asChild>
                  <Link href="/purchasing/bills">Bills Hub →</Link>
                </Button>
              </div>
            </div>

            {financialEvidence.isSuccess && financialEvidence.data.state === "complete" && (
              <div className="grid grid-cols-3 gap-2 rounded-md bg-muted/40 p-2.5 text-xs">
                <div>
                  <div className="text-muted-foreground">Billed to PO</div>
                  <div className="font-mono font-semibold mt-0.5">
                    {financialEvidence.data.invoicedAmountCents != null
                      ? formatIntegerCents(financialEvidence.data.invoicedAmountCents, financialEvidence.data.currency)
                      : "Unknown"}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Paid / Settled</div>
                  <div className="font-mono font-semibold text-emerald-700 dark:text-emerald-400 mt-0.5">
                    {financialEvidence.data.settledAmountCents != null
                      ? formatIntegerCents(financialEvidence.data.settledAmountCents, financialEvidence.data.currency)
                      : "Unknown"}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Remaining</div>
                  <div className="font-mono font-semibold mt-0.5">
                    {financialEvidence.data.outstandingAmountCents != null
                      ? formatIntegerCents(financialEvidence.data.outstandingAmountCents, financialEvidence.data.currency)
                      : "Unknown"}
                  </div>
                </div>
              </div>
            )}

            {activeInvoices.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No vendor bills recorded yet. Record a deposit or supplier invoice whenever ready—before or after receiving.
              </p>
            ) : (
              <div className="space-y-1.5">
                {activeInvoices.slice(0, 4).map((inv: any) => (
                  <div
                    key={inv.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="font-mono font-medium truncate">{inv.invoiceNumber}</span>
                      <Badge variant="outline" className="text-[11px] capitalize">
                        {(inv.status || "").replace(/_/g, " ")}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono">
                        {formatCents(inv.invoicedAmountCents)}
                        {Number(inv.balanceCents) > 0 && (
                          <span className="text-muted-foreground ml-1">
                            (due {formatCents(inv.balanceCents)})
                          </span>
                        )}
                      </span>
                      <Link
                        href={procurementNavigation.childHref(`/ap-invoices/${inv.id}`)}
                        className="font-medium text-primary hover:underline"
                      >
                        {Number(inv.balanceCents) > 0 ? "Open / Pay Bill →" : "Open Bill →"}
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* STAGE 3: SHIPPING, CONTAINER & FREIGHT / DUTY COSTS */}
        <Card id="po-stage-shipping" data-testid="po-stage-shipping" className="min-w-0">
          <CardContent className="p-4 space-y-3 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <StageStateIcon state={stageMap.get("shipping")!.state} />
                <span className="font-semibold text-sm">3. Shipping &amp; Freight / Duty</span>
                <Badge variant="outline" className={`text-xs ${stageBadgeStyles(stageMap.get("shipping")!.state)}`}>
                  {stageMap.get("shipping")!.badgeLabel}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {canMarkPoShipped && (
                  <Button size="sm" variant="outline" onClick={onMarkShipped} disabled={markShippedPending}>
                    <Truck className="h-3.5 w-3.5 mr-1" />
                    Mark PO Shipped
                  </Button>
                )}
                {canMarkPoInTransit && (
                  <Button size="sm" variant="outline" onClick={onMarkInTransit} disabled={markInTransitPending}>
                    <Ship className="h-3.5 w-3.5 mr-1" />
                    Mark PO In Transit
                  </Button>
                )}
                {canMarkPoArrived && (
                  <Button size="sm" variant="outline" onClick={onMarkArrived} disabled={markArrivedPending}>
                    <Package className="h-3.5 w-3.5 mr-1" />
                    Mark Arrived at Dock
                  </Button>
                )}
                {hasPurchasingEdit && lines.length > 0 && !["closed", "cancelled"].includes(po.status) && (
                  <Button size="sm" variant="outline" onClick={onOpenCreateShipmentDialog}>
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Create Inbound Shipment
                  </Button>
                )}
              </div>
            </div>

            {activeShipments.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Ship direct on this PO (edit supplier freight/tax in the cards above) or create an Inbound Shipment to split container freight, customs duties, and brokerage across SKUs or multiple POs.
              </p>
            ) : (
              <div className="space-y-1.5">
                {activeShipments.map((shipment) => {
                  const canFastForward =
                    hasPurchasingEdit &&
                    ["booked", "in_transit", "at_port", "customs_clearance"].includes(shipment.status);
                  const isAdvancing = fastForwardingShipmentId === shipment.id;
                  return (
                    <div
                      key={shipment.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Ship className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <Link
                          href={procurementNavigation.childHref(`/shipments/${shipment.id}`)}
                          className="font-mono font-medium text-primary hover:underline truncate"
                        >
                          {shipment.number}
                        </Link>
                        <Badge variant="outline" className="text-[11px] capitalize">
                          {shipment.status.replace(/_/g, " ")}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {canFastForward && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            disabled={fastForwardingShipmentId !== null}
                            onClick={() => void fastForwardShipmentDelivered(shipment)}
                          >
                            {isAdvancing ? "Advancing..." : "Mark Shipment Delivered"}
                          </Button>
                        )}
                        <Link
                          href={procurementNavigation.childHref(`/shipments/${shipment.id}?tab=costs`)}
                          className="font-medium text-primary hover:underline"
                        >
                          + Freight / Duty Bills
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* STAGE 4 & 5 SIDE-BY-SIDE ON WIDE SCREENS, LINEAR STACK ON COMPACT */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 min-w-0">
        {/* STAGE 4: DOCK RECEIVING */}
        <Card id="po-stage-receiving" data-testid="po-stage-receiving" className="min-w-0">
          <CardContent className="p-4 space-y-3 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <StageStateIcon state={stageMap.get("receiving")!.state} />
                <span className="font-semibold text-sm">4. Dock Receiving</span>
                <Badge variant="outline" className={`text-xs ${stageBadgeStyles(stageMap.get("receiving")!.state)}`}>
                  {stageMap.get("receiving")!.badgeLabel}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {openDraftOrActiveReceipts.length === 1 && (
                  <Button size="sm" variant="default" asChild>
                    <Link href={procurementNavigation.childHref(`/receiving?open=${openDraftOrActiveReceipts[0].id}`)}>
                      <Truck className="h-3.5 w-3.5 mr-1.5" />
                      Resume Receipt {openDraftOrActiveReceipts[0].number}
                    </Link>
                  </Button>
                )}
                {canCreateReceiptForPo && (
                  <Button
                    size="sm"
                    variant={openDraftOrActiveReceipts.length === 1 ? "outline" : "default"}
                    onClick={onOpenReceivePicker}
                  >
                    <Truck className="h-3.5 w-3.5 mr-1.5" />
                    Start / Continue Receiving
                  </Button>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  Received <strong>{totalReceivedPieces.toLocaleString()}</strong> of{" "}
                  <strong>{totalOrderedPieces.toLocaleString()}</strong> pieces
                </span>
                <span className="font-mono font-medium">{receivePct}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-600 transition-all"
                  style={{ width: `${receivePct}%` }}
                />
              </div>
            </div>

            {linkedReceipts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {linkedReceipts.map((rcpt) => (
                  <Link
                    key={rcpt.id}
                    href={procurementNavigation.childHref(`/receiving?open=${rcpt.id}`)}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-muted/50"
                  >
                    <span className="font-mono font-medium text-primary">{rcpt.number}</span>
                    <span className="text-muted-foreground capitalize">({rcpt.status.replace(/_/g, " ")})</span>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* STAGE 5: LANDED COGS SUMMARY */}
        <Card id="po-stage-cogs" data-testid="po-stage-cogs" className="min-w-0">
          <CardContent className="p-4 space-y-3 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <StageStateIcon state={stageMap.get("cogs")!.state} />
                <span className="font-semibold text-sm">5. Landed Cost &amp; FIFO COGS</span>
                <Badge variant="outline" className={`text-xs ${stageBadgeStyles(stageMap.get("cogs")!.state)}`}>
                  {stageMap.get("cogs")!.badgeLabel}
                </Badge>
              </div>
              {(shipmentCosts.data?.summary.reviewLines ?? 0) > 0 && (
                <Button size="sm" variant="outline" onClick={() => setActiveTab("lines")}>
                  <DollarSign className="h-3.5 w-3.5 mr-1" />
                  Review Landed Cost Tasks
                </Button>
              )}
            </div>

            {shipmentCosts.data ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-md bg-muted/40 p-2.5 text-xs">
                <div>
                  <div className="text-muted-foreground">Supplier PO</div>
                  <div className="font-mono font-semibold mt-0.5">
                    {formatIntegerCents(shipmentCosts.data.summary.poAmountCents, currency)}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Freight</div>
                  <div className="font-mono font-semibold mt-0.5">
                    {shipmentCosts.data.totals.freightCents != null
                      ? formatIntegerCents(shipmentCosts.data.totals.freightCents, currency)
                      : "Incomplete"}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Duties &amp; Tax</div>
                  <div className="font-mono font-semibold mt-0.5">
                    {shipmentCosts.data.totals.dutyCents != null
                      ? formatIntegerCents(shipmentCosts.data.totals.dutyCents, currency)
                      : "Incomplete"}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Total Landed</div>
                  <div className="font-mono font-bold text-primary mt-0.5">
                    {shipmentCosts.data.totals.combinedCostCents != null
                      ? formatIntegerCents(shipmentCosts.data.totals.combinedCostCents, currency)
                      : "Incomplete"}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Landed cost totals combine supplier quotes, freight, duties, and any post-receipt invoice updates into FIFO inventory lots.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
