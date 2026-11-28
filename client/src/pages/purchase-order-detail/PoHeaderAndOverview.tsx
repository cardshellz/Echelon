import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Ban,
  Check,
  CheckCircle,
  Clock,
  FileText,
  Package,
  Pencil,
  Printer,
  RotateCcw,
  Send,
  Ship,
  Truck,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SupplierHeaderCosts } from "@/features/purchasing/SupplierHeaderCosts";
import { PurchaseOrderStatusBadge } from "@/features/purchasing/PurchaseOrderStatusBadge";
import { PoShipmentCostSummary } from "@/features/purchasing/PoShipmentCostSummary";
import { PurchaseTaxReview } from "@/features/purchasing/PurchaseTaxReview";
import { PoFinancialEvidence, type usePoFinancialEvidence } from "@/features/purchasing/PoFinancialEvidence";
import type { usePoShipmentCosts } from "@/features/purchasing/use-po-shipment-costs";
import { PoQuantityAmendment } from "@/features/purchasing/PoQuantityAmendment";
import type { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { useToast } from "@/hooks/use-toast";
import { evaluateDollarInput } from "@/lib/exact-money-input";
import { formatProcurementScheduleDate } from "@/lib/procurement-schedule-date";
import { resolveCurrentPhysicalStatus } from "@shared/procurement/purchase-order-status";
import { formatIntegerCents } from "@shared/utils/format-integer-cents";
import {
  AUTO_DRAFT_SEVERITY_STYLES,
  AUTO_DRAFT_STEP_STYLES,
  type AutoDraftActionPlan,
  FINANCIAL_LABELS,
  FINANCIAL_TRACK_STAGES,
  firstHistoryAt,
  formatActor,
  formatCents,
  INCOTERMS_CHARGES,
  INCOTERMS_LIST,
  PHYSICAL_LABELS,
  PHYSICAL_TRACK_STAGES,
  type RelatedUsersMap,
  type StageTooltipInfo,
  stageState,
} from "./po-detail-types-and-helpers";

/** A dot-and-connector timeline for one track */
function TrackTimeline({
  stages,
  currentStatus,
  isWarn,
  timestamps,
}: {
  stages: readonly string[];
  currentStatus: string;
  isWarn?: boolean;
  // Map of stage name -> rich tooltip info. Stages absent from the map use
  // the default state-derived label.
  timestamps?: Record<string, StageTooltipInfo | undefined>;
}) {
  const effectiveStatus =
    currentStatus === "disputed" ? "partially_paid" : currentStatus;
  const currentIdx = stages.indexOf(effectiveStatus);

  return (
    <div className="flex items-center gap-0">
      {stages.map((stage, i) => {
        const state = stageState(i, currentIdx, !!(isWarn && i === currentIdx));
        const dotClass =
          state === "done"
            ? "bg-green-600 border-green-600"
            : state === "current"
            ? "bg-blue-600 border-blue-600"
            : state === "warn"
            ? "bg-amber-500 border-amber-500"
            : "bg-background border-border";
        // Connector lights up green up to AND INCLUDING the in-stage
        // (since that stage is now considered done under the new
        // convention). Connectors past the in-stage stay gray.
        const connectorClass =
          i <= currentIdx ? "bg-green-600" : "bg-border";
        const info = timestamps?.[stage];
        const ts = info?.ts ?? null;
        const extras = (info?.extra ?? []).filter(
          (s): s is string => typeof s === "string" && s.length > 0,
        );
        const stageLabel =
          PHYSICAL_LABELS[stage] ?? FINANCIAL_LABELS[stage] ?? stage;

        // Tooltip headline: state-aware. Body lines append timestamp + extras.
        const headline =
          state === "done"
            ? `${stageLabel} — completed`
            : state === "current"
            ? `${stageLabel} — in progress (next action)`
            : state === "warn"
            ? `${stageLabel} — needs attention`
            : `${stageLabel} — not yet reached`;
        const lines: string[] = [headline];
        if (ts) lines.push(new Date(ts).toLocaleString());
        for (const e of extras) lines.push(e);

        // aria-label collapses to a single string; tooltip renders multi-line.
        const ariaLabel = lines.join(". ");
        return (
          <div key={stage} className="flex items-center">
            <div className="relative flex flex-col items-center">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={ariaLabel}
                    className={`w-3 h-3 rounded-full border-2 ${dotClass} cursor-help block`}
                  />
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} className="text-xs max-w-xs">
                  {/*
                    Tooltip surface is dark (primary bg + primary-foreground).
                    The default `text-muted-foreground` was rendering as dim
                    grey-on-blue and effectively unreadable. Use a translucent
                    primary-foreground for the secondary lines so they stay
                    distinguishable from the headline without losing contrast.
                  */}
                  <div className="font-medium">{lines[0]}</div>
                  {lines.slice(1).map((line, idx) => (
                    <div
                      key={idx}
                      className="text-primary-foreground/85"
                    >
                      {line}
                    </div>
                  ))}
                </TooltipContent>
              </Tooltip>
              <span className="text-[9px] text-muted-foreground mt-0.5 whitespace-nowrap">
                {stageLabel}
              </span>
            </div>
            {i < stages.length - 1 && (
              <div className={`w-6 h-0.5 ${connectorClass} -mt-3`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The two-row dual-track header card */
export function DualTrackHeader({
  po,
  history = [],
}: {
  po: any;
  history?: Array<{ toStatus?: string; changedAt?: string | null }>;
}) {
  const isCancelled = po.physicalStatus === "cancelled" || po.physicalStatus === "short_closed";

  // physical summary text
  const totalOrderQty: number = (po.lines ?? []).reduce(
    (s: number, l: any) => s + (Number(l.orderQty) || 0),
    0,
  );
  const totalReceivedQty: number = (po.lines ?? []).reduce(
    (s: number, l: any) => s + (Number(l.receivedQty) || 0),
    0,
  );
  let physicalSummary: React.ReactNode;
  if (isCancelled) {
    physicalSummary = <span className="text-red-600 font-medium">Cancelled</span>;
  } else if (po.physicalStatus === "received") {
    physicalSummary = <span className="text-green-600 font-medium">All received</span>;
  } else {
    physicalSummary = (
      <>
        <strong>{totalReceivedQty.toLocaleString()}</strong> of{" "}
        <strong>{totalOrderQty.toLocaleString()}</strong> pcs received
      </>
    );
  }

  // This legacy track records linked invoice status. Its cached whole-invoice
  // totals cannot establish this PO's share; the evidence card owns amounts.
  const financialSummary = FINANCIAL_LABELS[po.financialStatus] ?? "Not recorded";

  const inTransitAt = firstHistoryAt(history, ["in_transit"]);
  const receivingAt = firstHistoryAt(history, ["receiving", "partially_received"]);
  const receivedAt = firstHistoryAt(history, ["received"]);

  const cancelledAt: string | null = po.cancelledAt ?? null;
  const cancelReason: string | null = po.cancelReason ?? null;
  const relatedUsers: RelatedUsersMap | undefined = (po as any).relatedUsers;
  const cancelledByFormatted = formatActor((po as any).cancelledBy, relatedUsers);
  const cancelExtras = (stageReachedAt: string | null | undefined): string[] => {
    if (!isCancelled || !cancelledAt) return [];
    const reached = !!stageReachedAt && new Date(stageReachedAt) <= new Date(cancelledAt);
    const cancelledByPart = (po as any).cancelledBy ? ` by ${cancelledByFormatted}` : "";
    if (reached) {
      return [
        `✅ Reached before cancellation (cancelled ${new Date(cancelledAt).toLocaleString()}${cancelledByPart})`,
        cancelReason ? `Reason: ${cancelReason}` : "",
      ];
    }
    return [
      `⛔ Not reached — PO cancelled ${new Date(cancelledAt).toLocaleString()}${cancelledByPart}`,
      cancelReason ? `Reason: ${cancelReason}` : "",
    ];
  };

  const physTimestamps: Record<string, StageTooltipInfo | undefined> = {
    draft: {
      ts: po.createdAt,
      extra: [
        po.createdBy ? `Created by ${formatActor(po.createdBy, relatedUsers)}` : null,
        ...cancelExtras(po.createdAt),
      ],
    },
    sent: {
      ts: po.sentToVendorAt,
      extra: [
        po.vendor?.name ? `Sent to ${po.vendor.name}` : null,
        ...cancelExtras(po.sentToVendorAt),
      ],
    },
    acknowledged: {
      ts: po.vendorAckDate,
      extra: [
        "Vendor confirmed receipt of PO",
        ...cancelExtras(po.vendorAckDate),
      ],
    },
    shipped: {
      ts: po.firstShippedAt,
      extra: ["Goods left vendor", ...cancelExtras(po.firstShippedAt)],
    },
    in_transit: {
      ts: inTransitAt,
      extra: ["Goods en route", ...cancelExtras(inTransitAt)],
    },
    arrived: {
      ts: po.firstArrivedAt,
      extra: ["Goods at our dock", ...cancelExtras(po.firstArrivedAt)],
    },
    receiving: {
      ts: receivingAt,
      extra: [
        totalOrderQty > 0
          ? `${totalReceivedQty.toLocaleString()} of ${totalOrderQty.toLocaleString()} pcs received so far`
          : null,
        ...cancelExtras(receivingAt),
      ],
    },
    received: {
      ts: receivedAt,
      extra: [
        totalOrderQty > 0
          ? `${totalReceivedQty.toLocaleString()} of ${totalOrderQty.toLocaleString()} pcs received`
          : null,
        ...cancelExtras(receivedAt),
      ],
    },
  };

  const finTimestamps: Record<string, StageTooltipInfo | undefined> = {
    unbilled: {
      extra: ["No linked invoice recorded"],
    },
    invoiced: {
      ts: po.firstInvoicedAt,
      extra: [
        "Linked invoices recorded",
        ...cancelExtras(po.firstInvoicedAt),
      ],
    },
    partially_paid: {
      ts: po.firstPaidAt,
      extra: [
        "Payment recorded against linked invoices",
        ...cancelExtras(po.firstPaidAt),
      ],
    },
    paid: {
      ts: po.fullyPaidAt,
      extra: [
        "Linked invoices recorded as paid",
        ...cancelExtras(po.fullyPaidAt),
      ],
    },
  };

  const finWarn = po.financialStatus === "disputed";

  return (
    <TooltipProvider delayDuration={150} skipDelayDuration={50}>
      <div className="rounded-lg border bg-card p-4 space-y-3">
        {/* Physical track */}
        <div className="flex items-start gap-4">
          <span className="w-20 shrink-0 text-xs font-semibold text-muted-foreground uppercase tracking-wide mt-1">
            Physical
          </span>
          <div className="flex-1 overflow-x-auto">
            <TrackTimeline
              stages={PHYSICAL_TRACK_STAGES}
              currentStatus={resolveCurrentPhysicalStatus(po)}
              timestamps={physTimestamps}
            />
          </div>
          <div className="text-xs text-right shrink-0 ml-4 mt-0.5">{physicalSummary}</div>
        </div>

        {/* Financial track */}
        <div className="flex items-start gap-4">
          <span className="w-20 shrink-0 text-xs font-semibold text-muted-foreground uppercase tracking-wide mt-1">
            Linked invoices
          </span>
          <div className="flex-1 overflow-x-auto">
            <TrackTimeline
              stages={FINANCIAL_TRACK_STAGES}
              currentStatus={po.financialStatus ?? "unbilled"}
              isWarn={finWarn}
              timestamps={finTimestamps}
            />
          </div>
          <div className="text-xs text-right shrink-0 ml-4 mt-0.5">{financialSummary}</div>
        </div>
        <p className="text-xs text-muted-foreground">Linked invoice status describes whole invoices, which may include other purchase orders.</p>
      </div>
    </TooltipProvider>
  );
}

export function usePoHeaderCharges(params: {
  poId: number | null;
  po: any;
  hasPermission: (resource: string, action: string) => boolean;
}) {
  const { poId, po, hasPermission } = params;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editingIncoterms, setEditingIncoterms] = useState(false);
  const [incotermsEdit, setIncotermsEdit] = useState("");
  const [editingDiscount, setEditingDiscount] = useState(false);
  const [discountDollars, setDiscountDollars] = useState("");
  const [editingShipping, setEditingShipping] = useState(false);
  const [shippingDollars, setShippingDollars] = useState("");
  const [editingTax, setEditingTax] = useState(false);
  const [taxDollars, setTaxDollars] = useState("");
  const [editingTolerance, setEditingTolerance] = useState(false);
  const [toleranceVal, setToleranceVal] = useState("");

  const poIncoterms = po?.incoterms as string | null | undefined;
  const chargeRules = poIncoterms ? INCOTERMS_CHARGES[poIncoterms] : null;
  const shippingApplicable = !chargeRules || chargeRules.shipping;
  const taxApplicable = !chargeRules || chargeRules.tax;

  const updateChargesMutation = useMutation({
    mutationFn: async (data: {
      incoterms?: string;
      discountCents?: number;
      taxCents?: number;
      shippingCostCents?: number;
      overReceiptTolerancePct?: number;
    }) => {
      if (!hasPermission("purchasing", "edit")) throw new Error("Purchasing edit permission is required to update purchase order charges.");
      const res = await fetch(`/api/purchase-orders/${poId}/incoterms-charges`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/history`] });
      setEditingIncoterms(false);
      setEditingDiscount(false);
      setEditingShipping(false);
      setEditingTax(false);
      setEditingTolerance(false);
      toast({ title: "Updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function submitDollarCharge(field: "discountCents" | "taxCents" | "shippingCostCents", raw: string, label: string) {
    const amount = evaluateDollarInput(raw || "0");
    if (!amount.valid) {
      toast({ title: "Invalid " + label.toLowerCase(), description: amount.message, variant: "destructive" });
      return;
    }
    updateChargesMutation.mutate({ [field]: amount.cents });
  }

  return {
    editingIncoterms,
    setEditingIncoterms,
    incotermsEdit,
    setIncotermsEdit,
    editingDiscount,
    setEditingDiscount,
    discountDollars,
    setDiscountDollars,
    editingShipping,
    setEditingShipping,
    shippingDollars,
    setShippingDollars,
    editingTax,
    setEditingTax,
    taxDollars,
    setTaxDollars,
    editingTolerance,
    setEditingTolerance,
    toleranceVal,
    setToleranceVal,
    poIncoterms,
    shippingApplicable,
    taxApplicable,
    updateChargesMutation,
    submitDollarCharge,
  };
}

export type PoHeaderChargesController = ReturnType<typeof usePoHeaderCharges>;

export function PoDetailHeaderBar(props: {
  po: any;
  poId: number | null;
  procurementNavigation: ReturnType<typeof useProcurementNavigation>;
  charges: PoHeaderChargesController;
  canEditHeader: boolean;
  canEditSchedule: boolean;
  openScheduleEditor: () => void;
  canSendPoToVendor: boolean;
  isSoloMode: boolean;
  entryBlocked: boolean;
  canPreparePurchaseEntry: boolean;
  sendToVendorPending: boolean;
  onSendToVendor: () => void;
  canSubmitPo: boolean;
  submitPending: boolean;
  onSubmitPo: () => void;
  canApprovePo: boolean;
  approvalBlocked: boolean;
  onApprovePo: () => void;
  canReturnPoToDraft: boolean;
  returnToDraftPending: boolean;
  onReturnPoToDraft: () => void;
  canSendPo: boolean;
  sendPending: boolean;
  onOpenExternalSendConfirmation: () => void;
  canAcknowledgePo: boolean;
  requireAcknowledgment: boolean;
  onOpenAckDialog: () => void;
  canCreateReceiptForPo: boolean;
  onOpenReceivePicker: () => void;
  canClosePo: boolean;
  closePending: boolean;
  onClosePo: () => void;
  canCloseShortPo: boolean;
  closeShortPending: boolean;
  onOpenCloseShortDialog: () => void;
  canCancelPo: boolean;
  cancellationLabel: string;
  onOpenCancelDialog: () => void;
  onOpenDocumentPreview: () => Promise<void>;
  canCreatePurchasing: boolean;
  onOpenCreateInvoiceDialog: () => Promise<void>;
}) {
  const {
    po,
    poId,
    procurementNavigation,
    charges,
    canEditHeader,
    canEditSchedule,
    openScheduleEditor,
    canSendPoToVendor,
    isSoloMode,
    entryBlocked,
    canPreparePurchaseEntry,
    sendToVendorPending,
    onSendToVendor,
    canSubmitPo,
    submitPending,
    onSubmitPo,
    canApprovePo,
    approvalBlocked,
    onApprovePo,
    canReturnPoToDraft,
    returnToDraftPending,
    onReturnPoToDraft,
    canSendPo,
    sendPending,
    onOpenExternalSendConfirmation,
    canAcknowledgePo,
    requireAcknowledgment,
    onOpenAckDialog,
    canCreateReceiptForPo,
    onOpenReceivePicker,
    canClosePo,
    closePending,
    onClosePo,
    canCloseShortPo,
    closeShortPending,
    onOpenCloseShortDialog,
    canCancelPo,
    cancellationLabel,
    onOpenCancelDialog,
    onOpenDocumentPreview,
    canCreatePurchasing,
    onOpenCreateInvoiceDialog,
  } = props;

  return (
    <div className="flex flex-col sm:flex-row items-start gap-4">
      <Button variant="ghost" size="sm" asChild className="min-h-[44px]">
        <Link href={procurementNavigation.backHref("/purchase-orders")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {procurementNavigation.backLabel ?? "Back to purchase orders"}
        </Link>
      </Button>
      <div className="flex-1">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl md:text-2xl font-bold font-mono">{po.poNumber}</h1>
          <PurchaseOrderStatusBadge purchaseOrder={po} />
          {po.priority === "rush" && <Badge variant="destructive">Rush</Badge>}
          {po.priority === "high" && <Badge variant="outline" className="text-orange-600 border-orange-300">High</Badge>}
          {Number(po.overReceiptTolerancePct) > 0 && <Badge variant="outline" className="border-blue-300 text-blue-700 bg-blue-50">Tol: {Number(po.overReceiptTolerancePct)}%</Badge>}
        </div>
        <div className="text-sm text-muted-foreground mt-1 flex items-center gap-x-2 flex-wrap">
          <span>{po.vendor?.name || `Vendor #${po.vendorId}`}</span>
          {po.poType !== "standard" && <span>• {po.poType}</span>}
          <span>•</span>
          {!charges.editingIncoterms ? (
            <span className="flex items-center gap-1">
              {charges.poIncoterms
                ? <span className="font-medium text-foreground">{charges.poIncoterms}</span>
                : <span className="italic text-amber-600">No incoterms set</span>}
              {canEditHeader && (
                <Button
                  variant="ghost" size="icon" className="h-5 w-5 ml-0.5"
                  onClick={() => { charges.setIncotermsEdit(charges.poIncoterms || ""); charges.setEditingIncoterms(true); }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <Select value={charges.incotermsEdit} onValueChange={charges.setIncotermsEdit}>
                <SelectTrigger className="h-7 w-36 text-xs">
                  <SelectValue placeholder="Select..." />
                </SelectTrigger>
                <SelectContent>
                  {INCOTERMS_LIST.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button
                size="sm" className="h-7 px-2"
                disabled={!charges.incotermsEdit || charges.updateChargesMutation.isPending}
                onClick={() => charges.updateChargesMutation.mutate({ incoterms: charges.incotermsEdit })}
              >
                <Check className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => charges.setEditingIncoterms(false)}>
                <XCircle className="h-3 w-3" />
              </Button>
            </span>
          )}
          <span>•</span>
          <span>Requested: {formatProcurementScheduleDate(po.expectedDeliveryDate, { empty: "Not set" })}</span>
          <span>•</span>
          <span>Vendor confirmed: {formatProcurementScheduleDate(po.confirmedDeliveryDate, { empty: "Not set" })}</span>
          {canEditSchedule && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={openScheduleEditor}
                    aria-label="Edit delivery schedule"
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit delivery schedule</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>

      {/* Context-sensitive action buttons */}
      <div className="flex gap-2 flex-wrap w-full sm:w-auto">
        {canSendPoToVendor && po.status === "draft" && isSoloMode && (
          <Button onClick={onSendToVendor} disabled={entryBlocked || !canPreparePurchaseEntry || sendToVendorPending} className="flex-1 sm:flex-none min-h-[44px]">
            <Send className="h-4 w-4 mr-2" />
            {sendToVendorPending ? "Submitting..." : "Prepare for supplier"}
          </Button>
        )}
        {canSubmitPo && po.status === "draft" && !isSoloMode && (
          <Button onClick={onSubmitPo} disabled={submitPending} className="flex-1 sm:flex-none min-h-[44px]">
            <Send className="h-4 w-4 mr-2" />
            Submit
          </Button>
        )}
        {(canApprovePo || canReturnPoToDraft) && po.status === "pending_approval" && (
          <>
            {canApprovePo && (
              <Button onClick={onApprovePo} disabled={approvalBlocked} className="flex-1 sm:flex-none min-h-[44px]">
                <CheckCircle className="h-4 w-4 mr-2" />
                Approve
              </Button>
            )}
            {canReturnPoToDraft && (
              <Button variant="outline" onClick={onReturnPoToDraft} disabled={returnToDraftPending} className="flex-1 sm:flex-none min-h-[44px]">
                <RotateCcw className="h-4 w-4 mr-2" />
                Return to Draft
              </Button>
            )}
          </>
        )}
        {canSendPo && po.status === "approved" && (
          <Button onClick={onOpenExternalSendConfirmation} disabled={sendPending} className="flex-1 sm:flex-none min-h-[44px]">
            <Send className="h-4 w-4 mr-2" />
            Record external send
          </Button>
        )}
        {canAcknowledgePo && requireAcknowledgment && (
          <Button onClick={onOpenAckDialog} className="flex-1 sm:flex-none min-h-[44px]">
            <CheckCircle className="h-4 w-4 mr-2" />
            Acknowledge
          </Button>
        )}
        {canCreateReceiptForPo && (
          <Button variant="outline" onClick={onOpenReceivePicker} className="flex-1 sm:flex-none min-h-[44px]">
            <Truck className="h-4 w-4 mr-2" />
            Receive
          </Button>
        )}
        {poId !== null && <PoQuantityAmendment key={poId} purchaseOrderId={poId} status={po.status} />}
        {canClosePo && (
          <Button onClick={onClosePo} disabled={closePending} className="flex-1 sm:flex-none min-h-[44px]">
            <Archive className="h-4 w-4 mr-2" />
            Close PO
          </Button>
        )}
        {canCloseShortPo && (
          <Button variant="outline" onClick={onOpenCloseShortDialog} disabled={closeShortPending} className="flex-1 sm:flex-none min-h-[44px]">
            <Archive className="h-4 w-4 mr-2" />
            Close short
          </Button>
        )}
        {canCancelPo && (
          <Button variant="outline" onClick={onOpenCancelDialog} className="flex-1 sm:flex-none min-h-[44px] text-red-600 hover:text-red-700">
            <Ban className="h-4 w-4 mr-2" />
            {cancellationLabel}
          </Button>
        )}
        {["approved", "sent", "acknowledged", "partially_received", "received", "closed"].includes(po.status) && (
          <Button variant="outline" onClick={onOpenDocumentPreview} className="flex-1 sm:flex-none min-h-[44px]">
            <Printer className="h-4 w-4 mr-2" />
            View / Print
          </Button>
        )}
        {canCreatePurchasing && ["approved", "sent", "acknowledged", "partially_received", "received", "closed"].includes(po.status) && (
          <Button variant="outline" onClick={() => void onOpenCreateInvoiceDialog()} className="flex-1 sm:flex-none min-h-[44px]">
            <FileText className="h-4 w-4 mr-2" />
            Create Invoice
          </Button>
        )}
      </div>
    </div>
  );
}

export function PoStatusBannersAndSummary(props: {
  po: any;
  poId: number | null;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  openExceptionCount: number;
  maxOpenSeverity: "info" | "warn" | "error" | null;
  cancelledByFormatted: string;
  issuedInvoicesCount: number;
  recordedApplicationsCount: number;
  receiptsCount: number;
  financialEvidence: ReturnType<typeof usePoFinancialEvidence>;
  procurementNavigation: ReturnType<typeof useProcurementNavigation>;
  history: any[];
  charges: PoHeaderChargesController;
  canEditHeader: boolean;
  canEditLines: boolean;
  shipmentCosts: ReturnType<typeof usePoShipmentCosts>;
  immutableRecommendationPo: boolean;
  autoDraftActionPlan: AutoDraftActionPlan | null | undefined;
  linesCount: number;
  reviewAutoDraftFinances: boolean;
  financialGuidanceLabel: string;
  financialGuidanceDetail: string;
  financialGuidanceLoading: boolean;
  financialGuidanceFailed: boolean;
  financialContextAvailable: boolean;
  financialReviewRequired: boolean;
  financialCompletionSupported: boolean;
  autoDraftPrimaryActionPending: boolean;
  autoDraftPrimaryButtonLabel: string;
  autoDraftPrimaryButtonDisabled: boolean;
  onRunAutoDraftPrimaryAction: () => Promise<void>;
}) {
  const {
    po,
    poId,
    activeTab,
    setActiveTab,
    openExceptionCount,
    maxOpenSeverity,
    cancelledByFormatted,
    issuedInvoicesCount,
    recordedApplicationsCount,
    receiptsCount,
    financialEvidence,
    procurementNavigation,
    history,
    charges,
    canEditHeader,
    canEditLines,
    shipmentCosts,
    immutableRecommendationPo,
    autoDraftActionPlan,
    linesCount,
    reviewAutoDraftFinances,
    financialGuidanceLabel,
    financialGuidanceDetail,
    financialGuidanceLoading,
    financialGuidanceFailed,
    financialContextAvailable,
    financialReviewRequired,
    financialCompletionSupported,
    autoDraftPrimaryActionPending,
    autoDraftPrimaryButtonLabel,
    autoDraftPrimaryButtonDisabled,
    onRunAutoDraftPrimaryAction,
  } = props;

  const costCardAmount = (amount: number | null | undefined) => {
    if (shipmentCosts.isError) return "Unavailable";
    if (!shipmentCosts.data) return "Loading…";
    if (amount == null) return "Incomplete";
    return formatIntegerCents(amount, shipmentCosts.data.summary.currency);
  };

  return (
    <>
      {po.status === "closed" && (
        <div className="rounded-md border border-green-600/30 bg-green-50 p-3 dark:bg-green-950/20" data-testid="po-closed-summary">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-semibold">This purchase order is closed</p>
              <p className="text-sm text-muted-foreground">Any remaining invoice or cost reviews are follow-up work. They do not reopen this PO.</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setActiveTab("history")}>View closure history</Button>
          </div>
        </div>
      )}

      {openExceptionCount > 0 && (
        <button
          type="button"
          onClick={() => setActiveTab("exceptions")}
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-sm font-medium transition-colors ${
            maxOpenSeverity === "error"
              ? "bg-red-50 text-red-700 border-red-300 hover:bg-red-100"
              : "bg-amber-50 text-amber-700 border-amber-300 hover:bg-amber-100"
          }`}
          data-testid="po-exception-pill"
        >
          <span aria-hidden>⚠</span>
          {openExceptionCount} exception{openExceptionCount > 1 ? "s" : ""}
        </button>
      )}

      {po.physicalStatus === "cancelled" && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-1.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <span aria-hidden>⛔</span>
              <span>
                Cancelled
                {po.cancelledAt
                  ? ` ${new Date(po.cancelledAt).toLocaleString()}`
                  : ""}
                {po.cancelledBy ? ` by ${cancelledByFormatted}` : ""}
              </span>
            </div>
            {po.cancelReason && (
              <span className="text-xs text-muted-foreground">
                Reason: <span className="text-foreground">{po.cancelReason}</span>
              </span>
            )}
          </div>
          {(() => {
            const items: Array<{ label: string; tab: string }> = [];
            if (issuedInvoicesCount > 0) items.push({ label: `${issuedInvoicesCount} invoice${issuedInvoicesCount > 1 ? "s" : ""} issued before cancellation`, tab: "invoices" });
            if (recordedApplicationsCount > 0) items.push({ label: `${recordedApplicationsCount} payment application${recordedApplicationsCount > 1 ? "s" : ""} recorded`, tab: "payments" });
            if (receiptsCount > 0) items.push({ label: `${receiptsCount} receipt${receiptsCount > 1 ? "s" : ""} on file`, tab: "receipts" });
            if (items.length === 0) return null;
            return (
              <div className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Pre-cancel artifacts:</span>{" "}
                {items.map((it, i) => (
                  <span key={it.tab}>
                    {i > 0 && " · "}
                    <button
                      type="button"
                      onClick={() => setActiveTab(it.tab)}
                      className="underline hover:text-foreground"
                    >
                      {it.label}
                    </button>
                  </span>
                ))}
                {". Review for follow-up."}
              </div>
            );
          })()}
          <div className="text-[11px] text-muted-foreground">
            Full audit trail in the{" "}
            <button
              type="button"
              onClick={() => setActiveTab("history")}
              className="underline hover:text-foreground"
            >
              History tab
            </button>
            .
          </div>
        </div>
      )}

      <PoFinancialEvidence
        query={financialEvidence}
        onViewInvoices={() => setActiveTab("invoices")}
        invoiceHref={(invoiceId) => procurementNavigation.childHref(`/ap-invoices/${invoiceId}`)}
      />

      <DualTrackHeader po={po} history={history} />

      {/* Charge summary cards — always visible across Lifecycle and detail tabs */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 md:gap-4">
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground" title="Over-Receipt Tolerance %">Tolerance</div>
              {canEditHeader && !charges.editingTolerance && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  onClick={() => { charges.setToleranceVal(String(Number(po.overReceiptTolerancePct) || 0)); charges.setEditingTolerance(true); }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </div>
            {charges.editingTolerance ? (
              <div className="flex gap-1 mt-1">
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={charges.toleranceVal}
                  onChange={e => charges.setToleranceVal(e.target.value)}
                  className="h-7 text-sm font-mono w-16 px-1"
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === "Enter") charges.updateChargesMutation.mutate({ overReceiptTolerancePct: parseFloat(charges.toleranceVal || "0") });
                    if (e.key === "Escape") charges.setEditingTolerance(false);
                  }}
                />
                <Button
                  size="sm"
                  className="h-7 px-1"
                  disabled={charges.updateChargesMutation.isPending}
                  onClick={() => charges.updateChargesMutation.mutate({ overReceiptTolerancePct: parseFloat(charges.toleranceVal || "0") })}
                >
                  <Check className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-1" onClick={() => charges.setEditingTolerance(false)}>
                  <XCircle className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <div className="font-mono font-medium">{Number(po.overReceiptTolerancePct) || 0}%</div>
            )}
          </CardContent>
        </Card>

        {/* Subtotal — always read-only */}
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Subtotal</div>
            <div className="font-mono font-medium">{formatCents(po.subtotalCents)}</div>
          </CardContent>
        </Card>

        {/* Discount — editable in draft */}
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">Discount</div>
              {canEditLines && !charges.editingDiscount && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  aria-label="Edit discount"
                  onClick={() => { charges.setDiscountDollars(((Number(po.discountCents) || 0) / 100).toFixed(2)); charges.setEditingDiscount(true); }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </div>
            {charges.editingDiscount ? (
              <div className="flex gap-1 mt-1">
                <Input
                  aria-label="Discount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={charges.discountDollars}
                  onChange={e => charges.setDiscountDollars(e.target.value)}
                  className="h-7 text-sm font-mono"
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === "Enter") charges.submitDollarCharge("discountCents", charges.discountDollars, "Discount");
                    if (e.key === "Escape") charges.setEditingDiscount(false);
                  }}
                />
                <Button
                  size="sm"
                  className="h-7 px-2"
                  disabled={charges.updateChargesMutation.isPending}
                  aria-label="Save discount"
                  onClick={() => charges.submitDollarCharge("discountCents", charges.discountDollars, "Discount")}
                >
                  <Check className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => charges.setEditingDiscount(false)}>
                  <XCircle className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <div className="font-mono font-medium">{formatCents(po.discountCents)}</div>
            )}
          </CardContent>
        </Card>

        {/* Combined duties; the edit action changes only the supplier charge. */}
        <Card data-testid="po-duty-summary-card">
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">{charges.editingTax ? "Edit supplier tax / duties" : "Tax / Duties"}</div>
              {charges.taxApplicable && canEditHeader && !charges.editingTax && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  aria-label="Edit supplier tax / duties"
                  onClick={() => { charges.setTaxDollars(((Number(po.taxCents) || 0) / 100).toFixed(2)); charges.setEditingTax(true); }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </div>
            {charges.editingTax ? (
              <div className="flex gap-1 mt-1">
                <Input
                  aria-label="Supplier tax / duties"
                  type="number"
                  min="0"
                  step="0.01"
                  value={charges.taxDollars}
                  onChange={e => charges.setTaxDollars(e.target.value)}
                  className="h-7 text-sm font-mono"
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === "Enter") charges.submitDollarCharge("taxCents", charges.taxDollars, "Supplier tax / duties");
                    if (e.key === "Escape") charges.setEditingTax(false);
                  }}
                />
                <Button
                  size="sm"
                  className="h-7 px-2"
                  disabled={charges.updateChargesMutation.isPending}
                  aria-label="Save supplier tax / duties"
                  onClick={() => charges.submitDollarCharge("taxCents", charges.taxDollars, "Supplier tax / duties")}
                >
                  <Check className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => charges.setEditingTax(false)}>
                  <XCircle className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <div className="font-mono font-medium">{costCardAmount(shipmentCosts.data?.totals.dutyCents)}</div>
            )}
            {shipmentCosts.isSuccess && (
              <div className="text-xs text-muted-foreground mt-1">
                Supplier: {formatIntegerCents(shipmentCosts.data.supplier.dutyCents, shipmentCosts.data.summary.currency)}<br />
                Shipment: {formatIntegerCents(shipmentCosts.data.summary.dutyCents, shipmentCosts.data.summary.currency)}
              </div>
            )}
            {!charges.taxApplicable && charges.poIncoterms && (
              <div className="text-xs text-muted-foreground mt-0.5">Supplier charge N/A — {charges.poIncoterms}</div>
            )}
          </CardContent>
        </Card>

        {/* Combined freight; supplier edits retain their incoterm restrictions. */}
        <Card data-testid="po-freight-summary-card">
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">{charges.editingShipping ? "Edit supplier freight" : "Freight"}</div>
              {charges.shippingApplicable && canEditHeader && !charges.editingShipping && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  aria-label="Edit supplier freight"
                  onClick={() => { charges.setShippingDollars(((Number(po.shippingCostCents) || 0) / 100).toFixed(2)); charges.setEditingShipping(true); }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </div>
            {charges.editingShipping ? (
              <div className="flex gap-1 mt-1">
                <Input
                  aria-label="Supplier freight"
                  type="number"
                  min="0"
                  step="0.01"
                  value={charges.shippingDollars}
                  onChange={e => charges.setShippingDollars(e.target.value)}
                  className="h-7 text-sm font-mono"
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === "Enter") charges.submitDollarCharge("shippingCostCents", charges.shippingDollars, "Supplier freight");
                    if (e.key === "Escape") charges.setEditingShipping(false);
                  }}
                />
                <Button
                  size="sm"
                  className="h-7 px-2"
                  disabled={charges.updateChargesMutation.isPending}
                  aria-label="Save supplier freight"
                  onClick={() => charges.submitDollarCharge("shippingCostCents", charges.shippingDollars, "Supplier freight")}
                >
                  <Check className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => charges.setEditingShipping(false)}>
                  <XCircle className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <div className="font-mono font-medium">{costCardAmount(shipmentCosts.data?.totals.freightCents)}</div>
            )}
            {shipmentCosts.isSuccess && (
              <div className="text-xs text-muted-foreground mt-1">
                Supplier: {formatIntegerCents(shipmentCosts.data.supplier.freightCents, shipmentCosts.data.summary.currency)}<br />
                Shipment: {formatIntegerCents(shipmentCosts.data.summary.freightCents, shipmentCosts.data.summary.currency)}
              </div>
            )}
            {!charges.shippingApplicable && charges.poIncoterms && (
              <div className="text-xs text-muted-foreground mt-0.5">
                Supplier charge N/A — {charges.poIncoterms}
                <button
                  className="ml-1 text-primary underline"
                  onClick={() => setActiveTab("shipments")}
                >
                  Log on shipment
                </button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Total — always read-only */}
        <Card data-testid="po-total-cost-summary-card">
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Total landed cost</div>
            <div className="font-mono font-bold text-lg">{costCardAmount(shipmentCosts.data?.totals.combinedCostCents)}</div>
            {shipmentCosts.isSuccess && (
              <div className="text-xs text-muted-foreground mt-1">
                Supplier PO: {formatIntegerCents(shipmentCosts.data.summary.poAmountCents, shipmentCosts.data.summary.currency)}<br />
                Shipment charges: {formatIntegerCents(shipmentCosts.data.summary.totalCents, shipmentCosts.data.summary.currency)}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {activeTab !== "lifecycle" && (
        <>
          {poId && (
            <div className="space-y-3">
              <PoShipmentCostSummary purchaseOrderId={poId} query={shipmentCosts} onViewShipments={() => setActiveTab("shipments")} />
              <div className="flex flex-wrap gap-2">
                <SupplierHeaderCosts target={{ kind: "purchase_order", id: poId }} />
                <PurchaseTaxReview target={{ kind: "purchase_order", id: poId }} label="Tax treatment" />
              </div>
            </div>
          )}

          {/* Auto-Draft Banner */}
          {immutableRecommendationPo && (
            <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 flex items-center gap-4 text-sm">
              <span className="text-lg flex-shrink-0">🤖</span>
              <div className="flex-1">
                <strong className="text-amber-700">
                  {po.source === "auto_draft" ? "Auto-Draft" : "Recommendation Purchase Order"}
                </strong>
                <p className="text-muted-foreground text-xs mt-0.5">
                  The accepted recommendation and vendor quote are preserved as an immutable economic snapshot. Review the lines, then use the lifecycle actions here to submit or send it without replacing the PO.
                </p>
              </div>
            </div>
          )}

          {autoDraftActionPlan && (
            <Card className="border-amber-200" role="region" aria-label="Auto-draft next action">
              <CardContent className="p-4 space-y-4">
                <div className="flex flex-col lg:flex-row lg:items-start gap-4">
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge
                        variant="outline"
                        className={`text-xs ${AUTO_DRAFT_SEVERITY_STYLES[reviewAutoDraftFinances ? "warning" : autoDraftActionPlan.primaryAction.severity]}`}
                      >
                        Auto-draft next action
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {autoDraftActionPlan.context.lineCount ?? linesCount} line{(autoDraftActionPlan.context.lineCount ?? linesCount) === 1 ? "" : "s"}
                        {autoDraftActionPlan.context.openExceptionCount > 0
                          ? `, ${autoDraftActionPlan.context.openExceptionCount} open exception${autoDraftActionPlan.context.openExceptionCount === 1 ? "" : "s"}`
                          : ""}
                      </span>
                    </div>
                    <div>
                      <h3 className="font-semibold text-base">{reviewAutoDraftFinances ? financialGuidanceLabel : autoDraftActionPlan.primaryAction.label}</h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        {reviewAutoDraftFinances ? financialGuidanceDetail : autoDraftActionPlan.primaryAction.detail}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant={autoDraftActionPlan.primaryAction.severity === "critical" ? "destructive" : "default"}
                    onClick={() => void onRunAutoDraftPrimaryAction()}
                    disabled={autoDraftPrimaryButtonDisabled}
                    className="w-full lg:w-auto"
                  >
                    {autoDraftPrimaryActionPending ? "Working..." : autoDraftPrimaryButtonLabel}
                  </Button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
                  {autoDraftActionPlan.checklist.map((recordedStep) => {
                    const step = recordedStep.id === "ap_closeout" &&
                      (!financialContextAvailable ||
                        (financialReviewRequired && autoDraftActionPlan.primaryAction.id !== "review_financial_evidence") ||
                        (recordedStep.status === "done" && !financialCompletionSupported))
                      ? {
                          ...recordedStep,
                          status: financialGuidanceLoading ? "pending" as const : financialGuidanceFailed ? "blocked" as const : "current" as const,
                          detail: financialGuidanceDetail,
                        }
                      : recordedStep;
                    return (
                      <div
                        key={step.id}
                        className={`rounded-md border px-3 py-2 text-sm ${AUTO_DRAFT_STEP_STYLES[step.status]}`}
                      >
                        <div className="flex items-center gap-2 font-medium">
                          {step.status === "done" ? (
                            <CheckCircle className="h-3.5 w-3.5 flex-shrink-0" />
                          ) : step.status === "blocked" ? (
                            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                          ) : (
                            <Clock className="h-3.5 w-3.5 flex-shrink-0" />
                          )}
                          <span className="truncate">{step.label}</span>
                        </div>
                        {step.detail && (
                          <p className="text-xs opacity-80 mt-1 line-clamp-2">
                            {step.detail}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </>
  );
}

export function PoQuickActionsRail(props: {
  po: any;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  canSendPoToVendor: boolean;
  isSoloMode: boolean;
  entryBlocked: boolean;
  canPreparePurchaseEntry: boolean;
  sendToVendorPending: boolean;
  onSendToVendor: () => void;
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
  canCancelPo: boolean;
  cancellationLabel: string;
  onOpenCancelDialog: () => void;
  financialCompletionSupported: boolean;
}) {
  const {
    po,
    activeTab,
    setActiveTab,
    canSendPoToVendor,
    isSoloMode,
    entryBlocked,
    canPreparePurchaseEntry,
    sendToVendorPending,
    onSendToVendor,
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
    canCancelPo,
    cancellationLabel,
    onOpenCancelDialog,
    financialCompletionSupported,
  } = props;

  return (
    <div className={activeTab === "lifecycle" ? "hidden" : `w-full ${activeTab === "lines" ? "2xl:w-64" : "md:w-64"} shrink-0 space-y-3`}>
      <Card role="region" aria-label="Purchase order actions">
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="text-sm">Quick actions</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-2">
          {canSendPoToVendor && isSoloMode && (
            <Button
              className="w-full justify-start"
              size="sm"
              onClick={onSendToVendor}
              disabled={entryBlocked || !canPreparePurchaseEntry || sendToVendorPending}
            >
              <Send className="h-3.5 w-3.5 mr-2" />
              Prepare for supplier
            </Button>
          )}

          {canAcknowledgePo && (
            <Button
              className="w-full justify-start"
              variant="outline"
              size="sm"
              onClick={onOpenAckDialog}
            >
              <CheckCircle className="h-3.5 w-3.5 mr-2" />
              Mark acknowledged
            </Button>
          )}

          {canMarkPoShipped && (
            <Button
              className="w-full justify-start"
              variant="outline"
              size="sm"
              onClick={onMarkShipped}
              disabled={markShippedPending}
            >
              <Truck className="h-3.5 w-3.5 mr-2" />
              {markShippedPending ? "Marking..." : "Mark shipped"}
            </Button>
          )}

          {canMarkPoInTransit && (
            <Button
              className="w-full justify-start"
              variant="outline"
              size="sm"
              onClick={onMarkInTransit}
              disabled={markInTransitPending}
            >
              <Ship className="h-3.5 w-3.5 mr-2" />
              {markInTransitPending ? "Marking..." : "Mark in transit"}
            </Button>
          )}

          {canMarkPoArrived && (
            <Button
              className="w-full justify-start"
              variant="outline"
              size="sm"
              onClick={onMarkArrived}
              disabled={markArrivedPending}
            >
              <Package className="h-3.5 w-3.5 mr-2" />
              {markArrivedPending ? "Marking..." : "Mark arrived"}
            </Button>
          )}

          {["sent", "acknowledged", "shipped", "in_transit", "arrived", "receiving"].includes(po.physicalStatus ?? "") &&
            !["cancelled", "closed"].includes(po.physicalStatus ?? "") && (
            <Button
              className="w-full justify-start"
              variant="outline"
              size="sm"
              onClick={onOpenCreateShipmentDialog}
            >
              <Package className="h-3.5 w-3.5 mr-2" />
              Create shipment
            </Button>
          )}

          {canCreateReceiptForPo && (
            <Button
              className="w-full justify-start"
              variant="outline"
              size="sm"
              onClick={onOpenReceivePicker}
            >
              <Truck className="h-3.5 w-3.5 mr-2" />
              Receive
            </Button>
          )}

          {canCancelPo && !["closed", "cancelled"].includes(po.status) && (
            <Button
              className="w-full justify-start text-red-600 hover:text-red-700"
              variant="ghost"
              size="sm"
              onClick={onOpenCancelDialog}
            >
              <Ban className="h-3.5 w-3.5 mr-2" />
              {cancellationLabel} PO
            </Button>
          )}

          {!financialCompletionSupported && (
            <Button className="w-full justify-start" variant="outline" size="sm" onClick={() => setActiveTab("invoices")}>
              <FileText className="h-3.5 w-3.5 mr-2" />
              Review linked invoices
            </Button>
          )}

          {po.status === "closed" ? (
            <p className="text-xs text-muted-foreground py-2">PO closed. Any remaining cost follow-ups are listed in the cost summary.</p>
          ) : po.physicalStatus === "received" && financialCompletionSupported && (
            <p className="text-xs text-muted-foreground text-center py-2">
              PO fully received and paid. Review the cost summary for any remaining cost follow-ups.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
