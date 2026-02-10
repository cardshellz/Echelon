import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Package,
  Save,
  Image as ImageIcon,
  Layers,
  BarChart3,
  Plus,
  Pencil,
  Trash2,
} from "lucide-react";

const HIERARCHY_TYPES = [
  { level: 1, label: "Pack", prefix: "P" },
  { level: 2, label: "Box", prefix: "B" },
  { level: 3, label: "Case", prefix: "C" },
  { level: 4, label: "Skid", prefix: "SK" },
] as const;

function getHierarchyLabel(level: number) {
  return HIERARCHY_TYPES.find((t) => t.level === level)?.label || `Level ${level}`;
}

function getHierarchyPrefix(level: number) {
  return HIERARCHY_TYPES.find((t) => t.level === level)?.prefix || "X";
}

interface ProductVariantRow {
  id: number;
  sku: string;
  name: string;
  unitsPerVariant: number;
  barcode: string | null;
  imageUrl: string | null;
  hierarchyLevel: number;
}

interface ProductDetailData {
  id: number;
  productId: number;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  brand: string | null;
  baseUnit: string;
  imageUrl: string | null;
  isActive: boolean;
  leadTimeDays: number;
  safetyStockQty: number;
  catalogProduct: {
    id: number;
    title: string;
    description: string | null;
    status: string;
    category: string | null;
    subcategory: string | null;
    brand: string | null;
    manufacturer: string | null;
  } | null;
  variants: ProductVariantRow[];
  assets: Array<{
    id: number;
    url: string;
    altText: string | null;
    assetType: string;
    isPrimary: number;
    position: number;
  }>;
}

interface Settings {
  [key: string]: string;
}

export default function ProductDetail() {
  const [, params] = useRoute("/products/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const productId = params?.id ? parseInt(params.id) : null;
  const [activeTab, setActiveTab] = useState("overview");

  // --- Product data ---
  const { data: product, isLoading, error } = useQuery<ProductDetailData>({
    queryKey: [`/api/products/${productId}`],
    enabled: !!productId,
  });

  // --- Global settings for default hints ---
  const { data: settings } = useQuery<Settings>({
    queryKey: ["/api/settings"],
  });
  const globalDefaultLeadTime = parseInt(settings?.default_lead_time_days || "120") || 120;
  const globalDefaultSafetyStock = parseInt(settings?.default_safety_stock_qty || "0") || 0;

  // --- Overview edit state ---
  const [editForm, setEditForm] = useState({
    name: "",
    sku: "",
    baseUnit: "",
    description: "",
    leadTimeDays: 120,
    safetyStockQty: 0,
  });
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (product) {
      setEditForm({
        name: product.name || "",
        sku: product.sku || "",
        baseUnit: product.baseUnit || "piece",
        description: product.description || "",
        leadTimeDays: product.leadTimeDays ?? 120,
        safetyStockQty: product.safetyStockQty ?? 0,
      });
      setIsDirty(false);
    }
  }, [product]);

  const updateField = useCallback((field: string, value: string | number) => {
    setEditForm((prev) => ({ ...prev, [field]: value }));
    setIsDirty(true);
  }, []);

  // --- Save product mutation ---
  const saveProductMutation = useMutation({
    mutationFn: async (data: typeof editForm) => {
      const res = await fetch(`/api/products/${product?.productId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name,
          sku: data.sku,
          baseUnit: data.baseUnit,
          description: data.description || null,
          leadTimeDays: data.leadTimeDays,
          safetyStockQty: data.safetyStockQty,
        }),
      });
      if (!res.ok) throw new Error("Failed to update product");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      toast({ title: "Product updated" });
      setIsDirty(false);
    },
    onError: () => {
      toast({ title: "Failed to update product", variant: "destructive" });
    },
  });

  // --- Variant dialog state ---
  const [variantDialogOpen, setVariantDialogOpen] = useState(false);
  const [editingVariant, setEditingVariant] = useState<ProductVariantRow | null>(null);
  const [variantForm, setVariantForm] = useState({
    hierarchyLevel: 1,
    unitsPerVariant: 1,
    sku: "",
    name: "",
    barcode: "",
  });
  const [skuManuallyEdited, setSkuManuallyEdited] = useState(false);
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);

  const computeAutoSku = useCallback(
    (level: number, units: number) => {
      const baseSku = product?.sku || "";
      const prefix = getHierarchyPrefix(level);
      return `${baseSku}-${prefix}${units}`;
    },
    [product?.sku],
  );

  const computeAutoName = useCallback(
    (level: number, units: number) => {
      const productName = product?.name || "";
      const typeLabel = getHierarchyLabel(level);
      return `${typeLabel} of ${units}`;
    },
    [product?.name],
  );

  const handleTypeChange = useCallback(
    (level: number) => {
      setVariantForm((prev) => {
        const next = { ...prev, hierarchyLevel: level };
        if (!skuManuallyEdited) next.sku = computeAutoSku(level, prev.unitsPerVariant);
        if (!nameManuallyEdited) next.name = computeAutoName(level, prev.unitsPerVariant);
        return next;
      });
    },
    [skuManuallyEdited, nameManuallyEdited, computeAutoSku, computeAutoName],
  );

  const handleUnitsChange = useCallback(
    (units: number) => {
      setVariantForm((prev) => {
        const next = { ...prev, unitsPerVariant: units };
        if (!skuManuallyEdited) next.sku = computeAutoSku(prev.hierarchyLevel, units);
        if (!nameManuallyEdited) next.name = computeAutoName(prev.hierarchyLevel, units);
        return next;
      });
    },
    [skuManuallyEdited, nameManuallyEdited, computeAutoSku, computeAutoName],
  );

  const openCreateVariant = useCallback(() => {
    setEditingVariant(null);
    setSkuManuallyEdited(false);
    setNameManuallyEdited(false);
    const defaultLevel = 1;
    const defaultUnits = 1;
    setVariantForm({
      hierarchyLevel: defaultLevel,
      unitsPerVariant: defaultUnits,
      sku: computeAutoSku(defaultLevel, defaultUnits),
      name: computeAutoName(defaultLevel, defaultUnits),
      barcode: "",
    });
    setVariantDialogOpen(true);
  }, [computeAutoSku, computeAutoName]);

  const openEditVariant = useCallback((variant: ProductVariantRow) => {
    setEditingVariant(variant);
    setSkuManuallyEdited(true);
    setNameManuallyEdited(true);
    setVariantForm({
      hierarchyLevel: variant.hierarchyLevel,
      unitsPerVariant: variant.unitsPerVariant,
      sku: variant.sku || "",
      name: variant.name,
      barcode: variant.barcode || "",
    });
    setVariantDialogOpen(true);
  }, []);

  // --- Variant mutations ---
  const createVariantMutation = useMutation({
    mutationFn: async (data: typeof variantForm) => {
      const res = await fetch(`/api/products/${product?.productId}/variants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: data.sku || null,
          name: data.name,
          unitsPerVariant: data.unitsPerVariant,
          hierarchyLevel: data.hierarchyLevel,
          barcode: data.barcode || null,
        }),
      });
      if (!res.ok) throw new Error("Failed to create variant");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      toast({ title: "Variant created" });
      setVariantDialogOpen(false);
    },
    onError: () => {
      toast({ title: "Failed to create variant", variant: "destructive" });
    },
  });

  const updateVariantMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: typeof variantForm }) => {
      const res = await fetch(`/api/product-variants/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: data.sku || null,
          name: data.name,
          unitsPerVariant: data.unitsPerVariant,
          hierarchyLevel: data.hierarchyLevel,
          barcode: data.barcode || null,
        }),
      });
      if (!res.ok) throw new Error("Failed to update variant");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      toast({ title: "Variant updated" });
      setVariantDialogOpen(false);
    },
    onError: () => {
      toast({ title: "Failed to update variant", variant: "destructive" });
    },
  });

  const deleteVariantMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/product-variants/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete variant");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      toast({ title: "Variant deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete variant", variant: "destructive" });
    },
  });

  const handleDeleteVariant = useCallback(
    (variant: ProductVariantRow) => {
      if (window.confirm(`Delete variant ${variant.sku || variant.name}?`)) {
        deleteVariantMutation.mutate(variant.id);
      }
    },
    [deleteVariantMutation],
  );

  // --- Sorted variants ---
  const sortedVariants = product?.variants
    ? [...product.variants].sort((a, b) => a.hierarchyLevel - b.hierarchyLevel)
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
        <div className="flex-1 min-w-0">
          <h1 className="text-lg md:text-2xl font-bold truncate">
            {product.catalogProduct?.title || product.name}
          </h1>
          <p className="text-sm text-muted-foreground font-mono">{product.sku}</p>
        </div>
        <div className="flex items-center gap-2">
          {isDirty && (
            <Button
              onClick={() => saveProductMutation.mutate(editForm)}
              disabled={saveProductMutation.isPending}
              size="sm"
              className="min-h-[44px]"
            >
              <Save className="h-4 w-4 mr-2" />
              {saveProductMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          )}
          <Badge variant={product.isActive ? "default" : "secondary"} className="text-xs">
            {product.isActive ? "Active" : "Inactive"}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        <div className="lg:col-span-2 order-2 lg:order-1">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="overview" className="min-h-[44px]" data-testid="tab-overview">
                <Package className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Overview</span>
              </TabsTrigger>
              <TabsTrigger value="variants" className="min-h-[44px]" data-testid="tab-variants">
                <Layers className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Variants</span>
                <span className="ml-1">({sortedVariants.length})</span>
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
                  <div className="space-y-1.5">
                    <Label className="text-xs md:text-sm">Description</Label>
                    <Textarea
                      value={editForm.description}
                      onChange={(e) => updateField("description", e.target.value)}
                      rows={3}
                      className="resize-none"
                    />
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
                      <Label className="text-xs md:text-sm">Safety Stock (units)</Label>
                      <Input
                        type="number"
                        min={0}
                        value={editForm.safetyStockQty}
                        onChange={(e) => updateField("safetyStockQty", parseInt(e.target.value) || 0)}
                        className="h-9"
                      />
                      <p className="text-xs text-muted-foreground">
                        Default: {globalDefaultSafetyStock} units
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Catalog Data (read-only, from Shopify sync) */}
              {product.catalogProduct && (
                <Card>
                  <CardHeader className="p-3 md:p-6">
                    <CardTitle className="text-base md:text-lg">Catalog Data</CardTitle>
                    <CardDescription className="text-xs md:text-sm">
                      From Shopify sync (read-only)
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <Label className="text-xs md:text-sm">Title</Label>
                        <p className="mt-1 text-sm">{product.catalogProduct.title}</p>
                      </div>
                      <div>
                        <Label className="text-xs md:text-sm">Status</Label>
                        <Badge variant="outline" className="mt-1 text-xs">
                          {product.catalogProduct.status}
                        </Badge>
                      </div>
                      <div>
                        <Label className="text-xs md:text-sm">Category</Label>
                        <p className="mt-1 text-sm">{product.catalogProduct.category || "-"}</p>
                      </div>
                      <div>
                        <Label className="text-xs md:text-sm">Brand</Label>
                        <p className="mt-1 text-sm">{product.catalogProduct.brand || "-"}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            {/* ===== VARIANTS TAB ===== */}
            <TabsContent value="variants" className="mt-4">
              <Card>
                <CardHeader className="p-3 md:p-6 flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-base md:text-lg">Product Variants</CardTitle>
                    <CardDescription className="text-xs md:text-sm">
                      Pack sizes and configurations
                    </CardDescription>
                  </div>
                  <Button size="sm" onClick={openCreateVariant} className="min-h-[44px]">
                    <Plus className="h-4 w-4 mr-1" />
                    Add Variant
                  </Button>
                </CardHeader>
                <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                  {sortedVariants.length > 0 ? (
                    <>
                      {/* Mobile cards */}
                      <div className="md:hidden space-y-2">
                        {sortedVariants.map((variant) => (
                          <div
                            key={variant.id}
                            className="border rounded-lg p-3"
                            data-testid={`variant-card-mobile-${variant.id}`}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <span className="font-mono text-sm text-primary">{variant.sku}</span>
                              <Badge variant="outline" className="text-xs">
                                {getHierarchyLabel(variant.hierarchyLevel)}
                              </Badge>
                            </div>
                            <p className="text-sm mb-2">{variant.name}</p>
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>Units: {variant.unitsPerVariant}</span>
                              <span className="font-mono">{variant.barcode || "No barcode"}</span>
                            </div>
                            <div className="flex justify-end gap-2 mt-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openEditVariant(variant)}
                                className="min-h-[44px]"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDeleteVariant(variant)}
                                className="min-h-[44px] text-destructive hover:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                      {/* Desktop table */}
                      <div className="hidden md:block">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>SKU</TableHead>
                              <TableHead>Name</TableHead>
                              <TableHead>Type</TableHead>
                              <TableHead>Units</TableHead>
                              <TableHead>Barcode</TableHead>
                              <TableHead className="w-[80px]"></TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {sortedVariants.map((variant) => (
                              <TableRow
                                key={variant.id}
                                data-testid={`variant-row-${variant.id}`}
                              >
                                <TableCell className="font-mono">{variant.sku}</TableCell>
                                <TableCell>{variant.name}</TableCell>
                                <TableCell>
                                  <Badge variant="outline" className="text-xs">
                                    {getHierarchyLabel(variant.hierarchyLevel)}
                                  </Badge>
                                </TableCell>
                                <TableCell>{variant.unitsPerVariant}</TableCell>
                                <TableCell className="font-mono text-sm">
                                  {variant.barcode || "-"}
                                </TableCell>
                                <TableCell>
                                  <div className="flex gap-1">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8"
                                      onClick={() => openEditVariant(variant)}
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 text-destructive hover:text-destructive"
                                      onClick={() => handleDeleteVariant(variant)}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </>
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      <Layers className="h-10 w-10 md:h-12 md:w-12 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No variants defined for this product.</p>
                      <Button
                        variant="link"
                        onClick={openCreateVariant}
                        className="text-xs mt-1"
                      >
                        Add your first variant
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ===== INVENTORY TAB ===== */}
            <TabsContent value="inventory" className="mt-4">
              <Card>
                <CardHeader className="p-3 md:p-6">
                  <CardTitle className="text-base md:text-lg">Inventory Levels</CardTitle>
                  <CardDescription className="text-xs md:text-sm">
                    Stock levels across warehouse locations
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
                  <div className="text-center py-8 text-muted-foreground">
                    <BarChart3 className="h-10 w-10 md:h-12 md:w-12 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">Inventory tracking coming soon.</p>
                    <p className="text-xs">Connect inventory levels to see stock by location.</p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        {/* Sidebar */}
        <div className="space-y-4 order-1 lg:order-2">
          <Card>
            <CardHeader className="p-3 md:p-6">
              <CardTitle className="text-base md:text-lg">Product Image</CardTitle>
            </CardHeader>
            <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
              <div className="aspect-square bg-muted rounded-lg flex items-center justify-center overflow-hidden">
                {product.imageUrl ? (
                  <img
                    src={product.imageUrl}
                    alt={product.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <ImageIcon className="h-12 w-12 md:h-16 md:w-16 text-muted-foreground/30" />
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-3 md:p-6">
              <CardTitle className="text-base md:text-lg">Quick Stats</CardTitle>
            </CardHeader>
            <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-3">
              <div className="flex justify-between">
                <span className="text-xs md:text-sm text-muted-foreground">Variants</span>
                <span className="text-sm font-medium">{sortedVariants.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs md:text-sm text-muted-foreground">Has Catalog</span>
                <span className="text-sm font-medium">
                  {product.catalogProduct ? "Yes" : "No"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs md:text-sm text-muted-foreground">Lead Time</span>
                <span className="text-sm font-medium">{product.leadTimeDays}d</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs md:text-sm text-muted-foreground">Status</span>
                <Badge
                  variant={product.isActive ? "default" : "secondary"}
                  className="text-xs"
                >
                  {product.isActive ? "Active" : "Inactive"}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ===== VARIANT EDITOR DIALOG ===== */}
      <Dialog open={variantDialogOpen} onOpenChange={setVariantDialogOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingVariant ? "Edit Variant" : "Add Variant"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={String(variantForm.hierarchyLevel)}
                onValueChange={(v) => handleTypeChange(parseInt(v))}
              >
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HIERARCHY_TYPES.map((t) => (
                    <SelectItem key={t.level} value={String(t.level)}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Units Per Variant</Label>
              <Input
                type="number"
                min={1}
                value={variantForm.unitsPerVariant}
                onChange={(e) => handleUnitsChange(parseInt(e.target.value) || 1)}
                className="h-11"
              />
            </div>

            <div className="space-y-1.5">
              <Label>SKU</Label>
              <Input
                value={variantForm.sku}
                onChange={(e) => {
                  setSkuManuallyEdited(true);
                  setVariantForm((prev) => ({ ...prev, sku: e.target.value }));
                }}
                className="h-11 font-mono"
              />
              {!skuManuallyEdited && (
                <p className="text-xs text-muted-foreground">Auto-generated from product SKU</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Display Name</Label>
              <Input
                value={variantForm.name}
                onChange={(e) => {
                  setNameManuallyEdited(true);
                  setVariantForm((prev) => ({ ...prev, name: e.target.value }));
                }}
                className="h-11"
              />
              {!nameManuallyEdited && (
                <p className="text-xs text-muted-foreground">Auto-generated from product name</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Barcode</Label>
              <Input
                value={variantForm.barcode}
                onChange={(e) => setVariantForm((prev) => ({ ...prev, barcode: e.target.value }))}
                placeholder="Optional"
                className="h-11"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setVariantDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (editingVariant) {
                  updateVariantMutation.mutate({ id: editingVariant.id, data: variantForm });
                } else {
                  createVariantMutation.mutate(variantForm);
                }
              }}
              disabled={createVariantMutation.isPending || updateVariantMutation.isPending}
            >
              {editingVariant
                ? updateVariantMutation.isPending
                  ? "Saving..."
                  : "Save Changes"
                : createVariantMutation.isPending
                  ? "Creating..."
                  : "Create Variant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
