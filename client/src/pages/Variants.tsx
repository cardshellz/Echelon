import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { 
  Package, 
  Search, 
  Link as LinkIcon,
  Plus,
  Filter
} from "lucide-react";

interface Product {
  id: number;
  sku: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  isActive: boolean;
}

interface ProductVariant {
  id: number;
  productId: number;
  sku: string | null;
  name: string;
  unitsPerVariant: number;
  hierarchyLevel: number;
  barcode: string | null;
  shopifyVariantId: string | null;
  isActive: boolean;
}

export default function Variants() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [linkFilter, setLinkFilter] = useState<string>("all");
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createProductDialogOpen, setCreateProductDialogOpen] = useState(false);
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

  const { data: products = [] } = useQuery<Product[]>({
    queryKey: ["/api/products"],
    select: (data) => data.map((p: any) => ({ 
      id: p.id, 
      sku: p.sku, 
      name: p.name, 
      category: p.category, 
      brand: p.brand, 
      isActive: p.isActive 
    })),
  });

  const { data: allVariants = [], isLoading } = useQuery<ProductVariant[]>({
    queryKey: ["/api/product-variants"],
  });

  const linkMutation = useMutation({
    mutationFn: async ({ variantId, productId }: { variantId: number; productId: number }) => {
      const res = await fetch(`/api/product-variants/${variantId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
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
    onError: () => {
      toast({ title: "Failed to link variant", variant: "destructive" });
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
    onError: () => {
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

  const filteredVariants = allVariants.filter(variant => {
    const matchesSearch = searchQuery === "" || 
      variant.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      variant.sku?.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesLink = linkFilter === "all" || 
      (linkFilter === "linked" && variant.productId) ||
      (linkFilter === "unlinked" && !variant.productId);
    
    return matchesSearch && matchesLink;
  });

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

  const stats = {
    total: allVariants.length,
    linked: allVariants.filter(v => v.productId).length,
    unlinked: allVariants.filter(v => !v.productId).length,
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
        <Button onClick={() => setCreateDialogOpen(true)} className="min-h-[44px] w-full md:w-auto" data-testid="btn-add-variant">
          <Plus className="h-4 w-4 mr-2" />
          Add Variant
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2 md:gap-4">
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
          <Select value={linkFilter} onValueChange={setLinkFilter}>
            <SelectTrigger className="w-28 md:w-36 h-10" data-testid="select-link-filter">
              <SelectValue placeholder="Filter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
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
                  <TableHead>Variant SKU</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Units</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Linked Product</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredVariants.map((variant) => (
                  <TableRow key={variant.id} data-testid={`variant-row-${variant.id}`}>
                    <TableCell className="font-mono text-sm">{variant.sku || '-'}</TableCell>
                    <TableCell>{variant.name}</TableCell>
                    <TableCell>{variant.unitsPerVariant}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{getHierarchyLabel(variant.hierarchyLevel)}</Badge>
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
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}

      <div className="text-xs md:text-sm text-muted-foreground">
        Showing {filteredVariants.length} of {allVariants.length} variants
      </div>

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
              <Label htmlFor="product-select" className="text-sm">Select Product</Label>
              <Select value={selectedProductId} onValueChange={setSelectedProductId}>
                <SelectTrigger id="product-select" className="mt-1 h-11">
                  <SelectValue placeholder="Choose a product..." />
                </SelectTrigger>
                <SelectContent>
                  {products.map((product) => (
                    <SelectItem key={product.id} value={product.id.toString()}>
                      {product.sku ? `${product.sku} - ` : ''}{product.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                <Select 
                  value={newVariant.productId} 
                  onValueChange={(val) => setNewVariant({ ...newVariant, productId: val })}
                >
                  <SelectTrigger className="flex-1 h-11">
                    <SelectValue placeholder="Select a product..." />
                  </SelectTrigger>
                  <SelectContent>
                    {products.map((product) => (
                      <SelectItem key={product.id} value={product.id.toString()}>
                        {product.sku ? `${product.sku} - ` : ''}{product.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
