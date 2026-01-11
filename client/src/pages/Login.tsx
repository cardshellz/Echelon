import React, { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Box, Lock, User, ArrowRight, Download, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";

export default function Login() {
  const [, setLocation] = useLocation();
  const { login, user } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
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

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");
    
    const result = await login(username, password);
    
    if (result.success) {
      setLocation("/");
    } else {
      setError(result.error || "Login failed");
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
            Enter your Picker ID or scan badge
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
          </form>
          
          <div className="mt-8 text-center">
            <Button 
              variant="ghost" 
              size="sm" 
              className="text-slate-500 hover:text-emerald-400 hover:bg-slate-900 gap-2 text-xs"
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
