/**
 * Product Type Manager — assign product types to products
 * 
 * Features:
 * - View all products with current type or "Unassigned"
 * - Filter by assigned/unassigned
 * - Search by name/SKU
 * - Bulk-select and assign product type
 * - Individual assignment via dropdown
 */

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Tag, Search, Filter, CheckCircle2, Loader2, Package, X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProductType {
  id: number;
  slug: string;
  name: string;
  sortOrder: number;
}

interface ProductWithType {
  id: number;
  sku: string | null;
  name: string;
  title: string | null;
  category: string | null;
  productType: string | null;
  isActive: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UNASSIGN_VALUE = "__unassign__";
const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProductTypeManager({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "assigned" | "unassigned">("all");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkType, setBulkType] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Data queries
  const { data: productTypesData = [] } = useQuery<ProductType[]>({
    queryKey: ["/api/product-types"],
    enabled: open,
  });

  const { data: productsData = [], isLoading } = useQuery<ProductWithType[]>({
    queryKey: ["/api/products/with-types", filterMode, search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filterMode !== "all") params.set("filter", filterMode);
      if (search.trim()) params.set("search", search.trim());
      const res = await fetch(`/api/products/with-types?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load products");
      return res.json();
    },
    enabled: open,
  });

  // Visible products (paginated client-side)
  const visibleProducts = useMemo(() => productsData.slice(0, visibleCount), [productsData, visibleCount]);

  // Product types map
  const typeMap = useMemo(() => {
    const m = new Map<string, string>();
    productTypesData.forEach(t => m.set(t.slug, t.name));
    return m;
  }, [productTypesData]);

  // Stats
  const assignedCount = productsData.filter(p => p.productType).length;
  const unassignedCount = productsData.filter(p => !p.productType).length;

  // Selection helpers
  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === visibleProducts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visibleProducts.map(p => p.id)));
    }
  };

  // Mutations
  const updateSingle = useMutation({
    mutationFn: async ({ id, productType }: { id: number; productType: string | null }) => {
      await apiRequest("PUT", `/api/products/${id}/product-type`, { productType });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/products/with-types"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

  const bulkAssign = useMutation({
    mutationFn: async () => {
      const productType = bulkType === UNASSIGN_VALUE ? null : bulkType;
      await apiRequest("PUT", "/api/products/bulk-product-type", {
        productIds: Array.from(selectedIds),
        productType,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/products/with-types"] });
      setSelectedIds(new Set());
      setBulkType("");
      toast({ title: `Updated ${selectedIds.size} products` });
    },
    onError: (err: Error) => {
      toast({ title: "Bulk update failed", description: err.message, variant: "destructive" });
    },
  });

  // Reset on close
  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setSearch("");
      setFilterMode("all");
      setSelectedIds(new Set());
      setBulkType("");
      setVisibleCount(PAGE_SIZE);
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="h-5 w-5" />
            Product Type Assignments
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 flex flex-col min-h-0 space-y-3">
          {/* Toolbar */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
                placeholder="Search by name or SKU..."
                className="h-8 text-xs pl-8"
              />
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant={filterMode === "all" ? "default" : "outline"}
                size="sm"
                className="h-8 text-xs"
                onClick={() => { setFilterMode("all"); setVisibleCount(PAGE_SIZE); }}
              >
                All ({productsData.length})
              </Button>
              <Button
                variant={filterMode === "unassigned" ? "default" : "outline"}
                size="sm"
                className="h-8 text-xs"
                onClick={() => { setFilterMode("unassigned"); setVisibleCount(PAGE_SIZE); }}
              >
                Unassigned
              </Button>
              <Button
                variant={filterMode === "assigned" ? "default" : "outline"}
                size="sm"
                className="h-8 text-xs"
                onClick={() => { setFilterMode("assigned"); setVisibleCount(PAGE_SIZE); }}
              >
                Assigned
              </Button>
            </div>
          </div>

          {/* Bulk actions */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2 p-2 bg-muted/50 rounded-lg border">
              <Badge variant="secondary" className="text-xs">
                {selectedIds.size} selected
              </Badge>
              <Select value={bulkType} onValueChange={setBulkType}>
                <SelectTrigger className="h-8 text-xs w-[220px]">
                  <SelectValue placeholder="Assign type..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGN_VALUE}>
                    <span className="text-muted-foreground italic">Unassign</span>
                  </SelectItem>
                  {productTypesData.map(t => (
                    <SelectItem key={t.slug} value={t.slug}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={!bulkType || bulkAssign.isPending}
                onClick={() => bulkAssign.mutate()}
              >
                {bulkAssign.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                Apply
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setSelectedIds(new Set())}
              >
                <X className="h-3 w-3 mr-1" /> Clear
              </Button>
            </div>
          )}

          {/* Product list */}
          <div className="flex-1 overflow-y-auto min-h-0 border rounded-lg">
            {isLoading ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading products...
              </div>
            ) : productsData.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-sm text-muted-foreground">
                <Package className="h-8 w-8 mb-2" />
                No products found
              </div>
            ) : (
              <>
                {/* Header */}
                <div className="sticky top-0 bg-background border-b px-3 py-2 flex items-center gap-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wider z-10">
                  <div className="w-6">
                    <Checkbox
                      checked={selectedIds.size === visibleProducts.length && visibleProducts.length > 0}
                      onCheckedChange={toggleSelectAll}
                    />
                  </div>
                  <div className="w-[120px]">SKU</div>
                  <div className="flex-1">Product</div>
                  <div className="w-[200px]">Type</div>
                </div>

                {/* Rows */}
                {visibleProducts.map(product => (
                  <div
                    key={product.id}
                    className={`px-3 py-2 flex items-center gap-3 border-b last:border-0 hover:bg-muted/30 transition-colors ${
                      selectedIds.has(product.id) ? "bg-muted/50" : ""
                    }`}
                  >
                    <div className="w-6">
                      <Checkbox
                        checked={selectedIds.has(product.id)}
                        onCheckedChange={() => toggleSelect(product.id)}
                      />
                    </div>
                    <div className="w-[120px] truncate">
                      <span className="font-mono text-xs">{product.sku || "—"}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{product.name}</p>
                      {product.category && (
                        <p className="text-[10px] text-muted-foreground truncate">{product.category}</p>
                      )}
                    </div>
                    <div className="w-[200px]">
                      <Select
                        value={product.productType || UNASSIGN_VALUE}
                        onValueChange={(v) => {
                          const val = v === UNASSIGN_VALUE ? null : v;
                          updateSingle.mutate({ id: product.id, productType: val });
                        }}
                      >
                        <SelectTrigger className={`h-7 text-xs ${!product.productType ? "text-muted-foreground italic" : ""}`}>
                          <SelectValue>
                            {product.productType ? (typeMap.get(product.productType) || product.productType) : "Unassigned"}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={UNASSIGN_VALUE}>
                            <span className="text-muted-foreground italic">Unassigned</span>
                          </SelectItem>
                          {productTypesData.map(t => (
                            <SelectItem key={t.slug} value={t.slug}>{t.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}

                {/* Load more */}
                {visibleCount < productsData.length && (
                  <div className="p-3 text-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs"
                      onClick={() => setVisibleCount(prev => prev + PAGE_SIZE)}
                    >
                      Show more ({productsData.length - visibleCount} remaining)
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <div className="text-xs text-muted-foreground">
            {productsData.length} products • {assignedCount} assigned • {unassignedCount} unassigned
          </div>
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
