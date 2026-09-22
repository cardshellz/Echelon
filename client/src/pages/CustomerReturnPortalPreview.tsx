import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Redirect } from "wouter";
import {
  Loader2,
  LockKeyhole,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import {
  assertPreviewOrderMatches,
  readPreviewResponse,
} from "@/lib/customer-return-preview";
import {
  CustomerReturnFlow,
  type CustomerReturnFlowGateway,
} from "@/components/returns/CustomerReturnFlow";
import {
  PreviewError,
  previewSelectClass,
} from "@/components/returns/CustomerReturnPreviewSteps";
import {
  returnPortalPreviewStateSchema,
  returnPreviewLookupInputSchema,
  returnPreviewOrderSchema,
  returnPreviewReviewInputSchema,
  returnPreviewReviewSchema,
  type ReturnPortalPreviewState,
} from "@shared/returns/customer-return-preview.contract";
import {
  CUSTOMER_RETURN_PORTAL_ACCESS_PATH,
  CUSTOMER_RETURN_PREVIEW_API_PATH,
} from "@shared/returns/customer-return-portal-paths";

export default function CustomerReturnPortalPreview() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <PortalLoading />;
  if (!user) return <Redirect to={CUSTOMER_RETURN_PORTAL_ACCESS_PATH} />;
  // Server authority is fresh; session role strings are not authorization.
  // Drafts never survive switching the authenticated identity.
  return <PortalWorkspace key={`${user.id}:${user.role}`} />;
}

function PortalWorkspace() {
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
        const response = await fetch(CUSTOMER_RETURN_PREVIEW_API_PATH, {
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
        ) {
          throw new Error(
            "The test scenarios could not be verified. Please try again.",
          );
        }
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
  const gateway = useMemo<CustomerReturnFlowGateway | null>(() => {
    if (!scenario) return null;
    return {
      async lookup(reference, signal) {
        const input = returnPreviewLookupInputSchema.parse({
          scenarioId: scenario.id,
          orderReference: reference,
        });
        const response = await fetch(
          `${CUSTOMER_RETURN_PREVIEW_API_PATH}/order`,
          {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          },
        );
        const order = await readPreviewResponse(
          response,
          returnPreviewOrderSchema,
        );
        assertPreviewOrderMatches(order, scenario.id, reference);
        return order;
      },
      async review(rawInput, signal) {
        const input = returnPreviewReviewInputSchema.parse(rawInput);
        if (input.scenarioId !== scenario.id)
          throw new Error("The test order changed. Find the order again.");
        const response = await fetch(
          `${CUSTOMER_RETURN_PREVIEW_API_PATH}/review`,
          {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          },
        );
        return readPreviewResponse(response, returnPreviewReviewSchema);
      },
    };
  }, [scenario]);

  return (
    <main
      className="min-h-screen bg-slate-50 px-4 py-6 text-slate-900 sm:py-10"
      data-testid="standalone-return-portal"
    >
      <title>Returns | Card Shellz</title>
      <div className="mx-auto max-w-3xl space-y-5">
        {state && scenario && (
          <aside
            className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-slate-600"
            aria-label="Private testing controls"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1.5">
                <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
                Private testing · Sample data
              </span>
              <span>Customer access is off</span>
            </div>
            <details className="mt-3">
              <summary className="flex min-h-8 cursor-pointer items-center gap-2 text-sm font-medium">
                <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                Testing controls
              </summary>
              <div className="space-y-3 border-t pt-3">
                <Label htmlFor="portal-test-scenario">Sample order</Label>
                <select
                  id="portal-test-scenario"
                  className={previewSelectClass}
                  value={scenarioId}
                  onChange={(event) => setScenarioId(event.target.value)}
                >
                  {state.scenarios.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </option>
                  ))}
                </select>
                <p className="text-sm">{scenario.description}</p>
                <p className="text-xs leading-relaxed">
                  Live Shopify lookup, return creation, ShipStation labels and
                  warehouse receiving still require their backend integrations.
                  This private gate remains in place when those are connected.
                </p>
              </div>
            </details>
            <p id="return-testing-status" className="mt-2 text-xs">
              Sample orders only. No returns, labels or refunds are created.
            </p>
          </aside>
        )}
        {loading && <PortalLoading embedded />}
        {error && (
          <section
            className="space-y-4 rounded-xl border bg-white p-6"
            aria-label="Portal access status"
          >
            <h1 className="text-xl font-semibold">Card Shellz returns</h1>
            <PreviewError message={error} />
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                onClick={() => setAttempt((value) => value + 1)}
              >
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                Retry access
              </Button>
              <Button variant="ghost" asChild>
                <Link href={CUSTOMER_RETURN_PORTAL_ACCESS_PATH}>
                  Sign in again
                </Link>
              </Button>
            </div>
          </section>
        )}
        {state && scenario && gateway && (
          <CustomerReturnFlow
            key={`${attempt}:${scenario.id}`}
            initialOrderReference={scenario.orderReference}
            gateway={gateway}
            onAccessDenied={denyAccess}
          />
        )}
      </div>
    </main>
  );
}

function PortalLoading({ embedded = false }: { embedded?: boolean }) {
  return (
    <div
      role="status"
      className={`flex items-center justify-center gap-3 bg-slate-50 p-12 text-sm text-slate-600 ${embedded ? "rounded-xl border" : "min-h-screen"}`}
    >
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
      Checking private access…
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The private portal is temporarily unavailable. Please try again.";
}
