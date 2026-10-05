import type { QueryClient } from "@tanstack/react-query";

/** Catalog-backed previews must refresh when a retained page or browser tab returns. */
export const catalogImageQueryOptions = {
  meta: { usesCatalogImages: true },
  staleTime: 0,
  refetchOnMount: "always" as const,
  refetchOnWindowFocus: true,
};

/** Refresh references, without replacing draft items or their explicit overrides. */
export async function invalidateCatalogImages(client: QueryClient, productRouteId: number | null): Promise<void> {
  await client.invalidateQueries({
    predicate: query => query.meta?.usesCatalogImages === true
      || (productRouteId !== null && query.queryKey[0] === `/api/products/${productRouteId}`)
      || query.queryKey[0] === "/api/products"
      || query.queryKey[0] === "/api/product-variants",
  });
}
