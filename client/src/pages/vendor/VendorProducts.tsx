import React, { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Package,
  Search,
  Check,
  X,
  Upload,
  Loader2,
  ImageOff,
  ChevronLeft,
  ChevronRight,
  Filter,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useVendorAuth } from "@/lib/vendor-auth";
import {
  fetchVendorProducts,
  selectVendorProducts,
  deselectVendorProduct,
  pushToEbay,
} from "@/lib/vendor-api";
import { useToast } from "@/hooks/use-toast";

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

type FilterMode = "all" | "true" | "false";

export default function VendorProducts() {
  const { vendor } = useVendorAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [selectedForPush, setSelectedForPush] = useState<Set<number>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ["vendor-products", page, search, filterMode],
    queryFn: () =>
      fetchVendorProducts({
        page,
        limit: 24,
        search: search || undefined,
        selected: filterMode === "all" ? undefined : filterMode,
      }),
    staleTime: 15_000,
  });

  const selectMutation = useMutation({
    mutationFn: (productIds: number[]) => selectVendorProducts(productIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vendor-products"] });
      queryClient.invalidateQueries({ queryKey: ["vendor-dashboard"] });
      toast({ title: "Products selected" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deselectMutation = useMutation({
    mutationFn: (productId: number) => deselectVendorProduct(productId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vendor-products"] });
      queryClient.invalidateQueries({ queryKey: ["vendor-dashboard"] });
      toast({ title: "Product removed" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const pushMutation = useMutation({
    mutationFn: (productIds: number[]) => pushToEbay(productIds),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["vendor-products"] });
      toast({
        title: "Push complete",
        description: `${data.pushed} product(s) pushed to eBay`,
      });
      setSelectedForPush(new Set());
    },
    onError: (err: Error) => toast({ title: "Push failed", description: err.message, variant: "destructive" }),
  });

  const products = data?.products ?? [];
  const pagination = data?.pagination ?? { page: 1, total: 0, total_pages: 1 };
  const ebayConnected = vendor?.ebay_connected ?? false;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  };

  const togglePushSelect = (id: number) => {
    setSelectedForPush((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllForPush = () => {
    const eligible = products.filter((p: any) => p.selected).map((p: any) => p.id);
    setSelectedForPush(new Set(eligible));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Products</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Browse and select products for your eBay store
          </p>
        </div>
        {ebayConnected && selectedForPush.size > 0 && (
          <Button
            onClick={() => pushMutation.mutate(Array.from(selectedForPush))}
            disabled={pushMutation.isPending}
            className="bg-red-600 hover:bg-red-700 min-h-[44px]"
          >
            {pushMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            Push {selectedForPush.size} to eBay
          </Button>
        )}
      </div>

      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <form onSubmit={handleSearch} className="flex gap-2 flex-1">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input
              placeholder="Search products..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-10 min-h-[44px]"
            />
          </div>
          <Button type="submit" variant="outline" className="min-h-[44px]">
            Search
          </Button>
        </form>
        <div className="flex gap-2">
          {(["all", "true", "false"] as FilterMode[]).map((mode) => (
            <Button
              key={mode}
              variant={filterMode === mode ? "default" : "outline"}
              size="sm"
              className="min-h-[44px]"
              onClick={() => {
                setFilterMode(mode);
                setPage(1);
              }}
            >
              {mode === "all" ? "All" : mode === "true" ? "Selected" : "Available"}
            </Button>
          ))}
        </div>
      </div>

      {/* Select All for Push */}
      {ebayConnected && products.some((p: any) => p.selected) && (
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            className="min-h-[44px]"
            onClick={selectAllForPush}
          >
            Select All for Push
          </Button>
          {selectedForPush.size > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="min-h-[44px]"
              onClick={() => setSelectedForPush(new Set())}
            >
              Clear Selection
            </Button>
          )}
        </div>
      )}

      {/* Product Grid */}
      {isLoading ? (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-full rounded-xl" />
          ))}
        </div>
      ) : products.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Package className="h-12 w-12 text-muted-foreground mb-3 opacity-50" />
            <p className="text-muted-foreground">No products found</p>
            {search && (
              <Button
                variant="link"
                className="mt-2 min-h-[44px]"
                onClick={() => {
                  setSearch("");
                  setSearchInput("");
                }}
              >
                Clear search
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {products.map((product: any) => (
            <Card
              key={product.id}
              className={`overflow-hidden transition-all ${
                selectedForPush.has(product.id) ? "ring-2 ring-red-600" : ""
              }`}
            >
              {/* Image */}
              <div className="aspect-square bg-muted relative overflow-hidden">
                {product.image_url ? (
                  <img
                    src={product.image_url}
                    alt={product.title}
                    className="object-cover w-full h-full"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <ImageOff className="h-8 w-8 text-muted-foreground opacity-40" />
                  </div>
                )}
                {product.selected && (
                  <Badge className="absolute top-2 right-2 bg-green-600 text-white border-0">
                    Selected
                  </Badge>
                )}
              </div>

              <CardContent className="p-4 space-y-3">
                <div>
                  <h3 className="text-sm font-semibold line-clamp-2 leading-tight">
                    {product.title}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">{product.sku}</p>
                </div>

                <div className="flex items-center justify-between text-sm">
                  <div>
                    <span className="text-xs text-muted-foreground">Wholesale</span>
                    <p className="font-semibold text-green-600">
                      {formatCents(product.wholesale_price_cents)}
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-muted-foreground">ATP</span>
                    <p className="font-semibold">{product.atp}</p>
                  </div>
                </div>

                <div className="flex gap-2">
                  {product.selected ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 min-h-[44px] text-destructive border-destructive/20 hover:bg-destructive/10"
                        onClick={() => deselectMutation.mutate(product.id)}
                        disabled={deselectMutation.isPending}
                      >
                        <X className="mr-1 h-4 w-4" />
                        Remove
                      </Button>
                      {ebayConnected && (
                        <Button
                          variant={selectedForPush.has(product.id) ? "default" : "outline"}
                          size="sm"
                          className="min-h-[44px]"
                          onClick={() => togglePushSelect(product.id)}
                        >
                          <Upload className="h-4 w-4" />
                        </Button>
                      )}
                    </>
                  ) : (
                    <Button
                      size="sm"
                      className="flex-1 min-h-[44px] bg-red-600 hover:bg-red-700"
                      onClick={() => selectMutation.mutate([product.id])}
                      disabled={selectMutation.isPending}
                    >
                      <Check className="mr-1 h-4 w-4" />
                      Select
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Pagination */}
      {pagination.total_pages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.total_pages} · {pagination.total} products
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="min-h-[44px]"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-[44px]"
              disabled={page >= pagination.total_pages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
