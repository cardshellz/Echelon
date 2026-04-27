import React from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Store, ShieldCheck } from "lucide-react";

export default function RegisterPage() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-md shadow-lg border-t-4 border-t-primary">
        <CardHeader className="space-y-3 text-center pt-8">
          <div className="flex justify-center mb-2">
            <div className="h-12 w-12 bg-primary rounded-xl flex items-center justify-center">
              <ShieldCheck className="h-6 w-6 text-primary-foreground" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">Become a Vendor</CardTitle>
          <CardDescription>
            Join the Card Shellz Dropship Network
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label htmlFor="companyName">Store / Company Name</Label>
            <Input id="companyName" placeholder="My Card Shop LLC" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="memberId">Shellz Club Member ID</Label>
            <Input id="memberId" placeholder="MEMBER-12345" required />
            <p className="text-xs text-muted-foreground">You must have an active Shellz Club membership.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" placeholder="store@example.com" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" required />
          </div>
          <Button className="w-full mt-4" size="lg">Submit Application</Button>
        </CardContent>
        <CardFooter className="flex justify-center pb-8 border-t pt-6 bg-muted/20">
          <div className="text-sm text-muted-foreground text-center">
            Already have an account?{" "}
            <Link href="/login">
              <a className="text-primary font-semibold hover:underline">Log in</a>
            </Link>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
