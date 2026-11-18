import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation, useSearch, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  RotateCcw,
  Package,
  Save,
  Image as ImageIcon,
  Layers,
  BarChart3,
  FileText,
  Globe,
  Archive,
  Check,
  Truck,
  Trash2,
  Copy,
  GitMerge,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { InventoryTrackingHistory } from "@/components/catalog/InventoryTrackingHistory";
import { ProductMergeDialog } from "@/components/catalog/ProductMergeDialog";
import { ProductConversionCard, ProductConversionSummary } from "@/features/inventory-builds/ProductConversionCard";
import { ProductSafetySummary } from "@/features/inventory-builds/ProductSafetySummary";
import { ProductStockRulesCard } from "@/features/channel-inventory/components/ProductStockRulesCard";
import { transformationQueryKey } from "@/features/inventory-builds/package-conversion-draft";
import { createProductVariant } from "@/features/catalog/create-product-variant";
import { buildVariantPackagePatch } from "@/lib/variant-package";
import {
  getVariantUomDefinition,
  inferLegacyVariantUomType,
  isSingleUnitVariantUomType,
  type VariantUomType,
} from "@shared/catalog/variant-uom";
import {
  DEFAULT_PRODUCT_INVENTORY_STRATEGY,
  PRODUCT_INVENTORY_STRATEGY_DEFINITIONS,
} from "@shared/catalog/inventory-strategy";
import type { VariantSalesEligibility } from "@shared/catalog/variant-sales-eligibility";
import {
  InventoryRuntimeAuthorityBadge,
  useInventoryRuntimeAuthority,
} from "@/components/inventory/InventoryRuntimeAuthorityBadge";
import {
  buildVariantPackagePayload,
  buildVariantPackingFlagsPayload,
  emptyVariantPackageInput,
  getVariantUomType,
  parsePositiveInt,
  safeInternalPath,
  variantPackageInputFromVariant,
  type ProductCategory,
  type ProductContentFormState,
  type ProductDetailData,
  type ProductEditFormState,
  type ProductLocationAssignment,
  type ProductVariantRow,
  type Settings,
  type ShippingGroup,
  type VariantFormState,
} from "./product-detail/product-detail-types-and-helpers";
import {
  ChannelListingsPanel,
  LegacyProductChannelAllocationPanels,
  ProductChannelsActionToolbar,
  ProductInventorySyncPanel,
  ShopifyProductMappingPanel,
  useProductLegacyChannelAllocation,
} from "./product-detail/ProductChannelsAndListingsPanels";
import { ProductInventoryTab } from "./product-detail/ProductInventoryAndShippingPanels";
import { ProductContentSection, ProductDetailSidebar } from "./product-detail/ProductContentAndSidebar";
import { ProductVariantsSection, VariantEditorDialog } from "./product-detail/ProductVariantsSection";
import { ProductSuppliersSection } from "./product-detail/ProductSuppliersSection";
import {
  ArchiveProductDialog,
  ArchiveVariantDialog,
  DeleteProductDialog,
  DuplicateProductDialog,
  ProductImagesSection,
} from "./product-detail/ProductMediaAndDialogs";

export { ProductInventorySyncPanel, ShopifyProductMappingPanel } from "./product-detail/ProductChannelsAndListingsPanels";

export default function ProductDetail() {
  const inventoryRuntimeAuthorityQuery = useInventoryRuntimeAuthority();
  const [, params] = useRoute("/products/:id");
  const [, setLocation] = useLocation();
  const searchStr = useSearch();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const productId = params?.id ? parseInt(params.id) : null;
  const [activeTab, setActiveTab] = useState("overview");
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [archiveVariant, setArchiveVariant] = useState<ProductVariantRow | null>(null);
  const receiptSetupAutoOpenRef = useRef<string | null>(null);
  const variantDeepLinkAutoOpenRef = useRef<string | null>(null);

  // --- Product data ---
  const { data: product, isLoading, error } = useQuery<ProductDetailData>({
    queryKey: [`/api/products/${productId}`],
    enabled: !!productId,
  });

  // --- Global settings for default hints ---
  const { data: settings } = useQuery<Settings>({
    queryKey: ["/api/settings"],
  });

  const { data: productCategories = [] } = useQuery<ProductCategory[]>({
    queryKey: ["/api/product-categories"],
    queryFn: async () => {
      const res = await fetch("/api/product-categories");
      if (!res.ok) throw new Error("Failed to fetch product categories");
      return res.json();
    },
  });
  const activeProductCategories = productCategories.filter((category) => category.isActive);

  const { data: shippingGroups = [] } = useQuery<ShippingGroup[]>({
    queryKey: ["/api/shipping-groups"],
    queryFn: async () => {
      const res = await fetch("/api/shipping-groups");
      if (!res.ok) throw new Error("Failed to fetch shipping groups");
      return res.json();
    },
  });
  const activeShippingGroups = shippingGroups.filter((group) => group.isActive);

  const globalDefaultLeadTime = parseInt(settings?.default_lead_time_days || "120") || 120;
  const globalDefaultSafetyStock = parseInt(settings?.default_safety_stock_days || "7") || 7;

  // --- Pick location assignments ---
  const { data: productLocations = [] } = useQuery<ProductLocationAssignment[]>({
    queryKey: [`/api/products/${productId}/locations`],
    enabled: !!productId,
  });

  // --- Overview & Content edit state ---
  const [editForm, setEditForm] = useState<ProductEditFormState>({
    name: "",
    sku: "",
    baseUnit: "",
    inventoryStrategy: DEFAULT_PRODUCT_INVENTORY_STRATEGY,
    inventoryTrackingDefault: true,
    leadTimeDays: 120,
    safetyStockDays: 7,
  });
  const [isDirty, setIsDirty] = useState(false);

  const [contentForm, setContentForm] = useState<ProductContentFormState>({
    title: "",
    description: "",
    bulletPoints: "",
    categoryId: "",
    shippingGroupId: "",
    subcategory: "",
    brand: "",
    manufacturer: "",
    tags: "",
    seoTitle: "",
    seoDescription: "",
    status: "active",
  });
  const [contentDirty, setContentDirty] = useState(false);

  useEffect(() => {
    if (product) {
      setEditForm({
        name: product.name || "",
        sku: product.sku || "",
        baseUnit: product.baseUnit || "piece",
        inventoryStrategy: product.inventoryStrategy ?? DEFAULT_PRODUCT_INVENTORY_STRATEGY,
        inventoryTrackingDefault: product.inventoryTrackingDefault ?? true,
        leadTimeDays: product.leadTimeDays ?? 120,
        safetyStockDays: product.safetyStockDays ?? 7,
      });
      setContentForm({
        title: product.title || "",
        description: product.description || "",
        bulletPoints: (product.bulletPoints || []).join("\n"),
        categoryId: product.categoryId ? String(product.categoryId) : "",
        shippingGroupId: product.shippingGroupId ? String(product.shippingGroupId) : "",
        subcategory: product.subcategory || "",
        brand: product.brand || "",
        manufacturer: product.manufacturer || "",
        tags: (product.tags || []).join(", "),
        seoTitle: product.seoTitle || "",
        seoDescription: product.seoDescription || "",
        status: product.status || "active",
      });
      setIsDirty(false);
      setContentDirty(false);
    }
  }, [product]);

  const updateField = useCallback((field: string, value: string | number | boolean) => {
    setEditForm((prev) => ({ ...prev, [field]: value }));
    setIsDirty(true);
  }, []);

  const updateContentField = useCallback((field: string, value: string) => {
    setContentForm((prev) => ({ ...prev, [field]: value }));
    setContentDirty(true);
  }, []);

  // --- Save product mutation ---
  const saveProductMutation = useMutation({
    mutationFn: async () => {
      const bulletPoints = contentForm.bulletPoints.trim()
        ? contentForm.bulletPoints.split("\n").map((s) => s.trim()).filter(Boolean)
        : null;
      const tags = contentForm.tags.trim()
        ? contentForm.tags.split(",").map((s) => s.trim()).filter(Boolean)
        : null;

      const productUpdate: Record<string, unknown> = {
        name: editForm.name,
        sku: editForm.sku,
        baseUnit: editForm.baseUnit,
        leadTimeDays: editForm.leadTimeDays,
        safetyStockDays: editForm.safetyStockDays,
        title: contentForm.title || null,
        description: contentForm.description || null,
        bulletPoints,
        categoryId: contentForm.categoryId ? Number(contentForm.categoryId) : null,
        shippingGroupId: contentForm.shippingGroupId ? Number(contentForm.shippingGroupId) : null,
        subcategory: contentForm.subcategory || null,
        brand: contentForm.brand || null,
        manufacturer: contentForm.manufacturer || null,
        tags,
        seoTitle: contentForm.seoTitle || null,
        seoDescription: contentForm.seoDescription || null,
        status: contentForm.status || "active",
      };
      if (editForm.inventoryTrackingDefault !== (product?.inventoryTrackingDefault ?? true)) {
        productUpdate.inventoryTrackingDefault = editForm.inventoryTrackingDefault;
      }
      const persistedInventoryStrategy = product?.inventoryStrategy ?? DEFAULT_PRODUCT_INVENTORY_STRATEGY;
      if (editForm.inventoryStrategy !== persistedInventoryStrategy) {
        productUpdate.inventoryStrategy = editForm.inventoryStrategy;
      }

      const res = await fetch(`/api/products/${product?.productId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(productUpdate),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || body?.error || "Failed to update product");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      toast({ title: "Product updated" });
      if (product?.productId) queryClient.invalidateQueries({ queryKey: transformationQueryKey(product.productId) });
      setIsDirty(false);
      setContentDirty(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update product", description: err.message, variant: "destructive" });
    },
  });

  const unarchiveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/products/${product?.productId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true, status: "active" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || body?.error || "Failed to reactivate product");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      toast({ title: "Product reactivated successfully" });
      if (product?.productId) queryClient.invalidateQueries({ queryKey: transformationQueryKey(product.productId) });
    },
    onError: (err: Error) => {
      toast({ title: "Reactivation failed", description: err.message, variant: "destructive" });
    },
  });

  // --- Legacy channel allocation query ---
  const legacyChannelsEnabled =
    !!product?.productId
    && activeTab === "channels"
    && inventoryRuntimeAuthorityQuery.data?.authority === "legacy";
  const { data: allocationData, isLoading: allocationLoading } = useProductLegacyChannelAllocation(
    product?.productId,
    legacyChannelsEnabled,
  );

  // --- Variant dialog state ---
  const [variantDialogOpen, setVariantDialogOpen] = useState(false);
  const [editingVariant, setEditingVariant] = useState<ProductVariantRow | null>(null);
  const [unitsInputRaw, setUnitsInputRaw] = useState<string | null>(null);
  const [variantForm, setVariantForm] = useState<VariantFormState>({
    uomType: "each" as VariantUomType,
    hierarchyLevel: 1,
    unitsPerVariant: 1,
    sku: "",
    name: "",
    barcode: "",
    parentVariantId: null as number | null,
    isBaseUnit: true,
    package: emptyVariantPackageInput(),
    shipsInOwnContainer: false,
    maxUnitsPerPackage: "",
    requiresShipping: true,
    inventoryTrackingOverride: null as boolean | null,
    salesEligibility: "sellable" as VariantSalesEligibility,
  });
  const [skuManuallyEdited, setSkuManuallyEdited] = useState(false);
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);

  const computeAutoSku = useCallback(
    (uomType: VariantUomType, units: number) => {
      const baseSku = product?.sku || "";
      const prefix = getVariantUomDefinition(uomType).skuPrefix;
      return prefix ? `${baseSku}-${prefix}${units}` : baseSku;
    },
    [product?.sku],
  );

  const computeAutoName = useCallback(
    (uomType: VariantUomType, units: number) => {
      const typeLabel = getVariantUomDefinition(uomType).label;
      return isSingleUnitVariantUomType(uomType) ? typeLabel : `${typeLabel} of ${units}`;
    },
    [],
  );

  const handleTypeChange = useCallback(
    (uomType: VariantUomType) => {
      setUnitsInputRaw(null);
      setVariantForm((prev) => {
        const definition = getVariantUomDefinition(uomType);
        const isSingleUnit = isSingleUnitVariantUomType(uomType);
        const wasSingleUnit = isSingleUnitVariantUomType(prev.uomType);
        const unitsPerVariant = isSingleUnit ? 1 : prev.unitsPerVariant;
        const next = {
          ...prev,
          uomType,
          hierarchyLevel: definition.defaultHierarchyLevel,
          unitsPerVariant,
          parentVariantId: isSingleUnit ? null : prev.parentVariantId,
          isBaseUnit: isSingleUnit ? true : wasSingleUnit ? false : prev.isBaseUnit,
        };
        if (!skuManuallyEdited) next.sku = computeAutoSku(uomType, unitsPerVariant);
        if (!nameManuallyEdited) next.name = computeAutoName(uomType, unitsPerVariant);
        return next;
      });
    },
    [skuManuallyEdited, nameManuallyEdited, computeAutoSku, computeAutoName],
  );

  const handleUnitsChange = useCallback(
    (units: number) => {
      setVariantForm((prev) => {
        const next = { ...prev, unitsPerVariant: units };
        if (!skuManuallyEdited) next.sku = computeAutoSku(prev.uomType, units);
        if (!nameManuallyEdited) next.name = computeAutoName(prev.uomType, units);
        return next;
      });
    },
    [skuManuallyEdited, nameManuallyEdited, computeAutoSku, computeAutoName],
  );

  const openCreateVariant = useCallback(() => {
    setEditingVariant(null);
    setSkuManuallyEdited(false);
    setNameManuallyEdited(false);
    const defaultUomType: VariantUomType = "each";
    const defaultUnits = 1;
    setVariantForm({
      uomType: defaultUomType,
      hierarchyLevel: getVariantUomDefinition(defaultUomType).defaultHierarchyLevel,
      unitsPerVariant: defaultUnits,
      sku: computeAutoSku(defaultUomType, defaultUnits),
      name: computeAutoName(defaultUomType, defaultUnits),
      barcode: "",
      parentVariantId: null,
      isBaseUnit: true,
      package: emptyVariantPackageInput(),
      shipsInOwnContainer: false,
      maxUnitsPerPackage: "",
      requiresShipping: true,
      inventoryTrackingOverride: null as boolean | null,
      salesEligibility: "sellable",
    });
    setVariantDialogOpen(true);
  }, [computeAutoSku, computeAutoName]);

  useEffect(() => {
    if (!product?.productId) return;
    const searchParams = new URLSearchParams(searchStr);
    if (searchParams.get("receiptSetup") !== "1") return;

    setActiveTab("variants");

    const unitsPerVariant = parsePositiveInt(searchParams.get("unitsPerVariant"));
    if (!unitsPerVariant) return;

    const setupKey = `${product.productId}:${searchParams.toString()}`;
    if (receiptSetupAutoOpenRef.current === setupKey) return;
    receiptSetupAutoOpenRef.current = setupKey;

    const hierarchyLevel = parsePositiveInt(searchParams.get("hierarchyLevel")) ?? 3;
    const uomType = inferLegacyVariantUomType({ hierarchyLevel, unitsPerVariant, isBaseUnit: false });
    setEditingVariant(null);
    setSkuManuallyEdited(false);
    setNameManuallyEdited(false);
    setUnitsInputRaw(null);
    setVariantForm({
      uomType,
      hierarchyLevel,
      unitsPerVariant,
      sku: computeAutoSku(uomType, unitsPerVariant),
      name: computeAutoName(uomType, unitsPerVariant),
      barcode: "",
      parentVariantId: null,
      isBaseUnit: false,
      package: emptyVariantPackageInput(),
      shipsInOwnContainer: false,
      maxUnitsPerPackage: "",
      requiresShipping: true,
      inventoryTrackingOverride: null as boolean | null,
      salesEligibility: "sellable",
    });
    setVariantDialogOpen(true);
    toast({
      title: "Receipt variant setup",
      description: `Create or activate a receive variant with ${unitsPerVariant} units per variant, then save to resume the receipt.`,
    });
  }, [searchStr, product?.productId, computeAutoSku, computeAutoName, toast]);

  const openEditVariant = useCallback((variant: ProductVariantRow) => {
    setEditingVariant(variant);
    setSkuManuallyEdited(true);
    setNameManuallyEdited(true);
    setVariantForm({
      uomType: getVariantUomType(variant),
      hierarchyLevel: variant.hierarchyLevel,
      unitsPerVariant: variant.unitsPerVariant,
      sku: variant.sku || "",
      name: variant.name,
      barcode: variant.barcode || "",
      parentVariantId: variant.parentVariantId,
      isBaseUnit: variant.isBaseUnit ?? false,
      package: variantPackageInputFromVariant(variant),
      shipsInOwnContainer: variant.shipsInOwnContainer ?? false,
      maxUnitsPerPackage: variant.maxUnitsPerPackage != null ? String(variant.maxUnitsPerPackage) : "",
      requiresShipping: variant.requiresShipping !== false,
      inventoryTrackingOverride: variant.inventoryTrackingOverride ?? null,
      salesEligibility: variant.salesEligibility ?? "sellable",
    });
    setVariantDialogOpen(true);
  }, []);

  useEffect(() => {
    const searchParams = new URLSearchParams(searchStr);
    const tab = searchParams.get("tab");
    const validTabs = new Set(["overview", "content", "images", "variants", "channels", "suppliers", "inventory"]);
    if (tab && validTabs.has(tab)) {
      setActiveTab(tab);
    }
  }, [searchStr]);

  useEffect(() => {
    const searchParams = new URLSearchParams(searchStr);
    if (searchParams.get("tab") !== "variants") return;

    const variantId = parsePositiveInt(searchParams.get("variantId"));
    if (!variantId || !product?.productId) return;

    const autoOpenKey = `${product.productId}:${variantId}`;
    if (variantDeepLinkAutoOpenRef.current === autoOpenKey) return;

    const variant = product.variants.find((candidate) => candidate.id === variantId);
    if (!variant) return;

    variantDeepLinkAutoOpenRef.current = autoOpenKey;
    setActiveTab("variants");
    openEditVariant(variant);
  }, [searchStr, product?.productId, product?.variants, openEditVariant]);

  // --- Variant mutations ---
  const createVariantMutation = useMutation({
    mutationFn: async (data: typeof variantForm) => {
      const packageAttributes = buildVariantPackagePayload(data.package, "null");
      const packingFlags = buildVariantPackingFlagsPayload(data);
      return createProductVariant(product?.productId ?? 0, {
        sku: data.sku || null,
        name: data.name,
        unitsPerVariant: data.unitsPerVariant,
        hierarchyLevel: data.hierarchyLevel,
        uomType: data.uomType,
        barcode: data.barcode || null,
        parentVariantId: data.parentVariantId,
        isBaseUnit: data.isBaseUnit,
        requiresShipping: data.requiresShipping,
        inventoryTrackingOverride: data.inventoryTrackingOverride,
        salesEligibility: data.salesEligibility,
        ...packageAttributes,
        ...packingFlags,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      setVariantDialogOpen(false);
      if (product?.productId) queryClient.invalidateQueries({ queryKey: transformationQueryKey(product.productId) });
      const returnTo = safeInternalPath(new URLSearchParams(searchStr).get("returnTo"));
      if (returnTo) {
        toast({ title: "Variant created", description: "Returning to shipment receipt setup." });
        setLocation(returnTo);
        return;
      }
      toast({ title: "Variant created" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create variant", description: err.message, variant: "destructive" });
    },
  });

  const updateVariantMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: typeof variantForm }) => {
      const packageAttributes = buildVariantPackagePatch(data.package, editingVariant ?? {});
      const packingFlags = buildVariantPackingFlagsPayload(data);
      const res = await fetch(`/api/product-variants/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: data.sku || null,
          name: data.name,
          unitsPerVariant: data.unitsPerVariant,
          hierarchyLevel: data.hierarchyLevel,
          uomType: data.uomType,
          barcode: data.barcode || null,
          // Conversion rules are authored separately. Do not overwrite a legacy
          // parent from a stale form when saving unrelated SKU attributes.
          isBaseUnit: data.isBaseUnit,
          requiresShipping: data.requiresShipping,
          inventoryTrackingOverride: data.inventoryTrackingOverride,
          salesEligibility: data.salesEligibility,
          ...packageAttributes,
          ...packingFlags,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || "Failed to update variant");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      setVariantDialogOpen(false);
      const returnTo = safeInternalPath(new URLSearchParams(searchStr).get("returnTo"));
      if (returnTo) {
        toast({ title: "Variant updated", description: "Returning to shipment receipt setup." });
        setLocation(returnTo);
        return;
      }
      toast({ title: "Variant updated" });
      if (product?.productId) queryClient.invalidateQueries({ queryKey: transformationQueryKey(product.productId) });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update variant", description: err.message, variant: "destructive" });
    },
  });

  // --- Sorted variants ---
  const sortedVariants = product?.variants
    ? [...product.variants].filter((v) => v.isActive !== false).sort((a, b) => a.hierarchyLevel - b.hierarchyLevel)
    : [];
  const archivedVariants = product?.variants
    ? [...product.variants].filter((v) => v.isActive === false).sort((a, b) => a.hierarchyLevel - b.hierarchyLevel)
    : [];

  // --- Render ---
  if (!productId) {
    return (
      <div className="p-4 md:p-6 text-center">
        <p className="text-muted-foreground">Invalid product ID</p>
        <Button variant="link" onClick={() => setLocation("/catalog")} className="min-h-[44px]">
          Back to Products
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-4 md:p-6 text-center">
        <p className="text-muted-foreground">Loading product...</p>
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="p-4 md:p-6 text-center">
        <p className="text-muted-foreground">Product not found</p>
        <Button variant="link" onClick={() => setLocation("/catalog")} className="min-h-[44px]">
          Back to Products
        </Button>
      </div>
    );
  }

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center gap-3 md:gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setLocation("/catalog")}
          className="min-h-[44px] min-w-[44px]"
          data-testid="btn-back"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0 max-w-full">
          <h1 className="text-lg md:text-2xl font-bold truncate">
            {product.title || product.name}
          </h1>
          <p className="text-sm text-muted-foreground font-mono">{product.sku}</p>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          {(isDirty || contentDirty) && (
            <Button
              onClick={() => saveProductMutation.mutate()}
              disabled={saveProductMutation.isPending}
              size="sm"
              className="min-h-[44px]"
            >
              <Save className="h-4 w-4 mr-2" />
              {saveProductMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          )}
          <Badge variant={product.isActive ? "default" : "secondary"} className="text-xs">
            {product.status === "archived" ? "Archived" : product.isActive ? "Active" : "Inactive"}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            className="min-h-[44px]"
            onClick={() => setDuplicateOpen(true)}
            data-testid="btn-duplicate-product"
          >
            <Copy className="h-4 w-4 mr-2" />
            Duplicate
          </Button>
          {product.isActive && (
            <Button
              variant="outline"
              size="sm"
              className="min-h-[44px]"
              onClick={() => setMergeOpen(true)}
              data-testid="btn-merge-product"
            >
              <GitMerge className="h-4 w-4 mr-2" />
              Merge into…
            </Button>
          )}
          {product.isActive ? (
            <Button
              variant="outline"
              size="sm"
              className="min-h-[44px] text-muted-foreground"
              onClick={() => setArchiveDialogOpen(true)}
            >
              <Archive className="h-4 w-4 mr-2" />
              Archive
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="min-h-[44px] text-green-600 border-green-600/20 hover:bg-green-600/10"
              onClick={() => unarchiveMutation.mutate()}
              disabled={unarchiveMutation.isPending}
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              {unarchiveMutation.isPending ? "Activating..." : "Reactivate"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="min-h-[44px] text-destructive hover:bg-destructive hover:text-destructive-foreground"
            onClick={() => setDeleteConfirmOpen(true)}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <DeleteProductDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        product={product}
        onDeleted={() => setLocation("/products")}
      />

      {mergeOpen && (
        <ProductMergeDialog
          product={{ id: product.id, sku: product.sku ?? null, name: product.name }}
          onClose={() => setMergeOpen(false)}
          onMerged={(targetProductId) => {
            setMergeOpen(false);
            queryClient.invalidateQueries();
            setLocation(`/products/${targetProductId}`);
          }}
        />
      )}

      {/* Duplicate product dialog */}
      <DuplicateProductDialog
        open={duplicateOpen}
        onOpenChange={setDuplicateOpen}
        product={product}
        routeProductId={productId}
        onDuplicated={(createdId) => setLocation(`/products/${createdId}?tab=variants`)}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        <div className="lg:col-span-2 order-2 lg:order-1">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="overview" className="min-h-[44px]" data-testid="tab-overview">
                <Package className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Overview</span>
              </TabsTrigger>
              <TabsTrigger value="content" className="min-h-[44px]" data-testid="tab-content">
                <FileText className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Content</span>
              </TabsTrigger>
              <TabsTrigger value="images" className="min-h-[44px]" data-testid="tab-images">
                <ImageIcon className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Images</span>
                <span className="ml-1">({product.assets?.length || 0})</span>
              </TabsTrigger>
              <TabsTrigger value="variants" className="min-h-[44px]" data-testid="tab-variants">
                <Layers className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Variants</span>
                <span className="ml-1">({sortedVariants.length})</span>
              </TabsTrigger>
              <TabsTrigger value="channels" className="min-h-[44px]" data-testid="tab-channels">
                <Globe className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Channels</span>
              </TabsTrigger>
              <TabsTrigger value="suppliers" className="min-h-[44px]" data-testid="tab-suppliers">
                <Truck className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Suppliers</span>
              </TabsTrigger>
              <TabsTrigger value="inventory" className="min-h-[44px]" data-testid="tab-inventory">
                <BarChart3 className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Inventory</span>
              </TabsTrigger>
            </TabsList>

            {/* ===== OVERVIEW TAB ===== */}
            <TabsContent value="overview" className="space-y-4 mt-4">
              <Card>
                <CardHeader className="p-3 md:p-6">
                  <CardTitle className="text-base md:text-lg">Product Information</CardTitle>
                </CardHeader>
                <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Product Name</Label>
                      <Input
                        value={editForm.name}
                        onChange={(e) => updateField("name", e.target.value)}
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Base SKU</Label>
                      <Input
                        value={editForm.sku}
                        onChange={(e) => updateField("sku", e.target.value)}
                        className="h-9 font-mono"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Base Unit</Label>
                      <Input
                        value={editForm.baseUnit}
                        onChange={(e) => updateField("baseUnit", e.target.value)}
                        className="h-9 capitalize"
                      />
                    </div>
                  </div>
                  <div className="space-y-2 border-t pt-4">
                    <Label htmlFor="product-inventory-tracking">Default inventory tracking</Label>
                    <Select
                      value={editForm.inventoryTrackingDefault ? "tracked" : "untracked"}
                      onValueChange={(value) => updateField("inventoryTrackingDefault", value === "tracked")}
                    >
                      <SelectTrigger id="product-inventory-tracking"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tracked">Track inventory</SelectItem>
                        <SelectItem value="untracked">Do not track inventory</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Applies to this product and variants that inherit it. Variants can override it in either direction.
                      Untracked physical products still require pick confirmation.
                    </p>
                    <InventoryTrackingHistory key={product.id} productId={product.id} />
                  </div>
                  <div className="space-y-2 border-t pt-4" data-testid="inventory-behavior-control">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Label className="text-xs md:text-sm">Inventory behavior</Label>
                        <InventoryRuntimeAuthorityBadge />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Controls how variants share availability and which inventory transformations are permitted.
                      </p>
                    </div>
                    {inventoryRuntimeAuthorityQuery.data?.authority === "legacy" ? (
                      <div
                        className="grid grid-cols-1 gap-2 lg:grid-cols-3"
                        role="radiogroup"
                        aria-label="Inventory behavior"
                      >
                        {PRODUCT_INVENTORY_STRATEGY_DEFINITIONS.map((definition) => {
                          const selected = editForm.inventoryStrategy === definition.strategy;
                          return (
                            <button
                              key={definition.strategy}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              className={cn(
                                "min-h-[76px] border px-3 py-2 text-left transition-colors",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                                selected
                                  ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary"
                                  : "border-border bg-background text-foreground hover:bg-muted/50",
                              )}
                              onClick={() => updateField("inventoryStrategy", definition.strategy)}
                            >
                              <span className="flex items-center justify-between gap-2 text-sm font-semibold">
                                {definition.label}
                                {selected ? <Check className="h-4 w-4 text-primary" aria-hidden="true" /> : null}
                              </span>
                              <span className="mt-1 block text-xs leading-4 text-muted-foreground">
                                {definition.description}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="inventory-behavior-read-only">
                        <p className="font-medium">
                          {inventoryRuntimeAuthorityQuery.data?.authority === "canonical"
                            ? "Inventory behavior is controlled by this product's active rules."
                            : "Inventory behavior cannot be edited until live authority is confirmed."}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Choose Physical only, Package hierarchy or Build managed on Variants. Review and apply changes to update ATP and warehouse execution together.
                        </p>
                        <Button variant="outline" size="sm" className="mt-3" onClick={() => setActiveTab("variants")}>
                          Manage inventory behavior
                        </Button>
                      </div>
                    )}
                    {product?.productId && <ProductConversionSummary productId={product.productId} enabled={activeTab === "overview"} />}
                  </div>
                </CardContent>
              </Card>

              {/* Procurement */}
              <Card>
                <CardHeader className="p-3 md:p-6">
                  <CardTitle className="text-base md:text-lg">Procurement</CardTitle>
                  <CardDescription className="text-xs md:text-sm">
                    Lead time and safety stock for reorder calculations
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Lead Time (days)</Label>
                      <Input
                        type="number"
                        min={0}
                        value={editForm.leadTimeDays}
                        onChange={(e) => updateField("leadTimeDays", parseInt(e.target.value) || 0)}
                        className="h-9"
                      />
                      <p className="text-xs text-muted-foreground">
                        Default: {globalDefaultLeadTime} days
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Safety Stock (days of cover)</Label>
                      <Input
                        type="number"
                        min={0}
                        value={editForm.safetyStockDays}
                        onChange={(e) => updateField("safetyStockDays", parseInt(e.target.value) || 0)}
                        className="h-9"
                      />
                      <p className="text-xs text-muted-foreground">
                        Default: {globalDefaultSafetyStock} days
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ===== CONTENT TAB ===== */}
            <TabsContent value="content" className="space-y-4 mt-4">
              <ProductContentSection
                contentForm={contentForm}
                updateContentField={updateContentField}
                activeProductCategories={activeProductCategories}
                activeShippingGroups={activeShippingGroups}
              />
            </TabsContent>

            {/* ===== IMAGES TAB ===== */}
            <TabsContent value="images" className="mt-4">
              <ProductImagesSection product={product} routeProductId={productId} />
            </TabsContent>

            {/* ===== CHANNELS TAB ===== */}
            <TabsContent value="channels" className="mt-4 space-y-4">
              <ProductInventorySyncPanel productId={product!.productId} />
              <ProductChannelsActionToolbar
                productId={product!.productId}
                routeProductId={productId}
                isLegacyAuthority={inventoryRuntimeAuthorityQuery.data?.authority === "legacy"}
                atpBase={allocationData?.atpBase}
                authorityBadge={<InventoryRuntimeAuthorityBadge />}
              />

              {inventoryRuntimeAuthorityQuery.data?.authority === "canonical" ? (
                // The retired legacy allocation's place: this product's stock rules on
                // every channel. Max 0 there is how a SKU is stopped on a channel.
                <ProductStockRulesCard productId={product!.productId} />
              ) : inventoryRuntimeAuthorityQuery.data?.authority !== "legacy" ? (
                <Card data-testid="product-legacy-channel-allocation-unavailable">
                  <CardHeader className="p-3 md:p-6">
                    <CardTitle className="text-base md:text-lg">Product allocation controls are unavailable</CardTitle>
                    <CardDescription className="text-xs md:text-sm">
                      The live inventory authority could not be confirmed, so legacy allocation reads and writes remain disabled.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
                    <Button asChild variant="outline">
                      <Link href="/channels/inventory">Open Channel Inventory</Link>
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <LegacyProductChannelAllocationPanels
                  productId={product!.productId}
                  routeProductId={productId}
                  enabled={legacyChannelsEnabled}
                  allocationData={allocationData}
                  allocationLoading={allocationLoading}
                />
              )}

              <ShopifyProductMappingPanel
                productId={product!.productId}
                enabled={!!product?.productId && activeTab === "channels"}
              />

              <ChannelListingsPanel
                productId={product!.productId}
                enabled={!!product?.productId && activeTab === "channels"}
              />
            </TabsContent>

            {/* ===== VARIANTS TAB ===== */}
            <TabsContent value="variants" className="mt-4 space-y-4">
              <ProductVariantsSection
                sortedVariants={sortedVariants}
                archivedVariants={archivedVariants}
                onCreateVariant={openCreateVariant}
                onEditVariant={openEditVariant}
                onArchiveVariant={(variant) => setArchiveVariant(variant)}
              />
              {product?.productId && (
                <ProductConversionCard
                  enabled={activeTab === "variants"}
                  productId={product.productId}
                />
              )}
            </TabsContent>

            {/* ===== SUPPLIERS TAB ===== */}
            <TabsContent value="suppliers" className="mt-4 space-y-4">
              <ProductSuppliersSection
                productId={product.productId}
                routeProductId={productId}
                enabled={activeTab === "suppliers"}
              />
            </TabsContent>

            {/* ===== INVENTORY TAB ===== */}
            <TabsContent value="inventory" className="mt-4">
              <ProductInventoryTab productId={product.productId} />
              <ProductSafetySummary productId={product.productId} />
            </TabsContent>
          </Tabs>
        </div>

        {/* Sidebar */}
        <ProductDetailSidebar
          product={product}
          productLocations={productLocations}
          activeVariantCount={sortedVariants.length}
        />
      </div>

      {/* ===== VARIANT EDITOR DIALOG ===== */}
      <VariantEditorDialog
        open={variantDialogOpen}
        onOpenChange={setVariantDialogOpen}
        editingVariant={editingVariant}
        variantForm={variantForm}
        setVariantForm={setVariantForm}
        unitsInputRaw={unitsInputRaw}
        setUnitsInputRaw={setUnitsInputRaw}
        skuManuallyEdited={skuManuallyEdited}
        setSkuManuallyEdited={setSkuManuallyEdited}
        nameManuallyEdited={nameManuallyEdited}
        setNameManuallyEdited={setNameManuallyEdited}
        onTypeChange={handleTypeChange}
        onUnitsChange={handleUnitsChange}
        productInventoryTrackingDefault={product.inventoryTrackingDefault}
        onSubmit={() => {
          if (editingVariant) {
            updateVariantMutation.mutate({ id: editingVariant.id, data: variantForm });
          } else {
            createVariantMutation.mutate(variantForm);
          }
        }}
        isCreating={createVariantMutation.isPending}
        isUpdating={updateVariantMutation.isPending}
      />

      {/* Archive Product Dialog */}
      <ArchiveProductDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        product={product}
        routeProductId={productId}
      />

      {/* Variant Archive Dialog */}
      <ArchiveVariantDialog
        archiveVariant={archiveVariant}
        onClose={() => setArchiveVariant(null)}
        productId={product.productId}
        routeProductId={productId}
      />
    </div>
  );
}
