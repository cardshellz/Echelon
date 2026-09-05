import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type {
  DropshipEbayListingPolicyOverrideResponse,
  DropshipEbayListingSetupResponse,
} from "../dropship-ops-surface";
import {
  ebayListingPolicyQueryKey,
  ebayListingSetupQueryKey,
  refreshEbayListingConfiguration,
  synchronizeSavedEbayListingSetup,
} from "../dropship-ebay-listing-query-sync";

const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe("saved eBay listing setup synchronization", () => {
  it("publishes defaults and current options while preserving listing choices and revisions", async () => {
    const client = queryClient();
    const setup = savedSetup();
    const before = policyResponse();
    client.setQueryData(ebayListingPolicyQueryKey(44), before);
    const otherStore = { ...policyResponse(), storeConnectionId: 45 };
    client.setQueryData(ebayListingPolicyQueryKey(45), otherStore);

    await synchronizeSavedEbayListingSetup(client, setup);

    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(setup);
    expect(client.getQueryData(ebayListingPolicyQueryKey(44))).toEqual({
      ...before,
      defaults: policiesFrom(setup),
      options: {
        fulfillmentPolicies: setup.options.fulfillmentPolicies,
        returnPolicies: setup.options.returnPolicies,
        paymentPolicies: setup.options.paymentPolicies,
      },
    });
    expect(client.getQueryData(ebayListingPolicyQueryKey(45))).toEqual(otherStore);
    expect(client.getQueryState(ebayListingPolicyQueryKey(44))?.isInvalidated).toBe(true);
    expect(client.getQueryState(ebayListingPolicyQueryKey(45))?.isInvalidated).toBe(false);
  });

  it("reloads active policy views so they include current assignments, not only new defaults", async () => {
    const client = queryClient();
    const before = policyResponse();
    const updated = { ...before, defaults: policiesFrom(savedSetup()), assignments: [] };
    client.setQueryData(ebayListingPolicyQueryKey(44), before);
    const fetchPolicies = vi.fn().mockResolvedValue(updated);
    const observer = new QueryObserver(client, {
      queryKey: ebayListingPolicyQueryKey(44), queryFn: fetchPolicies, staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    await synchronizeSavedEbayListingSetup(client, savedSetup());

    expect(fetchPolicies).toHaveBeenCalledOnce();
    expect(client.getQueryData(ebayListingPolicyQueryKey(44))).toEqual(updated);
    unsubscribe();
  });

  it("rejects a failed reread without rolling back the confirmed defaults, and supports refresh-only retry", async () => {
    const client = queryClient();
    const setup = savedSetup();
    client.setQueryData(ebayListingPolicyQueryKey(44), policyResponse());
    const fetchPolicies = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ...policyResponse(), defaults: policiesFrom(setup) });
    const observer = new QueryObserver(client, {
      queryKey: ebayListingPolicyQueryKey(44), queryFn: fetchPolicies, staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    await expect(synchronizeSavedEbayListingSetup(client, setup)).rejects.toThrow("offline");
    expect(client.getQueryData<DropshipEbayListingPolicyOverrideResponse>(ebayListingPolicyQueryKey(44))?.defaults)
      .toEqual(policiesFrom(setup));
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(setup);

    await expect(refreshEbayListingConfiguration(client, setup.storeConnectionId)).resolves.toBeUndefined();
    expect(fetchPolicies).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("cancels pre-save reads so late responses cannot restore missing defaults", async () => {
    const client = queryClient();
    const setup = savedSetup();
    const oldSetup = deferred<DropshipEbayListingSetupResponse>();
    const oldPolicies = deferred<DropshipEbayListingPolicyOverrideResponse>();
    const updated = { ...policyResponse(), defaults: policiesFrom(setup) };
    client.setQueryData(ebayListingPolicyQueryKey(44), policyResponse());
    const fetchPolicies = vi.fn().mockImplementationOnce(() => oldPolicies.promise).mockResolvedValue(updated);
    const observer = new QueryObserver(client, {
      queryKey: ebayListingPolicyQueryKey(44), queryFn: fetchPolicies, staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    const stalePolicyRead = observer.refetch();
    const staleSetupRead = client.fetchQuery({
      queryKey: ebayListingSetupQueryKey(44), queryFn: () => oldSetup.promise,
    }).catch(() => undefined);

    await synchronizeSavedEbayListingSetup(client, setup);
    oldPolicies.resolve(policyResponse());
    oldSetup.resolve({ ...setup, selection: {
      merchantLocationKey: null, fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null,
    } });
    await Promise.all([stalePolicyRead, staleSetupRead]);

    expect(fetchPolicies).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(setup);
    expect(client.getQueryData(ebayListingPolicyQueryKey(44))).toEqual(updated);
    unsubscribe();
  });

  it("refresh-only retry preserves newer defaults instead of republishing the old confirmed save", async () => {
    const client = queryClient();
    const savedA = savedSetup();
    const currentB = { ...savedSetup(), selection: {
      ...savedSetup().selection, fulfillmentPolicyId: "ups-ground",
    } };
    let currentSetup = savedA;
    client.setQueryData(ebayListingSetupQueryKey(44), savedA);
    client.setQueryData(ebayListingPolicyQueryKey(44), policyResponse());
    const fetchSetup = vi.fn().mockImplementation(async () => currentSetup);
    const fetchPolicies = vi.fn().mockRejectedValueOnce(new Error("policy read failed"))
      .mockImplementation(async () => ({ ...policyResponse(), defaults: policiesFrom(currentSetup) }));
    const setupObserver = new QueryObserver(client, {
      queryKey: ebayListingSetupQueryKey(44), queryFn: fetchSetup, staleTime: Infinity,
    });
    const policyObserver = new QueryObserver(client, {
      queryKey: ebayListingPolicyQueryKey(44), queryFn: fetchPolicies, staleTime: Infinity,
    });
    const stopSetup = setupObserver.subscribe(() => undefined);
    const stopPolicies = policyObserver.subscribe(() => undefined);
    await expect(synchronizeSavedEbayListingSetup(client, savedA)).rejects.toThrow("policy read failed");

    // Another tab saves B, then the setup view sees B through a focus/refetch.
    currentSetup = currentB;
    await setupObserver.refetch();
    const valuesDuringRetry: Array<string | null | undefined> = [];
    const stopWatching = setupObserver.subscribe((result) => {
      valuesDuringRetry.push(result.data?.selection.fulfillmentPolicyId);
    });
    await refreshEbayListingConfiguration(client, 44);

    expect(fetchSetup).toHaveBeenCalledTimes(2);
    expect(fetchPolicies).toHaveBeenCalledTimes(2);
    expect(valuesDuringRetry).not.toContain(savedA.selection.fulfillmentPolicyId);
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(currentB);
    expect(client.getQueryData<DropshipEbayListingPolicyOverrideResponse>(ebayListingPolicyQueryKey(44))?.defaults)
      .toEqual(policiesFrom(currentB));
    stopWatching();
    stopPolicies();
    stopSetup();
  });

  it("refresh-only retry reports setup read failure without discarding either cached view", async () => {
    const client = queryClient();
    const setup = savedSetup();
    const policies = { ...policyResponse(), defaults: policiesFrom(setup) };
    client.setQueryData(ebayListingSetupQueryKey(44), setup);
    client.setQueryData(ebayListingPolicyQueryKey(44), policies);
    const setupObserver = new QueryObserver(client, {
      queryKey: ebayListingSetupQueryKey(44), queryFn: async () => { throw new Error("setup offline"); }, staleTime: Infinity,
    });
    const policyObserver = new QueryObserver(client, {
      queryKey: ebayListingPolicyQueryKey(44), queryFn: async () => policies, staleTime: Infinity,
    });
    const stopSetup = setupObserver.subscribe(() => undefined);
    const stopPolicies = policyObserver.subscribe(() => undefined);

    await expect(refreshEbayListingConfiguration(client, 44)).rejects.toThrow("setup offline");
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(setup);
    expect(client.getQueryData(ebayListingPolicyQueryKey(44))).toEqual(policies);
    stopSetup();
    stopPolicies();
  });

  it("does not fabricate empty assignments when the policy view has not loaded", async () => {
    const client = queryClient();
    await synchronizeSavedEbayListingSetup(client, savedSetup());
    expect(client.getQueryData(ebayListingPolicyQueryKey(44))).toBeUndefined();
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(savedSetup());
  });
});

function queryClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  return client;
}

function policiesFrom(setup: DropshipEbayListingSetupResponse) {
  return {
    fulfillmentPolicyId: setup.selection.fulfillmentPolicyId,
    returnPolicyId: setup.selection.returnPolicyId,
    paymentPolicyId: setup.selection.paymentPolicyId,
  };
}

function policyResponse(): DropshipEbayListingPolicyOverrideResponse {
  return {
    storeConnectionId: 44,
    defaults: { fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null },
    options: { fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] },
    assignments: [{ productVariantId: 11, revisionId: 27, fulfillmentPolicyId: "ups-ground",
      returnPolicyId: null, paymentPolicyId: null, updatedAt: "2026-09-05T12:00:00Z" }],
    fetchedAt: "2026-09-05T12:00:00Z",
  };
}

function savedSetup(): DropshipEbayListingSetupResponse {
  return {
    storeConnectionId: 44, marketplaceId: "EBAY_US", complete: true, missingFields: [],
    fulfillmentCapability: {
      marketplaceId: "EBAY_US", requiredHandlingTimeBusinessDays: 1,
      destinationCountry: "US", destinationRegions: ["CA"], destinationCoverageComplete: false,
      supportedServices: [], evidenceHash: "evidence-hash",
      source: { omsChannelId: 1, originWarehouseId: 1, rateBookId: 1, rateBookCode: "default",
        rateTableId: 1, serviceLevelId: 1, fulfillmentRoutingRevision: 1 },
    },
    selection: { merchantLocationKey: "warehouse", fulfillmentPolicyId: "usps-ground",
      returnPolicyId: "return-30", paymentPolicyId: "managed-payments" },
    options: {
      merchantLocations: [{ id: "warehouse", name: "Warehouse" }],
      fulfillmentPolicies: [{ id: "usps-ground", name: "USPS Ground Advantage", compatible: true, compatibilityIssues: [] }],
      returnPolicies: [{ id: "return-30", name: "30-day returns" }],
      paymentPolicies: [{ id: "managed-payments", name: "Managed payments" }],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
