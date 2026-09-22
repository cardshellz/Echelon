import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2, LockKeyhole, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PreviewError } from "@/components/returns/CustomerReturnPreviewSteps";
import { useAuth } from "@/lib/auth";
import { readPreviewResponse } from "@/lib/customer-return-preview";
import { returnPortalPreviewStateSchema } from "@shared/returns/customer-return-preview.contract";
import {
  CUSTOMER_RETURN_PORTAL_PATH,
  CUSTOMER_RETURN_PREVIEW_API_PATH,
} from "@shared/returns/customer-return-portal-paths";

/** Public sign-in shell only. Rendering the customer journey requires a fresh
 * server authorization check, including after successful authentication. */
export default function CustomerReturnPortalAccess() {
  const { user, isLoading, login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [checking, setChecking] = useState(false);
  const [verifySession, setVerifySession] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const verification = useRef<AbortController | null>(null);
  const loginInFlight = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (isLoading || !user || signingIn || !verifySession) return;
    const controller = new AbortController();
    verification.current = controller;
    setChecking(true);
    setError(null);
    async function verify() {
      try {
        const response = await fetch(CUSTOMER_RETURN_PREVIEW_API_PATH, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        await readPreviewResponse(response, returnPortalPreviewStateSchema);
        // A fixed full navigation rechecks the protected HTML route. Never
        // accept a returnTo/query parameter or trust cached session role text.
        if (!controller.signal.aborted)
          window.location.replace(CUSTOMER_RETURN_PORTAL_PATH);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Private access could not be checked. Please try again.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setChecking(false);
      }
    }
    void verify();
    return () => {
      controller.abort();
      if (verification.current === controller) verification.current = null;
    };
  }, [user?.id, user?.role, isLoading, signingIn, verifySession, attempt]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loginInFlight.current || isLoading) return;
    if (!username.trim() || !password) {
      setError("Enter your admin username and password.");
      return;
    }
    loginInFlight.current = true;
    verification.current?.abort();
    setChecking(false);
    setVerifySession(false);
    setSigningIn(true);
    setError(null);
    try {
      const result = await login(username.trim(), password);
      if (!mounted.current) return;
      if (result.success) {
        setVerifySession(true);
        setAttempt((value) => value + 1);
      } else {
        setError("Sign-in failed. Check your credentials and try again.");
      }
    } catch {
      if (mounted.current)
        setError("Sign-in is temporarily unavailable. Please try again.");
    } finally {
      loginInFlight.current = false;
      if (mounted.current) {
        setPassword("");
        setSigningIn(false);
      }
    }
  }

  const busy = isLoading || signingIn || checking;
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12 text-slate-900"
      data-testid="return-portal-access"
    >
      <title>Private access | Card Shellz returns</title>
      <section
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
        aria-labelledby="private-access-title"
      >
        <div className="mb-8 flex items-center gap-2 text-lg font-bold">
          <Package className="h-6 w-6 text-blue-600" aria-hidden="true" />
          Card Shellz
        </div>
        <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
          <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
          Returns portal
        </div>
        <h1
          id="private-access-title"
          className="text-2xl font-semibold tracking-tight"
        >
          Private testing access
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Sign in with your Echelon admin account to test the customer returns
          experience before launch.
        </p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="return-admin-username">Admin username</Label>
            <Input
              id="return-admin-username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="return-admin-password">Password</Label>
            <Input
              id="return-admin-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </div>
          {error && <PreviewError message={error} />}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy && (
              <Loader2
                className="mr-2 h-4 w-4 animate-spin"
                aria-hidden="true"
              />
            )}
            Sign in to test
          </Button>
          {busy && (
            <p role="status" className="text-center text-sm text-slate-600">
              {signingIn ? "Signing in…" : "Checking private access…"}
            </p>
          )}
          {user && !busy && (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => {
                setVerifySession(true);
                setAttempt((value) => value + 1);
              }}
            >
              Retry current account
            </Button>
          )}
        </form>
        <p className="mt-6 border-t pt-4 text-xs text-slate-500">
          Access is limited to authorized staff. Customer access is not open
          yet.
        </p>
      </section>
    </main>
  );
}
