import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, Redirect } from "wouter";
import { z } from "zod";
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
  PreviewAccessError,
  readPreviewResponse,
} from "@/lib/customer-return-preview";
import {
  createLiveReturnGateway,
  createSampleReturnGateway,
} from "@/lib/customer-return-gateway";
import { CustomerReturnFlow } from "@/components/returns/CustomerReturnFlow";
import { CustomerReturnLabelSettings } from "@/components/returns/CustomerReturnLabelSettings";
import { CustomerReturnLabels } from "@/components/returns/CustomerReturnLabels";
import { CustomerReturnLabelSession } from "@/lib/customer-return-label-session";
import {
  createReturnLabelTransport,
  downloadReturnLabel,
  returnLabelsEnabled,
} from "@/lib/customer-return-labels";
import type { CustomerReturnLabelSettingsState } from "@shared/returns/customer-return-label.contract";
import {
  PreviewError,
  previewSelectClass,
} from "@/components/returns/CustomerReturnPreviewSteps";
import {
  returnPortalPreviewStateSchema,
  type ReturnPortalPreviewState,
} from "@shared/returns/customer-return-preview.contract";
import {
  customerReturnLiveReviewInputSchema,
  customerReturnLiveStateSchema,
} from "@shared/returns/customer-return-live.contract";
import type { CustomerReturnFlowReviewInput } from "@shared/returns/customer-return-flow.contract";
import {
  CUSTOMER_RETURN_PORTAL_ACCESS_PATH,
  CUSTOMER_RETURN_PREVIEW_API_PATH,
} from "@shared/returns/customer-return-portal-paths";

type OrderSource = "live" | "sample";
type LiveState = z.infer<typeof customerReturnLiveStateSchema>;

export default function CustomerReturnPortalPreview() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <PortalLoading />;
  if (!user) return <Redirect to={CUSTOMER_RETURN_PORTAL_ACCESS_PATH} />;
  // Fresh server authority controls access; order drafts never survive an identity switch.
  return (
    <PortalWorkspace
      key={`${user.id}:${user.role}`}
      adminId={String(user.id)}
    />
  );
}

function PortalWorkspace({ adminId }: { adminId: string }) {
  const [state, setState] = useState<ReturnPortalPreviewState | null>(null);
  const [source, setSource] = useState<OrderSource>("live");
  const [scenarioId, setScenarioId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [catalog, setCatalog] = useState<LiveState | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [channelId, setChannelId] = useState("");
  const [labelSettings, setLabelSettings] =
    useState<CustomerReturnLabelSettingsState | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloads = useRef(new Set<AbortController>());
  useEffect(
    () => () => {
      downloads.current.forEach((controller) => controller.abort());
    },
    [],
  );

  const denyAccess = useCallback((message: string) => {
    setState(null);
    setCatalog(null);
    setChannelId("");
    setError(message);
    setLoading(false);
    setCatalogLoading(false);
    setLabelSettings(null);
    downloads.current.forEach((controller) => controller.abort());
    setDownloadError(null);
  }, []);

  const [labels] = useState(() => {
    let storage: Storage | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      /* Creation stays closed without a recoverable command key. */
    }
    return new CustomerReturnLabelSession(
      adminId,
      storage,
      createReturnLabelTransport,
      denyAccess,
    );
  });
  const labelSession = useSyncExternalStore(
    labels.subscribe,
    labels.getSnapshot,
  );
  const labelLocked = labelSession.record !== null;
  useEffect(() => {
    labels.activate();
    if (state) void labels.restore();
    return () => labels.dispose();
  }, [labels, state]);

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

  useEffect(() => {
    setCatalog(null);
    setCatalogError(null);
    setChannelId("");
    if (!state || source !== "live") {
      setCatalogLoading(false);
      return;
    }
    const controller = new AbortController();
    setCatalogLoading(true);
    async function loadCatalog() {
      try {
        const response = await fetch(
          `${CUSTOMER_RETURN_PREVIEW_API_PATH}/live`,
          {
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const parsed = await readPreviewResponse(
          response,
          customerReturnLiveStateSchema,
        );
        if (
          new Set(parsed.shops.map((shop) => shop.channelId)).size !==
          parsed.shops.length
        ) {
          throw new Error(
            "The configured Shopify shops could not be verified. Please try again.",
          );
        }
        if (!controller.signal.aborted) {
          setCatalog(parsed);
          const savedChannel = labels.getSnapshot().record?.channelId;
          if (
            savedChannel &&
            parsed.shops.some((shop) => shop.channelId === savedChannel)
          )
            setChannelId(String(savedChannel));
          else if (parsed.shops.length === 1)
            setChannelId(String(parsed.shops[0].channelId));
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof PreviewAccessError) denyAccess(cause.message);
        else setCatalogError(errorMessage(cause));
      } finally {
        if (!controller.signal.aborted) setCatalogLoading(false);
      }
    }
    void loadCatalog();
    return () => controller.abort();
  }, [state, source, catalogAttempt, denyAccess, labels]);

  const scenario = state?.scenarios.find(
    (candidate) => candidate.id === scenarioId,
  );
  const shop = catalog?.shops.find(
    (candidate) => String(candidate.channelId) === channelId,
  );
  const gateway = useMemo(() => {
    if (!state) return null;
    if (source === "sample")
      return scenario ? createSampleReturnGateway(scenario.id) : null;
    if (!shop) return null;
    const settings =
      labelSettings?.channelId === shop.channelId ? labelSettings : null;
    const capability =
      returnLabelsEnabled(settings) &&
      !labelSession.storageBlocked &&
      settings?.settings
        ? {
            create: (input: CustomerReturnFlowReviewInput) =>
              labels.begin({
                ...customerReturnLiveReviewInputSchema.parse({
                  ...input,
                  channelId: shop.channelId,
                }),
                settingsVersion: settings.settings!.version,
              }),
          }
        : undefined;
    return createLiveReturnGateway(shop.channelId, fetch, capability);
  }, [
    state,
    source,
    scenario,
    shop,
    labelSettings,
    labelSession.storageBlocked,
    labels,
  ]);
  function changeSource(next: string) {
    if (labelLocked) return;
    if (next !== "live" && next !== "sample") return;
    setSource(next);
    setCatalog(null);
    setChannelId("");
    setCatalogError(null);
    setLabelSettings(null);
  }
  async function download(parcelId: number) {
    if (!labelSession.status) return;
    const status = labelSession.status;
    const controller = new AbortController();
    downloads.current.add(controller);
    setDownloadError(null);
    try {
      const artifact = await downloadReturnLabel(
        status,
        parcelId,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(artifact);
      const link = document.createElement("a");
      link.href = url;
      link.download = `return-${status.authorizationId}-box-${status.parcels.find((item) => item.parcelId === parcelId)!.number}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof PreviewAccessError) denyAccess(cause.message);
      else setDownloadError(errorMessage(cause));
    } finally {
      downloads.current.delete(controller);
    }
  }

  return (
    <main
      className="min-h-screen bg-slate-50 px-4 py-6 text-slate-900 sm:py-10"
      data-testid="standalone-return-portal"
    >
      <title>Returns | Card Shellz</title>
      <div className="mx-auto max-w-3xl space-y-5">
        {state && (
          <aside
            className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-slate-600"
            aria-label="Private testing controls"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1.5">
                <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
                Private testing ·{" "}
                {source === "live" ? "Live orders" : "Sample data"}
              </span>
              <span>Customer access is off</span>
            </div>
            <details className="mt-3">
              <summary className="flex min-h-8 cursor-pointer items-center gap-2 text-sm font-medium">
                <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                Testing controls
              </summary>
              <div className="space-y-3 border-t pt-3">
                <div className="space-y-2">
                  <Label htmlFor="portal-order-source">Order source</Label>
                  <select
                    id="portal-order-source"
                    className={previewSelectClass}
                    value={source}
                    disabled={labelLocked}
                    onChange={(event) => changeSource(event.target.value)}
                  >
                    <option value="live">Shopify orders</option>
                    <option value="sample">Sample orders</option>
                  </select>
                </div>
                {source === "sample" && scenario && (
                  <div className="space-y-2">
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
                  </div>
                )}
                {source === "live" && catalog && catalog.shops.length > 0 && (
                  <div className="space-y-2">
                    <Label htmlFor="portal-shop">Shopify shop</Label>
                    <select
                      id="portal-shop"
                      className={previewSelectClass}
                      value={channelId}
                      disabled={labelLocked || catalog.shops.length === 1}
                      onChange={(event) => {
                        setLabelSettings(null);
                        setChannelId(event.target.value);
                      }}
                    >
                      {catalog.shops.length > 1 && (
                        <option value="">Choose a Shopify shop</option>
                      )}
                      {catalog.shops.map((candidate) => (
                        <option
                          key={candidate.channelId}
                          value={candidate.channelId}
                        >
                          {candidate.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {source === "live" && shop && (
                  <CustomerReturnLabelSettings
                    key={shop.channelId}
                    channelId={shop.channelId}
                    locked={labelLocked}
                    accepted={labelSession.record?.authorizationId != null}
                    onState={setLabelSettings}
                    onAccessDenied={denyAccess}
                  />
                )}
                <p className="text-xs leading-relaxed">
                  Sample orders never create returns or labels. Live labels
                  require saved, enabled settings for the selected shop.
                  Customer access remains off and refunds remain manual in
                  Shopify.
                </p>
              </div>
            </details>
            <p id="return-testing-status" className="mt-2 text-xs">
              {source === "live"
                ? gateway?.labels
                  ? "Live return creation and label purchases are enabled for this shop. Refunds remain manual."
                  : "Live order lookup and review only. Configure and enable labels in Testing controls to create a return."
                : "Sample orders only. No returns, labels or refunds are created."}
            </p>
            {source === "live" && catalogLoading && (
              <p role="status" className="mt-3 text-sm">
                Loading configured Shopify shops…
              </p>
            )}
            {source === "live" && catalogError && (
              <div className="mt-3 space-y-3">
                <PreviewError message={catalogError} />
                <Button
                  variant="outline"
                  onClick={() => setCatalogAttempt((value) => value + 1)}
                >
                  Retry Shopify shops
                </Button>
              </div>
            )}
            {source === "live" && catalog && catalog.shops.length === 0 && (
              <p role="status" className="mt-3 text-sm">
                No Shopify shops are available for live testing.
              </p>
            )}
            {source === "live" &&
              catalog &&
              catalog.shops.length > 1 &&
              !shop && (
                <p role="status" className="mt-3 text-sm">
                  Choose a Shopify shop in Testing controls to find an order.
                </p>
              )}
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
        {state && !labelLocked && labelSession.error && (
          <PreviewError message={labelSession.error} />
        )}
        {state && labelLocked && (
          <CustomerReturnLabels
            state={{
              ...labelSession,
              error: downloadError ?? labelSession.error,
            }}
            onCheck={() => {
              setDownloadError(null);
              void labels.check();
            }}
            onFinish={() => {
              setDownloadError(null);
              labels.finish();
            }}
            onDownload={(parcelId) => void download(parcelId)}
          />
        )}
        {state && gateway && !labelLocked && (
          <CustomerReturnFlow
            key={`${attempt}:${source}:${source === "live" ? channelId : scenarioId}:${labelSession.revision}`}
            initialOrderReference={
              source === "sample" ? (scenario?.orderReference ?? "") : ""
            }
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
