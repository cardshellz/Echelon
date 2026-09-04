import { useEffect, useState, type FormEvent } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Store,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  buildDropshipEbayOAuthBrandingUpdateInput,
  buildDropshipEbayOAuthBrandingVerificationInput,
  createDropshipIdempotencyKey,
  fetchJson,
  postJson,
  putJson,
  queryErrorMessage,
  type DropshipEbayOAuthBrandingConfiguration,
  type DropshipEbayOAuthBrandingMutationResponse,
  type DropshipEbayOAuthBrandingResponse,
  type DropshipEbayOAuthBrandingUpdateInput,
  type DropshipEbayOAuthBrandingVerificationInput,
} from "@/lib/dropship-ops-surface";

export const DROPSHIP_EBAY_OAUTH_BRANDING_ADMIN_URL =
  "/api/dropship/admin/integrations/ebay/oauth-branding";
export const DROPSHIP_EBAY_OAUTH_BRANDING_VERIFICATION_URL =
  `${DROPSHIP_EBAY_OAUTH_BRANDING_ADMIN_URL}/external-update-verification`;

type BrandingProviderStatus =
  DropshipEbayOAuthBrandingConfiguration["customerFacingAppName"]["providerStatus"];

export function EbayOAuthBrandingAdminPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useQuery<DropshipEbayOAuthBrandingResponse>({
    queryKey: [DROPSHIP_EBAY_OAUTH_BRANDING_ADMIN_URL],
    queryFn: () =>
      fetchJson<DropshipEbayOAuthBrandingResponse>(
        DROPSHIP_EBAY_OAUTH_BRANDING_ADMIN_URL,
      ),
  });
  const configuration = query.data?.configuration;
  const [draftName, setDraftName] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (configuration) {
      setDraftName(configuration.customerFacingAppName.value);
    }
  }, [
    configuration?.customerFacingAppName.revision,
    configuration?.customerFacingAppName.value,
  ]);

  const updateMutation = useMutation<
    DropshipEbayOAuthBrandingMutationResponse,
    Error,
    DropshipEbayOAuthBrandingUpdateInput
  >({
    mutationFn: (input) =>
      putJson<DropshipEbayOAuthBrandingMutationResponse>(
        DROPSHIP_EBAY_OAUTH_BRANDING_ADMIN_URL,
        input,
      ),
    onSuccess: (result) => {
      queryClient.setQueryData<DropshipEbayOAuthBrandingResponse>(
        [DROPSHIP_EBAY_OAUTH_BRANDING_ADMIN_URL],
        { configuration: result.configuration },
      );
      setDraftName(result.configuration.customerFacingAppName.value);
      toast({
        title: result.idempotentReplay
          ? "Connection name already saved"
          : "Customer-facing app name saved",
        description:
          "Complete the eBay provider step before treating the consent-screen name as updated.",
      });
    },
    onError: (error) => {
      toast({
        title: "Customer-facing app name was not saved",
        description: queryErrorMessage(
          error,
          "The connection-branding update failed.",
        ),
        variant: "destructive",
      });
    },
  });

  const verificationMutation = useMutation<
    DropshipEbayOAuthBrandingMutationResponse,
    Error,
    DropshipEbayOAuthBrandingVerificationInput
  >({
    mutationFn: (input) =>
      postJson<DropshipEbayOAuthBrandingMutationResponse>(
        DROPSHIP_EBAY_OAUTH_BRANDING_VERIFICATION_URL,
        input,
      ),
    onSuccess: (result) => {
      queryClient.setQueryData<DropshipEbayOAuthBrandingResponse>(
        [DROPSHIP_EBAY_OAUTH_BRANDING_ADMIN_URL],
        { configuration: result.configuration },
      );
      toast({
        title: "eBay title marked complete",
        description:
          "The audit history now records that an administrator completed the provider update.",
      });
    },
    onError: (error) => {
      toast({
        title: "eBay title was not marked complete",
        description: queryErrorMessage(
          error,
          "The provider-update confirmation failed.",
        ),
        variant: "destructive",
      });
    },
  });

  if (query.isLoading) return <BrandingPanelSkeleton />;
  if (query.error || !configuration) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          {queryErrorMessage(
            query.error,
            "Connection branding could not be loaded.",
          )}
        </AlertDescription>
      </Alert>
    );
  }

  const normalizedDraft = draftName.trim();
  const draftIsValid =
    normalizedDraft.length > 0 &&
    normalizedDraft.length <= 200 &&
    !containsControlCharacter(normalizedDraft);
  const currentRevision = configuration.customerFacingAppName.revision;
  const savedCustomerFacingAppName =
    configuration.customerFacingAppName.value;
  const nameNeedsSave =
    configuration.customerFacingAppName.source === "default" ||
    configuration.customerFacingAppName.providerStatus === "provider_failed" ||
    normalizedDraft !== configuration.customerFacingAppName.value;
  const saveDisabled =
    !draftIsValid ||
    !nameNeedsSave ||
    updateMutation.isPending ||
    verificationMutation.isPending;

  function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saveDisabled) return;
    updateMutation.mutate(
      buildDropshipEbayOAuthBrandingUpdateInput({
        customerFacingAppName: draftName,
        expectedRevision: currentRevision,
        idempotencyKey: createDropshipIdempotencyKey(
          "admin-ebay-connection-branding",
        ),
      }),
    );
  }

  function markProviderUpdateComplete() {
    verificationMutation.mutate(
      buildDropshipEbayOAuthBrandingVerificationInput({
        expectedRevision: currentRevision,
        idempotencyKey: createDropshipIdempotencyKey(
          "admin-ebay-branding-confirmation",
        ),
      }),
    );
  }

  async function copyRequestedName() {
    try {
      if (!navigator.clipboard) {
        throw new Error("Clipboard access is unavailable in this browser.");
      }
      await navigator.clipboard.writeText(
        savedCustomerFacingAppName,
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      toast({
        title: "Copy failed",
        description:
          error instanceof Error
            ? error.message
            : "The customer-facing app name could not be copied.",
        variant: "destructive",
      });
    }
  }

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="rounded-md bg-purple-50 p-2 text-[#C060E0]">
            <Store className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Connection branding</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Set the app name customers should recognize when they authorize
              the .ops eBay connection.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">eBay</Badge>
          <Badge
            variant="outline"
            className={providerStatusTone(
              configuration.customerFacingAppName.providerStatus,
            )}
          >
            {providerStatusLabel(
              configuration.customerFacingAppName.providerStatus,
            )}
          </Badge>
        </div>
      </div>

      <form className="mt-4" onSubmit={saveName}>
        <Label htmlFor="ebay-customer-facing-app-name">
          Customer-facing app name
        </Label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Input
            id="ebay-customer-facing-app-name"
            value={draftName}
            maxLength={200}
            autoComplete="off"
            onChange={(event) => setDraftName(event.target.value)}
            aria-describedby="ebay-customer-facing-app-name-help"
          />
          <Button
            type="submit"
            className="shrink-0 bg-[#C060E0] hover:bg-[#a94bc9]"
            disabled={saveDisabled}
          >
            {updateMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Save requested name
          </Button>
        </div>
        <p
          id="ebay-customer-facing-app-name-help"
          className="mt-2 text-sm text-muted-foreground"
        >
          Saving records the name for this connection flow. eBay controls the
          consent screen, so its dedicated RuName must use the same Display
          Title.
        </p>
      </form>

      <BrandingProviderStatus configuration={configuration} />

      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild variant="outline" className="gap-2">
          <a
            href={configuration.management.portalUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="h-4 w-4" />
            Continue in eBay
          </a>
        </Button>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          disabled={
            configuration.customerFacingAppName.providerStatus !==
              "pending_external_update" ||
            configuration.status !== "ready" ||
            !configuration.ruName.dedicated ||
            verificationMutation.isPending
          }
          onClick={markProviderUpdateComplete}
        >
          {verificationMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          I updated the eBay Display Title
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="gap-2"
          onClick={() => void copyRequestedName()}
        >
          {copied ? (
            <Check className="h-4 w-4 text-emerald-600" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
          {copied ? "Copied" : "Copy requested name"}
        </Button>
      </div>

      <details className="mt-4 rounded-md border px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">
          Technical connection details
        </summary>
        <dl className="mt-3 grid gap-3 text-sm md:grid-cols-3">
          <ConnectionDetail
            label="RuName"
            value={configuration.ruName.value ?? "Not configured"}
          />
          <ConnectionDetail
            label="eBay keyset"
            value={configuration.clientId.fingerprint ?? "Not configured"}
          />
          <ConnectionDetail
            label="Environment"
            value={
              configuration.environment === "production"
                ? "Production"
                : "Sandbox"
            }
          />
        </dl>
      </details>
    </section>
  );
}

function BrandingProviderStatus({
  configuration,
}: {
  configuration: DropshipEbayOAuthBrandingConfiguration;
}) {
  if (configuration.status !== "ready") {
    return (
      <Alert className="mt-4 border-amber-300 bg-amber-50 text-amber-950">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{configuration.message}</AlertDescription>
      </Alert>
    );
  }

  const providerStatus =
    configuration.customerFacingAppName.providerStatus;
  if (providerStatus === "pending_external_update") {
    const message = configuration.customerFacingAppName.providerResourceChanged
      ? "The dedicated eBay application or RuName changed after the last saved confirmation. Update that RuName's Display Title to the requested name, then mark the step complete again."
      : "Requested name saved. eBay still needs the Display Title updated for the dedicated RuName. Open eBay below, save the same name, then mark the step complete here.";
    return (
      <Alert className="mt-4 border-amber-300 bg-amber-50 text-amber-950">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    );
  }
  if (providerStatus === "manually_verified") {
    return (
      <Alert className="mt-4 border-emerald-200 bg-emerald-50 text-emerald-900">
        <Check className="h-4 w-4" />
        <AlertDescription>
          An administrator confirmed that eBay uses this Display Title.
        </AlertDescription>
      </Alert>
    );
  }
  if (providerStatus === "provider_applied") {
    return (
      <Alert className="mt-4 border-emerald-200 bg-emerald-50 text-emerald-900">
        <Check className="h-4 w-4" />
        <AlertDescription>
          The provider reports that this customer-facing app name is applied.
        </AlertDescription>
      </Alert>
    );
  }
  if (providerStatus === "provider_failed") {
    return (
      <Alert variant="destructive" className="mt-4">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          The provider update failed. Save the name again to retry after the
          underlying provider issue is resolved.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert className="mt-4">
      <AlertCircle className="h-4 w-4" />
      <AlertDescription>
        Save the requested name, then complete the eBay provider step.
      </AlertDescription>
    </Alert>
  );
}

function ConnectionDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 break-all font-mono text-xs">{value}</dd>
    </div>
  );
}

function BrandingPanelSkeleton() {
  return (
    <section className="rounded-md border bg-card p-4">
      <Skeleton className="h-6 w-52" />
      <Skeleton className="mt-3 h-10 w-full" />
      <Skeleton className="mt-3 h-16 w-full" />
    </section>
  );
}

function providerStatusLabel(
  status: BrandingProviderStatus,
): string {
  switch (status) {
    case "pending_external_update":
      return "Action required in eBay";
    case "manually_verified":
      return "Admin confirmed";
    case "provider_applied":
      return "Applied";
    case "provider_failed":
      return "Provider update failed";
    default:
      return "Not configured";
  }
}

function providerStatusTone(
  status: BrandingProviderStatus,
): string {
  if (status === "manually_verified" || status === "provider_applied") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (status === "pending_external_update") {
    return "border-amber-300 bg-amber-50 text-amber-900";
  }
  if (status === "provider_failed") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.charCodeAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
}
