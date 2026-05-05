import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRight,
  Bell,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  Fingerprint,
  KeyRound,
  Mail,
  Plug,
  ShieldCheck,
  Store,
  Wallet,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useDropshipAuth } from "@/lib/dropship-auth";
import {
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  sectionStatusTone,
  type DropshipSettingsResponse,
  type DropshipSettingsSection,
  type DropshipStoreConnectionSummary,
} from "@/lib/dropship-ops-surface";
import { DropshipPortalShell } from "./DropshipPortalShell";

type PendingAction = "send-code" | "verify-code" | "passkey-proof" | "register-passkey" | null;

const sectionIcons: Record<DropshipSettingsSection["key"], React.ReactNode> = {
  account: <ShieldCheck className="h-4 w-4" />,
  store_connection: <Store className="h-4 w-4" />,
  wallet_payment: <Wallet className="h-4 w-4" />,
  notifications: <Bell className="h-4 w-4" />,
  api_keys: <KeyRound className="h-4 w-4" />,
  webhooks: <Plug className="h-4 w-4" />,
  return_contact: <Mail className="h-4 w-4" />,
};

export default function DropshipPortalDashboard() {
  const {
    passkeysSupported,
    principal,
    registerPasskey,
    sensitiveProofs,
    startEmailStepUp,
    verifyEmailStepUp,
    verifyPasskeyStepUp,
  } = useDropshipAuth();
  const [verificationCode, setVerificationCode] = useState("");
  const [emailProofReady, setEmailProofReady] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const settingsQuery = useQuery<DropshipSettingsResponse>({
    queryKey: ["/api/dropship/settings"],
    queryFn: () => fetchJson<DropshipSettingsResponse>("/api/dropship/settings"),
    enabled: !!principal,
  });

  const settings = settingsQuery.data?.settings;
  const stepUpMethod = principal?.hasPasskey ? "passkey" : "email_mfa";
  const registerPasskeyProofActive = useMemo(() => {
    const proof = sensitiveProofs.register_passkey;
    return !!proof && new Date(proof.expiresAt).getTime() > Date.now();
  }, [sensitiveProofs.register_passkey]);
  const statusLabel = useMemo(() => {
    if (!principal) return "Not signed in";
    if (settings?.vendor.entitlementStatus) return formatStatus(settings.vendor.entitlementStatus);
    return principal.entitlementStatus === "grace" ? "Billing grace" : "Active";
  }, [principal, settings?.vendor.entitlementStatus]);

  async function run(action: PendingAction, task: () => Promise<void>) {
    setPendingAction(action);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setPendingAction(null);
    }
  }

  if (!principal) {
    return null;
  }

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        {settingsQuery.error && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {settingsQuery.error instanceof Error ? settingsQuery.error.message : "Unable to load dropship settings."}
            </AlertDescription>
          </Alert>
        )}

        <section className="grid gap-4 xl:grid-cols-[1.4fr_0.9fr]">
          <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-500">Signed in as</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-normal">{principal.cardShellzEmail}</h1>
                {settings?.vendor.businessName && (
                  <p className="mt-1 text-sm text-zinc-500">{settings.vendor.businessName}</p>
                )}
              </div>
              <Badge className="w-fit bg-[#C060E0] text-white hover:bg-[#C060E0]">{statusLabel}</Badge>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatusTile
                icon={<Store className="h-4 w-4" />}
                label="Store connections"
                value={settings ? `${settings.storeConnections.length} of ${settings.vendor.includedStoreConnections}` : "Loading"}
              />
              <StatusTile
                icon={<CircleDollarSign className="h-4 w-4" />}
                label="Wallet available"
                value={settings ? formatCents(settings.wallet.availableBalanceCents) : "Loading"}
              />
              <StatusTile
                icon={<Wallet className="h-4 w-4" />}
                label="Auto-reload"
                value={settings ? (settings.wallet.autoReloadEnabled ? "Enabled" : "Needs setup") : "Loading"}
              />
              <StatusTile
                icon={<Clock className="h-4 w-4" />}
                label="Last checked"
                value={settings ? formatDateTime(settings.generatedAt) : "Loading"}
              />
            </div>
          </div>

          <SecurityPanel
            emailProofReady={emailProofReady}
            error={error}
            message={message}
            passkeysSupported={passkeysSupported}
            pendingAction={pendingAction}
            registerPasskeyProofActive={registerPasskeyProofActive}
            stepUpMethod={stepUpMethod}
            verificationCode={verificationCode}
            hasPasskey={principal.hasPasskey}
            onVerificationCodeChange={setVerificationCode}
            run={run}
            registerPasskey={registerPasskey}
            setEmailProofReady={setEmailProofReady}
            setMessage={setMessage}
            startEmailStepUp={startEmailStepUp}
            verifyEmailStepUp={verifyEmailStepUp}
            verifyPasskeyStepUp={verifyPasskeyStepUp}
          />
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[1fr_0.8fr]">
          <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Settings</h2>
                <p className="text-sm text-zinc-500">Launch readiness sections</p>
              </div>
              {settings && (
                <Badge variant="outline" className="w-fit">
                  {settings.sections.filter((section) => section.status === "attention_required").length} need attention
                </Badge>
              )}
            </div>
            {settingsQuery.isLoading ? (
              <SettingsSkeleton />
            ) : (
              <div className="mt-5 grid gap-3 md:grid-cols-2">
                {(settings?.sections ?? []).map((section) => (
                  <SettingsSectionCard key={section.key} section={section} />
                ))}
              </div>
            )}
          </div>

          <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Stores</h2>
                <p className="text-sm text-zinc-500">External store connection health</p>
              </div>
              {settings && <Badge variant="outline">{settings.storeConnections.length} configured</Badge>}
            </div>
            {settingsQuery.isLoading ? (
              <div className="mt-5 space-y-3">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : settings?.storeConnections.length ? (
              <div className="mt-5 space-y-3">
                {settings.storeConnections.map((connection) => (
                  <StoreConnectionCard key={connection.storeConnectionId} connection={connection} />
                ))}
              </div>
            ) : (
              <div className="mt-5 rounded-md border border-dashed border-zinc-300 p-5 text-sm text-zinc-600">
                No store connection configured.
              </div>
            )}
          </div>
        </section>
      </div>
    </DropshipPortalShell>
  );
}

function SecurityPanel({
  emailProofReady,
  error,
  hasPasskey,
  message,
  passkeysSupported,
  pendingAction,
  registerPasskey,
  registerPasskeyProofActive,
  run,
  setEmailProofReady,
  setMessage,
  startEmailStepUp,
  stepUpMethod,
  verificationCode,
  verifyEmailStepUp,
  verifyPasskeyStepUp,
  onVerificationCodeChange,
}: {
  emailProofReady: boolean;
  error: string;
  hasPasskey: boolean;
  message: string;
  passkeysSupported: boolean;
  pendingAction: PendingAction;
  registerPasskey: () => Promise<unknown>;
  registerPasskeyProofActive: boolean;
  run: (action: PendingAction, task: () => Promise<void>) => Promise<void>;
  setEmailProofReady: (value: boolean) => void;
  setMessage: (value: string) => void;
  startEmailStepUp: (action: "register_passkey") => Promise<void>;
  stepUpMethod: "passkey" | "email_mfa";
  verificationCode: string;
  verifyEmailStepUp: (input: { action: "register_passkey"; verificationCode: string }) => Promise<unknown>;
  verifyPasskeyStepUp: (action: "register_passkey") => Promise<unknown>;
  onVerificationCodeChange: (value: string) => void;
}) {
  const proofReady = emailProofReady || registerPasskeyProofActive;

  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-zinc-950 text-white">
            <Fingerprint className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Security</h2>
            <p className="text-sm text-zinc-500">Sensitive action proof: {stepUpMethod === "passkey" ? "passkey" : "email MFA"}</p>
          </div>
        </div>
        <Badge variant="outline">{hasPasskey ? "Passkey enrolled" : "Email MFA"}</Badge>
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

      {!hasPasskey ? (
        <div className="mt-5 space-y-4">
          {!proofReady && (
            <Button
              type="button"
              disabled={pendingAction === "send-code"}
              variant="outline"
              className="h-10 w-full gap-2"
              onClick={() => run("send-code", async () => {
                await startEmailStepUp("register_passkey");
                onVerificationCodeChange("");
                setMessage("Verification code sent.");
              })}
            >
              <Mail className="h-4 w-4" />
              Send verification code
            </Button>
          )}

          {!proofReady && (
            <div className="space-y-3">
              <Label>Verification code</Label>
              <InputOTP
                maxLength={6}
                value={verificationCode}
                onChange={onVerificationCodeChange}
                containerClassName="justify-between"
                disabled={pendingAction !== null}
              >
                <InputOTPGroup>
                  {Array.from({ length: 6 }).map((_, index) => (
                    <InputOTPSlot key={index} index={index} className="h-10 w-10 text-sm" />
                  ))}
                </InputOTPGroup>
              </InputOTP>
              <Button
                type="button"
                disabled={verificationCode.length !== 6 || pendingAction === "verify-code"}
                className="h-10 w-full gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
                onClick={() => run("verify-code", async () => {
                  await verifyEmailStepUp({
                    action: "register_passkey",
                    verificationCode,
                  });
                  setEmailProofReady(true);
                  onVerificationCodeChange("");
                  setMessage("Verification confirmed.");
                })}
              >
                Confirm code
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          )}

          <Button
            type="button"
            disabled={!proofReady || !passkeysSupported || pendingAction === "register-passkey"}
            className="h-10 w-full gap-2 bg-zinc-950 text-white hover:bg-zinc-800"
            onClick={() => run("register-passkey", async () => {
              await registerPasskey();
              setEmailProofReady(false);
              onVerificationCodeChange("");
              setMessage("Passkey added.");
            })}
          >
            <Fingerprint className="h-4 w-4" />
            Add passkey
          </Button>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <Button
            type="button"
            disabled={!passkeysSupported || pendingAction === "passkey-proof"}
            variant="outline"
            className="h-10 w-full gap-2"
            onClick={() => run("passkey-proof", async () => {
              await verifyPasskeyStepUp("register_passkey");
              setMessage("Passkey confirmed.");
            })}
          >
            <Fingerprint className="h-4 w-4" />
            Confirm passkey
          </Button>
          <Button
            type="button"
            disabled={!registerPasskeyProofActive || pendingAction === "register-passkey"}
            className="h-10 w-full gap-2 bg-zinc-950 text-white hover:bg-zinc-800"
            onClick={() => run("register-passkey", async () => {
              await registerPasskey();
              setEmailProofReady(false);
              onVerificationCodeChange("");
              setMessage("Passkey added.");
            })}
          >
            <Fingerprint className="h-4 w-4" />
            Add another passkey
          </Button>
        </div>
      )}
    </div>
  );
}

function StatusTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border border-zinc-200 p-4">
      <div className="flex items-center gap-2 text-sm text-zinc-500">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-base font-semibold text-zinc-950">{value}</div>
    </div>
  );
}

function SettingsSectionCard({ section }: { section: DropshipSettingsSection }) {
  return (
    <div className="rounded-md border border-zinc-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-700">
            {sectionIcons[section.key]}
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold">{section.label}</h3>
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
  );
}

function StoreConnectionCard({ connection }: { connection: DropshipStoreConnectionSummary }) {
  return (
    <div className="rounded-md border border-zinc-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{connection.externalDisplayName || formatStatus(connection.platform)}</h3>
          <p className="mt-1 text-sm text-zinc-500">{connection.shopDomain || formatStatus(connection.platform)}</p>
        </div>
        <Badge variant="outline">{formatStatus(connection.status)}</Badge>
      </div>
      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <div className="text-zinc-500">Setup</div>
          <div className="mt-1 font-medium">{formatStatus(connection.setupStatus)}</div>
        </div>
        <div>
          <div className="text-zinc-500">Updated</div>
          <div className="mt-1 font-medium">{formatDateTime(connection.updatedAt)}</div>
        </div>
      </div>
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className="mt-5 grid gap-3 md:grid-cols-2">
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className="h-28 w-full" />
      ))}
    </div>
  );
}
