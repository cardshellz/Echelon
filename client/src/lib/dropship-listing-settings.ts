import { listingSettingsSummarySchema, type ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { fetchJson } from "./dropship-ops-surface";

/**
 * The Listing settings read model as the Catalog page reads it (design 8.4,
 * 8.9). Contract: shared/dropship/listing-settings.ts. Every answer is checked
 * against that contract here, so the page never shows a value the server did
 * not promise.
 */

function listingSettingsPath(storeConnectionId: number): string {
  return `/api/dropship/listings/stores/${storeConnectionId}/listing-settings`;
}

/** The prefix of every listing settings read for one store: invalidating it refreshes them all. */
export function listingSettingsQueryKey(storeConnectionId: number) {
  return ["/api/dropship/listings/stores", storeConnectionId, "listing-settings"] as const;
}

export function listingSettingsSummaryQueryOptions(storeConnectionId: number) {
  return {
    queryKey: [...listingSettingsQueryKey(storeConnectionId), "summary"] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ListingSettingsSummary> =>
      listingSettingsSummarySchema.parse(await fetchJson(`${listingSettingsPath(storeConnectionId)}/summary`, { signal })),
    enabled: Number.isInteger(storeConnectionId) && storeConnectionId > 0,
    // Saves on this page invalidate it at once; the server's own view is at most 60 seconds old.
    staleTime: 60_000,
    // A failed check says "Couldn't check" with Try again, rather than retrying out of sight.
    retry: false,
  } as const;
}
