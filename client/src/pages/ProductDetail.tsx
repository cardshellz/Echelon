import { useState } from "react";
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
import { useToast } from "@/hooks/use-toast";
import { 
  ArrowLeft, 
  Package, 
  Save, 
  Image as ImageIcon,
  Layers,
  BarChart3,
  Settings
} from "lucide-react";

interface ProductDetail {
  id: number;
  baseSku: string;
  name: string;
  imageUrl: string | null;
  active: number;
  description: string | null;
  baseUnit: string;
  costPerUnit: number | null;
  catalogProduct: {
    id: number;
    title: string;
    description: string | null;
    status: string;
    category: string | null;
    subcategory: string | null;
    brand: string | null;
    manufacturer: string | null;
    tags: string[] | null;
    seoTitle: string | null;
    seoDescription: string | null;
  } | null;
  variants: Array<{
    id: number;
    sku: string;
    name: string;
    unitsPerVariant: number;
    barcode: string | null;
    imageUrl: string | null;
    hierarchyLevel: number;
  }>;
  assets: Array<{
    id: number;
    url: string;
    altText: string | null;
    assetType: string;
    isPrimary: number;
    position: number;
  }>;
}

export default function ProductDetail() {
  const [, params] = useRoute("/products/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const productId = params?.id ? parseInt(params.id) : null;
  const [activeTab, setActiveTab] = useState("overview");

  const { data: product, isLoading, error } = useQuery<ProductDetail>({
    queryKey: [`/api/products/${productId}`],
    enabled: !!productId,
  });

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
          <h1 className="text-lg md:text-2xl font-bold truncate">{product?.catalogProduct?.title || product.name}</h1>
          <p className="text-sm text-muted-foreground font-mono">{product.baseSku}</p>
        </div>
        <Badge variant={product.active ? "default" : "secondary"} className="text-xs">
          {product.active ? "Active" : "Inactive"}
        </Badge>
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
                <span className="ml-1">({product?.variants?.length || 0})</span>
              </TabsTrigger>
              <TabsTrigger value="inventory" className="min-h-[44px]" data-testid="tab-inventory">
                <BarChart3 className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Inventory</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-4 mt-4">
              <Card>
                <CardHeader className="p-3 md:p-6">
                  <CardTitle className="text-base md:text-lg">Product Information</CardTitle>
                  <CardDescription className="text-xs md:text-sm">Basic product details synced from Shopify</CardDescription>
                </CardHeader>
                <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <Label className="text-xs md:text-sm">Product Name</Label>
                      <p className="mt-1 text-sm">{product.name}</p>
                    </div>
                    <div>
                      <Label className="text-xs md:text-sm">Base SKU</Label>
                      <p className="mt-1 text-sm font-mono">{product.baseSku}</p>
                    </div>
                    <div>
                      <Label className="text-xs md:text-sm">Base Unit</Label>
                      <p className="mt-1 text-sm capitalize">{product.baseUnit}</p>
                    </div>
                    <div>
                      <Label className="text-xs md:text-sm">Cost Per Unit</Label>
                      <p className="mt-1 text-sm">
                        {product.costPerUnit 
                          ? `$${(product.costPerUnit / 100).toFixed(2)}`
                          : "-"
                        }
                      </p>
                    </div>
                  </div>
                  {product.description && (
                    <div>
                      <Label className="text-xs md:text-sm">Description</Label>
                      <p className="mt-1 text-sm text-muted-foreground">{product.description}</p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {product?.catalogProduct && (
                <Card>
                  <CardHeader className="p-3 md:p-6">
                    <CardTitle className="text-base md:text-lg">Catalog Data</CardTitle>
                    <CardDescription className="text-xs md:text-sm">Extended product information for sales channels</CardDescription>
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
                    {product.catalogProduct.description && (
                      <div>
                        <Label className="text-xs md:text-sm">Description</Label>
                        <p className="mt-1 text-sm text-muted-foreground">{product.catalogProduct.description}</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="variants" className="mt-4">
              <Card>
                <CardHeader className="p-3 md:p-6">
                  <CardTitle className="text-base md:text-lg">Product Variants</CardTitle>
                  <CardDescription className="text-xs md:text-sm">Different pack sizes and configurations</CardDescription>
                </CardHeader>
                <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                  {product?.variants && product.variants.length > 0 ? (
                    <>
                      <div className="md:hidden space-y-2">
                        {product.variants.map((variant) => (
                          <div key={variant.id} className="border rounded-lg p-3" data-testid={`variant-card-mobile-${variant.id}`}>
                            <div className="flex items-center justify-between mb-2">
                              <span className="font-mono text-sm text-primary">{variant.sku}</span>
                              <Badge variant="outline" className="text-xs">Level {variant.hierarchyLevel}</Badge>
                            </div>
                            <p className="text-sm mb-2">{variant.name}</p>
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>Units: {variant.unitsPerVariant}</span>
                              <span className="font-mono">{variant.barcode || "No barcode"}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="hidden md:block">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>SKU</TableHead>
                              <TableHead>Name</TableHead>
                              <TableHead>Units</TableHead>
                              <TableHead>Barcode</TableHead>
                              <TableHead>Level</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {product.variants.map((variant) => (
                              <TableRow key={variant.id} data-testid={`variant-row-${variant.id}`}>
                                <TableCell className="font-mono">{variant.sku}</TableCell>
                                <TableCell>{variant.name}</TableCell>
                                <TableCell>{variant.unitsPerVariant}</TableCell>
                                <TableCell className="font-mono text-sm">
                                  {variant.barcode || "-"}
                                </TableCell>
                                <TableCell>
                                  <Badge variant="outline">Level {variant.hierarchyLevel}</Badge>
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
                      <p className="text-xs">Use the inventory bootstrap to create variants from SKU patterns.</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="inventory" className="mt-4">
              <Card>
                <CardHeader className="p-3 md:p-6">
                  <CardTitle className="text-base md:text-lg">Inventory Levels</CardTitle>
                  <CardDescription className="text-xs md:text-sm">Stock levels across warehouse locations</CardDescription>
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
                <span className="text-sm font-medium">{product?.variants?.length || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs md:text-sm text-muted-foreground">Has Catalog</span>
                <span className="text-sm font-medium">{product?.catalogProduct ? "Yes" : "No"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs md:text-sm text-muted-foreground">Status</span>
                <Badge variant={product.active ? "default" : "secondary"} className="text-xs">
                  {product.active ? "Active" : "Inactive"}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
