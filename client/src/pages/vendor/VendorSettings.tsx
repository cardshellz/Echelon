import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  User,
  Link2,
  Link2Off,
  Lock,
  Loader2,
  ExternalLink,
  CheckCircle,
  XCircle,
  AlertCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useVendorAuth } from "@/lib/vendor-auth";
import {
  fetchEbayStatus,
  getEbayAuthUrl,
  disconnectEbay,
  updateVendorProfile,
  changeVendorPassword,
} from "@/lib/vendor-api";
import { useToast } from "@/hooks/use-toast";

export default function VendorSettings() {
  const { vendor, refetch: refetchAuth } = useVendorAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Profile state
  const [name, setName] = useState(vendor?.name ?? "");
  const [companyName, setCompanyName] = useState(vendor?.company_name ?? "");
  const [phone, setPhone] = useState(vendor?.phone ?? "");

  // Password state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    if (vendor) {
      setName(vendor.name);
      setCompanyName(vendor.company_name ?? "");
      setPhone(vendor.phone ?? "");
    }
  }, [vendor]);

  // Check URL params for eBay callback status
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ebayStatus = params.get("ebay");
    if (ebayStatus === "connected") {
      toast({ title: "eBay Connected", description: "Your eBay account has been linked successfully." });
      refetchAuth();
      queryClient.invalidateQueries({ queryKey: ["vendor-ebay-status"] });
      window.history.replaceState({}, "", window.location.pathname);
    } else if (ebayStatus === "error") {
      const reason = params.get("reason") || "Unknown error";
      toast({ title: "eBay Connection Failed", description: reason, variant: "destructive" });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const { data: ebayData, isLoading: ebayLoading } = useQuery({
    queryKey: ["vendor-ebay-status"],
    queryFn: fetchEbayStatus,
    staleTime: 30_000,
  });

  const connectEbayMutation = useMutation({
    mutationFn: getEbayAuthUrl,
    onSuccess: (data) => {
      if (data.auth_url) {
        window.location.href = data.auth_url;
      }
    },
    onError: (err: Error) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const disconnectEbayMutation = useMutation({
    mutationFn: disconnectEbay,
    onSuccess: () => {
      toast({ title: "eBay Disconnected" });
      refetchAuth();
      queryClient.invalidateQueries({ queryKey: ["vendor-ebay-status"] });
    },
    onError: (err: Error) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const profileMutation = useMutation({
    mutationFn: () => updateVendorProfile({ name, company_name: companyName, phone }),
    onSuccess: () => {
      toast({ title: "Profile updated" });
      refetchAuth();
    },
    onError: (err: Error) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const passwordMutation = useMutation({
    mutationFn: () => changeVendorPassword({ current_password: currentPassword, new_password: newPassword }),
    onSuccess: () => {
      toast({ title: "Password changed" });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
    onError: (err: Error) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const handleProfileSave = (e: React.FormEvent) => {
    e.preventDefault();
    profileMutation.mutate();
  };

  const handlePasswordChange = (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    if (newPassword.length < 8) {
      toast({ title: "Password must be at least 8 characters", variant: "destructive" });
      return;
    }
    passwordMutation.mutate();
  };

  const ebayConnected = ebayData?.connected ?? false;

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage your account and integrations
        </p>
      </div>

      {/* eBay Connection */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            eBay Connection
          </CardTitle>
          <CardDescription>
            Connect your eBay seller account to push products
          </CardDescription>
        </CardHeader>
        <CardContent>
          {ebayLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking connection status...
            </div>
          ) : ebayConnected ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-green-600/5 border border-green-600/20">
                <CheckCircle className="h-5 w-5 text-green-600 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">Connected</p>
                  {ebayData?.ebay_user_id && (
                    <p className="text-xs text-muted-foreground">
                      eBay User: {ebayData.ebay_user_id}
                    </p>
                  )}
                </div>
                <Badge variant="outline" className="bg-green-600/10 text-green-600 border-green-600/20">
                  Active
                </Badge>
              </div>
              <Button
                variant="outline"
                className="min-h-[44px] text-destructive border-destructive/20 hover:bg-destructive/10"
                onClick={() => disconnectEbayMutation.mutate()}
                disabled={disconnectEbayMutation.isPending}
              >
                {disconnectEbayMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Link2Off className="mr-2 h-4 w-4" />
                )}
                Disconnect eBay
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-600/5 border border-amber-600/20">
                <XCircle className="h-5 w-5 text-amber-600 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">Not Connected</p>
                  <p className="text-xs text-muted-foreground">
                    Connect your eBay account to list products
                  </p>
                </div>
              </div>
              <Button
                className="bg-red-600 hover:bg-red-700 min-h-[44px]"
                onClick={() => connectEbayMutation.mutate()}
                disabled={connectEbayMutation.isPending}
              >
                {connectEbayMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Link2 className="mr-2 h-4 w-4" />
                )}
                Connect eBay Account
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Profile */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <User className="h-5 w-5" />
            Profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleProfileSave} className="space-y-4">
            <div>
              <label className="text-sm text-muted-foreground">Name</label>
              <Input
                className="mt-1 min-h-[44px]"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">Company Name</label>
              <Input
                className="mt-1 min-h-[44px]"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">Email</label>
              <Input
                className="mt-1 min-h-[44px]"
                value={vendor?.email ?? ""}
                disabled
              />
              <p className="text-xs text-muted-foreground mt-1">Contact support to change email</p>
            </div>
            <div>
              <label className="text-sm text-muted-foreground">Phone</label>
              <Input
                className="mt-1 min-h-[44px]"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Optional"
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              className="min-h-[44px]"
              disabled={profileMutation.isPending}
            >
              {profileMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Save Profile
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Change Password */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Lock className="h-5 w-5" />
            Change Password
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePasswordChange} className="space-y-4">
            <div>
              <label className="text-sm text-muted-foreground">Current Password</label>
              <Input
                type="password"
                className="mt-1 min-h-[44px]"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">New Password</label>
              <Input
                type="password"
                className="mt-1 min-h-[44px]"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">Confirm New Password</label>
              <Input
                type="password"
                className="mt-1 min-h-[44px]"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              className="min-h-[44px]"
              disabled={passwordMutation.isPending || !currentPassword || !newPassword}
            >
              {passwordMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Change Password
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Account Info */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between text-sm">
            <div className="text-muted-foreground">
              Account Status
            </div>
            <Badge
              variant="outline"
              className={
                vendor?.status === "active"
                  ? "bg-green-600/10 text-green-600 border-green-600/20"
                  : "bg-amber-600/10 text-amber-600 border-amber-600/20"
              }
            >
              {vendor?.status || "unknown"}
            </Badge>
          </div>
          <div className="flex items-center justify-between text-sm mt-2">
            <div className="text-muted-foreground">Tier</div>
            <span className="font-medium capitalize">{vendor?.tier || "standard"}</span>
          </div>
          <div className="flex items-center justify-between text-sm mt-2">
            <div className="text-muted-foreground">Member Since</div>
            <span className="font-medium">
              {vendor?.created_at
                ? new Date(vendor.created_at).toLocaleDateString("en-US", {
                    month: "long",
                    year: "numeric",
                  })
                : "—"}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
