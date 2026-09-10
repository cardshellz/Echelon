import { useQuery } from "@tanstack/react-query";

export function useInventoryQuantityCapabilities() {
  return useQuery<{ legacyQuantityImportAllowed: boolean }>({
    queryKey: ["/api/inventory/quantity-capabilities"],
    staleTime: 0,
  });
}
