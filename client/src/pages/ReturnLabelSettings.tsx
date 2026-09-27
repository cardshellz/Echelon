import { useCallback, useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { readPreviewResponse } from "@/lib/customer-return-preview";
import { selectedReturnSettingsChannel } from "@/lib/customer-return-label-settings";
import { CustomerReturnLabelSettings } from "@/components/returns/CustomerReturnLabelSettings";
import {
  PreviewError,
  previewSelectClass,
} from "@/components/returns/CustomerReturnPreviewSteps";
import {
  customerReturnLiveStateSchema,
  type CustomerReturnLiveState,
} from "@shared/returns/customer-return-live.contract";
import {
  CUSTOMER_RETURN_PORTAL_PATH,
  CUSTOMER_RETURN_PREVIEW_API_PATH,
} from "@shared/returns/customer-return-portal-paths";

const ignoreSettingsState = () => undefined;

export default function ReturnLabelSettings() {
  const { user } = useAuth();
  const search = useSearch();
  if (!user) return null;
  return (
    <ReturnLabelSettingsWorkspace
      key={`${user.id}:${user.role}:${search}`}
      search={search}
    />
  );
}

function ReturnLabelSettingsWorkspace({ search }: { search: string }) {
  const [catalog, setCatalog] = useState<CustomerReturnLiveState | null>(null);
  const [channelId, setChannelId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const denyAccess = useCallback((message: string) => {
    setCatalog(null);
    setChannelId("");
    setError(message);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setCatalog(null);
    setChannelId("");
    setError(null);
    async function load() {
      try {
        const response = await fetch(
          `${CUSTOMER_RETURN_PREVIEW_API_PATH}/live`,
          {
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const next = await readPreviewResponse(
          response,
          customerReturnLiveStateSchema,
        );
        if (
          new Set(next.shops.map((shop) => shop.channelId)).size !==
          next.shops.length
        ) {
          throw new Error(
            "The configured Shopify shops could not be verified. Please try again.",
          );
        }
        if (controller.signal.aborted) return;
        setCatalog(next);
        setChannelId(selectedReturnSettingsChannel(search, next.shops));
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Return label settings are unavailable.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt, search]);

  const shop = catalog?.shops.find(
    (candidate) => String(candidate.channelId) === channelId,
  );
  return (
    <div
      className="mx-auto max-w-4xl space-y-5 p-4 md:p-6"
      data-testid="return-label-admin-settings"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Return label settings</h1>
          <p className="text-sm text-muted-foreground">
            Configure return shipping for each Shopify shop. Customer access
            remains off.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link
            href={CUSTOMER_RETURN_PORTAL_PATH}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open customer portal
            <span className="sr-only"> (opens in a new tab)</span>
          </Link>
        </Button>
      </header>
      <PreviewError message={error} />
      {loading && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          Checking administrator access and configured shops…
        </p>
      )}
      {!loading && !catalog && (
        <Button
          variant="outline"
          onClick={() => setAttempt((value) => value + 1)}
        >
          <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
          Retry label settings
        </Button>
      )}
      {catalog && catalog.shops.length === 0 && (
        <p role="status">No Shopify shops are configured for returns.</p>
      )}
      {catalog && catalog.shops.length > 0 && (
        <div className="max-w-md space-y-2">
          <Label htmlFor="return-settings-shop">Shopify shop</Label>
          <select
            id="return-settings-shop"
            className={previewSelectClass}
            value={channelId}
            disabled={catalog.shops.length === 1 && Boolean(shop)}
            onChange={(event) => {
              setChannelId(event.target.value);
              setError(null);
            }}
          >
            {!shop && <option value="">Choose a Shopify shop</option>}
            {catalog.shops.map((candidate) => (
              <option key={candidate.channelId} value={candidate.channelId}>
                {candidate.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {shop && (
        <CustomerReturnLabelSettings
          key={shop.channelId}
          channelId={shop.channelId}
          locked={false}
          onState={ignoreSettingsState}
          onAccessDenied={denyAccess}
        />
      )}
    </div>
  );
}
