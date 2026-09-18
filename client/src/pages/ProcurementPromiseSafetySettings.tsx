import React, { useDeferredValue, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { inventoryPlanningProductOptionsResponseSchema } from "@shared/types/inventory-availability-admin";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import {
  inventoryPlanningProductHref,
  parseInventoryPlanningProductId,
} from "./inventory-planning-navigation";
import { PromiseSafetyPolicyPanel } from "./promise-safety-policy-panel";
import { productOptionLabel } from "./supply-transformations-model";
import { fetchJson } from "./inventory-planning-http";

const PAGE_PATH = "/settings/procurement/promise-safety";

export default function ProcurementPromiseSafetySettings() {
  const { hasPermission } = useAuth();
  const canView = hasPermission("inventory_planning", "view");
  const canEdit = hasPermission("inventory_planning", "edit");
  const [, navigate] = useLocation();
  const search = useSearch();
  const productId = parseInventoryPlanningProductId(search);
  const [productSearch, setProductSearch] = useState("");
  const deferredSearch = useDeferredValue(productSearch.trim());
  const productsQuery = useQuery({
    queryKey: ["/api/inventory-planning/admin/products", deferredSearch],
    queryFn: async ({ signal }) => {
      if (!canView) throw new Error("Inventory planning view permission is required.");
      const parameters = new URLSearchParams({ limit: "50" });
      if (deferredSearch) parameters.set("q", deferredSearch);
      return (await fetchJson(
        `/api/inventory-planning/admin/products?${parameters}`,
        inventoryPlanningProductOptionsResponseSchema,
        { signal },
      )).products;
    },
    enabled: canView,
  });

  if (!canView) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">ATP promise safety</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Inventory planning view permission is required. No promise-safety data is shown.
        </p>
      </div>
    );
  }

  const products = productsQuery.data ?? [];
  const selectedProductMissing = productId !== null && !products.some((product) => product.id === productId);
  const invalidProductLink = new URLSearchParams(search).has("productId") && productId === null;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-bold">ATP promise safety</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Procurement settings · promise-safety floors and demand evidence.
          This is separate from the purchasing reorder buffer (safetyStockDays).
          Saving a safety draft does not activate it or change live ATP.
        </p>
      </header>
      <Card>
        <CardHeader><CardTitle>Choose a product</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="promise-safety-product-search">Search products</Label>
              <Input
                id="promise-safety-product-search"
                value={productSearch}
                maxLength={100}
                onChange={(event) => setProductSearch(event.target.value)}
                placeholder="Product name or SKU"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="promise-safety-product">Product</Label>
              <select
                id="promise-safety-product"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={productId ?? ""}
                onChange={(event) => {
                  const nextProductId = parseInventoryPlanningProductId(
                    new URLSearchParams({ productId: event.target.value }).toString(),
                  );
                  navigate(inventoryPlanningProductHref(PAGE_PATH, nextProductId));
                }}
              >
                <option value="">Choose a product</option>
                {selectedProductMissing && <option value={productId}>Selected product #{productId}</option>}
                {products.map((product) => (
                  <option key={product.id} value={product.id}>{productOptionLabel(product)}</option>
                ))}
              </select>
            </div>
          </div>
          {productsQuery.isLoading && <p role="status" className="text-sm">Loading products…</p>}
          {productsQuery.isError && (
            <div role="alert" className="text-sm text-destructive">
              {productsQuery.error.message}
              <Button type="button" variant="link" disabled={productsQuery.isFetching} onClick={() => productsQuery.refetch()}>
                Retry product search
              </Button>
            </div>
          )}
          {invalidProductLink && <p role="alert" className="text-sm text-destructive">The product link is invalid. Choose a product to continue.</p>}
          {!productsQuery.isLoading && !productsQuery.isError && products.length === 0 && (
            <p className="text-sm text-muted-foreground">No products match this search.</p>
          )}
        </CardContent>
      </Card>
      {productId === null ? (
        <p className="text-sm text-muted-foreground">Select a product to review its ATP safety policies and warehouse/SKU demand evidence.</p>
      ) : (
        <PromiseSafetyPolicyPanel key={productId} productId={productId} canView={canView} canEdit={canEdit} />
      )}
    </div>
  );
}
