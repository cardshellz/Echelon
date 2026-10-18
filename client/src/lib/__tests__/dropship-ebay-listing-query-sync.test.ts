import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { DropshipEbayListingSetupResponse } from "../dropship-ops-surface";
import {
  EBAY_LISTING_SETUP_CONTRACT_HEADERS,
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

// Listing settings PR 12 dropped the per-size policy view's cache key (D16): its only reader, the per-size policy
// panel, was deleted, so these cases observe and assert the setup read alone. The cases that were about the policy
// view only (its re-read, the two-read ordering and failures, no fabricated assignments) went with it.
describe("saved eBay listing setup synchronization", () => {
  it("publishes the confirmed setup for its own store only, and leaves it fresh", async () => {
    const client = queryClient();
    const setup = savedSetup();
    const otherStore = { ...savedSetup(), storeConnectionId: 45 };
    client.setQueryData(ebayListingSetupQueryKey(45), otherStore);

    await synchronizeSavedEbayListingSetup(client, setup);

    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(setup);
    expect(client.getQueryState(ebayListingSetupQueryKey(44))?.isInvalidated).toBe(false);
    expect(client.getQueryData(ebayListingSetupQueryKey(45))).toEqual(otherStore);
    expect(client.getQueryState(ebayListingSetupQueryKey(45))?.isInvalidated).toBe(false);
    // Only the setup read is in the cache: no other key is written for the store.
    expect(client.getQueryCache().getAll().map((query) => query.queryKey)).toEqual([
      ebayListingSetupQueryKey(45), ebayListingSetupQueryKey(44),
    ]);
  });

  it("publishes a checked answer without reading again, and a refresh-only retry reads the server's setup", async () => {
    const client = queryClient();
    const setup = savedSetup();
    const current = { ...savedSetup(), revision: 6 };
    const fetchSetup = vi.fn().mockResolvedValue(current);
    const observer = new QueryObserver(client, {
      queryKey: ebayListingSetupQueryKey(44), queryFn: fetchSetup, staleTime: Infinity,
    });
    client.setQueryData(ebayListingSetupQueryKey(44), savedSetup());
    const unsubscribe = observer.subscribe(() => undefined);

    await expect(synchronizeSavedEbayListingSetup(client, setup)).resolves.toBeUndefined();
    expect(fetchSetup).not.toHaveBeenCalled();
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(setup);

    await expect(refreshEbayListingConfiguration(client, setup.storeConnectionId)).resolves.toBeUndefined();
    expect(fetchSetup).toHaveBeenCalledOnce();
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(current);
    unsubscribe();
  });

  it("cancels pre-save reads so a late response cannot restore missing defaults", async () => {
    const client = queryClient();
    const setup = savedSetup();
    const oldSetup = deferred<DropshipEbayListingSetupResponse>();
    const staleSetupRead = client.fetchQuery({
      queryKey: ebayListingSetupQueryKey(44), queryFn: () => oldSetup.promise,
    }).catch(() => undefined);

    await synchronizeSavedEbayListingSetup(client, setup);
    oldSetup.resolve({ ...setup, selection: {
      merchantLocationKey: null, fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null,
    } });
    await staleSetupRead;

    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(setup);
  });

  it("refresh-only retry preserves newer defaults instead of republishing the old confirmed save", async () => {
    const client = queryClient();
    const savedA = savedSetup();
    const currentB = { ...savedSetup(), selection: {
      ...savedSetup().selection, fulfillmentPolicyId: "ups-ground",
    } };
    let currentSetup = savedA;
    client.setQueryData(ebayListingSetupQueryKey(44), savedA);
    const fetchSetup = vi.fn().mockImplementation(async () => currentSetup);
    const setupObserver = new QueryObserver(client, {
      queryKey: ebayListingSetupQueryKey(44), queryFn: fetchSetup, staleTime: Infinity,
    });
    const stopSetup = setupObserver.subscribe(() => undefined);
    await synchronizeSavedEbayListingSetup(client, savedA);

    // Another tab saves B, then the setup view sees B through a focus/refetch.
    currentSetup = currentB;
    await setupObserver.refetch();
    const valuesDuringRetry: Array<string | null | undefined> = [];
    const stopWatching = setupObserver.subscribe((result) => {
      valuesDuringRetry.push(result.data?.selection.fulfillmentPolicyId);
    });
    await refreshEbayListingConfiguration(client, 44);

    expect(fetchSetup).toHaveBeenCalledTimes(2);
    expect(valuesDuringRetry).not.toContain(savedA.selection.fulfillmentPolicyId);
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(currentB);
    stopWatching();
    stopSetup();
  });

  it("refresh-only retry reports a setup read failure without discarding the cached view", async () => {
    const client = queryClient();
    const setup = savedSetup();
    client.setQueryData(ebayListingSetupQueryKey(44), setup);
    const stopSetup = new QueryObserver(client, {
      queryKey: ebayListingSetupQueryKey(44), queryFn: async () => { throw new Error("setup offline"); }, staleTime: Infinity,
    }).subscribe(() => undefined);

    await expect(refreshEbayListingConfiguration(client, 44)).rejects.toThrow("setup offline");
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(setup);
    stopSetup();
  });

  it("reads the setup again instead of caching an answer that did not read eBay", async () => {
    // A replayed save (or a shelf-only one) answers without eBay's option lists.
    const client = queryClient();
    const loaded = savedSetup();
    client.setQueryData(ebayListingSetupQueryKey(44), loaded);

    await synchronizeSavedEbayListingSetup(client, notReadFromEbay(loaded));

    // Nothing from the answer is published: no empty option lists.
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(loaded);
    // It is stale, so a view mounted later reads the server, not the cache.
    expect(client.getQueryState(ebayListingSetupQueryKey(44))?.isInvalidated).toBe(true);
  });

  it("an answer that did not read eBay refreshes an open setup view from the server", async () => {
    const client = queryClient();
    const loaded = savedSetup();
    const current = { ...savedSetup(), revision: 6, selection: { ...savedSetup().selection, returnPolicyId: "return-60" },
      options: { ...savedSetup().options, returnPolicies: [{ id: "return-60", name: "60-day returns" }] } };
    client.setQueryData(ebayListingSetupQueryKey(44), loaded);
    const fetchSetup = vi.fn().mockResolvedValue(current);
    const stopSetup = new QueryObserver(client, {
      queryKey: ebayListingSetupQueryKey(44), queryFn: fetchSetup, staleTime: Infinity,
    }).subscribe(() => undefined);

    await synchronizeSavedEbayListingSetup(client, notReadFromEbay({ ...current, outcome: "replayed" }));

    expect(fetchSetup).toHaveBeenCalledOnce();
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(current);
    stopSetup();
  });

  it("reports a failed reread of the setup after an answer that did not read eBay, keeping the loaded setup", async () => {
    const client = queryClient();
    const loaded = savedSetup();
    client.setQueryData(ebayListingSetupQueryKey(44), loaded);
    const stopSetup = new QueryObserver(client, {
      queryKey: ebayListingSetupQueryKey(44), queryFn: async () => { throw new Error("setup offline"); }, staleTime: Infinity,
    }).subscribe(() => undefined);

    await expect(synchronizeSavedEbayListingSetup(client, notReadFromEbay(loaded))).rejects.toThrow("setup offline");
    // The empty-option answer never replaces what was loaded; the step's save runner then reports
    // "Saved. We couldn't load the latest view." and the refresh-only retry is refreshEbayListingConfiguration.
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(loaded);
    stopSetup();
  });

  it("publishes an answer that says it read eBay, as before checks existed", async () => {
    const client = queryClient();
    const setup = { ...savedSetup(), revision: 5, outcome: "changed" as const,
      checks: { ebay: "checked" as const, fulfillment: { status: "checked" as const } } };

    await synchronizeSavedEbayListingSetup(client, setup);

    // Published as a read answers it: the save's outcome is not part of the setup view.
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(asRead(setup));
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).not.toHaveProperty("outcome");
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
      // The caller still reads the outcome from the answer it was handed.
      expect(answer.outcome).toBe(outcome);
    },
  );

  it.each([
    { path: "the refresh-only retry", reread: (client: QueryClient) => refreshEbayListingConfiguration(client, 44) },
    { path: "an invalidation", reread: (client: QueryClient) => client.invalidateQueries({ queryKey: ebayListingSetupQueryKey(44) }) },
  ])("keeps the cached setup's reference when a read after the save says the same, through $path", async ({ reread }) => {
    // Every observer of the setup read (the step and its policy and shelf rows) renders again whenever the
    // data changes reference; an unchanged read must not hand them new data.
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

  it("hands observers a new setup when the read after the save differs, or when the cache held the save outcome", async () => {
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
  ])("reads the setup again instead of caching an answer whose shipping was $status", async (fulfillment) => {
    // eBay was read, but shipping policies in this answer are unchecked: it
    // must not replace a loaded view whose policies were checked.
    const client = queryClient();
    const loaded = savedSetup();
    client.setQueryData(ebayListingSetupQueryKey(44), loaded);
    const setQueryData = vi.spyOn(client, "setQueryData");
    const answer: DropshipEbayListingSetupResponse = { ...savedSetup(), revision: 5, fulfillmentCapability: null,
      checks: { ebay: "checked", fulfillment } };

    await synchronizeSavedEbayListingSetup(client, answer);

    expect(setQueryData).not.toHaveBeenCalled();
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toEqual(loaded);
    expect(client.getQueryState(ebayListingSetupQueryKey(44))?.isInvalidated).toBe(true);
  });

  it("publishes nothing from an answer that did not read eBay, even when no view has loaded", async () => {
    const client = queryClient();
    const setQueryData = vi.spyOn(client, "setQueryData");

    await synchronizeSavedEbayListingSetup(client, notReadFromEbay(savedSetup()));

    expect(setQueryData).not.toHaveBeenCalled();
    expect(client.getQueryData(ebayListingSetupQueryKey(44))).toBeUndefined();
  });
});

function queryClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  return client;
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
