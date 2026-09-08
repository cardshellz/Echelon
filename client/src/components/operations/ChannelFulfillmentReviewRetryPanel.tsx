import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  buildFulfillmentReviewPreviewRequest,
  buildFulfillmentReviewRetryRequest,
  fulfillmentReviewBlockerLabel,
  fulfillmentReviewFailureMessage,
  FULFILLMENT_REVIEW_REASON_LIMIT,
  requestFulfillmentReviewRetry,
  type FulfillmentReviewResult,
  type FulfillmentReviewScope,
} from "@/lib/channel-fulfillment-review-retry";

export function ChannelFulfillmentReviewRetryPanel(props: {
  scope: FulfillmentReviewScope;
  onQueued: () => Promise<void>;
}) {
  const { toast } = useToast();
  const reasonId = useId();
  const [preview, setPreview] = useState<FulfillmentReviewResult | null>(null);
  const [reason, setReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [completionMessage, setCompletionMessage] = useState<string | null>(null);
  const previewMutation = useMutation({
    mutationFn: () => requestFulfillmentReviewRetry(buildFulfillmentReviewPreviewRequest(props.scope)),
    retry: false,
    onMutate: () => {
      setPreview(null);
      setReason("");
      setConfirmOpen(false);
      setErrorMessage(null);
      setCompletionMessage(null);
    },
    onSuccess: setPreview,
    onError: (error) => setErrorMessage(fulfillmentReviewFailureMessage(error, "preview")),
  });
  const executeMutation = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error("A fresh preview is required.");
      return requestFulfillmentReviewRetry(buildFulfillmentReviewRetryRequest(props.scope, preview, reason));
    },
    retry: false,
    onSuccess: async (result) => {
      const message = result.replayed
        ? "This recheck was already requested. No additional recheck was queued."
        : "One recheck was queued. The worker will verify the package and sales-channel evidence before making any update.";
      setConfirmOpen(false);
      setPreview(null);
      setReason("");
      setErrorMessage(null);
      setCompletionMessage(message);
      toast({ title: result.replayed ? "Recheck already requested" : "Shipment recheck queued", description: message });
      try {
        await props.onQueued();
      } catch {
        // Refresh failure must not misrepresent a confirmed queue write as failed.
        setErrorMessage("The recheck was recorded, but this view could not refresh. Reload the Operations Tower to see its current status.");
      }
    },
    onError: (error) => {
      setConfirmOpen(false);
      setPreview(null);
      setReason("");
      setErrorMessage(fulfillmentReviewFailureMessage(error, "execute"));
    },
  });
  const busy = previewMutation.isPending || executeMutation.isPending;
  const snapshot = preview?.snapshot;
  const orderReference = snapshot?.orderNumber || snapshot?.externalOrderId;
  const canConfirm = preview?.mode === "preview" && preview.eligibleForRecheck && preview.blockers.length === 0;

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label="Sales-channel fulfillment recheck">
      <div>
        <h3 className="font-medium">Recheck sales-channel fulfillment</h3>
        <p className="text-sm text-muted-foreground">Preview this reviewed shipment, then authorize one guarded recheck. This action does not mark it fulfilled or change inventory.</p>
      </div>
      <Button variant="outline" disabled={busy} onClick={() => previewMutation.mutate()}>
        {previewMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
        Preview shipment recheck
      </Button>
      {errorMessage && <p role="alert" className="text-sm text-destructive">{errorMessage}</p>}
      {completionMessage && <p role="status" className="text-sm">{completionMessage}</p>}
      {preview && snapshot && (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Order</dt><dd>{orderReference}</dd>
            <dt className="text-muted-foreground">Sales channel</dt><dd>{snapshot.provider}</dd>
            <dt className="text-muted-foreground">Tracking</dt><dd className="break-all">{snapshot.trackingNumber} ({snapshot.carrier})</dd>
            {snapshot.providerPhysicalShipmentId && <><dt className="text-muted-foreground">Provider shipment</dt><dd>{snapshot.providerPhysicalShipmentId}</dd></>}
            <dt className="text-muted-foreground">Command</dt><dd>{snapshot.commandId} ({snapshot.status})</dd>
          </dl>
          <table className="w-full text-left text-sm">
            <caption className="mb-1 text-left font-medium">Saved package contents</caption>
            <thead><tr><th scope="col">Item</th><th scope="col" className="text-right">This package</th></tr></thead>
            <tbody>{snapshot.items.map((item) => (
              <tr key={item.pushItemId}>
                <td>{item.sku || `Channel line ${item.channelOrderLineId ?? "unavailable"}`}</td>
                <td className="text-right">{item.quantity}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="text-xs text-muted-foreground">These are saved records, not a live provider check. Only this package's quantities are being rechecked.</p>
          {preview.blockers.length > 0 && <ul role="status" className="list-disc space-y-1 pl-5 text-sm">{preview.blockers.map((code) => <li key={code}>{fulfillmentReviewBlockerLabel(code)}</li>)}</ul>}
          {canConfirm && <Button disabled={busy} onClick={() => setConfirmOpen(true)}>Authorize recheck...</Button>}
        </div>
      )}
      <Dialog open={confirmOpen} onOpenChange={(open) => { if (!executeMutation.isPending) setConfirmOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Queue one shipment recheck?</DialogTitle>
            <DialogDescription>Order {orderReference}, tracking {snapshot?.trackingNumber}. The worker will revalidate this package. Queuing a recheck is not confirmation that the sales channel has been updated.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={reasonId}>Reason for recheck (required)</Label>
            <Textarea id={reasonId} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={FULFILLMENT_REVIEW_REASON_LIMIT} disabled={executeMutation.isPending} placeholder="Explain why this reviewed shipment should be checked again." />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={executeMutation.isPending} onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button disabled={!canConfirm || !reason.trim() || busy} onClick={() => executeMutation.mutate()}>
              {executeMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Confirm and queue recheck
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
