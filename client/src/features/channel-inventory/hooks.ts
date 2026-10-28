import { useCallback, useRef } from "react";
import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { StockLinkStatus } from "@shared/types/stock-link";

import { ENDPOINTS, fetchPreview, fetchPublicationStatus, fetchPublishingStatus, fetchShopifyLocations, fetchStockLinkStatus, fetchView } from "./api";

/** React Query wiring for the Channel Inventory workspace. */

export const VIEW_QUERY_KEY = [ENDPOINTS.view] as const;
export const PREVIEW_QUERY_KEY = [ENDPOINTS.preview] as const;
export const PUBLISHING_STATUS_QUERY_KEY = [ENDPOINTS.syncStatus] as const;
const PUBLISHING_STATUS_REFRESH_MS = 30_000;

export function useChannelInventoryView(productId: number | null) {
  return useQuery({
    queryKey: [...VIEW_QUERY_KEY, productId],
    queryFn: () => fetchView(productId),
    // Switching the product in focus refetches the same page; keep the last
    // good view on screen instead of flashing to a loading state.
    placeholderData: keepPreviousData,
  });
}

export function useQuantityPreview(publicationTargetId: number | null, productId: number | null) {
  return useQuery({
    queryKey: [...PREVIEW_QUERY_KEY, publicationTargetId, productId],
    queryFn: () => fetchPreview(publicationTargetId!, productId!),
    enabled: publicationTargetId !== null && productId !== null,
    retry: false,
  });
}

export function usePublishingStatus() {
  return useQuery({
    queryKey: PUBLISHING_STATUS_QUERY_KEY,
    queryFn: fetchPublishingStatus,
    refetchInterval: PUBLISHING_STATUS_REFRESH_MS,
  });
}

export function usePublicationStatus(publicationTargetId: number, productId: number) {
  return useQuery({
    queryKey: [ENDPOINTS.publicationStatus, publicationTargetId, productId],
    queryFn: () => fetchPublicationStatus(publicationTargetId, productId),
    refetchInterval: PUBLISHING_STATUS_REFRESH_MS,
    retry: false,
  });
}

export const stockLinkStatusQueryKey = (publicationTargetId: number) => [ENDPOINTS.stockLinkStatus, publicationTargetId] as const;

/**
 * Read only for destinations that can have a stock-link policy (`enabled`); a 404 or bad answer on a first read reads
 * as unsupported. Each refresh passes the cached answer, so a failed refresh after a supported one keeps it (TST-1).
 */
export function useStockLinkStatus(publicationTargetId: number, enabled: boolean) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: stockLinkStatusQueryKey(publicationTargetId),
    queryFn: () => fetchStockLinkStatus(publicationTargetId, queryClient.getQueryData<StockLinkStatus>(stockLinkStatusQueryKey(publicationTargetId))),
    enabled,
    refetchInterval: PUBLISHING_STATUS_REFRESH_MS,
    retry: false,
  });
}

export function useShopifyLocations(channelId: number | null) {
  return useQuery({
    queryKey: [ENDPOINTS.shopifyLocations(channelId ?? 0)],
    queryFn: () => fetchShopifyLocations(channelId!),
    enabled: channelId !== null,
    retry: false,
  });
}

export async function invalidateChannelInventory(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: VIEW_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: PREVIEW_QUERY_KEY }),
  ]);
}

/**
 * One idempotency key per distinct command payload. A retry of the exact same
 * payload (after a lost response) reuses the key so the server replays the
 * original outcome instead of writing twice; any change to the payload or a
 * successful save issues a fresh key.
 */
export function useCommandKey() {
  const retained = useRef<{ fingerprint: string; key: string } | null>(null);
  const keyFor = useCallback((fingerprint: string): string => {
    if (retained.current?.fingerprint !== fingerprint) {
      retained.current = { fingerprint, key: crypto.randomUUID() };
    }
    return retained.current.key;
  }, []);
  const clear = useCallback(() => { retained.current = null; }, []);
  return { keyFor, clear };
}
