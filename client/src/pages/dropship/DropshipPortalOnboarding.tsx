import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Circle,
  Clock,
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
  describeAccountSummary,
  describeActivation,
  describeOnboardingProgress,
  describeOnboardingStep,
  isOnboardingVendor,
  type ActivationView,
  type OnboardingStepTone,
  type OnboardingStepView,
} from "@/lib/dropship-onboarding";
import {
  buildStoreConnectionOAuthStartInput,
  fetchJson,
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
import { describeVendorStanding } from "@/lib/dropship-vendor-standing";
import { DropshipPortalShell } from "./DropshipPortalShell";
import {
  readStoreOAuthCallbackStatus,
  storeOAuthCallbackMessage,
} from "./store-oauth-callback-status";
import { storeOAuthEmailVerificationMessage } from "./store-oauth-verification-copy";
import { StoreOAuthTargetConfirmationDialog } from "./StoreOAuthTargetConfirmationDialog";

/**
 * Vendor onboarding.
 *
 * One checklist, five rows, each row with its own button, and the activation
 * step at the bottom of the same card. The store panel sits below it because
 * connecting a store happens on this page. Once the vendor is past onboarding
 * the checklist gives way to a short account summary; the store panel stays,
 * since this is the only page that can connect one, and the shell drops the
 * page from the nav.
 */

const ONBOARDING_QUERY_KEY = ["/api/dropship/onboarding/state"] as const;

type PendingAction = "send-email-code" | "verify-email-code" | "passkey-proof" | "oauth-start" | null;
type PendingActivationAction = "send-email-code" | "verify-email-code" | "passkey-proof" | "activate-account" | null;
type ExistingStoreOAuthIntent = Extract<DropshipStoreOAuthIntent, "refresh_connection" | "change_store">;

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
  // Activation flips the status to active, which would swap the checklist for
  // the account summary the moment it succeeds. Remember it happened here so
  // the confirmation stays on screen and the vendor chooses when to move on.
  const [activatedHere, setActivatedHere] = useState(false);
  const storePanelRef = useRef<HTMLDivElement | null>(null);
  const onboardingQuery = useQuery<DropshipOnboardingState>({
    queryKey: [...ONBOARDING_QUERY_KEY],
    queryFn: () => fetchJson<DropshipOnboardingState>(ONBOARDING_QUERY_KEY[0]),
    enabled: !!principal,
  });
  const onboarding = onboardingQuery.data;
  const showChecklist = onboarding ? isOnboardingVendor(onboarding.vendor.status) || activatedHere : true;
  const progress = onboarding ? describeOnboardingProgress(onboarding.steps) : null;
  const connectionStatus = readStoreOAuthCallbackStatus(window.location.search);

  function navigate(path: string) {
    setLocation(dropshipPortalPath(path));
  }

  function revealStorePanel() {
    storePanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Plug className="h-6 w-6 text-[#C060E0]" />
              {showChecklist ? "Onboarding" : "Account"}
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              {showChecklist
                ? "Connect your store, pick your products, set up your wallet, then activate."
                : "Your account and store connection."}
            </p>
          </div>
          {showChecklist && progress && (
            <Badge variant="outline" className="w-fit border-zinc-200 bg-white text-zinc-700" data-testid="onboarding-progress">
              {progress.completedCount} of {progress.totalCount} complete
            </Badge>
          )}
        </div>

        {connectionStatus && (
          <Alert className={connectionStatus.kind === "connected" ? "mt-5 border-emerald-200 bg-emerald-50 text-emerald-900" : "mt-5 border-rose-200 bg-rose-50 text-rose-900"}>
            {connectionStatus.kind === "connected" ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
            <AlertDescription>{storeOAuthCallbackMessage(connectionStatus)}</AlertDescription>
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
          <div className="mt-5 space-y-4">
            <Skeleton className="h-80 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : onboarding ? (
          <>
            {showChecklist ? (
              <LaunchChecklist
                onboarding={onboarding}
                onNavigate={navigate}
                onRevealStorePanel={revealStorePanel}
                onActivated={(state) => {
                  setActivatedHere(true);
                  queryClient.setQueryData([...ONBOARDING_QUERY_KEY], state);
                }}
              />
            ) : (
              <AccountSummaryCard onboarding={onboarding} onOpenDashboard={() => navigate("/dashboard")} />
            )}
            <div ref={storePanelRef} className="mt-4 scroll-mt-4">
              <StoreConnectPanel onboarding={onboarding} />
            </div>
          </>
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

function LaunchChecklist({
  onboarding,
  onNavigate,
  onRevealStorePanel,
  onActivated,
}: {
  onboarding: DropshipOnboardingState;
  onNavigate: (path: string) => void;
  onRevealStorePanel: () => void;
  onActivated: (state: DropshipOnboardingState) => void;
}) {
  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-5 shadow-sm" data-testid="onboarding-checklist">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Launch checklist</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {onboarding.vendor.businessName || onboarding.vendor.email || "Card Shellz member"}
          </p>
        </div>
        <Badge variant="outline">{formatStatus(onboarding.vendor.status)}</Badge>
      </div>

      <ol className="mt-5 divide-y divide-zinc-200 rounded-md border border-zinc-200">
        {onboarding.steps.map((step) => (
          <ChecklistRow
            key={step.key}
            view={describeOnboardingStep(step, onboarding)}
            onNavigate={onNavigate}
            onRevealStorePanel={onRevealStorePanel}
          />
        ))}
      </ol>

      <ActivationFooter
        onboarding={onboarding}
        onActivated={onActivated}
        onOpenDashboard={() => onNavigate("/dashboard")}
      />
    </section>
  );
}

function ChecklistRow({
  view,
  onNavigate,
  onRevealStorePanel,
}: {
  view: OnboardingStepView;
  onNavigate: (path: string) => void;
  onRevealStorePanel: () => void;
}) {
  const action = view.action;
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center" data-testid={`onboarding-step-${view.key}`}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${stepIconTone(view.tone)}`}>
          {stepIcon(view)}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{view.label}</h3>
            <Badge variant="outline" className={stepBadgeTone(view.tone)}>{view.badge}</Badge>
          </div>
          <p className="mt-1 text-sm text-zinc-500">{view.detail}</p>
        </div>
      </div>
      {action && (
        <Button
          type="button"
          variant={view.tone === "complete" ? "ghost" : "outline"}
          size="sm"
          className="h-9 w-fit shrink-0 gap-2"
          onClick={() => (action.kind === "navigate" ? onNavigate(action.path) : onRevealStorePanel())}
        >
          {action.label}
          <ArrowRight className="h-4 w-4" />
        </Button>
      )}
    </li>
  );
}

function stepIcon(view: OnboardingStepView): ReactNode {
  if (view.tone === "complete") return <CheckCircle2 className="h-4 w-4" />;
  if (view.tone === "waiting") return <Clock className="h-4 w-4" />;
  return stepIcons[view.key] ?? <Circle className="h-4 w-4" />;
}

function AccountSummaryCard({
  onboarding,
  onOpenDashboard,
}: {
  onboarding: DropshipOnboardingState;
  onOpenDashboard: () => void;
}) {
  const summary = describeAccountSummary(onboarding.vendor.status);
  const standing = describeVendorStanding(onboarding.vendor);
  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-5 shadow-sm" data-testid="onboarding-account-summary">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{summary.title}</h2>
          <p className="mt-1 text-sm text-zinc-500">{standing ? `${standing.reason} ${standing.action}` : summary.detail}</p>
        </div>
        <Badge variant="outline">{formatStatus(onboarding.vendor.status)}</Badge>
      </div>
      <Button type="button" className="mt-5 h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={onOpenDashboard}>
        Open dashboard
        <ArrowRight className="h-4 w-4" />
      </Button>
    </section>
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
  const [oauthTargetStoreConnectionId, setOauthTargetStoreConnectionId] = useState<number | null>(null);
  const [oauthConfirmation, setOauthConfirmation] = useState<{
    intent: ExistingStoreOAuthIntent;
    storeConnectionId: number;
  } | null>(null);
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
  const activeOAuthTargetStoreConnectionId = emailCodeSent
    ? oauthTargetStoreConnectionId
    : selectedPlatformConnection?.storeConnectionId ?? null;
  const confirmationConnection = oauthConfirmation === null
    ? null
    : reconnectableConnections.find((connection) => (
        connection.storeConnectionId === oauthConfirmation.storeConnectionId
      )) ?? null;
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

  function requestOAuth(
    requestedIntent: DropshipStoreOAuthIntent = activeOAuthIntent,
    requestedStoreConnectionId: number | null = activeOAuthTargetStoreConnectionId,
  ): void {
    if (requestedIntent === "connect") {
      void startOAuth(requestedIntent, null);
      return;
    }
    if (!Number.isInteger(requestedStoreConnectionId) || (requestedStoreConnectionId ?? 0) <= 0) {
      setError("The store selected for authorization is no longer available. Refresh the page and choose the store again.");
      return;
    }
    setOauthIntent(requestedIntent);
    setOauthTargetStoreConnectionId(requestedStoreConnectionId);
    setOauthConfirmation({
      intent: requestedIntent,
      storeConnectionId: requestedStoreConnectionId as number,
    });
  }

  async function startOAuth(
    requestedIntent: DropshipStoreOAuthIntent,
    requestedStoreConnectionId: number | null,
  ) {
    setOauthIntent(requestedIntent);
    setOauthTargetStoreConnectionId(requestedStoreConnectionId);
    if (requestedIntent !== "connect") {
      const target = reconnectableConnections.find((connection) => (
        connection.storeConnectionId === requestedStoreConnectionId
        && connection.platform === platform
      ));
      if (!target) {
        setError("The store selected for authorization is no longer available. Refresh the page and choose the store again.");
        return;
      }
    }
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
          setMessage(storeOAuthEmailVerificationMessage(
            storeOAuthActionText(requestedIntent, platform),
          ));
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
          storeConnectionId: requestedStoreConnectionId,
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
        onClick={() => {
          if (emailCodeSent) {
            void startOAuth(activeOAuthIntent, activeOAuthTargetStoreConnectionId);
            return;
          }
          requestOAuth();
        }}
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
          targetStoreName: selectedPlatformConnection === null
            ? null
            : connectionDisplayName(selectedPlatformConnection),
        })}
      </Button>
      {selectedPlatformConnection && defaultOAuthIntent === "refresh_connection" && (
        <Button
          type="button"
          variant="outline"
          disabled={connectDisabled}
          className="mt-3 h-10 w-full gap-2"
          onClick={() => requestOAuth("change_store", selectedPlatformConnection.storeConnectionId)}
        >
          <Store className="h-4 w-4" />
          Change {platformName} store
        </Button>
      )}
      {oauthConfirmation && confirmationConnection && (
        <StoreOAuthTargetConfirmationDialog
          intent={oauthConfirmation.intent}
          open
          target={{
            storeConnectionId: confirmationConnection.storeConnectionId,
            platform: confirmationConnection.platform,
            displayName: connectionDisplayName(confirmationConnection),
            externalAccountId: confirmationConnection.externalAccountId,
          }}
          onCancel={() => setOauthConfirmation(null)}
          onConfirm={() => {
            const confirmed = oauthConfirmation;
            setOauthConfirmation(null);
            void startOAuth(confirmed.intent, confirmed.storeConnectionId);
          }}
        />
      )}
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
  targetStoreName: string | null;
}): string {
  const action = storeOAuthActionText(input.intent, input.platform);
  const titleAction = storeOAuthActionTitle(input.intent, input.platform);
  const exactAction = input.intent === "refresh_connection" && input.targetStoreName
    ? `reconnect ${input.targetStoreName}`
    : action;
  if (input.pendingAction === "send-email-code") return "Sending code";
  if (input.pendingAction === "verify-email-code") return "Verifying code";
  if (input.pendingAction === "passkey-proof") return "Waiting for passkey";
  if (input.pendingAction === "oauth-start") return "Opening authorization";
  if (input.connectProofActive || input.hasPasskey) {
    return input.intent === "refresh_connection" && input.targetStoreName
      ? `Reconnect ${input.targetStoreName}`
      : titleAction;
  }
  if (!input.emailCodeSent) return `Verify to ${exactAction}`;
  return `Verify and ${exactAction}`;
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

function activationBadgeTone(activation: ActivationView): string {
  if (activation.alreadyActive) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (activation.ready) return "border-[#C060E0]/30 bg-[#C060E0]/10 text-[#8941a0]";
  return "border-amber-200 bg-amber-50 text-amber-900";
}

function ActivationFooter({
  onboarding,
  onActivated,
  onOpenDashboard,
}: {
  onboarding: DropshipOnboardingState;
  onActivated: (state: DropshipOnboardingState) => void;
  onOpenDashboard: () => void;
}) {
  const {
    principal,
    sensitiveProofs,
    startEmailStepUp,
    verifyEmailStepUp,
    verifyPasskeyStepUp,
  } = useDropshipAuth();
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingActivationAction>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const activationAction: DropshipSensitiveAction = "activate_account";
  const activation = describeActivation(onboarding);
  const activateProofActive = useMemo(() => {
    return isDropshipSensitiveProofActive({
      principal,
      action: activationAction,
      proof: sensitiveProofs.activate_account,
    });
  }, [activationAction, principal, sensitiveProofs.activate_account]);
  const activateDisabled = !activation.ready
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
    if (!activation.ready) return;

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
      setMessage("Your .ops account is active.");
    });
  }

  return (
    <div className="mt-5 border-t border-zinc-200 pt-5" data-testid="onboarding-activation">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="font-semibold">Activate .ops</h3>
          <p className="mt-1 text-sm text-zinc-500">{activation.detail}</p>
        </div>
        <Badge variant="outline" className={activationBadgeTone(activation)}>
          {activation.alreadyActive ? "Active" : activation.ready ? "Ready" : "Not yet"}
        </Badge>
      </div>

      {error && (
        <Alert variant="destructive" className="mt-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="mt-4 border-emerald-200 bg-emerald-50 text-emerald-900">
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

      {activation.alreadyActive ? (
        <Button
          type="button"
          className="mt-4 h-11 w-full gap-2 bg-[#C060E0] hover:bg-[#a94bc9] sm:w-auto"
          onClick={onOpenDashboard}
        >
          Open dashboard
          <ArrowRight className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          type="button"
          disabled={activateDisabled}
          className="mt-4 h-11 w-full gap-2 bg-[#C060E0] hover:bg-[#a94bc9] sm:w-auto"
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

function stepIconTone(tone: OnboardingStepTone): string {
  if (tone === "complete") return "bg-emerald-50 text-emerald-700";
  if (tone === "blocked") return "bg-rose-50 text-rose-700";
  if (tone === "waiting") return "bg-zinc-100 text-zinc-600";
  return "bg-amber-50 text-amber-700";
}

function stepBadgeTone(tone: OnboardingStepTone): string {
  if (tone === "complete") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (tone === "blocked") return "border-rose-200 bg-rose-50 text-rose-800";
  if (tone === "waiting") return "border-zinc-200 bg-zinc-50 text-zinc-700";
  return "border-amber-200 bg-amber-50 text-amber-900";
}
