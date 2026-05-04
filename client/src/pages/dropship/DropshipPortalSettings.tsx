import { useState } from "react";
import type React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Bell, CheckCircle2, Fingerprint, KeyRound, Mail, Plug, Settings, Store, Wallet } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
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
  type DropshipStoreConnectionProfileResponse,
  type DropshipStoreConnectionSetupCheck,
} from "@/lib/dropship-ops-surface";
import { useDropshipAuth } from "@/lib/dropship-auth";
import { DropshipPortalShell } from "./DropshipPortalShell";

type PendingStoreAction = "send-code" | "verify-code" | "passkey-proof" | "disconnect" | null;

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
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [pendingStoreAction, setPendingStoreAction] = useState<PendingStoreAction>(null);
  const [disconnectTargetId, setDisconnectTargetId] = useState<number | null>(null);
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

  const hasActiveDisconnectProof = () => {
    const proof = sensitiveProofs.disconnect_store;
    return !!proof && new Date(proof.expiresAt).getTime() > Date.now();
  };

  async function ensureDisconnectProof(): Promise<boolean> {
    if (hasActiveDisconnectProof()) return true;
    if (principal?.hasPasskey) {
      return runStoreAction("passkey-proof", async () => {
        await verifyPasskeyStepUp("disconnect_store");
      });
    }

    if (!emailCodeSent) {
      await runStoreAction("send-code", async () => {
        await startEmailStepUp("disconnect_store");
        setEmailCodeSent(true);
        setMessage("Verification code sent. Enter it below, then retry the disconnect.");
      });
      return false;
    }

    if (verificationCode.length !== 6) {
      setError("Enter the 6-digit verification code before disconnecting.");
      return false;
    }

    return runStoreAction("verify-code", async () => {
      await verifyEmailStepUp({
        action: "disconnect_store",
        verificationCode,
      });
    });
  }

  async function disconnectStore(connection: DropshipStoreConnectionProfileResponse): Promise<void> {
    setDisconnectTargetId(connection.storeConnectionId);
    try {
      if (!await ensureDisconnectProof()) return;

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
        setEmailCodeSent(false);
        setVerificationCode("");
        setMessage(`${connectionDisplayName(response.connection)} moved to ${formatStatus(response.connection.status)}.`);
      });
    } finally {
      setDisconnectTargetId(null);
    }
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
              <Metric title="Wallet" value={formatCents(settings.wallet.availableBalanceCents)} detail={settings.wallet.autoReloadEnabled ? "Auto-reload enabled" : "Auto-reload needs setup"} />
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

            {emailCodeSent && (
              <SensitiveActionVerificationPanel
                pendingStoreAction={pendingStoreAction}
                verificationCode={verificationCode}
                onVerificationCodeChange={setVerificationCode}
              />
            )}

            <StoreConnectionsPanel
              result={storeConnectionsQuery.data}
              isLoading={storeConnectionsQuery.isLoading}
              emailCodeSent={emailCodeSent}
              pendingStoreAction={pendingStoreAction}
              disconnectTargetId={disconnectTargetId}
              verificationCode={verificationCode}
              onDisconnect={disconnectStore}
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
  emailCodeSent,
  isLoading,
  onDisconnect,
  pendingStoreAction,
  result,
  verificationCode,
}: {
  disconnectTargetId: number | null;
  emailCodeSent: boolean;
  isLoading: boolean;
  onDisconnect: (connection: DropshipStoreConnectionProfileResponse) => void;
  pendingStoreAction: PendingStoreAction;
  result: DropshipStoreConnectionListResponse | undefined;
  verificationCode: string;
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

  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Store connections</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {connections.length} of {result?.vendor.includedStoreConnections ?? 1} included connection(s) configured
          </p>
        </div>
        <Badge variant="outline" className={connections.some((connection) => connection.status === "connected") ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}>
          {connections.some((connection) => connection.status === "connected") ? "Connected" : "Attention required"}
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
              emailCodeSent={emailCodeSent}
              pendingStoreAction={pendingStoreAction}
              verificationCode={verificationCode}
              onDisconnect={onDisconnect}
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
  emailCodeSent,
  onDisconnect,
  pendingStoreAction,
  setupChecks,
  verificationCode,
}: {
  connection: DropshipStoreConnectionProfileResponse;
  disconnectTargetId: number | null;
  emailCodeSent: boolean;
  onDisconnect: (connection: DropshipStoreConnectionProfileResponse) => void;
  pendingStoreAction: PendingStoreAction;
  setupChecks: DropshipStoreConnectionSetupCheck[];
  verificationCode: string;
}) {
  const isDisconnectTarget = disconnectTargetId === connection.storeConnectionId;
  const pending = pendingStoreAction !== null;
  const canDisconnect = canDisconnectStoreConnection(connection);
  const disconnectDisabled = !canDisconnect || pending || (emailCodeSent && verificationCode.length !== 6);
  const openSetupChecks = setupChecks.filter((check) => !check.resolvedAt);

  return (
    <div className="rounded-md border border-zinc-200 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Store className="h-4 w-4 text-zinc-500" />
            <h3 className="truncate font-semibold">{connectionDisplayName(connection)}</h3>
          </div>
          <p className="mt-1 text-sm text-zinc-500">{formatStatus(connection.platform)}</p>
        </div>
        <Badge variant="outline" className={storeConnectionStatusTone(connection.status)}>
          {formatStatus(connection.status)}
        </Badge>
      </div>

      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <ConnectionFact label="Setup" value={formatStatus(connection.setupStatus)} />
        <ConnectionFact label="Default warehouse" value={connection.orderProcessingConfig.defaultWarehouseId ? String(connection.orderProcessingConfig.defaultWarehouseId) : "Admin controlled"} />
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

      <Button
        type="button"
        variant="destructive"
        className="mt-4 h-10 w-full gap-2"
        disabled={disconnectDisabled}
        onClick={() => onDisconnect(connection)}
      >
        {storeConnectionButtonIcon({ emailCodeSent, isDisconnectTarget, pendingStoreAction })}
        {storeConnectionButtonLabel({ emailCodeSent, isDisconnectTarget, pendingStoreAction })}
      </Button>
      {!canDisconnect && (
        <p className="mt-2 text-xs text-zinc-500">
          {connection.status === "grace_period" ? "Disconnect grace period is already active." : "This connection is already disconnected."}
        </p>
      )}
    </div>
  );
}

function SensitiveActionVerificationPanel({
  onVerificationCodeChange,
  pendingStoreAction,
  verificationCode,
}: {
  onVerificationCodeChange: (value: string) => void;
  pendingStoreAction: PendingStoreAction;
  verificationCode: string;
}) {
  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
      <div className="max-w-sm space-y-2">
        <Label>Verification code</Label>
        <InputOTP
          maxLength={6}
          value={verificationCode}
          onChange={onVerificationCodeChange}
          containerClassName="justify-between"
          disabled={pendingStoreAction !== null}
        >
          <InputOTPGroup>
            {Array.from({ length: 6 }).map((_, index) => (
              <InputOTPSlot key={index} index={index} className="h-10 w-10 text-sm" />
            ))}
          </InputOTPGroup>
        </InputOTP>
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

function connectionDisplayName(connection: DropshipStoreConnectionProfileResponse): string {
  return connection.externalDisplayName || connection.shopDomain || `${formatStatus(connection.platform)} connection ${connection.storeConnectionId}`;
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

function storeConnectionButtonLabel(input: {
  emailCodeSent: boolean;
  isDisconnectTarget: boolean;
  pendingStoreAction: PendingStoreAction;
}): string {
  if (input.isDisconnectTarget && input.pendingStoreAction === "send-code") return "Sending code";
  if (input.isDisconnectTarget && input.pendingStoreAction === "verify-code") return "Verifying code";
  if (input.isDisconnectTarget && input.pendingStoreAction === "passkey-proof") return "Waiting for passkey";
  if (input.isDisconnectTarget && input.pendingStoreAction === "disconnect") return "Disconnecting";
  if (input.emailCodeSent) return "Verify and disconnect";
  return "Disconnect";
}

function storeConnectionButtonIcon(input: {
  emailCodeSent: boolean;
  isDisconnectTarget: boolean;
  pendingStoreAction: PendingStoreAction;
}) {
  if (input.isDisconnectTarget && input.pendingStoreAction === "passkey-proof") return <Fingerprint className="h-4 w-4" />;
  if (input.isDisconnectTarget && (input.pendingStoreAction === "send-code" || input.pendingStoreAction === "verify-code")) return <Mail className="h-4 w-4" />;
  if (input.emailCodeSent) return <Mail className="h-4 w-4" />;
  return <Plug className="h-4 w-4" />;
}
