import React, { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Box, Lock, User, ArrowRight, Download, AlertCircle, CheckCircle2, KeyRound, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { newStaffPasswordSchema } from "@shared/staff-credentials";

type LoginView = "signin" | "forgot" | "reset";

function initialResetTokenFromSearch(): string {
  if (typeof window === "undefined") return "";
  try {
    return new URLSearchParams(window.location.search).get("resetToken")?.trim() ?? "";
  } catch {
    return "";
  }
}

export default function Login() {
  const [, setLocation] = useLocation();
  const { login, user } = useAuth();
  const initialToken = initialResetTokenFromSearch();
  const [view, setView] = useState<LoginView>(initialToken ? "reset" : "signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryIdentifier, setRecoveryIdentifier] = useState("");
  const [resetToken, setResetToken] = useState(initialToken);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

  useEffect(() => {
    if (user) {
      setLocation("/");
    }
  }, [user, setLocation]);

  useEffect(() => {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    });
  }, []);

  const switchView = (nextView: LoginView, nextNotice = "") => {
    setError("");
    setNotice(nextNotice);
    setView(nextView);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");
    setNotice("");

    const result = await login(username, password);

    if (result.success) {
      setLocation("/");
    } else {
      setError(result.error || "Login failed");
      setIsLoading(false);
    }
  };

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    const identifier = recoveryIdentifier.trim();
    if (!identifier) {
      setError("Enter your username or recovery email.");
      return;
    }
    setIsLoading(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ identifier }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error || (response.status === 429
          ? "Too many recovery requests. Please wait 15 minutes and try again."
          : "Could not submit recovery request."));
        return;
      }
      setNotice(
        payload?.message ||
          "If an active account with a recovery email matches, a 15-minute single-use reset link has been sent.",
      );
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCompleteReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    const trimmedToken = resetToken.trim();
    if (!trimmedToken) {
      setError("Enter or open a valid password reset link.");
      return;
    }
    if (!newStaffPasswordSchema.safeParse(newPassword).success) {
      setError("Enter a new password (up to 72 UTF-8 bytes).");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }
    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/reset-password-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          token: trimmedToken,
          password: newPassword,
          operationId: crypto.randomUUID(),
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(
          payload?.error ||
            (response.status === 429
              ? "Too many attempts. Please wait before trying again."
              : "This reset link is invalid, expired, or has already been used."),
        );
        return;
      }
      setResetToken("");
      setNewPassword("");
      setConfirmPassword("");
      setPassword("");
      if (typeof window !== "undefined" && window.location.search.includes("resetToken")) {
        window.history.replaceState({}, "", window.location.pathname);
      }
      switchView("signin", "Password reset complete. Sign in with your new password.");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleInstall = () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      setDeferredPrompt(null);
    } else {
      alert("To install: Tap 'Share' then 'Add to Home Screen'");
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <Card className="w-full max-w-md border-slate-800 bg-slate-950 text-slate-50 shadow-2xl">
        <CardHeader className="space-y-1 flex flex-col items-center text-center pb-8">
          <div className="h-16 w-16 bg-primary/20 rounded-2xl flex items-center justify-center mb-4">
            <Box className="h-10 w-10 text-primary" />
          </div>
          <CardTitle className="text-3xl font-bold tracking-tight">Echelon</CardTitle>
          <CardDescription className="text-slate-400">
            {view === "signin" && "Enter your Picker ID or scan badge"}
            {view === "forgot" && "Request a single-use 15-minute password reset link"}
            {view === "reset" && "Choose a new password for your Echelon account"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="mb-4 flex items-center gap-2 p-3 bg-red-900/30 border border-red-800 rounded-lg text-red-400 text-sm" data-testid="login-error-banner">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {notice && (
            <div className="mb-4 flex items-center gap-2 p-3 bg-emerald-900/30 border border-emerald-800 rounded-lg text-emerald-300 text-sm" data-testid="login-notice-banner">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {notice}
            </div>
          )}

          {view === "signin" && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-3">
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 h-4 w-4" />
                  <Input
                    type="text"
                    placeholder="Username"
                    className="pl-10 h-12 bg-slate-900 border-slate-800 text-lg focus-visible:ring-primary"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    data-testid="input-username"
                  />
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 h-4 w-4" />
                  <Input
                    type="password"
                    placeholder="Password"
                    className="pl-10 h-12 bg-slate-900 border-slate-800 text-lg focus-visible:ring-primary"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    data-testid="input-password"
                  />
                </div>
              </div>

              <Button
                type="submit"
                className="w-full h-12 text-lg font-medium transition-all"
                disabled={isLoading || !username || !password}
                data-testid="button-login"
              >
                {isLoading ? "Signing in..." : "Sign In"} <ArrowRight className="ml-2 h-5 w-5" />
              </Button>

              <div className="text-center pt-1">
                <Button
                  type="button"
                  variant="link"
                  className="text-slate-400 hover:text-slate-200 text-xs"
                  onClick={() => {
                    setRecoveryIdentifier(username);
                    switchView("forgot");
                  }}
                  data-testid="button-forgot-password"
                >
                  Forgot password?
                </Button>
              </div>
            </form>
          )}

          {view === "forgot" && (
            <form onSubmit={handleRequestReset} className="space-y-4">
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 h-4 w-4" />
                <Input
                  type="text"
                  placeholder="Username or recovery email"
                  className="pl-10 h-12 bg-slate-900 border-slate-800 text-base focus-visible:ring-primary"
                  value={recoveryIdentifier}
                  onChange={(e) => setRecoveryIdentifier(e.target.value)}
                  autoComplete="username"
                  data-testid="input-recovery-identifier"
                />
              </div>

              <Button
                type="submit"
                className="w-full h-12 text-base font-medium"
                disabled={isLoading || !recoveryIdentifier.trim()}
                data-testid="button-send-reset-link"
              >
                {isLoading ? "Sending reset link..." : "Send Reset Link"}
              </Button>

              <div className="flex items-center justify-between pt-1 text-xs">
                <Button
                  type="button"
                  variant="link"
                  className="text-slate-400 hover:text-slate-200 text-xs px-0"
                  onClick={() => switchView("signin")}
                  data-testid="button-back-to-login"
                >
                  Back to Sign In
                </Button>
                <Button
                  type="button"
                  variant="link"
                  className="text-slate-400 hover:text-slate-200 text-xs px-0"
                  onClick={() => switchView("reset")}
                  data-testid="button-enter-reset-token"
                >
                  Have a reset token?
                </Button>
              </div>
            </form>
          )}

          {view === "reset" && (
            <form onSubmit={handleCompleteReset} className="space-y-4">
              {!initialToken && (
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 h-4 w-4" />
                  <Input
                    type="text"
                    placeholder="Paste reset token"
                    className="pl-10 h-12 bg-slate-900 border-slate-800 text-sm focus-visible:ring-primary"
                    value={resetToken}
                    onChange={(e) => setResetToken(e.target.value)}
                    autoComplete="off"
                    data-testid="input-reset-token"
                  />
                </div>
              )}

              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 h-4 w-4" />
                <Input
                  type="password"
                  placeholder="New password"
                  className="pl-10 h-12 bg-slate-900 border-slate-800 text-base focus-visible:ring-primary"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  data-testid="input-reset-new-password"
                />
              </div>

              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 h-4 w-4" />
                <Input
                  type="password"
                  placeholder="Confirm new password"
                  className="pl-10 h-12 bg-slate-900 border-slate-800 text-base focus-visible:ring-primary"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  data-testid="input-reset-confirm-password"
                />
              </div>

              <Button
                type="submit"
                className="w-full h-12 text-base font-medium"
                disabled={isLoading || !resetToken.trim() || !newPassword || !confirmPassword}
                data-testid="button-complete-password-reset"
              >
                {isLoading ? "Updating password..." : "Set New Password"}
              </Button>

              <div className="text-center pt-1">
                <Button
                  type="button"
                  variant="link"
                  className="text-slate-400 hover:text-slate-200 text-xs"
                  onClick={() => switchView("signin")}
                  data-testid="button-back-to-login"
                >
                  Back to Sign In
                </Button>
              </div>
            </form>
          )}

          <div className="mt-8 text-center">
            <Button
              variant="ghost"
              className="text-slate-500 hover:text-emerald-400 hover:bg-slate-900 gap-2 text-xs min-h-[44px]"
              onClick={handleInstall}
            >
              <Download size={14} /> Install App to Device
            </Button>
            <div className="text-xs text-slate-600 mt-2">
              Version 2.4.0 • Enterprise Edition
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
