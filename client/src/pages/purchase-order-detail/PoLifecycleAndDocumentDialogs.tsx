import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertTriangle, Mail, Printer, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { poEmailDeliveryPresentation } from "@/lib/po-email-delivery";
import {
  type ExternalSendReview,
  genPoEmailIdempotencyKey,
  type NavigationSnapshot,
  type PoEmailDelivery,
} from "./po-detail-types-and-helpers";

export function usePoDocumentAndEmail(params: {
  poId: number | null;
  po: any;
  hasPermission: (resource: string, action: string) => boolean;
  navigate: (to: string, options?: { replace?: boolean }) => void;
  captureNavigation: () => NavigationSnapshot;
}) {
  const { poId, po, hasPermission, navigate, captureNavigation } = params;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [showDocDialog, setShowDocDialog] = useState(false);
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [showCreateInvoiceDialog, setShowCreateInvoiceDialog] = useState(false);
  const [invoiceForm, setInvoiceForm] = useState({
    invoiceNumber: "",
    amountDollars: "",
    invoiceDate: "",
    dueDate: "",
    notes: "",
  });
  const [docHtml, setDocHtml] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const documentRequest = React.useRef(0);

  useEffect(() => {
    documentRequest.current += 1;
    setDocHtml(null);
    setDocError(null);
    setDocLoading(false);
    setShowDocDialog(false);
  }, [poId]);

  const loadDocumentPreview = async () => {
    const request = ++documentRequest.current;
    setDocLoading(true);
    setDocHtml(null);
    setDocError(null);
    try {
      const response = await fetch(`/api/purchase-orders/${poId}/document`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to load the purchase order document.");
      if (typeof result.html !== "string" || !result.html) throw new Error("The document response is incomplete. Please retry.");
      if (request === documentRequest.current) setDocHtml(result.html);
    } catch (error) {
      if (request === documentRequest.current) {
        setDocError(error instanceof Error ? error.message : "Unable to load the purchase order document.");
      }
    } finally {
      if (request === documentRequest.current) setDocLoading(false);
    }
  };

  const handleDocDialogOpenChange = (open: boolean) => {
    setShowDocDialog(open);
    if (!open) {
      documentRequest.current += 1;
      setDocHtml(null);
      setDocError(null);
      setDocLoading(false);
    }
  };

  const [emailForm, setEmailForm] = useState({ toEmail: "", ccEmail: "", message: "" });
  const [emailSending, setEmailSending] = useState(false);
  const [emailIdempotencyKey, setEmailIdempotencyKey] = useState(genPoEmailIdempotencyKey);
  const [emailReplayKeys, setEmailReplayKeys] = useState<Record<number, string>>({});
  const [emailReplayingId, setEmailReplayingId] = useState<number | null>(null);

  const { data: emailDeliveriesData } = useQuery<{ deliveries: PoEmailDelivery[] }>({
    queryKey: [`/api/purchase-orders/${poId}/email-deliveries`],
    enabled: !!poId && showEmailDialog,
    refetchInterval: showEmailDialog ? 5_000 : false,
  });

  const replayEmailDelivery = async (deliveryId: number) => {
    const idempotencyKey = emailReplayKeys[deliveryId] ?? genPoEmailIdempotencyKey();
    setEmailReplayKeys((keys) => ({ ...keys, [deliveryId]: idempotencyKey }));
    setEmailReplayingId(deliveryId);
    try {
      const res = await fetch(
        `/api/purchase-orders/${poId}/email-deliveries/${deliveryId}/replay`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: "{}",
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to replay email delivery");
      setEmailReplayKeys((keys) => {
        const next = { ...keys };
        delete next[deliveryId];
        return next;
      });
      await queryClient.invalidateQueries({
        queryKey: [`/api/purchase-orders/${poId}/email-deliveries`],
      });
      const presentation = poEmailDeliveryPresentation(data.delivery);
      toast({
        title: presentation.label,
        description: presentation.description,
        variant: presentation.needsAttention ? "destructive" : "default",
      });
    } catch (error) {
      toast({
        title: "Failed to replay delivery",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setEmailReplayingId(null);
    }
  };

  const queueEmailToVendor = async () => {
    setEmailSending(true);
    try {
      const res = await fetch(`/api/purchase-orders/${poId}/send-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": emailIdempotencyKey,
        },
        body: JSON.stringify({
          toEmail: emailForm.toEmail,
          ccEmail: emailForm.ccEmail || undefined,
          message: emailForm.message || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const presentation = poEmailDeliveryPresentation(data.delivery);
      toast({
        title: presentation.label,
        description: presentation.description,
        variant: presentation.needsAttention ? "destructive" : "default",
      });
      setEmailIdempotencyKey(genPoEmailIdempotencyKey());
      if (!presentation.needsAttention) setShowEmailDialog(false);
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/email-deliveries`] });
    } catch (err: any) {
      toast({ title: "Failed to queue email", description: err.message, variant: "destructive" });
    } finally {
      setEmailSending(false);
    }
  };

  const createInvoiceMutation = useMutation({
    onMutate: captureNavigation,
    mutationFn: async () => {
      if (!hasPermission("purchasing", "create")) throw new Error("Purchasing create permission is required to create an invoice.");
      const idempotencyKey = (
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto as any).randomUUID()
          : `po-invoice-${Date.now()}-${Math.random().toString(36).slice(2)}`
      ) as string;
      const res = await fetch("/api/vendor-invoices", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          vendorId: po.vendorId,
          invoiceNumber: invoiceForm.invoiceNumber,
          currency: po.currency || "USD",
          paymentTermsDays: po.paymentTermsDays,
          paymentTermsType: po.paymentTermsType,
          invoiceDate: invoiceForm.invoiceDate || undefined,
          dueDate: invoiceForm.dueDate || undefined,
          notes: invoiceForm.notes || undefined,
          internalNotes: `Auto-created from ${po.poNumber}`,
          poIds: [po.id],
        }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Failed to create invoice"); }
      return res.json();
    },
    onSuccess: (invoice, _variables, context) => {
      if (context?.poId) queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${context.poId}`] });
      toast({ title: "Invoice created", description: `Invoice ${invoice.invoiceNumber} created and linked to this PO.` });
      if (!context?.isCurrent()) return;
      setShowCreateInvoiceDialog(false);
      navigate(context.childHref(`/ap-invoices/${invoice.id}`));
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const openCreateInvoiceDialogFromPo = async () => {
    if (!hasPermission("purchasing", "create")) return;
    let invoiceNumber = "";
    try {
      const res = await fetch("/api/vendor-invoices/next-number");
      if (res.ok) {
        const data = await res.json();
        invoiceNumber = data.invoiceNumber;
      }
    } catch {}
    setInvoiceForm({
      invoiceNumber,
      amountDollars: ((Number(po?.totalCents) || 0) / 100).toString(),
      invoiceDate: new Date().toISOString().slice(0, 10),
      dueDate: "",
      notes: "",
    });
    setShowCreateInvoiceDialog(true);
  };

  return {
    showDocDialog,
    setShowDocDialog,
    handleDocDialogOpenChange,
    docHtml,
    docLoading,
    docError,
    loadDocumentPreview,
    showEmailDialog,
    setShowEmailDialog,
    emailForm,
    setEmailForm,
    emailSending,
    setEmailIdempotencyKey,
    emailDeliveriesData,
    emailReplayingId,
    replayEmailDelivery,
    queueEmailToVendor,
    showCreateInvoiceDialog,
    setShowCreateInvoiceDialog,
    invoiceForm,
    setInvoiceForm,
    createInvoiceMutation,
    openCreateInvoiceDialogFromPo,
  };
}

export type PoDocumentAndEmailController = ReturnType<typeof usePoDocumentAndEmail>;

export function PoLifecycleDialogs(props: {
  po: any;
  poId: number | null;
  docAndEmail: PoDocumentAndEmailController;
  canCreatePurchasing: boolean;
  // Close short
  showCloseShortDialog: boolean;
  setShowCloseShortDialog: (open: boolean) => void;
  closeShortReason: string;
  setCloseShortReason: (reason: string) => void;
  canCloseShortPo: boolean;
  closeShortEndpoint: string | undefined;
  closeShortPending: boolean;
  closeShortError: Error | null;
  onConfirmCloseShort: (command: { purchaseOrderId: number; endpoint: string; reason: string }) => void;
  // Cancel
  showCancelDialog: boolean;
  setShowCancelDialog: (open: boolean) => void;
  canCancelPo: boolean;
  cancellationLabel: string;
  cancelReason: string;
  setCancelReason: (reason: string) => void;
  cancelPending: boolean;
  onConfirmCancel: (reason: string) => void;
  // Delivery Schedule
  showScheduleDialog: boolean;
  setShowScheduleDialog: (open: boolean) => void;
  scheduleMinimumDate: string;
  canSetConfirmedDelivery: boolean;
  scheduleData: { expectedDeliveryDate: string; confirmedDeliveryDate: string; notes: string };
  setScheduleData: React.Dispatch<React.SetStateAction<{ expectedDeliveryDate: string; confirmedDeliveryDate: string; notes: string }>>;
  updateSchedulePending: boolean;
  onSaveSchedule: () => void;
  // External Send
  externalSendReview: ExternalSendReview | null;
  setExternalSendReview: (review: ExternalSendReview | null) => void;
  sendPending: boolean;
  sendError: Error | null;
  onConfirmExternalSend: (review: ExternalSendReview) => void;
  // Vendor Acknowledgment
  showAckDialog: boolean;
  setShowAckDialog: (open: boolean) => void;
  ackData: { vendorRefNumber: string; confirmedDeliveryDate: string };
  setAckData: React.Dispatch<React.SetStateAction<{ vendorRefNumber: string; confirmedDeliveryDate: string }>>;
  acknowledgePending: boolean;
  onConfirmAcknowledge: () => void;
}) {
  const {
    po,
    poId,
    docAndEmail,
    canCreatePurchasing,
    showCloseShortDialog,
    setShowCloseShortDialog,
    closeShortReason,
    setCloseShortReason,
    canCloseShortPo,
    closeShortEndpoint,
    closeShortPending,
    closeShortError,
    onConfirmCloseShort,
    showCancelDialog,
    setShowCancelDialog,
    canCancelPo,
    cancellationLabel,
    cancelReason,
    setCancelReason,
    cancelPending,
    onConfirmCancel,
    showScheduleDialog,
    setShowScheduleDialog,
    scheduleMinimumDate,
    canSetConfirmedDelivery,
    scheduleData,
    setScheduleData,
    updateSchedulePending,
    onSaveSchedule,
    externalSendReview,
    setExternalSendReview,
    sendPending,
    sendError,
    onConfirmExternalSend,
    showAckDialog,
    setShowAckDialog,
    ackData,
    setAckData,
    acknowledgePending,
    onConfirmAcknowledge,
  } = props;

  return (
    <>
      <Dialog open={showCloseShortDialog} onOpenChange={(open) => { if (!closeShortPending) setShowCloseShortDialog(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Close Purchase Order Short</DialogTitle>
            <DialogDescription>
              {po.status === "closed" && po.physicalStatus === "short_closed"
                ? "The saved purchase order is already closed short. Close this dialog to review its current state."
                : canCloseShortPo
                  ? "Close the remaining receipt work with an approved reason. This does not record additional received goods."
                  : "Close-short is unavailable for the current purchase order or your current permissions. Reload the purchase order to review its state."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Label htmlFor="po-close-short-reason">Reason *</Label>
            <Textarea
              id="po-close-short-reason"
              value={closeShortReason}
              disabled={closeShortPending}
              onChange={(event) => setCloseShortReason(event.target.value)}
              placeholder="Why will the remaining goods not be received?"
              rows={3}
            />
            {closeShortError && <p role="alert" className="text-sm text-destructive">{closeShortError.message}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={closeShortPending} onClick={() => setShowCloseShortDialog(false)}>Back</Button>
              <Button
                disabled={!canCloseShortPo || !closeShortReason.trim() || closeShortPending}
                onClick={() => {
                  if (poId && closeShortEndpoint) {
                    onConfirmCloseShort({ purchaseOrderId: poId, endpoint: closeShortEndpoint, reason: closeShortReason });
                  }
                }}
              >
                {closeShortPending ? "Saving…" : "Confirm close short"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Cancel Dialog ── */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              {cancellationLabel} Purchase Order
            </DialogTitle>
            <DialogDescription>
              {canCancelPo
                ? "This action cannot be undone. Please provide a reason."
                : po.status === "cancelled"
                  ? "The saved purchase order is already cancelled. Close this dialog to review its current state."
                  : "Cancellation is unavailable for the current purchase order or your current permissions."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Reason *</Label>
              <Textarea
                value={cancelReason}
                onChange={e => setCancelReason(e.target.value)}
                placeholder="Why is this PO being cancelled?"
                rows={3}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowCancelDialog(false)}>Back</Button>
              <Button
                variant="destructive"
                onClick={() => onConfirmCancel(cancelReason)}
                disabled={!canCancelPo || !cancelReason.trim() || cancelPending}
              >
                {cancelPending ? "Saving..." : `Confirm ${cancellationLabel}`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delivery Schedule Dialog ── */}
      <Dialog open={showScheduleDialog} onOpenChange={setShowScheduleDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delivery Schedule</DialogTitle>
            <DialogDescription>Update requested and vendor-confirmed delivery dates.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Requested Delivery Date</Label>
              <Input
                type="date"
                min={scheduleMinimumDate || undefined}
                value={scheduleData.expectedDeliveryDate}
                onChange={event => setScheduleData(previous => ({
                  ...previous,
                  expectedDeliveryDate: event.target.value,
                }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Vendor Confirmed Delivery Date</Label>
              <Input
                type="date"
                min={scheduleMinimumDate || undefined}
                value={scheduleData.confirmedDeliveryDate}
                disabled={!canSetConfirmedDelivery}
                onChange={event => setScheduleData(previous => ({
                  ...previous,
                  confirmedDeliveryDate: event.target.value,
                }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Change Note</Label>
              <Textarea
                value={scheduleData.notes}
                onChange={event => setScheduleData(previous => ({ ...previous, notes: event.target.value }))}
                placeholder="Reason for the schedule correction"
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowScheduleDialog(false)}>Cancel</Button>
              <Button
                onClick={onSaveSchedule}
                disabled={updateSchedulePending}
              >
                {updateSchedulePending ? "Saving..." : "Save Schedule"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Explicit operator attestation for an external supplier send. */}
      <Dialog open={externalSendReview !== null} onOpenChange={(open) => { if (!open && !sendPending) setExternalSendReview(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record an external supplier send</DialogTitle>
            <DialogDescription>
              Continue only after you have sent the reviewed {externalSendReview?.poNumber} to the supplier outside Echelon. This records your confirmation; it does not send an email or document, or record supplier acknowledgement.
            </DialogDescription>
          </DialogHeader>
          {sendError && <p role="alert" className="text-sm text-destructive">{sendError.message} Reload the PO to verify its current state before trying again.</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={sendPending} onClick={() => setExternalSendReview(null)}>Cancel</Button>
            <Button disabled={sendPending} onClick={() => { if (externalSendReview) onConfirmExternalSend(externalSendReview); }}>
              {sendPending ? "Recording..." : "Confirm external send"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showAckDialog} onOpenChange={setShowAckDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Vendor Acknowledgment</DialogTitle>
            <DialogDescription>Record the vendor's acknowledgment of this PO.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Vendor Reference #</Label>
              <Input
                value={ackData.vendorRefNumber}
                onChange={e => setAckData(prev => ({ ...prev, vendorRefNumber: e.target.value }))}
                placeholder="Vendor's order confirmation number"
                className="h-10"
              />
            </div>
            <div className="space-y-2">
              <Label>Confirmed Delivery Date</Label>
              <Input
                type="date"
                min={scheduleMinimumDate || undefined}
                value={ackData.confirmedDeliveryDate}
                onChange={e => setAckData(prev => ({ ...prev, confirmedDeliveryDate: e.target.value }))}
                className="h-10"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowAckDialog(false)}>Cancel</Button>
              <Button
                onClick={onConfirmAcknowledge}
                disabled={acknowledgePending}
              >
                {acknowledgePending ? "Saving..." : "Record Acknowledgment"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── PO Document Dialog ── */}
      <Dialog open={docAndEmail.showDocDialog} onOpenChange={docAndEmail.handleDocDialogOpenChange}>
        <DialogContent className="max-w-4xl w-[95vw] h-[90vh] flex flex-col p-0">
          <DialogHeader className="px-6 py-4 border-b flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between space-y-0">
            <DialogTitle className="text-base font-semibold pr-8">
              Purchase Order — {po?.poNumber}
            </DialogTitle>
            <div className="flex gap-2 self-end sm:self-auto">
              <Button
                size="sm"
                variant="outline"
                disabled={docAndEmail.docLoading || !docAndEmail.docHtml || !!docAndEmail.docError}
                onClick={() => {
                  docAndEmail.setEmailForm(f => ({ ...f, toEmail: po?.vendor?.email || po?.vendorContactEmail || "" }));
                  docAndEmail.setShowEmailDialog(true);
                }}
              >
                <Mail className="h-4 w-4 mr-2" />
                Email to Vendor
              </Button>
              <Button
                size="sm"
                disabled={docAndEmail.docLoading || !docAndEmail.docHtml || !!docAndEmail.docError}
                onClick={() => {
                  const iframe = document.getElementById("po-doc-iframe") as HTMLIFrameElement | null;
                  iframe?.contentWindow?.print();
                }}
              >
                <Printer className="h-4 w-4 mr-2" />
                Print
              </Button>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-hidden">
            {docAndEmail.docLoading ? (
              <div className="flex items-center justify-center h-full">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            ) : docAndEmail.docError ? (
              <div role="alert" className="p-6 space-y-3">
                <p className="font-medium">The supplier document could not be generated.</p>
                <p className="text-sm text-muted-foreground">{docAndEmail.docError}</p>
                <Button variant="outline" onClick={() => void docAndEmail.loadDocumentPreview()}>Retry document</Button>
              </div>
            ) : docAndEmail.docHtml ? (
              <iframe
                id="po-doc-iframe"
                srcDoc={docAndEmail.docHtml}
                className="w-full h-full border-0"
                title="PO Document"
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Email to Vendor Dialog ── */}
      <Dialog open={docAndEmail.showEmailDialog} onOpenChange={docAndEmail.setShowEmailDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Email PO to Vendor</DialogTitle>
            <DialogDescription>
              Queue <span className="font-mono font-medium">{po?.poNumber}</span> for reliable delivery. The full PO document is snapshotted in the email body and retries happen automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>To *</Label>
              <Input
                type="email"
                placeholder="vendor@example.com"
                value={docAndEmail.emailForm.toEmail}
                onChange={(e) => {
                  docAndEmail.setEmailForm(f => ({ ...f, toEmail: e.target.value }));
                  docAndEmail.setEmailIdempotencyKey(genPoEmailIdempotencyKey());
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>CC <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input
                type="email"
                placeholder="cc@example.com"
                value={docAndEmail.emailForm.ccEmail}
                onChange={(e) => {
                  docAndEmail.setEmailForm(f => ({ ...f, ccEmail: e.target.value }));
                  docAndEmail.setEmailIdempotencyKey(genPoEmailIdempotencyKey());
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>Message <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Textarea
                placeholder="Add a personal note to the vendor..."
                rows={3}
                value={docAndEmail.emailForm.message}
                onChange={(e) => {
                  docAndEmail.setEmailForm(f => ({ ...f, message: e.target.value }));
                  docAndEmail.setEmailIdempotencyKey(genPoEmailIdempotencyKey());
                }}
              />
            </div>
            {(docAndEmail.emailDeliveriesData?.deliveries?.length ?? 0) > 0 && (
              <div className="space-y-2 border-t pt-3">
                <Label>Recent deliveries</Label>
                <div className="max-h-36 space-y-2 overflow-y-auto">
                  {docAndEmail.emailDeliveriesData!.deliveries.slice(0, 5).map((delivery) => {
                    const presentation = poEmailDeliveryPresentation(delivery);
                    const hasActiveReplay = docAndEmail.emailDeliveriesData!.deliveries.some(
                      (candidate) => candidate.replayOfId === delivery.id
                        && ["queued", "processing", "sent", "partially_sent"].includes(candidate.status),
                    );
                    return (
                      <div key={delivery.id} className="rounded-md border p-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">{delivery.toEmail}</span>
                          <Badge
                            variant={presentation.needsAttention ? "destructive" : delivery.status === "sent" ? "default" : "secondary"}
                            className={`shrink-0 text-[10px] ${delivery.status === "partially_sent" ? "border-amber-300 bg-amber-50 text-amber-800" : ""}`}
                          >
                            {presentation.label}
                          </Badge>
                        </div>
                        <div className="mt-1 text-muted-foreground">
                          {format(new Date(delivery.sentAt || delivery.createdAt), "MMM d, h:mm a")}
                          {delivery.attemptCount > 0 ? ` · attempt ${delivery.attemptCount}/${delivery.maxAttempts}` : ""}
                        </div>
                        {delivery.documentHoldReason ? (
                          <div className="mt-1 text-destructive" role="status">{presentation.description}</div>
                        ) : null}
                        {delivery.status === "dead_letter" && delivery.lastErrorMessage ? (
                          <div className="mt-1 text-destructive">{delivery.lastErrorMessage}</div>
                        ) : null}
                        {delivery.status === "partially_sent" && delivery.lastErrorMessage ? (
                          <div className="mt-1 text-amber-700">{delivery.lastErrorMessage}</div>
                        ) : null}
                        {presentation.canReplay && !hasActiveReplay ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="mt-2 h-7 text-xs"
                            disabled={docAndEmail.emailReplayingId === delivery.id}
                            onClick={() => void docAndEmail.replayEmailDelivery(delivery.id)}
                          >
                            <RotateCcw className="mr-1 h-3 w-3" />
                            {docAndEmail.emailReplayingId === delivery.id ? "Queueing replay..." : "Replay delivery"}
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => docAndEmail.setShowEmailDialog(false)}>Cancel</Button>
              <Button
                disabled={!docAndEmail.emailForm.toEmail || docAndEmail.emailSending}
                onClick={() => void docAndEmail.queueEmailToVendor()}
              >
                {docAndEmail.emailSending ? "Queueing..." : "Queue Email"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Create Invoice from PO Dialog ── */}
      <Dialog open={docAndEmail.showCreateInvoiceDialog} onOpenChange={docAndEmail.setShowCreateInvoiceDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Invoice from PO</DialogTitle>
            <DialogDescription>
              Pre-filled from {po?.poNumber}. Edit any field before creating.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Vendor</Label>
              <div className="text-sm font-medium p-2 bg-muted rounded-md">{po?.vendor?.name || `Vendor #${po?.vendorId}`}</div>
            </div>
            <div className="space-y-2">
              <Label>Invoice Number *</Label>
              <Input
                value={docAndEmail.invoiceForm.invoiceNumber}
                onChange={(e) => docAndEmail.setInvoiceForm(f => ({ ...f, invoiceNumber: e.target.value }))}
                placeholder="INV-..."
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Invoice Date</Label>
                <Input
                  type="date"
                  value={docAndEmail.invoiceForm.invoiceDate}
                  onChange={(e) => docAndEmail.setInvoiceForm(f => ({ ...f, invoiceDate: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Due Date</Label>
                <Input
                  type="date"
                  value={docAndEmail.invoiceForm.dueDate}
                  onChange={(e) => docAndEmail.setInvoiceForm(f => ({ ...f, dueDate: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Input
                value={docAndEmail.invoiceForm.notes}
                onChange={(e) => docAndEmail.setInvoiceForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Optional notes"
              />
            </div>
            <div className="p-2 bg-muted/50 rounded text-xs text-muted-foreground">
              This invoice will be linked to {po?.poNumber} and PO line items will be auto-imported.
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => docAndEmail.setShowCreateInvoiceDialog(false)}>Cancel</Button>
              <Button
                onClick={() => docAndEmail.createInvoiceMutation.mutate()}
                disabled={!canCreatePurchasing || docAndEmail.createInvoiceMutation.isPending || !docAndEmail.invoiceForm.invoiceNumber.trim()}
              >
                {docAndEmail.createInvoiceMutation.isPending ? "Creating..." : "Create Invoice"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
