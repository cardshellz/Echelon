/**
 * eBay Channel Configuration — Full Page
 *
 * Three sections:
 * 1. Store Setup (connection, location, default policies)
 * 2. Category Mapping (product type → eBay category)
 * 3. Listing Feed (products ready to list)
 */

import { ListingIntentChanges } from "@/features/channel-listing-publication/ListingIntentChanges";
import { publicationRequest } from "@/features/channel-listing-publication/api";
import { useAuth } from "@/lib/auth";
import { ebayProductSyncResultSchema, ebayListingSyncJobSchema } from "@shared/types/ebay-listing-sync";
import { EbayListingJobStatusDialog } from "@/components/ebay/EbayListingJobStatusDialog";
import { EbayListingJobProgress } from "@/components/ebay/EbayListingJobProgress";
import { presentEbayListingJob } from "@shared/ebay-listing-progress";
import { EbayProductListingIntentControl } from "@/components/ebay/EbayProductListingIntentControl";
import { EbayWithdrawalIssueCard } from "@/components/ebay/EbayWithdrawalIssueCard";
import { ebayListingIssueSchema, type EbayListingIssue } from "@shared/types/ebay-listing-issue";
import { resolveEbayListingIssue, resolveEbayListingJobIssue } from "@shared/ebay-listing-issue";
import { listingFeedIssueFromError, listingIssueFromError, listingSyncIssueFromError } from "@/lib/ebay-listing-issue";
import { z } from "zod";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { EbayPolicyValues, EbayPolicyPatch, EbayPolicyScope } from "@shared/ebay-business-policies";
import { EbayPolicyFields, PolicyDraftConflict, policyChanges, useEbayPolicyDraft, type PolicyCatalogStatus } from "@/features/channels/EbayPolicyFields";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChannelWorkspaceHeader } from "@/components/channels/ChannelWorkspaceHeader";
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
  ShieldCheck,
  Clock,
  ExternalLink,
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
import { ChannelSyncProgress } from "@/components/channels/ChannelSyncProgress";
import { useChannelSyncBatches } from "@/hooks/use-channel-sync-batches";
import { EbayListingIssueCard } from "@/components/ebay/EbayListingIssueCard";
import { EbayMappingRepairDialog } from "@/components/ebay/EbayMappingRepairDialog";
import { EbaySyncRecoveryDialog } from "@/components/ebay/EbaySyncRecoveryDialog";
import { MarketplaceListingRegistrationDialog } from "@/components/marketplace/MarketplaceListingRegistrationDialog";
import { MarketplaceListingChangesDialog } from "@/components/marketplace/MarketplaceListingChangesDialog";
import {
  fetchChannelEbayMarketplaceListingRegistrationStatuses,
  type MarketplaceListingRegistrationStatus,
} from "@/lib/marketplace-listing-registration-status";
import { reconcileMarketplaceListing } from "@/lib/marketplace-listing-reconciliation";

// ============================================================================
// Types
// ============================================================================

interface ChannelConfig {
  connected: boolean;
  connectionHealth?: "verified" | "needs_attention" | "not_connected";
  connectionIssue?: EbayListingIssue | null;
  channel: { id: number; name: string; status: string } | null;
  ebayUsername: string | null;
  tokenInfo: {
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
    lastRefreshedAt: string;
    environment: string;
  } | null;
  config: {
    marketplaceId: string;
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
  scope?: EbayPolicyScope;
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
  explicitlyExcluded: boolean;
  excludedByProduct: boolean;
  effectivelyListed: boolean;
  inventoryQuantity: number | null;
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
  status: "ready" | "missing_config" | "missing_specifics" | "listed" | "publication_incomplete" | "excluded" | "type_disabled" | "ended" | "deleted" | "error";
  missingItems: string[];
  missingAspects: string[];
  isListed: boolean;
  canSyncExistingListing?: boolean;
  isExcluded: boolean;
  syncError: string | null;
  inventoryIssue?: EbayListingIssue | null;
  priceIssue?: EbayListingIssue | null;
  externalListingId: string | null;
  externalListingIdentityConflict: boolean;
  variantCount: number;
  includedVariantCount: number;
  unlinkedVariants?: Array<{ id: number; sku: string }>;
  imageCount: number;
  variants: FeedVariant[];
  fulfillmentPolicyOverride: string | null;
  returnPolicyOverride: string | null;
  paymentPolicyOverride: string | null;
}

function listingNeedsAttention(item: FeedItem, job: z.infer<typeof ebayListingSyncJobSchema> | undefined, hasLocalIssue: boolean): boolean {
  if (item.priceIssue || item.inventoryIssue || hasLocalIssue || job?.readRetryPaused || job?.inventoryReconciliation?.state === "needs_attention"
    || (job && ["needs_attention", "awaiting_evidence"].includes(job.state))) return true;
  if (job && ["queued", "running", "recovering"].includes(job.state)) return false;
  return item.status === "error" || item.status === "publication_incomplete";
}

// Reads retain legacy values so an invalid saved rule can still be corrected or
// removed. New selections are validated by the pricing command owner.
const pricingRuleSchema = z.object({
  id: z.number().int().positive(),
  channel_id: z.number().int().positive(),
  scope: z.string().max(20),
  scope_id: z.string().nullable(),
  rule_type: z.string().max(20),
  value: z.string().max(100),
  scope_label: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
const pricingRulesResponseSchema = z.object({ rules: z.array(pricingRuleSchema) });
type PricingRule = z.infer<typeof pricingRuleSchema>;

interface EffectivePrices {
  [variantId: number]: { basePriceCents: number | null; effectivePriceCents: number | null; missingPrice?: boolean; resolutionIssue?: { code: string; message: string } };
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

function categoryPolicyValues(mapping: Partial<CategoryMapping>): EbayPolicyValues {
  return { fulfillmentPolicyId: mapping.fulfillmentPolicyOverride ?? null,
    returnPolicyId: mapping.returnPolicyOverride ?? null, paymentPolicyId: mapping.paymentPolicyOverride ?? null };
}
function categoryPolicyPatch(patch: EbayPolicyPatch): Partial<CategoryMapping> {
  return { ...("fulfillmentPolicyId" in patch ? { fulfillmentPolicyOverride: patch.fulfillmentPolicyId } : {}),
    ...("returnPolicyId" in patch ? { returnPolicyOverride: patch.returnPolicyId } : {}),
    ...("paymentPolicyId" in patch ? { paymentPolicyOverride: patch.paymentPolicyId } : {}) };
}
function PolicyOverrideRow({ label, fulfillmentPolicyId, returnPolicyId, paymentPolicyId, policies,
  catalogStatus, onSave, isPending, inheritLabel, id }: {
  label: string; fulfillmentPolicyId: string | null; returnPolicyId: string | null; paymentPolicyId: string | null;
  policies: PoliciesResponse | undefined; catalogStatus: PolicyCatalogStatus; isPending: boolean;
  inheritLabel: string; id: string;
  onSave: (patch: EbayPolicyPatch, expectedPolicies: EbayPolicyValues, expectedScope?: EbayPolicyScope) => Promise<unknown>;
}) {
  const draft = useEbayPolicyDraft({ fulfillmentPolicyId: fulfillmentPolicyId ?? null,
    returnPolicyId: returnPolicyId ?? null, paymentPolicyId: paymentPolicyId ?? null }, policies?.scope);
  const [error, setError] = useState<string | null>(null);
  return <section id={id} aria-label={label} className="space-y-2 scroll-mt-4">
    <p className="text-xs font-medium text-muted-foreground">{label}</p>
    <EbayPolicyFields values={draft.values} catalog={policies} status={catalogStatus} labelPrefix={label}
      inheritLabel={inheritLabel} disabled={isPending} onChange={patch => { draft.change(patch); setError(null); }} />
    {draft.dirty && draft.changedElsewhere && <PolicyDraftConflict onReload={() => { draft.reload(); setError(null); }} />}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {draft.dirty && <Button size="sm" className="min-h-11 text-xs"
      disabled={isPending || catalogStatus !== "ready" || draft.changedElsewhere}
      onClick={async () => {
        setError(null);
        try { await onSave(draft.patch, draft.base, draft.scope); draft.saved(); }
        catch (failure) { setError(listingIssueFromError(failure).message); }
      }}>{isPending ? "Saving…" : "Save Policies"}</Button>}
  </section>;
}

// ============================================================================
// Component
// ============================================================================

export default function EbayChannelPage() {
  const { user, hasPermission } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ---- Main config query ----
  const {
    data: config,
    isLoading: configLoading,
    isFetching: configFetching,
    error: configError,
  } = useQuery<ChannelConfig>({
    queryKey: ["/api/ebay/channel-config"],
  });

  // ---- Policies ----
  const { data: policies, isLoading: policiesLoading, error: policiesError, refetch: refetchPolicies } = useQuery<PoliciesResponse>({
    queryKey: ["/api/ebay/policies"],
    enabled: !!config?.connected,
  });

  // ---- Store categories ----
  const { data: storeCatsData, refetch: refetchStoreCats } = useQuery<{ categories: StoreCategory[] }>({
    queryKey: ["/api/ebay/store-categories"],
    enabled: !!config?.connected,
  });

  // ---- Listing feed ----
  const { data: feedData, isLoading: feedLoading, isFetching: feedFetching, error: feedError, refetch: refetchFeed } = useQuery<{ feed: FeedItem[]; total: number }>({
    queryKey: ["/api/ebay/listing-feed"],
    enabled: !!config?.connected,
  });
  const feedReadIssue = useMemo(() => feedError ? listingFeedIssueFromError(feedError) : null, [feedError]);
  const syncJobsQuery = useQuery({
    queryKey: ["/api/ebay/listings/sync-jobs"],
    queryFn: async () => z.array(ebayListingSyncJobSchema).parse(await (await apiRequest("GET", "/api/ebay/listings/sync-jobs")).json()),
    enabled: !!config?.connected, refetchInterval: 10_000,
  });
  const latestSyncJobs = useMemo(() => {
    const jobs = new Map<number, z.infer<typeof ebayListingSyncJobSchema>>();
    for (const job of syncJobsQuery.data ?? []) if (!jobs.has(job.productId)) jobs.set(job.productId,job);
    return jobs;
  }, [syncJobsQuery.data]);
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
  }, [syncJobsQuery.dataUpdatedAt, queryClient]);

  const registrationStatusProductIds = useMemo(
    () => [...new Set(
      (feedData?.feed ?? [])
        .filter((item) => item.externalListingId && item.status !== "deleted")
        .map((item) => item.id),
    )].sort((left, right) => left - right),
    [feedData?.feed],
  );
  const registrationStatusQueryInput = useMemo(() => {
    const channelId = config?.channel?.id;
    const marketplaceId = config?.config.marketplaceId?.trim();
    if (!config?.connected || !channelId || !marketplaceId || registrationStatusProductIds.length === 0) {
      return null;
    }
    return {
      channelId,
      marketplaceId,
      productIds: registrationStatusProductIds,
    };
  }, [
    config?.channel?.id,
    config?.config.marketplaceId,
    config?.connected,
    registrationStatusProductIds,
  ]);
  const registrationStatusQueryKey = useMemo(
    () => [
      "marketplace-listing-registration-status",
      "channel",
      "ebay",
      registrationStatusQueryInput?.channelId ?? null,
      registrationStatusQueryInput?.marketplaceId ?? null,
      registrationStatusQueryInput?.productIds.join(",") ?? null,
    ] as const,
    [registrationStatusQueryInput],
  );
  const {
    data: registrationStatuses = [],
    isLoading: registrationStatusesLoading,
    isFetching: registrationStatusesFetching,
    error: registrationStatusesError,
  } = useQuery<readonly MarketplaceListingRegistrationStatus[]>({
    queryKey: registrationStatusQueryKey,
    enabled: registrationStatusQueryInput !== null,
    queryFn: async () => registrationStatusQueryInput
      ? fetchChannelEbayMarketplaceListingRegistrationStatuses(registrationStatusQueryInput)
      : [],
  });
  const registrationStatusConfigurationUnavailable =
    registrationStatusProductIds.length > 0
    && registrationStatusQueryInput === null
    && !configLoading
    && !feedLoading;
  const registrationStatusByProductId = useMemo(
    () => new Map(
      registrationStatuses.map((status) => [
        status.productId,
        status,
      ]),
    ),
    [registrationStatuses],
  );

  // ---- Pricing rules ----
  const {
    data: pricingRulesData,
    isLoading: pricingRulesLoading,
    error: pricingReadError,
    refetch: refetchPricingRules,
  } = useQuery({
    queryKey: ["/api/ebay/pricing-rules"],
    queryFn: () => publicationRequest("GET", "/api/ebay/pricing-rules", pricingRulesResponseSchema),
    enabled: !!config?.connected,
  });

  // ---- Effective prices (bulk) ----
  const { data: effectivePricesData, isError: effectivePricesUnavailable } = useQuery<{ prices: EffectivePrices }>({
    queryKey: ["/api/ebay/effective-prices"],
    enabled: !!config?.connected,
  });

  // ---- Local state ----
  const storePolicyDraft = useEbayPolicyDraft({ fulfillmentPolicyId: config?.config?.fulfillmentPolicyId ?? null,
    returnPolicyId: config?.config?.returnPolicyId ?? null, paymentPolicyId: config?.config?.paymentPolicyId ?? null }, policies?.scope);
  const policyCatalogStatus: PolicyCatalogStatus = policiesLoading ? "loading" : policiesError || !policies ? "unavailable" : "ready";
  const [productTypeManagerOpen, setProductTypeManagerOpen] = useState(false);

  // Category mapping local state
  const [localMappings, setLocalMappings] = useState<Map<string, CategoryMapping>>(new Map());
  const [mappingsDirty, setMappingsDirty] = useState(false);
  const [mappingPolicyBaselines, setMappingPolicyBaselines] = useState<Map<string, EbayPolicyValues>>(new Map());
  const [mappingPolicyScope, setMappingPolicyScope] = useState<EbayPolicyScope | undefined>();
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
  const [policyAnchor, setPolicyAnchor] = useState(() => window.location.hash);
  const [policyAnchorActivation, setPolicyAnchorActivation] = useState(0);
  const consumedPolicyAnchor = useRef<string | null>(null);
  const [policyScrollRequest, setPolicyScrollRequest] = useState<{ anchor: string } | null>(null);
  const handlePolicyAnchorClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
    if (link.origin !== window.location.origin || link.pathname !== window.location.pathname || link.search !== window.location.search) return;
    if (link.hash !== "#business-policies" && !/^#ebay-(?:product|variant|category)-policies-/.test(link.hash)) return;
    // Re-activating the same fragment does not fire hashchange. Keep the real
    // link's navigation and keyboard behavior, while reopening its editor.
    if (link.hash === window.location.hash) {
      setPolicyAnchor(link.hash);
      setPolicyAnchorActivation(previous => previous + 1);
    }
  };
  useEffect(() => {
    const changed = () => {
      setPolicyAnchor(window.location.hash);
      setPolicyAnchorActivation(previous => previous + 1);
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    const activationKey = `${policyAnchorActivation}:${policyAnchor}`;
    if (consumedPolicyAnchor.current === activationKey) return;
    const product = /^#ebay-product-policies-([1-9][0-9]*)$/.exec(policyAnchor);
    const variant = /^#ebay-variant-policies-([1-9][0-9]*)$/.exec(policyAnchor);
    const category = /^#ebay-category-policies-(.+)$/.exec(policyAnchor);
    if (product) {
      const id = Number(product[1]);
      if (!feedData?.feed.some(item => item.id === id)) return;
      setExpandedProducts(previous => new Set(previous).add(id));
    } else if (variant) {
      const id = Number(variant[1]);
      const owner = feedData?.feed.find(item => item.variants.some(member => member.id === id));
      if (!owner) return;
      setExpandedProducts(previous => new Set(previous).add(owner.id));
      setExpandedVariantPolicies(previous => new Set(previous).add(id));
    } else if (category) {
      try {
        const slug = decodeURIComponent(category[1]);
        if (!config?.productTypes?.some(type => type.slug === slug)) return;
        setExpandedOverrides(previous => new Set(previous).add(slug));
      } catch { return; /* A malformed location fragment cannot select a category. */ }
    } else if (policyAnchor !== "#business-policies" || !config?.connected) return;
    // Consume only after the requested owner is available. Later feed reads
    // must not reopen a manually collapsed editor or steal the user's scroll.
    consumedPolicyAnchor.current = activationKey;
    setPolicyScrollRequest({ anchor: policyAnchor });
  }, [policyAnchor, policyAnchorActivation, feedData, config?.productTypes, config?.connected]);
  useEffect(() => {
    if (!policyScrollRequest) return;
    const anchor = policyScrollRequest.anchor;
    const frame = requestAnimationFrame(() => {
      const category = /^#ebay-category-policies-(.+)$/.exec(anchor);
      let target: HTMLElement | null = null;
      if (category) {
        try { target = [...document.querySelectorAll<HTMLElement>("[data-policy-category]")]
          .find(element => element.dataset.policyCategory === decodeURIComponent(category[1]) && element.getClientRects().length > 0) ?? null; }
        catch { return; }
      } else target = document.getElementById(anchor.slice(1));
      target?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [policyScrollRequest]);
  const [registrationTarget, setRegistrationTarget] = useState<FeedItem | null>(null);
  const [listingChangesTarget, setListingChangesTarget] = useState<FeedItem | null>(null);
  const activeListingChangeVariants = useMemo(
    () =>
      listingChangesTarget?.variants.map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        name: variant.name,
        included: variant.effectivelyListed,
      })) ?? [],
    [listingChangesTarget],
  );
  const listingChangeVariants = useMemo(() => {
    if (!listingChangesTarget) return [];
    const activeVariantIds = new Set(activeListingChangeVariants.map((variant) => variant.id));
    const registeredVariants = registrationStatusByProductId
      .get(listingChangesTarget.id)?.registeredVariants ?? [];
    const archivedVariants = registeredVariants
      .filter((variant) => !activeVariantIds.has(variant.productVariantId))
      .map((variant) => ({
        id: variant.productVariantId,
        sku: variant.sku,
        name: "Archived variant",
        included: false,
        lockedExcluded: true,
      }));
    return [...activeListingChangeVariants, ...archivedVariants];
  }, [activeListingChangeVariants, registrationStatusByProductId, listingChangesTarget]);
  const registrationOwner = useMemo(() => {
    const marketplaceId = config?.config.marketplaceId?.trim();
    const target = registrationTarget ?? listingChangesTarget;
    if (!target || !config?.channel || !marketplaceId) return null;
    return {
      kind: "channel" as const,
      channelId: config.channel.id,
      productId: target.id,
      marketplaceId,
    };
  }, [config?.channel, config?.config.marketplaceId, registrationTarget, listingChangesTarget]);
  const handleListingChangesComplete = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
    if (registrationStatusQueryInput) {
      void queryClient.invalidateQueries({ queryKey: registrationStatusQueryKey, exact: true });
    }
    toast({
      title: "eBay listing changes saved",
      description: "Echelon refreshed the live listing and its verified comparison state.",
    });
  }, [queryClient, registrationStatusQueryInput, registrationStatusQueryKey, toast]);

  const handleRegistrationComplete = useCallback(() => {
    if (registrationStatusQueryInput) {
      void queryClient.invalidateQueries({
        queryKey: registrationStatusQueryKey,
        exact: true,
      });
    }
    toast({
      title: "Listing analyzed",
      description: "Echelon read the live listing and can now identify whether it needs an update or a rebuild.",
    });
  }, [queryClient, registrationStatusQueryInput, registrationStatusQueryKey, toast]);

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

  // Sync category mappings from config
  useEffect(() => {
    if (config?.categoryMappings && !mappingsDirty) {
      const map = new Map<string, CategoryMapping>();
      for (const m of config.categoryMappings) {
        map.set(m.productTypeSlug, m);
      }
      setLocalMappings(map);
      setMappingPolicyBaselines(new Map([...map].map(([slug, mapping]) => [slug, categoryPolicyValues(mapping)])));
      setMappingPolicyScope(policies?.scope);
    }
  }, [config?.categoryMappings, mappingsDirty, policies?.scope]);

  const categoryPoliciesChangedElsewhere = mappingsDirty && (JSON.stringify(mappingPolicyScope) !== JSON.stringify(policies?.scope)
    || [...new Set([...mappingPolicyBaselines.keys(), ...(config?.categoryMappings ?? []).map(mapping => mapping.productTypeSlug)])].some(slug =>
      JSON.stringify(mappingPolicyBaselines.get(slug) ?? categoryPolicyValues({}))
        !== JSON.stringify(categoryPolicyValues(config?.categoryMappings?.find(mapping => mapping.productTypeSlug === slug) ?? {}))));
  const reloadCategoryPolicies = () => {
    const current = new Map((config?.categoryMappings ?? []).map(mapping => [mapping.productTypeSlug, categoryPolicyValues(mapping)]));
    setLocalMappings(previous => new Map([...previous].map(([slug, mapping]) => [slug, { ...mapping,
      ...categoryPolicyPatch(current.get(slug) ?? categoryPolicyValues({})) }])));
    setMappingPolicyBaselines(current);
    setMappingPolicyScope(policies?.scope);
  };

  // ---- Mutations ----

  const savePoliciesMutation = useMutation({
    mutationFn: async () => {
      const resp = await apiRequest("PUT", "/api/ebay/settings", { ...storePolicyDraft.patch, expectedPolicies: storePolicyDraft.base, expectedScope: storePolicyDraft.scope });
      return resp.json();
    },
    onSuccess: () => {
      storePolicyDraft.saved();
      toast({ title: "Settings Saved", description: "Default business policies updated." });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] });
    },
    onError: (err: Error) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      void refetchPolicies();
      toast({ title: "Error", description: listingIssueFromError(err).message, variant: "destructive" });
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
      // A first policy override is a mapping even before a browse/store category
      // or listing flag has been saved for the product type.
      const mappingsArray = Array.from(localMappings.values()).filter(
        (m) => m.ebayBrowseCategoryId || m.ebayStoreCategoryId || m.listingEnabled !== undefined
          || Object.keys(policyChanges(mappingPolicyBaselines.get(m.productTypeSlug) ?? categoryPolicyValues({}), categoryPolicyValues(m))).length > 0
      );
      const mappings = mappingsArray.map(mapping => {
        const { fulfillmentPolicyOverride, returnPolicyOverride, paymentPolicyOverride, ...otherFields } = mapping;
        const expectedPolicies = mappingPolicyBaselines.get(mapping.productTypeSlug) ?? categoryPolicyValues({});
        const patch = policyChanges(expectedPolicies, categoryPolicyValues(mapping));
        return { ...otherFields, ...categoryPolicyPatch(patch),
          ...(Object.keys(patch).length ? { expectedPolicies } : {}) };
      });
      const resp = await apiRequest("PUT", "/api/ebay/category-mapping", { mappings, expectedScope: mappingPolicyScope });
      return resp.json();
    },
    onSuccess: async (data: { message?: string }) => {
      toast({ title: "Mappings Saved", description: data.message });
      await queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] });
      setMappingsDirty(false);
      void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
    },
    onError: (err: Error) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      void refetchPolicies();
      toast({ title: "Error", description: listingIssueFromError(err).message, variant: "destructive" });
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

  // ---- Durable eBay publication ----
  const syncBatches = useChannelSyncBatches(config?.channel?.id, user?.id ? String(user.id) : undefined);
  const batchActivity = syncBatches.batch?.items.map(item => `${item.operationId}:${item.state}:${item.updatedAt}`).join("|");
  useEffect(() => {
    if (!batchActivity) return;
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/effective-prices"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listings/sync-jobs"] });
  }, [batchActivity, queryClient]);
  // ---- Sync All Listings ----
  const handleSyncAll = () => { void syncBatches.start(); };

  // ---- Sync Single Product ----
  const [syncingProductIds, setSyncingProductIds] = useState<Set<number>>(new Set());
  const [localSyncIssues, setLocalSyncIssues] = useState<Map<number, { issue: EbayListingIssue; commandKey: string | null }>>(new Map());
  const [recoveryTarget, setRecoveryTarget] = useState<{ jobId: string | null; productId: number; name: string; issue: EbayListingIssue | null; mode: "recovery" | "mapping" } | null>(null);
  const uncertainCommands = [...localSyncIssues].flatMap(([productId, local]) => local.commandKey ? [{ productId, commandKey: local.commandKey }] : []);
  const commandReceipts = useQueries({ queries: uncertainCommands.map(({ productId, commandKey }) => ({
    queryKey: ["/api/ebay/listings/sync-jobs", "command", commandKey],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/ebay/listings/sync-jobs/${commandKey}`);
      const receipt = z.object({ job: ebayListingSyncJobSchema }).parse(await response.json());
      if (receipt.job.productId !== productId) throw new Error("The saved sync receipt belongs to a different product.");
      return { commandKey, job: receipt.job };
    },
    retry: false, staleTime: 0, refetchInterval: 10_000,
  })) });
  useEffect(() => {
    for (const receipt of commandReceipts) {
      if (!receipt.data) continue;
      const { commandKey, job } = receipt.data;
      forgetSyncCommand(job.productId, commandKey);
      if (localSyncIssues.get(job.productId)?.commandKey !== commandKey) continue;
      // The server resolves exact command membership, including commands that
      // coalesced into an older active job. A product's old completion is no proof.
      void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listings/sync-jobs"], exact: true });
      setLocalSyncIssues((previous) => {
        if (previous.get(job.productId)?.commandKey !== commandKey) return previous;
        const next = new Map(previous); next.delete(job.productId); return next;
      });
    }
  }, [commandReceipts, localSyncIssues, queryClient]);

  const syncCommandStorageKey = (productId: number) => `channel-listing-sync-command:${user?.id}:${config?.channel?.id}:${productId}`;
  function readSavedSyncCommand(productId: number): string | null {
    const current = sessionStorage.getItem(syncCommandStorageKey(productId));
    if (current) return z.string().uuid().parse(current);
    // Preserve unacknowledged requests from the retired Push UI. The server
    // verifies requester/account scope before replaying these exact commands.
    const legacy = sessionStorage.getItem(`ebay:publication-command:${productId}`);
    if (!legacy) return null;
    const command = z.object({ productId: z.literal(productId), commandKey: z.string().uuid() }).strict().parse(JSON.parse(legacy));
    return command.commandKey;
  }
  useEffect(() => {
    if (!user?.id || !config?.channel?.id || !feedData?.feed) return;
    const recovered = new Map<number, { issue: EbayListingIssue; commandKey: string | null }>();
    try {
      for (const product of feedData.feed) {
        const key = readSavedSyncCommand(product.id);
        if (key) recovered.set(product.id, { commandKey: z.string().uuid().parse(key),
          issue: resolveEbayListingIssue({ code: "EBAY_SYNC_ADMISSION_UNSAVED", productId: product.id }) });
      }
    } catch {
      toast({ title: "Saved sync request could not be read", description: "Allow browser storage and reload before starting another sync. Existing server requests remain available in sync progress.", variant: "destructive" });
      return;
    }
    if (recovered.size) setLocalSyncIssues(previous => new Map([...previous, ...recovered]));
  }, [user?.id, config?.channel?.id, feedData?.feed, toast]);
  function forgetSyncCommand(productId: number, commandKey: string) {
    try {
      if (sessionStorage.getItem(syncCommandStorageKey(productId)) === commandKey) sessionStorage.removeItem(syncCommandStorageKey(productId));
      const legacyKey = `ebay:publication-command:${productId}`;
      const legacy = sessionStorage.getItem(legacyKey);
      if (legacy) {
        const command = z.object({ productId: z.literal(productId), commandKey: z.string().uuid() }).strict().parse(JSON.parse(legacy));
        if (command.commandKey === commandKey) sessionStorage.removeItem(legacyKey);
      }
    }
    catch {
      // Retain the key so the next request can only replay the exact server receipt.
      toast({ title: "Sync saved; browser recovery key retained", description: "Allow browser storage and reload before requesting another update.", variant: "destructive" });
    }
  }
  const syncProductMutation = useMutation({
    mutationFn: async ({ productId, commandKey }: { productId: number; commandKey: string }) => {
      const resp = await apiRequest("POST", `/api/ebay/listings/sync-product/${productId}`, { commandKey });
      return ebayProductSyncResultSchema.parse(await resp.json());
    },
    onSuccess: (data, { productId, commandKey }) => {
      setSyncingProductIds((prev) => { const next = new Set(prev); next.delete(productId); return next; });
      const { synced, priceChanges, qtyChanges, errors, pending } = data;
      const changes: string[] = [];
      if (priceChanges > 0) changes.push(`${priceChanges} price`);
      if (qtyChanges > 0) changes.push(`${qtyChanges} qty`);
      const changeStr = changes.length > 0 ? `: ${changes.join(", ")} updated` : "";
      const errorMessage = data.details.find(detail => !detail.success && detail.error)?.error;
      const failure = data.details.find(detail => !detail.success);
      const savedJob = data.jobs.find((candidate) => candidate.productId === productId);
      if (savedJob || data.errors === 0 && data.pending === 0) forgetSyncCommand(productId, commandKey);
      setLocalSyncIssues((previous) => {
        const current = previous.get(productId);
        if (current?.commandKey && current.commandKey !== commandKey) return previous;
        const next = new Map(previous);
        if (failure && !savedJob) next.set(productId, { issue: failure.issue ?? resolveEbayListingIssue({ code: failure.code, message: failure.error, productId }), commandKey });
        else next.delete(productId);
        return next;
      });
      toast({
        title: errors > 0 ? (synced > 0 ? "Sync Incomplete" : "Sync Needs Attention") : pending > 0 ? "Sync Saved" : (synced > 0 ? "Product Synced" : "Nothing to Sync"),
        description: errors > 0
          ? `${synced} variant${synced !== 1 ? "s" : ""} synced; ${errors} error${errors !== 1 ? "s" : ""}. ${errorMessage || "Open the listing's next step below to resolve the problem."}`
          : pending > 0 ? "Your update is saved. Echelon will process it and recover interrupted work automatically. Progress remains available after you leave this page."
          : `Synced ${synced} variant${synced !== 1 ? "s" : ""}${changeStr}`,
        ...(errors > 0 ? { variant: "destructive" as const } : {}),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/effective-prices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listings/sync-jobs"] });
    },
    onError: (err: Error, { productId, commandKey }) => {
      setSyncingProductIds((prev) => { const next = new Set(prev); next.delete(productId); return next; });
      const issue = listingSyncIssueFromError(err, productId);
      setLocalSyncIssues((previous) => {
        const current = previous.get(productId);
        if (current?.commandKey && current.commandKey !== commandKey) return previous;
        return new Map(previous).set(productId, { issue, commandKey });
      });
      toast({ title: "Sync Failed", description: `${issue.message} ${issue.nextStep}`, variant: "destructive" });
    },
  });

  const handleSyncProduct = (productId: number, commandKey?: string) => {
    if (syncJobsQuery.isError || syncJobsQuery.isPending || feedError) {
      toast({ title: "Refresh saved status first", description: "Refresh the listing feed and saved requests before starting another sync." });
      return;
    }
    try {
      if (!user?.id || !config?.channel?.id) throw new Error("The channel session is not ready.");
      const saved = readSavedSyncCommand(productId);
      const key = z.string().uuid().parse(saved ?? commandKey ?? crypto.randomUUID());
      if (saved && commandKey && saved !== commandKey) throw new Error("An earlier sync request must be checked first.");
      sessionStorage.setItem(syncCommandStorageKey(productId), key);
      setSyncingProductIds((prev) => new Set([...prev, productId]));
      syncProductMutation.mutate({ productId, commandKey: key });
    } catch {
      toast({ title: "Sync request not sent", description: "Echelon could not retain this request safely. Allow browser storage, reload the page, then check the saved request before retrying.", variant: "destructive" });
    }
  };

  const clearUntrackedLocalIssue = (productId: number) => {
    setLocalSyncIssues(previous => {
      // Mapping/recovery completion proves its own command only. An unrelated
      // unconfirmed sync must keep its exact receipt check and retry identity.
      if (previous.get(productId)?.commandKey !== null) return previous;
      const next = new Map(previous); next.delete(productId); return next;
    });
  };

  const [publicationStatusTarget, setPublicationStatusTarget] = useState<{ jobId: string; productId: number; name: string } | null>(null);
  const [checkingRecovery, setCheckingRecovery] = useState(false);
  const [withdrawalRetryRequests, setWithdrawalRetryRequests] = useState<Map<number, number>>(new Map());
  const retryWithdrawal = (productId: number) => setWithdrawalRetryRequests(previous => new Map(previous).set(productId, (previous.get(productId) ?? 0) + 1));
  const withdrawalRetryHandled = (productId: number, request: number) => setWithdrawalRetryRequests(previous => {
    if (previous.get(productId) !== request) return previous;
    const next = new Map(previous); next.delete(productId); return next;
  });
  const continueSavedRecovery = async () => {
    if (!recoveryTarget || checkingRecovery) return;
    if (!recoveryTarget.jobId) { handleSyncProduct(recoveryTarget.productId); return; }
    setCheckingRecovery(true);
    try {
      const { job } = z.object({ job: ebayListingSyncJobSchema }).parse(await (await apiRequest("GET", `/api/ebay/listings/sync-jobs/${recoveryTarget.jobId}`)).json());
      if (job.id !== recoveryTarget.jobId || job.productId !== recoveryTarget.productId) throw new Error("The saved request does not match this product.");
      // A withdrawal must never enter ordinary sync or publish. Its exact saved
      // status owns continuation; a terminal failure offers the removal retry.
      if (job.operation === "withdraw" || ["queued", "running", "recovering", "completed"].includes(job.state)) {
        setPublicationStatusTarget({ jobId: job.id, productId: job.productId, name: recoveryTarget.name });
        setRecoveryTarget(null);
      } else {
        setRecoveryTarget(null);
        handleSyncProduct(job.productId);
      }
    } catch {
      toast({ title: "Saved request could not be checked", description: "Refresh this recovery view and try again. No new listing operation was sent.", variant: "destructive" });
    } finally { setCheckingRecovery(false); }
  };

  const handleIssueAction = (issue: EbayListingIssue, productId: number, jobId?: string) => {
    const item = feedData?.feed.find((candidate) => candidate.id === productId);
    if (issue.action.kind === "review_publication_stock") {
      // Compatibility with an older response: current code, not the retired
      // enrollment action, decides whether to publish or correct inventory.
      const current = resolveEbayListingIssue({ code: issue.code, message: issue.message, productId, jobId: issue.reference ?? jobId });
      if (current.action.href) window.location.assign(current.action.href);
      else handleIssueAction(current, productId, jobId);
      return;
    }
    // An admission refusal may point to an older publication that is blocking
    // this new request. Its explicit reference takes precedence over the refusal.
    const referencedJobId = issue.reference && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(issue.reference) ? issue.reference : undefined;
    if (issue.action.kind === "check_status") {
      const savedId = referencedJobId ?? jobId ?? latestSyncJobs.get(productId)?.id;
      if (savedId) setPublicationStatusTarget({ jobId: savedId, productId, name: item?.name ?? `Product ${productId}` });
      else void syncJobsQuery.refetch().then(result => {
        const saved = result.data?.find(candidate => candidate.productId === productId);
        if (saved) setPublicationStatusTarget({ jobId: saved.id, productId, name: item?.name ?? `Product ${productId}` });
        else toast({ title: "Saved publishing status unavailable", description: "Refresh the listing feed to load this request's reference. No new publication was sent.", variant: "destructive" });
      });
      return;
    }
    if (issue.action.kind === "retry_sync" && issue.retryable) {
      const local = localSyncIssues.get(productId);
      const commandKey = local?.issue.code === issue.code ? local.commandKey ?? undefined : undefined;
      // This key belongs to the exact local sync whose response was lost. An
      // older job's operation must not redirect that retry to publish/withdraw.
      if (commandKey) handleSyncProduct(productId, commandKey);
      else if (latestSyncJobs.get(productId)?.operation === "withdraw") retryWithdrawal(productId);
      else handleSyncProduct(productId);
      return;
    }
    if (issue.action.kind === "check_recovery" || issue.action.kind === "review_mapping") {
      const savedJobId = referencedJobId ?? jobId ?? latestSyncJobs.get(productId)?.id;
      setRecoveryTarget({ jobId: savedJobId ?? null, productId, name: item?.name ?? `Product ${productId}`, issue, mode: issue.action.kind === "review_mapping" ? "mapping" : "recovery" });
      return;
    }
    setExpandedProducts((previous) => new Set(previous).add(productId));
    document.getElementById(`ebay-product-${productId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
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
      const raw = err.message || "Unknown error";
      const isHtml = raw.includes("<!DOCTYPE") || raw.includes("<html");
      const description = isHtml ? "eBay server returned an error page. Check server logs." : raw.length > 200 ? raw.substring(0, 200) + "…" : raw;
      toast({ title: "Verification Failed", description, variant: "destructive" });
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
    mutationFn: async ({ productId, patch, expectedPolicies, expectedScope }: { productId: number; patch: EbayPolicyPatch; expectedPolicies: EbayPolicyValues; expectedScope?: EbayPolicyScope }) => {
      const resp = await apiRequest("PUT", `/api/ebay/product-policies/${productId}`, { ...patch, expectedPolicies, expectedScope });
      return resp.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      toast({ title: "Product Policies Updated" });
    },
    onError: (err: Error) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      void refetchPolicies();
      toast({ title: "Error", description: listingIssueFromError(err).message, variant: "destructive" });
    },
  });

  const saveVariantPoliciesMutation = useMutation({
    mutationFn: async ({ variantId, patch, expectedPolicies, expectedScope }: { variantId: number; patch: EbayPolicyPatch; expectedPolicies: EbayPolicyValues; expectedScope?: EbayPolicyScope }) => {
      const resp = await apiRequest("PUT", `/api/ebay/variant-policies/${variantId}`, { ...patch, expectedPolicies, expectedScope });
      return resp.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      toast({ title: "Variant Policies Updated" });
    },
    onError: (err: Error) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      void refetchPolicies();
      toast({ title: "Error", description: listingIssueFromError(err).message, variant: "destructive" });
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
  const [pricingRuleBaseline, setPricingRuleBaseline] = useState<PricingRule[]>([]);
  const [pricingScopeSearch, setPricingScopeSearch] = useState("");
  const [pricingError, setPricingError] = useState("");
  const [pricingReloading, setPricingReloading] = useState(false);
  const [pricingReloaded, setPricingReloaded] = useState(false);

  async function reloadSavedPricingRules() {
    setPricingReloading(true);
    setPricingReloaded(false);
    try {
      const result = await refetchPricingRules({ throwOnError: true });
      if (!result.data) throw new Error("The server did not return the saved pricing rules.");
      setPricingRuleBaseline(result.data.rules.map((rule) => ({ ...rule })));
      setPricingError("");
      setPricingReloaded(true);
    } catch (error) {
      setPricingError(error instanceof Error ? error.message : "Saved pricing rules could not be reloaded. Try again.");
    } finally {
      setPricingReloading(false);
    }
  }

  const upsertPricingRuleMutation = useMutation({
    mutationFn: async (rule: {
      scope: string;
      scopeId: string | null;
      ruleType: string;
      value: string;
      expected: { id: number; ruleType: PricingRule["rule_type"]; value: string } | null;
    }) => {
      return publicationRequest(
        "PUT", "/api/ebay/pricing-rules", z.object({ rule: pricingRuleSchema }), rule,
      );
    },
    onSuccess: async ({ rule }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/ebay/pricing-rules"] });
      queryClient.setQueryData<{ rules: PricingRule[] }>(["/api/ebay/pricing-rules"], (current) => {
        const previous = current?.rules.find((saved) => saved.id === rule.id);
        const acknowledged = { ...previous, ...rule };
        return {
          rules: [
            ...(current?.rules ?? []).filter((saved) =>
              saved.id !== rule.id && !(saved.scope === rule.scope && saved.scope_id === rule.scope_id),
            ),
            acknowledged,
          ],
        };
      });
      toast({ title: "Pricing Rule Saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/pricing-rules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/effective-prices"] });
      setShowPricingForm(false);
      setPricingError("");
      setPricingReloaded(false);
      setPricingRuleForm({ scope: "channel", scopeId: "", ruleType: "percentage", value: "" });
    },
    onError: (err: Error) => {
      setPricingError(err.message);
      setPricingReloaded(false);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deletePricingRuleMutation = useMutation({
    mutationFn: async (rule: PricingRule) => {
      return publicationRequest(
        "DELETE", `/api/ebay/pricing-rules/${rule.id}`, z.object({ success: z.literal(true) }),
        { expected: { id: rule.id, ruleType: rule.rule_type, value: String(rule.value) } },
      );
    },
    onSuccess: async (_result, deleted) => {
      await queryClient.cancelQueries({ queryKey: ["/api/ebay/pricing-rules"] });
      queryClient.setQueryData<{ rules: PricingRule[] }>(["/api/ebay/pricing-rules"], (current) => ({
        rules: (current?.rules ?? []).filter((rule) => rule.id !== deleted.id),
      }));
      setPricingError("");
      setPricingReloaded(false);
      toast({ title: "Pricing Rule Deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/pricing-rules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/effective-prices"] });
    },
    onError: (err: Error) => {
      setPricingError(err.message);
      setPricingReloaded(false);
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
  const parsedConnectionIssue = ebayListingIssueSchema.safeParse(config?.connectionIssue);
  const connectionIssue = parsedConnectionIssue.success ? parsedConnectionIssue.data
    : config?.connectionHealth === "needs_attention"
      ? resolveEbayListingIssue({ code: "EBAY_AUTH_RESPONSE_INVALID", message: "The eBay connection could not be verified. Refresh the connection check to load its current details." })
      : null;
  const hasPolicies = !!(
    config?.config?.fulfillmentPolicyId &&
    config?.config?.returnPolicyId &&
    config?.config?.paymentPolicyId
  );

  const filteredFeed = useMemo(() => {
    if (!feedData?.feed) return [];
    // Category exclusion does not hide an unfinished operation or its recovery controls.
    let items = feedData.feed.filter(i => i.status !== "type_disabled" || (latestSyncJobs.get(i.id)?.state && latestSyncJobs.get(i.id)?.state !== "completed") || listingNeedsAttention(i,latestSyncJobs.get(i.id),localSyncIssues.has(i.id)));
    if (feedFilter === "excluded") {
      items = items.filter((i) => i.status === "excluded");
    } else if (feedFilter === "missing_specifics") {
      items = items.filter((i) => i.status === "missing_specifics");
    } else if (feedFilter === "ended") {
      items = items.filter((i) => i.status === "ended" || i.status === "deleted");
    } else if (feedFilter === "errors") {
      items = items.filter((i) => listingNeedsAttention(i, latestSyncJobs.get(i.id), localSyncIssues.has(i.id)));
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
  }, [feedData, feedFilter, feedSearch, latestSyncJobs, localSyncIssues]);

  const feedCounts = useMemo(() => {
    if (!feedData?.feed) return { all: 0, ready: 0, missing_config: 0, missing_specifics: 0, listed: 0, excluded: 0, ended: 0, errors: 0 };
    const feed = feedData.feed.filter(i => i.status !== "type_disabled" || (latestSyncJobs.get(i.id)?.state && latestSyncJobs.get(i.id)?.state !== "completed") || listingNeedsAttention(i,latestSyncJobs.get(i.id),localSyncIssues.has(i.id)));
    return {
      all: feed.length,
      ready: feed.filter((f) => f.status === "ready" && !["queued", "running", "recovering"].includes(latestSyncJobs.get(f.id)?.state ?? "")).length,
      missing_config: feed.filter((f) => f.status === "missing_config").length,
      missing_specifics: feed.filter((f) => f.status === "missing_specifics").length,
      listed: feed.filter((f) => f.status === "listed").length,
      excluded: feed.filter((f) => f.status === "excluded").length,
      ended: feed.filter((f) => f.status === "ended" || f.status === "deleted").length,
      errors: feed.filter((f) => listingNeedsAttention(f, latestSyncJobs.get(f.id), localSyncIssues.has(f.id))).length,
    };
  }, [feedData, latestSyncJobs, localSyncIssues]);

  const includedListingCount = (feedData?.feed ?? []).filter((item) =>
    !item.isExcluded && item.status !== "type_disabled",
  ).length;

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
            <Button className="mt-3" variant="outline" onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] })}>Reload connection settings</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-2 sm:p-4 md:p-6 space-y-4 sm:space-y-6 max-w-6xl mx-auto" onClickCapture={handlePolicyAnchorClick}>
      {/* Page Header */}
      <ChannelWorkspaceHeader name="eBay" description="Store setup, category mapping, and listing feed" />
      <ChannelSyncProgress controller={syncBatches} canEdit={hasPermission("channels", "edit")}
        onReview={item => {
          if (item.operationId) setPublicationStatusTarget({ jobId: item.operationId, productId: item.productId, name: item.name });
          else window.location.assign(`/products/${item.productId}`);
        }} />
      {config?.channel?.id && <ListingIntentChanges scope={{ kind: "channel", channelId: config.channel.id }}
        canEdit={hasPermission("channels", "edit")}
        onReview={row => {
          const product = feedData?.feed.find(item => item.id === row.product_id);
          if (product) setListingChangesTarget(product);
          else window.location.assign(`/products/${row.product_id}`);
        }}
        onOpenWork={(row,action) => {
          const name = feedData?.feed.find(item => item.id === row.product_id)?.name ?? `Product ${row.product_id}`;
          if (action.owner === "ebay_listing_sync" && action.operationId) {
            setPublicationStatusTarget({ jobId:action.operationId,productId:row.product_id,name }); return true;
          }
          if (action.owner === "listing_mapping") {
            setRecoveryTarget({jobId:null,productId:row.product_id,name,issue:null,mode:"mapping"}); return true;
          }
          return false;
        }}
        onOpenOperation={row => {
          if (row.receipt?.owner === "ebay_listing_sync") setPublicationStatusTarget({
            jobId: row.receipt.operationId, productId: row.product_id,
            name: feedData?.feed.find(item => item.id === row.product_id)?.name ?? `Product ${row.product_id}`,
          });
        }} />}

      {/* ================================================================== */}
      {/* SECTION 1: Store Setup                                             */}
      {/* ================================================================== */}
      <Card id="ebay-store-setup">
        <CardHeader className="px-3 sm:px-6">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Store Setup
          </CardTitle>
          <CardDescription>Connection, location, and default business policies</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 px-3 sm:px-6">
          {/* Connection Status */}
          <div id="connection">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground font-medium">Connection</Label>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 mt-2">
              <div className="flex items-center gap-3 flex-1">
                {config?.connectionHealth === "needs_attention" ? (
                  <Badge variant="outline" className="border-amber-500 text-amber-800 dark:text-amber-300 gap-1.5 py-1 px-3">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Connection needs attention
                  </Badge>
                ) : config?.connected && config.connectionHealth !== "not_connected" ? (
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
                onClick={() => window.open(config?.channel?.id ? `/api/ebay/oauth/consent?channelId=${config.channel.id}` : "/api/ebay/oauth/consent", "_blank", "noopener,noreferrer")}
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                {config?.connected ? "Reconnect" : "Connect eBay"}
              </Button>
              <Button variant="outline" size="sm" disabled={configFetching} onClick={() => {
                void queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] });
                void refetchPolicies();
                void refetchStoreCats();
              }}>Refresh connection</Button>
            </div>
            {connectionIssue && <div className="mt-3"><EbayListingIssueCard issue={connectionIssue} busy={configFetching} onAction={(issue) => {
              if (issue.action.kind === "retry_sync" && issue.retryable) void queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] });
            }} /></div>}
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

          {policiesError && <div role="alert" className="space-y-2 rounded-md border border-amber-300 p-3 text-sm">
            <p className="font-medium">eBay business policies could not be loaded</p>
            <p>Reload the policies before changing shipping, returns or payment settings. If authorization has expired, reconnect the eBay account above.</p>
            <Button variant="outline" size="sm" onClick={() => refetchPolicies()}>Reload business policies</Button>
          </div>}

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
          <div id="business-policies">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground font-medium">Default Business Policies</Label>
            {!config?.connected ? (
              <p className="text-sm text-muted-foreground mt-2">Connect to eBay to load policies.</p>
            ) : (
              <div className="mt-2 space-y-3">
                <EbayPolicyFields values={storePolicyDraft.values} catalog={policies} status={policyCatalogStatus}
                  labelPrefix="Store defaults" disabled={savePoliciesMutation.isPending} onChange={storePolicyDraft.change} />
                {storePolicyDraft.dirty && storePolicyDraft.changedElsewhere && <PolicyDraftConflict onReload={storePolicyDraft.reload} />}
                <Button size="sm" onClick={() => savePoliciesMutation.mutate()} disabled={savePoliciesMutation.isPending
                  || policyCatalogStatus !== "ready" || !storePolicyDraft.dirty || storePolicyDraft.changedElsewhere}>
                  {savePoliciesMutation.isPending ? "Saving…" : "Save Policies"}
                </Button>
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
                                    ) : aspectsReady === false && missingRequiredCount === -1 ? (
                                      <Badge variant="outline" className="text-amber-600 border-amber-300 hover:bg-amber-50 text-xs gap-1 cursor-pointer">
                                        <AlertCircle className="h-3 w-3" />
                                        Load specifics
                                      </Badge>
                                    ) : aspectsReady === false && missingRequiredCount != null && missingRequiredCount > 0 ? (
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
                                      key={`aspects-${pt.slug}-${mapping.ebayBrowseCategoryId}`}
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
                                        Policy overrides for {pt.name} (inherit store defaults when unset)
                                      </p>
                                      <div data-policy-category={pt.slug}><EbayPolicyFields values={categoryPolicyValues(mapping)} catalog={policies} status={policyCatalogStatus}
                                        labelPrefix={`${pt.name} category`} inheritLabel="Use store default"
                                        disabled={saveMappingsMutation.isPending || policyCatalogStatus !== "ready"} onChange={patch => updateMapping(pt.slug, categoryPolicyPatch(patch))} /></div>
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
                            ) : aspectsReady === false && missingRequiredCount === -1 ? (
                              <Badge variant="outline" className="text-amber-600 border-amber-300 hover:bg-amber-50 text-xs gap-1 cursor-pointer py-1.5 px-3">
                                <AlertCircle className="h-3 w-3" />
                                Load specifics
                              </Badge>
                            ) : aspectsReady === false && missingRequiredCount != null && missingRequiredCount > 0 ? (
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
                            key={`aspects-mobile-${pt.slug}-${mapping.ebayBrowseCategoryId}`}
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
                            Policy overrides (inherit store defaults when unset)
                          </p>
                          <div data-policy-category={pt.slug}><EbayPolicyFields values={categoryPolicyValues(mapping)} catalog={policies} status={policyCatalogStatus}
                                        labelPrefix={`${pt.name} category`} inheritLabel="Use store default"
                                        disabled={saveMappingsMutation.isPending || policyCatalogStatus !== "ready"} onChange={patch => updateMapping(pt.slug, categoryPolicyPatch(patch))} /></div>
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
              {categoryPoliciesChangedElsewhere && <PolicyDraftConflict onReload={reloadCategoryPolicies} />}
              {mappingsDirty && (
                <div className="flex items-center gap-3 mt-4">
                  <Button
                    onClick={() => saveMappingsMutation.mutate()}
                    disabled={saveMappingsMutation.isPending || policyCatalogStatus !== "ready" || categoryPoliciesChangedElsewhere}
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
                disabled={!hasPermission("channels", "edit") || includedListingCount === 0 || !!feedError || syncJobsQuery.isError || syncJobsQuery.isPending || syncBatches.query.isError || syncBatches.query.isPending || syncBatches.starting || syncBatches.permissionDenied}
                onClick={handleSyncAll}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Sync All ({includedListingCount})
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 sm:flex-none min-h-[44px] sm:min-h-0"
                disabled={feedCounts.listed === 0 || !!feedError || reconcileMutation.isPending}
                onClick={() => reconcileMutation.mutate()}
              >
                {reconcileMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4 mr-2" />
                )}
                Verify ({feedCounts.listed})
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          {!config?.connected ? (
            <p className="text-sm text-muted-foreground">Connect to eBay first.</p>
          ) : feedError ? (
            <div role="alert" className="space-y-2 rounded-md border border-red-300 p-3 text-sm">
              {feedReadIssue && <EbayListingIssueCard issue={feedReadIssue} />}
              <Button variant="outline" size="sm" disabled={feedFetching} onClick={() => refetchFeed()}>{feedFetching ? "Reloading listings…" : "Reload listings"}</Button>
            </div>
          ) : feedLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading listing feed...
            </div>
          ) : (
            <>
              {syncJobsQuery.isError && (
                <div role="alert" className="mb-3 space-y-2 rounded-md border border-amber-300 p-3 text-sm">
                  <p className="font-medium">Saved sync status is unavailable</p>
                  <p>We cannot tell whether an update is still running or needs your attention. Refresh its status before starting another sync or publication.</p>
                  <Button variant="outline" size="sm" onClick={() => syncJobsQuery.refetch()}>Refresh sync status</Button>
                </div>
              )}
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

              {(registrationStatusesError || registrationStatusConfigurationUnavailable) && (
                <div className="mb-3 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/20 dark:text-red-300">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">Listing change analysis is unavailable</p>
                    <p className="mt-0.5 text-xs">Echelon could not determine whether listing changes require an update or replacement. Refresh the page or try again later.</p>
                  </div>
                </div>
              )}

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
                      const syncJob = latestSyncJobs.get(item.id);
                      const syncPending = syncJob && !syncJob.readRetryPaused && ["queued","running","recovering"].includes(syncJob.state);
                      const publicationPending = (syncPending || syncJob?.readRetryPaused) && syncJob?.operation === "publish";
                      const withdrawalJob = syncJob?.operation === "withdraw" ? syncJob : null;
                      const withdrawalUnfinished = withdrawalJob != null && withdrawalJob.state !== "completed";
                      const savedSyncIssue = syncJob ? resolveEbayListingJobIssue(syncJob) : null;
                      const syncIssue = item.priceIssue ?? localSyncIssues.get(item.id)?.issue ?? (syncJob && (syncJob.readRetryPaused || ["awaiting_evidence", "needs_attention"].includes(syncJob.state))
                        ? savedSyncIssue
                        : item.status === "error" && item.syncError && !syncPending
                          ? resolveEbayListingIssue({ message: item.syncError, productId: item.id }) : null);
                      // Sync admission checks saved responses and current settings;
                      // requesting that check does not bypass the provider-write guard.
                      // A saved blocker may have been corrected. Sync rechecks it
                      // through the owner; the UI never overrides write barriers.
                      const canSyncExistingListing = !withdrawalUnfinished;
                      const syncExistingListing = () => handleSyncProduct(item.id, localSyncIssues.get(item.id)?.commandKey ?? undefined);
                      const isExcluded = item.isExcluded;
                      const readinessSyncAction = ["missing_config", "missing_specifics", "ended", "deleted"].includes(item.status)
                        && !syncPending && !isExcluded ? (
                          <Button variant="outline" size="sm" className="min-h-11 text-xs"
                            disabled={withdrawalUnfinished || syncingProductIds.has(item.id) || syncJobsQuery.isError || syncJobsQuery.isPending}
                            onClick={event => { event.stopPropagation(); syncExistingListing(); }}>
                            <RefreshCw className="h-4 w-4 mr-1" />Sync
                          </Button>
                        ) : null;
                      const isExpanded = expandedProducts.has(item.id);
                      const hasVariants = item.variants && item.variants.length > 0;
                      const allIncluded = item.includedVariantCount === item.variantCount;
                      const someExcluded = item.includedVariantCount < item.variantCount && item.includedVariantCount > 0;
                      const registrationStatus = registrationStatusByProductId.get(item.id) ?? null;
                      const registrationStatusUnavailable = registrationStatusQueryInput === null
                        || registrationStatusesError !== null;
                      const registrationStatusChecking = !registrationStatusUnavailable
                        && (registrationStatusesLoading || registrationStatusesFetching);
                      const reconciliation = registrationStatusUnavailable || registrationStatusChecking
                        ? null
                        : reconcileMarketplaceListing({
                            externalListingId: item.externalListingId,
                            desiredVariantIds: item.variants
                              .filter((variant) => variant.effectivelyListed)
                              .map((variant) => variant.id),
                            registration: registrationStatus,
                          });
                      const hasProvenListingChanges = Boolean(
                        item.externalListingId
                        && (
                          reconciliation?.kind === "replacement_required"
                          || reconciliation?.kind === "update_available"
                          || reconciliation?.kind === "verification_required"
                        )
                      );
                      const needsInitialVariantCheck = Boolean(
                        item.externalListingId
                        && reconciliation?.kind === "normal"
                        && someExcluded
                      );
                      const reconciliationAction = hasProvenListingChanges
                        ? "Review listing changes"
                        : needsInitialVariantCheck
                          ? "Check eBay variants"
                          : reconciliation?.kind === "normal" && item.status === "error"
                            ? "Analyze listing"
                            : null;
                      const runReconciliationAction = () => {
                        if (hasProvenListingChanges || needsInitialVariantCheck) {
                          setListingChangesTarget(item);
                          return;
                        }
                        if (reconciliation?.kind === "normal") {
                          setRegistrationTarget(item);
                        }
                      };


                      return (
                        <React.Fragment key={item.id}>
                        <TableRow
                          id={`ebay-product-${item.id}`}
                          className={`sm:table-row flex flex-col p-3 sm:p-0 gap-2 sm:gap-0 ${isExcluded ? "opacity-50" : ""} cursor-pointer hover:bg-muted/50`}
                          onClick={() => toggleProductExpanded(item.id)}
                        >
                          {/* Expand chevron + Exclude toggle */}
                          <TableCell className="sm:table-cell flex items-center sm:w-[40px] py-0 sm:py-2">
                            <div className="flex items-center gap-2 min-h-[44px] sm:min-h-0" onClick={(e) => e.stopPropagation()}>
                              <button
                                className="p-1 hover:bg-muted rounded min-w-[28px] min-h-[28px] flex items-center justify-center"
                                onClick={() => toggleProductExpanded(item.id)}
                                aria-label={`Policy and variant settings for ${item.name}`} aria-expanded={isExpanded}
                              >
                                {isExpanded ? (
                                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                  )}
                              </button>
                              <EbayProductListingIntentControl productId={item.id} productName={item.name} excluded={isExcluded} currentJob={syncJob}
                                disabled={syncJobsQuery.isError || syncJobsQuery.isPending} retryRequested={withdrawalRetryRequests.get(item.id)} onRetryHandled={withdrawalRetryHandled} onIssueAction={handleIssueAction}
                                onSync={() => handleSyncProduct(item.id)}
                                onSyncSaved={batchId => { syncBatches.setSelectedId(batchId); syncBatches.setOpen(true); void syncBatches.query.refetch(); }} />
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
                            {syncJob && (syncJob.state !== "completed" || syncJob.inventoryReconciliation) && (
                              <div className="mt-1"><EbayListingJobProgress job={syncJob} label={`Sync status for ${item.name}`}
                                detail={syncPending ? savedSyncIssue?.message : null} /></div>
                            )}
                            {syncJob && (syncJob.state !== "completed" || syncJob.inventoryReconciliation) && syncJob.operation === "sync" && syncIssue?.action.kind !== "check_status" && <Button variant="outline" size="sm" className="min-h-[44px] mt-1 text-xs" onClick={event => {
                              event.stopPropagation();
                              setPublicationStatusTarget({ jobId: syncJob.id, productId: item.id, name: item.name });
                            }}>View update status</Button>}
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
                              {publicationPending && <><Badge className="bg-blue-600 text-xs">{syncJob.readRetryPaused ? "Publishing needs attention" : "Publishing"}</Badge><Button variant="outline" size="sm" className="min-h-[44px] px-3 text-xs" onClick={event => { event.stopPropagation(); setPublicationStatusTarget({ jobId: syncJob.id, productId: item.id, name: item.name }); }}>View publishing status</Button></>}
                              {item.status === "publication_incomplete" && !publicationPending && <>
                                <Badge variant="outline" className="text-amber-700 border-amber-300 text-xs">Publication incomplete</Badge>
                                <Button variant="outline" size="sm" className="min-h-[44px] px-3 text-xs"
                                  disabled={syncingProductIds.has(item.id) || !!syncPending || withdrawalUnfinished || syncJobsQuery.isError || syncJobsQuery.isPending}
                                  onClick={(event) => { event.stopPropagation(); syncExistingListing(); }} title="Sync this listing">
                                  {syncingProductIds.has(item.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                                  <span className="ml-1">Sync</span>
                                </Button>
                              </>}
                              {item.status === "ready" && !publicationPending && (
                                <>
                                  <Badge className="bg-green-600 hover:bg-green-600 text-xs py-1 px-2">Ready</Badge>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="min-h-[44px] min-w-[44px] px-3 text-xs"
                                    disabled={syncJobsQuery.isError || syncJobsQuery.isPending}
                                    onClick={(e) => { e.stopPropagation(); handleSyncProduct(item.id); }}
                                  >
                                    <RefreshCw className="h-4 w-4 mr-1" />
                                    Sync
                                  </Button>
                                </>
                              )}
                              {item.status === "error" && !syncPending && !syncIssue && (
                                <>
                                  <Badge variant="destructive" className="text-xs py-1 px-2">Error</Badge>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="min-h-[44px] min-w-[44px] px-3 text-xs"
                                    disabled={syncingProductIds.has(item.id) || syncJobsQuery.isError || syncJobsQuery.isPending}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleSyncProduct(item.id);
                                    }}
                                  >
                                    {syncingProductIds.has(item.id) ? (
                                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                    ) : (
                                      <RefreshCw className="h-4 w-4 mr-1" />
                                    )}
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
                              {item.status === "listed" && !publicationPending && (
                                <>
                                  <Badge className="bg-blue-600 hover:bg-blue-600 text-xs">Listed</Badge>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="min-h-[44px] min-w-[44px] px-3 text-xs"
                                    disabled={syncingProductIds.has(item.id) || !!syncPending || !canSyncExistingListing || syncJobsQuery.isError || syncJobsQuery.isPending}
                                    onClick={(e) => { e.stopPropagation(); syncExistingListing(); }}
                                    title="Sync this listing"
                                  >
                                    {syncingProductIds.has(item.id) ? (
                                      <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                      <RefreshCw className="h-4 w-4" />
                                    )}
                                    <span className="ml-1">Sync</span>
                                  </Button>
                                </>
                              )}
                              {(item.status === "ended" || item.status === "deleted") && (
                                <Badge variant="outline" className="text-red-600 border-red-300 text-xs">
                                  {item.status === "deleted" ? "Deleted" : "Ended"}
                                </Badge>
                              )}
                              {readinessSyncAction}
                              {item.status === "excluded" && <Badge variant="outline" className="text-muted-foreground text-xs">{withdrawalJob?.state === "completed" ? "Ended on eBay · excluded" : withdrawalJob ? "Excluded · removal pending" : "Excluded locally"}</Badge>}
                              {withdrawalJob && <Button variant="outline" size="sm" className="min-h-11 text-xs" onClick={event => { event.stopPropagation(); setPublicationStatusTarget({ jobId: withdrawalJob.id, productId: item.id, name: item.name }); }}>View removal status</Button>}
                              {reconciliationAction && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="min-h-[44px] px-3 text-xs"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    runReconciliationAction();
                                  }}
                                >
                                  {reconciliation?.kind === "replacement_required" && (
                                    <RefreshCw className="h-4 w-4 mr-1" />
                                  )}
                                  {reconciliationAction}
                                </Button>
                              )}
                            </div>
                            {/* Error message inline on mobile */}
                            {item.syncError && item.status === "error" && !syncIssue && (!syncJob || syncJob.state === "completed") && (
                              <p className="text-xs text-red-600 mt-1 sm:hidden line-clamp-2" title={item.syncError}>
                                {item.syncError}
                              </p>
                            )}
                            {item.externalListingIdentityConflict && (
                              <p className="text-xs text-red-600 mt-1 sm:hidden">
                                Conflicting active eBay listing IDs; registration is unavailable.
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
                                {publicationPending && <><Badge className="bg-blue-600 text-xs">{syncJob.readRetryPaused ? "Publishing needs attention" : "Publishing"}</Badge><Button variant="outline" size="sm" className="min-h-9 text-xs" onClick={event => { event.stopPropagation(); setPublicationStatusTarget({ jobId: syncJob.id, productId: item.id, name: item.name }); }}>View publishing status</Button></>}
                                {item.status === "publication_incomplete" && !publicationPending && <>
                                  <Badge variant="outline" className="text-amber-700 border-amber-300 text-xs">Publication incomplete</Badge>
                                  <Button variant="outline" size="sm" className="min-h-9 text-xs"
                                    disabled={syncingProductIds.has(item.id) || !!syncPending || withdrawalUnfinished || syncJobsQuery.isError || syncJobsQuery.isPending}
                                    onClick={(event) => { event.stopPropagation(); syncExistingListing(); }} title="Sync this listing">
                                    {syncingProductIds.has(item.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                    <span className="ml-1">Sync</span>
                                  </Button>
                                </>}
                                {item.status === "ready" && !publicationPending && (
                                  <>
                                    <Badge className="bg-green-600 hover:bg-green-600 text-xs">Ready</Badge>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-8 px-2"
                                      disabled={syncJobsQuery.isError || syncJobsQuery.isPending}
                                      onClick={(e) => { e.stopPropagation(); handleSyncProduct(item.id); }}
                                      title="Sync this product"
                                    >
                                      <RefreshCw className="h-3.5 w-3.5 mr-1" />Sync
                                    </Button>
                                  </>
                                )}
                                {item.status === "error" && !syncPending && !syncIssue && (
                                  <>
                                    <Badge variant="destructive" className="text-xs" title={item.syncError || undefined}>Error</Badge>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 w-6 p-0"
                                      disabled={syncingProductIds.has(item.id) || syncJobsQuery.isError || syncJobsQuery.isPending}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleSyncProduct(item.id);
                                      }}
                                      title={item.externalListingId ? "Retry listing sync" : "Retry push"}
                                    >
                                      {syncingProductIds.has(item.id) ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                      ) : (
                                        <RefreshCw className="h-3.5 w-3.5" />
                                      )}
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
                                {item.status === "listed" && !publicationPending && (
                                  <>
                                    <Badge className="bg-blue-600 hover:bg-blue-600 text-xs">Listed</Badge>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-8 px-2"
                                      disabled={syncingProductIds.has(item.id) || !!syncPending || !canSyncExistingListing || syncJobsQuery.isError || syncJobsQuery.isPending}
                                      onClick={(e) => { e.stopPropagation(); syncExistingListing(); }}
                                      title="Sync this listing"
                                    >
                                      {syncingProductIds.has(item.id) ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                      ) : (
                                        <RefreshCw className="h-3.5 w-3.5" />
                                      )}
                                      <span className="ml-1">Sync</span>
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
                                {readinessSyncAction}
                              {item.status === "excluded" && <Badge variant="outline" className="text-muted-foreground text-xs">{withdrawalJob?.state === "completed" ? "Ended on eBay · excluded" : withdrawalJob ? "Excluded · removal pending" : "Excluded locally"}</Badge>}
                                {withdrawalJob && <Button variant="outline" size="sm" className="min-h-9 text-xs" onClick={event => { event.stopPropagation(); setPublicationStatusTarget({ jobId: withdrawalJob.id, productId: item.id, name: item.name }); }}>View removal status</Button>}
                                {reconciliationAction && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 px-2 text-[11px]"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      runReconciliationAction();
                                    }}
                                  >
                                    {reconciliation?.kind === "replacement_required" && (
                                      <RefreshCw className="h-3.5 w-3.5 mr-1" />
                                    )}
                                    {reconciliationAction}
                                  </Button>
                                )}
                              </div>
                              {/* Error message inline — desktop */}
                              {item.syncError && item.status === "error" && !syncIssue && (!syncJob || syncJob.state === "completed") && (
                                <p className="text-[10px] text-red-600 max-w-[180px] truncate" title={item.syncError}>
                                  {item.syncError}
                                </p>
                              )}
                              {item.externalListingIdentityConflict && (
                                <p className="text-[10px] text-red-600 max-w-[180px]" title="Active variants reference different eBay listing IDs">
                                  Conflicting eBay listing IDs
                                </p>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        {item.externalListingId && !isExcluded && !!item.unlinkedVariants?.length && <TableRow className="block sm:table-row">
                          <TableCell colSpan={6} className="block sm:table-cell p-3">
                            <section aria-label={`Variants without a saved listing for ${item.name}`} className="rounded-md border p-3 text-sm space-y-2">
                              <p className="font-medium">Selected variants without a saved eBay listing: {item.unlinkedVariants.map(variant => variant.sku).join(", ")}</p>
                              <p>Sync updates the existing listing and its pictures. Review these variants to check whether they need to be added.</p>
                              <Button variant="outline" size="sm" disabled={!!syncPending || registrationStatusUnavailable || registrationStatusChecking}
                                onClick={() => setListingChangesTarget(item)}>Review variants</Button>
                            </section>
                          </TableCell>
                        </TableRow>}
                        {syncIssue && <TableRow className="block sm:table-row">
                          <TableCell colSpan={6} className="block sm:table-cell p-3">
                            {withdrawalJob && syncIssue.action.kind === "review_mapping" ? <EbayWithdrawalIssueCard issue={syncIssue}
                              onCheck={() => setPublicationStatusTarget({ jobId: withdrawalJob.id, productId: item.id, name: item.name })}
                              onRetry={withdrawalJob.state === "needs_attention" ? () => retryWithdrawal(item.id) : undefined} />
                              : <EbayListingIssueCard issue={syncIssue}
                                showTitle={!syncJob || syncJob.state === "completed" || presentEbayListingJob(syncJob).summary !== syncIssue.title}
                                busy={syncingProductIds.has(item.id)} onAction={(issue) => handleIssueAction(issue, item.id, syncJob?.id)} />}
                          </TableCell>
                        </TableRow>}
                        {item.inventoryIssue && <TableRow className="block sm:table-row">
                          <TableCell colSpan={6} className="block sm:table-cell p-3">
                            <section aria-label={`Inventory availability for ${item.name}`} className="space-y-2">
                              <p className="text-sm font-medium">Current inventory availability</p>
                              {syncIssue?.code === item.inventoryIssue.code && syncIssue.message === item.inventoryIssue.message
                                && syncIssue.reference === item.inventoryIssue.reference
                                && JSON.stringify(syncIssue.details) === JSON.stringify(item.inventoryIssue.details)
                                ? <p className="text-sm">The current inventory read encountered the same issue described above. Reload inventory after correcting it.</p>
                                : <EbayListingIssueCard issue={item.inventoryIssue}
                                onAction={["review_mapping", "check_status"].includes(item.inventoryIssue.action.kind)
                                  ? (issue) => handleIssueAction(issue, item.id, syncJob?.id) : undefined} />}
                              <Button variant="outline" size="sm" disabled={feedFetching} onClick={() => refetchFeed()}>{feedFetching ? "Reloading inventory…" : "Reload inventory"}</Button>
                            </section>
                          </TableCell>
                        </TableRow>}
                        {/* Expanded variant rows */}
                        {isExpanded && hasVariants && item.variants.map((variant) => (
                          <React.Fragment key={`v-${variant.id}`}>
                          <TableRow
                            className={`bg-muted/20 sm:table-row flex flex-col p-3 sm:p-0 gap-1 sm:gap-0 ${!variant.effectivelyListed ? "opacity-50" : ""}`}
                          >
                            <TableCell className="sm:table-cell flex items-center sm:w-[40px] py-0 sm:py-1.5 pl-8 sm:pl-10">
                              <Switch
                                checked={variant.effectivelyListed}
                                disabled={variant.excludedByProduct}
                                onCheckedChange={(checked) =>
                                  toggleVariantExclusionMutation.mutate({ variantId: variant.id, excluded: !checked })
                                }
                                className="scale-[0.65]"
                                title={variant.excludedByProduct ? "Excluded by product" : variant.explicitlyExcluded ? "Include variant" : "Exclude variant"}
                              />
                            </TableCell>
                            <TableCell className="sm:table-cell block py-0 sm:py-1.5" colSpan={2}>
                              <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
                                <span className={`text-xs font-medium ${!variant.effectivelyListed ? "line-through text-muted-foreground" : ""}`}>
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
                                  if (ep?.resolutionIssue) return <a className="text-xs text-destructive underline" href={ep.resolutionIssue.code.startsWith("RETAIL_") ? "/catalog/variants" : "/channels/ebay"} title={ep.resolutionIssue.message}>Price needs review</a>;
                                  if (effectivePricesUnavailable || !ep || ep.missingPrice || ep.basePriceCents === null || ep.effectivePriceCents === null)
                                    return <span className="text-xs text-muted-foreground">Price unavailable</span>;
                                if (ep && ep.effectivePriceCents !== ep.basePriceCents) {
                                  const pctDiff = ep.basePriceCents > 0 ? ((ep.effectivePriceCents - ep.basePriceCents) / ep.basePriceCents * 100).toFixed(0) : null;
                                  return (
                                    <span className="text-xs">
                                      <span className="text-muted-foreground line-through mr-1">{formatPrice(ep.basePriceCents)}</span>
                                      <span className="font-medium text-blue-600">{formatPrice(ep.effectivePriceCents)}</span>
                                      {pctDiff !== null && <span className="text-muted-foreground ml-1">(+{pctDiff}%)</span>}
                                    </span>
                                  );
                                }
                                return <span className="text-xs">{formatPrice(ep.effectivePriceCents)}</span>;
                              })()}
                            </TableCell>
                            {/* Qty — desktop */}
                            <TableCell className="hidden sm:table-cell py-1.5">
                              <span className="text-xs">{variant.inventoryQuantity === null ? "Unavailable" : `${variant.inventoryQuantity} qty`}</span>
                            </TableCell>
                            {/* Policy toggle — desktop */}
                            <TableCell className="hidden sm:table-cell py-1.5">
                              <button
                                className={`p-1 rounded hover:bg-muted min-w-[28px] min-h-[28px] flex items-center justify-center ${
                                  [variant.fulfillmentPolicyOverride, variant.returnPolicyOverride, variant.paymentPolicyOverride].some(value => value !== null && value !== undefined)
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
                                  if (ep?.resolutionIssue) return <a className="text-xs text-destructive underline" href={ep.resolutionIssue.code.startsWith("RETAIL_") ? "/catalog/variants" : "/channels/ebay"} title={ep.resolutionIssue.message}>Price needs review</a>;
                                  if (effectivePricesUnavailable || !ep || ep.missingPrice || ep.basePriceCents === null || ep.effectivePriceCents === null)
                                    return <span className="text-xs text-muted-foreground">Price unavailable</span>;
                                  if (ep && ep.effectivePriceCents !== ep.basePriceCents) {
                                    return (
                                      <>
                                        <span className="line-through">{formatPrice(ep.basePriceCents)}</span>
                                        <span className="text-blue-600 font-medium">{formatPrice(ep.effectivePriceCents)}</span>
                                      </>
                                    );
                                  }
                                  return <span>{formatPrice(ep.effectivePriceCents)}</span>;
                                })()}
                                <span>·</span>
                                <span>{variant.inventoryQuantity === null ? "Unavailable" : `${variant.inventoryQuantity} qty`}</span>
                                <button
                                  className={`p-1 rounded hover:bg-muted min-w-[44px] min-h-[44px] flex items-center justify-center ${
                                    [variant.fulfillmentPolicyOverride, variant.returnPolicyOverride, variant.paymentPolicyOverride].some(value => value !== null && value !== undefined)
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
                                  id={`ebay-variant-policies-${variant.id}`} catalogStatus={policyCatalogStatus}
                                  inheritLabel="Use product, category or store default"
                                  onSave={(patch, expectedPolicies, expectedScope) => saveVariantPoliciesMutation.mutateAsync({ variantId: variant.id, patch, expectedPolicies, expectedScope })}
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
                                id={`ebay-product-policies-${item.id}`} catalogStatus={policyCatalogStatus}
                                inheritLabel="Use category or store default"
                                onSave={(patch, expectedPolicies, expectedScope) => saveProductPoliciesMutation.mutateAsync({ productId: item.id, patch, expectedPolicies, expectedScope })}
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
                disabled={pricingReloading || (!showPricingForm && !pricingRulesData)}
                onClick={() => {
                  if (!showPricingForm) {
                    // Keep the snapshot the operator started editing, even if a
                    // background refresh returns a newer value before Save.
                    setPricingRuleBaseline((pricingRulesData?.rules ?? []).map((rule) => ({ ...rule })));
                    setPricingReloaded(false);
                  }
                  setShowPricingForm(!showPricingForm);
                }}
              >
                {showPricingForm ? "Cancel" : "Add Rule"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="px-3 sm:px-6">
            {(pricingError || pricingReadError) && (
              <div className="mb-3 space-y-2 text-sm">
                <p role="alert" className="text-destructive">{pricingError || pricingReadError?.message}</p>
                <p>{showPricingForm
                  ? "Your entered value and selection are retained. Reload the saved rules, review your change, then retry."
                  : "Reload the saved rules and review the current values before retrying."}</p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pricingReloading || upsertPricingRuleMutation.isPending || deletePricingRuleMutation.isPending}
                  onClick={() => void reloadSavedPricingRules()}
                >
                  {pricingReloading ? "Reloading saved pricing rules…" : "Reload saved pricing rules"}
                </Button>
              </div>
            )}
            {pricingReloaded && (
              <p role="status" className="mb-3 text-sm">
                {showPricingForm
                  ? "Saved pricing rules reloaded. Your entered value and selection are unchanged; review them before saving."
                  : "Saved pricing rules reloaded. Review the current values before making changes."}
              </p>
            )}
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
                        aria-label="Save pricing rule"
                        className="min-h-[44px] sm:h-8 px-4"
                        disabled={
                          !pricingRuleForm.value ||
                          (pricingRuleForm.scope !== "channel" && !pricingRuleForm.scopeId) ||
                          pricingReloading ||
                          upsertPricingRuleMutation.isPending
                        }
                        onClick={() => {
                          const scopeId = pricingRuleForm.scope === "channel" ? null : pricingRuleForm.scopeId;
                          const previous = pricingRuleBaseline.find((rule) =>
                            rule.scope === pricingRuleForm.scope && rule.scope_id === scopeId,
                          );
                          upsertPricingRuleMutation.mutate({
                            scope: pricingRuleForm.scope,
                            scopeId,
                            ruleType: pricingRuleForm.ruleType,
                            value: pricingRuleForm.value,
                            expected: previous
                              ? { id: previous.id, ruleType: previous.rule_type, value: String(previous.value) }
                              : null,
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
                      aria-label={`Delete ${rule.scope_label || rule.scope} pricing rule`}
                      onClick={() => deletePricingRuleMutation.mutate(rule)}
                      disabled={deletePricingRuleMutation.isPending || pricingReloading}
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
                            aria-label={`Delete ${rule.scope_label || rule.scope} pricing rule`}
                            onClick={() => deletePricingRuleMutation.mutate(rule)}
                            disabled={deletePricingRuleMutation.isPending || pricingReloading}
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

      {/* Sync Progress Modal (SSE-based) */}
      {registrationTarget && registrationOwner && registrationTarget.externalListingId && (
        <MarketplaceListingRegistrationDialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setRegistrationTarget(null);
          }}
          owner={registrationOwner}
          productName={registrationTarget.name}
          externalListingId={registrationTarget.externalListingId}
          onRegistered={handleRegistrationComplete}
        />
      )}

      {listingChangesTarget && registrationOwner && (
        <MarketplaceListingChangesDialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setListingChangesTarget(null);
          }}
          owner={registrationOwner}
          productName={listingChangesTarget.name}
          variants={listingChangeVariants}
          onCompleted={handleListingChangesComplete}
        />
      )}

      {publicationStatusTarget && <EbayListingJobStatusDialog
        key={publicationStatusTarget.jobId} jobId={publicationStatusTarget.jobId} productId={publicationStatusTarget.productId}
        productName={publicationStatusTarget.name} onClose={() => setPublicationStatusTarget(null)} onIssueAction={handleIssueAction}
        onRetryWithdrawal={retryWithdrawal}
      />}

      <EbaySyncRecoveryDialog
        jobId={recoveryTarget?.jobId ?? null}
        productId={recoveryTarget?.mode === "recovery" ? recoveryTarget.productId : null}
        productName={recoveryTarget?.name ?? ""}
        issue={recoveryTarget?.issue ?? null}
        onClose={() => setRecoveryTarget(null)}
        operation={recoveryTarget?.jobId && latestSyncJobs.get(recoveryTarget.productId)?.id === recoveryTarget.jobId ? latestSyncJobs.get(recoveryTarget.productId)?.operation : undefined}
        checking={checkingRecovery || (recoveryTarget ? syncingProductIds.has(recoveryTarget.productId) : false)}
        onRecheck={() => void continueSavedRecovery()}
        onRecovered={(job) => {
          if (!recoveryTarget) return;
          clearUntrackedLocalIssue(recoveryTarget.productId);
          if (job) {
            // Recovery can replace the blocker shown in a previously opened
            // status dialog. Require a fresh read before rendering it again.
            queryClient.removeQueries({ queryKey: ["/api/ebay/listings/sync-jobs", "read-only-status", job.id], exact: true });
            setPublicationStatusTarget({ jobId: job.id, productId: job.productId, name: recoveryTarget.name });
            setRecoveryTarget(null);
          }
        }}
      />

      {recoveryTarget?.mode === "mapping" && <EbayMappingRepairDialog
        key={recoveryTarget.productId}
        productId={recoveryTarget.productId}
        productName={recoveryTarget.name}
        onClose={() => setRecoveryTarget(null)}
        onIssueAction={handleIssueAction}
        onQueued={(job) => clearUntrackedLocalIssue(job.productId)}
        onReviewRegisteredListing={async () => {
          const currentFeed = await refetchFeed();
          const product = currentFeed.data?.feed.find((item) => item.id === recoveryTarget.productId);
          if (currentFeed.isError || !product) throw new Error("The current product could not be loaded for listing review.");
          setRecoveryTarget(null);
          setListingChangesTarget(product);
        }}
      />}

    </div>
  );
}
