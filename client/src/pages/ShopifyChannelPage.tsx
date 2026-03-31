/**
 * Shopify Channel Page
 *
 * Manages the Shopify sales channel:
 * - Store connection status
 * - Product listing feed with push status
 * - Push individual or all products to Shopify
 * - Pull products from Shopify into Echelon
 */

import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft, Store, CheckCircle2, XCircle, AlertCircle, ExternalLink,
  RefreshCw, Send, Search, Loader2, Package, Clock,
} from "lucide-react";

interface Channel {
  id: number;
  name: string;
  provider: string;
  status: string;
}

interface Product {
  id: number;
  name: string;
  sku: string | null;
  isActive: boolean;
  shopifyProductId: string | null;
  imageUrl: string | null;
}

interface ChannelListing {
  id: number;
  channelId: number;
  productVariantId: number;
  externalProductId: string | null;
  externalVariantId: string | null;
  externalSku: string | null;
  syncStatus: string | null;
  syncError: string | null;
  lastSyncedAt: string | null;
}

type FeedStatus = "all" | "listed" | "not_listed" | "errors";

export default function ShopifyChannelPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [feedFilter, setFeedFilter] = useState<FeedStatus>("all");
  const [feedSearch, setFeedSearch] = useState("");
  const [pushingProductId, setPushingProductId] = useState<number | null>(null);

  // --- Fetch channels, find active Shopify channel ---
  const { data: channels = [] } = useQuery<Channel[]>({
    queryKey: ["/api/channels"],
    queryFn: async () => {
      const res = await fetch("/api/channels", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch channels");
      return res.json();
    },
  });
  const shopifyChannel = channels.find((c) => c.provider === "shopify" && c.status === "active")
    ?? channels.find((c) => c.provider === "shopify");

  // --- Fetch products ---
  const { data: products = [], isLoading: productsLoading } = useQuery<Product[]>({
    queryKey: ["/api/products"],
    queryFn: async () => {
      const res = await fetch("/api/products", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch products");
      return res.json();
    },
    enabled: !!shopifyChannel,
  });

  // --- Fetch channel listings ---
  const { data: listings = [], isLoading: listingsLoading } = useQuery<ChannelListing[]>({
    queryKey: ["/api/channels", shopifyChannel?.id, "listings"],
    queryFn: async () => {
      const res = await fetch(`/api/channels/${shopifyChannel!.id}/listings`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch listings");
      return res.json();
    },
    enabled: !!shopifyChannel,
  });

  // --- Sync from Shopify mutation ---
  const syncFromShopifyMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/shopify/sync-products", { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error("Sync failed");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/channels", shopifyChannel?.id, "listings"] });
      toast({
        title: "Sync Complete",
        description: `Products: ${data.products?.created || 0} created, ${data.products?.updated || 0} updated`,
      });
    },
    onError: () => {
      toast({ title: "Sync Failed", variant: "destructive" });
    },
  });

  // --- Sync Inventory to Shopify ---
  const syncInventoryMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/channel-sync/all", { method: "POST", credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels", shopifyChannel?.id, "listings"] });
      toast({
        title: "Inventory Synced",
        description: `${data.synced ?? 0} variant${(data.synced ?? 0) !== 1 ? "s" : ""} synced to Shopify`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Inventory Sync Failed", description: err.message, variant: "destructive" });
    },
  });

  // --- Push All mutation ---
  const pushAllMutation = useMutation({
    mutationFn: async () => {
      if (!shopifyChannel) throw new Error("No active Shopify channel");
      const res = await fetch(`/api/channel-push/all/${shopifyChannel.id}`, { method: "POST", credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/channels", shopifyChannel?.id, "listings"] });
      toast({
        title: "Push All Complete",
        description: `${data.created || 0} created · ${data.updated || 0} updated · ${data.errors || 0} errors`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Push All Failed", description: err.message, variant: "destructive" });
    },
  });

  // --- Push single product mutation ---
  const pushProductMutation = useMutation({
    mutationFn: async (productId: number) => {
      if (!shopifyChannel) throw new Error("No Shopify channel");
      setPushingProductId(productId);
      const res = await fetch(`/api/channel-push/product/${productId}/channel/${shopifyChannel.id}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      // Service returns 200 with status:"error"/"skipped" on soft failure
      if (data?.status === "error" || data?.status === "skipped") {
        throw new Error(data?.error || `Push ${data?.status}`);
      }
      return data;
    },
    onSuccess: (data, _productId) => {
      setPushingProductId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/channels", shopifyChannel?.id, "listings"] });
      const status = data?.status;
      toast({
        title: status === "created" ? "Created on Shopify" : "Updated on Shopify",
        description: data?.externalProductId ? `Shopify ID: ${data.externalProductId}` : undefined,
      });
    },
    onError: (err: Error, _productId) => {
      setPushingProductId(null);
      const raw = err.message || "Unknown error";
      const isHtml = raw.includes("<!DOCTYPE") || raw.includes("<html");
      toast({
        title: "Push Failed",
        description: isHtml ? "Server error — check logs" : raw.length > 200 ? raw.substring(0, 200) + "…" : raw,
        variant: "destructive",
      });
    },
  });

  // Build a map from externalProductId → listing[]
  const listingsByExternalId = useMemo(() => {
    const map = new Map<string, ChannelListing[]>();
    for (const l of listings) {
      if (l.externalProductId) {
        const arr = map.get(l.externalProductId) || [];
        arr.push(l);
        map.set(l.externalProductId, arr);
      }
    }
    return map;
  }, [listings]);

  // Build the feed items
  interface FeedItem {
    productId: number;
    name: string;
    sku: string | null;
    isActive: boolean;
    shopifyProductId: string | null;
    listings: ChannelListing[];
    status: "listed" | "not_listed" | "error";
    lastSyncedAt: string | null;
    syncError: string | null;
  }

  const feed = useMemo((): FeedItem[] => {
    return products.map((p) => {
      const productListings = p.shopifyProductId
        ? (listingsByExternalId.get(p.shopifyProductId) || [])
        : [];

      const hasError = productListings.some((l) => l.syncStatus === "error");
      const isListed = productListings.length > 0 && productListings.some((l) => l.externalProductId);
      const lastSyncedAt = productListings.reduce<string | null>((latest, l) => {
        if (!l.lastSyncedAt) return latest;
        if (!latest) return l.lastSyncedAt;
        return l.lastSyncedAt > latest ? l.lastSyncedAt : latest;
      }, null);
      const syncError = productListings.find((l) => l.syncError)?.syncError || null;

      return {
        productId: p.id,
        name: p.name,
        sku: p.sku,
        isActive: p.isActive,
        shopifyProductId: p.shopifyProductId,
        listings: productListings,
        status: hasError ? "error" : isListed ? "listed" : "not_listed",
        lastSyncedAt,
        syncError,
      };
    });
  }, [products, listingsByExternalId]);

  const feedCounts = useMemo(() => ({
    all: feed.length,
    listed: feed.filter((f) => f.status === "listed").length,
    not_listed: feed.filter((f) => f.status === "not_listed").length,
    errors: feed.filter((f) => f.status === "error").length,
  }), [feed]);

  const filteredFeed = useMemo(() => {
    let items = feed;
    if (feedFilter === "listed") items = items.filter((f) => f.status === "listed");
    else if (feedFilter === "not_listed") items = items.filter((f) => f.status === "not_listed");
    else if (feedFilter === "errors") items = items.filter((f) => f.status === "error");
    if (feedSearch) {
      const q = feedSearch.toLowerCase();
      items = items.filter(
        (f) => f.name.toLowerCase().includes(q) || (f.sku && f.sku.toLowerCase().includes(q))
      );
    }
    return items;
  }, [feed, feedFilter, feedSearch]);

  const isLoading = productsLoading || listingsLoading;

  return (
    <div className="p-2 sm:p-4 md:p-6 space-y-4 sm:space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/channels")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="bg-green-500/10 p-2 rounded-lg">
          <Store className="h-6 w-6 text-green-600" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">Shopify Channel</h1>
          <p className="text-sm text-muted-foreground">
            {shopifyChannel ? shopifyChannel.name : "No Shopify channel configured"}
          </p>
        </div>
      </div>

      {/* Section 1: Store Setup */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Store className="h-5 w-5" />
            Store Connection
          </CardTitle>
          <CardDescription>Shopify store credentials and connection status</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!shopifyChannel ? (
            <div className="flex items-center gap-3">
              <Badge variant="destructive" className="gap-1.5 py-1 px-3">
                <XCircle className="h-3.5 w-3.5" />
                No Shopify Channel
              </Badge>
              <Button variant="outline" size="sm" onClick={() => navigate("/channels")}>
                <ExternalLink className="h-4 w-4 mr-2" />
                Set Up Channel
              </Button>
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <Badge variant="default" className="bg-green-600 hover:bg-green-600 gap-1.5 py-1 px-3 w-fit">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Connected
              </Badge>
              <span className="text-sm text-muted-foreground">
                Channel: <strong className="text-foreground">{shopifyChannel.name}</strong>
              </span>
              <Badge variant="outline" className="text-xs w-fit capitalize">{shopifyChannel.status}</Badge>
              <Button variant="outline" size="sm" className="sm:ml-auto" onClick={() => navigate("/channels")}>
                <ExternalLink className="h-4 w-4 mr-2" />
                Manage Connection
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 2: Listing Feed */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                Product Feed
              </CardTitle>
              <CardDescription>Products and their Shopify push status</CardDescription>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Button
                variant="outline"
                size="sm"
                className="min-h-[44px] sm:min-h-0"
                disabled={syncFromShopifyMutation.isPending || !shopifyChannel}
                onClick={() => syncFromShopifyMutation.mutate()}
              >
                {syncFromShopifyMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Sync from Shopify
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-[44px] sm:min-h-0"
                disabled={syncInventoryMutation.isPending || !shopifyChannel}
                onClick={() => syncInventoryMutation.mutate()}
                title="Push current inventory levels to Shopify now"
              >
                {syncInventoryMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Sync Inventory
              </Button>
              <Button
                size="sm"
                className="min-h-[44px] sm:min-h-0"
                disabled={pushAllMutation.isPending || !shopifyChannel}
                onClick={() => pushAllMutation.mutate()}
              >
                {pushAllMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-2" />
                )}
                Push All to Shopify
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!shopifyChannel ? (
            <p className="text-sm text-muted-foreground">Configure a Shopify channel first.</p>
          ) : isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading product feed...
            </div>
          ) : (
            <>
              {/* Filter tabs */}
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-1.5">
                  {(["all", "listed", "not_listed", "errors"] as const).map((f) => (
                    <Button
                      key={f}
                      variant={feedFilter === f ? "default" : "outline"}
                      size="sm"
                      className={`text-xs h-8 px-3 ${f === "errors" && feedCounts.errors > 0 ? "border-red-300 text-red-600" : ""}`}
                      onClick={() => setFeedFilter(f)}
                    >
                      {f === "all" && `All (${feedCounts.all})`}
                      {f === "listed" && `Listed (${feedCounts.listed})`}
                      {f === "not_listed" && `Not Listed (${feedCounts.not_listed})`}
                      {f === "errors" && `Errors (${feedCounts.errors})`}
                    </Button>
                  ))}
                </div>
                <div className="relative w-full sm:max-w-xs">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name or SKU..."
                    className="pl-9 h-9 text-sm"
                    value={feedSearch}
                    onChange={(e) => setFeedSearch(e.target.value)}
                  />
                </div>
              </div>

              {/* Feed table */}
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="w-[140px]">SKU</TableHead>
                      <TableHead className="w-[120px]">Shopify ID</TableHead>
                      <TableHead className="w-[110px] text-center">Status</TableHead>
                      <TableHead className="w-[120px]">Last Synced</TableHead>
                      <TableHead className="w-[80px] text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredFeed.map((item) => (
                      <TableRow key={item.productId} className={!item.isActive ? "opacity-50" : ""}>
                        <TableCell>
                          <span className="font-medium text-sm">{item.name}</span>
                          {item.syncError && (
                            <p className="text-xs text-red-600 mt-0.5 line-clamp-1" title={item.syncError}>
                              {item.syncError}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          <code className="text-xs bg-muted px-1 py-0.5 rounded">
                            {item.sku || "—"}
                          </code>
                        </TableCell>
                        <TableCell>
                          {item.shopifyProductId ? (
                            <a
                              href={`https://admin.shopify.com/store/cardshellz/products/${item.shopifyProductId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-500 hover:text-blue-700 flex items-center gap-1 font-mono"
                            >
                              {item.shopifyProductId}
                              <ExternalLink className="h-3 w-3 shrink-0" />
                            </a>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          {item.status === "listed" && (
                            <Badge className="bg-green-600 hover:bg-green-600 text-xs">Listed</Badge>
                          )}
                          {item.status === "not_listed" && (
                            <Badge variant="secondary" className="text-xs">Not Listed</Badge>
                          )}
                          {item.status === "error" && (
                            <Badge variant="destructive" className="text-xs">
                              <AlertCircle className="h-3 w-3 mr-1" />Error
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {item.lastSyncedAt ? (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {new Date(item.lastSyncedAt).toLocaleDateString()}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">Never</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={pushingProductId === item.productId || pushProductMutation.isPending}
                            onClick={() => pushProductMutation.mutate(item.productId)}
                            title={item.status === "listed" ? "Update on Shopify" : "Push to Shopify"}
                          >
                            {pushingProductId === item.productId ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Send className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {filteredFeed.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                          {feed.length === 0
                            ? "No products found. Sync from Shopify or add products manually."
                            : "No products match your filter."}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              {filteredFeed.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Showing {filteredFeed.length} of {feedCounts.all} products
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
