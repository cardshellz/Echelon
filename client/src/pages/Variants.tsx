import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty } from "@/components/ui/command";
import {
  Package,
  Search,
  Link as LinkIcon,
  Plus,
  Download,
  Upload,
  AlertTriangle,
  ShieldAlert,
  Pencil,
  Trash2,
  ChevronsUpDown,
  Check
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";

interface Product {
  id: number;
  sku: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  isActive: boolean;
  status: string | null;
  productLineIds?: number[];
}

interface ProductVariant {
  id: number;
  productId: number;
  sku: string | null;
  name: string;
  unitsPerVariant: number;
  hierarchyLevel: number;
  parentVariantId: number | null;
  barcode: string | null;
  shopifyVariantId: string | null;
  isActive: boolean;
  dropshipEligible?: boolean;
}

export default function Variants() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [linkFilter, setLinkFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [productLineFilter, setProductLineFilter] = useState<string>("all");
  const [selectedVariantIds, setSelectedVariantIds] = useState<number[]>([]);
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createProductDialogOpen, setCreateProductDialogOpen] = useState(false);
  const [linkProductOpen, setLinkProductOpen] = useState(false);
  const [linkProductSearch, setLinkProductSearch] = useState("");
  const [createProductPickerOpen, setCreateProductPickerOpen] = useState(false);
  const [createProductSearch, setCreateProductSearch] = useState("");
  const [newVariant, setNewVariant] = useState({
    productId: "",
    sku: "",
    name: "",
    unitsPerVariant: 1,
    hierarchyLevel: 1,
    barcode: "",
  });
  const [newProduct, setNewProduct] = useState({
    name: "",
    sku: "",
    baseUnit: "piece",
  });
  const [skuConflict, setSkuConflict] = useState<{
    open: boolean;
    conflictVariant: { id: number; sku: string; productId: number; productName: string | null } | null;
    action: "rename" | "deactivate" | null;
    newSku: string;
  }>({ open: false, conflictVariant: null, action: null, newSku: "" });

  const { data: products = [] } = useQuery<Product[]>({
    queryKey: ["/api/products"],
    select: (data) => data.map((p: any) => ({ 
      id: p.id, 
      sku: p.sku, 
      name: p.name, 
      category: p.category, 
      brand: p.brand, 
      isActive: p.isActive,
      status: p.status,
      productLineIds: p.productLineIds,
    })),
  });

  const { data: allVariants = [], isLoading } = useQuery<ProductVariant[]>({
    queryKey: ["/api/product-variants", { includeInactive: true }],
    queryFn: async () => {
      const res = await fetch("/api/product-variants?includeInactive=true");
      if (!res.ok) throw new Error("Failed to fetch variants");
      return res.json();
    },
  });

  const { data: productLines = [] } = useQuery<{id: number, name: string}[]>({
    queryKey: ["/api/product-lines"],
    queryFn: async () => {
      const res = await fetch("/api/product-lines");
      if (!res.ok) throw new Error("Failed to fetch product lines");
      return res.json();
    },
  });

  const linkMutation = useMutation({
    mutationFn: async ({ variantId, productId }: { variantId: number; productId: number }) => {
      const res = await fetch(`/api/product-variants/${variantId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      if (res.status === 409) {
        const body = await res.json();
        setSkuConflict({
          open: true,
          conflictVariant: body.conflictVariant,
          action: null,
          newSku: "",
        });
        throw new Error("SKU_CONFLICT");
      }
      if (!res.ok) throw new Error("Failed to link variant");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-variants"] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      toast({ title: "Variant linked successfully" });
      setLinkDialogOpen(false);
      setSelectedVariant(null);
      setSelectedProductId("");
    },
    onError: (error) => {
      if (error.message === "SKU_CONFLICT") return;
      toast({ title: "Failed to link variant", variant: "destructive" });
    },
  });

  const dropshipMutation = useMutation({
    mutationFn: async ({ variantId, eligible }: { variantId: number; eligible: boolean }) => {
      const res = await fetch(`/api/admin/variants/${variantId}/dropship-eligible`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eligible }),
      });
      if (!res.ok) throw new Error("Failed to update dropship eligibility");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-variants"] });
      toast({ title: "Dropship eligibility updated" });
    },
    onError: () => {
      toast({ title: "Failed to update dropship eligibility", variant: "destructive" });
    },
  });

  const bulkDropshipMutation = useMutation({
    mutationFn: async ({ variantIds, eligible }: { variantIds: number[]; eligible: boolean }) => {
      const res = await fetch("/api/admin/variants/bulk-dropship-eligible", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantIds, eligible }),
      });
      if (!res.ok) throw new Error("Failed to update bulk dropship eligibility");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-variants"] });
      setSelectedVariantIds([]);
      toast({ title: "Bulk dropship eligibility updated" });
    },
    onError: () => {
      toast({ title: "Failed to update bulk dropship eligibility", variant: "destructive" });
    },
  });

  const createVariantMutation = useMutation({
    mutationFn: async (data: typeof newVariant) => {
      const res = await fetch(`/api/products/${data.productId}/variants`, {
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
      if (res.status === 409) {
        const body = await res.json();
        setSkuConflict({
          open: true,
          conflictVariant: body.conflictVariant,
          action: null,
          newSku: "",
        });
        throw new Error("SKU_CONFLICT");
      }
      if (!res.ok) throw new Error("Failed to create variant");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-variants"] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      toast({ title: "Variant created successfully" });
      setCreateDialogOpen(false);
      setNewVariant({ productId: "", sku: "", name: "", unitsPerVariant: 1, hierarchyLevel: 1, barcode: "" });
    },
    onError: (error) => {
      if (error.message === "SKU_CONFLICT") return; // handled by conflict dialog
      toast({ title: "Failed to create variant", variant: "destructive" });
    },
  });

  const createProductMutation = useMutation({
    mutationFn: async (data: typeof newProduct) => {
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name,
          sku: data.sku || null,
          baseUnit: data.baseUnit,
        }),
      });
      if (!res.ok) throw new Error("Failed to create product");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      toast({ title: "Product created successfully" });
      setCreateProductDialogOpen(false);
      setNewProduct({ name: "", sku: "", baseUnit: "piece" });
      setNewVariant({ ...newVariant, productId: data.id.toString() });
    },
    onError: () => {
      toast({ title: "Failed to create product", variant: "destructive" });
    },
  });

  const deactivateVariantMutation = useMutation({
    mutationFn: async (variantId: number) => {
      const res = await fetch(`/api/product-variants/${variantId}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      if (!res.ok) throw new Error("Failed to archive variant");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-variants"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory"] });
      toast({ title: "Conflicting variant archived" });
      // Now retry the original create
      setSkuConflict(prev => ({ ...prev, open: false }));
      createVariantMutation.mutate(newVariant);
    },
    onError: () => {
      toast({ title: "Failed to archive variant", variant: "destructive" });
    },
  });

  const [csvUploading, setCsvUploading] = useState(false);

  const bulkParentMutation = useMutation({
    mutationFn: async (rows: { sku: string; parent_sku: string }[]) => {
      const res = await fetch("/api/product-variants/bulk-parent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      if (!res.ok) throw new Error("Failed to update parent assignments");
      return res.json();
    },
    onSuccess: (data: { updated: number; skipped: number; errors: string[]; total: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-variants"] });
      const errMsg = data.errors.length > 0 ? ` Errors: ${data.errors.slice(0, 3).join(", ")}${data.errors.length > 3 ? "..." : ""}` : "";
      toast({ title: `Updated ${data.updated} of ${data.total} variants.${errMsg}` });
      setCsvUploading(false);
    },
    onError: () => {
      toast({ title: "Failed to update parent assignments", variant: "destructive" });
      setCsvUploading(false);
    },
  });

  const handleCsvExport = () => {
    const skuMap = new Map<number, string>();
    for (const v of allVariants) {
      if (v.sku) skuMap.set(v.id, v.sku);
    }
    const header = "sku,parent_sku";
    const rows = allVariants
      .filter((v) => v.sku)
      .map((v) => {
        const parentSku = v.parentVariantId ? skuMap.get(v.parentVariantId) || "" : "";
        return `${v.sku},${parentSku}`;
      });
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "variant-parents.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCsvImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvUploading(true);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) {
        toast({ title: "CSV must have header + data rows", variant: "destructive" });
        setCsvUploading(false);
        return;
      }
      const rows = lines.slice(1).map((line) => {
        const [sku, parent_sku] = line.split(",").map((s) => s.trim());
        return { sku, parent_sku };
      });
      bulkParentMutation.mutate(rows);
    };
    reader.readAsText(file);
    // Reset input so same file can be re-selected
    e.target.value = "";
  };

  const filteredVariants = allVariants.filter(variant => {
    const matchesSearch = searchQuery === "" || 
      variant.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      variant.sku?.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesLink = linkFilter === "all" || 
      (linkFilter === "linked" && variant.productId) ||
      (linkFilter === "unlinked" && !variant.productId);

    const product = products.find(p => p.id === variant.productId);
    
    const matchesStatus = statusFilter === "all" ||
      (statusFilter === "active" && variant.isActive) ||
      (statusFilter === "inactive" && !variant.isActive) ||
      (statusFilter === "archived" && product?.status === "archived");

    const matchesCategory = categoryFilter === "all" || 
      product?.category === categoryFilter;

    const matchesProductLine = productLineFilter === "all" ||
      (product && product.productLineIds?.includes(parseInt(productLineFilter)));
    
    return matchesSearch && matchesLink && matchesStatus && matchesCategory && matchesProductLine;
  });

  const categories = Array.from(new Set(products
    .map(p => p.category)
    .filter((c): c is string => Boolean(c))
  ));

  const getProductName = (productId: number) => {
    const product = products.find(p => p.id === productId);
    return product ? product.name : "Unknown";
  };

  const getProductSku = (productId: number) => {
    const product = products.find(p => p.id === productId);
    return product?.sku || "-";
  };

  const getHierarchyLabel = (level: number) => {
    switch (level) {
      case 1: return "Pack";
      case 2: return "Box";
      case 3: return "Case";
      default: return `Level ${level}`;
    }
  };

  const variantSkuMap = new Map<number, string>();
  for (const v of allVariants) {
    if (v.sku) variantSkuMap.set(v.id, v.sku);
  }

  const stats = {
    total: allVariants.length,
    linked: allVariants.filter(v => v.productId).length,
    unlinked: allVariants.filter(v => !v.productId).length,
    needsConfig: allVariants.filter(v => !v.parentVariantId && v.hierarchyLevel > 1).length,
  };

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <Package className="h-5 w-5 md:h-6 md:w-6" />
            Variants
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage sellable SKUs and link them to products
          </p>
        </div>
        <div className="flex gap-2 w-full md:w-auto">
          <Button variant="outline" onClick={handleCsvExport} className="min-h-[44px]" title="Export parent assignments CSV">
            <Download className="h-4 w-4 mr-1" />
            <span className="hidden md:inline">Export</span>
          </Button>
          <label>
            <Button variant="outline" className="min-h-[44px] cursor-pointer" asChild disabled={csvUploading}>
              <span>
                <Upload className="h-4 w-4 mr-1" />
                <span className="hidden md:inline">{csvUploading ? "Importing..." : "Import"}</span>
              </span>
            </Button>
            <input type="file" accept=".csv" className="hidden" onChange={handleCsvImport} />
          </label>
          <Button onClick={() => setCreateDialogOpen(true)} className="min-h-[44px] flex-1 md:flex-initial" data-testid="btn-add-variant">
            <Plus className="h-4 w-4 mr-2" />
            Add Variant
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 md:gap-4">
        <Card>
          <CardContent className="p-2 md:p-4">
            <div className="text-xl md:text-2xl font-bold">{stats.total}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Total Variants</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-green-600">{stats.linked}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Linked</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-amber-600">{stats.unlinked}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Unlinked</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-yellow-600">{stats.needsConfig}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Needs Config</div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
        <div className="flex flex-wrap gap-2 items-center w-full md:w-auto">
          <div className="relative w-full md:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search variants..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 w-full h-10"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-testid="input-search-variants"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-28 md:w-36 h-10" data-testid="select-status-filter">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
          {categories.length > 0 && (
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-32 md:w-40 h-10" data-testid="select-category-filter">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map(cat => (
                  <SelectItem key={cat} value={cat!}>{cat}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {productLines.length > 0 && (
            <Select value={productLineFilter} onValueChange={setProductLineFilter}>
              <SelectTrigger className="w-32 md:w-40 h-10" data-testid="select-productline-filter">
                <SelectValue placeholder="Product Line" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Product Lines</SelectItem>
                {productLines.map((pl) => (
                  <SelectItem key={pl.id} value={pl.id.toString()}>{pl.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={linkFilter} onValueChange={setLinkFilter}>
            <SelectTrigger className="w-28 md:w-36 h-10" data-testid="select-link-filter">
              <SelectValue placeholder="Link Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Links</SelectItem>
              <SelectItem value="linked">Linked</SelectItem>
              <SelectItem value="unlinked">Unlinked</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-12">Loading variants...</div>
      ) : filteredVariants.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {allVariants.length === 0 ? (
              <div className="space-y-4">
                <Package className="h-12 w-12 mx-auto opacity-50" />
                <p className="text-sm">No variants found. Sync from Shopify to import variants.</p>
              </div>
            ) : (
              <p className="text-sm">No variants match your filters.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="md:hidden space-y-2">
            {filteredVariants.map((variant) => (
              <Card key={variant.id} data-testid={`variant-card-mobile-${variant.id}`}>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-sm truncate">{variant.sku || '-'}</p>
                      <p className="text-sm text-muted-foreground truncate">{variant.name}</p>
                    </div>
                    <Badge variant={variant.isActive ? "default" : "secondary"} className="text-xs flex-shrink-0">
                      {variant.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="outline" className="text-xs">{getHierarchyLabel(variant.hierarchyLevel)}</Badge>
                    <span className="text-xs text-muted-foreground">Units: {variant.unitsPerVariant}</span>
                  </div>
                  {variant.productId ? (
                    <div className="text-xs mb-2">
                      <span className="text-muted-foreground">Product: </span>
                      <span className="font-medium">{getProductName(variant.productId)}</span>
                    </div>
                  ) : (
                    <Badge variant="secondary" className="text-xs mb-2">Unlinked</Badge>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full min-h-[44px]"
                    onClick={() => {
                      setSelectedVariant(variant);
                      setSelectedProductId(variant.productId?.toString() || "");
                      setLinkDialogOpen(true);
                    }}
                    data-testid={`btn-link-variant-mobile-${variant.id}`}
                  >
                    <LinkIcon className="h-4 w-4 mr-1" />
                    {variant.productId ? "Change Link" : "Link to Product"}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <Checkbox 
                      checked={filteredVariants.length > 0 && selectedVariantIds.length === filteredVariants.length}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setSelectedVariantIds(filteredVariants.map(v => v.id));
                        } else {
                          setSelectedVariantIds([]);
                        }
                      }}
                    />
                  </TableHead>
                  <TableHead>Variant SKU</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Units</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Breaks Into</TableHead>
                  <TableHead>Linked Product</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Dropship</TableHead>
                  <TableHead className="w-24">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredVariants.map((variant) => {
                  const parentSku = variant.parentVariantId ? variantSkuMap.get(variant.parentVariantId) : null;
                  const needsConfig = !variant.parentVariantId && variant.hierarchyLevel > 1;
                  return (
                  <TableRow key={variant.id} data-testid={`variant-row-${variant.id}`}>
                    <TableCell>
                      <Checkbox 
                        checked={selectedVariantIds.includes(variant.id)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedVariantIds(prev => [...prev, variant.id]);
                          } else {
                            setSelectedVariantIds(prev => prev.filter(id => id !== variant.id));
                          }
                        }}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-sm">{variant.sku || '-'}</TableCell>
                    <TableCell>{variant.name}</TableCell>
                    <TableCell>{variant.unitsPerVariant}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{getHierarchyLabel(variant.hierarchyLevel)}</Badge>
                    </TableCell>
                    <TableCell>
                      {parentSku ? (
                        <span className="font-mono text-xs">{parentSku}</span>
                      ) : needsConfig ? (
                        <Badge variant="outline" className="text-xs bg-yellow-50 text-yellow-700 border-yellow-300">
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          Needs config
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Base</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {variant.productId ? (
                        <div>
                          <p className="font-medium">{getProductName(variant.productId)}</p>
                          <p className="text-sm text-muted-foreground font-mono">{getProductSku(variant.productId)}</p>
                        </div>
                      ) : (
                        <Badge variant="secondary">Unlinked</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={variant.isActive ? "default" : "secondary"}>
                        {variant.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={!!variant.dropshipEligible}
                        onCheckedChange={(checked) => {
                          dropshipMutation.mutate({ variantId: variant.id, eligible: checked });
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-[44px]"
                        onClick={() => {
                          setSelectedVariant(variant);
                          setSelectedProductId(variant.productId?.toString() || "");
                          setLinkDialogOpen(true);
                        }}
                        data-testid={`btn-link-variant-${variant.id}`}
                      >
                        <LinkIcon className="h-4 w-4 mr-1" />
                        {variant.productId ? "Change" : "Link"}
                      </Button>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        </>
      )}

      <div className="text-xs md:text-sm text-muted-foreground">
        Showing {filteredVariants.length} of {allVariants.length} variants
      </div>

      {selectedVariantIds.length > 0 && (
        <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 bg-slate-900 text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-4 z-50 border border-slate-700 animate-in slide-in-from-bottom-10 fade-in duration-300">
          <span className="text-sm font-medium">{selectedVariantIds.length} Variants Selected</span>
          <div className="h-4 w-px bg-slate-600"></div>
          <Button 
            size="sm" 
            variant="ghost" 
            className="hover:bg-slate-800 text-green-400 hover:text-green-300 transition-colors"
            onClick={() => bulkDropshipMutation.mutate({ variantIds: selectedVariantIds, eligible: true })}
            disabled={bulkDropshipMutation.isPending}
          >
            Enable Dropship
          </Button>
          <Button 
            size="sm" 
            variant="ghost" 
            className="hover:bg-slate-800 text-red-400 hover:text-red-300 transition-colors"
            onClick={() => bulkDropshipMutation.mutate({ variantIds: selectedVariantIds, eligible: false })}
            disabled={bulkDropshipMutation.isPending}
          >
            Disable Dropship
          </Button>
        </div>
      )}

      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Link Variant to Product</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label className="text-sm">Variant</Label>
              <p className="text-sm font-mono mt-1">{selectedVariant?.sku}</p>
              <p className="text-sm text-muted-foreground">{selectedVariant?.name}</p>
            </div>
            <div>
              <Label className="text-sm">Select Product</Label>
              <Popover open={linkProductOpen} onOpenChange={setLinkProductOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" className="w-full justify-between h-10 font-normal mt-1">
                    {selectedProductId
                      ? (() => { const p = products.find(p => p.id.toString() === selectedProductId); return p ? `${p.sku ? p.sku + ' - ' : ''}${p.name}` : 'Choose a product...'; })()
                      : "Choose a product..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput placeholder="Search products..." value={linkProductSearch} onValueChange={setLinkProductSearch} />
                    <CommandList>
                      <CommandEmpty>No products found.</CommandEmpty>
                      <CommandGroup>
                        {products
                          .filter(p => {
                            const q = linkProductSearch.toLowerCase();
                            return !q || (p.sku || '').toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
                          })
                          .slice(0, 50)
                          .map((product) => (
                            <CommandItem
                              key={product.id}
                              value={product.id.toString()}
                              onSelect={() => {
                                setSelectedProductId(product.id.toString());
                                setLinkProductOpen(false);
                                setLinkProductSearch("");
                              }}
                            >
                              <Check className={`mr-2 h-4 w-4 ${selectedProductId === product.id.toString() ? "opacity-100" : "opacity-0"}`} />
                              <span className="font-mono text-xs mr-2">{product.sku || '-'}</span>
                              <span className="truncate">{product.name}</span>
                            </CommandItem>
                          ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setLinkDialogOpen(false)} className="min-h-[44px]">
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (selectedVariant && selectedProductId) {
                  linkMutation.mutate({
                    variantId: selectedVariant.id,
                    productId: parseInt(selectedProductId),
                  });
                }
              }}
              disabled={!selectedProductId || linkMutation.isPending}
              className="min-h-[44px]"
            >
              {linkMutation.isPending ? "Linking..." : "Link Variant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Add New Variant</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label className="text-sm">Parent Product *</Label>
              <div className="flex gap-2">
                <Popover open={createProductPickerOpen} onOpenChange={setCreateProductPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" role="combobox" className="flex-1 justify-between h-10 font-normal">
                      {newVariant.productId
                        ? (() => { const p = products.find(p => p.id.toString() === newVariant.productId); return p ? `${p.sku ? p.sku + ' - ' : ''}${p.name}` : 'Select a product...'; })()
                        : "Select a product..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                    <Command shouldFilter={false}>
                      <CommandInput placeholder="Search products..." value={createProductSearch} onValueChange={setCreateProductSearch} />
                      <CommandList>
                        <CommandEmpty>No products found.</CommandEmpty>
                        <CommandGroup>
                          {products
                            .filter(p => {
                              const q = createProductSearch.toLowerCase();
                              return !q || (p.sku || '').toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
                            })
                            .slice(0, 50)
                            .map((product) => (
                              <CommandItem
                                key={product.id}
                                value={product.id.toString()}
                                onSelect={() => {
                                  setNewVariant({ ...newVariant, productId: product.id.toString() });
                                  setCreateProductPickerOpen(false);
                                  setCreateProductSearch("");
                                }}
                              >
                                <Check className={`mr-2 h-4 w-4 ${newVariant.productId === product.id.toString() ? "opacity-100" : "opacity-0"}`} />
                                <span className="font-mono text-xs mr-2">{product.sku || '-'}</span>
                                <span className="truncate">{product.name}</span>
                              </CommandItem>
                            ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <Button
                  variant="outline"
                  size="icon"
                  className="min-h-[44px] min-w-[44px]"
                  onClick={() => setCreateProductDialogOpen(true)}
                  title="Create new product"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="variant-sku" className="text-sm">SKU</Label>
                <Input
                  id="variant-sku"
                  value={newVariant.sku}
                  onChange={(e) => setNewVariant({ ...newVariant, sku: e.target.value })}
                  placeholder="e.g., ARM-ENV-SGL-P50"
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="variant-barcode" className="text-sm">Barcode</Label>
                <Input
                  id="variant-barcode"
                  value={newVariant.barcode}
                  onChange={(e) => setNewVariant({ ...newVariant, barcode: e.target.value })}
                  placeholder="UPC/EAN"
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="variant-name" className="text-sm">Name *</Label>
              <Input
                id="variant-name"
                value={newVariant.name}
                onChange={(e) => setNewVariant({ ...newVariant, name: e.target.value })}
                placeholder="e.g., Pack of 50"
                className="h-11"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="variant-units" className="text-sm">Units per Variant</Label>
                <Input
                  id="variant-units"
                  type="number"
                  min={1}
                  value={newVariant.unitsPerVariant}
                  onChange={(e) => setNewVariant({ ...newVariant, unitsPerVariant: parseInt(e.target.value) || 1 })}
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-sm">Type</Label>
                <Select 
                  value={newVariant.hierarchyLevel.toString()} 
                  onValueChange={(val) => setNewVariant({ ...newVariant, hierarchyLevel: parseInt(val) })}
                >
                  <SelectTrigger className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Pack</SelectItem>
                    <SelectItem value="2">Box</SelectItem>
                    <SelectItem value="3">Case</SelectItem>
                    <SelectItem value="4">Pallet</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)} className="min-h-[44px]">
              Cancel
            </Button>
            <Button
              onClick={() => createVariantMutation.mutate(newVariant)}
              disabled={!newVariant.productId || !newVariant.name || createVariantMutation.isPending}
              className="min-h-[44px]"
            >
              {createVariantMutation.isPending ? "Creating..." : "Create Variant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* SKU Conflict Resolution Dialog */}
      <Dialog open={skuConflict.open} onOpenChange={(open) => setSkuConflict(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <ShieldAlert className="h-5 w-5" />
              SKU Conflict
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              The SKU <span className="font-mono font-medium text-foreground">{skuConflict.conflictVariant?.sku}</span> is already in use by another active variant.
            </p>
            {skuConflict.conflictVariant && (
              <div className="rounded-md border p-3 bg-muted/30 space-y-1">
                <div className="text-xs text-muted-foreground">Existing variant</div>
                <div className="text-sm font-mono">{skuConflict.conflictVariant.sku}</div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Product: </span>
                  {skuConflict.conflictVariant.productName || "Unknown"} (ID: {skuConflict.conflictVariant.productId})
                </div>
                <div className="text-xs text-muted-foreground">Variant ID: {skuConflict.conflictVariant.id}</div>
              </div>
            )}

            <div className="space-y-2">
              <p className="text-sm font-medium">How would you like to resolve this?</p>

              {/* Option 1: Rename SKU */}
              <div className="rounded-md border p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Pencil className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Use a different SKU</span>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={skuConflict.newSku}
                    onChange={(e) => setSkuConflict(prev => ({ ...prev, newSku: e.target.value }))}
                    placeholder="Enter corrected SKU"
                    className="h-9 font-mono text-sm"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-[36px]"
                    disabled={!skuConflict.newSku.trim() || createVariantMutation.isPending}
                    onClick={() => {
                      const updated = { ...newVariant, sku: skuConflict.newSku.trim() };
                      setNewVariant(updated);
                      setSkuConflict(prev => ({ ...prev, open: false }));
                      createVariantMutation.mutate(updated);
                    }}
                  >
                    Retry
                  </Button>
                </div>
              </div>

              {/* Option 2: Deactivate old */}
              <div className="rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Deactivate existing & retry</span>
                  </div>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="min-h-[36px]"
                    disabled={deactivateVariantMutation.isPending || !skuConflict.conflictVariant}
                    onClick={() => {
                      if (skuConflict.conflictVariant) {
                        deactivateVariantMutation.mutate(skuConflict.conflictVariant.id);
                      }
                    }}
                  >
                    {deactivateVariantMutation.isPending ? "Archiving..." : "Archive & Retry"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Archives the existing variant (cleans up inventory, feeds, bins) and retries creating yours.
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSkuConflict(prev => ({ ...prev, open: false }))} className="min-h-[44px]">
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createProductDialogOpen} onOpenChange={setCreateProductDialogOpen}>
        <DialogContent className="max-w-sm max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Create New Product</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="new-product-name" className="text-sm">Name *</Label>
              <Input
                id="new-product-name"
                value={newProduct.name}
                onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })}
                placeholder="Product name"
                className="h-11"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-product-sku" className="text-sm">SKU</Label>
              <Input
                id="new-product-sku"
                value={newProduct.sku}
                onChange={(e) => setNewProduct({ ...newProduct, sku: e.target.value })}
                placeholder="e.g., ARM-ENV-SGL"
                className="h-11"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-sm">Base Unit</Label>
              <Select 
                value={newProduct.baseUnit} 
                onValueChange={(val) => setNewProduct({ ...newProduct, baseUnit: val })}
              >
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="piece">Piece</SelectItem>
                  <SelectItem value="pack">Pack</SelectItem>
                  <SelectItem value="box">Box</SelectItem>
                  <SelectItem value="case">Case</SelectItem>
                  <SelectItem value="pallet">Pallet</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCreateProductDialogOpen(false)} className="min-h-[44px]">
              Cancel
            </Button>
            <Button
              onClick={() => createProductMutation.mutate(newProduct)}
              disabled={!newProduct.name || createProductMutation.isPending}
              className="min-h-[44px]"
            >
              {createProductMutation.isPending ? "Creating..." : "Create & Select"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
