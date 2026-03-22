import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  User,
  Wallet,
  ShoppingCart,
  Package,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
} from "lucide-react";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusIcon(status: string) {
  switch (status) {
    case "active": return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case "pending": return <Clock className="h-4 w-4 text-yellow-500" />;
    case "suspended": return <Ban className="h-4 w-4 text-red-500" />;
    case "closed": return <XCircle className="h-4 w-4 text-gray-500" />;
    default: return null;
  }
}

function statusColor(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active": return "default";
    case "pending": return "secondary";
    case "suspended": return "destructive";
    case "closed": return "outline";
    default: return "secondary";
  }
}

export default function VendorDetail() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/vendors/:id");
  const vendorId = params?.id;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("overview");

  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/vendors", vendorId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/vendors/${vendorId}`);
      if (!res.ok) throw new Error("Failed to fetch vendor");
      return res.json();
    },
    enabled: !!vendorId,
  });

  const statusMutation = useMutation({
    mutationFn: async (newStatus: string) => {
      const res = await fetch(`/api/admin/vendors/${vendorId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error("Failed to update vendor");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/vendors", vendorId] });
      toast({ title: "Vendor updated" });
    },
    onError: () => {
      toast({ title: "Failed to update vendor", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        Vendor not found
      </div>
    );
  }

  const { vendor, stats, recent_orders, recent_transactions } = data;

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-full">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/vendors")} className="min-h-[44px] min-w-[44px]">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl md:text-2xl font-bold truncate">{vendor.name}</h1>
            <Badge variant={statusColor(vendor.status)} className="capitalize">
              {vendor.status}
            </Badge>
            <Badge variant="outline" className="capitalize">{vendor.tier}</Badge>
          </div>
          {vendor.company_name && (
            <p className="text-sm text-muted-foreground">{vendor.company_name}</p>
          )}
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Wallet className="h-4 w-4" />
              <span className="text-xs font-medium">Balance</span>
            </div>
            <div className="text-lg md:text-xl font-bold font-mono">
              {formatCents(vendor.wallet_balance_cents)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <ShoppingCart className="h-4 w-4" />
              <span className="text-xs font-medium">Orders</span>
            </div>
            <div className="text-lg md:text-xl font-bold">{stats.total_orders}</div>
            <div className="text-xs text-muted-foreground">{stats.orders_this_month} this month</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Package className="h-4 w-4" />
              <span className="text-xs font-medium">Products</span>
            </div>
            <div className="text-lg md:text-xl font-bold">{stats.products_selected}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Wallet className="h-4 w-4" />
              <span className="text-xs font-medium">Revenue</span>
            </div>
            <div className="text-lg md:text-xl font-bold font-mono">
              {formatCents(stats.total_revenue_cents)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="wallet">Wallet</TabsTrigger>
            <TabsTrigger value="orders">Orders</TabsTrigger>
          </TabsList>
        </div>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Profile */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <User className="h-4 w-4" />
                  Profile
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Email</span>
                  <span className="font-medium">{vendor.email}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Phone</span>
                  <span className="font-medium">{vendor.phone || "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Member ID</span>
                  <span className="font-medium">{vendor.shellz_club_member_id || "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">eBay</span>
                  <span className="font-medium">{vendor.ebay_user_id || "Not connected"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Stripe</span>
                  <span className="font-mono text-xs">{vendor.stripe_customer_id || "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Joined</span>
                  <span>{formatDate(vendor.created_at)}</span>
                </div>
              </CardContent>
            </Card>

            {/* Status Control */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Status Control</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-2">
                  {statusIcon(vendor.status)}
                  <span className="capitalize font-medium">{vendor.status}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {vendor.status === "pending" && (
                    <Button
                      size="sm"
                      onClick={() => statusMutation.mutate("active")}
                      disabled={statusMutation.isPending}
                    >
                      Activate
                    </Button>
                  )}
                  {vendor.status === "active" && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => statusMutation.mutate("suspended")}
                      disabled={statusMutation.isPending}
                    >
                      Suspend
                    </Button>
                  )}
                  {vendor.status === "suspended" && (
                    <>
                      <Button
                        size="sm"
                        onClick={() => statusMutation.mutate("active")}
                        disabled={statusMutation.isPending}
                      >
                        Reactivate
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => statusMutation.mutate("closed")}
                        disabled={statusMutation.isPending}
                      >
                        Close
                      </Button>
                    </>
                  )}
                  {vendor.status !== "closed" && vendor.status !== "suspended" && vendor.status !== "pending" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => statusMutation.mutate("closed")}
                      disabled={statusMutation.isPending}
                    >
                      Close Account
                    </Button>
                  )}
                </div>

                <div className="pt-2 border-t">
                  <p className="text-sm text-muted-foreground mb-2">Auto-reload</p>
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Enabled</span>
                      <span>{vendor.auto_reload_enabled ? "Yes" : "No"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Threshold</span>
                      <span className="font-mono">{formatCents(vendor.auto_reload_threshold_cents || 0)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Reload Amount</span>
                      <span className="font-mono">{formatCents(vendor.auto_reload_amount_cents || 0)}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Wallet Tab */}
        <TabsContent value="wallet" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent Transactions</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {recent_transactions.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No transactions yet</div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="text-right hidden sm:table-cell">Balance</TableHead>
                        <TableHead className="hidden md:table-cell">Reference</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recent_transactions.map((tx: any) => (
                        <TableRow key={tx.id}>
                          <TableCell>
                            <Badge variant="outline" className="text-xs capitalize">
                              {tx.type.replace(/_/g, " ")}
                            </Badge>
                          </TableCell>
                          <TableCell className={`text-right font-mono text-sm ${tx.amount_cents >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {tx.amount_cents >= 0 ? "+" : ""}{formatCents(tx.amount_cents)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm hidden sm:table-cell">
                            {formatCents(tx.balance_after_cents)}
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                            {tx.reference_type ? `${tx.reference_type}: ${tx.reference_id}` : "—"}
                          </TableCell>
                          <TableCell className="text-sm">{formatDateTime(tx.created_at)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Orders Tab */}
        <TabsContent value="orders" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent Orders</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {recent_orders.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No orders yet</div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Order</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="hidden sm:table-cell">Customer</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        <TableHead className="hidden md:table-cell">Tracking</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recent_orders.map((o: any) => (
                        <TableRow key={o.id}>
                          <TableCell className="font-mono text-xs">
                            {o.external_order_id || `#${o.id}`}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs capitalize">
                              {o.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell text-sm">{o.customer_name || "—"}</TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {formatCents(o.total_cents)}
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-xs">
                            {o.tracking_number || "—"}
                          </TableCell>
                          <TableCell className="text-sm">
                            {o.ordered_at ? formatDate(o.ordered_at) : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
