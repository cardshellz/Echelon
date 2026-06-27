import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Fingerprint,
  KeyRound,
  Lock,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import {
  dropshipPortalPath,
  type DropshipAuthEmailStatus,
  useDropshipAuth,
} from "@/lib/dropship-auth";

type AuthStep = "email" | "returning" | "code" | "password" | "ineligible";
type PendingAction = "lookup" | "code-start" | "code-complete" | "password" | "passkey" | null;

const OPS_UPSELL_URL = "https://www.cardshellz.com/pages/club";

export default function DropshipPortalAuth() {
  const [, setLocation] = useLocation();
  const {
    completeBootstrap,
    isAuthenticated,
    loginWithPasskey,
    loginWithPassword,
    lookupAuthEmail,
    passkeysSupported,
    platformPasskeyAvailable,
    startBootstrap,
  } = useDropshipAuth();
  const [step, setStep] = useState<AuthStep>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [emailStatus, setEmailStatus] = useState<DropshipAuthEmailStatus | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (isAuthenticated) {
      setLocation(dropshipPortalPath("/onboarding"));
    }
  }, [isAuthenticated, setLocation]);

  const canUsePasskey = passkeysSupported && emailStatus?.hasPasskey;
  const passkeyLabel = useMemo(
    () => platformPasskeyAvailable ? "Continue with passkey" : "Continue with security key",
    [platformPasskeyAvailable],
  );
  const normalizedEmail = emailValue(email);

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

  async function sendVerificationCode() {
    await startBootstrap(normalizedEmail);
    setCodeSent(true);
    setVerificationCode("");
    setStep("code");
    setMessage("Verification code sent.");
  }

  function resetToEmail() {
    setStep("email");
    setEmailStatus(null);
    setCodeSent(false);
    setVerificationCode("");
    setPassword("");
    setMessage("");
    setError("");
  }

  function continueToPortal() {
    setLocation(dropshipPortalPath("/onboarding"));
  }

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto grid min-h-screen w-full max-w-6xl grid-cols-1 lg:grid-cols-[1fr_440px]">
        <section className="hidden border-r border-zinc-200 bg-white px-10 py-12 lg:flex lg:flex-col lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-md bg-[#C060E0] text-white">
                <ShieldCheck className="h-6 w-6" />
              </div>
              <div>
                <div className="text-lg font-semibold">Card Shellz</div>
                <div className="text-sm text-zinc-500">Dropship Portal</div>
              </div>
            </div>
            <div className="mt-20 max-w-xl">
              <h1 className="text-4xl font-semibold tracking-normal text-zinc-950">
                Secure vendor access for `.ops` members.
              </h1>
              <p className="mt-5 text-base leading-7 text-zinc-600">
                Start with the email on your Card Shellz account. Eligible members can continue with a code, password, or passkey.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div className="rounded-md border border-zinc-200 p-4">
              <div className="font-medium text-zinc-900">Identity</div>
              <div className="mt-1 text-zinc-500">Card Shellz email</div>
            </div>
            <div className="rounded-md border border-zinc-200 p-4">
              <div className="font-medium text-zinc-900">Access</div>
              <div className="mt-1 text-zinc-500">`.ops` entitlement</div>
            </div>
            <div className="rounded-md border border-zinc-200 p-4">
              <div className="font-medium text-zinc-900">Step-up</div>
              <div className="mt-1 text-zinc-500">Passkey or email MFA</div>
            </div>
          </div>
        </section>

        <section className="flex items-center justify-center px-4 py-10 sm:px-8">
          <div className="w-full max-w-[440px] rounded-md border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="mb-6 lg:hidden">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[#C060E0] text-white">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-base font-semibold">Card Shellz</div>
                  <div className="text-xs text-zinc-500">Dropship Portal</div>
                </div>
              </div>
            </div>

            {step !== "email" && (
              <Button
                type="button"
                variant="ghost"
                onClick={resetToEmail}
                className="-ml-2 mb-4 h-9 gap-2 px-2 text-zinc-600"
              >
                <ArrowLeft className="h-4 w-4" />
                Change email
              </Button>
            )}

            <div className="space-y-2">
              <h2 className="text-2xl font-semibold tracking-normal">{headingForStep(step, emailStatus)}</h2>
              <p className="text-sm text-zinc-500">{descriptionForStep(step, normalizedEmail)}</p>
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

            {step === "email" && (
              <form
                className="mt-6 space-y-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  run("lookup", async () => {
                    const status = await lookupAuthEmail(normalizedEmail);
                    setEmailStatus(status);
                    if (!status.eligible) {
                      setStep("ineligible");
                      return;
                    }
                    if (status.status === "eligible_returning") {
                      setStep("returning");
                      return;
                    }
                    await sendVerificationCode();
                  });
                }}
              >
                <EmailField email={email} onEmailChange={setEmail} />
                <Button
                  type="submit"
                  disabled={!normalizedEmail || pendingAction === "lookup"}
                  className="h-11 w-full gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
                >
                  {pendingAction === "lookup" ? "Checking access" : "Continue"}
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </form>
            )}

            {step === "returning" && (
              <div className="mt-6 space-y-3">
                {canUsePasskey && (
                  <Button
                    type="button"
                    disabled={pendingAction === "passkey"}
                    onClick={() => run("passkey", async () => {
                      await loginWithPasskey(normalizedEmail);
                      continueToPortal();
                    })}
                    className="h-11 w-full gap-2 bg-[#C060E0] text-white hover:bg-[#a94bc9]"
                  >
                    <Fingerprint className="h-4 w-4" />
                    {pendingAction === "passkey" ? "Waiting for passkey" : passkeyLabel}
                  </Button>
                )}
                {emailStatus?.hasPassword && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setPassword("");
                      setStep("password");
                    }}
                    className="h-11 w-full gap-2"
                  >
                    <KeyRound className="h-4 w-4" />
                    Continue with password
                  </Button>
                )}
                <Button
                  type="button"
                  variant={emailStatus?.hasPassword || canUsePasskey ? "secondary" : "default"}
                  disabled={pendingAction === "code-start"}
                  onClick={() => run("code-start", sendVerificationCode)}
                  className="h-11 w-full gap-2"
                >
                  <Mail className="h-4 w-4" />
                  {pendingAction === "code-start" ? "Sending code" : "Email me a code"}
                </Button>
              </div>
            )}

            {step === "password" && (
              <form
                className="mt-6 space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  run("password", async () => {
                    await loginWithPassword({ email: normalizedEmail, password });
                    continueToPortal();
                  });
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="dropship-password">Password</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                    <Input
                      id="dropship-password"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="current-password"
                      className="h-11 pl-10"
                    />
                  </div>
                </div>
                <Button
                  type="submit"
                  disabled={!password || pendingAction === "password"}
                  className="h-11 w-full gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
                >
                  {pendingAction === "password" ? "Signing in" : "Sign in"}
                  <ArrowRight className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pendingAction === "code-start"}
                  onClick={() => run("code-start", sendVerificationCode)}
                  className="h-10 w-full gap-2"
                >
                  <Mail className="h-4 w-4" />
                  Email me a code instead
                </Button>
              </form>
            )}

            {step === "code" && (
              <div className="mt-6 space-y-4">
                <div className="space-y-2">
                  <Label>Verification code</Label>
                  <InputOTP
                    maxLength={6}
                    value={verificationCode}
                    onChange={setVerificationCode}
                    containerClassName="justify-between"
                  >
                    <InputOTPGroup>
                      {Array.from({ length: 6 }).map((_, index) => (
                        <InputOTPSlot key={index} index={index} className="h-11 w-11 text-base" />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                <Button
                  type="button"
                  disabled={verificationCode.length !== 6 || pendingAction === "code-complete"}
                  onClick={() => run("code-complete", async () => {
                    await completeBootstrap({
                      email: normalizedEmail,
                      verificationCode,
                    });
                    continueToPortal();
                  })}
                  className="h-11 w-full gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
                >
                  {pendingAction === "code-complete" ? "Verifying" : codeSent ? "Continue" : "Verify code"}
                  <ArrowRight className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pendingAction === "code-start"}
                  onClick={() => run("code-start", sendVerificationCode)}
                  className="h-11 w-full gap-2"
                >
                  <Mail className="h-4 w-4" />
                  {pendingAction === "code-start" ? "Sending code" : "Send another code"}
                </Button>
              </div>
            )}

            {step === "ineligible" && (
              <div className="mt-6 space-y-4">
                <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                  This email is not currently authorized for `.ops` dropship access.
                </div>
                <Button asChild className="h-11 w-full gap-2 bg-[#C060E0] text-white hover:bg-[#a94bc9]">
                  <a href={OPS_UPSELL_URL} target="_blank" rel="noreferrer">
                    Sign up for .ops
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function EmailField({
  email,
  onEmailChange,
}: {
  email: string;
  onEmailChange: (email: string) => void;
}) {
  return (
    <div className="space-y-3">
      <Label htmlFor="dropship-email">Card Shellz email</Label>
      <div className="relative">
        <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <Input
          id="dropship-email"
          type="email"
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
          autoComplete="email webauthn"
          className="h-11 pl-10"
        />
      </div>
    </div>
  );
}

function headingForStep(step: AuthStep, status: DropshipAuthEmailStatus | null): string {
  if (step === "returning") return "Welcome back";
  if (step === "code") return status?.status === "eligible_new" ? "Verify your email" : "Check your email";
  if (step === "password") return "Enter password";
  if (step === "ineligible") return ".ops access required";
  return "Sign in";
}

function descriptionForStep(step: AuthStep, email: string): string {
  if (step === "returning") return email;
  if (step === "code") return `Enter the 6-digit code sent to ${email}.`;
  if (step === "password") return email;
  if (step === "ineligible") return "Use an eligible account email or upgrade to continue.";
  return "Use the email on your Card Shellz customer account.";
}

function emailValue(email: string): string {
  return email.trim().toLowerCase();
}
