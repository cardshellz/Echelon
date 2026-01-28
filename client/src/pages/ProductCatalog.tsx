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

  const productsWithVariants: ProductWithVariants[] = items.map(item => ({
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
      case 1: return "Base Unit (Piece)";
      case 2: return "Pack";
      case 3: return "Case";
      case 4: return "Pallet";
      default: return `Level ${level}`;
    }
  };

  const buildHierarchyTree = (variants: UomVariant[]) => {
    const baseUnit = variants.find(v => v.hierarchyLevel === 1);
    const storableVariants = variants.filter(v => v.hierarchyLevel > 1);
    return { baseUnit, storableVariants };
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
      <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-10 p-4 md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight flex items-center gap-2">
              <Layers className="h-6 w-6" />
              Product Catalog
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Manage products and their unit of measure (UOM) hierarchy
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 md:w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Search products or SKUs..."
                className="pl-9 h-9"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                data-testid="input-search-catalog"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 p-4 md:p-6 overflow-auto">
        {filteredProducts.length === 0 ? (
          <div className="flex-1 bg-card rounded-md border flex flex-col items-center justify-center text-center p-12">
            <div className="bg-primary/10 p-4 rounded-full mb-4">
              <Package className="h-10 w-10 text-primary" />
            </div>
            <h2 className="text-2xl font-bold mb-2">No Products Found</h2>
            <p className="text-muted-foreground max-w-md">
              {searchQuery ? "No products match your search." : "Add products via Shopify sync or manually to see them here."}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredProducts.map(({ item, variants }) => {
              const { baseUnit, storableVariants } = buildHierarchyTree(variants);
              const isExpanded = expandedProducts.has(item.id);

              return (
                <Card key={item.id} data-testid={`card-product-${item.id}`}>
                  <Collapsible open={isExpanded} onOpenChange={() => toggleExpanded(item.id)}>
                    <CollapsibleTrigger asChild>
                      <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {isExpanded ? (
                              <ChevronDown className="h-5 w-5 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-5 w-5 text-muted-foreground" />
                            )}
                            <div>
                              <CardTitle className="text-base font-mono">{item.baseSku}</CardTitle>
                              <CardDescription className="mt-1">{item.name}</CardDescription>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{variants.length} variants</Badge>
                            {baseUnit && (
                              <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                                Base: {baseUnit.name}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </CardHeader>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <CardContent className="pt-0">
                        <div className="border rounded-lg overflow-hidden">
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
                              {baseUnit && (
                                <tr className="border-t bg-blue-50/50 dark:bg-blue-950/20">
                                  <td className="px-4 py-3 font-mono text-sm text-primary">{baseUnit.sku}</td>
                                  <td className="px-4 py-3 text-sm">{baseUnit.name}</td>
                                  <td className="px-4 py-3">
                                    <Badge variant="secondary" className="text-xs">
                                      {getVariantTypeLabel(baseUnit.hierarchyLevel)}
                                    </Badge>
                                  </td>
                                  <td className="px-4 py-3 text-right font-mono text-sm text-muted-foreground">
                                    1 (base)
                                  </td>
                                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                                    {baseUnit.barcode || "-"}
                                  </td>
                                  <td className="px-4 py-3 text-right">
                                    <span className="text-xs text-muted-foreground">Purchase Unit</span>
                                  </td>
                                </tr>
                              )}
                              {storableVariants.map((variant) => (
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
                                        className="w-20 h-8 text-right font-mono ml-auto"
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
                                          className="h-7 w-7"
                                          onClick={() => saveEdit(variant.id)}
                                          disabled={updateVariantMutation.isPending}
                                          data-testid={`button-save-${variant.id}`}
                                        >
                                          <Save className="h-4 w-4 text-green-600" />
                                        </Button>
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-7 w-7"
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
                                        className="h-7 w-7"
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
