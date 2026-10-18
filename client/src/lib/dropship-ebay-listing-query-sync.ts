import type { QueryClient } from "@tanstack/react-query";
import { fetchJson } from "./dropship-ops-surface";
import type { DropshipEbayListingSetupResponse } from "./dropship-ops-surface";

export function ebayListingSetupQueryKey(storeConnectionId: number) {
  return ["/api/dropship/ebay/listing-setup", storeConnectionId] as const;
}

/**
 * Tells the server this page reads the setup answer with its read-only and
 * "shipping check unavailable" states (server: LISTING_SETUP_CONTRACT_HEADER).
 * Without it the server answers those states with the older errors.
 */
export const EBAY_LISTING_SETUP_CONTRACT_HEADERS: Readonly<Record<string, string>> = {
  "X-Dropship-Listing-Setup-Contract": "2",
};

/**
 * The Listing settings step and its policy and shelf rows observe this one
 * provider read; the rail and step 3 read its cached answer. Server retries
 * are bounded; do not multiply them here.
 */
export function ebayListingSetupQueryOptions(storeConnectionId: number) {
  return {
    queryKey: ebayListingSetupQueryKey(storeConnectionId),
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchJson<DropshipEbayListingSetupResponse>(
      `/api/dropship/ebay/listing-setup/${storeConnectionId}`, { signal, headers: { ...EBAY_LISTING_SETUP_CONTRACT_HEADERS } }),
    enabled: Number.isInteger(storeConnectionId) && storeConnectionId > 0,
    staleTime: 60_000,
    refetchOnMount: true,
    retry: false,
  } as const;
}

/** Retry reads from current server state; never replay a historical save response. */
export async function refreshEbayListingConfiguration(
  queryClient: QueryClient,
  storeConnectionId: number,
): Promise<void> {
  await queryClient.invalidateQueries(
    { queryKey: ebayListingSetupQueryKey(storeConnectionId), exact: true },
    { throwOnError: true },
  );
}

/** Publish a confirmed save to the setup read, or read the setup again when the answer can't stand in for a read. */
export async function synchronizeSavedEbayListingSetup(
  queryClient: QueryClient,
  setup: DropshipEbayListingSetupResponse,
): Promise<void> {
  const setupKey = ebayListingSetupQueryKey(setup.storeConnectionId);
  // Reads started before the save may contain the previous defaults. Cancel them
  // before publishing the write response, even if their transport ignores abort.
  await queryClient.cancelQueries({ queryKey: setupKey, exact: true });
  // A save that did not read everything (a shelf-only or return-only change,
  // or a replayed request) answers with empty option lists or unchecked
  // shipping policies. It must not replace the loaded view, so the setup is
  // read again instead.
  if (setup.checks && (setup.checks.ebay !== "checked" || setup.checks.fulfillment.status !== "checked")) {
    await queryClient.invalidateQueries({ queryKey: setupKey, exact: true }, { throwOnError: true });
    return;
  }
  // Cached in the shape a read answers (no save outcome), so an unchanged
  // refetch keeps the same data and the step's draft.
  const { outcome: _outcome, ...setupView } = setup;
  queryClient.setQueryData<DropshipEbayListingSetupResponse>(setupKey, setupView);
}
