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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft, Store, CheckCircle2, XCircle, AlertCircle, ExternalLink,
  RefreshCw, Send, Search, Loader2, Package, Clock, Download, Upload,
  Image as ImageIcon, ShieldCheck,
} from "lucide-react";

interface Channel {
  id: number;
  name: string;
  provider: string;
  status: string;
  isDefault: number;
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

type ShopifyMappingIssueCode =
  | "catalog_product_id_missing"
  | "invalid_shopify_product_id"
  | "remote_product_missing"
  | "duplicate_local_owner"
  | "local_mapping_inconsistent"
  | "shipping_group_conflict"
  | "storefront_shipping_group_drift";

interface ShopifyMappingReconciliationItem {
  productId: number;
  productName: string;
  productSku: string | null;
  shopifyProductId: string | null;
  shippingGroupCode: string | null;
  mappingStatus: string;
  mappingFingerprint: string;
  evidenceProductIds: string[];
  remoteTitle: string | null;
  remoteStatus: string | null;
  remoteShippingGroupCode: string | null;
  comparedShopifyProductId: string | null;
  ownerProductIds: number[];
  issueCodes: ShopifyMappingIssueCode[];
  canRetireDeadMapping: boolean;
}

interface ShopifyMappingReconciliationReport {
  generatedAt: string;
  channel: {
    id: number;
    name: string;
    shopDomain: string;
  };
  summary: {
    localProductCount: number;
    uniqueShopifyProductCount: number;
    healthyProductCount: number;
    issueProductCount: number;
    issueCounts: Record<ShopifyMappingIssueCode, number>;
  };
  items: ShopifyMappingReconciliationItem[];
}

type FeedStatus = "all" | "listed" | "not_listed" | "errors";
const MAPPING_PAGE_SIZE = 20;

const mappingIssueLabels: Record<ShopifyMappingIssueCode, string> = {
  catalog_product_id_missing: "Catalog product ID missing",
  invalid_shopify_product_id: "Invalid Shopify ID",
  remote_product_missing: "Missing in Shopify",
  duplicate_local_owner: "Duplicate local owner",
  local_mapping_inconsistent: "Local mapping incomplete",
  shipping_group_conflict: "Shipping group conflict",
  storefront_shipping_group_drift: "Storefront group drift",
};

export default function ShopifyChannelPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [feedFilter, setFeedFilter] = useState<FeedStatus>("all");
  const [feedSearch, setFeedSearch] = useState("");
  const [pushingProductId, setPushingProductId] = useState<number | null>(null);
  const [showHealthyMappings, setShowHealthyMappings] = useState(false);
  const [mappingPage, setMappingPage] = useState(1);
  const [retireCandidate, setRetireCandidate] =
    useState<ShopifyMappingReconciliationItem | null>(null);

  // --- Fetch channels, find active Shopify channel ---
  const { data: channels = [] } = useQuery<Channel[]>({
    queryKey: ["/api/channels"],
    queryFn: async () => {
      const res = await fetch("/api/channels", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch channels");
      return res.json();
    },
  });
  const shopifyChannel = channels.find(
    (c) =>
      c.provider === "shopify"
      && c.isDefault === 1
      && c.status === "active",
  )
    ?? channels.find(
      (c) => c.provider === "shopify" && c.isDefault === 1,
    )
    ?? channels.find((c) => c.provider === "shopify" && c.status === "active")
    ?? channels.find((c) => c.provider === "shopify");

  const mappingReconciliationQuery =
    useQuery<ShopifyMappingReconciliationReport>({
      queryKey: [
        "/api/channels",
        shopifyChannel?.id,
        "shopify-mapping-reconciliation",
      ],
      queryFn: async () => {
        const response = await fetch(
          `/api/channels/${shopifyChannel!.id}/shopify-mapping-reconciliation`,
          { credentials: "include" },
        );
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(
            body?.error ?? `Mapping health scan failed (${response.status})`,
          );
        }
        return body;
      },
      enabled: false,
      retry: false,
    });

  const retireMappingMutation = useMutation({
    mutationFn: async (item: ShopifyMappingReconciliationItem) => {
      if (!shopifyChannel || !item.shopifyProductId) {
        throw new Error("The stale Shopify mapping is no longer available");
      }
      const response = await fetch(
        `/api/channels/${shopifyChannel.id}/shopify-mapping-reconciliation/products/${item.productId}/retire`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedProductId: item.shopifyProductId,
            expectedFingerprint: item.mappingFingerprint,
            expectedShopDomain:
              mappingReconciliationQuery.data?.channel.shopDomain,
          }),
        },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          body?.error ?? `Stale mapping retirement failed (${response.status})`,
        );
      }
      return body;
    },
    onSuccess: async () => {
      setRetireCandidate(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/products"] }),
        queryClient.invalidateQueries({
          queryKey: ["/api/channels", shopifyChannel?.id, "listings"],
        }),
      ]);
      await mappingReconciliationQuery.refetch();
      toast({
        title: "Stale mapping retired",
        description:
          "The dead Shopify identity was removed. The Echelon product and history were preserved.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Mapping was not changed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

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

  // --- Import images from eBay ---
  const importImagesFromEbayMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/images/pull/ebay", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
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
        title: "Images Imported from eBay",
        description: data.status === "started" ? "Running in background — check logs for progress" : `${data.summary?.imagesAdded ?? data.imported ?? 0} images added · ${data.summary?.errors ?? data.errors ?? 0} errors`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Image Import Failed", description: err.message, variant: "destructive" });
    },
  });

  // --- Push images only to Shopify (safe — no prices/variants touched) ---
  const pushImagesMutation = useMutation({
    mutationFn: async () => {
      if (!shopifyChannel) throw new Error("No active Shopify channel");
      const res = await fetch(`/api/channel-push/images/${shopifyChannel.id}`, { method: "POST", credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels", shopifyChannel?.id, "listings"] });
      const firstErr = data.firstErrors?.[0];
      toast({
        title: data.status === "started" ? "Images Pushed to Shopify" : (data.errors > 0 && data.updated === 0 ? "Image Push Failed" : "Images Pushed to Shopify"),
        description: firstErr
          ? `${data.errors} errors — ${firstErr}`
          : data.status === "started" ? "Running in background — check logs for progress" : `${data.updated} updated · ${data.skipped} skipped`,
        variant: data.errors > 0 ? "destructive" : undefined,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Image Push Failed", description: err.message, variant: "destructive" });
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

  const visibleMappingItems = useMemo(() => {
    const items = mappingReconciliationQuery.data?.items ?? [];
    return showHealthyMappings
      ? items
      : items.filter((item) => item.issueCodes.length > 0);
  }, [mappingReconciliationQuery.data, showHealthyMappings]);
  const mappingPageCount = Math.max(
    1,
    Math.ceil(visibleMappingItems.length / MAPPING_PAGE_SIZE),
  );
  const currentMappingPage = Math.min(mappingPage, mappingPageCount);
  const paginatedMappingItems = visibleMappingItems.slice(
    (currentMappingPage - 1) * MAPPING_PAGE_SIZE,
    currentMappingPage * MAPPING_PAGE_SIZE,
  );

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

      {/* Section 2: Mapping Health */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5" />
                Mapping Health
              </CardTitle>
              <CardDescription>
                Compare Echelon product identities and shipping groups with the
                provider-default Shopify store.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={
                !shopifyChannel || mappingReconciliationQuery.isFetching
              }
              onClick={() => {
                setMappingPage(1);
                void mappingReconciliationQuery.refetch();
              }}
            >
              {mappingReconciliationQuery.isFetching ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Run health scan
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {mappingReconciliationQuery.error ? (
            <div className="flex items-start gap-2 border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{mappingReconciliationQuery.error.message}</span>
            </div>
          ) : !mappingReconciliationQuery.data ? (
            <p className="text-sm text-muted-foreground">
              Run the live scan before changing shipping policies or product
              mappings.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                <span>
                  <strong>
                    {mappingReconciliationQuery.data.summary.issueProductCount}
                  </strong>{" "}
                  need attention
                </span>
                <span>
                  <strong>
                    {mappingReconciliationQuery.data.summary.healthyProductCount}
                  </strong>{" "}
                  healthy
                </span>
                <span className="text-muted-foreground">
                  {mappingReconciliationQuery.data.summary.localProductCount}{" "}
                  mapped products checked
                </span>
                <span className="text-muted-foreground">
                  {mappingReconciliationQuery.data.channel.shopDomain}
                </span>
                <span className="text-xs text-muted-foreground sm:ml-auto">
                  {new Date(
                    mappingReconciliationQuery.data.generatedAt,
                  ).toLocaleString()}
                </span>
              </div>

              <div className="flex gap-2">
                <Button
                  variant={!showHealthyMappings ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setShowHealthyMappings(false);
                    setMappingPage(1);
                  }}
                >
                  Issues
                </Button>
                <Button
                  variant={showHealthyMappings ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setShowHealthyMappings(true);
                    setMappingPage(1);
                  }}
                >
                  All
                </Button>
              </div>

              <div className="border rounded-lg overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead>Shopify product</TableHead>
                      <TableHead>Shipping group</TableHead>
                      <TableHead>Issues</TableHead>
                      <TableHead className="w-[210px] text-right">
                        Actions
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedMappingItems.map((item) => (
                      <TableRow key={item.productId}>
                        <TableCell>
                          <div className="font-medium text-sm">
                            {item.productName}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {item.productSku ?? "No base SKU"}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            {item.remoteTitle ?? "Not found"}
                          </div>
                          <code className="text-xs text-muted-foreground">
                            Catalog: {item.shopifyProductId ?? "missing"}
                          </code>
                          {item.evidenceProductIds.length > 0 && (
                            <div className="text-xs text-muted-foreground">
                              Channel: {item.evidenceProductIds.join(", ")}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            Echelon: {item.shippingGroupCode ?? "None"}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Shopify:{" "}
                            {item.remoteShippingGroupCode ?? "None"}
                          </div>
                        </TableCell>
                        <TableCell>
                          {item.issueCodes.length === 0 ? (
                            <Badge
                              variant="outline"
                              className="border-green-300 text-green-700"
                            >
                              Healthy
                            </Badge>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {item.issueCodes.map((issueCode) => (
                                <Badge
                                  key={issueCode}
                                  variant={
                                    issueCode === "remote_product_missing"
                                    || issueCode === "shipping_group_conflict"
                                      ? "destructive"
                                      : "outline"
                                  }
                                  className="text-xs"
                                >
                                  {mappingIssueLabels[issueCode]}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                navigate(
                                  `/products/${item.productId}?tab=channels`,
                                )}
                            >
                              Open product
                            </Button>
                            {item.canRetireDeadMapping && (
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => setRetireCandidate(item)}
                              >
                                Retire mapping
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {paginatedMappingItems.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="text-center text-sm text-muted-foreground py-8"
                        >
                          {showHealthyMappings
                            ? "No mapped Shopify products were returned."
                            : "No mapping issues were found."}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              {mappingPageCount > 1 && (
                <div className="flex items-center justify-end gap-2">
                  <span className="text-xs text-muted-foreground">
                    Page {currentMappingPage} of {mappingPageCount}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentMappingPage === 1}
                    onClick={() =>
                      setMappingPage((page) => Math.max(1, page - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentMappingPage === mappingPageCount}
                    onClick={() =>
                      setMappingPage((page) =>
                        Math.min(mappingPageCount, page + 1))}
                  >
                    Next
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Section 3: Listing Feed */}
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
                variant="outline"
                size="sm"
                className="min-h-[44px] sm:min-h-0"
                disabled={importImagesFromEbayMutation.isPending}
                onClick={() => importImagesFromEbayMutation.mutate()}
                title="Pull product images from eBay listings into Echelon, then they'll push to Shopify on next push"
              >
                {importImagesFromEbayMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <ImageIcon className="h-4 w-4 mr-2" />
                )}
                Import Images from eBay
              </Button>
              <Button
                size="sm"
                className="min-h-[44px] sm:min-h-0"
                disabled={pushImagesMutation.isPending || !shopifyChannel}
                onClick={() => pushImagesMutation.mutate()}
                title="Push images only — safe, does not change prices or variants"
              >
                {pushImagesMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <ImageIcon className="h-4 w-4 mr-2" />
                )}
                Push Images to Shopify
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-[44px] sm:min-h-0 opacity-50 cursor-not-allowed"
                disabled={true}
                title="Product push is disabled to prevent data loss. Contact an admin to re-enable."
              >
                <Send className="h-4 w-4 mr-2" />
                Push Disabled
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
                      {/* Push action column disabled */}
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
                        {/* Push button removed — feature disabled */}
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

      <AlertDialog
        open={retireCandidate !== null}
        onOpenChange={(open) => {
          if (!open && !retireMappingMutation.isPending) {
            setRetireCandidate(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire dead Shopify mapping?</AlertDialogTitle>
            <AlertDialogDescription>
              Shopify will be checked again before any change. If the product
              or any referenced variant still exists, nothing will be changed.
              The Echelon product and historical records are always preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {retireCandidate && (
            <div className="border p-3 text-sm">
              <div className="font-medium">{retireCandidate.productName}</div>
              <div className="text-muted-foreground">
                Shopify product {retireCandidate.shopifyProductId}
              </div>
              <div className="text-muted-foreground">
                {mappingReconciliationQuery.data?.channel.shopDomain}
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={retireMappingMutation.isPending}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={
                !retireCandidate || retireMappingMutation.isPending
              }
              onClick={(event) => {
                event.preventDefault();
                if (retireCandidate) {
                  retireMappingMutation.mutate(retireCandidate);
                }
              }}
            >
              {retireMappingMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Verify and retire
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
