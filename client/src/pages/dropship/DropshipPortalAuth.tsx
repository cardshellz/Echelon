import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { AlertCircle, ArrowRight, Fingerprint, KeyRound, Lock, Mail, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dropshipPortalPath, useDropshipAuth } from "@/lib/dropship-auth";

type AuthTab = "password" | "setup";

export default function DropshipPortalAuth() {
  const [, setLocation] = useLocation();
  const {
    completeBootstrap,
    isAuthenticated,
    loginWithPasskey,
    loginWithPassword,
    passkeysSupported,
    platformPasskeyAvailable,
    startBootstrap,
  } = useDropshipAuth();
  const [tab, setTab] = useState<AuthTab>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [setupCodeSent, setSetupCodeSent] = useState(false);
  const [pendingAction, setPendingAction] = useState<"password" | "passkey" | "setup-start" | "setup-complete" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (isAuthenticated) {
      setLocation(dropshipPortalPath("/dashboard"));
    }
  }, [isAuthenticated, setLocation]);

  useEffect(() => {
    if (window.location.pathname.endsWith("/setup")) {
      setTab("setup");
    }
  }, []);

  const canUsePasskey = passkeysSupported;
  const passkeyLabel = useMemo(
    () => platformPasskeyAvailable ? "Continue with passkey" : "Continue with security key",
    [platformPasskeyAvailable],
  );

  async function run(action: typeof pendingAction, task: () => Promise<void>) {
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

  function emailValue(): string {
    return email.trim().toLowerCase();
  }

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto grid min-h-screen w-full max-w-6xl grid-cols-1 lg:grid-cols-[1fr_440px]">
        <section className="hidden border-r border-zinc-200 bg-white px-10 py-12 lg:flex lg:flex-col lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-md bg-emerald-600 text-white">
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
                Sign in with your Card Shellz account email, then protect account changes with passkey or email verification.
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
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-600 text-white">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-base font-semibold">Card Shellz</div>
                  <div className="text-xs text-zinc-500">Dropship Portal</div>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <h2 className="text-2xl font-semibold tracking-normal">Sign in</h2>
              <p className="text-sm text-zinc-500">Use the email on your Card Shellz customer account.</p>
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

            <div className="mt-6 space-y-3">
              <Label htmlFor="dropship-email">Card Shellz email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <Input
                  id="dropship-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email webauthn"
                  className="h-11 pl-10"
                />
              </div>
            </div>

            <Button
              type="button"
              disabled={!canUsePasskey || pendingAction === "passkey"}
              onClick={() => run("passkey", async () => {
                await loginWithPasskey(emailValue() || undefined);
                setLocation(dropshipPortalPath("/dashboard"));
              })}
              className="mt-4 h-11 w-full gap-2 bg-zinc-950 text-white hover:bg-zinc-800"
            >
              <Fingerprint className="h-4 w-4" />
              {pendingAction === "passkey" ? "Waiting for passkey" : passkeyLabel}
            </Button>

            <Tabs value={tab} onValueChange={(value) => setTab(value as AuthTab)} className="mt-6">
              <TabsList className="grid h-10 w-full grid-cols-2 rounded-md">
                <TabsTrigger value="password" className="gap-2">
                  <KeyRound className="h-4 w-4" />
                  Password
                </TabsTrigger>
                <TabsTrigger value="setup" className="gap-2">
                  <ShieldCheck className="h-4 w-4" />
                  Set Up
                </TabsTrigger>
              </TabsList>

              <TabsContent value="password" className="mt-5">
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    run("password", async () => {
                      await loginWithPassword({ email: emailValue(), password });
                      setLocation(dropshipPortalPath("/dashboard"));
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
                    disabled={!emailValue() || !password || pendingAction === "password"}
                    className="h-11 w-full gap-2 bg-emerald-600 hover:bg-emerald-700"
                  >
                    {pendingAction === "password" ? "Signing in" : "Sign in"}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </form>
              </TabsContent>

              <TabsContent value="setup" className="mt-5">
                <div className="space-y-4">
                  <Button
                    type="button"
                    variant={setupCodeSent ? "outline" : "default"}
                    disabled={!emailValue() || pendingAction === "setup-start"}
                    onClick={() => run("setup-start", async () => {
                      await startBootstrap(emailValue());
                      setSetupCodeSent(true);
                      setMessage("Verification code sent.");
                    })}
                    className="h-11 w-full gap-2"
                  >
                    <Mail className="h-4 w-4" />
                    {setupCodeSent ? "Send another code" : "Send verification code"}
                  </Button>

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

                  <div className="space-y-2">
                    <Label htmlFor="dropship-setup-password">Password</Label>
                    <Input
                      id="dropship-setup-password"
                      type="password"
                      value={setupPassword}
                      onChange={(event) => setSetupPassword(event.target.value)}
                      autoComplete="new-password"
                      className="h-11"
                    />
                  </div>

                  <Button
                    type="button"
                    disabled={
                      !emailValue() ||
                      verificationCode.length !== 6 ||
                      !setupPassword ||
                      pendingAction === "setup-complete"
                    }
                    onClick={() => run("setup-complete", async () => {
                      await completeBootstrap({
                        email: emailValue(),
                        verificationCode,
                        password: setupPassword,
                      });
                      setLocation(dropshipPortalPath("/dashboard"));
                    })}
                    className="h-11 w-full gap-2 bg-emerald-600 hover:bg-emerald-700"
                  >
                    {pendingAction === "setup-complete" ? "Creating login" : "Create login"}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </section>
      </div>
    </main>
  );
}
