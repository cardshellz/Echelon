import { Button } from "@/components/ui/button";
import { useEffect, useRef } from "react";
import { Package, Loader2 } from "lucide-react";
import type { ReturnLabelSessionState } from "@/lib/customer-return-label-session";
import { PreviewError } from "./CustomerReturnPreviewSteps";

const parcelStatus = {
  pending: "Your label is waiting to be prepared.",
  processing:
    "We are checking whether this label was created. Check status before trying again.",
  ready: "Ready to download.",
  needs_review:
    "This label needs verification. Check status or contact support for help.",
  failed: "This label could not be prepared. Please contact support for help.",
};

export function CustomerReturnLabels({
  state,
  onCheck,
  onFinish,
  onDownload,
}: {
  state: ReturnLabelSessionState;
  onCheck: () => void;
  onFinish: () => void;
  onDownload: (parcelId: number) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.scrollIntoView({ block: "start", behavior: "auto" });
    heading.current?.focus({ preventScroll: true });
  }, []);
  const complete = Boolean(
    state.status?.parcels.every((parcel) => parcel.status === "ready"),
  );
  return (
    <section
      className="overflow-hidden rounded-2xl border bg-card shadow-sm"
      aria-labelledby="return-labels-title"
      data-testid="return-labels"
    >
      <div className="flex items-center gap-2.5 bg-slate-950 px-4 py-4 text-white sm:px-6">
        <Package aria-hidden="true" className="h-6 w-6 text-blue-400" />
        <span className="text-lg font-bold">CARD SHELLZ</span>
        <span className="border-l border-white/20 pl-3 text-sm text-slate-300">
          Returns
        </span>
      </div>
      <div className="space-y-5 p-4 sm:p-6">
        <div className="space-y-2">
          <h1
            id="return-labels-title"
            ref={heading}
            tabIndex={-1}
            className="scroll-mt-6 text-xl font-semibold outline-none"
          >
            {state.status ? "Your return labels" : "Checking your return"}
          </h1>
          {state.status ? (
            <>
              <p className="text-sm font-medium">
                Return {state.status.authorizationNumber}
              </p>
              <p className="text-sm text-muted-foreground">
                Use a separate label for each box. Your items and box plan are
                saved.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              We are confirming your request. Keep this return unchanged until
              the result is known.
            </p>
          )}
        </div>
        <PreviewError message={state.error} />
        {state.busy && (
          <p role="status" className="flex items-center gap-2 text-sm">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            Preparing or checking your labels…
          </p>
        )}
        {state.status?.parcels.map((parcel) => (
          <section
            key={parcel.parcelId}
            data-testid={`return-label-box-${parcel.number}`}
            className="space-y-3 rounded-xl border p-4"
          >
            <h2 className="font-semibold">Box {parcel.number}</h2>
            <p role="status" className="text-sm text-muted-foreground">
              {parcelStatus[parcel.status]}
            </p>
            {parcel.status === "ready" && parcel.trackingNumber && (
              <p className="break-all text-sm">
                Tracking: {parcel.trackingNumber}
              </p>
            )}
            {parcel.status === "ready" && parcel.downloadPath && (
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => onDownload(parcel.parcelId)}
              >
                Download label for box {parcel.number}
              </Button>
            )}
          </section>
        ))}
        <div className="flex flex-wrap gap-3 border-t pt-4">
          <Button variant="outline" disabled={state.busy} onClick={onCheck}>
            Check label status
          </Button>
          {complete && (
            <Button variant="ghost" disabled={state.busy} onClick={onFinish}>
              Start another return
            </Button>
          )}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Our team inspects returned items and reviews any refund in Shopify.
          Creating a label does not issue a refund.
        </p>
      </div>
    </section>
  );
}
