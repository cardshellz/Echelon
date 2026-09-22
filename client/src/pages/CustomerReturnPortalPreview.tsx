import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  FlaskConical,
  Loader2,
  LockKeyhole,
  Package,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import {
  assertPreviewOrderMatches,
  assertPreviewReviewMatches,
  buildPreviewReviewInput,
  initialPreviewSelections,
  normalizedPreviewReference,
  PreviewAccessError,
  readPreviewResponse,
  samePreviewQuantities,
  singlePreviewParcel,
  validatePreviewSelections,
  type PreviewParcelDraft,
  type PreviewSelectionDraft,
} from "@/lib/customer-return-preview";
import {
  returnPortalPreviewStateSchema,
  returnPreviewLookupInputSchema,
  returnPreviewOrderSchema,
  returnPreviewReviewSchema,
  type ReturnPortalPreviewState,
  type ReturnPreviewOrder,
  type ReturnPreviewReview,
} from "@shared/returns/customer-return-preview.contract";
import {
  PreviewError,
  PreviewItems,
  PreviewPacking,
  PreviewPromises,
  PreviewReview,
  previewSelectClass,
} from "@/components/returns/CustomerReturnPreviewSteps";

const previewApi = "/api/returns/admin/portal-preview";
type Scenario = ReturnPortalPreviewState["scenarios"][number];
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
    : "The preview could not be loaded. Please try again.";
}

export default function CustomerReturnPortalPreview() {
  const { user } = useAuth();
  // Keep draft and request state scoped to the current staff identity, outside the query cache.
  return user ? <PreviewWorkspace key={`${user.id}:${user.role}`} /> : null;
}

function PreviewWorkspace() {
  const [state, setState] = useState<ReturnPortalPreviewState | null>(null);
  const [scenarioId, setScenarioId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    setError(null);
    setLoading(true);
    async function load() {
      try {
        const response = await fetch(previewApi, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        const parsed = await readPreviewResponse(
          response,
          returnPortalPreviewStateSchema,
        );
        if (
          new Set(parsed.scenarios.map((scenario) => scenario.id)).size !==
          parsed.scenarios.length
        )
          throw new Error(
            "The sample scenarios could not be verified. Please try again.",
          );
        if (!controller.signal.aborted) {
          setState(parsed);
          setScenarioId(parsed.scenarios[0].id);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt]);
  const denyAccess = useCallback((message: string) => {
    setState(null);
    setError(message);
    setLoading(false);
  }, []);
  const scenario = state?.scenarios.find(
    (candidate) => candidate.id === scenarioId,
  );
  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
      <header className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Returns · Admin workspace
            </p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Customer returns preview
            </h1>
          </div>
          <Badge variant="secondary" className="gap-2 px-3 py-1.5">
            <LockKeyhole aria-hidden="true" className="h-3.5 w-3.5" />
            Customer access is off
          </Badge>
        </div>
        <div className="rounded-xl border bg-card p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <FlaskConical
              aria-hidden="true"
              className="mt-0.5 h-5 w-5 shrink-0 text-primary"
            />
            <div className="min-w-0">
              <h2 className="font-semibold">Sample orders</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                Test the customer journey before launch. This preview uses
                sample data and makes no changes to orders.
              </p>
              <p
                id="preview-readiness"
                className="mt-3 text-xs leading-relaxed text-muted-foreground"
              >
                Live customer verification, Shopify order lookup, return
                creation, ShipStation labels, and warehouse receiving are not
                connected in this preview. Customer access stays off.
              </p>
            </div>
          </div>
          {state && scenario && (
            <div className="mt-5 grid gap-3 border-t pt-4 sm:grid-cols-[minmax(0,280px)_minmax(0,1fr)] sm:items-end">
              <div className="min-w-0 space-y-2">
                <Label htmlFor="preview-scenario">Sample order</Label>
                <select
                  id="preview-scenario"
                  className={previewSelectClass}
                  value={scenarioId}
                  onChange={(event) => setScenarioId(event.target.value)}
                >
                  {state.scenarios.map((candidate) => (
                    <option value={candidate.id} key={candidate.id}>
                      {candidate.title}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {scenario.description}
              </p>
            </div>
          )}
        </div>
      </header>
      {loading && (
        <div
          role="status"
          className="flex items-center justify-center gap-3 rounded-xl border bg-card p-12 text-sm text-muted-foreground"
        >
          <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />
          Loading sample orders…
        </div>
      )}
      {error && (
        <div className="space-y-3">
          <PreviewError message={error} />
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry preview
          </Button>
        </div>
      )}
      {state && scenario && (
        <CustomerCanvas
          key={`${attempt}:${scenario.id}`}
          scenario={scenario}
          onAccessDenied={denyAccess}
        />
      )}
    </div>
  );
}

function CustomerCanvas({
  scenario,
  onAccessDenied,
}: {
  scenario: Scenario;
  onAccessDenied: (message: string) => void;
}) {
  const [step, setStep] = useState<Step>("find");
  const [reference, setReference] = useState(
    normalizedPreviewReference(scenario.orderReference),
  );
  const [order, setOrder] = useState<ReturnPreviewOrder | null>(null);
  const [drafts, setDrafts] = useState<PreviewSelectionDraft[]>([]);
  const [parcels, setParcels] = useState<PreviewParcelDraft[]>([]);
  const [review, setReview] = useState<ReturnPreviewReview | null>(null);
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
    // Leave initial page entry at the admin frame; later steps start at the
    // canvas top even when the prior step ended below the mobile viewport.
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
    else setError(errorMessage(cause));
  }

  async function findOrder() {
    const input = returnPreviewLookupInputSchema.safeParse({
      scenarioId: scenario.id,
      orderReference: reference,
    });
    if (!input.success || !normalizedPreviewReference(reference)) {
      setError("Enter an order number to continue.");
      return;
    }
    const { controller, sequence } = beginRequest();
    try {
      const response = await fetch(`${previewApi}/order`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input.data),
      });
      const found = await readPreviewResponse(
        response,
        returnPreviewOrderSchema,
      );
      assertPreviewOrderMatches(found, scenario.id, reference);
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
      const response = await fetch(`${previewApi}/review`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input.value),
      });
      const checked = await readPreviewResponse(
        response,
        returnPreviewReviewSchema,
      );
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
        <span className="rounded-full border border-white/20 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-300">
          Preview
        </span>
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
          <h2
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
          >
            {headings[step]}
          </h2>
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
                  maxLength={256}
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
            <PreviewReview order={order} review={review} onBack={() => back("packing")} />
          )}
        </div>
      </div>
    </section>
  );
}
