import React from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Store } from "lucide-react";

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-md shadow-lg border-t-4 border-t-primary">
        <CardHeader className="space-y-3 text-center pt-8">
          <div className="flex justify-center mb-2">
            <div className="h-12 w-12 bg-primary rounded-xl flex items-center justify-center">
              <Store className="h-6 w-6 text-primary-foreground" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">Vendor Portal</CardTitle>
          <CardDescription>
            Log in to manage your Dropship account
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" placeholder="store@example.com" required />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <a href="#" className="text-sm font-medium text-primary hover:underline">Forgot password?</a>
            </div>
            <Input id="password" type="password" required />
          </div>
          <Button className="w-full mt-2" size="lg">Sign In</Button>
        </CardContent>
        <CardFooter className="flex justify-center pb-8 border-t pt-6 bg-muted/20">
          <div className="text-sm text-muted-foreground text-center">
            New vendor?{" "}
            <Link href="/register">
              <a className="text-primary font-semibold hover:underline">Apply here</a>
            </Link>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
