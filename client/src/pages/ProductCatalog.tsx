import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Layers,
  Search,
  ChevronRight,
  ChevronDown,
  Package,
  Edit2,
  Save,
  X,
  RefreshCw,
  Plus
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface UomVariant {
  id: number;
  sku: string;
  inventoryItemId: number;
  name: string;
  unitsPerVariant: number;
  hierarchyLevel: number;
  parentVariantId: number | null;
  barcode: string | null;
  active: number;
}

interface InventoryItem {
  id: number;
  baseSku: string;
  name: string;
  description: string | null;
  baseUnit: string;
  costPerUnit: number | null;
  active: number;
}

interface ProductWithVariants {
  item: InventoryItem;
  variants: UomVariant[];
}

export default function ProductCatalog() {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedProducts, setExpandedProducts] = useState<Set<number>>(new Set());
  const [editingVariant, setEditingVariant] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: items = [], isLoading: loadingItems } = useQuery<InventoryItem[]>({
    queryKey: ["/api/inventory/items"],
  });

  const { data: variants = [], isLoading: loadingVariants } = useQuery<UomVariant[]>({
    queryKey: ["/api/inventory/variants"],
  });

  const updateVariantMutation = useMutation({
    mutationFn: async ({ variantId, unitsPerVariant }: { variantId: number; unitsPerVariant: number }) => {
      const response = await apiRequest("PATCH", `/api/inventory/variants/${variantId}`, { unitsPerVariant });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Variant updated successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/variants"] });
      setEditingVariant(null);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update variant", description: error.message, variant: "destructive" });
    },
  });

  const parentItemsOnly = items.filter(item => {
    const itemVariants = variants.filter(v => v.inventoryItemId === item.id);
    return itemVariants.some(v => v.hierarchyLevel === 1);
  });

  const productsWithVariants: ProductWithVariants[] = parentItemsOnly.map(item => ({
    item,
    variants: variants.filter(v => v.inventoryItemId === item.id).sort((a, b) => a.hierarchyLevel - b.hierarchyLevel)
  }));

  const filteredProducts = productsWithVariants.filter(p =>
    (p.item.baseSku || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (p.item.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.variants.some(v => v.sku.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const toggleExpanded = (itemId: number) => {
    setExpandedProducts(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const startEdit = (variant: UomVariant) => {
    setEditingVariant(variant.id);
    setEditValue(variant.unitsPerVariant.toString());
  };

  const saveEdit = (variantId: number) => {
    const value = parseInt(editValue);
    if (isNaN(value) || value < 1) {
      toast({ title: "Invalid value", description: "Units per variant must be at least 1", variant: "destructive" });
      return;
    }
    updateVariantMutation.mutate({ variantId, unitsPerVariant: value });
  };

  const cancelEdit = () => {
    setEditingVariant(null);
    setEditValue("");
  };

  const getVariantTypeLabel = (level: number) => {
    switch (level) {
      case 1: return "Piece";
      case 2: return "Pack";
      case 3: return "Case";
      case 4: return "Pallet";
      default: return `Level ${level}`;
    }
  };

  if (loadingItems || loadingVariants) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-10 p-2 md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-lg md:text-2xl font-bold tracking-tight flex items-center gap-2">
              <Layers className="h-5 w-5 md:h-6 md:w-6" />
              Product Catalog
            </h1>
            <p className="text-xs md:text-sm text-muted-foreground mt-1">
              Manage products and their unit of measure (UOM) hierarchy
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 md:w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Search products or SKUs..."
                className="pl-9 h-10"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="input-search-catalog"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 p-2 md:p-6 overflow-auto">
        {filteredProducts.length === 0 ? (
          <div className="flex-1 bg-card rounded-md border flex flex-col items-center justify-center text-center p-8 md:p-12">
            <div className="bg-primary/10 p-4 rounded-full mb-4">
              <Package className="h-8 w-8 md:h-10 md:w-10 text-primary" />
            </div>
            <h2 className="text-xl md:text-2xl font-bold mb-2">No Products Found</h2>
            <p className="text-sm text-muted-foreground max-w-md">
              {searchQuery ? "No products match your search." : "Add products via Shopify sync or manually to see them here."}
            </p>
          </div>
        ) : (
          <div className="space-y-3 md:space-y-4">
            {filteredProducts.map(({ item, variants }) => {
              const isExpanded = expandedProducts.has(item.id);

              return (
                <Card key={item.id} data-testid={`card-product-${item.id}`}>
                  <Collapsible open={isExpanded} onOpenChange={() => toggleExpanded(item.id)}>
                    <CollapsibleTrigger asChild>
                      <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors p-3 md:p-6">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 md:gap-3">
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4 md:h-5 md:w-5 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 md:h-5 md:w-5 text-muted-foreground" />
                            )}
                            <div>
                              <CardTitle className="text-sm md:text-base font-mono">{item.baseSku}</CardTitle>
                              <CardDescription className="mt-1 text-xs md:text-sm">{item.name}</CardDescription>
                            </div>
                          </div>
                          <Badge variant="outline" className="text-xs">{variants.length} variants</Badge>
                        </div>
                      </CardHeader>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <CardContent className="pt-0 p-2 md:p-6 md:pt-0">
                        <div className="md:hidden space-y-2">
                          {variants.map((variant) => (
                            <div key={variant.id} className="border rounded-lg p-3" data-testid={`card-variant-mobile-${variant.id}`}>
                              <div className="flex items-center justify-between mb-2">
                                <span className="font-mono text-sm text-primary">{variant.sku}</span>
                                <Badge variant="outline" className="text-xs">
                                  {getVariantTypeLabel(variant.hierarchyLevel)}
                                </Badge>
                              </div>
                              <p className="text-sm text-muted-foreground mb-2">{variant.name}</p>
                              <div className="flex items-center justify-between">
                                <div>
                                  <span className="text-xs text-muted-foreground">Units:</span>
                                  {editingVariant === variant.id ? (
                                    <Input
                                      type="number"
                                      min="1"
                                      value={editValue}
                                      onChange={(e) => setEditValue(e.target.value)}
                                      className="w-20 h-10 text-right font-mono ml-2 inline-block"
                                      autoComplete="off"
                                      autoCorrect="off"
                                      autoCapitalize="off"
                                      spellCheck={false}
                                      data-testid={`input-units-mobile-${variant.id}`}
                                    />
                                  ) : (
                                    <span className="font-mono text-sm font-medium ml-2">
                                      {variant.unitsPerVariant.toLocaleString()}
                                    </span>
                                  )}
                                </div>
                                <div className="flex gap-1">
                                  {editingVariant === variant.id ? (
                                    <>
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-10 w-10 min-h-[44px]"
                                        onClick={() => saveEdit(variant.id)}
                                        disabled={updateVariantMutation.isPending}
                                        data-testid={`button-save-mobile-${variant.id}`}
                                      >
                                        <Save className="h-4 w-4 text-green-600" />
                                      </Button>
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-10 w-10 min-h-[44px]"
                                        onClick={cancelEdit}
                                        data-testid={`button-cancel-mobile-${variant.id}`}
                                      >
                                        <X className="h-4 w-4 text-red-600" />
                                      </Button>
                                    </>
                                  ) : (
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="h-10 w-10 min-h-[44px]"
                                      onClick={() => startEdit(variant)}
                                      data-testid={`button-edit-mobile-${variant.id}`}
                                    >
                                      <Edit2 className="h-4 w-4" />
                                    </Button>
                                  )}
                                </div>
                              </div>
                              {variant.barcode && (
                                <p className="text-xs text-muted-foreground mt-2 font-mono">
                                  Barcode: {variant.barcode}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                        <div className="hidden md:block border rounded-lg overflow-hidden">
                          <table className="w-full">
                            <thead className="bg-muted/50">
                              <tr>
                                <th className="text-left px-4 py-2 text-sm font-medium">SKU</th>
                                <th className="text-left px-4 py-2 text-sm font-medium">Name</th>
                                <th className="text-left px-4 py-2 text-sm font-medium">Type</th>
                                <th className="text-right px-4 py-2 text-sm font-medium">Units Per</th>
                                <th className="text-left px-4 py-2 text-sm font-medium">Barcode</th>
                                <th className="text-right px-4 py-2 text-sm font-medium w-24">Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {variants.map((variant) => (
                                <tr key={variant.id} className="border-t" data-testid={`row-variant-${variant.id}`}>
                                  <td className="px-4 py-3 font-mono text-sm text-primary">{variant.sku}</td>
                                  <td className="px-4 py-3 text-sm">{variant.name}</td>
                                  <td className="px-4 py-3">
                                    <Badge variant="outline" className="text-xs">
                                      {getVariantTypeLabel(variant.hierarchyLevel)}
                                    </Badge>
                                  </td>
                                  <td className="px-4 py-3 text-right">
                                    {editingVariant === variant.id ? (
                                      <Input
                                        type="number"
                                        min="1"
                                        value={editValue}
                                        onChange={(e) => setEditValue(e.target.value)}
                                        className="w-20 h-10 text-right font-mono ml-auto"
                                        autoComplete="off"
                                        autoCorrect="off"
                                        autoCapitalize="off"
                                        spellCheck={false}
                                        data-testid={`input-units-${variant.id}`}
                                      />
                                    ) : (
                                      <span className="font-mono text-sm font-medium">
                                        {variant.unitsPerVariant.toLocaleString()}
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                                    {variant.barcode || "-"}
                                  </td>
                                  <td className="px-4 py-3 text-right">
                                    {editingVariant === variant.id ? (
                                      <div className="flex items-center justify-end gap-1">
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-8 w-8 min-h-[44px]"
                                          onClick={() => saveEdit(variant.id)}
                                          disabled={updateVariantMutation.isPending}
                                          data-testid={`button-save-${variant.id}`}
                                        >
                                          <Save className="h-4 w-4 text-green-600" />
                                        </Button>
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-8 w-8 min-h-[44px]"
                                          onClick={cancelEdit}
                                          data-testid={`button-cancel-${variant.id}`}
                                        >
                                          <X className="h-4 w-4 text-red-600" />
                                        </Button>
                                      </div>
                                    ) : (
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-8 w-8 min-h-[44px]"
                                        onClick={() => startEdit(variant)}
                                        data-testid={`button-edit-${variant.id}`}
                                      >
                                        <Edit2 className="h-4 w-4" />
                                      </Button>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </CardContent>
                    </CollapsibleContent>
                  </Collapsible>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
