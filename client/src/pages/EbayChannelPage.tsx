/**
 * eBay Channel Configuration — Full Page
 *
 * Three sections:
 * 1. Store Setup (connection, location, default policies)
 * 2. Category Mapping (product type → eBay category)
 * 3. Listing Feed (products ready to list)
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  MapPin,
  FileText,
  Store,
  ShieldCheck,
  Clock,
  ExternalLink,
  ArrowLeft,
  Layers,
  Tag,
  Search,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Upload,
  Package,
  AlertCircle,
  Settings2,
  Save,
  Zap,
} from "lucide-react";
import { ProductTypeManager } from "@/components/ebay/ProductTypeManager";

// ============================================================================
// Types
// ============================================================================

interface ChannelConfig {
  connected: boolean;
  channel: { id: number; name: string; status: string } | null;
  ebayUsername: string | null;
  tokenInfo: {
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
    lastRefreshedAt: string;
    environment: string;
  } | null;
  config: {
    merchantLocationKey: string | null;
    fulfillmentPolicyId: string | null;
    returnPolicyId: string | null;
    paymentPolicyId: string | null;
    merchantLocation: {
      name: string;
      addressLine1: string;
      addressLine2: string;
      city: string;
      stateOrProvince: string;
      postalCode: string;
      country: string;
    } | null;
  };
  categoryMappings: CategoryMapping[];
  productTypes: ProductTypeWithCount[];
  lastSyncAt: string | null;
  syncStatus: string;
}

interface CategoryMapping {
  id?: number;
  productTypeSlug: string;
  ebayBrowseCategoryId: string | null;
  ebayBrowseCategoryName: string | null;
  ebayStoreCategoryId: string | null;
  ebayStoreCategoryName: string | null;
  fulfillmentPolicyOverride: string | null;
  returnPolicyOverride: string | null;
  paymentPolicyOverride: string | null;
}

interface ProductTypeWithCount {
  id: number;
  slug: string;
  name: string;
  sort_order: number;
  product_count: number;
}

interface Policy {
  id: string;
  name: string;
  description: string;
}

interface PoliciesResponse {
  fulfillmentPolicies: Policy[];
  returnPolicies: Policy[];
  paymentPolicies: Policy[];
}

interface BrowseCategory {
  id: string;
  name: string;
  path: string;
}

interface StoreCategory {
  id: string;
  name: string;
}

interface FeedItem {
  id: number;
  name: string;
  sku: string | null;
  productType: string;
  productTypeName: string;
  ebayBrowseCategoryName: string | null;
  ebayStoreCategoryName: string | null;
  status: "ready" | "missing_config" | "listed";
  missingItems: string[];
  isListed: boolean;
  externalListingId: string | null;
  variantCount: number;
  imageCount: number;
}

// ============================================================================
// Component
// ============================================================================

export default function EbayChannelPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ---- Main config query ----
  const {
    data: config,
    isLoading: configLoading,
    error: configError,
  } = useQuery<ChannelConfig>({
    queryKey: ["/api/ebay/channel-config"],
  });

  // ---- Policies ----
  const { data: policies, isLoading: policiesLoading } = useQuery<PoliciesResponse>({
    queryKey: ["/api/ebay/policies"],
    enabled: !!config?.connected,
  });

  // ---- Store categories ----
  const { data: storeCatsData, refetch: refetchStoreCats } = useQuery<{ categories: StoreCategory[] }>({
    queryKey: ["/api/ebay/store-categories"],
    enabled: !!config?.connected,
  });

  // ---- Listing feed ----
  const { data: feedData, isLoading: feedLoading } = useQuery<{ feed: FeedItem[]; total: number }>({
    queryKey: ["/api/ebay/listing-feed"],
    enabled: !!config?.connected,
  });

  // ---- Local state ----
  const [policySelections, setPolicySelections] = useState({
    fulfillmentPolicyId: "",
    returnPolicyId: "",
    paymentPolicyId: "",
  });
  const [policySynced, setPolicySynced] = useState(false);
  const [productTypeManagerOpen, setProductTypeManagerOpen] = useState(false);

  // Category mapping local state
  const [localMappings, setLocalMappings] = useState<Map<string, CategoryMapping>>(new Map());
  const [mappingsDirty, setMappingsDirty] = useState(false);
  const [expandedOverrides, setExpandedOverrides] = useState<Set<string>>(new Set());

  // Browse category search
  const [browseCategorySearch, setBrowseCategorySearch] = useState<Record<string, string>>({});
  const [browseCategoryResults, setBrowseCategoryResults] = useState<Record<string, BrowseCategory[]>>({});
  const [searchingCategory, setSearchingCategory] = useState<string | null>(null);

  // Feed filters
  const [feedFilter, setFeedFilter] = useState<"all" | "ready" | "missing_config" | "listed">("all");
  const [feedSearch, setFeedSearch] = useState("");

  // Location form
  const [locationForm, setLocationForm] = useState({
    name: "Card Shellz HQ",
    addressLine1: "20 Leonberg Rd",
    addressLine2: "",
    city: "Cranberry Township",
    stateOrProvince: "PA",
    postalCode: "16066",
    country: "US",
    merchantLocationKey: "CARDSHELLZ_HQ",
  });

  // Sync policies from config
  useEffect(() => {
    if (config?.config && !policySynced) {
      const c = config.config;
      if (c.fulfillmentPolicyId || c.returnPolicyId || c.paymentPolicyId) {
        setPolicySelections({
          fulfillmentPolicyId: c.fulfillmentPolicyId || "",
          returnPolicyId: c.returnPolicyId || "",
          paymentPolicyId: c.paymentPolicyId || "",
        });
        setPolicySynced(true);
      }
    }
  }, [config, policySynced]);

  // Sync category mappings from config
  useEffect(() => {
    if (config?.categoryMappings && !mappingsDirty) {
      const map = new Map<string, CategoryMapping>();
      for (const m of config.categoryMappings) {
        map.set(m.productTypeSlug, m);
      }
      setLocalMappings(map);
    }
  }, [config?.categoryMappings, mappingsDirty]);

  // ---- Browse category search handler ----
  const searchBrowseCategories = useCallback(async (slug: string, query: string) => {
    if (query.length < 2) {
      setBrowseCategoryResults((prev) => ({ ...prev, [slug]: [] }));
      return;
    }
    setSearchingCategory(slug);
    try {
      const resp = await fetch(`/api/ebay/browse-categories?q=${encodeURIComponent(query)}`, {
        credentials: "include",
      });
      if (resp.ok) {
        const data = await resp.json();
        setBrowseCategoryResults((prev) => ({ ...prev, [slug]: data.categories || [] }));
      }
    } catch {} finally {
      setSearchingCategory(null);
    }
  }, []);

  // ---- Mutations ----

  const savePoliciesMutation = useMutation({
    mutationFn: async () => {
      const resp = await apiRequest("PUT", "/api/ebay/settings", policySelections);
      return resp.json();
    },
    onSuccess: () => {
      toast({ title: "Settings Saved", description: "Default business policies updated." });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const createLocationMutation = useMutation({
    mutationFn: async () => {
      const resp = await apiRequest("POST", "/api/ebay/location", locationForm);
      return resp.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Location Created", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const saveMappingsMutation = useMutation({
    mutationFn: async () => {
      const mappingsArray = Array.from(localMappings.values()).filter(
        (m) => m.ebayBrowseCategoryId || m.ebayStoreCategoryId
      );
      const resp = await apiRequest("PUT", "/api/ebay/category-mapping", { mappings: mappingsArray });
      return resp.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Mappings Saved", description: data.message });
      setMappingsDirty(false);
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const syncStoreCategoriesMutation = useMutation({
    mutationFn: async (names: string[]) => {
      const resp = await apiRequest("POST", "/api/ebay/sync-store-categories", { productTypeNames: names });
      return resp.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Store Categories Synced", description: data.message });
      refetchStoreCats();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // ---- Helpers ----

  const updateMapping = (slug: string, updates: Partial<CategoryMapping>) => {
    setLocalMappings((prev) => {
      const next = new Map(prev);
      const existing = next.get(slug) || { productTypeSlug: slug } as CategoryMapping;
      next.set(slug, { ...existing, ...updates });
      return next;
    });
    setMappingsDirty(true);
  };

  const toggleOverride = (slug: string) => {
    setExpandedOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  // ---- Computed ----

  const hasLocation = !!config?.config?.merchantLocationKey;
  const hasPolicies = !!(
    config?.config?.fulfillmentPolicyId &&
    config?.config?.returnPolicyId &&
    config?.config?.paymentPolicyId
  );

  const filteredFeed = useMemo(() => {
    if (!feedData?.feed) return [];
    let items = feedData.feed;
    if (feedFilter !== "all") {
      items = items.filter((i) => i.status === feedFilter);
    }
    if (feedSearch) {
      const q = feedSearch.toLowerCase();
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          (i.sku && i.sku.toLowerCase().includes(q))
      );
    }
    return items;
  }, [feedData, feedFilter, feedSearch]);

  const feedCounts = useMemo(() => {
    if (!feedData?.feed) return { all: 0, ready: 0, missing_config: 0, listed: 0 };
    const feed = feedData.feed;
    return {
      all: feed.length,
      ready: feed.filter((f) => f.status === "ready").length,
      missing_config: feed.filter((f) => f.status === "missing_config").length,
      listed: feed.filter((f) => f.status === "listed").length,
    };
  }, [feedData]);

  const storeCats = storeCatsData?.categories || [];

  // ---- Render ----

  if (configLoading) {
    return (
      <div className="flex items-center justify-center h-full py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (configError) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-10 text-center">
            <AlertCircle className="h-10 w-10 text-destructive mx-auto mb-3" />
            <p className="text-destructive font-medium">Failed to load eBay configuration</p>
            <p className="text-sm text-muted-foreground mt-1">{(configError as Error).message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      {/* Page Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/channels")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="bg-blue-500/10 p-2 rounded-lg">
          <Store className="h-6 w-6 text-blue-600" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">eBay Channel</h1>
          <p className="text-sm text-muted-foreground">
            Store setup, category mapping, and listing feed
          </p>
        </div>
      </div>

      {/* ================================================================== */}
      {/* SECTION 1: Store Setup                                             */}
      {/* ================================================================== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Store Setup
          </CardTitle>
          <CardDescription>Connection, location, and default business policies</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Connection Status */}
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground font-medium">Connection</Label>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 mt-2">
              <div className="flex items-center gap-3 flex-1">
                {config?.connected ? (
                  <Badge variant="default" className="bg-green-600 hover:bg-green-600 gap-1.5 py-1 px-3">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Connected
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="gap-1.5 py-1 px-3">
                    <XCircle className="h-3.5 w-3.5" />
                    Not Connected
                  </Badge>
                )}
                {config?.ebayUsername && (
                  <span className="text-sm text-muted-foreground">
                    Account: <strong className="text-foreground">{config.ebayUsername}</strong>
                  </span>
                )}
                {config?.tokenInfo?.environment && (
                  <Badge variant="outline" className="text-xs">{config.tokenInfo.environment}</Badge>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open("/api/ebay/oauth/consent", "_blank")}
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                {config?.connected ? "Reconnect" : "Connect eBay"}
              </Button>
            </div>
            {config?.tokenInfo && (
              <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Access expires: {new Date(config.tokenInfo.accessTokenExpiresAt).toLocaleString()}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Refresh expires: {config.tokenInfo.refreshTokenExpiresAt
                    ? new Date(config.tokenInfo.refreshTokenExpiresAt).toLocaleString()
                    : "N/A"}
                </span>
              </div>
            )}
          </div>

          <Separator />

          {/* Merchant Location */}
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground font-medium">Merchant Location</Label>
            {hasLocation && config?.config?.merchantLocation ? (
              <div className="flex items-start gap-3 mt-2">
                <Badge variant="default" className="bg-green-600 hover:bg-green-600 gap-1.5 py-1 px-3 shrink-0 mt-0.5">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Active
                </Badge>
                <div className="text-sm">
                  <p className="font-medium">{config.config.merchantLocation.name}</p>
                  <p className="text-muted-foreground">
                    {config.config.merchantLocation.addressLine1}
                    {config.config.merchantLocation.addressLine2 && `, ${config.config.merchantLocation.addressLine2}`}
                    {" — "}
                    {config.config.merchantLocation.city}, {config.config.merchantLocation.stateOrProvince} {config.config.merchantLocation.postalCode}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Key: <code className="bg-muted px-1 rounded">{config.config.merchantLocationKey}</code>
                  </p>
                </div>
              </div>
            ) : (
              <div className="mt-2 space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <Label className="text-xs">Name</Label>
                    <Input
                      value={locationForm.name}
                      onChange={(e) => setLocationForm({ ...locationForm, name: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Key</Label>
                    <Input
                      value={locationForm.merchantLocationKey}
                      onChange={(e) => setLocationForm({ ...locationForm, merchantLocationKey: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Address</Label>
                    <Input
                      value={locationForm.addressLine1}
                      onChange={(e) => setLocationForm({ ...locationForm, addressLine1: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">City, State ZIP</Label>
                    <Input
                      value={`${locationForm.city}, ${locationForm.stateOrProvince} ${locationForm.postalCode}`}
                      readOnly
                      className="mt-1 bg-muted"
                    />
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => createLocationMutation.mutate()}
                  disabled={createLocationMutation.isPending || !config?.connected}
                >
                  {createLocationMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  <MapPin className="h-4 w-4 mr-2" />
                  Create Location on eBay
                </Button>
              </div>
            )}
          </div>

          <Separator />

          {/* Default Business Policies */}
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground font-medium">Default Business Policies</Label>
            {!config?.connected ? (
              <p className="text-sm text-muted-foreground mt-2">Connect to eBay to load policies.</p>
            ) : policiesLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground mt-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading policies...
              </div>
            ) : (
              <div className="mt-2 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <Label className="text-xs">Shipping</Label>
                    <Select
                      value={policySelections.fulfillmentPolicyId}
                      onValueChange={(v) => setPolicySelections({ ...policySelections, fulfillmentPolicyId: v })}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select shipping..." />
                      </SelectTrigger>
                      <SelectContent>
                        {(policies?.fulfillmentPolicies || []).map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">Returns</Label>
                    <Select
                      value={policySelections.returnPolicyId}
                      onValueChange={(v) => setPolicySelections({ ...policySelections, returnPolicyId: v })}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select returns..." />
                      </SelectTrigger>
                      <SelectContent>
                        {(policies?.returnPolicies || []).map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">Payment</Label>
                    <Select
                      value={policySelections.paymentPolicyId}
                      onValueChange={(v) => setPolicySelections({ ...policySelections, paymentPolicyId: v })}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select payment..." />
                      </SelectTrigger>
                      <SelectContent>
                        {(policies?.paymentPolicies || []).map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    onClick={() => savePoliciesMutation.mutate()}
                    disabled={
                      savePoliciesMutation.isPending ||
                      !policySelections.fulfillmentPolicyId ||
                      !policySelections.returnPolicyId ||
                      !policySelections.paymentPolicyId
                    }
                  >
                    {savePoliciesMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    <Save className="h-4 w-4 mr-2" />
                    Save Policies
                  </Button>
                  {hasPolicies && (
                    <Badge variant="default" className="bg-green-600 hover:bg-green-600 gap-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      All configured
                    </Badge>
                  )}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ================================================================== */}
      {/* SECTION 2: Category Mapping                                        */}
      {/* ================================================================== */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Layers className="h-5 w-5" />
                Category Mapping
              </CardTitle>
              <CardDescription>Map your product types to eBay categories</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setProductTypeManagerOpen(true)}
              >
                <Tag className="h-4 w-4 mr-2" />
                Manage Product Types
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const names = (config?.productTypes || [])
                    .filter((pt) => pt.product_count > 0)
                    .map((pt) => pt.name);
                  if (names.length === 0) {
                    toast({ title: "No product types with products", variant: "destructive" });
                    return;
                  }
                  syncStoreCategoriesMutation.mutate(names);
                }}
                disabled={syncStoreCategoriesMutation.isPending || !config?.connected}
              >
                {syncStoreCategoriesMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                Sync to eBay Store
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {!config?.connected ? (
            <p className="text-sm text-muted-foreground">Connect to eBay first.</p>
          ) : (
            <>
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[200px]">Product Type</TableHead>
                      <TableHead>eBay Browse Category</TableHead>
                      <TableHead className="w-[200px]">eBay Store Category</TableHead>
                      <TableHead className="w-[100px] text-center">Overrides</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(config?.productTypes || []).map((pt) => {
                      const mapping = localMappings.get(pt.slug) || {} as Partial<CategoryMapping>;
                      const isOverrideExpanded = expandedOverrides.has(pt.slug);
                      const searchQuery = browseCategorySearch[pt.slug] || "";
                      const results = browseCategoryResults[pt.slug] || [];
                      const isSearching = searchingCategory === pt.slug;

                      return (
                        <React.Fragment key={pt.slug}>
                            <TableRow className="group">
                              <TableCell>
                                <div>
                                  <span className="font-medium text-sm">{pt.name}</span>
                                  <span className="text-xs text-muted-foreground ml-2">
                                    ({pt.product_count} product{pt.product_count !== 1 ? "s" : ""})
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="relative">
                                  {mapping.ebayBrowseCategoryName ? (
                                    <div className="flex items-center gap-2">
                                      <Badge variant="secondary" className="text-xs max-w-[300px] truncate">
                                        {mapping.ebayBrowseCategoryName}
                                      </Badge>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 px-2 text-xs"
                                        onClick={() => {
                                          updateMapping(pt.slug, {
                                            ebayBrowseCategoryId: null,
                                            ebayBrowseCategoryName: null,
                                          });
                                        }}
                                      >
                                        <XCircle className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  ) : (
                                    <div className="space-y-1">
                                      <div className="relative">
                                        <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                                        <Input
                                          placeholder="Search eBay categories..."
                                          className="pl-8 h-8 text-xs"
                                          value={searchQuery}
                                          onChange={(e) => {
                                            setBrowseCategorySearch((prev) => ({
                                              ...prev,
                                              [pt.slug]: e.target.value,
                                            }));
                                            searchBrowseCategories(pt.slug, e.target.value);
                                          }}
                                        />
                                        {isSearching && (
                                          <Loader2 className="absolute right-2 top-2.5 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                        )}
                                      </div>
                                      {results.length > 0 && (
                                        <div className="absolute z-10 bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto w-[400px]">
                                          {results.map((cat) => (
                                            <button
                                              key={cat.id}
                                              className="w-full text-left px-3 py-2 text-xs hover:bg-accent transition-colors"
                                              onClick={() => {
                                                updateMapping(pt.slug, {
                                                  ebayBrowseCategoryId: cat.id,
                                                  ebayBrowseCategoryName: cat.path || cat.name,
                                                });
                                                setBrowseCategorySearch((prev) => ({
                                                  ...prev,
                                                  [pt.slug]: "",
                                                }));
                                                setBrowseCategoryResults((prev) => ({
                                                  ...prev,
                                                  [pt.slug]: [],
                                                }));
                                              }}
                                            >
                                              <div className="font-medium">{cat.name}</div>
                                              {cat.path && cat.path !== cat.name && (
                                                <div className="text-muted-foreground truncate">{cat.path}</div>
                                              )}
                                            </button>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Select
                                  value={mapping.ebayStoreCategoryId || ""}
                                  onValueChange={(v) => {
                                    const cat = storeCats.find((c) => c.id === v);
                                    updateMapping(pt.slug, {
                                      ebayStoreCategoryId: v || null,
                                      ebayStoreCategoryName: cat?.name || null,
                                    });
                                  }}
                                >
                                  <SelectTrigger className="h-8 text-xs">
                                    <SelectValue placeholder="Select store category..." />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {storeCats.map((cat) => (
                                      <SelectItem key={cat.id} value={cat.id} className="text-xs">
                                        {cat.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </TableCell>
                              <TableCell className="text-center">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => toggleOverride(pt.slug)}
                                >
                                  {isOverrideExpanded ? (
                                    <ChevronDown className="h-3.5 w-3.5" />
                                  ) : (
                                    <ChevronRight className="h-3.5 w-3.5" />
                                  )}
                                  <Settings2 className="h-3.5 w-3.5 ml-1" />
                                </Button>
                              </TableCell>
                            </TableRow>
                            {isOverrideExpanded && (
                              <TableRow className="bg-muted/30">
                                <TableCell colSpan={4}>
                                  <div className="py-2 px-4">
                                    <p className="text-xs text-muted-foreground mb-2 font-medium">
                                      Policy overrides for {pt.name} (leave blank to use store defaults)
                                    </p>
                                    <div className="grid grid-cols-3 gap-3">
                                      <div>
                                        <Label className="text-xs">Shipping Override</Label>
                                        <Select
                                          value={mapping.fulfillmentPolicyOverride || ""}
                                          onValueChange={(v) =>
                                            updateMapping(pt.slug, { fulfillmentPolicyOverride: v || null })
                                          }
                                        >
                                          <SelectTrigger className="mt-1 h-8 text-xs">
                                            <SelectValue placeholder="Use default" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            <SelectItem value="" className="text-xs">Use default</SelectItem>
                                            {(policies?.fulfillmentPolicies || []).map((p) => (
                                              <SelectItem key={p.id} value={p.id} className="text-xs">{p.name}</SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                      </div>
                                      <div>
                                        <Label className="text-xs">Returns Override</Label>
                                        <Select
                                          value={mapping.returnPolicyOverride || ""}
                                          onValueChange={(v) =>
                                            updateMapping(pt.slug, { returnPolicyOverride: v || null })
                                          }
                                        >
                                          <SelectTrigger className="mt-1 h-8 text-xs">
                                            <SelectValue placeholder="Use default" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            <SelectItem value="" className="text-xs">Use default</SelectItem>
                                            {(policies?.returnPolicies || []).map((p) => (
                                              <SelectItem key={p.id} value={p.id} className="text-xs">{p.name}</SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                      </div>
                                      <div>
                                        <Label className="text-xs">Payment Override</Label>
                                        <Select
                                          value={mapping.paymentPolicyOverride || ""}
                                          onValueChange={(v) =>
                                            updateMapping(pt.slug, { paymentPolicyOverride: v || null })
                                          }
                                        >
                                          <SelectTrigger className="mt-1 h-8 text-xs">
                                            <SelectValue placeholder="Use default" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            <SelectItem value="" className="text-xs">Use default</SelectItem>
                                            {(policies?.paymentPolicies || []).map((p) => (
                                              <SelectItem key={p.id} value={p.id} className="text-xs">{p.name}</SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                      </div>
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                        </React.Fragment>
                      );
                    })}
                    {(!config?.productTypes || config.productTypes.length === 0) && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                          No product types defined. Use "Manage Product Types" to create and assign them.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              {mappingsDirty && (
                <div className="flex items-center gap-3 mt-4">
                  <Button
                    onClick={() => saveMappingsMutation.mutate()}
                    disabled={saveMappingsMutation.isPending}
                  >
                    {saveMappingsMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    <Save className="h-4 w-4 mr-2" />
                    Save Category Mappings
                  </Button>
                  <Badge variant="outline" className="text-amber-600 border-amber-300">
                    Unsaved changes
                  </Badge>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ================================================================== */}
      {/* SECTION 3: Listing Feed                                            */}
      {/* ================================================================== */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                Listing Feed
              </CardTitle>
              <CardDescription>Products that will be listed on eBay</CardDescription>
            </div>
            <Button variant="outline" size="sm" disabled>
              <Zap className="h-4 w-4 mr-2" />
              Push to eBay
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!config?.connected ? (
            <p className="text-sm text-muted-foreground">Connect to eBay first.</p>
          ) : feedLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading listing feed...
            </div>
          ) : (
            <>
              {/* Filters */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-4">
                <div className="flex gap-1">
                  {(["all", "ready", "missing_config", "listed"] as const).map((f) => (
                    <Button
                      key={f}
                      variant={feedFilter === f ? "default" : "outline"}
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => setFeedFilter(f)}
                    >
                      {f === "all" && `All (${feedCounts.all})`}
                      {f === "ready" && `Ready (${feedCounts.ready})`}
                      {f === "missing_config" && `Missing (${feedCounts.missing_config})`}
                      {f === "listed" && `Listed (${feedCounts.listed})`}
                    </Button>
                  ))}
                </div>
                <div className="relative flex-1 max-w-xs">
                  <Search className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name or SKU..."
                    className="pl-8 h-8 text-sm"
                    value={feedSearch}
                    onChange={(e) => setFeedSearch(e.target.value)}
                  />
                </div>
              </div>

              {/* Feed Table */}
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="w-[100px]">SKU</TableHead>
                      <TableHead className="w-[150px]">Product Type</TableHead>
                      <TableHead className="w-[200px]">eBay Category</TableHead>
                      <TableHead className="w-[120px] text-center">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredFeed.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <span className="font-medium text-sm">{item.name}</span>
                          <div className="flex gap-1.5 mt-0.5">
                            <span className="text-xs text-muted-foreground">
                              {item.variantCount} variant{item.variantCount !== 1 ? "s" : ""}
                            </span>
                            <span className="text-xs text-muted-foreground">·</span>
                            <span className="text-xs text-muted-foreground">
                              {item.imageCount} image{item.imageCount !== 1 ? "s" : ""}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <code className="text-xs bg-muted px-1 py-0.5 rounded">
                            {item.sku || "—"}
                          </code>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {item.productTypeName || item.productType}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {item.ebayBrowseCategoryName ? (
                            <span className="text-xs text-muted-foreground truncate block max-w-[180px]">
                              {item.ebayBrowseCategoryName}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">Not mapped</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          {item.status === "ready" && (
                            <Badge className="bg-green-600 hover:bg-green-600 text-xs">Ready</Badge>
                          )}
                          {item.status === "missing_config" && (
                            <Badge variant="outline" className="text-amber-600 border-amber-300 text-xs">
                              Missing: {item.missingItems.join(", ")}
                            </Badge>
                          )}
                          {item.status === "listed" && (
                            <Badge className="bg-blue-600 hover:bg-blue-600 text-xs">
                              Listed
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {filteredFeed.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                          {feedData?.total === 0
                            ? "No products have product types assigned. Use \"Manage Product Types\" to assign them."
                            : "No products match your filter."}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              {filteredFeed.length > 0 && (
                <p className="text-xs text-muted-foreground mt-2">
                  Showing {filteredFeed.length} of {feedData?.total || 0} products
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Setup Checklist */}
      {config?.connected && (!hasLocation || !hasPolicies) && (
        <Card className="border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/10">
          <CardContent className="py-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-amber-800 dark:text-amber-400">Setup incomplete</p>
                <ul className="mt-1 space-y-1 text-amber-700 dark:text-amber-500">
                  {!hasLocation && <li>• Create a merchant location</li>}
                  {!hasPolicies && <li>• Select default business policies</li>}
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Product Type Manager Dialog */}
      <ProductTypeManager
        open={productTypeManagerOpen}
        onOpenChange={setProductTypeManagerOpen}
      />
    </div>
  );
}
