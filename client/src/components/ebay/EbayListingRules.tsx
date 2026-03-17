/**
 * eBay Listing Rules — cascading config UI
 * 
 * Shows default → product_type → SKU rules with inheritance.
 * Includes a resolve preview to show effective config for any SKU.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Layers, Plus, Trash2, Search, ArrowDown, CheckCircle2,
  Loader2, ChevronDown, ChevronRight, Tag, Package,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EbayPolicy {
  id: string;
  name: string;
}

interface EbayPolicies {
  fulfillmentPolicies: EbayPolicy[];
  returnPolicies: EbayPolicy[];
  paymentPolicies: EbayPolicy[];
}

interface StoreCategory {
  id: string;
  name: string;
}

interface BrowseCategory {
  id: string;
  name: string;
  path: string;
}

interface ListingRule {
  id: number;
  channelId: number;
  scopeType: "default" | "product_type" | "sku";
  scopeValue: string | null;
  ebayCategoryId: string | null;
  ebayStoreCategoryId: string | null;
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
  sortOrder: number;
  enabled: boolean;
}

interface ProductType {
  id: number;
  slug: string;
  name: string;
  sortOrder: number;
}

interface ResolveResult {
  sku: string;
  productName: string;
  productType: string | null;
  resolved: Record<string, string | null>;
  sources: Record<string, string>;
}

interface Props {
  policies: EbayPolicies | null;
  connected: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EbayListingRules({ policies, connected }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expandedSections, setExpandedSections] = useState({ typeRules: true, skuOverrides: true, resolve: false });
  const [addingTypeRule, setAddingTypeRule] = useState(false);
  const [addingSkuOverride, setAddingSkuOverride] = useState(false);
  const [newTypeSlug, setNewTypeSlug] = useState("");
  const [newSkuValue, setNewSkuValue] = useState("");
  const [skuSearch, setSkuSearch] = useState("");
  const [resolveSku, setResolveSku] = useState("");
  const [browseQuery, setBrowseQuery] = useState("");

  // Data queries
  const { data: rules = [], isLoading: rulesLoading } = useQuery<ListingRule[]>({
    queryKey: ["/api/ebay/listing-rules"],
    enabled: connected,
  });

  const { data: productTypesData = [] } = useQuery<ProductType[]>({
    queryKey: ["/api/product-types"],
  });

  const { data: storeCategories } = useQuery<{ categories: StoreCategory[] }>({
    queryKey: ["/api/ebay/store-categories"],
    enabled: connected,
  });

  const { data: browseResults } = useQuery<{ categories: BrowseCategory[] }>({
    queryKey: ["/api/ebay/browse-categories", browseQuery],
    enabled: connected && browseQuery.length >= 2,
  });

  const { data: resolveResult, isLoading: resolveLoading } = useQuery<ResolveResult>({
    queryKey: ["/api/ebay/listing-rules/resolve", resolveSku],
    enabled: connected && resolveSku.length > 0,
  });

  // Find the default rule
  const defaultRule = rules.find(r => r.scopeType === "default");
  const typeRules = rules.filter(r => r.scopeType === "product_type");
  const skuRules = rules.filter(r => r.scopeType === "sku");

  // Product types that already have rules
  const usedTypeSlugs = new Set(typeRules.map(r => r.scopeValue));
  const availableTypes = productTypesData.filter(t => !usedTypeSlugs.has(t.slug));

  // Store categories map for display
  const storeCatMap = useMemo(() => {
    const m = new Map<string, string>();
    (storeCategories?.categories || []).forEach(c => m.set(c.id, c.name));
    return m;
  }, [storeCategories]);

  // Policies maps for display
  const policyName = useCallback((type: "fulfillment" | "return" | "payment", id: string | null) => {
    if (!id || !policies) return null;
    const list = type === "fulfillment" ? policies.fulfillmentPolicies
      : type === "return" ? policies.returnPolicies
      : policies.paymentPolicies;
    return list.find(p => p.id === id)?.name || id;
  }, [policies]);

  // Mutations
  const createRule = useMutation({
    mutationFn: async (data: Partial<ListingRule>) => {
      const res = await apiRequest("POST", "/api/ebay/listing-rules", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-rules"] });
      toast({ title: "Rule created" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create rule", description: err.message, variant: "destructive" });
    },
  });

  const updateRule = useMutation({
    mutationFn: async ({ id, ...data }: { id: number } & Partial<ListingRule>) => {
      const res = await apiRequest("PUT", `/api/ebay/listing-rules/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-rules"] });
      if (resolveSku) queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-rules/resolve", resolveSku] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update rule", description: err.message, variant: "destructive" });
    },
  });

  const deleteRule = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/ebay/listing-rules/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-rules"] });
      toast({ title: "Rule deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete rule", description: err.message, variant: "destructive" });
    },
  });

  // Ensure default rule exists
  const ensureDefault = useCallback(() => {
    if (!defaultRule && !createRule.isPending) {
      createRule.mutate({ scopeType: "default", scopeValue: undefined });
    }
  }, [defaultRule, createRule]);

  useEffect(() => {
    if (connected && !rulesLoading && !defaultRule) {
      ensureDefault();
    }
  }, [connected, rulesLoading, defaultRule, ensureDefault]);

  if (!connected) {
    return (
      <div className="text-sm text-muted-foreground p-3 bg-muted rounded-lg">
        Connect to eBay to configure listing rules.
      </div>
    );
  }

  if (rulesLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-3">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading listing rules...
      </div>
    );
  }

  const toggleSection = (key: keyof typeof expandedSections) =>
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="space-y-4">
      {/* Store Defaults */}
      {defaultRule && (
        <div className="border rounded-lg p-3 space-y-3">
          <div className="flex items-center gap-2">
            <Badge variant="default" className="text-[10px] py-0 h-5">DEFAULT</Badge>
            <span className="text-xs text-muted-foreground">Applied to all listings unless overridden</span>
          </div>
          <RuleRow
            rule={defaultRule}
            policies={policies}
            storeCategories={storeCategories?.categories || []}
            browseResults={browseResults?.categories || []}
            browseQuery={browseQuery}
            onBrowseSearch={setBrowseQuery}
            onUpdate={(data) => updateRule.mutate({ id: defaultRule.id, ...data })}
            isDefault
          />
        </div>
      )}

      {/* Product Type Rules */}
      <div className="border rounded-lg">
        <button
          className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
          onClick={() => toggleSection("typeRules")}
        >
          <div className="flex items-center gap-2">
            <Tag className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Product Type Rules</span>
            <Badge variant="secondary" className="text-[10px] py-0 h-5">{typeRules.length}</Badge>
          </div>
          {expandedSections.typeRules ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        {expandedSections.typeRules && (
          <div className="px-3 pb-3 space-y-3">
            {typeRules.length === 0 && !addingTypeRule && (
              <p className="text-xs text-muted-foreground py-2">
                No product type rules yet. Add one to override defaults for a category of products.
              </p>
            )}
            {typeRules.map(rule => (
              <div key={rule.id} className="border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px] py-0 h-5">
                      {productTypesData.find(t => t.slug === rule.scopeValue)?.name || rule.scopeValue}
                    </Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => deleteRule.mutate(rule.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <RuleRow
                  rule={rule}
                  policies={policies}
                  storeCategories={storeCategories?.categories || []}
                  browseResults={browseResults?.categories || []}
                  browseQuery={browseQuery}
                  onBrowseSearch={setBrowseQuery}
                  onUpdate={(data) => updateRule.mutate({ id: rule.id, ...data })}
                  inheritLabel="(inherit from default)"
                />
              </div>
            ))}
            {addingTypeRule ? (
              <div className="flex items-center gap-2 p-2 border rounded-lg bg-muted/30">
                <Select value={newTypeSlug} onValueChange={setNewTypeSlug}>
                  <SelectTrigger className="h-8 text-xs w-[200px]">
                    <SelectValue placeholder="Select product type..." />
                  </SelectTrigger>
                  <SelectContent>
                    {availableTypes.map(t => (
                      <SelectItem key={t.slug} value={t.slug}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  disabled={!newTypeSlug || createRule.isPending}
                  onClick={() => {
                    createRule.mutate(
                      { scopeType: "product_type", scopeValue: newTypeSlug },
                      { onSuccess: () => { setAddingTypeRule(false); setNewTypeSlug(""); } }
                    );
                  }}
                >
                  Add
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => { setAddingTypeRule(false); setNewTypeSlug(""); }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1"
                onClick={() => setAddingTypeRule(true)}
                disabled={availableTypes.length === 0}
              >
                <Plus className="h-3 w-3" />
                Add Product Type Rule
              </Button>
            )}
          </div>
        )}
      </div>

      {/* SKU Overrides */}
      <div className="border rounded-lg">
        <button
          className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
          onClick={() => toggleSection("skuOverrides")}
        >
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">SKU Overrides</span>
            <Badge variant="secondary" className="text-[10px] py-0 h-5">{skuRules.length}</Badge>
          </div>
          {expandedSections.skuOverrides ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        {expandedSections.skuOverrides && (
          <div className="px-3 pb-3 space-y-3">
            {skuRules.length === 0 && !addingSkuOverride && (
              <p className="text-xs text-muted-foreground py-2">
                No SKU overrides. Add one to customize settings for a specific variant.
              </p>
            )}
            {skuRules.map(rule => (
              <div key={rule.id} className="border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="text-[10px] py-0 h-5 font-mono">
                    {rule.scopeValue}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => deleteRule.mutate(rule.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <RuleRow
                  rule={rule}
                  policies={policies}
                  storeCategories={storeCategories?.categories || []}
                  browseResults={browseResults?.categories || []}
                  browseQuery={browseQuery}
                  onBrowseSearch={setBrowseQuery}
                  onUpdate={(data) => updateRule.mutate({ id: rule.id, ...data })}
                  inheritLabel="(inherit)"
                />
              </div>
            ))}
            {addingSkuOverride ? (
              <div className="flex items-center gap-2 p-2 border rounded-lg bg-muted/30">
                <Input
                  value={newSkuValue}
                  onChange={(e) => setNewSkuValue(e.target.value.toUpperCase())}
                  placeholder="Enter SKU..."
                  className="h-8 text-xs w-[200px] font-mono"
                />
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  disabled={!newSkuValue.trim() || createRule.isPending}
                  onClick={() => {
                    createRule.mutate(
                      { scopeType: "sku", scopeValue: newSkuValue.trim() },
                      { onSuccess: () => { setAddingSkuOverride(false); setNewSkuValue(""); } }
                    );
                  }}
                >
                  Add
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => { setAddingSkuOverride(false); setNewSkuValue(""); }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1"
                onClick={() => setAddingSkuOverride(true)}
              >
                <Plus className="h-3 w-3" />
                Add SKU Override
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Resolve Preview */}
      <div className="border rounded-lg">
        <button
          className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
          onClick={() => toggleSection("resolve")}
        >
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Resolve Preview</span>
          </div>
          {expandedSections.resolve ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        {expandedSections.resolve && (
          <div className="px-3 pb-3 space-y-3">
            <div className="flex items-center gap-2">
              <Input
                value={skuSearch}
                onChange={(e) => setSkuSearch(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === "Enter") setResolveSku(skuSearch); }}
                placeholder="Enter SKU to resolve..."
                className="h-8 text-xs font-mono flex-1"
              />
              <Button
                size="sm"
                className="h-8 text-xs"
                onClick={() => setResolveSku(skuSearch)}
                disabled={!skuSearch.trim() || resolveLoading}
              >
                {resolveLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Resolve"}
              </Button>
            </div>
            {resolveResult && (
              <div className="border rounded-lg p-3 space-y-2 bg-muted/30">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{resolveResult.productName}</span>
                  {resolveResult.productType && (
                    <Badge variant="outline" className="text-[10px] py-0 h-5">{resolveResult.productType}</Badge>
                  )}
                </div>
                <div className="space-y-1">
                  {Object.entries(resolveResult.resolved).map(([field, value]) => (
                    <div key={field} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{formatFieldName(field)}</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono">{value || "—"}</span>
                        <Badge variant="secondary" className="text-[9px] py-0 h-4">
                          {resolveResult.sources[field]}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RuleRow — individual rule editor
// ---------------------------------------------------------------------------

function RuleRow({
  rule,
  policies,
  storeCategories,
  browseResults,
  browseQuery,
  onBrowseSearch,
  onUpdate,
  isDefault,
  inheritLabel = "(inherit)",
}: {
  rule: ListingRule;
  policies: EbayPolicies | null;
  storeCategories: StoreCategory[];
  browseResults: BrowseCategory[];
  browseQuery: string;
  onBrowseSearch: (q: string) => void;
  onUpdate: (data: Partial<ListingRule>) => void;
  isDefault?: boolean;
  inheritLabel?: string;
}) {
  const INHERIT_VALUE = "__inherit__";

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
      {/* eBay Category */}
      <div>
        <Label className="text-[10px] text-muted-foreground">eBay Category</Label>
        <div className="flex gap-1">
          <Input
            value={rule.ebayCategoryId || ""}
            onChange={(e) => onUpdate({ ebayCategoryId: e.target.value || null })}
            placeholder={isDefault ? "Category ID" : inheritLabel}
            className="h-8 text-xs font-mono flex-1"
          />
        </div>
        {/* Browse search for category IDs */}
        <div className="mt-1">
          <Input
            value={browseQuery}
            onChange={(e) => onBrowseSearch(e.target.value)}
            placeholder="Search categories..."
            className="h-7 text-[10px]"
          />
          {browseResults.length > 0 && browseQuery.length >= 2 && (
            <div className="mt-1 max-h-32 overflow-y-auto border rounded text-[10px]">
              {browseResults.slice(0, 8).map(cat => (
                <button
                  key={cat.id}
                  className="w-full text-left px-2 py-1 hover:bg-muted/50 truncate"
                  onClick={() => {
                    onUpdate({ ebayCategoryId: cat.id });
                    onBrowseSearch("");
                  }}
                >
                  <span className="font-mono mr-1">{cat.id}</span>
                  <span className="text-muted-foreground">{cat.path}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Store Category */}
      <div>
        <Label className="text-[10px] text-muted-foreground">Store Category</Label>
        <Select
          value={rule.ebayStoreCategoryId || INHERIT_VALUE}
          onValueChange={(v) => onUpdate({ ebayStoreCategoryId: v === INHERIT_VALUE ? null : v })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={isDefault ? "Select..." : inheritLabel} />
          </SelectTrigger>
          <SelectContent>
            {!isDefault && <SelectItem value={INHERIT_VALUE}><span className="text-muted-foreground">{inheritLabel}</span></SelectItem>}
            {storeCategories.map(c => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Fulfillment Policy */}
      <div>
        <Label className="text-[10px] text-muted-foreground">Shipping Policy</Label>
        <Select
          value={rule.fulfillmentPolicyId || INHERIT_VALUE}
          onValueChange={(v) => onUpdate({ fulfillmentPolicyId: v === INHERIT_VALUE ? null : v })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={isDefault ? "Select..." : inheritLabel} />
          </SelectTrigger>
          <SelectContent>
            {!isDefault && <SelectItem value={INHERIT_VALUE}><span className="text-muted-foreground">{inheritLabel}</span></SelectItem>}
            {(policies?.fulfillmentPolicies || []).map(p => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Return Policy */}
      <div>
        <Label className="text-[10px] text-muted-foreground">Return Policy</Label>
        <Select
          value={rule.returnPolicyId || INHERIT_VALUE}
          onValueChange={(v) => onUpdate({ returnPolicyId: v === INHERIT_VALUE ? null : v })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={isDefault ? "Select..." : inheritLabel} />
          </SelectTrigger>
          <SelectContent>
            {!isDefault && <SelectItem value={INHERIT_VALUE}><span className="text-muted-foreground">{inheritLabel}</span></SelectItem>}
            {(policies?.returnPolicies || []).map(p => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Payment Policy */}
      <div>
        <Label className="text-[10px] text-muted-foreground">Payment Policy</Label>
        <Select
          value={rule.paymentPolicyId || INHERIT_VALUE}
          onValueChange={(v) => onUpdate({ paymentPolicyId: v === INHERIT_VALUE ? null : v })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={isDefault ? "Select..." : inheritLabel} />
          </SelectTrigger>
          <SelectContent>
            {!isDefault && <SelectItem value={INHERIT_VALUE}><span className="text-muted-foreground">{inheritLabel}</span></SelectItem>}
            {(policies?.paymentPolicies || []).map(p => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFieldName(field: string): string {
  const map: Record<string, string> = {
    ebayCategoryId: "eBay Category",
    ebayStoreCategoryId: "Store Category",
    fulfillmentPolicyId: "Shipping Policy",
    returnPolicyId: "Return Policy",
    paymentPolicyId: "Payment Policy",
  };
  return map[field] || field;
}
