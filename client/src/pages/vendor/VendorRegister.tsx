import React, { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { Mail, Lock, User, Building2, Hash, ArrowRight, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useVendorAuth } from "@/lib/vendor-auth";
import { vendorRegister } from "@/lib/vendor-api";

export default function VendorRegister() {
  const [, setLocation] = useLocation();
  const { isAuthenticated } = useVendorAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [shellzClubId, setShellzClubId] = useState("");

  useEffect(() => {
    if (isAuthenticated) {
      setLocation("/vendor/dashboard");
    }
  }, [isAuthenticated, setLocation]);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setIsLoading(true);
    try {
      await vendorRegister({
        name,
        email,
        password,
        companyName: companyName || undefined,
        shellzClubMemberId: shellzClubId || undefined,
      });
      setLocation("/vendor/login?registered=true");
    } catch (err: any) {
      setError(err.message || "Registration failed");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-red-950/30 flex items-center justify-center p-4">
      <Card className="w-full max-w-md border-slate-800 bg-slate-950/80 text-slate-50 shadow-2xl backdrop-blur">
        <CardHeader className="space-y-1 flex flex-col items-center text-center pb-4">
          <div className="h-16 w-16 bg-red-600 rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-red-600/20">
            <span className="text-white font-bold text-2xl">CS</span>
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">Apply for Vendor Access</CardTitle>
          <CardDescription className="text-slate-400">
            Join the Card Shellz dropship program
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleRegister} className="space-y-3">
            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-900/30 border border-red-800 rounded-lg text-red-400 text-sm">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 h-4 w-4" />
              <Input
                type="text"
                placeholder="Full Name *"
                className="pl-10 h-12 bg-slate-900 border-slate-800 focus-visible:ring-red-600"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 h-4 w-4" />
              <Input
                type="email"
                placeholder="Email *"
                className="pl-10 h-12 bg-slate-900 border-slate-800 focus-visible:ring-red-600"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </div>

            <div className="relative">
              <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 h-4 w-4" />
              <Input
                type="text"
                placeholder="Company Name (optional)"
                className="pl-10 h-12 bg-slate-900 border-slate-800 focus-visible:ring-red-600"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
              />
            </div>

            <p className="text-xs text-slate-500 text-center">
              Your Shellz Club membership will be detected automatically from your email address.
            </p>

            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 h-4 w-4" />
              <Input
                type="password"
                placeholder="Password (min 8 chars) *"
                className="pl-10 h-12 bg-slate-900 border-slate-800 focus-visible:ring-red-600"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
              />
            </div>

            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 h-4 w-4" />
              <Input
                type="password"
                placeholder="Confirm Password *"
                className="pl-10 h-12 bg-slate-900 border-slate-800 focus-visible:ring-red-600"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </div>

            <Button
              type="submit"
              className="w-full h-12 text-lg font-medium bg-red-600 hover:bg-red-700 transition-all mt-2"
              disabled={isLoading || !name || !email || !password || !confirmPassword}
            >
              {isLoading ? "Creating Account..." : "Create Account"}{" "}
              <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-slate-500 text-sm">
              Already have an account?{" "}
              <Link
                href="/vendor/login"
                className="text-red-400 hover:text-red-300 font-medium"
              >
                Sign In
              </Link>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
