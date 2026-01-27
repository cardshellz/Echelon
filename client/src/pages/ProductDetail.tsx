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
      <div className="p-6 text-center">
        <p className="text-muted-foreground">Invalid product ID</p>
        <Button variant="link" onClick={() => setLocation("/products")}>
          Back to Products
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground">Loading product...</p>
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground">Product not found</p>
        <Button variant="link" onClick={() => setLocation("/products")}>
          Back to Products
        </Button>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button 
          variant="ghost" 
          size="icon"
          onClick={() => setLocation("/products")}
          data-testid="btn-back"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{product?.catalogProduct?.title || product.name}</h1>
          <p className="text-muted-foreground font-mono">{product.baseSku}</p>
        </div>
        <Badge variant={product.active ? "default" : "secondary"}>
          {product.active ? "Active" : "Inactive"}
        </Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="w-full justify-start">
              <TabsTrigger value="overview" data-testid="tab-overview">
                <Package className="h-4 w-4 mr-2" />
                Overview
              </TabsTrigger>
              <TabsTrigger value="variants" data-testid="tab-variants">
                <Layers className="h-4 w-4 mr-2" />
                Variants ({product?.variants?.length || 0})
              </TabsTrigger>
              <TabsTrigger value="inventory" data-testid="tab-inventory">
                <BarChart3 className="h-4 w-4 mr-2" />
                Inventory
              </TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-4 mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Product Information</CardTitle>
                  <CardDescription>Basic product details synced from Shopify</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>Product Name</Label>
                      <p className="mt-1 text-sm">{product.name}</p>
                    </div>
                    <div>
                      <Label>Base SKU</Label>
                      <p className="mt-1 text-sm font-mono">{product.baseSku}</p>
                    </div>
                    <div>
                      <Label>Base Unit</Label>
                      <p className="mt-1 text-sm capitalize">{product.baseUnit}</p>
                    </div>
                    <div>
                      <Label>Cost Per Unit</Label>
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
                      <Label>Description</Label>
                      <p className="mt-1 text-sm text-muted-foreground">{product.description}</p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {product?.catalogProduct && (
                <Card>
                  <CardHeader>
                    <CardTitle>Catalog Data</CardTitle>
                    <CardDescription>Extended product information for sales channels</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Title</Label>
                        <p className="mt-1 text-sm">{product.catalogProduct.title}</p>
                      </div>
                      <div>
                        <Label>Status</Label>
                        <Badge variant="outline" className="mt-1">
                          {product.catalogProduct.status}
                        </Badge>
                      </div>
                      <div>
                        <Label>Category</Label>
                        <p className="mt-1 text-sm">{product.catalogProduct.category || "-"}</p>
                      </div>
                      <div>
                        <Label>Brand</Label>
                        <p className="mt-1 text-sm">{product.catalogProduct.brand || "-"}</p>
                      </div>
                    </div>
                    {product.catalogProduct.description && (
                      <div>
                        <Label>Description</Label>
                        <p className="mt-1 text-sm text-muted-foreground">{product.catalogProduct.description}</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="variants" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Product Variants</CardTitle>
                  <CardDescription>Different pack sizes and configurations</CardDescription>
                </CardHeader>
                <CardContent>
                  {product?.variants && product.variants.length > 0 ? (
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
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      <Layers className="h-12 w-12 mx-auto mb-2 opacity-50" />
                      <p>No variants defined for this product.</p>
                      <p className="text-sm">Use the inventory bootstrap to create variants from SKU patterns.</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="inventory" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Inventory Levels</CardTitle>
                  <CardDescription>Stock levels across warehouse locations</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="text-center py-8 text-muted-foreground">
                    <BarChart3 className="h-12 w-12 mx-auto mb-2 opacity-50" />
                    <p>Inventory tracking coming soon.</p>
                    <p className="text-sm">Connect inventory levels to see stock by location.</p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Product Image</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="aspect-square bg-muted rounded-lg flex items-center justify-center overflow-hidden">
                {product.imageUrl ? (
                  <img 
                    src={product.imageUrl} 
                    alt={product.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <ImageIcon className="h-16 w-16 text-muted-foreground/30" />
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Quick Stats</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Variants</span>
                <span className="font-medium">{product?.variants?.length || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Has Catalog</span>
                <span className="font-medium">{product?.catalogProduct ? "Yes" : "No"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <Badge variant={product.active ? "default" : "secondary"}>
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
