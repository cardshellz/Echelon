import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Circle,
  Fingerprint,
  Mail,
  Plug,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Store,
  Wallet,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  dropshipPortalPath,
  isDropshipSensitiveProofActive,
  useDropshipAuth,
  type DropshipSensitiveAction,
} from "@/lib/dropship-auth";
import {
  buildStoreConnectionOAuthStartInput,
  fetchJson,
  formatCents,
  formatStatus,
  postJson,
  type DropshipStoreConnectionListResponse,
  type DropshipOnboardingState,
  type DropshipOnboardingStep,
  type DropshipStoreConnectionOAuthStartResponse,
  type DropshipStoreConnectionProfileResponse,
  type DropshipStoreOAuthIntent,
  type DropshipStorePlatform,
} from "@/lib/dropship-ops-surface";
import { DropshipPortalShell } from "./DropshipPortalShell";

type PendingAction = "send-email-code" | "verify-email-code" | "passkey-proof" | "oauth-start" | null;
type PendingActivationAction = "send-email-code" | "verify-email-code" | "passkey-proof" | "activate-account" | null;

const stepIcons: Record<DropshipOnboardingStep["key"], ReactNode> = {
  vendor_profile: <ShieldCheck className="h-4 w-4" />,
  store_connection: <Store className="h-4 w-4" />,
  catalog_available: <Boxes className="h-4 w-4" />,
  catalog_selection: <CheckCircle2 className="h-4 w-4" />,
  wallet_payment: <Wallet className="h-4 w-4" />,
};

export default function DropshipPortalOnboarding() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { principal } = useDropshipAuth();
  const onboardingQuery = useQuery<DropshipOnboardingState>({
    queryKey: ["/api/dropship/onboarding/state"],
    queryFn: () => fetchJson<DropshipOnboardingState>("/api/dropship/onboarding/state"),
    enabled: !!principal,
  });
  const onboarding = onboardingQuery.data;
  const completedStepCount = onboarding?.steps.filter((step) => step.status === "complete").length ?? 0;
  const totalStepCount = onboarding?.steps.length ?? 0;
  const connectionStatus = getStoreConnectionCallbackStatus();

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Plug className="h-6 w-6 text-[#C060E0]" />
              Onboarding
            </h1>
            <p className="mt-1 text-sm text-zinc-500">Connect a marketplace store, confirm catalog access, and complete launch readiness.</p>
          </div>
          {onboarding && (
            <Badge variant="outline" className="w-fit border-zinc-200 bg-white text-zinc-700">
              {completedStepCount} of {totalStepCount} complete
            </Badge>
          )}
        </div>

        {connectionStatus && (
          <Alert className={connectionStatus.kind === "connected" ? "mt-5 border-emerald-200 bg-emerald-50 text-emerald-900" : "mt-5 border-rose-200 bg-rose-50 text-rose-900"}>
            {connectionStatus.kind === "connected" ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
            <AlertDescription>{connectionStatus.message}</AlertDescription>
          </Alert>
        )}

        {onboardingQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {onboardingQuery.error instanceof Error ? onboardingQuery.error.message : "Unable to load onboarding state."}
            </AlertDescription>
          </Alert>
        )}

        {onboardingQuery.isLoading ? (
          <div className="mt-5 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
            <Skeleton className="h-80 w-full" />
            <Skeleton className="h-80 w-full" />
          </div>
        ) : onboarding ? (
          <div className="mt-5 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
            <section className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Launch checklist</h2>
                  <p className="mt-1 text-sm text-zinc-500">
                    {onboarding.vendor.businessName || onboarding.vendor.email || "Card Shellz member"}
                  </p>
                </div>
                <Badge variant="outline">{formatStatus(onboarding.vendor.status)}</Badge>
              </div>

              <div className="mt-5 space-y-3">
                {onboarding.steps.map((step) => (
                  <OnboardingStepRow key={step.key} step={step} />
                ))}
              </div>
            </section>

            <section className="space-y-4">
              <StoreConnectPanel onboarding={onboarding} />

              <div className="grid gap-4 md:grid-cols-3">
                <LaunchGate
                  icon={<Boxes className="h-4 w-4" />}
                  title="Catalog availability"
                  status={onboarding.catalog.adminCatalogAvailable ? "complete" : "incomplete"}
                  value={`${onboarding.catalog.adminExposureRuleCount} admin rule(s)`}
                  detail={onboarding.catalog.adminCatalogAvailable
                    ? "Catalog access is available for vendor selection."
                    : "Catalog exposure must be configured by Card Shellz ops."}
                  actionLabel="Open catalog"
                  onAction={() => setLocation(dropshipPortalPath("/catalog"))}
                />
                <LaunchGate
                  icon={<CheckCircle2 className="h-4 w-4" />}
                  title="Product selection"
                  status={onboarding.catalog.hasVendorSelection ? "complete" : "incomplete"}
                  value={`${onboarding.catalog.vendorSelectionRuleCount} selection rule(s)`}
                  detail={onboarding.catalog.hasVendorSelection
                    ? "Vendor catalog selection exists."
                    : "Select products after catalog access is available."}
                  actionLabel="Manage catalog"
                  onAction={() => setLocation(dropshipPortalPath("/catalog"))}
                />
                <LaunchGate
                  icon={<Wallet className="h-4 w-4" />}
                  title="Wallet and auto-reload"
                  status={onboarding.wallet.walletReady ? "complete" : "incomplete"}
                  value={`${formatCents(onboarding.wallet.availableBalanceCents)} available`}
                  detail={walletGateDetail(onboarding)}
                  actionLabel="Open wallet"
                  onAction={() => setLocation(dropshipPortalPath("/wallet"))}
                />
              </div>

              <ActivationPanel
                onboarding={onboarding}
                onActivated={(state) => {
                  queryClient.setQueryData(["/api/dropship/onboarding/state"], state);
                }}
              />
            </section>
          </div>
        ) : (
          <Empty className="mt-5 rounded-md border border-dashed p-8">
            <EmptyMedia variant="icon"><Plug /></EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No onboarding state</EmptyTitle>
              <EmptyDescription>Dropship onboarding state could not be loaded.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </DropshipPortalShell>
  );
}

function StoreConnectPanel({ onboarding }: { onboarding: DropshipOnboardingState }) {
  const {
    principal,
    sensitiveProofs,
    startEmailStepUp,
    verifyEmailStepUp,
    verifyPasskeyStepUp,
  } = useDropshipAuth();
  const [platform, setPlatform] = useState<DropshipStorePlatform>("ebay");
  const [shopDomain, setShopDomain] = useState("");
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [oauthIntent, setOauthIntent] = useState<DropshipStoreOAuthIntent>("connect");
  const [verificationCode, setVerificationCode] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const connectProofActive = useMemo(() => {
    return isDropshipSensitiveProofActive({
      principal,
      action: "connect_store",
      proof: sensitiveProofs.connect_store,
    });
  }, [principal, sensitiveProofs.connect_store]);
  const storeConnectionsQuery = useQuery<DropshipStoreConnectionListResponse>({
    queryKey: ["/api/dropship/store-connections"],
    queryFn: () => fetchJson<DropshipStoreConnectionListResponse>("/api/dropship/store-connections"),
    enabled: !!principal,
  });
  const reconnectableConnections = storeConnectionsQuery.data?.connections.filter(canReconnectStoreConnection) ?? [];
  const selectedPlatformConnection = reconnectableConnections.find((connection) => (
    connection.platform === platform && canReconnectStoreConnection(connection)
  )) ?? null;
  const occupiedConnection = reconnectableConnections[0] ?? null;
  const canConnectStore = onboarding.storeConnections.canConnectStore;
  const canReconnectSelectedPlatform = selectedPlatformConnection !== null;
  const canStartStoreOAuth = canConnectStore || canReconnectSelectedPlatform;
  const platformName = storePlatformName(platform);
  const defaultOAuthIntent = storeOAuthIntentForConnection(selectedPlatformConnection);
  const activeOAuthIntent = emailCodeSent ? oauthIntent : defaultOAuthIntent;
  const occupiedPlatform = occupiedConnection?.platform ?? null;
  const selectedShopifyDomain = platform === "shopify"
    ? shopDomain.trim() || selectedPlatformConnection?.shopDomain || ""
    : "";
  const shopifyDomainRequired = platform === "shopify" && !selectedShopifyDomain;
  const connectDisabled = !canStartStoreOAuth || shopifyDomainRequired || pendingAction !== null || (!principal?.hasPasskey && emailCodeSent && verificationCode.length !== 6);
  const ebaySelectable = canConnectStore || reconnectableConnections.some((connection) => connection.platform === "ebay");
  const shopifySelectable = canConnectStore || reconnectableConnections.some((connection) => connection.platform === "shopify");
  useEffect(() => {
    if (!canConnectStore && occupiedPlatform && platform !== occupiedPlatform) {
      setPlatform(occupiedPlatform);
    }
  }, [canConnectStore, occupiedPlatform, platform]);
  useEffect(() => {
    if (!emailCodeSent) {
      setOauthIntent(defaultOAuthIntent);
    }
  }, [defaultOAuthIntent, emailCodeSent]);

  async function run(action: PendingAction, task: () => Promise<void>): Promise<boolean> {
    setPendingAction(action);
    setError("");
    setMessage("");
    try {
      await task();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
      return false;
    } finally {
      setPendingAction(null);
    }
  }

  async function startOAuth(requestedIntent: DropshipStoreOAuthIntent = activeOAuthIntent) {
    setOauthIntent(requestedIntent);
    if (!connectProofActive) {
      if (principal?.hasPasskey) {
        const verified = await run("passkey-proof", async () => {
          await verifyPasskeyStepUp("connect_store");
        });
        if (!verified) return;
      } else if (!emailCodeSent) {
        await run("send-email-code", async () => {
          await startEmailStepUp("connect_store");
          setEmailCodeSent(true);
          setVerificationCode("");
          setMessage(`Verification code sent. Enter it below, then ${storeOAuthActionText(requestedIntent, platform)}.`);
        });
        return;
      } else {
        if (verificationCode.length !== 6) {
          setError(`Enter the 6-digit verification code before you ${storeOAuthActionText(requestedIntent, platform)}.`);
          return;
        }
        const verified = await run("verify-email-code", async () => {
          await verifyEmailStepUp({
            action: "connect_store",
            verificationCode,
          });
        });
        if (!verified) return;
        setEmailCodeSent(false);
        setVerificationCode("");
      }
    }

    await run("oauth-start", async () => {
      const result = await postJson<DropshipStoreConnectionOAuthStartResponse>(
        "/api/dropship/store-connections/oauth/start",
        buildStoreConnectionOAuthStartInput({
          platform,
          intent: requestedIntent,
          shopDomain: platform === "shopify" ? selectedShopifyDomain : shopDomain,
          returnTo: dropshipPortalPath("/onboarding"),
        }),
      );
      window.location.assign(result.authorizationUrl);
    });
  }

  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {selectedPlatformConnection ? `${platformName} connected` : "Connect store"}
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            {storeConnectPanelSubtitle({ canConnectStore, occupiedConnection, onboarding, selectedPlatformConnection })}
          </p>
        </div>
        <Badge variant="outline" className={storeConnectPanelBadgeTone({ canConnectStore, selectedPlatformConnection })}>
          {storeConnectPanelBadgeLabel({ canConnectStore, selectedPlatformConnection })}
        </Badge>
      </div>

      {error && (
        <Alert variant="destructive" className="mt-5">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="mt-5 border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {onboarding.storeConnections.connectedCount > 0
        && onboarding.storeConnections.launchReadyConnectedCount === 0
        && onboarding.storeConnections.credentialAttentionCount > 0 && (
          <Alert className="mt-5 border-amber-200 bg-amber-50 text-amber-900">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Connected store credentials need attention before launch. eBay requires access and refresh token references.
            </AlertDescription>
          </Alert>
        )}

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Button
          type="button"
          variant={platform === "ebay" ? "default" : "outline"}
          className={platform === "ebay" ? "h-11 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" : "h-11 gap-2"}
          disabled={!ebaySelectable || pendingAction !== null}
          onClick={() => setPlatform("ebay")}
        >
          <Store className="h-4 w-4" />
          eBay
          {platform === "ebay" && <CheckCircle2 className="h-4 w-4" />}
        </Button>
        <Button
          type="button"
          variant={platform === "shopify" ? "default" : "outline"}
          className={platform === "shopify" ? "h-11 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" : "h-11 gap-2"}
          disabled={!shopifySelectable || pendingAction !== null}
          onClick={() => setPlatform("shopify")}
        >
          <Store className="h-4 w-4" />
          Shopify
          {platform === "shopify" && <CheckCircle2 className="h-4 w-4" />}
        </Button>
      </div>

      {!canConnectStore && occupiedConnection && !canReconnectSelectedPlatform && (
        <p className="mt-3 text-sm text-zinc-500">
          {storePlatformName(platform)} is unavailable because the included connection is used by {storePlatformName(occupiedConnection.platform)}.
        </p>
      )}

      {platform === "shopify" && (
        <div className="mt-4 space-y-2">
          <Label htmlFor="dropship-shopify-domain">Shopify domain</Label>
          <Input
            id="dropship-shopify-domain"
            value={shopDomain}
            onChange={(event) => setShopDomain(event.target.value)}
            placeholder="store-name.myshopify.com"
            className="h-11"
          />
        </div>
      )}

      {selectedPlatformConnection ? (
        <ConnectedStoreSummary connection={selectedPlatformConnection} />
      ) : canConnectStore ? (
        <p className="mt-4 text-sm text-zinc-500">
          Continue sends you to {platformName} to sign in and authorize the store.
        </p>
      ) : null}

      {!principal?.hasPasskey && emailCodeSent && (
        <div className="mt-4 space-y-2">
          <Label>Verification code</Label>
          <InputOTP
            maxLength={6}
            value={verificationCode}
            onChange={setVerificationCode}
            containerClassName="justify-between"
            disabled={pendingAction !== null}
          >
            <InputOTPGroup>
              {Array.from({ length: 6 }).map((_, index) => (
                <InputOTPSlot key={index} index={index} className="h-10 w-10 text-sm" />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
      )}

      <Button
        type="button"
        disabled={connectDisabled}
        className="mt-5 h-11 w-full gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
        onClick={() => startOAuth()}
      >
        {connectButtonIcon({
          connectProofActive,
          hasPasskey: principal?.hasPasskey ?? false,
          emailCodeSent,
          intent: activeOAuthIntent,
        })}
        {connectButtonLabel({
          connectProofActive,
          hasPasskey: principal?.hasPasskey ?? false,
          emailCodeSent,
          intent: activeOAuthIntent,
          pendingAction,
          platform,
        })}
      </Button>
      {selectedPlatformConnection && defaultOAuthIntent === "refresh_connection" && (
        <Button
          type="button"
          variant="outline"
          disabled={connectDisabled}
          className="mt-3 h-10 w-full gap-2"
          onClick={() => startOAuth("change_store")}
        >
          <Store className="h-4 w-4" />
          Change {platformName} store
        </Button>
      )}
    </div>
  );
}

function OnboardingStepRow({ step }: { step: DropshipOnboardingStep }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-zinc-200 p-4">
      <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${stepIconTone(step.status)}`}>
        {step.status === "complete" ? <CheckCircle2 className="h-4 w-4" /> : stepIcons[step.key] ?? <Circle className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-semibold">{step.label}</h3>
          <Badge variant="outline" className={stepBadgeTone(step.status)}>
            {formatStatus(step.status)}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-zinc-500">{stepDescription(step)}</p>
      </div>
    </div>
  );
}

function LaunchGate({
  actionLabel,
  detail,
  icon,
  onAction,
  status,
  title,
  value,
}: {
  actionLabel: string;
  detail: string;
  icon: ReactNode;
  onAction: () => void;
  status: "complete" | "incomplete";
  title: string;
  value: string;
}) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-zinc-100 text-zinc-700">
            {icon}
          </div>
          <div>
            <h3 className="font-semibold">{title}</h3>
            <p className="mt-1 text-sm text-zinc-500">{value}</p>
          </div>
        </div>
        <Badge variant="outline" className={stepBadgeTone(status)}>
          {formatStatus(status)}
        </Badge>
      </div>
      <p className="mt-4 text-sm text-zinc-500">{detail}</p>
      <Button type="button" variant="outline" className="mt-4 h-10 w-full gap-2" onClick={onAction}>
        {actionLabel}
        <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

function canReconnectStoreConnection(connection: DropshipStoreConnectionProfileResponse): boolean {
  return ["connected", "needs_reauth", "refresh_failed", "disconnected"].includes(connection.status);
}

function ConnectedStoreSummary({ connection }: { connection: DropshipStoreConnectionProfileResponse }) {
  return (
    <div className="mt-5 border-t border-zinc-200 pt-4">
      <div className="rounded-md border border-[#C060E0]/30 bg-[#C060E0]/5 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-white text-[#C060E0]">
            <Store className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-xs uppercase text-zinc-500">Connected store</div>
            <div className="mt-1 truncate text-base font-semibold text-zinc-950">{connectionDisplayName(connection)}</div>
            <p className="mt-1 text-sm text-zinc-500">{connectedStoreIdentityDetail(connection)}</p>
          </div>
        </div>
      </div>
      <div className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
        <StoreConnectionDetail label="Status" value={formatStatus(connection.status)} />
        <StoreConnectionDetail label="Readiness" value={connection.launchReady ? "Launch ready" : launchReadinessDetail(connection)} />
        <StoreConnectionDetail label="Updated" value={formatDateTime(connection.updatedAt)} />
      </div>
      <p className="mt-4 text-sm text-zinc-500">
        {connectedStoreSummaryDetail(connection)}
      </p>
    </div>
  );
}

function StoreConnectionDetail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase text-zinc-500">{label}</div>
      <div className="mt-1 truncate font-medium text-zinc-900">{value}</div>
    </div>
  );
}

function storeConnectPanelSubtitle(input: {
  canConnectStore: boolean;
  occupiedConnection: DropshipStoreConnectionProfileResponse | null;
  onboarding: DropshipOnboardingState;
  selectedPlatformConnection: DropshipStoreConnectionProfileResponse | null;
}): string {
  if (input.selectedPlatformConnection) {
    return `${input.onboarding.storeConnections.launchReadyConnectedCount} launch-ready / ${input.onboarding.storeConnections.includedLimit} included connection(s)`;
  }
  if (!input.canConnectStore && input.occupiedConnection) {
    return `Included connection used by ${storePlatformName(input.occupiedConnection.platform)}`;
  }
  return "Choose a marketplace to authorize.";
}

function storeConnectPanelBadgeLabel(input: {
  canConnectStore: boolean;
  selectedPlatformConnection: DropshipStoreConnectionProfileResponse | null;
}): string {
  if (input.selectedPlatformConnection?.launchReady) return "Launch ready";
  if (input.selectedPlatformConnection) return "Needs attention";
  return input.canConnectStore ? "Available" : "Slot used";
}

function storeConnectPanelBadgeTone(input: {
  canConnectStore: boolean;
  selectedPlatformConnection: DropshipStoreConnectionProfileResponse | null;
}): string {
  if (input.selectedPlatformConnection?.launchReady) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (input.selectedPlatformConnection) return "border-amber-200 bg-amber-50 text-amber-900";
  return input.canConnectStore ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-zinc-200 bg-zinc-50 text-zinc-700";
}

function connectButtonLabel(input: {
  connectProofActive: boolean;
  hasPasskey: boolean;
  emailCodeSent: boolean;
  pendingAction: PendingAction;
  intent: DropshipStoreOAuthIntent;
  platform: DropshipStorePlatform;
}): string {
  const action = storeOAuthActionText(input.intent, input.platform);
  const titleAction = storeOAuthActionTitle(input.intent, input.platform);
  if (input.pendingAction === "send-email-code") return "Sending code";
  if (input.pendingAction === "verify-email-code") return "Verifying code";
  if (input.pendingAction === "passkey-proof") return "Waiting for passkey";
  if (input.pendingAction === "oauth-start") return "Opening authorization";
  if (input.connectProofActive || input.hasPasskey) return titleAction;
  if (!input.emailCodeSent) return `Verify to ${action}`;
  return `Verify and ${action}`;
}

function activateButtonLabel(input: {
  hasPasskey: boolean;
  emailCodeSent: boolean;
  pendingAction: PendingActivationAction;
}): string {
  if (input.pendingAction === "send-email-code") return "Sending code";
  if (input.pendingAction === "verify-email-code") return "Verifying code";
  if (input.pendingAction === "passkey-proof") return "Waiting for passkey";
  if (input.pendingAction === "activate-account") return "Activating";
  if (!input.hasPasskey && !input.emailCodeSent) return "Send verification code";
  return "Activate .ops";
}

function connectButtonIcon(input: {
  connectProofActive: boolean;
  hasPasskey: boolean;
  emailCodeSent: boolean;
  intent: DropshipStoreOAuthIntent;
}): ReactNode {
  if (input.connectProofActive) return input.intent === "refresh_connection" ? <RefreshCw className="h-4 w-4" /> : <Store className="h-4 w-4" />;
  if (input.hasPasskey) return <Fingerprint className="h-4 w-4" />;
  if (!input.emailCodeSent) return <Mail className="h-4 w-4" />;
  return <ArrowRight className="h-4 w-4" />;
}

function connectionDisplayName(connection: DropshipStoreConnectionProfileResponse): string {
  return connection.externalDisplayName || connection.shopDomain || `${storePlatformName(connection.platform)} store name pending`;
}

function connectedStoreIdentityDetail(connection: DropshipStoreConnectionProfileResponse): string {
  const details = [storePlatformName(connection.platform)];
  if (connection.shopDomain && connection.shopDomain !== connectionDisplayName(connection)) {
    details.push(connection.shopDomain);
  }
  if (connection.externalAccountId && connection.externalAccountId !== connection.externalDisplayName) {
    details.push(`Account ID ${connection.externalAccountId}`);
  }
  if (!connection.externalDisplayName && !connection.shopDomain && !connection.externalAccountId) {
    details.push("Reauthorize to load store name");
  }
  return details.join(" | ");
}

function launchReadinessDetail(connection: DropshipStoreConnectionProfileResponse): string {
  if (connection.status !== "connected") return formatStatus(connection.status);
  if (connection.setupStatus !== "ready") return `Setup ${formatStatus(connection.setupStatus)}`;
  if (!connection.hasAccessToken) return "Access token missing";
  if (connection.platform === "ebay" && !connection.hasRefreshToken) return "Refresh token missing";
  return "Not ready";
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function storePlatformName(platform: DropshipStorePlatform): string {
  return platform === "ebay" ? "eBay" : "Shopify";
}

function storeOAuthIntentForConnection(connection: DropshipStoreConnectionProfileResponse | null): DropshipStoreOAuthIntent {
  if (!connection) return "connect";
  return connection.launchReady && connection.status === "connected" ? "change_store" : "refresh_connection";
}

function storeOAuthActionTitle(intent: DropshipStoreOAuthIntent, platform: DropshipStorePlatform): string {
  if (intent === "refresh_connection") return `Refresh ${storePlatformName(platform)} connection`;
  if (intent === "change_store") return `Change ${storePlatformName(platform)} store`;
  return `Connect ${storePlatformName(platform)}`;
}

function storeOAuthActionText(intent: DropshipStoreOAuthIntent, platform: DropshipStorePlatform): string {
  if (intent === "refresh_connection") return `refresh the ${storePlatformName(platform)} connection`;
  if (intent === "change_store") return `change the ${storePlatformName(platform)} store`;
  return `connect ${storePlatformName(platform)}`;
}

function connectedStoreSummaryDetail(connection: DropshipStoreConnectionProfileResponse): string {
  if (storeOAuthIntentForConnection(connection) === "refresh_connection") {
    return `Refresh reauthorizes the current ${storePlatformName(connection.platform)} account. Change store opens ${storePlatformName(connection.platform)} sign-in so you can replace it.`;
  }
  return `Change store opens ${storePlatformName(connection.platform)} sign-in so you can replace the connected account.`;
}

function activateButtonIcon(hasPasskey: boolean, emailCodeSent: boolean): ReactNode {
  if (hasPasskey) return <Fingerprint className="h-4 w-4" />;
  if (!emailCodeSent) return <Mail className="h-4 w-4" />;
  return <Rocket className="h-4 w-4" />;
}

function activationPanelDetail(input: {
  onboarding: DropshipOnboardingState;
  requiredStepsComplete: boolean;
  alreadyActive: boolean;
}): string {
  if (input.alreadyActive) return "Live order intake can proceed when marketplace orders arrive.";
  if (input.onboarding.entitlement.status !== "active") return "Active .ops entitlement is required before activation.";
  if (!input.requiredStepsComplete) return "Complete every required launch gate before activation.";
  return "All launch gates are complete.";
}

function activationBadgeTone(input: { alreadyActive: boolean; activationReady: boolean }): string {
  if (input.alreadyActive) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (input.activationReady) return "border-[#C060E0]/30 bg-[#C060E0]/10 text-[#8941a0]";
  return "border-amber-200 bg-amber-50 text-amber-900";
}

function stepDescription(step: DropshipOnboardingStep): string {
  if (step.key === "vendor_profile") return "Card Shellz .ops entitlement and vendor profile are available.";
  if (step.key === "store_connection") return "One marketplace store must be connected with launch-ready credentials before launch.";
  if (step.key === "catalog_available") return "Card Shellz ops controls the catalog available for vendor selection.";
  if (step.key === "wallet_payment") return "Stripe-ready funding, USDC Base funding, and auto-reload are required before launch; a current balance is optional when auto-reload is ready.";
  return "Selected products define what can be pushed to connected marketplace stores.";
}

function ActivationPanel({
  onboarding,
  onActivated,
}: {
  onboarding: DropshipOnboardingState;
  onActivated: (state: DropshipOnboardingState) => void;
}) {
  const {
    principal,
    sensitiveProofs,
    startEmailStepUp,
    verifyEmailStepUp,
    verifyPasskeyStepUp,
  } = useDropshipAuth();
  const [, setLocation] = useLocation();
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingActivationAction>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const activationAction: DropshipSensitiveAction = "activate_account";
  const requiredStepsComplete = onboarding.steps.every((step) => !step.required || step.status === "complete");
  const alreadyActive = onboarding.vendor.status === "active";
  const activationReady = onboarding.vendor.status === "onboarding"
    && onboarding.entitlement.status === "active"
    && requiredStepsComplete;
  const activateProofActive = useMemo(() => {
    return isDropshipSensitiveProofActive({
      principal,
      action: activationAction,
      proof: sensitiveProofs.activate_account,
    });
  }, [activationAction, principal, sensitiveProofs.activate_account]);
  const activateDisabled = !activationReady
    || pendingAction !== null
    || (!principal?.hasPasskey && emailCodeSent && verificationCode.length !== 6);

  async function run(action: PendingActivationAction, task: () => Promise<void>): Promise<boolean> {
    setPendingAction(action);
    setError("");
    setMessage("");
    try {
      await task();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Activation request failed.");
      return false;
    } finally {
      setPendingAction(null);
    }
  }

  async function activateAccount() {
    if (!activationReady) return;

    if (!activateProofActive) {
      if (principal?.hasPasskey) {
        const verified = await run("passkey-proof", async () => {
          await verifyPasskeyStepUp(activationAction);
        });
        if (!verified) return;
      } else if (!emailCodeSent) {
        await run("send-email-code", async () => {
          await startEmailStepUp(activationAction);
          setEmailCodeSent(true);
          setVerificationCode("");
          setMessage("Verification code sent.");
        });
        return;
      } else {
        if (verificationCode.length !== 6) {
          setError("Enter the 6-digit verification code before activating .ops.");
          return;
        }
        const verified = await run("verify-email-code", async () => {
          await verifyEmailStepUp({
            action: activationAction,
            verificationCode,
          });
        });
        if (!verified) return;
        setEmailCodeSent(false);
        setVerificationCode("");
      }
    }

    await run("activate-account", async () => {
      const state = await postJson<DropshipOnboardingState>("/api/dropship/onboarding/activate", {});
      onActivated(state);
      setEmailCodeSent(false);
      setVerificationCode("");
      setMessage("Dropship account activated.");
    });
  }

  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Activate .ops</h2>
          <p className="mt-1 text-sm text-zinc-500">{activationPanelDetail({ onboarding, requiredStepsComplete, alreadyActive })}</p>
        </div>
        <Badge variant="outline" className={activationBadgeTone({ alreadyActive, activationReady })}>
          {alreadyActive ? "Active" : activationReady ? "Ready" : "Incomplete"}
        </Badge>
      </div>

      {error && (
        <Alert variant="destructive" className="mt-5">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="mt-5 border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      {!principal?.hasPasskey && emailCodeSent && (
        <div className="mt-4 space-y-2">
          <Label>Verification code</Label>
          <InputOTP
            maxLength={6}
            value={verificationCode}
            onChange={setVerificationCode}
            containerClassName="justify-between"
            disabled={pendingAction !== null}
          >
            <InputOTPGroup>
              {Array.from({ length: 6 }).map((_, index) => (
                <InputOTPSlot key={index} index={index} className="h-10 w-10 text-sm" />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
      )}

      {alreadyActive ? (
        <Button
          type="button"
          className="mt-5 h-11 w-full gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
          onClick={() => setLocation(dropshipPortalPath("/dashboard"))}
        >
          Open dashboard
          <ArrowRight className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          type="button"
          disabled={activateDisabled}
          className="mt-5 h-11 w-full gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
          onClick={activateAccount}
        >
          {activateButtonIcon(principal?.hasPasskey ?? false, emailCodeSent)}
          {activateButtonLabel({
            hasPasskey: principal?.hasPasskey ?? false,
            emailCodeSent,
            pendingAction,
          })}
        </Button>
      )}
    </div>
  );
}

function walletGateDetail(onboarding: DropshipOnboardingState): string {
  if (onboarding.wallet.walletReady) {
    return onboarding.wallet.hasSpendableBalance
      ? "Spendable wallet balance, USDC Base funding, and auto-reload are ready."
      : "Stripe-ready auto-reload and USDC Base funding are configured; wallet can fund accepted orders.";
  }
  if (!onboarding.wallet.hasStripeReadyFundingMethod) {
    return onboarding.wallet.hasActiveFundingMethod
      ? "Active funding method exists, but Stripe card or ACH setup is not ready."
      : "Add a Stripe card or ACH funding method before accepting live dropship orders.";
  }
  if (!onboarding.wallet.hasUsdcBaseFundingMethod) {
    return "Register a USDC Base funding wallet before accepting live dropship orders.";
  }
  if (!onboarding.wallet.autoReloadConfigured) {
    return onboarding.wallet.autoReloadEnabled
      ? "Select a usable Stripe card or ACH method for auto-reload."
      : "Configure auto-reload before launch.";
  }
  return "Wallet setup needs attention.";
}

function stepIconTone(status: DropshipOnboardingStep["status"]): string {
  if (status === "complete") return "bg-emerald-50 text-emerald-700";
  if (status === "blocked") return "bg-rose-50 text-rose-700";
  return "bg-amber-50 text-amber-700";
}

function stepBadgeTone(status: DropshipOnboardingStep["status"] | "incomplete"): string {
  if (status === "complete") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "blocked") return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-amber-200 bg-amber-50 text-amber-900";
}

function getStoreConnectionCallbackStatus(): { kind: "connected" | "error"; message: string } | null {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("storeConnection");
  if (status === "connected") {
    return { kind: "connected", message: "Store connection completed." };
  }
  if (status === "error") {
    const code = params.get("error");
    return {
      kind: "error",
      message: code ? `Store connection failed: ${formatStatus(code)}` : "Store connection failed.",
    };
  }
  return null;
}
