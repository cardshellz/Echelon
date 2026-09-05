import type { QueryClient } from "@tanstack/react-query";
import type {
  DropshipEbayListingPolicyOverrideResponse,
  DropshipEbayListingSetupResponse,
} from "./dropship-ops-surface";

export function ebayListingSetupQueryKey(storeConnectionId: number) {
  return ["/api/dropship/ebay/listing-setup", storeConnectionId] as const;
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
  queryClient.setQueryData(setupKey, setup);
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
