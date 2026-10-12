import { useQuery } from "@tanstack/react-query";
import { channelCatalogStockSchema } from "@shared/types/channel-catalog";
import { publicationRequest } from "./api";

export function useListingStock(
  channelId: number,
  connectionId: number | undefined,
  skus: readonly string[],
  enabled: boolean,
) {
  const exactSkus = [...new Set(skus)].sort();
  const query = useQuery({
    queryKey: [
      `/api/channels/${channelId}/catalog`,
      "stock",
      connectionId,
      exactSkus,
    ],
    enabled: enabled && !!connectionId && exactSkus.length > 0,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const items = [];
      for (let offset = 0; offset < exactSkus.length; offset += 50) {
        const result = await publicationRequest(
          "POST",
          `/api/channels/${channelId}/catalog/stock`,
          channelCatalogStockSchema,
          { connectionId, skus: exactSkus.slice(offset, offset + 50) },
        );
        if (result.connectionId !== connectionId)
          throw new Error(
            "The connection changed. Refresh listings to check stock.",
          );
        items.push(...result.items);
      }
      return items;
    },
  });
  return {
    ...query,
    bySku: new Map((query.data ?? []).map((item) => [item.sku, item])),
  };
}
