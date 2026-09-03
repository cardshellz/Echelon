import { useState } from "react";
import type React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Bell, CheckCircle2, Fingerprint, KeyRound, Mail, Plug, RefreshCw, Settings, Store, Wallet } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  buildStoreConnectionOAuthStartInput,
  buildStoreConnectionDisconnectInput,
  createDropshipIdempotencyKey,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  postJson,
  queryErrorMessage,
  sectionStatusTone,
  type DropshipSettingsResponse,
  type DropshipSettingsSection,
  type DropshipStoreConnectionDisconnectResponse,
  type DropshipStoreConnectionListResponse,
  type DropshipStoreConnectionOAuthStartResponse,
  type DropshipStoreConnectionProfileResponse,
  type DropshipStoreConnectionSetupCheck,
  type DropshipStoreOAuthIntent,
} from "@/lib/dropship-ops-surface";
import {
  dropshipPortalPath,
  isDropshipSensitiveProofActive,
  useDropshipAuth,
  type DropshipSensitiveAction,
} from "@/lib/dropship-auth";
import { DropshipPortalShell } from "./DropshipPortalShell";
import {
  readStoreOAuthCallbackStatus,
  storeOAuthCallbackMessage,
} from "./store-oauth-callback-status";
import { storeOAuthEmailVerificationMessage } from "./store-oauth-verification-copy";

type PendingStoreAction =
  | "disconnect-send-code"
  | "disconnect-verify-code"
  | "disconnect-passkey-proof"
  | "disconnect"
  | "reauth-send-code"
  | "reauth-verify-code"
  | "reauth-passkey-proof"
  | "reauth-start"
  | null;

const icons: Record<DropshipSettingsSection["key"], React.ReactNode> = {
  account: <Settings className="h-4 w-4" />,
  store_connection: <Store className="h-4 w-4" />,
  wallet_payment: <Wallet className="h-4 w-4" />,
  notifications: <Bell className="h-4 w-4" />,
  api_keys: <KeyRound className="h-4 w-4" />,
  webhooks: <Plug className="h-4 w-4" />,
  return_contact: <Mail className="h-4 w-4" />,
};

export default function DropshipPortalSettings() {
  const queryClient = useQueryClient();
  const {
    principal,
    sensitiveProofs,
    startEmailStepUp,
    verifyEmailStepUp,
    verifyPasskeyStepUp,
  } = useDropshipAuth();
  const [emailChallengeAction, setEmailChallengeAction] = useState<DropshipSensitiveAction | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [pendingStoreAction, setPendingStoreAction] = useState<PendingStoreAction>(null);
  const [disconnectTargetId, setDisconnectTargetId] = useState<number | null>(null);
  const [reauthorizeTargetId, setReauthorizeTargetId] = useState<number | null>(null);
  const [reauthorizeIntent, setReauthorizeIntent] = useState<DropshipStoreOAuthIntent>("refresh_connection");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const settingsQuery = useQuery<DropshipSettingsResponse>({
    queryKey: ["/api/dropship/settings"],
    queryFn: () => fetchJson<DropshipSettingsResponse>("/api/dropship/settings"),
  });
  const storeConnectionsQuery = useQuery<DropshipStoreConnectionListResponse>({
    queryKey: ["/api/dropship/store-connections"],
    queryFn: () => fetchJson<DropshipStoreConnectionListResponse>("/api/dropship/store-connections"),
  });
  const settings = settingsQuery.data?.settings;
  const storeConnections = storeConnectionsQuery.data?.connections ?? [];
  const connectionStatus = readStoreOAuthCallbackStatus(window.location.search);
  const callbackEbayConnections = storeConnections.filter((connection) => connection.platform === "ebay");
  const callbackStoreName = callbackEbayConnections.length === 1
    ? connectionDisplayName(callbackEbayConnections[0])
    : null;
  const verificationTargetId = emailChallengeAction === "connect_store"
    ? reauthorizeTargetId
    : emailChallengeAction === "disconnect_store"
      ? disconnectTargetId
      : null;
  const verificationConnection = verificationTargetId === null
    ? null
    : storeConnections.find((connection) => connection.storeConnectionId === verificationTargetId) ?? null;

  const hasActiveProof = (action: DropshipSensitiveAction) => {
    return isDropshipSensitiveProofActive({
      principal,
      action,
      proof: sensitiveProofs[action],
    });
  };

  async function ensureSensitiveActionProof(input: {
    action: DropshipSensitiveAction;
    passkeyAction: PendingStoreAction;
    sendCodeAction: PendingStoreAction;
    verifyCodeAction: PendingStoreAction;
    sentMessage: string;
    codeRequiredMessage: string;
  }): Promise<boolean> {
    if (hasActiveProof(input.action)) return true;

    if (principal?.hasPasskey) {
      return runStoreAction(input.passkeyAction, async () => {
        await verifyPasskeyStepUp(input.action);
      });
    }

    if (emailChallengeAction !== input.action) {
      await runStoreAction(input.sendCodeAction, async () => {
        await startEmailStepUp(input.action);
        setEmailChallengeAction(input.action);
        setVerificationCode("");
        setMessage(input.sentMessage);
      });
      return false;
    }

    if (verificationCode.length !== 6) {
      setError(input.codeRequiredMessage);
      return false;
    }

    const verified = await runStoreAction(input.verifyCodeAction, async () => {
      await verifyEmailStepUp({
        action: input.action,
        verificationCode,
      });
    });
    if (verified) {
      setEmailChallengeAction(null);
      setVerificationCode("");
    }
    return verified;
  }

  async function ensureDisconnectProof(): Promise<boolean> {
    return ensureSensitiveActionProof({
      action: "disconnect_store",
      passkeyAction: "disconnect-passkey-proof",
      sendCodeAction: "disconnect-send-code",
      verifyCodeAction: "disconnect-verify-code",
      sentMessage: "Verification code sent. Enter it below, then retry the disconnect.",
      codeRequiredMessage: "Enter the 6-digit verification code before disconnecting.",
    });
  }

  async function disconnectStore(connection: DropshipStoreConnectionProfileResponse): Promise<void> {
    setDisconnectTargetId(connection.storeConnectionId);
    if (!await ensureDisconnectProof()) return;
    try {
      await runStoreAction("disconnect", async () => {
        const response = await postJson<DropshipStoreConnectionDisconnectResponse>(
          `/api/dropship/store-connections/${connection.storeConnectionId}/disconnect`,
          buildStoreConnectionDisconnectInput({
            reason: `Vendor portal disconnect request for ${connectionDisplayName(connection)}.`,
            idempotencyKey: createDropshipIdempotencyKey(`store-disconnect:${connection.storeConnectionId}`),
          }),
        );
        await Promise.all([
          storeConnectionsQuery.refetch(),
          queryClient.invalidateQueries({ queryKey: ["/api/dropship/settings"] }),
          queryClient.invalidateQueries({ queryKey: ["/api/dropship/onboarding/state"] }),
        ]);
        setEmailChallengeAction(null);
        setVerificationCode("");
        setMessage(`${connectionDisplayName(response.connection)} moved to ${formatStatus(response.connection.status)}.`);
      });
    } finally {
      setDisconnectTargetId(null);
    }
  }

  async function ensureConnectProof(intent: DropshipStoreOAuthIntent, connection: DropshipStoreConnectionProfileResponse): Promise<boolean> {
    const action = storeOAuthActionText(intent, connection.platform, connection.status);
    return ensureSensitiveActionProof({
      action: "connect_store",
      passkeyAction: "reauth-passkey-proof",
      sendCodeAction: "reauth-send-code",
      verifyCodeAction: "reauth-verify-code",
      sentMessage: storeOAuthEmailVerificationMessage(action),
      codeRequiredMessage: `Enter the 6-digit verification code before you ${action}.`,
    });
  }

  async function reauthorizeStore(connection: DropshipStoreConnectionProfileResponse, intent: DropshipStoreOAuthIntent): Promise<void> {
    setReauthorizeTargetId(connection.storeConnectionId);
    setReauthorizeIntent(intent);
    if (intent === "refresh_connection" && !canRefreshStoreConnection(connection)) {
      setReauthorizeTargetId(null);
      return;
    }
    if (intent === "change_store" && !canChangeStoreConnection(connection)) {
      setReauthorizeTargetId(null);
      return;
    }
    if (connection.platform === "shopify" && !connection.shopDomain) {
      setError("Shopify authorization requires the stored shop domain. Disconnect and connect the store again if the domain is missing.");
      setReauthorizeTargetId(null);
      return;
    }
    if (!await ensureConnectProof(intent, connection)) return;
    try {
      await runStoreAction("reauth-start", async () => {
        const result = await postJson<DropshipStoreConnectionOAuthStartResponse>(
          "/api/dropship/store-connections/oauth/start",
          buildStoreConnectionOAuthStartInput({
            platform: connection.platform,
            intent,
            shopDomain: connection.shopDomain ?? "",
            returnTo: dropshipPortalPath("/settings"),
          }),
        );
        window.location.assign(result.authorizationUrl);
      });
    } finally {
      setReauthorizeTargetId(null);
    }
  }

  function cancelSensitiveActionVerification(): void {
    setEmailChallengeAction(null);
    setVerificationCode("");
    setDisconnectTargetId(null);
    setReauthorizeTargetId(null);
    setError("");
  }

  async function confirmSensitiveActionVerification(): Promise<void> {
    if (!emailChallengeAction || !verificationConnection) {
      cancelSensitiveActionVerification();
      setError("The selected store action is no longer available. Choose the action again.");
      return;
    }
    if (emailChallengeAction === "disconnect_store") {
      await disconnectStore(verificationConnection);
      return;
    }
    await reauthorizeStore(verificationConnection, reauthorizeIntent);
  }

  async function runStoreAction(action: PendingStoreAction, task: () => Promise<void>): Promise<boolean> {
    setPendingStoreAction(action);
    setError("");
    setMessage("");
    try {
      await task();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Store connection request failed.");
      return false;
    } finally {
      setPendingStoreAction(null);
    }
  }

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Settings className="h-6 w-6 text-[#C060E0]" />
            Settings
          </h1>
          <p className="mt-1 text-sm text-zinc-500">Account, store connection, wallet, notification, return contact, and Phase 2 surfaces.</p>
        </div>

        {connectionStatus && (
          <Alert className={connectionStatus.kind === "connected" ? "mt-5 border-emerald-200 bg-emerald-50 text-emerald-900" : "mt-5 border-rose-200 bg-rose-50 text-rose-900"}>
            {connectionStatus.kind === "connected" ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
            <AlertDescription>
              {storeOAuthCallbackMessage(connectionStatus, callbackStoreName)}
            </AlertDescription>
          </Alert>
        )}

        {settingsQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(settingsQuery.error, "Unable to load dropship settings.")}
            </AlertDescription>
          </Alert>
        )}
        {storeConnectionsQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(storeConnectionsQuery.error, "Unable to load store connections.")}
            </AlertDescription>
          </Alert>
        )}

        {settingsQuery.isLoading ? (
          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : settings ? (
          <>
            <section className="mt-5 grid gap-4 lg:grid-cols-3">
              <Metric title="Vendor" value={settings.vendor.businessName || settings.vendor.email || "Card Shellz member"} detail={formatStatus(settings.vendor.status)} />
              <Metric title="Wallet" value={formatCents(settings.wallet.availableBalanceCents)} detail={walletMetricDetail(settings)} />
              <Metric
                title="Generated"
                value={formatDateTime(settings.generatedAt)}
                detail={`${storeConnectionsQuery.data?.connections.length ?? settings.storeConnections.length} store connection(s)`}
              />
            </section>

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

            {emailChallengeAction && verificationConnection && (
              <SensitiveActionVerificationPanel
                emailChallengeAction={emailChallengeAction}
                connection={verificationConnection}
                intent={reauthorizeIntent}
                onCancel={cancelSensitiveActionVerification}
                onConfirm={confirmSensitiveActionVerification}
                pendingStoreAction={pendingStoreAction}
                verificationCode={verificationCode}
                onVerificationCodeChange={setVerificationCode}
              />
            )}

            <StoreConnectionsPanel
              result={storeConnectionsQuery.data}
              isLoading={storeConnectionsQuery.isLoading}
              emailChallengeAction={emailChallengeAction}
              pendingStoreAction={pendingStoreAction}
              disconnectTargetId={disconnectTargetId}
              reauthorizeTargetId={reauthorizeTargetId}
              onDisconnect={disconnectStore}
              onReauthorize={reauthorizeStore}
              reauthorizeIntent={reauthorizeIntent}
            />

            <section className="mt-5 grid gap-4 md:grid-cols-2">
              {settings.sections.map((section) => (
                <div key={section.key} className="rounded-md border border-zinc-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-700">
                        {icons[section.key]}
                      </div>
                      <div>
                        <h2 className="font-semibold">{section.label}</h2>
                        <p className="mt-1 text-sm text-zinc-500">{section.summary}</p>
                      </div>
                    </div>
                    <Badge variant="outline" className={sectionStatusTone(section.status)}>
                      {section.comingSoon ? "Coming soon" : formatStatus(section.status)}
                    </Badge>
                  </div>
                  {section.blockers.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {section.blockers.map((blocker) => (
                        <Badge key={blocker} variant="outline" className="border-amber-200 bg-amber-50 text-amber-900">
                          {formatStatus(blocker)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </section>
          </>
        ) : (
          <Empty className="mt-5 rounded-md border border-dashed p-8">
            <EmptyMedia variant="icon"><Settings /></EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>{settingsQuery.error ? "Settings unavailable" : "No settings"}</EmptyTitle>
              <EmptyDescription>
                {settingsQuery.error ? "The settings API request failed." : "Dropship settings could not be loaded."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </DropshipPortalShell>
  );
}

function StoreConnectionsPanel({
  disconnectTargetId,
  emailChallengeAction,
  isLoading,
  onDisconnect,
  onReauthorize,
  pendingStoreAction,
  reauthorizeIntent,
  reauthorizeTargetId,
  result,
}: {
  disconnectTargetId: number | null;
  emailChallengeAction: DropshipSensitiveAction | null;
  isLoading: boolean;
  onDisconnect: (connection: DropshipStoreConnectionProfileResponse) => void;
  onReauthorize: (connection: DropshipStoreConnectionProfileResponse, intent: DropshipStoreOAuthIntent) => void;
  pendingStoreAction: PendingStoreAction;
  reauthorizeIntent: DropshipStoreOAuthIntent;
  reauthorizeTargetId: number | null;
  result: DropshipStoreConnectionListResponse | undefined;
}) {
  if (isLoading) {
    return (
      <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
        <Skeleton className="h-6 w-48" />
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </section>
    );
  }

  const connections = result?.connections ?? [];
  const launchReadyCount = connections.filter((connection) => connection.launchReady).length;

  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Store connections</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {launchReadyCount} launch-ready / {result?.vendor.includedStoreConnections ?? 1} included connection(s)
          </p>
        </div>
        <Badge variant="outline" className={launchReadyCount > 0 ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}>
          {launchReadyCount > 0 ? "Launch ready" : "Attention required"}
        </Badge>
      </div>

      {connections.length ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {connections.map((connection) => (
            <StoreConnectionCard
              key={connection.storeConnectionId}
              connection={connection}
              setupChecks={result?.setupChecksByConnectionId[String(connection.storeConnectionId)] ?? []}
              disconnectTargetId={disconnectTargetId}
              emailChallengeAction={emailChallengeAction}
              pendingStoreAction={pendingStoreAction}
              reauthorizeIntent={reauthorizeIntent}
              reauthorizeTargetId={reauthorizeTargetId}
              onDisconnect={onDisconnect}
              onReauthorize={onReauthorize}
            />
          ))}
        </div>
      ) : (
        <Empty className="mt-4 rounded-md border border-dashed p-8">
          <EmptyMedia variant="icon"><Store /></EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No store connections</EmptyTitle>
            <EmptyDescription>Connect eBay or Shopify from onboarding before processing dropship orders.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </section>
  );
}

function StoreConnectionCard({
  connection,
  disconnectTargetId,
  emailChallengeAction,
  onDisconnect,
  onReauthorize,
  pendingStoreAction,
  reauthorizeIntent,
  reauthorizeTargetId,
  setupChecks,
}: {
  connection: DropshipStoreConnectionProfileResponse;
  disconnectTargetId: number | null;
  emailChallengeAction: DropshipSensitiveAction | null;
  onDisconnect: (connection: DropshipStoreConnectionProfileResponse) => void;
  onReauthorize: (connection: DropshipStoreConnectionProfileResponse, intent: DropshipStoreOAuthIntent) => void;
  pendingStoreAction: PendingStoreAction;
  reauthorizeIntent: DropshipStoreOAuthIntent;
  reauthorizeTargetId: number | null;
  setupChecks: DropshipStoreConnectionSetupCheck[];
}) {
  const isDisconnectTarget = disconnectTargetId === connection.storeConnectionId;
  const isReauthorizeTarget = reauthorizeTargetId === connection.storeConnectionId;
  const canDisconnect = canDisconnectStoreConnection(connection);
  const canRefresh = canRefreshStoreConnection(connection);
  const canChange = canChangeStoreConnection(connection);
  const actionSelectionLocked = storeActionButtonsLocked(emailChallengeAction, pendingStoreAction);
  const disconnectDisabled = !canDisconnect || actionSelectionLocked;
  const reauthorizeDisabled = actionSelectionLocked;
  const openSetupChecks = setupChecks.filter((check) => !check.resolvedAt);

  return (
    <div className="rounded-md border border-zinc-200 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Store className="h-4 w-4 text-zinc-500" />
            <div className="min-w-0">
              <div className="text-xs uppercase text-zinc-500">Connected store</div>
              <h3 className="truncate font-semibold">{connectionDisplayName(connection)}</h3>
            </div>
          </div>
          <p className="mt-1 text-sm text-zinc-500">{connectedStoreIdentityDetail(connection)}</p>
        </div>
        <Badge variant="outline" className={storeConnectionStatusTone(connection.status)}>
          {formatStatus(connection.status)}
        </Badge>
      </div>

      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <ConnectionFact label="Setup" value={formatStatus(connection.setupStatus)} />
        <ConnectionFact label="Default warehouse" value={connection.orderProcessingConfig.defaultWarehouseId ? String(connection.orderProcessingConfig.defaultWarehouseId) : "Admin controlled"} />
        <ConnectionFact label="Launch ready" value={connection.launchReady ? "Ready" : launchReadinessDetail(connection)} />
        <ConnectionFact label="Access token" value={connection.hasAccessToken ? "Present" : "Missing"} />
        <ConnectionFact label="Refresh token" value={connection.hasRefreshToken ? "Present" : "Missing"} />
        <ConnectionFact label="Last order sync" value={formatDateTime(connection.lastOrderSyncAt)} />
        <ConnectionFact label="Last inventory sync" value={formatDateTime(connection.lastInventorySyncAt)} />
        <ConnectionFact label="Token expires" value={formatDateTime(connection.tokenExpiresAt)} />
        <ConnectionFact label="Updated" value={formatDateTime(connection.updatedAt)} />
      </div>

      {connection.disconnectReason && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {connection.disconnectReason}
        </div>
      )}

      {openSetupChecks.length > 0 && (
        <div className="mt-4 space-y-2">
          {openSetupChecks.slice(0, 3).map((check) => (
            <div key={check.checkKey} className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{formatStatus(check.checkKey)}</span>
                <Badge variant="outline" className={setupCheckTone(check.severity)}>{formatStatus(check.severity)}</Badge>
              </div>
              {check.message && <p className="mt-1 text-zinc-500">{check.message}</p>}
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {canRefresh && (
          <Button
            type="button"
            className="h-auto min-h-10 min-w-0 gap-2 whitespace-normal bg-[#C060E0] text-center hover:bg-[#a94bc9]"
            disabled={reauthorizeDisabled}
            onClick={() => onReauthorize(connection, "refresh_connection")}
          >
            {reauthorizeButtonIcon({ intent: "refresh_connection", isReauthorizeTarget, pendingStoreAction, reauthorizeIntent })}
            {reauthorizeButtonLabel({ intent: "refresh_connection", isReauthorizeTarget, pendingStoreAction, platform: connection.platform, reauthorizeIntent, status: connection.status })}
          </Button>
        )}
        {canChange && (
          <Button
            type="button"
            variant={canRefresh ? "outline" : "default"}
            className={canRefresh
              ? "h-auto min-h-10 min-w-0 gap-2 whitespace-normal text-center"
              : "h-auto min-h-10 min-w-0 gap-2 whitespace-normal bg-[#C060E0] text-center hover:bg-[#a94bc9]"}
            disabled={reauthorizeDisabled}
            onClick={() => onReauthorize(connection, "change_store")}
          >
            {reauthorizeButtonIcon({ intent: "change_store", isReauthorizeTarget, pendingStoreAction, reauthorizeIntent })}
            {reauthorizeButtonLabel({ intent: "change_store", isReauthorizeTarget, pendingStoreAction, platform: connection.platform, reauthorizeIntent, status: connection.status })}
          </Button>
        )}
        {canDisconnect && (
          <Button
            type="button"
            variant="destructive"
            className="h-auto min-h-10 w-full gap-2 whitespace-normal text-center sm:col-span-2"
            disabled={disconnectDisabled}
            onClick={() => onDisconnect(connection)}
          >
            {disconnectButtonIcon({ isDisconnectTarget, pendingStoreAction })}
            {disconnectButtonLabel({ isDisconnectTarget, pendingStoreAction })}
          </Button>
        )}
      </div>
      {!canDisconnect && (
        <p className="mt-2 text-xs text-zinc-500">
          {connection.status === "grace_period" ? "Disconnect grace period is already active." : "This connection is already disconnected."}
        </p>
      )}
    </div>
  );
}

export function storeActionButtonsLocked(
  emailChallengeAction: DropshipSensitiveAction | null,
  pendingStoreAction: PendingStoreAction,
): boolean {
  return emailChallengeAction !== null || pendingStoreAction !== null;
}

export function storeVerificationActionContent(input: {
  connection: DropshipStoreConnectionProfileResponse;
  emailChallengeAction: DropshipSensitiveAction;
  intent: DropshipStoreOAuthIntent;
}): {
  actionLabel: string;
  confirmLabel: string;
} {
  const storeName = connectionDisplayName(input.connection);
  if (input.emailChallengeAction === "disconnect_store") {
    return {
      actionLabel: `Disconnect ${storeName}`,
      confirmLabel: `Verify and disconnect ${storeName}`,
    };
  }
  return {
    actionLabel: `${storeOAuthActionTitle(input.intent, input.connection.platform, input.connection.status)}: ${storeName}`,
    confirmLabel: `Verify and ${storeOAuthActionText(input.intent, input.connection.platform, input.connection.status)}`,
  };
}

export function SensitiveActionVerificationPanel({
  connection,
  emailChallengeAction,
  intent,
  onCancel,
  onConfirm,
  onVerificationCodeChange,
  pendingStoreAction,
  verificationCode,
}: {
  connection: DropshipStoreConnectionProfileResponse;
  emailChallengeAction: DropshipSensitiveAction;
  intent: DropshipStoreOAuthIntent;
  onCancel: () => void;
  onConfirm: () => void;
  onVerificationCodeChange: (value: string) => void;
  pendingStoreAction: PendingStoreAction;
  verificationCode: string;
}) {
  const content = storeVerificationActionContent({ connection, emailChallengeAction, intent });
  const pending = pendingStoreAction !== null;
  return (
    <section className="mt-5 rounded-md border border-[#C060E0]/40 bg-white p-4" aria-labelledby="store-action-verification-title">
      <div>
        <h2 id="store-action-verification-title" className="font-semibold">Confirm selected store action</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Enter the 6-digit verification code sent to your email. This code authorizes only the selected action below.
        </p>
      </div>
      <div className="mt-4 rounded-md border border-violet-200 bg-violet-50 p-3 text-sm text-violet-950">
        <span className="font-medium">Selected action:</span> {content.actionLabel}
      </div>
      <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <Label>{sensitiveActionVerificationLabel(emailChallengeAction)}</Label>
          <InputOTP
            maxLength={6}
            value={verificationCode}
            onChange={onVerificationCodeChange}
            disabled={pending}
          >
            <InputOTPGroup>
              {Array.from({ length: 6 }).map((_, index) => (
                <InputOTPSlot key={index} index={index} className="h-10 w-10 text-sm" />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row lg:justify-end">
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={emailChallengeAction === "disconnect_store" ? "destructive" : "default"}
            className={emailChallengeAction === "connect_store" ? "bg-[#C060E0] hover:bg-[#a94bc9]" : undefined}
            disabled={pending || verificationCode.length !== 6}
            onClick={onConfirm}
          >
            {pending ? "Verifying code" : content.confirmLabel}
          </Button>
        </div>
      </div>
    </section>
  );
}

function ConnectionFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <div className="text-xs uppercase text-zinc-500">{label}</div>
      <div className="mt-1 truncate font-medium text-zinc-900">{value}</div>
    </div>
  );
}

function Metric({ detail, title, value }: { detail: string; title: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-4">
      <div className="text-sm text-zinc-500">{title}</div>
      <div className="mt-2 truncate text-xl font-semibold">{value}</div>
      <div className="mt-1 text-sm text-zinc-500">{detail}</div>
    </div>
  );
}

function canDisconnectStoreConnection(connection: DropshipStoreConnectionProfileResponse): boolean {
  return connection.status !== "disconnected" && connection.status !== "grace_period";
}

export function canRefreshStoreConnection(connection: DropshipStoreConnectionProfileResponse): boolean {
  return connection.status === "needs_reauth"
    || connection.status === "refresh_failed"
    || connection.status === "grace_period"
    || connection.status === "disconnected"
    || (connection.status === "connected" && (connection.platform === "ebay" || !connection.launchReady));
}

export function canChangeStoreConnection(connection: DropshipStoreConnectionProfileResponse): boolean {
  return ["connected", "needs_reauth", "refresh_failed", "grace_period", "disconnected"].includes(connection.status);
}

function connectionDisplayName(connection: DropshipStoreConnectionProfileResponse): string {
  return connection.externalDisplayName || connection.shopDomain || `${formatStatus(connection.platform)} store name pending`;
}

function connectedStoreIdentityDetail(connection: DropshipStoreConnectionProfileResponse): string {
  const details = [formatStatus(connection.platform)];
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

function storeConnectionStatusTone(status: DropshipStoreConnectionProfileResponse["status"]): string {
  if (status === "connected") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "disconnected") return "border-zinc-200 bg-zinc-50 text-zinc-600";
  if (status === "grace_period" || status === "paused") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-rose-200 bg-rose-50 text-rose-800";
}

function setupCheckTone(severity: string): string {
  if (severity === "error") return "border-rose-200 bg-rose-50 text-rose-800";
  if (severity === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

function disconnectButtonLabel(input: {
  isDisconnectTarget: boolean;
  pendingStoreAction: PendingStoreAction;
}): string {
  if (input.isDisconnectTarget && input.pendingStoreAction === "disconnect-send-code") return "Sending code";
  if (input.isDisconnectTarget && input.pendingStoreAction === "disconnect-verify-code") return "Verifying code";
  if (input.isDisconnectTarget && input.pendingStoreAction === "disconnect-passkey-proof") return "Waiting for passkey";
  if (input.isDisconnectTarget && input.pendingStoreAction === "disconnect") return "Disconnecting";
  return "Disconnect";
}

function disconnectButtonIcon(input: {
  isDisconnectTarget: boolean;
  pendingStoreAction: PendingStoreAction;
}) {
  if (input.isDisconnectTarget && input.pendingStoreAction === "disconnect-passkey-proof") return <Fingerprint className="h-4 w-4" />;
  if (input.isDisconnectTarget && (input.pendingStoreAction === "disconnect-send-code" || input.pendingStoreAction === "disconnect-verify-code")) return <Mail className="h-4 w-4" />;
  return <Plug className="h-4 w-4" />;
}

function reauthorizeButtonLabel(input: {
  intent: DropshipStoreOAuthIntent;
  isReauthorizeTarget: boolean;
  pendingStoreAction: PendingStoreAction;
  platform: DropshipStoreConnectionProfileResponse["platform"];
  reauthorizeIntent: DropshipStoreOAuthIntent;
  status: DropshipStoreConnectionProfileResponse["status"];
}): string {
  const isActiveIntent = input.isReauthorizeTarget && input.reauthorizeIntent === input.intent;
  if (isActiveIntent && input.pendingStoreAction === "reauth-send-code") return "Sending code";
  if (isActiveIntent && input.pendingStoreAction === "reauth-verify-code") return "Verifying code";
  if (isActiveIntent && input.pendingStoreAction === "reauth-passkey-proof") return "Waiting for passkey";
  if (isActiveIntent && input.pendingStoreAction === "reauth-start") return "Opening authorization";
  return storeOAuthActionTitle(input.intent, input.platform, input.status);
}

function reauthorizeButtonIcon(input: {
  intent: DropshipStoreOAuthIntent;
  isReauthorizeTarget: boolean;
  pendingStoreAction: PendingStoreAction;
  reauthorizeIntent: DropshipStoreOAuthIntent;
}) {
  const isActiveIntent = input.isReauthorizeTarget && input.reauthorizeIntent === input.intent;
  if (isActiveIntent && input.pendingStoreAction === "reauth-passkey-proof") return <Fingerprint className="h-4 w-4" />;
  if (isActiveIntent && (input.pendingStoreAction === "reauth-send-code" || input.pendingStoreAction === "reauth-verify-code")) return <Mail className="h-4 w-4" />;
  return input.intent === "refresh_connection" ? <RefreshCw className="h-4 w-4" /> : <Store className="h-4 w-4" />;
}

export function storeOAuthActionTitle(
  intent: DropshipStoreOAuthIntent,
  platform: DropshipStoreConnectionProfileResponse["platform"],
  status?: DropshipStoreConnectionProfileResponse["status"],
): string {
  if (intent === "refresh_connection" && status === "grace_period") return `Reconnect ${formatStatus(platform)} store`;
  if (intent === "change_store" && status === "grace_period") return `Connect a different ${formatStatus(platform)} store`;
  if (intent === "refresh_connection") return `Refresh ${formatStatus(platform)} connection`;
  if (intent === "change_store") return `Change ${formatStatus(platform)} store`;
  return `Connect ${formatStatus(platform)}`;
}

function storeOAuthActionText(
  intent: DropshipStoreOAuthIntent,
  platform: DropshipStoreConnectionProfileResponse["platform"],
  status?: DropshipStoreConnectionProfileResponse["status"],
): string {
  if (intent === "refresh_connection" && status === "grace_period") return `reconnect the ${formatStatus(platform)} store`;
  if (intent === "change_store" && status === "grace_period") return `connect a different ${formatStatus(platform)} store`;
  if (intent === "refresh_connection") return `refresh the ${formatStatus(platform)} connection`;
  if (intent === "change_store") return `change the ${formatStatus(platform)} store`;
  return `connect ${formatStatus(platform)}`;
}

function sensitiveActionVerificationLabel(action: DropshipSensitiveAction): string {
  if (action === "connect_store") return "Store authorization verification code";
  if (action === "disconnect_store") return "Disconnect verification code";
  return "Verification code";
}

function walletMetricDetail(settings: DropshipSettingsResponse["settings"]): string {
  if (!settings.wallet.autoReloadEnabled) return "Auto-reload needs setup";
  if (!settings.wallet.autoReloadFundingMethodReady) return "Auto-reload funding method needs setup";
  const optionalUsdc = settings.wallet.activeUsdcBaseFundingMethodCount > 0
    ? ` / ${settings.wallet.activeUsdcBaseFundingMethodCount} optional USDC Base method${settings.wallet.activeUsdcBaseFundingMethodCount === 1 ? "" : "s"}`
    : "";
  return `${settings.wallet.activeStripeFundingMethodCount} Stripe-ready${optionalUsdc}`;
}
