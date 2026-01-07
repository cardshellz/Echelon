import React, { useState } from "react";
import { useLocation } from "wouter";
import { Box, Lock, Scan, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function Login() {
  const [, setLocation] = useLocation();
  const [pin, setPin] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    // Simulate API delay
    setTimeout(() => {
      setLocation("/");
    }, 800);
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <Card className="w-full max-w-md border-slate-800 bg-slate-950 text-slate-50 shadow-2xl">
        <CardHeader className="space-y-1 flex flex-col items-center text-center pb-8">
          <div className="h-16 w-16 bg-primary/20 rounded-2xl flex items-center justify-center mb-4">
             <Box className="h-10 w-10 text-primary" />
          </div>
          <CardTitle className="text-3xl font-bold tracking-tight">Nexus WMS</CardTitle>
          <CardDescription className="text-slate-400">
            Enter your Picker ID or scan badge
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 h-4 w-4" />
                <Input 
                  type="password" 
                  placeholder="Enter Pin Code" 
                  className="pl-10 h-12 bg-slate-900 border-slate-800 text-lg tracking-widest text-center focus-visible:ring-primary"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  maxLength={6}
                />
              </div>
            </div>
            
            <Button 
              type="submit" 
              className="w-full h-12 text-lg font-medium transition-all" 
              disabled={isLoading || pin.length < 3}
            >
              {isLoading ? "Signing in..." : "Sign In"} <ArrowRight className="ml-2 h-5 w-5" />
            </Button>

            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-slate-800" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-slate-950 px-2 text-slate-500">
                  Or scan badge
                </span>
              </div>
            </div>

            <Button variant="outline" type="button" className="w-full h-12 border-slate-800 hover:bg-slate-900 text-slate-300">
              <Scan className="mr-2 h-5 w-5" /> Use Camera
            </Button>
          </form>
          
          <div className="mt-8 text-center text-xs text-slate-600">
            Version 2.4.0 • Enterprise Edition
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
