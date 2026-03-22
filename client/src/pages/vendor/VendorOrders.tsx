import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ShoppingCart,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Truck,
  ExternalLink,
  Package,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchVendorOrders } from "@/lib/vendor-api";

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
    year: "numeric",
  });
}

function statusVariant(
  status: string
): { className: string; label: string } {
  switch (status) {
    case "shipped":
      return { className: "bg-blue-600/10 text-blue-600 border-blue-600/20", label: "Shipped" };
    case "delivered":
      return { className: "bg-green-600/10 text-green-600 border-green-600/20", label: "Delivered" };
    case "processing":
      return { className: "bg-purple-600/10 text-purple-600 border-purple-600/20", label: "Processing" };
    case "pending":
      return { className: "bg-yellow-600/10 text-yellow-600 border-yellow-600/20", label: "Pending" };
    case "cancelled":
      return { className: "bg-red-600/10 text-red-600 border-red-600/20", label: "Cancelled" };
    default:
      return { className: "bg-slate-600/10 text-slate-600 border-slate-600/20", label: status };
  }
}

const STATUS_OPTIONS = ["", "pending", "processing", "shipped", "delivered"];

export default function VendorOrders() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [expandedOrder, setExpandedOrder] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["vendor-orders", page, statusFilter],
    queryFn: () =>
      fetchVendorOrders({
        page,
        limit: 20,
        status: statusFilter || undefined,
      }),
    staleTime: 15_000,
  });

  const orders = data?.orders ?? [];
  const pagination = data?.pagination ?? { page: 1, total: 0, total_pages: 1 };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Orders</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Track orders fulfilled through your eBay listings
        </p>
      </div>

      {/* Status Filter */}
      <div className="flex gap-2 flex-wrap">
        {STATUS_OPTIONS.map((s) => (
          <Button
            key={s || "all"}
            variant={statusFilter === s ? "default" : "outline"}
            size="sm"
            className="min-h-[44px]"
            onClick={() => {
              setStatusFilter(s);
              setPage(1);
            }}
          >
            {s === "" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
          </Button>
        ))}
      </div>

      {/* Orders List */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <ShoppingCart className="h-12 w-12 text-muted-foreground mb-3 opacity-50" />
            <p className="text-muted-foreground">No orders found</p>
            {statusFilter && (
              <Button
                variant="link"
                className="mt-2 min-h-[44px]"
                onClick={() => setStatusFilter("")}
              >
                Clear filter
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {orders.map((order: any) => {
            const sv = statusVariant(order.status);
            const isExpanded = expandedOrder === order.id;

            return (
              <Card key={order.id} className="overflow-hidden">
                <button
                  className="w-full text-left p-4 flex items-center justify-between gap-4 min-h-[64px] hover:bg-accent/30 transition-colors"
                  onClick={() =>
                    setExpandedOrder(isExpanded ? null : order.id)
                  }
                >
                  <div className="flex items-center gap-4 min-w-0 flex-1">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold">
                          {order.vendor_order_ref || `#${order.id}`}
                        </span>
                        <Badge className={sv.className} variant="outline">
                          {sv.label}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {formatDate(order.ordered_at)}
                        {order.ship_to_city &&
                          ` · ${order.ship_to_city}, ${order.ship_to_state}`}
                        {` · ${order.items?.length || 0} item${(order.items?.length || 0) !== 1 ? "s" : ""}`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-sm font-semibold">
                      {formatCents(order.total_cents || 0)}
                    </span>
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t px-4 pb-4 pt-3 space-y-4 bg-muted/30">
                    {/* Line Items */}
                    <div>
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                        Items
                      </h4>
                      <div className="space-y-2">
                        {(order.items || []).map((item: any, idx: number) => (
                          <div
                            key={idx}
                            className="flex items-center justify-between text-sm"
                          >
                            <div className="flex items-center gap-2">
                              <Package className="h-4 w-4 text-muted-foreground" />
                              <span>{item.title || item.sku}</span>
                              <span className="text-muted-foreground">×{item.quantity}</span>
                            </div>
                            <span className="font-medium">
                              {formatCents(item.unit_price_cents * item.quantity)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Shipping */}
                    {order.ship_to_city && (
                      <div>
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">
                          Ship To
                        </h4>
                        <p className="text-sm">
                          {order.ship_to_city}, {order.ship_to_state}
                        </p>
                      </div>
                    )}

                    {/* Tracking */}
                    {order.tracking_number && (
                      <div>
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">
                          Tracking
                        </h4>
                        <div className="flex items-center gap-2 text-sm">
                          <Truck className="h-4 w-4 text-muted-foreground" />
                          <span>{order.tracking_carrier || "Carrier"}</span>
                          <code className="bg-muted px-2 py-0.5 rounded text-xs">
                            {order.tracking_number}
                          </code>
                        </div>
                      </div>
                    )}

                    {/* Total */}
                    <div className="flex items-center justify-between pt-2 border-t">
                      <span className="text-sm font-medium">Total Debited</span>
                      <span className="text-base font-bold">
                        {formatCents(order.total_cents || 0)}
                      </span>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {pagination.total_pages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.total_pages} · {pagination.total} orders
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="min-h-[44px]"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-[44px]"
              disabled={page >= pagination.total_pages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
