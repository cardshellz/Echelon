import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type {
  DropshipEbayListingPolicyOverrideResponse,
  DropshipEbayListingSetupResponse,
} from "../dropship-ops-surface";
import {
  EBAY_LISTING_SETUP_CONTRACT_HEADERS,
  ebayListingPolicyQueryKey,
  ebayListingSetupQueryKey,
  ebayListingSetupQueryOptions,
  refreshEbayListingConfiguration,
  synchronizeSavedEbayListingSetup,
} from "../dropship-ebay-listing-query-sync";

const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("eBay listing setup read", () => {
  it("asks for the setup answer with its read-only and shipping-check states", async () => {
    const answer = savedSetup();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => answer }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await expect(ebayListingSetupQueryOptions(44).queryFn({ signal })).resolves.toEqual(answer);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/dropship/ebay/listing-setup/44", {
      credentials: "include",
      signal,
      headers: { "X-Dropship-Listing-Setup-Contract": "2" },
    });
  });

  it("names contract 2, the one the server answers read-only views and shipping outages with", () => {
    // server: LISTING_SETUP_CONTRACT_HEADER; without it the server answers those states as errors.
    expect(EBAY_LISTING_SETUP_CONTRACT_HEADERS).toEqual({ "X-Dropship-Listing-Setup-Contract": "2" });
  });

  it("sends the header as a copy, so a request can never change the shared constant", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      (init?.headers as Record<string, string>)["X-Dropship-Listing-Setup-Contract"] = "changed";
      return { ok: true, status: 200, json: async () => savedSetup() } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await ebayListingSetupQueryOptions(44).queryFn({ signal: new AbortController().signal });

    expect(EBAY_LISTING_SETUP_CONTRACT_HEADERS).toEqual({ "X-Dropship-Listing-Setup-Contract": "2" });
  });
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

  it("reads both views again instead of caching an answer that did not read eBay", async () => {
    // A replayed save (or a shelf-only one) answers without eBay's option lists.
    const client = queryClient();
    const loaded = savedSetup();
    const loadedPolicies = policyResponse();
    client.setQueryData(ebayListingSetupQueryKey(44), loaded);
    client.setQueryData(ebayListingPolicyQueryKey(44), loadedPolicies);

    await synchronizeSavedEbayListingSetup(client, notReadFromEbay(loaded));

    // Nothing from the answer is published: no empty option lists, no defaults copied over.
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(loaded);
    expect(client.getQueryData(ebayListingPolicyQueryKey(44))).toEqual(loadedPolicies);
    // Both are stale, so a view mounted later reads the server, not the cache.
    expect(client.getQueryState(ebayListingSetupQueryKey(44))?.isInvalidated).toBe(true);
    expect(client.getQueryState(ebayListingPolicyQueryKey(44))?.isInvalidated).toBe(true);
  });

  it("an answer that did not read eBay refreshes open views from the server", async () => {
    const client = queryClient();
    const loaded = savedSetup();
    const current = { ...savedSetup(), revision: 6, selection: { ...savedSetup().selection, returnPolicyId: "return-60" },
      options: { ...savedSetup().options, returnPolicies: [{ id: "return-60", name: "60-day returns" }] } };
    const currentPolicies = { ...policyResponse(), defaults: policiesFrom(current) };
    client.setQueryData(ebayListingSetupQueryKey(44), loaded);
    client.setQueryData(ebayListingPolicyQueryKey(44), policyResponse());
    const fetchSetup = vi.fn().mockResolvedValue(current);
    const fetchPolicies = vi.fn().mockResolvedValue(currentPolicies);
    const stopSetup = new QueryObserver(client, {
      queryKey: ebayListingSetupQueryKey(44), queryFn: fetchSetup, staleTime: Infinity,
    }).subscribe(() => undefined);
    const stopPolicies = new QueryObserver(client, {
      queryKey: ebayListingPolicyQueryKey(44), queryFn: fetchPolicies, staleTime: Infinity,
    }).subscribe(() => undefined);

    await synchronizeSavedEbayListingSetup(client, notReadFromEbay({ ...current, outcome: "replayed" }));

    expect(fetchSetup).toHaveBeenCalledOnce();
    expect(fetchPolicies).toHaveBeenCalledOnce();
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(current);
    expect(client.getQueryData(ebayListingPolicyQueryKey(44))).toEqual(currentPolicies);
    stopSetup();
    stopPolicies();
  });

  it("reports a failed reread of the setup after an answer that did not read eBay, keeping the loaded setup", async () => {
    const client = queryClient();
    const loaded = savedSetup();
    client.setQueryData(ebayListingSetupQueryKey(44), loaded);
    const stopSetup = new QueryObserver(client, {
      queryKey: ebayListingSetupQueryKey(44), queryFn: async () => { throw new Error("setup offline"); }, staleTime: Infinity,
    }).subscribe(() => undefined);

    await expect(synchronizeSavedEbayListingSetup(client, notReadFromEbay(loaded))).rejects.toThrow("setup offline");
    // The empty-option answer never replaces what was loaded; the panel then
    // offers its refresh-only retry (refreshEbayListingConfiguration).
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(loaded);
    stopSetup();
  });

  it("publishes an answer that says it read eBay, as before checks existed", async () => {
    const client = queryClient();
    const before = policyResponse();
    const setup = { ...savedSetup(), revision: 5, outcome: "changed" as const,
      checks: { ebay: "checked" as const, fulfillment: { status: "checked" as const } } };
    client.setQueryData(ebayListingPolicyQueryKey(44), before);

    await synchronizeSavedEbayListingSetup(client, setup);

    // Published as a read answers it: the save's outcome is not part of the setup view.
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(asRead(setup));
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).not.toHaveProperty("outcome");
    expect(client.getQueryData<DropshipEbayListingPolicyOverrideResponse>(ebayListingPolicyQueryKey(44))?.defaults)
      .toEqual(policiesFrom(setup));
  });

  it.each(["changed", "unchanged", "replayed"] as const)(
    "caches a checked save answer whose outcome is %s without the outcome, and leaves the answer itself alone",
    async (outcome) => {
      const client = queryClient();
      const answer: DropshipEbayListingSetupResponse = Object.freeze({ ...savedSetup(), revision: 5, checks: CHECKED, outcome });

      await synchronizeSavedEbayListingSetup(client, answer);

      const cached = client.getQueryData<DropshipEbayListingSetupResponse>(ebayListingSetupQueryKey(44));
      expect(cached).not.toHaveProperty("outcome");
      expect(cached).toEqual({ ...savedSetup(), revision: 5, checks: CHECKED });
      expect(cached).not.toBe(answer);
      // The panel still reads the outcome from the answer it was handed.
      expect(answer.outcome).toBe(outcome);
    },
  );

  it.each([
    { path: "the refresh-only retry", reread: (client: QueryClient) => refreshEbayListingConfiguration(client, 44) },
    { path: "an invalidation", reread: (client: QueryClient) => client.invalidateQueries({ queryKey: ebayListingSetupQueryKey(44) }) },
  ])("keeps the cached setup's reference when a read after the save says the same, through $path", async ({ reread }) => {
    // The panel rebuilds its draft whenever the setup data changes reference
    // (EbayListingSetupPanel); an unchanged read must not hand it new data.
    const client = queryClient();
    const saved: DropshipEbayListingSetupResponse = { ...savedSetup(), revision: 5, checks: CHECKED };
    client.setQueryData(ebayListingSetupQueryKey(44), savedSetup());
    // The server reads back what was saved: a new object with the same content.
    const fetchSetup = vi.fn(async () => structuredClone(saved));
    const observer = new QueryObserver(client, {
      queryKey: ebayListingSetupQueryKey(44), queryFn: fetchSetup, staleTime: Infinity,
    });
    const stop = observer.subscribe(() => undefined);

    await synchronizeSavedEbayListingSetup(client, { ...saved, outcome: "changed" });
    const cached = client.getQueryData(ebayListingSetupQueryKey(44));
    expect(cached).toEqual(saved);
    expect(fetchSetup).not.toHaveBeenCalled();

    await reread(client);

    expect(fetchSetup).toHaveBeenCalledOnce();
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toBe(cached);
    expect(observer.getCurrentResult().data).toBe(cached);
    stop();
  });

  it("hands the panel a new setup when the read after the save differs, or when the cache held the save outcome", async () => {
    // Why the outcome is left out: a cached outcome makes every read differ.
    const saved: DropshipEbayListingSetupResponse = { ...savedSetup(), revision: 5, checks: CHECKED };
    for (const { cache, read } of [
      { cache: saved, read: { ...saved, revision: 6 } },
      { cache: { ...saved, outcome: "changed" as const }, read: saved },
    ]) {
      const client = queryClient();
      client.setQueryData(ebayListingSetupQueryKey(44), cache);
      const stop = new QueryObserver(client, {
        queryKey: ebayListingSetupQueryKey(44), queryFn: async () => structuredClone(read), staleTime: Infinity,
      }).subscribe(() => undefined);
      const before = client.getQueryData(ebayListingSetupQueryKey(44));

      await refreshEbayListingConfiguration(client, 44);

      expect(client.getQueryData(ebayListingSetupQueryKey(44))).not.toBe(before);
      expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(read);
      stop();
    }
  });

  it.each([
    { status: "unavailable" as const, reference: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", kind: "temporary" as const },
    { status: "unavailable" as const, reference: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED", kind: "setup_incomplete" as const },
    { status: "not_checked" as const },
  ])("reads both views again instead of caching an answer whose shipping was $status", async (fulfillment) => {
    // eBay was read, but shipping policies in this answer are unchecked: it
    // must not replace a loaded view whose policies were checked.
    const client = queryClient();
    const loaded = savedSetup();
    const loadedPolicies = policyResponse();
    client.setQueryData(ebayListingSetupQueryKey(44), loaded);
    client.setQueryData(ebayListingPolicyQueryKey(44), loadedPolicies);
    const setQueryData = vi.spyOn(client, "setQueryData");
    const answer: DropshipEbayListingSetupResponse = { ...savedSetup(), revision: 5, fulfillmentCapability: null,
      checks: { ebay: "checked", fulfillment } };

    await synchronizeSavedEbayListingSetup(client, answer);

    expect(setQueryData).not.toHaveBeenCalled();
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(loaded);
    expect(client.getQueryData(ebayListingPolicyQueryKey(44))).toEqual(loadedPolicies);
    expect(client.getQueryState(ebayListingSetupQueryKey(44))?.isInvalidated).toBe(true);
    expect(client.getQueryState(ebayListingPolicyQueryKey(44))?.isInvalidated).toBe(true);
  });

  it("publishes nothing from an answer that did not read eBay, even when no view has loaded", async () => {
    const client = queryClient();
    const setQueryData = vi.spyOn(client, "setQueryData");

    await synchronizeSavedEbayListingSetup(client, notReadFromEbay(savedSetup()));

    expect(setQueryData).not.toHaveBeenCalled();
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toBeUndefined();
    expect(client.getQueryData(ebayListingPolicyQueryKey(44))).toBeUndefined();
  });

  it("still rereads the policy view when the setup reread fails after a partial answer, then reports the setup failure", async () => {
    const client = queryClient();
    const loaded = savedSetup();
    const currentPolicies = { ...policyResponse(), defaults: policiesFrom(loaded) };
    client.setQueryData(ebayListingSetupQueryKey(44), loaded);
    client.setQueryData(ebayListingPolicyQueryKey(44), policyResponse());
    const setQueryData = vi.spyOn(client, "setQueryData");
    const fetchPolicies = vi.fn().mockResolvedValue(currentPolicies);
    const stopSetup = new QueryObserver(client, {
      queryKey: ebayListingSetupQueryKey(44), queryFn: async () => { throw new Error("setup offline"); }, staleTime: Infinity,
    }).subscribe(() => undefined);
    const stopPolicies = new QueryObserver(client, {
      queryKey: ebayListingPolicyQueryKey(44), queryFn: fetchPolicies, staleTime: Infinity,
    }).subscribe(() => undefined);

    await expect(synchronizeSavedEbayListingSetup(client, notReadFromEbay(loaded))).rejects.toThrow("setup offline");

    // The answer itself was never written to either cache.
    expect(setQueryData).not.toHaveBeenCalled();
    expect(fetchPolicies).toHaveBeenCalledOnce();
    expect(client.getQueryData(ebayListingPolicyQueryKey(44))).toEqual(currentPolicies);
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(loaded);
    stopSetup();
    stopPolicies();
  });

  it("still rereads the setup when the policy reread fails after a partial answer, then reports the policy failure", async () => {
    const client = queryClient();
    const loaded = savedSetup();
    const current = { ...savedSetup(), revision: 6 };
    client.setQueryData(ebayListingSetupQueryKey(44), loaded);
    client.setQueryData(ebayListingPolicyQueryKey(44), policyResponse());
    const setQueryData = vi.spyOn(client, "setQueryData");
    const fetchSetup = vi.fn().mockResolvedValue(current);
    const stopSetup = new QueryObserver(client, {
      queryKey: ebayListingSetupQueryKey(44), queryFn: fetchSetup, staleTime: Infinity,
    }).subscribe(() => undefined);
    const stopPolicies = new QueryObserver(client, {
      queryKey: ebayListingPolicyQueryKey(44), queryFn: async () => { throw new Error("policies offline"); }, staleTime: Infinity,
    }).subscribe(() => undefined);

    await expect(synchronizeSavedEbayListingSetup(client, notReadFromEbay(loaded))).rejects.toThrow("policies offline");

    expect(setQueryData).not.toHaveBeenCalled();
    expect(fetchSetup).toHaveBeenCalledOnce();
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(current);
    stopSetup();
    stopPolicies();
  });

  it("reports the setup failure first when both rereads fail after a partial answer", async () => {
    const client = queryClient();
    client.setQueryData(ebayListingSetupQueryKey(44), savedSetup());
    client.setQueryData(ebayListingPolicyQueryKey(44), policyResponse());
    const stopSetup = new QueryObserver(client, {
      queryKey: ebayListingSetupQueryKey(44), queryFn: async () => { throw new Error("setup offline"); }, staleTime: Infinity,
    }).subscribe(() => undefined);
    const stopPolicies = new QueryObserver(client, {
      queryKey: ebayListingPolicyQueryKey(44), queryFn: async () => { throw new Error("policies offline"); }, staleTime: Infinity,
    }).subscribe(() => undefined);

    await expect(synchronizeSavedEbayListingSetup(client, notReadFromEbay(savedSetup()))).rejects.toThrow("setup offline");
    stopSetup();
    stopPolicies();
  });

  it("waits for the policy reread to finish before reporting a setup reread that failed first", async () => {
    // A retry started on the error must not race an unfinished sibling read.
    const client = queryClient();
    client.setQueryData(ebayListingSetupQueryKey(44), savedSetup());
    client.setQueryData(ebayListingPolicyQueryKey(44), policyResponse());
    const policies = deferred<DropshipEbayListingPolicyOverrideResponse>();
    const stopSetup = new QueryObserver(client, {
      queryKey: ebayListingSetupQueryKey(44), queryFn: async () => { throw new Error("setup offline"); }, staleTime: Infinity,
    }).subscribe(() => undefined);
    const stopPolicies = new QueryObserver(client, {
      queryKey: ebayListingPolicyQueryKey(44), queryFn: () => policies.promise, staleTime: Infinity,
    }).subscribe(() => undefined);
    let settled = false;
    const sync = synchronizeSavedEbayListingSetup(client, notReadFromEbay(savedSetup()))
      .finally(() => { settled = true; });
    const outcome = sync.catch((error: unknown) => error);

    // Let the setup read fail; the policy read is still open.
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.getQueryState(ebayListingSetupQueryKey(44))?.status).toBe("error");
    expect(client.getQueryState(ebayListingPolicyQueryKey(44))?.fetchStatus).toBe("fetching");
    expect(settled).toBe(false);

    policies.resolve(policyResponse());
    await expect(outcome).resolves.toMatchObject({ message: "setup offline" });
    expect(settled).toBe(true);
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

/** An answer that read eBay and checked Card Shellz shipping. */
const CHECKED: NonNullable<DropshipEbayListingSetupResponse["checks"]> = { ebay: "checked", fulfillment: { status: "checked" } };

/** The setup as a read answers it: a save's answer without its outcome. */
function asRead(setup: DropshipEbayListingSetupResponse): DropshipEbayListingSetupResponse {
  const { outcome: _outcome, ...read } = setup;
  return read;
}

/** The same store's answer as a save gives it when it read nothing from eBay: empty option lists. */
function notReadFromEbay(setup: DropshipEbayListingSetupResponse): DropshipEbayListingSetupResponse {
  return {
    ...setup,
    revision: setup.revision ?? 5,
    fulfillmentCapability: null,
    options: { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] },
    checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
    outcome: setup.outcome ?? "replayed",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
