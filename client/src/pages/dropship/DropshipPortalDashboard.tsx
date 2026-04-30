import React, { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  Fingerprint,
  KeyRound,
  LogOut,
  Mail,
  ShieldCheck,
  Store,
  Wallet,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { dropshipPortalPath, useDropshipAuth } from "@/lib/dropship-auth";

type PendingAction = "send-code" | "verify-code" | "passkey-proof" | "register-passkey" | "logout" | null;

export default function DropshipPortalDashboard() {
  const [, setLocation] = useLocation();
  const {
    logout,
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

  const stepUpMethod = principal?.hasPasskey ? "passkey" : "email_mfa";
  const registerPasskeyProofActive = useMemo(() => {
    const proof = sensitiveProofs.register_passkey;
    return !!proof && new Date(proof.expiresAt).getTime() > Date.now();
  }, [sensitiveProofs.register_passkey]);
  const statusLabel = useMemo(() => {
    if (!principal) return "Not signed in";
    return principal.entitlementStatus === "grace" ? "Billing grace" : "Active";
  }, [principal]);

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
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex min-h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-600 text-white">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="text-base font-semibold">Card Shellz</div>
              <div className="text-xs text-zinc-500">Dropship Portal</div>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={pendingAction === "logout"}
            onClick={() => run("logout", async () => {
              await logout();
              setLocation(dropshipPortalPath("/login"));
            })}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <section className="grid gap-4 lg:grid-cols-[1.4fr_0.9fr]">
          <div className="rounded-md border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-500">Signed in as</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-normal">{principal.cardShellzEmail}</h1>
              </div>
              <Badge className="w-fit bg-emerald-600 text-white hover:bg-emerald-600">{statusLabel}</Badge>
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <StatusTile icon={<KeyRound className="h-4 w-4" />} label="Login" value={principal.authMethod} />
              <StatusTile
                icon={<Fingerprint className="h-4 w-4" />}
                label="Passkey"
                value={principal.hasPasskey ? "Enrolled" : "Not enrolled"}
              />
              <StatusTile
                icon={<ShieldCheck className="h-4 w-4" />}
                label="Step-up"
                value={stepUpMethod === "passkey" ? "Passkey" : "Email MFA"}
              />
            </div>
          </div>

          <div className="rounded-md border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-zinc-950 text-white">
                <Fingerprint className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Passkey</h2>
                <p className="text-sm text-zinc-500">Account security</p>
              </div>
            </div>

            {error && (
              <Alert variant="destructive" className="mt-5">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {message && (
              <Alert className="mt-5 border-emerald-200 bg-emerald-50 text-emerald-900">
                <ShieldCheck className="h-4 w-4" />
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            )}

            {!principal.hasPasskey ? (
              <div className="mt-5 space-y-4">
                {!emailProofReady && (
                  <Button
                    type="button"
                    disabled={pendingAction === "send-code"}
                    variant="outline"
                    className="h-10 w-full gap-2"
                    onClick={() => run("send-code", async () => {
                      await startEmailStepUp("register_passkey");
                      setMessage("Verification code sent.");
                    })}
                  >
                    <Mail className="h-4 w-4" />
                    Send verification code
                  </Button>
                )}

                {!emailProofReady && (
                  <div className="space-y-3">
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
                    <Button
                      type="button"
                      disabled={verificationCode.length !== 6 || pendingAction === "verify-code"}
                      className="h-10 w-full gap-2 bg-emerald-600 hover:bg-emerald-700"
                      onClick={() => run("verify-code", async () => {
                        await verifyEmailStepUp({
                          action: "register_passkey",
                          verificationCode,
                        });
                        setEmailProofReady(true);
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
                  disabled={!registerPasskeyProofActive || !passkeysSupported || pendingAction === "register-passkey"}
                  className="h-10 w-full gap-2 bg-zinc-950 text-white hover:bg-zinc-800"
                  onClick={() => run("register-passkey", async () => {
                    await registerPasskey();
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
                    setMessage("Passkey added.");
                  })}
                >
                  <Fingerprint className="h-4 w-4" />
                  Add another passkey
                </Button>
              </div>
            )}
          </div>
        </section>

        <section className="mt-4 grid gap-4 md:grid-cols-3">
          <PortalModule icon={<Store className="h-5 w-5" />} title="Stores" label="Coming soon" />
          <PortalModule icon={<Wallet className="h-5 w-5" />} title="Wallet" label="Coming soon" />
          <PortalModule icon={<ShieldCheck className="h-5 w-5" />} title="Orders" label="Coming soon" />
        </section>
      </div>
    </main>
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
      <div className="mt-2 text-base font-semibold capitalize text-zinc-950">{value}</div>
    </div>
  );
}

function PortalModule({
  icon,
  title,
  label,
}: {
  icon: React.ReactNode;
  title: string;
  label: string;
}) {
  return (
    <div className="rounded-md border border-dashed border-zinc-300 bg-white p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-zinc-100 text-zinc-700">
            {icon}
          </div>
          <h3 className="font-semibold">{title}</h3>
        </div>
        <Badge variant="outline">{label}</Badge>
      </div>
    </div>
  );
}
