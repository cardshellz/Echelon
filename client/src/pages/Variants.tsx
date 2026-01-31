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
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Package className="h-6 w-6" />
            Variants
          </h1>
          <p className="text-muted-foreground">
            Manage sellable SKUs and link them to products
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold">{stats.total}</div>
            <div className="text-sm text-muted-foreground">Total Variants</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold text-green-600">{stats.linked}</div>
            <div className="text-sm text-muted-foreground">Linked</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold text-amber-600">{stats.unlinked}</div>
            <div className="text-sm text-muted-foreground">Unlinked</div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div className="flex flex-wrap gap-2 items-center w-full sm:w-auto">
          <div className="relative w-full sm:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search variants..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 w-full"
              data-testid="input-search-variants"
            />
          </div>
          <Select value={linkFilter} onValueChange={setLinkFilter}>
            <SelectTrigger className="w-36" data-testid="select-link-filter">
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
                <p>No variants found. Sync from Shopify to import variants.</p>
              </div>
            ) : (
              <p>No variants match your filters.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
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
      )}

      <div className="text-sm text-muted-foreground">
        Showing {filteredVariants.length} of {allVariants.length} variants
      </div>

      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link Variant to Product</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label>Variant</Label>
              <p className="text-sm font-mono mt-1">{selectedVariant?.sku}</p>
              <p className="text-sm text-muted-foreground">{selectedVariant?.name}</p>
            </div>
            <div>
              <Label htmlFor="product-select">Select Product</Label>
              <Select value={selectedProductId} onValueChange={setSelectedProductId}>
                <SelectTrigger id="product-select" className="mt-1">
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkDialogOpen(false)}>
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
            >
              {linkMutation.isPending ? "Linking..." : "Link Variant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
