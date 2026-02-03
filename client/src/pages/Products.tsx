import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { 
  Package, 
  Search, 
  RefreshCw, 
  Grid3X3, 
  List, 
  Filter,
  ChevronRight,
  Image as ImageIcon,
  MoreVertical,
  Plus
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
  weightGrams: number | null;
  imageUrl: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Product {
  id: number;
  sku: string | null;
  name: string;
  description: string | null;
  baseUnit: string;
  category: string | null;
  brand: string | null;
  imageUrl: string | null;
  shopifyProductId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  variants: ProductVariant[];
}

export default function Products() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState<"grid" | "table">("table");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newProduct, setNewProduct] = useState({
    name: "",
    sku: "",
    description: "",
    category: "",
    brand: "",
    baseUnit: "piece",
  });

  const { data: products = [], isLoading, refetch } = useQuery<Product[]>({
    queryKey: ["/api/products"],
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/shopify/sync-products", { method: "POST" });
      if (!res.ok) throw new Error("Sync failed");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      toast({ 
        title: "Sync Complete", 
        description: `Products: ${data.products?.created || 0} created, ${data.products?.updated || 0} updated. Variants: ${data.variants?.created || 0} created, ${data.variants?.updated || 0} updated.` 
      });
    },
    onError: () => {
      toast({ title: "Sync Failed", variant: "destructive" });
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof newProduct) => {
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name,
          sku: data.sku || null,
          description: data.description || null,
          category: data.category || null,
          brand: data.brand || null,
          baseUnit: data.baseUnit,
        }),
      });
      if (!res.ok) throw new Error("Failed to create product");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      toast({ title: "Product created successfully" });
      setCreateDialogOpen(false);
      setNewProduct({ name: "", sku: "", description: "", category: "", brand: "", baseUnit: "piece" });
    },
    onError: () => {
      toast({ title: "Failed to create product", variant: "destructive" });
    },
  });

  const filteredProducts = products.filter(product => {
    const matchesSearch = searchQuery === "" || 
      product.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      product.sku?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      product.variants?.some(v => v.sku?.toLowerCase().includes(searchQuery.toLowerCase()));
    
    const matchesStatus = statusFilter === "all" || 
      (statusFilter === "active" && product.isActive) ||
      (statusFilter === "inactive" && !product.isActive);
    
    const matchesCategory = categoryFilter === "all" || 
      product.category === categoryFilter;
    
    return matchesSearch && matchesStatus && matchesCategory;
  });

  const categories = Array.from(new Set(products
    .map(p => p.category)
    .filter((c): c is string => Boolean(c))
  ));

  const stats = {
    total: products.length,
    active: products.filter(p => p.isActive).length,
    variants: products.reduce((acc, p) => acc + (p.variants?.length || 0), 0),
  };

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <Package className="h-5 w-5 md:h-6 md:w-6" />
            Products
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage your product catalog and inventory
          </p>
        </div>
        <div className="flex gap-2 w-full md:w-auto">
          <Button
            variant="outline"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="min-h-[44px] flex-1 md:flex-none"
            data-testid="btn-sync-shopify"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">{syncMutation.isPending ? "Syncing..." : "Sync from Shopify"}</span>
            <span className="sm:hidden">{syncMutation.isPending ? "..." : "Sync"}</span>
          </Button>
          <Button onClick={() => setCreateDialogOpen(true)} className="min-h-[44px] flex-1 md:flex-none" data-testid="btn-add-product">
            <Plus className="h-4 w-4 mr-2" />
            Add Product
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 md:gap-4">
        <Card>
          <CardContent className="p-2 md:p-4">
            <div className="text-xl md:text-2xl font-bold">{stats.total}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Total Products</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2 md:p-4">
            <div className="text-xl md:text-2xl font-bold">{stats.active}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Active</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2 md:p-4">
            <div className="text-xl md:text-2xl font-bold">{stats.variants}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Variants</div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
        <div className="flex flex-wrap gap-2 items-center w-full md:w-auto">
          <div className="relative w-full md:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search products..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 w-full h-10"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-testid="input-search-products"
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
        </div>
        <div className="flex gap-1">
          <Button
            variant={viewMode === "table" ? "secondary" : "ghost"}
            size="icon"
            onClick={() => setViewMode("table")}
            className="min-h-[44px] min-w-[44px]"
            data-testid="btn-view-table"
          >
            <List className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === "grid" ? "secondary" : "ghost"}
            size="icon"
            onClick={() => setViewMode("grid")}
            className="min-h-[44px] min-w-[44px]"
            data-testid="btn-view-grid"
          >
            <Grid3X3 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-12">Loading products...</div>
      ) : filteredProducts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {products.length === 0 ? (
              <div className="space-y-4">
                <Package className="h-12 w-12 mx-auto opacity-50" />
                <p>No products found. Click "Sync from Shopify" to import your products.</p>
              </div>
            ) : (
              <p>No products match your filters.</p>
            )}
          </CardContent>
        </Card>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredProducts.map((product) => (
            <Card 
              key={product.id} 
              className="cursor-pointer hover:border-primary transition-colors"
              onClick={() => setLocation(`/products/${product.id}`)}
              data-testid={`product-card-${product.id}`}
            >
              <CardContent className="p-3 md:p-4">
                <div className="aspect-square bg-muted rounded-lg mb-3 flex items-center justify-center overflow-hidden">
                  {product.imageUrl ? (
                    <img 
                      src={product.imageUrl} 
                      alt={product.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <ImageIcon className="h-12 w-12 text-muted-foreground/50" />
                  )}
                </div>
                <div className="space-y-1">
                  <p className="font-medium line-clamp-2 text-sm md:text-base">{product.name}</p>
                  <p className="text-xs md:text-sm text-muted-foreground font-mono">{product.sku || '-'}</p>
                  <div className="flex gap-1 flex-wrap">
                    <Badge variant={product.isActive ? "default" : "secondary"} className="text-xs">
                      {product.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <>
          <div className="md:hidden space-y-2">
            {filteredProducts.map((product) => (
              <Card 
                key={product.id}
                className="cursor-pointer hover:border-primary transition-colors"
                onClick={() => setLocation(`/products/${product.id}`)}
                data-testid={`product-card-mobile-${product.id}`}
              >
                <CardContent className="p-3">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-muted rounded flex-shrink-0 flex items-center justify-center overflow-hidden">
                      {product.imageUrl ? (
                        <img 
                          src={product.imageUrl} 
                          alt={product.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <ImageIcon className="h-5 w-5 text-muted-foreground/50" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{product.name}</p>
                      <p className="text-xs text-muted-foreground font-mono">{product.sku || '-'}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant={product.isActive ? "default" : "secondary"} className="text-xs">
                          {product.isActive ? "Active" : "Inactive"}
                        </Badge>
                        {product.category && (
                          <span className="text-xs text-muted-foreground">{product.category}</span>
                        )}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12"></TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredProducts.map((product) => (
                  <TableRow 
                    key={product.id}
                    className="cursor-pointer"
                    onClick={() => setLocation(`/products/${product.id}`)}
                    data-testid={`product-row-${product.id}`}
                  >
                    <TableCell>
                      <div className="w-10 h-10 bg-muted rounded flex items-center justify-center overflow-hidden">
                        {product.imageUrl ? (
                          <img 
                            src={product.imageUrl} 
                            alt={product.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <ImageIcon className="h-4 w-4 text-muted-foreground/50" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="font-medium">{product.name}</p>
                        {product.brand && (
                          <p className="text-sm text-muted-foreground">{product.brand}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{product.sku || '-'}</TableCell>
                    <TableCell className="capitalize">{product.baseUnit || 'piece'}</TableCell>
                    <TableCell>{product.category || "-"}</TableCell>
                    <TableCell>
                      <Badge variant={product.isActive ? "default" : "secondary"}>
                        {product.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}

      <div className="text-xs md:text-sm text-muted-foreground">
        Showing {filteredProducts.length} of {products.length} products
      </div>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Add New Product</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="product-name" className="text-sm">Name *</Label>
              <Input
                id="product-name"
                value={newProduct.name}
                onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })}
                placeholder="Product name"
                className="h-11"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="input-product-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="product-sku" className="text-sm">SKU</Label>
              <Input
                id="product-sku"
                value={newProduct.sku}
                onChange={(e) => setNewProduct({ ...newProduct, sku: e.target.value })}
                placeholder="e.g., ARM-ENV-SGL"
                className="h-11"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="input-product-sku"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="product-description" className="text-sm">Description</Label>
              <Textarea
                id="product-description"
                value={newProduct.description}
                onChange={(e) => setNewProduct({ ...newProduct, description: e.target.value })}
                placeholder="Product description"
                rows={3}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="input-product-description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="product-category" className="text-sm">Category</Label>
                <Input
                  id="product-category"
                  value={newProduct.category}
                  onChange={(e) => setNewProduct({ ...newProduct, category: e.target.value })}
                  placeholder="e.g., Envelopes"
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-product-category"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="product-brand" className="text-sm">Brand</Label>
                <Input
                  id="product-brand"
                  value={newProduct.brand}
                  onChange={(e) => setNewProduct({ ...newProduct, brand: e.target.value })}
                  placeholder="e.g., Armor"
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-product-brand"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="product-unit" className="text-sm">Base Unit</Label>
              <Select
                value={newProduct.baseUnit}
                onValueChange={(val) => setNewProduct({ ...newProduct, baseUnit: val })}
              >
                <SelectTrigger id="product-unit" className="h-11" data-testid="select-product-unit">
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
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)} className="min-h-[44px]">
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate(newProduct)}
              disabled={!newProduct.name || createMutation.isPending}
              className="min-h-[44px]"
              data-testid="btn-save-product"
            >
              {createMutation.isPending ? "Creating..." : "Create Product"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
