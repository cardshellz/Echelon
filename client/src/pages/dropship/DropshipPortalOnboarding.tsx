import { useMemo, useState } from "react";
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
import { dropshipPortalPath, useDropshipAuth, type DropshipSensitiveAction } from "@/lib/dropship-auth";
import {
  buildStoreConnectionOAuthStartInput,
  fetchJson,
  formatCents,
  formatStatus,
  postJson,
  type DropshipOnboardingState,
  type DropshipOnboardingStep,
  type DropshipStoreConnectionOAuthStartResponse,
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
  const [verificationCode, setVerificationCode] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const connectProofActive = useMemo(() => {
    const proof = sensitiveProofs.connect_store;
    return !!proof && new Date(proof.expiresAt).getTime() > Date.now();
  }, [sensitiveProofs.connect_store]);
  const canConnectStore = onboarding.storeConnections.canConnectStore;
  const shopifyDomainRequired = platform === "shopify" && !shopDomain.trim();
  const connectDisabled = !canConnectStore || shopifyDomainRequired || pendingAction !== null || (!principal?.hasPasskey && emailCodeSent && verificationCode.length !== 6);

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

  async function startOAuth() {
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
          setMessage("Verification code sent.");
        });
        return;
      } else {
        const verified = await run("verify-email-code", async () => {
          await verifyEmailStepUp({
            action: "connect_store",
            verificationCode,
          });
        });
        if (!verified) return;
      }
    }

    await run("oauth-start", async () => {
      const result = await postJson<DropshipStoreConnectionOAuthStartResponse>(
        "/api/dropship/store-connections/oauth/start",
        buildStoreConnectionOAuthStartInput({
          platform,
          shopDomain,
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
          <h2 className="text-lg font-semibold">Connect store</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {onboarding.storeConnections.activeCount} of {onboarding.storeConnections.includedLimit} included connection(s) used
          </p>
        </div>
        <Badge variant="outline" className={canConnectStore ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}>
          {canConnectStore ? "Available" : "Unavailable"}
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

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Button
          type="button"
          variant={platform === "ebay" ? "default" : "outline"}
          className={platform === "ebay" ? "h-11 gap-2 bg-zinc-950 hover:bg-zinc-800" : "h-11 gap-2"}
          onClick={() => setPlatform("ebay")}
        >
          <Store className="h-4 w-4" />
          eBay
        </Button>
        <Button
          type="button"
          variant={platform === "shopify" ? "default" : "outline"}
          className={platform === "shopify" ? "h-11 gap-2 bg-zinc-950 hover:bg-zinc-800" : "h-11 gap-2"}
          onClick={() => setPlatform("shopify")}
        >
          <Store className="h-4 w-4" />
          Shopify
        </Button>
      </div>

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

      {!principal?.hasPasskey && emailCodeSent && (
        <div className="mt-4 space-y-2">
          <Label>Verification code</Label>
          <InputOTP
            maxLength={6}
            value={verificationCode}
            onChange={setVerificationCode}
            containerClassName="justify-between"
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
        onClick={startOAuth}
      >
        {connectButtonIcon(principal?.hasPasskey ?? false, emailCodeSent)}
        {connectButtonLabel({
          hasPasskey: principal?.hasPasskey ?? false,
          emailCodeSent,
          pendingAction,
          platform,
        })}
      </Button>
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

function connectButtonLabel(input: {
  hasPasskey: boolean;
  emailCodeSent: boolean;
  pendingAction: PendingAction;
  platform: DropshipStorePlatform;
}): string {
  if (input.pendingAction === "send-email-code") return "Sending code";
  if (input.pendingAction === "verify-email-code") return "Verifying code";
  if (input.pendingAction === "passkey-proof") return "Waiting for passkey";
  if (input.pendingAction === "oauth-start") return "Opening authorization";
  if (!input.hasPasskey && !input.emailCodeSent) return "Send verification code";
  return `Connect ${input.platform === "ebay" ? "eBay" : "Shopify"}`;
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

function connectButtonIcon(hasPasskey: boolean, emailCodeSent: boolean): ReactNode {
  if (hasPasskey) return <Fingerprint className="h-4 w-4" />;
  if (!emailCodeSent) return <Mail className="h-4 w-4" />;
  return <ArrowRight className="h-4 w-4" />;
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
  if (step.key === "store_connection") return "One approved marketplace store must be connected before launch.";
  if (step.key === "catalog_available") return "Card Shellz ops controls the catalog available for vendor selection.";
  if (step.key === "wallet_payment") return "A funding method, auto-reload, and spendable wallet balance are required before launch.";
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
    const proof = sensitiveProofs.activate_account;
    return !!proof && new Date(proof.expiresAt).getTime() > Date.now();
  }, [sensitiveProofs.activate_account]);
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
          setMessage("Verification code sent.");
        });
        return;
      } else {
        const verified = await run("verify-email-code", async () => {
          await verifyEmailStepUp({
            action: activationAction,
            verificationCode,
          });
        });
        if (!verified) return;
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
          className="mt-5 h-11 w-full gap-2 bg-zinc-950 hover:bg-zinc-800"
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
    return "Funding method, auto-reload, and spendable balance are ready.";
  }
  if (!onboarding.wallet.hasActiveFundingMethod) {
    return "Add a funding method before accepting live dropship orders.";
  }
  if (!onboarding.wallet.autoReloadConfigured) {
    return "Configure auto-reload with an active funding method.";
  }
  if (!onboarding.wallet.hasSpendableBalance) {
    return onboarding.wallet.pendingBalanceCents > 0
      ? "Pending funds are not spendable yet; add settled funds before launch."
      : "Add settled wallet funds before launch.";
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
