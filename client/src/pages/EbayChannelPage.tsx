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
import { Switch } from "@/components/ui/switch";
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
  Sparkles,
} from "lucide-react";
import { ProductTypeManager } from "@/components/ebay/ProductTypeManager";
import { EbayCategoryPicker } from "@/components/ebay/EbayCategoryPicker";
import { AspectEditor } from "@/components/ebay/AspectEditor";
import { PushProgressModal } from "@/components/ebay/PushProgressModal";

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
  listingEnabled: boolean;
  aspectsReady: boolean | null;
  missingRequiredCount: number | null;
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

interface StoreCategory {
  id: string;
  name: string;
}

interface FeedVariant {
  id: number;
  sku: string;
  name: string;
  priceCents: number | null;
  ebayListingExcluded: boolean;
  inventoryQuantity: number;
  fulfillmentPolicyOverride: string | null;
  returnPolicyOverride: string | null;
  paymentPolicyOverride: string | null;
}

interface FeedItem {
  id: number;
  name: string;
  sku: string | null;
  productType: string;
  productTypeName: string;
  ebayBrowseCategoryId: string | null;
  ebayBrowseCategoryName: string | null;
  ebayBrowseCategoryOverrideId: string | null;
  ebayBrowseCategoryOverrideName: string | null;
  ebayStoreCategoryName: string | null;
  status: "ready" | "missing_config" | "missing_specifics" | "listed" | "excluded" | "type_disabled" | "ended" | "deleted" | "error";
  missingItems: string[];
  missingAspects: string[];
  isListed: boolean;
  isExcluded: boolean;
  syncError: string | null;
  externalListingId: string | null;
  variantCount: number;
  includedVariantCount: number;
  imageCount: number;
  variants: FeedVariant[];
  fulfillmentPolicyOverride: string | null;
  returnPolicyOverride: string | null;
  paymentPolicyOverride: string | null;
}

interface PricingRule {
  id: number;
  channel_id: number;
  scope: "channel" | "category" | "product" | "variant";
  scope_id: string | null;
  rule_type: "percentage" | "fixed" | "override";
  value: string;
  scope_label: string | null;
  created_at: string;
  updated_at: string;
}

interface EffectivePrices {
  [variantId: number]: { basePriceCents: number; effectivePriceCents: number };
}

// ============================================================================
// Helper: Product Aspect Editor with Type Defaults
// ============================================================================

function ProductAspectEditorWithDefaults({
  categoryId,
  productId,
  productType,
}: {
  categoryId: string;
  productId: number;
  productType: string;
}) {
  const { data: typeDefaultsData } = useQuery<{ defaults: Record<string, string> }>({
    queryKey: ["/api/ebay/type-aspect-defaults", productType],
    enabled: !!productType,
  });

  return (
    <AspectEditor
      categoryId={categoryId}
      mode="product"
      productId={productId}
      typeDefaults={typeDefaultsData?.defaults}
      compact
    />
  );
}

// ============================================================================
// Helper: Policy Override Dropdowns (product or variant level)
// ============================================================================

function PolicyOverrideRow({
  label,
  fulfillmentPolicyId,
  returnPolicyId,
  paymentPolicyId,
  policies,
  onSave,
  isPending,
}: {
  label: string;
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
  policies: PoliciesResponse | undefined;
  onSave: (fp: string | null, rp: string | null, pp: string | null) => void;
  isPending: boolean;
}) {
  const [fp, setFp] = useState(fulfillmentPolicyId || "__default__");
  const [rp, setRp] = useState(returnPolicyId || "__default__");
  const [pp, setPp] = useState(paymentPolicyId || "__default__");
  const [dirty, setDirty] = useState(false);

  // Sync from props
  useEffect(() => {
    setFp(fulfillmentPolicyId || "__default__");
    setRp(returnPolicyId || "__default__");
    setPp(paymentPolicyId || "__default__");
    setDirty(false);
  }, [fulfillmentPolicyId, returnPolicyId, paymentPolicyId]);

  const handleChange = (setter: (v: string) => void) => (val: string) => {
    setter(val);
    setDirty(true);
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <Label className="text-[11px] text-muted-foreground">Fulfillment</Label>
          <Select value={fp} onValueChange={handleChange(setFp)}>
            <SelectTrigger className="min-h-[44px] sm:h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">Use default</SelectItem>
              {(policies?.fulfillmentPolicies || []).map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-[11px] text-muted-foreground">Return</Label>
          <Select value={rp} onValueChange={handleChange(setRp)}>
            <SelectTrigger className="min-h-[44px] sm:h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">Use default</SelectItem>
              {(policies?.returnPolicies || []).map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-[11px] text-muted-foreground">Payment</Label>
          <Select value={pp} onValueChange={handleChange(setPp)}>
            <SelectTrigger className="min-h-[44px] sm:h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">Use default</SelectItem>
              {(policies?.paymentPolicies || []).map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {dirty && (
        <Button
          size="sm"
          className="min-h-[44px] sm:h-7 text-xs"
          disabled={isPending}
          onClick={() => {
            onSave(
              fp === "__default__" ? null : fp,
              rp === "__default__" ? null : rp,
              pp === "__default__" ? null : pp,
            );
            setDirty(false);
          }}
        >
          {isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
          Save Policies
        </Button>
      )}
    </div>
  );
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

  // ---- Pricing rules ----
  const { data: pricingRulesData, isLoading: pricingRulesLoading } = useQuery<{ rules: PricingRule[] }>({
    queryKey: ["/api/ebay/pricing-rules"],
    enabled: !!config?.connected,
  });

  // ---- Effective prices (bulk) ----
  const { data: effectivePricesData } = useQuery<{ prices: EffectivePrices }>({
    queryKey: ["/api/ebay/effective-prices"],
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
  const [expandedSpecifics, setExpandedSpecifics] = useState<Set<string>>(new Set());

  // Browse category search (legacy state — now handled by EbayCategoryPicker)

  // Variant policy expansion
  const [expandedVariantPolicies, setExpandedVariantPolicies] = useState<Set<number>>(new Set());
  const toggleVariantPolicies = (variantId: number) => {
    setExpandedVariantPolicies((prev) => {
      const next = new Set(prev);
      if (next.has(variantId)) next.delete(variantId);
      else next.add(variantId);
      return next;
    });
  };

  // Feed filters
  const [feedFilter, setFeedFilter] = useState<"all" | "ready" | "missing_config" | "missing_specifics" | "listed" | "excluded" | "ended" | "errors">("all");
  const [feedSearch, setFeedSearch] = useState("");
  const [expandedProducts, setExpandedProducts] = useState<Set<number>>(new Set());

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
      // Include any mapping that has category data OR has listing_enabled explicitly set
      const mappingsArray = Array.from(localMappings.values()).filter(
        (m) => m.ebayBrowseCategoryId || m.ebayStoreCategoryId || m.listingEnabled !== undefined
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

  const toggleTypeListingMutation = useMutation({
    mutationFn: async ({ productTypeSlug, listingEnabled }: { productTypeSlug: string; listingEnabled: boolean }) => {
      const resp = await apiRequest("PUT", `/api/ebay/toggle-type-listing/${encodeURIComponent(productTypeSlug)}`, { listingEnabled });
      return resp.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      // Revert local state on error by re-syncing from server
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] });
    },
  });

  // ---- Push to eBay (SSE-based with progress modal) ----
  const [pushModalOpen, setPushModalOpen] = useState(false);
  const [pushProductIds, setPushProductIds] = useState<number[]>([]);

  const handlePushAll = () => {
    const readyProducts = feedData?.feed?.filter((f) => f.status === "ready" || f.status === "error") || [];
    if (readyProducts.length === 0) return;
    const ids = readyProducts.map((f) => f.id);
    setPushProductIds(ids);
    setPushModalOpen(true);
  };

  const handlePushSingle = (productId: number) => {
    setPushProductIds([productId]);
    setPushModalOpen(true);
  };

  const handleRetryFailed = (failedIds: number[]) => {
    setPushProductIds(failedIds);
    setPushModalOpen(true);
  };

  // ---- Sync All Listings ----
  const syncAllMutation = useMutation({
    mutationFn: async () => {
      const resp = await apiRequest("POST", "/api/ebay/listings/sync-all");
      return resp.json();
    },
    onSuccess: (data: any) => {
      const { synced, priceChanges, qtyChanges, policyChanges, errors } = data;
      const changes: string[] = [];
      if (priceChanges > 0) changes.push(`${priceChanges} price update${priceChanges !== 1 ? "s" : ""}`);
      if (qtyChanges > 0) changes.push(`${qtyChanges} quantity update${qtyChanges !== 1 ? "s" : ""}`);
      if (policyChanges > 0) changes.push(`${policyChanges} policy update${policyChanges !== 1 ? "s" : ""}`);
      const changeStr = changes.length > 0 ? `: ${changes.join(", ")}` : "";
      toast({
        title: "Sync Complete",
        description: `Synced ${synced} listing${synced !== 1 ? "s" : ""}${changeStr}${errors > 0 ? ` (${errors} error${errors !== 1 ? "s" : ""})` : ""}`,
        variant: errors > 0 ? "destructive" : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/effective-prices"] });
    },
    onError: (err: Error) => {
      toast({ title: "Sync Failed", description: err.message, variant: "destructive" });
    },
  });

  // ---- Sync Single Product ----
  const [syncingProductIds, setSyncingProductIds] = useState<Set<number>>(new Set());

  const syncProductMutation = useMutation({
    mutationFn: async (productId: number) => {
      const resp = await apiRequest("POST", `/api/ebay/listings/sync-product/${productId}`);
      return resp.json();
    },
    onSuccess: (data: any, productId: number) => {
      setSyncingProductIds((prev) => { const next = new Set(prev); next.delete(productId); return next; });
      const { synced, priceChanges, qtyChanges, errors } = data;
      const changes: string[] = [];
      if (priceChanges > 0) changes.push(`${priceChanges} price`);
      if (qtyChanges > 0) changes.push(`${qtyChanges} qty`);
      const changeStr = changes.length > 0 ? `: ${changes.join(", ")} updated` : "";
      toast({
        title: "Product Synced",
        description: `Synced ${synced} variant${synced !== 1 ? "s" : ""}${changeStr}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/effective-prices"] });
    },
    onError: (err: Error, productId: number) => {
      setSyncingProductIds((prev) => { const next = new Set(prev); next.delete(productId); return next; });
      toast({ title: "Sync Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSyncProduct = (productId: number) => {
    setSyncingProductIds((prev) => new Set([...prev, productId]));
    syncProductMutation.mutate(productId);
  };

  // ---- Verify / Reconcile Listings ----
  const reconcileMutation = useMutation({
    mutationFn: async () => {
      const resp = await apiRequest("POST", "/api/ebay/listings/reconcile");
      return resp.json();
    },
    onSuccess: (data: any) => {
      const { checked, active, ended, deleted, errors } = data;
      const removed = ended + deleted;
      toast({
        title: "Verification Complete",
        description: `Verified ${checked} listing${checked !== 1 ? "s" : ""}: ${active} active${removed > 0 ? `, ${removed} removed from eBay` : ""}${errors > 0 ? `, ${errors} error${errors !== 1 ? "s" : ""}` : ""}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
    },
    onError: (err: Error) => {
      toast({ title: "Verification Failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleExclusionMutation = useMutation({
    mutationFn: async ({ productId, excluded }: { productId: number; excluded: boolean }) => {
      const resp = await apiRequest("PUT", `/api/ebay/product-exclusion/${productId}`, { excluded });
      return resp.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const toggleVariantExclusionMutation = useMutation({
    mutationFn: async ({ variantId, excluded }: { variantId: number; excluded: boolean }) => {
      const resp = await apiRequest("PUT", `/api/ebay/variant-exclusion/${variantId}`, { excluded });
      return resp.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const saveProductPoliciesMutation = useMutation({
    mutationFn: async ({ productId, fulfillmentPolicyId, returnPolicyId, paymentPolicyId }: {
      productId: number; fulfillmentPolicyId: string | null; returnPolicyId: string | null; paymentPolicyId: string | null;
    }) => {
      const resp = await apiRequest("PUT", `/api/ebay/product-policies/${productId}`, { fulfillmentPolicyId, returnPolicyId, paymentPolicyId });
      return resp.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      toast({ title: "Product Policies Updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const saveVariantPoliciesMutation = useMutation({
    mutationFn: async ({ variantId, fulfillmentPolicyId, returnPolicyId, paymentPolicyId }: {
      variantId: number; fulfillmentPolicyId: string | null; returnPolicyId: string | null; paymentPolicyId: string | null;
    }) => {
      const resp = await apiRequest("PUT", `/api/ebay/variant-policies/${variantId}`, { fulfillmentPolicyId, returnPolicyId, paymentPolicyId });
      return resp.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      toast({ title: "Variant Policies Updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const setProductCategoryMutation = useMutation({
    mutationFn: async ({ productId, ebayBrowseCategoryId, ebayBrowseCategoryName }: { productId: number; ebayBrowseCategoryId: string | null; ebayBrowseCategoryName: string | null }) => {
      const resp = await apiRequest("PUT", `/api/ebay/product-category/${productId}`, { ebayBrowseCategoryId, ebayBrowseCategoryName });
      return resp.json();
    },
    onSuccess: () => {
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
    onError: (err: any) => {
      let description = err.message;
      try {
        const body = JSON.parse(err.message);
        if (body.invalidNames) {
          description = `Names too long (max 30 chars): ${body.invalidNames.map((n: any) => `"${n.name}" (${n.length})`).join(", ")}`;
        } else if (body.error) {
          description = body.error;
        }
      } catch {}
      toast({ title: "Store Category Error", description, variant: "destructive" });
    },
  });

  // ---- Pricing rules state ----
  const [pricingRuleForm, setPricingRuleForm] = useState<{
    scope: "channel" | "category" | "product" | "variant";
    scopeId: string;
    ruleType: "percentage" | "fixed" | "override";
    value: string;
  }>({ scope: "channel", scopeId: "", ruleType: "percentage", value: "" });
  const [showPricingForm, setShowPricingForm] = useState(false);
  const [pricingScopeSearch, setPricingScopeSearch] = useState("");

  const upsertPricingRuleMutation = useMutation({
    mutationFn: async (rule: { scope: string; scopeId: string | null; ruleType: string; value: number }) => {
      const resp = await apiRequest("PUT", "/api/ebay/pricing-rules", rule);
      return resp.json();
    },
    onSuccess: () => {
      toast({ title: "Pricing Rule Saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/pricing-rules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/effective-prices"] });
      setShowPricingForm(false);
      setPricingRuleForm({ scope: "channel", scopeId: "", ruleType: "percentage", value: "" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deletePricingRuleMutation = useMutation({
    mutationFn: async (id: number) => {
      const resp = await apiRequest("DELETE", `/api/ebay/pricing-rules/${id}`);
      return resp.json();
    },
    onSuccess: () => {
      toast({ title: "Pricing Rule Deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/pricing-rules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/effective-prices"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // ---- Helpers ----

  const toggleProductExpanded = (productId: number) => {
    setExpandedProducts((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const formatPrice = (cents: number | null) => {
    if (cents == null) return "—";
    return `$${(cents / 100).toFixed(2)}`;
  };

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

  const toggleSpecifics = (slug: string) => {
    setExpandedSpecifics((prev) => {
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
    // Filter out type_disabled products entirely — they're controlled by the category mapping toggle
    let items = feedData.feed.filter((i) => i.status !== "type_disabled");
    if (feedFilter === "excluded") {
      items = items.filter((i) => i.status === "excluded");
    } else if (feedFilter === "missing_specifics") {
      items = items.filter((i) => i.status === "missing_specifics");
    } else if (feedFilter === "ended") {
      items = items.filter((i) => i.status === "ended" || i.status === "deleted");
    } else if (feedFilter === "errors") {
      items = items.filter((i) => i.status === "error");
    } else if (feedFilter !== "all") {
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
    if (!feedData?.feed) return { all: 0, ready: 0, missing_config: 0, missing_specifics: 0, listed: 0, excluded: 0, ended: 0, errors: 0 };
    // Exclude type_disabled from all counts
    const feed = feedData.feed.filter((f) => f.status !== "type_disabled");
    return {
      all: feed.length,
      ready: feed.filter((f) => f.status === "ready").length,
      missing_config: feed.filter((f) => f.status === "missing_config").length,
      missing_specifics: feed.filter((f) => f.status === "missing_specifics").length,
      listed: feed.filter((f) => f.status === "listed").length,
      excluded: feed.filter((f) => f.status === "excluded").length,
      ended: feed.filter((f) => f.status === "ended" || f.status === "deleted").length,
      errors: feed.filter((f) => f.status === "error").length,
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
    <div className="p-2 sm:p-4 md:p-6 space-y-4 sm:space-y-6 max-w-6xl mx-auto">
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
        <CardHeader className="px-3 sm:px-6">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Store Setup
          </CardTitle>
          <CardDescription>Connection, location, and default business policies</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 px-3 sm:px-6">
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
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
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
        <CardHeader className="px-3 sm:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Layers className="h-5 w-5" />
                Category Mapping
              </CardTitle>
              <CardDescription>Map your product types to eBay categories</CardDescription>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto min-h-[44px] sm:min-h-0"
                onClick={() => setProductTypeManagerOpen(true)}
              >
                <Tag className="h-4 w-4 mr-2" />
                Manage Product Types
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto min-h-[44px] sm:min-h-0"
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
        <CardContent className="px-3 sm:px-6">
          {!config?.connected ? (
            <p className="text-sm text-muted-foreground">Connect to eBay first.</p>
          ) : (
            <>
              {/* Desktop table view */}
              <div className="hidden sm:block border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[200px]">Product Type</TableHead>
                      <TableHead>eBay Browse Category</TableHead>
                      <TableHead className="w-[200px]">eBay Store Category</TableHead>
                      <TableHead className="w-[120px] text-center">Specifics</TableHead>
                      <TableHead className="w-[80px] text-center">Policies</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(config?.productTypes || []).map((pt) => {
                      const mapping = localMappings.get(pt.slug) || {} as Partial<CategoryMapping>;
                      const isOverrideExpanded = expandedOverrides.has(pt.slug);
                      const isSpecificsExpanded = expandedSpecifics.has(pt.slug);
                      const hasBrowseCategory = !!mapping.ebayBrowseCategoryId;
                      const serverMapping = config?.categoryMappings?.find((m) => m.productTypeSlug === pt.slug);
                      const aspectsReady = serverMapping?.aspectsReady ?? null;
                      const missingRequiredCount = serverMapping?.missingRequiredCount ?? null;

                      return (
                        <React.Fragment key={pt.slug}>
                            <TableRow className="group">
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  <Switch
                                    checked={mapping.listingEnabled !== false}
                                    onCheckedChange={(checked) => {
                                      setLocalMappings((prev) => {
                                        const next = new Map(prev);
                                        const existing = next.get(pt.slug) || { productTypeSlug: pt.slug } as CategoryMapping;
                                        next.set(pt.slug, { ...existing, listingEnabled: checked });
                                        return next;
                                      });
                                      toggleTypeListingMutation.mutate({ productTypeSlug: pt.slug, listingEnabled: checked });
                                    }}
                                    className="scale-75"
                                  />
                                  <div>
                                    <span className={`font-medium text-sm ${mapping.listingEnabled === false ? 'text-muted-foreground line-through' : ''}`}>{pt.name}</span>
                                    <span className="text-xs text-muted-foreground ml-2">
                                      ({pt.product_count} product{pt.product_count !== 1 ? "s" : ""})
                                    </span>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell>
                                <EbayCategoryPicker
                                  currentCategoryId={mapping.ebayBrowseCategoryId || null}
                                  currentCategoryName={mapping.ebayBrowseCategoryName || null}
                                  onSelect={(categoryId, categoryName) => {
                                    updateMapping(pt.slug, {
                                      ebayBrowseCategoryId: categoryId,
                                      ebayBrowseCategoryName: categoryName,
                                    });
                                  }}
                                />
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
                                {hasBrowseCategory ? (
                                  <button
                                    onClick={() => toggleSpecifics(pt.slug)}
                                    className="inline-flex items-center"
                                  >
                                    {aspectsReady === true ? (
                                      <Badge className="bg-green-600 hover:bg-green-700 text-xs gap-1 cursor-pointer">
                                        <CheckCircle2 className="h-3 w-3" />
                                        Specifics ✓
                                      </Badge>
                                    ) : aspectsReady === false && missingRequiredCount != null ? (
                                      <Badge variant="outline" className="text-amber-600 border-amber-300 hover:bg-amber-50 text-xs gap-1 cursor-pointer">
                                        <AlertCircle className="h-3 w-3" />
                                        {missingRequiredCount} required
                                      </Badge>
                                    ) : (
                                      <Badge variant="outline" className="text-muted-foreground text-xs gap-1 cursor-pointer">
                                        <Sparkles className="h-3 w-3" />
                                        Set specifics
                                      </Badge>
                                    )}
                                  </button>
                                ) : (
                                  <span className="text-xs text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell className="text-center">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs gap-1"
                                  onClick={() => toggleOverride(pt.slug)}
                                >
                                  <Settings2 className="h-3.5 w-3.5" />
                                  {isOverrideExpanded ? (
                                    <ChevronDown className="h-3.5 w-3.5" />
                                  ) : (
                                    <ChevronRight className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                              </TableCell>
                            </TableRow>
                            {isSpecificsExpanded && hasBrowseCategory && (
                              <TableRow className="bg-amber-50/50 dark:bg-amber-950/10">
                                <TableCell colSpan={5}>
                                  <div className="py-3 px-4">
                                    <AspectEditor
                                      categoryId={mapping.ebayBrowseCategoryId!}
                                      mode="type"
                                      productTypeSlug={pt.slug}
                                      compact
                                    />
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                            {isOverrideExpanded && (
                              <TableRow className="bg-muted/30">
                                <TableCell colSpan={5}>
                                  <div className="py-2 px-4 space-y-4">
                                    <div>
                                      <p className="text-xs text-muted-foreground mb-2 font-medium">
                                        Policy overrides for {pt.name} (leave blank to use store defaults)
                                      </p>
                                      <div className="grid grid-cols-3 gap-3">
                                        <div>
                                          <Label className="text-xs">Shipping Override</Label>
                                          <Select
                                            value={mapping.fulfillmentPolicyOverride || "__default__"}
                                            onValueChange={(v) =>
                                              updateMapping(pt.slug, { fulfillmentPolicyOverride: v === "__default__" ? null : v })
                                            }
                                          >
                                            <SelectTrigger className="mt-1 h-8 text-xs">
                                              <SelectValue placeholder="Use default" />
                                            </SelectTrigger>
                                            <SelectContent>
                                              <SelectItem value="__default__" className="text-xs">Use default</SelectItem>
                                              {(policies?.fulfillmentPolicies || []).map((p) => (
                                                <SelectItem key={p.id} value={p.id} className="text-xs">{p.name}</SelectItem>
                                              ))}
                                            </SelectContent>
                                          </Select>
                                        </div>
                                        <div>
                                          <Label className="text-xs">Returns Override</Label>
                                          <Select
                                            value={mapping.returnPolicyOverride || "__default__"}
                                            onValueChange={(v) =>
                                              updateMapping(pt.slug, { returnPolicyOverride: v === "__default__" ? null : v })
                                            }
                                          >
                                            <SelectTrigger className="mt-1 h-8 text-xs">
                                              <SelectValue placeholder="Use default" />
                                            </SelectTrigger>
                                            <SelectContent>
                                              <SelectItem value="__default__" className="text-xs">Use default</SelectItem>
                                              {(policies?.returnPolicies || []).map((p) => (
                                                <SelectItem key={p.id} value={p.id} className="text-xs">{p.name}</SelectItem>
                                              ))}
                                            </SelectContent>
                                          </Select>
                                        </div>
                                        <div>
                                          <Label className="text-xs">Payment Override</Label>
                                          <Select
                                            value={mapping.paymentPolicyOverride || "__default__"}
                                            onValueChange={(v) =>
                                              updateMapping(pt.slug, { paymentPolicyOverride: v === "__default__" ? null : v })
                                            }
                                          >
                                            <SelectTrigger className="mt-1 h-8 text-xs">
                                              <SelectValue placeholder="Use default" />
                                            </SelectTrigger>
                                            <SelectContent>
                                              <SelectItem value="__default__" className="text-xs">Use default</SelectItem>
                                              {(policies?.paymentPolicies || []).map((p) => (
                                                <SelectItem key={p.id} value={p.id} className="text-xs">{p.name}</SelectItem>
                                              ))}
                                            </SelectContent>
                                          </Select>
                                        </div>
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
                        <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                          No product types defined. Use "Manage Product Types" to create and assign them.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile card view */}
              <div className="sm:hidden space-y-3">
                {(config?.productTypes || []).map((pt) => {
                  const mapping = localMappings.get(pt.slug) || {} as Partial<CategoryMapping>;
                  const isOverrideExpanded = expandedOverrides.has(pt.slug);
                  const isSpecificsExpanded = expandedSpecifics.has(pt.slug);
                  const hasBrowseCategory = !!mapping.ebayBrowseCategoryId;
                  const serverMapping = config?.categoryMappings?.find((m) => m.productTypeSlug === pt.slug);
                  const aspectsReady = serverMapping?.aspectsReady ?? null;
                  const missingRequiredCount = serverMapping?.missingRequiredCount ?? null;

                  return (
                    <div key={pt.slug} className="border rounded-lg p-3 space-y-3">
                      {/* Row 1: Toggle + Name + Count */}
                      <div className="flex items-center gap-2 min-h-[44px]">
                        <Switch
                          checked={mapping.listingEnabled !== false}
                          onCheckedChange={(checked) => {
                            setLocalMappings((prev) => {
                              const next = new Map(prev);
                              const existing = next.get(pt.slug) || { productTypeSlug: pt.slug } as CategoryMapping;
                              next.set(pt.slug, { ...existing, listingEnabled: checked });
                              return next;
                            });
                            toggleTypeListingMutation.mutate({ productTypeSlug: pt.slug, listingEnabled: checked });
                          }}
                        />
                        <span className={`font-medium text-sm flex-1 ${mapping.listingEnabled === false ? 'text-muted-foreground line-through' : ''}`}>
                          {pt.name}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {pt.product_count} product{pt.product_count !== 1 ? "s" : ""}
                        </span>
                      </div>

                      {/* Row 2: Browse category picker */}
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1 block">Browse Category</Label>
                        <EbayCategoryPicker
                          currentCategoryId={mapping.ebayBrowseCategoryId || null}
                          currentCategoryName={mapping.ebayBrowseCategoryName || null}
                          onSelect={(categoryId, categoryName) => {
                            updateMapping(pt.slug, {
                              ebayBrowseCategoryId: categoryId,
                              ebayBrowseCategoryName: categoryName,
                            });
                          }}
                        />
                      </div>

                      {/* Row 3: Store category dropdown */}
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1 block">Store Category</Label>
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
                          <SelectTrigger className="w-full min-h-[44px] text-sm">
                            <SelectValue placeholder="Select store category..." />
                          </SelectTrigger>
                          <SelectContent>
                            {storeCats.map((cat) => (
                              <SelectItem key={cat.id} value={cat.id} className="text-sm">
                                {cat.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Row 4: Specifics badge + Policy Overrides button */}
                      <div className="flex items-center gap-2 flex-wrap">
                        {hasBrowseCategory ? (
                          <button
                            onClick={() => toggleSpecifics(pt.slug)}
                            className="inline-flex items-center min-h-[44px]"
                          >
                            {aspectsReady === true ? (
                              <Badge className="bg-green-600 hover:bg-green-700 text-xs gap-1 cursor-pointer py-1.5 px-3">
                                <CheckCircle2 className="h-3 w-3" />
                                Specifics ✓
                              </Badge>
                            ) : aspectsReady === false && missingRequiredCount != null ? (
                              <Badge variant="outline" className="text-amber-600 border-amber-300 hover:bg-amber-50 text-xs gap-1 cursor-pointer py-1.5 px-3">
                                <AlertCircle className="h-3 w-3" />
                                {missingRequiredCount} required
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-muted-foreground text-xs gap-1 cursor-pointer py-1.5 px-3">
                                <Sparkles className="h-3 w-3" />
                                Set specifics
                              </Badge>
                            )}
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">No category set</span>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-[44px] px-3 text-xs gap-1 ml-auto"
                          onClick={() => toggleOverride(pt.slug)}
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                          Policy Overrides
                          {isOverrideExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>

                      {/* Specifics expansion */}
                      {isSpecificsExpanded && hasBrowseCategory && (
                        <div className="border-t pt-3 bg-amber-50/50 dark:bg-amber-950/10 -mx-3 px-3 pb-3">
                          <AspectEditor
                            categoryId={mapping.ebayBrowseCategoryId!}
                            mode="type"
                            productTypeSlug={pt.slug}
                            compact
                          />
                        </div>
                      )}

                      {/* Policy overrides expansion */}
                      {isOverrideExpanded && (
                        <div className="border-t pt-3 space-y-3">
                          <p className="text-xs text-muted-foreground font-medium">
                            Policy overrides (leave blank for store defaults)
                          </p>
                          <div>
                            <Label className="text-xs">Shipping Override</Label>
                            <Select
                              value={mapping.fulfillmentPolicyOverride || "__default__"}
                              onValueChange={(v) =>
                                updateMapping(pt.slug, { fulfillmentPolicyOverride: v === "__default__" ? null : v })
                              }
                            >
                              <SelectTrigger className="mt-1 min-h-[44px] text-sm">
                                <SelectValue placeholder="Use default" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__default__">Use default</SelectItem>
                                {(policies?.fulfillmentPolicies || []).map((p) => (
                                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-xs">Returns Override</Label>
                            <Select
                              value={mapping.returnPolicyOverride || "__default__"}
                              onValueChange={(v) =>
                                updateMapping(pt.slug, { returnPolicyOverride: v === "__default__" ? null : v })
                              }
                            >
                              <SelectTrigger className="mt-1 min-h-[44px] text-sm">
                                <SelectValue placeholder="Use default" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__default__">Use default</SelectItem>
                                {(policies?.returnPolicies || []).map((p) => (
                                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-xs">Payment Override</Label>
                            <Select
                              value={mapping.paymentPolicyOverride || "__default__"}
                              onValueChange={(v) =>
                                updateMapping(pt.slug, { paymentPolicyOverride: v === "__default__" ? null : v })
                              }
                            >
                              <SelectTrigger className="mt-1 min-h-[44px] text-sm">
                                <SelectValue placeholder="Use default" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__default__">Use default</SelectItem>
                                {(policies?.paymentPolicies || []).map((p) => (
                                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {(!config?.productTypes || config.productTypes.length === 0) && (
                  <p className="text-center text-sm text-muted-foreground py-8">
                    No product types defined. Use "Manage Product Types" to create and assign them.
                  </p>
                )}
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
        <CardHeader className="px-3 sm:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                Listing Feed
              </CardTitle>
              <CardDescription>Products that will be listed on eBay</CardDescription>
            </div>
            <div className="flex gap-2 w-full sm:w-auto flex-wrap">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 sm:flex-none min-h-[44px] sm:min-h-0"
                disabled={feedCounts.listed === 0 || syncAllMutation.isPending}
                onClick={() => syncAllMutation.mutate()}
              >
                {syncAllMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Sync All ({feedCounts.listed})
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 sm:flex-none min-h-[44px] sm:min-h-0"
                disabled={feedCounts.listed === 0 || reconcileMutation.isPending}
                onClick={() => reconcileMutation.mutate()}
              >
                {reconcileMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4 mr-2" />
                )}
                Verify ({feedCounts.listed})
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 sm:flex-none min-h-[44px] sm:min-h-0"
                disabled={feedCounts.ready === 0 && feedCounts.errors === 0}
                onClick={handlePushAll}
              >
                <Zap className="h-4 w-4 mr-2" />
                Push to eBay ({feedCounts.ready + feedCounts.errors})
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
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
              <div className="flex flex-col gap-3 mb-4">
                <div className="grid grid-cols-3 sm:flex sm:flex-wrap gap-1.5 sm:gap-1">
                  {(["all", "ready", "missing_config", "missing_specifics", "listed", "errors", "ended", "excluded"] as const).map((f) => (
                    <Button
                      key={f}
                      variant={feedFilter === f ? "default" : "outline"}
                      size="sm"
                      className={`text-xs min-h-[44px] sm:min-h-0 sm:h-7 px-2 ${f === "errors" && feedCounts.errors > 0 ? "border-red-300 text-red-600" : ""}`}
                      onClick={() => setFeedFilter(f)}
                    >
                      {f === "all" && `All (${feedCounts.all})`}
                      {f === "ready" && `Ready (${feedCounts.ready})`}
                      {f === "missing_config" && `Missing (${feedCounts.missing_config})`}
                      {f === "missing_specifics" && `Specifics (${feedCounts.missing_specifics})`}
                      {f === "listed" && `Listed (${feedCounts.listed})`}
                      {f === "errors" && `Errors (${feedCounts.errors})`}
                      {f === "ended" && `Ended (${feedCounts.ended})`}
                      {f === "excluded" && `Excluded (${feedCounts.excluded})`}
                    </Button>
                  ))}
                </div>
                <div className="relative w-full sm:max-w-xs">
                  <Search className="absolute left-3 top-3 sm:top-2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name or SKU..."
                    className="pl-9 min-h-[44px] sm:h-8 text-sm"
                    value={feedSearch}
                    onChange={(e) => setFeedSearch(e.target.value)}
                  />
                </div>
              </div>

              {/* Feed Table — Mobile-first: card layout on mobile, table on sm+ */}
              <div className="border rounded-lg overflow-x-hidden">
                {/* Desktop table header — hidden on mobile */}
                <Table>
                  <TableHeader className="hidden sm:table-header-group">
                    <TableRow>
                      <TableHead className="w-[40px]"></TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="w-[100px]">SKU</TableHead>
                      <TableHead className="w-[130px]">Type</TableHead>
                      <TableHead className="w-[180px]">eBay Category</TableHead>
                      <TableHead className="w-[120px] text-center">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredFeed.map((item) => {
                      const isExcluded = item.status === "excluded";
                      const isExpanded = expandedProducts.has(item.id);
                      const hasVariants = item.variants && item.variants.length > 0;
                      const allIncluded = item.includedVariantCount === item.variantCount;
                      const someExcluded = item.includedVariantCount < item.variantCount && item.includedVariantCount > 0;

                      return (
                        <React.Fragment key={item.id}>
                        <TableRow
                          className={`sm:table-row flex flex-col p-3 sm:p-0 gap-2 sm:gap-0 ${isExcluded ? "opacity-50" : ""} cursor-pointer hover:bg-muted/50`}
                          onClick={() => hasVariants && toggleProductExpanded(item.id)}
                        >
                          {/* Expand chevron + Exclude toggle */}
                          <TableCell className="sm:table-cell flex items-center sm:w-[40px] py-0 sm:py-2">
                            <div className="flex items-center gap-2 min-h-[44px] sm:min-h-0" onClick={(e) => e.stopPropagation()}>
                              <button
                                className="p-1 hover:bg-muted rounded min-w-[28px] min-h-[28px] flex items-center justify-center"
                                onClick={() => hasVariants && toggleProductExpanded(item.id)}
                              >
                                {hasVariants ? (
                                  isExpanded ? (
                                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                  )
                                ) : (
                                  <span className="inline-block w-4" />
                                )}
                              </button>
                              <Switch
                                checked={!isExcluded}
                                onCheckedChange={(checked) =>
                                  toggleExclusionMutation.mutate({ productId: item.id, excluded: !checked })
                                }
                                title={isExcluded ? "Include in eBay listings" : "Exclude from eBay listings"}
                              />
                              <span className="text-xs text-muted-foreground sm:hidden">
                                {isExcluded ? "Excluded" : "Included"}
                              </span>
                            </div>
                          </TableCell>
                          {/* Product name */}
                          <TableCell className="sm:table-cell block py-0 sm:py-2">
                            <span className={`font-medium text-sm ${isExcluded ? "line-through text-muted-foreground" : ""}`}>
                              {item.name}
                            </span>
                            <div className="flex flex-wrap gap-1.5 mt-0.5">
                              {/* Variant count with inclusion info */}
                              {allIncluded ? (
                                <span className="text-xs text-muted-foreground">
                                  {item.variantCount} variant{item.variantCount !== 1 ? "s" : ""}
                                </span>
                              ) : someExcluded ? (
                                <span className="text-xs text-amber-600 font-medium">
                                  {item.includedVariantCount} of {item.variantCount} variants
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {item.variantCount} variant{item.variantCount !== 1 ? "s" : ""}
                                </span>
                              )}
                              <span className="text-xs text-muted-foreground">·</span>
                              <span className="text-xs text-muted-foreground">
                                {item.imageCount} image{item.imageCount !== 1 ? "s" : ""}
                              </span>
                              {item.sku && (
                                <>
                                  <span className="text-xs text-muted-foreground sm:hidden">·</span>
                                  <code className="text-xs bg-muted px-1 py-0.5 rounded sm:hidden">
                                    {item.sku}
                                  </code>
                                </>
                              )}
                            </div>
                            {/* Mobile-only: type + status row */}
                            <div className="flex items-center gap-2 mt-1.5 sm:hidden flex-wrap">
                              <Badge variant="outline" className="text-xs">
                                {item.productTypeName || item.productType}
                              </Badge>
                              {item.status === "ready" && (
                                <>
                                  <Badge className="bg-green-600 hover:bg-green-600 text-xs py-1 px-2">Ready</Badge>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="min-h-[44px] min-w-[44px] px-3 text-xs"
                                    onClick={(e) => { e.stopPropagation(); handlePushSingle(item.id); }}
                                  >
                                    <Zap className="h-4 w-4 mr-1" />
                                    Push
                                  </Button>
                                </>
                              )}
                              {item.status === "error" && (
                                <>
                                  <Badge variant="destructive" className="text-xs py-1 px-2">Error</Badge>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="min-h-[44px] min-w-[44px] px-3 text-xs"
                                    onClick={(e) => { e.stopPropagation(); handlePushSingle(item.id); }}
                                  >
                                    <RefreshCw className="h-4 w-4 mr-1" />
                                    Retry
                                  </Button>
                                </>
                              )}
                              {item.status === "missing_config" && (
                                <Badge variant="outline" className="text-amber-600 border-amber-300 text-xs">
                                  Missing: {item.missingItems.join(", ")}
                                </Badge>
                              )}
                              {item.status === "missing_specifics" && (
                                <Badge variant="outline" className="text-orange-600 border-orange-300 text-xs">
                                  Specifics: {item.missingAspects?.slice(0, 3).join(", ")}{item.missingAspects?.length > 3 ? ` +${item.missingAspects.length - 3}` : ""}
                                </Badge>
                              )}
                              {item.status === "listed" && (
                                <>
                                  <Badge className="bg-blue-600 hover:bg-blue-600 text-xs">Listed</Badge>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="min-h-[44px] min-w-[44px] px-3 text-xs"
                                    disabled={syncingProductIds.has(item.id)}
                                    onClick={(e) => { e.stopPropagation(); handleSyncProduct(item.id); }}
                                    title="Sync this listing"
                                  >
                                    {syncingProductIds.has(item.id) ? (
                                      <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                      <RefreshCw className="h-4 w-4" />
                                    )}
                                  </Button>
                                </>
                              )}
                              {(item.status === "ended" || item.status === "deleted") && (
                                <Badge variant="outline" className="text-red-600 border-red-300 text-xs">
                                  {item.status === "deleted" ? "Deleted" : "Ended"}
                                </Badge>
                              )}
                              {item.status === "excluded" && (
                                <Badge variant="outline" className="text-muted-foreground text-xs">Excluded</Badge>
                              )}
                            </div>
                            {/* Error message inline on mobile */}
                            {item.syncError && (item.status === "error") && (
                              <p className="text-xs text-red-600 mt-1 sm:hidden line-clamp-2" title={item.syncError}>
                                {item.syncError}
                              </p>
                            )}
                          </TableCell>
                          {/* SKU — desktop only */}
                          <TableCell className="hidden sm:table-cell">
                            <code className="text-xs bg-muted px-1 py-0.5 rounded">
                              {item.sku || "—"}
                            </code>
                          </TableCell>
                          {/* Product Type — desktop only */}
                          <TableCell className="hidden sm:table-cell">
                            <Badge variant="outline" className="text-xs">
                              {item.productTypeName || item.productType}
                            </Badge>
                          </TableCell>
                          {/* eBay Category — desktop only */}
                          <TableCell className="hidden sm:table-cell" onClick={(e) => e.stopPropagation()}>
                            <EbayCategoryPicker
                              currentCategoryId={item.ebayBrowseCategoryId || null}
                              currentCategoryName={item.ebayBrowseCategoryName || null}
                              onSelect={(categoryId, categoryName) => {
                                setProductCategoryMutation.mutate({
                                  productId: item.id,
                                  ebayBrowseCategoryId: categoryId,
                                  ebayBrowseCategoryName: categoryName,
                                });
                              }}
                            />
                            {item.ebayBrowseCategoryOverrideId && (
                              <span className="text-[10px] text-blue-500 mt-0.5 block">Override</span>
                            )}
                          </TableCell>
                          {/* Status — desktop only */}
                          <TableCell className="hidden sm:table-cell text-center">
                            <div className="flex flex-col items-center gap-1">
                              <div className="flex items-center justify-center gap-1.5 flex-wrap">
                                {item.status === "ready" && (
                                  <>
                                    <Badge className="bg-green-600 hover:bg-green-600 text-xs">Ready</Badge>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 w-6 p-0"
                                      onClick={(e) => { e.stopPropagation(); handlePushSingle(item.id); }}
                                      title="Push to eBay"
                                    >
                                      <Zap className="h-3.5 w-3.5" />
                                    </Button>
                                  </>
                                )}
                                {item.status === "error" && (
                                  <>
                                    <Badge variant="destructive" className="text-xs" title={item.syncError || undefined}>Error</Badge>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 w-6 p-0"
                                      onClick={(e) => { e.stopPropagation(); handlePushSingle(item.id); }}
                                      title="Retry push"
                                    >
                                      <RefreshCw className="h-3.5 w-3.5" />
                                    </Button>
                                  </>
                                )}
                                {item.status === "missing_config" && (
                                  <Badge variant="outline" className="text-amber-600 border-amber-300 text-xs">
                                    Missing: {item.missingItems.join(", ")}
                                  </Badge>
                                )}
                                {item.status === "missing_specifics" && (
                                  <Badge variant="outline" className="text-orange-600 border-orange-300 text-xs" title={item.missingAspects?.join(", ")}>
                                    Specifics: {item.missingAspects?.slice(0, 2).join(", ")}{item.missingAspects?.length > 2 ? ` +${item.missingAspects.length - 2}` : ""}
                                  </Badge>
                                )}
                                {item.status === "listed" && (
                                  <>
                                    <Badge className="bg-blue-600 hover:bg-blue-600 text-xs">Listed</Badge>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 w-6 p-0"
                                      disabled={syncingProductIds.has(item.id)}
                                      onClick={(e) => { e.stopPropagation(); handleSyncProduct(item.id); }}
                                      title="Sync this listing"
                                    >
                                      {syncingProductIds.has(item.id) ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                      ) : (
                                        <RefreshCw className="h-3.5 w-3.5" />
                                      )}
                                    </Button>
                                    {item.externalListingId && (
                                      <a
                                        href={`https://www.ebay.com/itm/${item.externalListingId}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-blue-500 hover:text-blue-700"
                                        title="View on eBay"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <ExternalLink className="h-3.5 w-3.5" />
                                      </a>
                                    )}
                                  </>
                                )}
                                {(item.status === "ended" || item.status === "deleted") && (
                                  <Badge variant="outline" className="text-red-600 border-red-300 text-xs">
                                    {item.status === "deleted" ? "Deleted" : "Ended"}
                                  </Badge>
                                )}
                                {item.status === "excluded" && (
                                  <Badge variant="outline" className="text-muted-foreground text-xs">Excluded</Badge>
                                )}
                              </div>
                              {/* Error message inline — desktop */}
                              {item.syncError && item.status === "error" && (
                                <p className="text-[10px] text-red-600 max-w-[180px] truncate" title={item.syncError}>
                                  {item.syncError}
                                </p>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        {/* Expanded variant rows */}
                        {isExpanded && hasVariants && item.variants.map((variant) => (
                          <React.Fragment key={`v-${variant.id}`}>
                          <TableRow
                            className={`bg-muted/20 sm:table-row flex flex-col p-3 sm:p-0 gap-1 sm:gap-0 ${variant.ebayListingExcluded ? "opacity-50" : ""}`}
                          >
                            <TableCell className="sm:table-cell flex items-center sm:w-[40px] py-0 sm:py-1.5 pl-8 sm:pl-10">
                              <Switch
                                checked={!variant.ebayListingExcluded}
                                onCheckedChange={(checked) =>
                                  toggleVariantExclusionMutation.mutate({ variantId: variant.id, excluded: !checked })
                                }
                                className="scale-[0.65]"
                                title={variant.ebayListingExcluded ? "Include variant" : "Exclude variant"}
                              />
                            </TableCell>
                            <TableCell className="sm:table-cell block py-0 sm:py-1.5" colSpan={2}>
                              <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
                                <span className={`text-xs font-medium ${variant.ebayListingExcluded ? "line-through text-muted-foreground" : ""}`}>
                                  {variant.name}
                                </span>
                                <code className="text-[11px] bg-muted px-1 py-0.5 rounded text-muted-foreground">
                                  {variant.sku}
                                </code>
                              </div>
                            </TableCell>
                            {/* Price — desktop (base → eBay) */}
                            <TableCell className="hidden sm:table-cell py-1.5">
                              {(() => {
                                const ep = effectivePricesData?.prices?.[variant.id];
                                if (ep && ep.effectivePriceCents !== ep.basePriceCents) {
                                  const pctDiff = ((ep.effectivePriceCents - ep.basePriceCents) / ep.basePriceCents * 100).toFixed(0);
                                  return (
                                    <span className="text-xs">
                                      <span className="text-muted-foreground line-through mr-1">{formatPrice(ep.basePriceCents)}</span>
                                      <span className="font-medium text-blue-600">{formatPrice(ep.effectivePriceCents)}</span>
                                      <span className="text-muted-foreground ml-1">(+{pctDiff}%)</span>
                                    </span>
                                  );
                                }
                                return <span className="text-xs">{formatPrice(variant.priceCents)}</span>;
                              })()}
                            </TableCell>
                            {/* Qty — desktop */}
                            <TableCell className="hidden sm:table-cell py-1.5">
                              <span className="text-xs">{variant.inventoryQuantity} qty</span>
                            </TableCell>
                            {/* Policy toggle — desktop */}
                            <TableCell className="hidden sm:table-cell py-1.5">
                              <button
                                className={`p-1 rounded hover:bg-muted min-w-[28px] min-h-[28px] flex items-center justify-center ${
                                  (variant.fulfillmentPolicyOverride || variant.returnPolicyOverride || variant.paymentPolicyOverride)
                                    ? "text-blue-500" : "text-muted-foreground"
                                }`}
                                onClick={(e) => { e.stopPropagation(); toggleVariantPolicies(variant.id); }}
                                title="Policy overrides"
                              >
                                <Settings2 className="h-3.5 w-3.5" />
                              </button>
                            </TableCell>
                            {/* Mobile: price + qty + policy toggle inline */}
                            <TableCell className="sm:hidden block py-0">
                              <div className="flex items-center gap-3 text-xs text-muted-foreground pl-1">
                                {(() => {
                                  const ep = effectivePricesData?.prices?.[variant.id];
                                  if (ep && ep.effectivePriceCents !== ep.basePriceCents) {
                                    return (
                                      <>
                                        <span className="line-through">{formatPrice(ep.basePriceCents)}</span>
                                        <span className="text-blue-600 font-medium">{formatPrice(ep.effectivePriceCents)}</span>
                                      </>
                                    );
                                  }
                                  return <span>{formatPrice(variant.priceCents)}</span>;
                                })()}
                                <span>·</span>
                                <span>{variant.inventoryQuantity} qty</span>
                                <button
                                  className={`p-1 rounded hover:bg-muted min-w-[44px] min-h-[44px] flex items-center justify-center ${
                                    (variant.fulfillmentPolicyOverride || variant.returnPolicyOverride || variant.paymentPolicyOverride)
                                      ? "text-blue-500" : "text-muted-foreground"
                                  }`}
                                  onClick={(e) => { e.stopPropagation(); toggleVariantPolicies(variant.id); }}
                                  title="Policy overrides"
                                >
                                  <Settings2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </TableCell>
                          </TableRow>
                          {/* Variant policy overrides (expanded) */}
                          {expandedVariantPolicies.has(variant.id) && (
                            <TableRow className="bg-muted/5" onClick={(e) => e.stopPropagation()}>
                              <TableCell colSpan={6} className="px-8 sm:px-12 py-2">
                                <PolicyOverrideRow
                                  label={`Variant Policy Overrides — ${variant.sku}`}
                                  fulfillmentPolicyId={variant.fulfillmentPolicyOverride}
                                  returnPolicyId={variant.returnPolicyOverride}
                                  paymentPolicyId={variant.paymentPolicyOverride}
                                  policies={policies}
                                  isPending={saveVariantPoliciesMutation.isPending}
                                  onSave={(fp, rp, pp) => saveVariantPoliciesMutation.mutate({
                                    variantId: variant.id,
                                    fulfillmentPolicyId: fp,
                                    returnPolicyId: rp,
                                    paymentPolicyId: pp,
                                  })}
                                />
                              </TableCell>
                            </TableRow>
                          )}
                          </React.Fragment>
                        ))}
                        {/* Expanded: Item Specifics per-product overrides */}
                        {isExpanded && item.ebayBrowseCategoryId && (
                          <TableRow className="bg-muted/10" onClick={(e) => e.stopPropagation()}>
                            <TableCell colSpan={6} className="px-4 sm:px-8 py-3">
                              <ProductAspectEditorWithDefaults
                                categoryId={item.ebayBrowseCategoryId}
                                productId={item.id}
                                productType={item.productType}
                              />
                            </TableCell>
                          </TableRow>
                        )}
                        {/* Expanded: Product-level policy overrides */}
                        {isExpanded && (
                          <TableRow className="bg-muted/10" onClick={(e) => e.stopPropagation()}>
                            <TableCell colSpan={6} className="px-4 sm:px-8 py-3">
                              <PolicyOverrideRow
                                label="Product Policy Overrides"
                                fulfillmentPolicyId={item.fulfillmentPolicyOverride}
                                returnPolicyId={item.returnPolicyOverride}
                                paymentPolicyId={item.paymentPolicyOverride}
                                policies={policies}
                                isPending={saveProductPoliciesMutation.isPending}
                                onSave={(fp, rp, pp) => saveProductPoliciesMutation.mutate({
                                  productId: item.id,
                                  fulfillmentPolicyId: fp,
                                  returnPolicyId: rp,
                                  paymentPolicyId: pp,
                                })}
                              />
                            </TableCell>
                          </TableRow>
                        )}
                        </React.Fragment>
                      );
                    })}
                    {filteredFeed.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
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
                  Showing {filteredFeed.length} of {feedCounts.all} products
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ================================================================== */}
      {/* SECTION 4: Pricing Rules                                          */}
      {/* ================================================================== */}
      {config?.connected && (
        <Card>
          <CardHeader className="px-3 sm:px-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Tag className="h-5 w-5" />
                  Pricing Rules
                </CardTitle>
                <CardDescription>Set markup rules for eBay listings. Most specific rule wins (variant &gt; product &gt; category &gt; channel).</CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto min-h-[44px] sm:min-h-0"
                onClick={() => setShowPricingForm(!showPricingForm)}
              >
                {showPricingForm ? "Cancel" : "Add Rule"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="px-3 sm:px-6">
            {/* Add/edit form */}
            {showPricingForm && (
              <div className="border rounded-lg p-3 sm:p-4 mb-4 bg-muted/30 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  {/* Scope */}
                  <div>
                    <Label className="text-xs mb-1 block">Scope</Label>
                    <Select
                      value={pricingRuleForm.scope}
                      onValueChange={(v: any) => setPricingRuleForm((f) => ({ ...f, scope: v, scopeId: "" }))}
                    >
                      <SelectTrigger className="min-h-[44px] sm:h-8 text-sm sm:text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="channel">Channel (all products)</SelectItem>
                        <SelectItem value="category">Category (product type)</SelectItem>
                        <SelectItem value="product">Product</SelectItem>
                        <SelectItem value="variant">Variant</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Scope ID (target) */}
                  {pricingRuleForm.scope !== "channel" && (
                    <div>
                      <Label className="text-xs mb-1 block">
                        {pricingRuleForm.scope === "category" ? "Product Type" :
                         pricingRuleForm.scope === "product" ? "Product" : "Variant"}
                      </Label>
                      {pricingRuleForm.scope === "category" ? (
                        <Select
                          value={pricingRuleForm.scopeId}
                          onValueChange={(v) => setPricingRuleForm((f) => ({ ...f, scopeId: v }))}
                        >
                          <SelectTrigger className="min-h-[44px] sm:h-8 text-sm sm:text-xs">
                            <SelectValue placeholder="Select type..." />
                          </SelectTrigger>
                          <SelectContent>
                            {config?.productTypes?.map((pt) => (
                              <SelectItem key={pt.slug} value={pt.slug}>{pt.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <div className="space-y-1">
                          <Input
                            placeholder={`Search ${pricingRuleForm.scope}...`}
                            className="min-h-[44px] sm:h-8 text-sm sm:text-xs"
                            value={pricingScopeSearch}
                            onChange={(e) => setPricingScopeSearch(e.target.value)}
                          />
                          {pricingScopeSearch.length >= 2 && (
                            <div className="max-h-32 overflow-y-auto border rounded bg-background text-xs">
                              {pricingRuleForm.scope === "product" && feedData?.feed
                                ?.filter((f) => f.name.toLowerCase().includes(pricingScopeSearch.toLowerCase()) || f.sku?.toLowerCase().includes(pricingScopeSearch.toLowerCase()))
                                .slice(0, 8)
                                .map((f) => (
                                  <button
                                    key={f.id}
                                    className="w-full text-left px-2 py-1 hover:bg-muted block"
                                    onClick={() => {
                                      setPricingRuleForm((prev) => ({ ...prev, scopeId: String(f.id) }));
                                      setPricingScopeSearch(f.name);
                                    }}
                                  >
                                    {f.name} <code className="text-muted-foreground">{f.sku}</code>
                                  </button>
                                ))}
                              {pricingRuleForm.scope === "variant" && feedData?.feed
                                ?.flatMap((f) => f.variants.map((v) => ({ ...v, productName: f.name })))
                                .filter((v) => v.name?.toLowerCase().includes(pricingScopeSearch.toLowerCase()) || v.sku?.toLowerCase().includes(pricingScopeSearch.toLowerCase()))
                                .slice(0, 8)
                                .map((v) => (
                                  <button
                                    key={v.id}
                                    className="w-full text-left px-2 py-1 hover:bg-muted block"
                                    onClick={() => {
                                      setPricingRuleForm((prev) => ({ ...prev, scopeId: String(v.id) }));
                                      setPricingScopeSearch(`${v.productName} - ${v.name}`);
                                    }}
                                  >
                                    {v.productName} — {v.name} <code className="text-muted-foreground">{v.sku}</code>
                                  </button>
                                ))}
                            </div>
                          )}
                          {pricingRuleForm.scopeId && (
                            <Badge variant="outline" className="text-xs">ID: {pricingRuleForm.scopeId}</Badge>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Rule type */}
                  <div>
                    <Label className="text-xs mb-1 block">Rule Type</Label>
                    <Select
                      value={pricingRuleForm.ruleType}
                      onValueChange={(v: any) => setPricingRuleForm((f) => ({ ...f, ruleType: v }))}
                    >
                      <SelectTrigger className="min-h-[44px] sm:h-8 text-sm sm:text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percentage">Percentage (+X%)</SelectItem>
                        <SelectItem value="fixed">Fixed (+$X.XX)</SelectItem>
                        <SelectItem value="override">Override ($X.XX)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Value */}
                  <div>
                    <Label className="text-xs mb-1 block">
                      {pricingRuleForm.ruleType === "percentage" ? "Percentage" :
                       pricingRuleForm.ruleType === "fixed" ? "Amount ($)" : "Price ($)"}
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        step={pricingRuleForm.ruleType === "percentage" ? "0.1" : "0.01"}
                        placeholder={pricingRuleForm.ruleType === "percentage" ? "15" : "2.00"}
                        className="min-h-[44px] sm:h-8 text-sm sm:text-xs"
                        value={pricingRuleForm.value}
                        onChange={(e) => setPricingRuleForm((f) => ({ ...f, value: e.target.value }))}
                      />
                      <Button
                        size="sm"
                        className="min-h-[44px] sm:h-8 px-4"
                        disabled={
                          !pricingRuleForm.value ||
                          (pricingRuleForm.scope !== "channel" && !pricingRuleForm.scopeId) ||
                          upsertPricingRuleMutation.isPending
                        }
                        onClick={() => {
                          upsertPricingRuleMutation.mutate({
                            scope: pricingRuleForm.scope,
                            scopeId: pricingRuleForm.scope === "channel" ? null : pricingRuleForm.scopeId,
                            ruleType: pricingRuleForm.ruleType,
                            value: parseFloat(pricingRuleForm.value),
                          });
                        }}
                      >
                        {upsertPricingRuleMutation.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Save className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Rules table */}
            {pricingRulesLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading rules...
              </div>
            ) : (pricingRulesData?.rules?.length || 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-4">
                No pricing rules configured. All products will use base prices.
              </p>
            ) : (
              <>
              {/* Mobile: card layout */}
              <div className="sm:hidden space-y-2">
                {pricingRulesData?.rules?.map((rule) => (
                  <div key={rule.id} className="border rounded-lg p-3 flex items-center gap-3">
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-xs capitalize">{rule.scope}</Badge>
                        <Badge variant="secondary" className="text-xs">
                          {rule.rule_type === "percentage" ? "%" :
                           rule.rule_type === "fixed" ? "+$" : "=$"}
                        </Badge>
                        <span className="text-sm font-mono font-medium">
                          {rule.rule_type === "percentage"
                            ? `+${parseFloat(rule.value)}%`
                            : rule.rule_type === "fixed"
                            ? `+$${parseFloat(rule.value).toFixed(2)}`
                            : `$${parseFloat(rule.value).toFixed(2)}`}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {rule.scope === "channel" ? "All products" : (rule.scope_label || rule.scope_id || "—")}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-[44px] min-w-[44px] p-0 text-destructive hover:text-destructive shrink-0"
                      onClick={() => deletePricingRuleMutation.mutate(rule.id)}
                      disabled={deletePricingRuleMutation.isPending}
                    >
                      <XCircle className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
              {/* Desktop: table layout */}
              <div className="hidden sm:block border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Scope</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead>Rule</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead className="w-[60px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pricingRulesData?.rules?.map((rule) => (
                      <TableRow key={rule.id}>
                        <TableCell>
                          <Badge variant="outline" className="text-xs capitalize">{rule.scope}</Badge>
                        </TableCell>
                        <TableCell className="text-sm">
                          {rule.scope === "channel" ? "All products" : (rule.scope_label || rule.scope_id || "—")}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-xs">
                            {rule.rule_type === "percentage" ? "%" :
                             rule.rule_type === "fixed" ? "+$" : "=$"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm font-mono">
                          {rule.rule_type === "percentage"
                            ? `+${parseFloat(rule.value)}%`
                            : rule.rule_type === "fixed"
                            ? `+$${parseFloat(rule.value).toFixed(2)}`
                            : `$${parseFloat(rule.value).toFixed(2)}`}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                            onClick={() => deletePricingRuleMutation.mutate(rule.id)}
                            disabled={deletePricingRuleMutation.isPending}
                          >
                            <XCircle className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

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

      {/* Push Progress Modal (SSE-based) */}
      <PushProgressModal
        open={pushModalOpen}
        onClose={() => setPushModalOpen(false)}
        productIds={pushProductIds}
        onRetryFailed={handleRetryFailed}
      />
    </div>
  );
}
