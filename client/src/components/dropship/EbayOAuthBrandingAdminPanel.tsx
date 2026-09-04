import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  RefreshCw,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  fetchJson,
  type DropshipEbayOAuthBrandingConfiguration,
  type DropshipEbayOAuthBrandingResponse,
} from "@/lib/dropship-ops-surface";

export const DROPSHIP_EBAY_OAUTH_BRANDING_ADMIN_URL =
  "/api/dropship/admin/integrations/ebay/oauth-branding";

export function EbayOAuthBrandingAdminPanel() {
  const query = useQuery<DropshipEbayOAuthBrandingResponse>({
    queryKey: [DROPSHIP_EBAY_OAUTH_BRANDING_ADMIN_URL],
    queryFn: () =>
      fetchJson<DropshipEbayOAuthBrandingResponse>(
        DROPSHIP_EBAY_OAUTH_BRANDING_ADMIN_URL,
      ),
  });

  if (query.isLoading) {
    return <BrandingPanelSkeleton />;
  }

  if (query.error || !query.data) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          {query.error instanceof Error
            ? query.error.message
            : "eBay OAuth branding configuration could not be loaded."}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <BrandingConfigurationPanel
      configuration={query.data.configuration}
      isRefreshing={query.isFetching}
      onRefresh={() => void query.refetch()}
    />
  );
}

function BrandingConfigurationPanel({
  configuration,
  isRefreshing,
  onRefresh,
}: {
  configuration: DropshipEbayOAuthBrandingConfiguration;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  const BrandingAlertIcon =
    configuration.status === "ready" ? CheckCircle2 : AlertCircle;

  return (
    <div className="space-y-5">
      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-[#C060E0]" />
              <h2 className="text-lg font-semibold">
                eBay .ops consent branding
              </h2>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Identify the exact RuName used when a vendor connects an eBay
              store, then manage its customer-facing consent title in eBay.
            </p>
          </div>
          <Badge
            variant="outline"
            className={brandingStatusTone(configuration.status)}
          >
            {brandingStatusLabel(configuration.status)}
          </Badge>
        </div>

        <Alert className={`mt-4 ${brandingAlertTone(configuration.status)}`}>
          <BrandingAlertIcon className="h-4 w-4" />
          <AlertDescription>{configuration.message}</AlertDescription>
        </Alert>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <ConfigurationFact
            label="Suggested Display Title"
            value={configuration.suggestedDisplayTitle}
            copyValue={configuration.suggestedDisplayTitle}
          />
          <ConfigurationFact
            label="Active RuName"
            value={configuration.ruName.value ?? "Not configured"}
            detail={configuration.ruName.source ?? undefined}
            copyValue={configuration.ruName.value ?? undefined}
            monospace
          />
          <ConfigurationFact
            label="eBay keyset"
            value={configuration.clientId.fingerprint ?? "Not configured"}
            detail={configuration.clientId.source ?? undefined}
            monospace
          />
          <ConfigurationFact
            label="Environment"
            value={
              configuration.environment === "production"
                ? "Production"
                : "Sandbox"
            }
          />
        </div>
      </section>

      <section className="rounded-md border bg-card p-4">
        <h2 className="text-lg font-semibold">Update the consent title</h2>
        <p className="mt-1 max-w-4xl text-sm text-muted-foreground">
          eBay does not expose the saved RuName Display Title through a public
          read or write API. This screen therefore cannot safely claim that it
          changed or verified the title. Use the exact RuName above in eBay's
          Developer Portal.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge variant="outline">
            API read:{" "}
            {configuration.management.displayTitleReadableByApi
              ? "available"
              : "unavailable"}
          </Badge>
          <Badge variant="outline">
            API update:{" "}
            {configuration.management.displayTitleWritableByApi
              ? "available"
              : "unavailable"}
          </Badge>
        </div>

        <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm">
          <li>Open the {configuration.environment} application keyset.</li>
          <li>
            Open User Tokens, then Get a Token from eBay via Your Application.
          </li>
          <li>
            Select the exact RuName shown above and set Display Title to the
            customer-facing name.
          </li>
          <li>
            Save in eBay, then run a new .ops connection or reauthorization
            to verify the consent screen.
          </li>
        </ol>

        {!configuration.ruName.dedicated && (
          <Alert className="mt-4 border-amber-300 bg-amber-50 text-amber-950">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              The shared <code>EBAY_RUNAME</code> is active. Do not rename that
              RuName if other Echelon flows use it. Create a dedicated RuName
              in eBay and set <code>EBAY_VENDOR_RUNAME</code> in the deployment
              first.
            </AlertDescription>
          </Alert>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]">
            <a
              href={configuration.management.portalUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="h-4 w-4" />
              Manage Display Title in eBay
            </a>
          </Button>
          <Button asChild variant="outline" className="gap-2">
            <a
              href={configuration.management.documentationUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="h-4 w-4" />
              eBay RuName documentation
            </a>
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            disabled={isRefreshing}
            onClick={onRefresh}
          >
            <RefreshCw
              className={isRefreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"}
            />
            {isRefreshing ? "Refreshing" : "Refresh configuration"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function ConfigurationFact({
  copyValue,
  detail,
  label,
  monospace = false,
  value,
}: {
  copyValue?: string;
  detail?: string;
  label: string;
  monospace?: boolean;
  value: string;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!copyValue) return;
    try {
      if (!navigator.clipboard) {
        throw new Error("Clipboard API is unavailable in this browser.");
      }
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      toast({
        title: "Copy failed",
        description:
          error instanceof Error ? error.message : "The value could not be copied.",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="min-w-0 rounded-md border p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-2">
        <div
          className={`min-w-0 flex-1 break-all font-medium ${monospace ? "font-mono text-sm" : ""}`}
          title={value}
        >
          {value}
        </div>
        {copyValue && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label={copied ? `${label} copied` : `Copy ${label}`}
            onClick={copy}
          >
            {copied ? (
              <Check className="h-4 w-4 text-emerald-600" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>
      {detail && (
        <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
          Source: {detail}
        </div>
      )}
    </div>
  );
}

function BrandingPanelSkeleton() {
  return (
    <section className="rounded-md border bg-card p-4">
      <Skeleton className="h-6 w-64" />
      <Skeleton className="mt-3 h-16 w-full" />
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
    </section>
  );
}

function brandingStatusLabel(
  status: DropshipEbayOAuthBrandingConfiguration["status"],
): string {
  if (status === "ready") return "Dedicated RuName";
  if (status === "attention_required") return "Shared RuName";
  return "Configuration blocked";
}

function brandingStatusTone(
  status: DropshipEbayOAuthBrandingConfiguration["status"],
): string {
  if (status === "ready") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (status === "attention_required") {
    return "border-amber-300 bg-amber-50 text-amber-900";
  }
  return "border-rose-200 bg-rose-50 text-rose-800";
}

function brandingAlertTone(
  status: DropshipEbayOAuthBrandingConfiguration["status"],
): string {
  if (status === "ready") {
    return "border-emerald-200 bg-emerald-50 text-emerald-900";
  }
  if (status === "attention_required") {
    return "border-amber-300 bg-amber-50 text-amber-950";
  }
  return "border-rose-200 bg-rose-50 text-rose-900";
}
