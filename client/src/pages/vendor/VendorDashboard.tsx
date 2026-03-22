import React from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Wallet,
  Package,
  ShoppingCart,
  DollarSign,
  ArrowRight,
  AlertTriangle,
  Link2,
  TrendingUp,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useVendorAuth } from "@/lib/vendor-auth";
import { fetchVendorDashboard } from "@/lib/vendor-api";

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function statusColor(status: string): string {
  switch (status) {
    case "shipped":
    case "delivered":
      return "bg-green-600/10 text-green-600 border-green-600/20";
    case "processing":
      return "bg-blue-600/10 text-blue-600 border-blue-600/20";
    case "pending":
      return "bg-yellow-600/10 text-yellow-600 border-yellow-600/20";
    default:
      return "bg-slate-600/10 text-slate-600 border-slate-600/20";
  }
}

export default function VendorDashboard() {
  const { vendor } = useVendorAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["vendor-dashboard"],
    queryFn: fetchVendorDashboard,
    staleTime: 30_000,
  });

  const balance = vendor?.wallet_balance_cents ?? 0;
  const lowBalance = balance < 5000; // Less than $50
  const ebayConnected = vendor?.ebay_connected ?? false;
  const totalProducts = data?.products?.pagination?.total ?? 0;
  const totalOrders = data?.orders?.pagination?.total ?? 0;
  const recentOrders = data?.orders?.orders ?? [];

  // Calculate revenue this month from recent orders
  const revenueCents = recentOrders.reduce(
    (sum: number, o: any) => sum + (o.total_cents || 0),
    0
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">
          Welcome back{vendor?.name ? `, ${vendor.name.split(" ")[0]}` : ""}
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Here's an overview of your dropship account.
        </p>
      </div>

      {/* CTAs for missing setup */}
      {(!ebayConnected || lowBalance) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {!ebayConnected && (
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardContent className="flex items-center gap-4 p-4">
                <div className="h-10 w-10 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0">
                  <Link2 className="h-5 w-5 text-amber-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">Connect your eBay account</p>
                  <p className="text-xs text-muted-foreground">
                    Required to push products to your store
                  </p>
                </div>
                <Link href="/vendor/settings">
                  <Button size="sm" variant="outline" className="min-h-[44px] shrink-0">
                    Connect <ArrowRight className="ml-1 h-4 w-4" />
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}
          {lowBalance && (
            <Card className="border-red-500/30 bg-red-500/5">
              <CardContent className="flex items-center gap-4 p-4">
                <div className="h-10 w-10 rounded-full bg-red-500/10 flex items-center justify-center shrink-0">
                  <AlertTriangle className="h-5 w-5 text-red-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">Low wallet balance</p>
                  <p className="text-xs text-muted-foreground">
                    Fund your wallet to process orders
                  </p>
                </div>
                <Link href="/vendor/wallet">
                  <Button size="sm" variant="outline" className="min-h-[44px] shrink-0">
                    Add Funds <ArrowRight className="ml-1 h-4 w-4" />
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-green-600/10 flex items-center justify-center">
                <Wallet className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Balance</p>
                {isLoading ? (
                  <Skeleton className="h-7 w-24" />
                ) : (
                  <p className="text-xl font-bold text-green-600 dark:text-green-400">
                    {formatCents(balance)}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-blue-600/10 flex items-center justify-center">
                <Package className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Products Listed</p>
                {isLoading ? (
                  <Skeleton className="h-7 w-12" />
                ) : (
                  <p className="text-xl font-bold">{totalProducts}</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-purple-600/10 flex items-center justify-center">
                <ShoppingCart className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Orders</p>
                {isLoading ? (
                  <Skeleton className="h-7 w-12" />
                ) : (
                  <p className="text-xl font-bold">{totalOrders}</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-red-600/10 flex items-center justify-center">
                <TrendingUp className="h-5 w-5 text-red-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Revenue</p>
                {isLoading ? (
                  <Skeleton className="h-7 w-20" />
                ) : (
                  <p className="text-xl font-bold">{formatCents(revenueCents)}</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Orders */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base font-semibold">Recent Orders</CardTitle>
          <Link href="/vendor/orders">
            <Button variant="ghost" size="sm" className="min-h-[44px]">
              View All <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : recentOrders.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <ShoppingCart className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No orders yet</p>
              <p className="text-xs mt-1">
                Orders will appear here when customers buy from your eBay listings
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {recentOrders.slice(0, 5).map((order: any) => (
                <div
                  key={order.id}
                  className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div>
                      <p className="text-sm font-medium truncate">
                        {order.vendor_order_ref || `#${order.id}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {order.ship_to_city && order.ship_to_state
                          ? `${order.ship_to_city}, ${order.ship_to_state}`
                          : formatDate(order.ordered_at)}
                        {" · "}
                        {order.items?.length || 0} item
                        {(order.items?.length || 0) !== 1 ? "s" : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <Badge
                      className={statusColor(order.status)}
                      variant="outline"
                    >
                      {order.status}
                    </Badge>
                    <span className="text-sm font-medium">
                      {formatCents(order.total_cents || 0)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
