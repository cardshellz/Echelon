import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Loader2, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  assertReturnFlowOrderMatches,
  assertPreviewReviewMatches,
  buildPreviewReviewInput,
  initialPreviewSelections,
  normalizedPreviewReference,
  PreviewAccessError,
  ReturnSourceChangedError,
  samePreviewQuantities,
  singlePreviewParcel,
  validatePreviewSelections,
  type PreviewParcelDraft,
  type PreviewSelectionDraft,
} from "@/lib/customer-return-preview";
import type {
  CustomerReturnFlowOrder,
  CustomerReturnFlowReview,
} from "@shared/returns/customer-return-flow.contract";
import type { CustomerReturnFlowGateway } from "@/lib/customer-return-gateway";
export type { CustomerReturnFlowGateway } from "@/lib/customer-return-gateway";
import {
  PreviewError,
  PreviewItems,
  PreviewPacking,
  PreviewPromises,
  PreviewReview,
} from "@/components/returns/CustomerReturnPreviewSteps";

export interface CustomerReturnFlowProps {
  initialOrderReference: string;
  gateway: CustomerReturnFlowGateway;
  onAccessDenied: (message: string) => void;
}

const MAX_ORDER_REFERENCE_LENGTH = 256;
type Step = "find" | "items" | "packing" | "review";
const steps: { id: Step; label: string }[] = [
  { id: "find", label: "Find order" },
  { id: "items", label: "Select items" },
  { id: "packing", label: "Pack return" },
  { id: "review", label: "Review" },
];
const headings: Record<Step, string> = {
  find: "Let's find your order",
  items: "What would you like to return?",
  packing: "How will you pack your return?",
  review: "Review your return",
};
function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Your return could not be loaded. Please try again.";
}

// The host keys this component by customer/order context. Gateways own transport,
// access control and DTO parsing; the flow verifies replies match current intent.
export function CustomerReturnFlow({
  initialOrderReference,
  gateway,
  onAccessDenied,
}: CustomerReturnFlowProps) {
  const [step, setStep] = useState<Step>("find");
  const [reference, setReference] = useState(
    normalizedPreviewReference(initialOrderReference),
  );
  const [order, setOrder] = useState<CustomerReturnFlowOrder | null>(null);
  const [drafts, setDrafts] = useState<PreviewSelectionDraft[]>([]);
  const [parcels, setParcels] = useState<PreviewParcelDraft[]>([]);
  const [review, setReview] = useState<CustomerReturnFlowReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef<Step>(step);
  const request = useRef<{
    sequence: number;
    controller: AbortController | null;
  }>({ sequence: 0, controller: null });
  useEffect(
    () => () => {
      request.current.sequence++;
      request.current.controller?.abort();
    },
    [],
  );
  useEffect(() => {
    // Preserve initial page position; later steps start at the flow top even
    // when the prior step ended below the mobile viewport.
    if (previousStep.current === step) return;
    previousStep.current = step;
    canvas.current?.scrollIntoView({ block: "start", behavior: "auto" });
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  function invalidateRequest() {
    request.current.sequence++;
    request.current.controller?.abort();
    request.current.controller = null;
    setBusy(false);
  }
  function beginRequest() {
    invalidateRequest();
    const controller = new AbortController();
    request.current.controller = controller;
    setBusy(true);
    setError(null);
    return { controller, sequence: request.current.sequence };
  }
  function current(sequence: number, controller: AbortController) {
    return request.current.sequence === sequence && !controller.signal.aborted;
  }
  function fail(cause: unknown) {
    if (cause instanceof PreviewAccessError) onAccessDenied(cause.message);
    else if (cause instanceof ReturnSourceChangedError) {
      setOrder(null);
      setDrafts([]);
      setParcels([]);
      setReview(null);
      setStep("find");
      setError(cause.message);
    } else setError(errorMessage(cause));
  }

  async function findOrder() {
    if (
      reference.length > MAX_ORDER_REFERENCE_LENGTH ||
      !normalizedPreviewReference(reference)
    ) {
      setError("Enter an order number to continue.");
      return;
    }
    const { controller, sequence } = beginRequest();
    try {
      const found = await gateway.lookup(reference, controller.signal);
      assertReturnFlowOrderMatches(found, reference);
      if (!current(sequence, controller)) return;
      setOrder(found);
      setDrafts(initialPreviewSelections(found));
      setParcels([]);
      setReview(null);
      setStep("items");
    } catch (cause) {
      if (current(sequence, controller)) fail(cause);
    } finally {
      if (current(sequence, controller)) setBusy(false);
    }
  }
  function updateDrafts(next: PreviewSelectionDraft[]) {
    if (!samePreviewQuantities(drafts, next)) setParcels([]);
    setDrafts(next);
    setReview(null);
    setError(null);
  }
  function continueToPacking() {
    if (!order) return;
    const selected = validatePreviewSelections(order, drafts);
    if (!selected.ok) {
      setError(selected.message);
      return;
    }
    if (!parcels.length) setParcels(singlePreviewParcel(selected.value));
    setReview(null);
    setError(null);
    setStep("packing");
  }
  async function reviewReturn() {
    if (!order) return;
    setReview(null);
    const selected = validatePreviewSelections(order, drafts);
    if (!selected.ok) {
      setError(selected.message);
      return;
    }
    const input = buildPreviewReviewInput(order, selected.value, parcels);
    if (!input.ok) {
      setError(input.message);
      return;
    }
    const { controller, sequence } = beginRequest();
    try {
      const checked = await gateway.review(input.value, controller.signal);
      assertPreviewReviewMatches(checked, input.value);
      if (!current(sequence, controller)) return;
      setReview(checked);
      setStep("review");
    } catch (cause) {
      if (current(sequence, controller)) fail(cause);
    } finally {
      if (current(sequence, controller)) setBusy(false);
    }
  }
  function back(to: Step) {
    invalidateRequest();
    setReview(null);
    setError(null);
    setStep(to);
    if (to === "find") {
      setOrder(null);
      setDrafts([]);
      setParcels([]);
    }
  }
  const selected = order ? validatePreviewSelections(order, drafts) : null;
  const stepIndex = steps.findIndex((candidate) => candidate.id === step);
  return (
    <section
      ref={canvas}
      data-testid="preview-canvas"
      aria-label="Customer return experience"
      className="mx-auto w-full max-w-3xl scroll-mt-20 overflow-hidden rounded-2xl border bg-card shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-950 px-5 py-5 text-white sm:px-8">
        <div className="flex items-center gap-2.5">
          <Package aria-hidden="true" className="h-6 w-6 text-blue-400" />
          <span className="text-lg font-bold tracking-tight">CARD SHELLZ</span>
          <span className="ml-1 border-l border-white/20 pl-3 text-sm text-slate-300">
            Returns
          </span>
        </div>
      </div>
      <div className="p-5 sm:p-8">
        <ol aria-label="Return steps" className="mb-8 grid grid-cols-4 gap-2">
          {steps.map((candidate, index) => (
            <li
              key={candidate.id}
              aria-current={step === candidate.id ? "step" : undefined}
              className={cn(
                "min-w-0 space-y-2 border-t-2 pt-3",
                index <= stepIndex ? "border-primary" : "border-muted",
              )}
            >
              <div className="flex items-center gap-1 text-xs font-medium">
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]",
                    index <= stepIndex
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {index < stepIndex ? (
                    <Check aria-hidden="true" className="h-3 w-3" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span
                  className={
                    index === stepIndex
                      ? "text-foreground"
                      : "text-muted-foreground"
                  }
                >
                  {candidate.label}
                </span>
              </div>
            </li>
          ))}
        </ol>
        <div className="mb-6 space-y-2">
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
          >
            {headings[step]}
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {step === "find"
              ? "Start with the order number from your confirmation."
              : step === "items"
                ? "Choose the items and quantities you want to send back."
                : step === "packing"
                  ? "Tell us what goes in each box so every item is accounted for."
                  : "Check your items and boxes before the next step."}
          </p>
          {order && (
            <p className="pt-1 text-xs font-medium text-muted-foreground">
              Order #{normalizedPreviewReference(order.orderReference)}
            </p>
          )}
        </div>
        <div className="space-y-5">
          <PreviewError message={error} />
          {step === "find" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void findOrder();
              }}
              className="space-y-5"
            >
              <div className="space-y-2">
                <Label htmlFor="preview-order-reference">Order number</Label>
                <Input
                  id="preview-order-reference"
                  autoComplete="off"
                  className="min-h-12"
                  value={reference}
                  maxLength={MAX_ORDER_REFERENCE_LENGTH}
                  disabled={busy}
                  onChange={(event) => {
                    setReference(event.target.value);
                    setError(null);
                  }}
                  aria-describedby="preview-order-help"
                />
                <p
                  id="preview-order-help"
                  className="text-xs leading-relaxed text-muted-foreground"
                >
                  You can enter the number with or without the #.
                </p>
              </div>
              <Button type="submit" className="min-h-12 w-full" disabled={busy}>
                {busy ? (
                  <>
                    <Loader2
                      aria-hidden="true"
                      className="mr-2 h-4 w-4 animate-spin"
                    />
                    Finding your order…
                  </>
                ) : (
                  <>
                    Find order
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
              <PreviewPromises />
            </form>
          )}
          {step === "items" && order && (
            <PreviewItems
              order={order}
              drafts={drafts}
              onChange={updateDrafts}
              onContinue={continueToPacking}
              onBack={() => back("find")}
            />
          )}
          {step === "packing" && order && selected?.ok && (
            <PreviewPacking
              order={order}
              selections={selected.value}
              parcels={parcels}
              busy={busy}
              onChange={(next) => {
                setParcels(next);
                setReview(null);
                setError(null);
              }}
              onContinue={() => void reviewReturn()}
              onBack={() => back("items")}
            />
          )}
          {step === "review" && review && order && (
            <PreviewReview
              order={order}
              review={review}
              onBack={() => back("packing")}
            />
          )}
        </div>
      </div>
    </section>
  );
}
