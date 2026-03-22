import React, { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { Mail, Lock, ArrowRight, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useVendorAuth } from "@/lib/vendor-auth";

export default function VendorLogin() {
  const [, setLocation] = useLocation();
  const { login, isAuthenticated } = useVendorAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    if (isAuthenticated) {
      setLocation("/vendor/dashboard");
    }
  }, [isAuthenticated, setLocation]);

  // Check for registration success message
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("registered") === "true") {
      setSuccess("Account created successfully! Please sign in.");
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");
    setSuccess("");

    const result = await login(email, password);

    if (result.success) {
      setLocation("/vendor/dashboard");
    } else {
      setError(result.error || "Login failed");
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-red-950/30 flex items-center justify-center p-4">
      <Card className="w-full max-w-md border-slate-800 bg-slate-950/80 text-slate-50 shadow-2xl backdrop-blur">
        <CardHeader className="space-y-1 flex flex-col items-center text-center pb-6">
          <div className="h-16 w-16 bg-red-600 rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-red-600/20">
            <span className="text-white font-bold text-2xl">CS</span>
          </div>
          <CardTitle className="text-3xl font-bold tracking-tight">Vendor Portal</CardTitle>
          <CardDescription className="text-slate-400">
            Sign in to manage your dropship products
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-900/30 border border-red-800 rounded-lg text-red-400 text-sm">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}
            {success && (
              <div className="flex items-center gap-2 p-3 bg-green-900/30 border border-green-800 rounded-lg text-green-400 text-sm">
                {success}
              </div>
            )}

            <div className="space-y-3">
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 h-4 w-4" />
                <Input
                  type="email"
                  placeholder="Email"
                  className="pl-10 h-12 bg-slate-900 border-slate-800 text-lg focus-visible:ring-red-600"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 h-4 w-4" />
                <Input
                  type="password"
                  placeholder="Password"
                  className="pl-10 h-12 bg-slate-900 border-slate-800 text-lg focus-visible:ring-red-600"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
            </div>

            <Button
              type="submit"
              className="w-full h-12 text-lg font-medium bg-red-600 hover:bg-red-700 transition-all"
              disabled={isLoading || !email || !password}
            >
              {isLoading ? "Signing in..." : "Sign In"}{" "}
              <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-slate-500 text-sm">
              Don't have an account?{" "}
              <Link
                href="/vendor/register"
                className="text-red-400 hover:text-red-300 font-medium"
              >
                Apply Now
              </Link>
            </p>
          </div>

          <div className="mt-8 text-center">
            <div className="text-xs text-slate-600">
              Card Shellz Dropship Platform · Veteran-Owned 🇺🇸
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
