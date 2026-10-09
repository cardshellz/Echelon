import type { QueryClient } from "@tanstack/react-query";
import { fetchJson } from "./dropship-ops-surface";
import type {
  DropshipEbayListingPolicyOverrideResponse,
  DropshipEbayListingSetupResponse,
} from "./dropship-ops-surface";

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

/** Both panels observe one provider read. Server retries are bounded; do not multiply them here. */
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

export function ebayListingPolicyQueryKey(storeConnectionId: number) {
  return ["/api/dropship/ebay/listing-policy-overrides", storeConnectionId] as const;
}

/** Retry reads from current server state; never replay a historical save response. */
export async function refreshEbayListingConfiguration(
  queryClient: QueryClient,
  storeConnectionId: number,
): Promise<void> {
  const refreshed = await Promise.allSettled([
    queryClient.invalidateQueries(
      { queryKey: ebayListingSetupQueryKey(storeConnectionId), exact: true },
      { throwOnError: true },
    ),
    queryClient.invalidateQueries(
      { queryKey: ebayListingPolicyQueryKey(storeConnectionId), exact: true },
      { throwOnError: true },
    ),
  ]);
  // Wait for both reads so another retry cannot race an unfinished sibling read.
  for (const result of refreshed) {
    if (result.status === "rejected") throw result.reason;
  }
}

/** Publish a confirmed save before reloading the independently cached assignments. */
export async function synchronizeSavedEbayListingSetup(
  queryClient: QueryClient,
  setup: DropshipEbayListingSetupResponse,
): Promise<void> {
  const setupKey = ebayListingSetupQueryKey(setup.storeConnectionId);
  const policyKey = ebayListingPolicyQueryKey(setup.storeConnectionId);
  // Reads started before the save may contain the previous defaults. Cancel them
  // before publishing the write response, even if their transport ignores abort.
  await Promise.all([
    queryClient.cancelQueries({ queryKey: setupKey, exact: true }),
    queryClient.cancelQueries({ queryKey: policyKey, exact: true }),
  ]);
  // A save that did not read everything (a shelf-only or return-only change,
  // or a replayed request) answers with empty option lists or unchecked
  // shipping policies. It must not replace the loaded view, so the setup is
  // read again instead.
  if (setup.checks && (setup.checks.ebay !== "checked" || setup.checks.fulfillment.status !== "checked")) {
    // Both reads together, as refreshEbayListingConfiguration does, so a failed
    // setup read still leaves the policy view marked stale.
    const refreshed = await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: setupKey, exact: true }, { throwOnError: true }),
      queryClient.invalidateQueries({ queryKey: policyKey, exact: true }, { throwOnError: true }),
    ]);
    for (const result of refreshed) {
      if (result.status === "rejected") throw result.reason;
    }
    return;
  }
  // Cached in the shape a read answers (no save outcome), so an unchanged
  // refetch keeps the same data and the panel's draft.
  const { outcome: _outcome, ...setupView } = setup;
  queryClient.setQueryData<DropshipEbayListingSetupResponse>(setupKey, setupView);
  queryClient.setQueryData<DropshipEbayListingPolicyOverrideResponse>(policyKey, (existing) => {
    // Do not invent assignments or revision tokens if this view has not loaded.
    if (!existing) return existing;
    return {
      ...existing,
      defaults: {
        fulfillmentPolicyId: setup.selection.fulfillmentPolicyId,
        returnPolicyId: setup.selection.returnPolicyId,
        paymentPolicyId: setup.selection.paymentPolicyId,
      },
      options: {
        fulfillmentPolicies: setup.options.fulfillmentPolicies,
        returnPolicies: setup.options.returnPolicies,
        paymentPolicies: setup.options.paymentPolicies,
      },
    };
  });
  // Surface refresh failure separately from the already-confirmed write. Inactive
  // policy views are marked stale and fetch the current defaults when mounted.
  await queryClient.invalidateQueries(
    { queryKey: policyKey, exact: true },
    { throwOnError: true },
  );
}
