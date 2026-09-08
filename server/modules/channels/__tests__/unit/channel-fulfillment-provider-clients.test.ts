import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@shared/schema";
import { ChannelIdentityService } from "../../channel-identity.service";
import { createChannelFulfillmentProviderClients, createFulfillmentEbayAuth } from "../../channel-fulfillment-provider-clients.service";
import type { ShopifyIdentityConnection } from "../../adapters/shopify-identity.reader";
import { EbayApiClient } from "../../adapters/ebay/ebay-api.client";
import { EbayProviderAccountIdentityConflictError, type EbayObservedProviderAccount } from "../../adapters/ebay/ebay-auth.service";
import type { EbayShippingFulfillmentRequest } from "../../adapters/ebay/ebay-types";

vi.mock("../../../../infrastructure/auditLogger", () => ({
  persistAuditEvent: vi.fn(() => { throw new Error("Unexpected audit write during account resolution"); }),
}));

const timestamp = new Date("2026-09-07T12:00:00Z");

function channel(id: number, provider: string): Channel {
  return {
    id, provider, name: `Channel ${id}`, type: "internal", status: "active",
    isDefault: 0, priority: 0, allocationPct: null, allocationFixedQty: null,
    syncEnabled: true, syncMode: "live", sweepIntervalMinutes: 15, slaDays: null,
    shippingConfig: null, createdAt: timestamp, updatedAt: timestamp,
  };
}

function connection(channelId: number): ShopifyIdentityConnection {
  return {
    id: channelId + 100, channelId, shopDomain: `store-${channelId}.myshopify.com`,
    accessToken: `test-only-shopify-${channelId}`, apiVersion: "2024-01",
    shopifyLocationId: String(channelId + 1_000),
  };
}

function account(externalAccountId = "seller-31"): EbayObservedProviderAccount {
  return {
    externalAccountId, externalAccountDisplayName: "Test seller",
    externalAccountIdentityScheme: "provider_user_id", externalAccountVerifiedAt: timestamp,
  };
}

function ebayAuth(externalAccountId = "seller-31") {
  return {
    getVerifiedProviderAccount: vi.fn(async (_channelId: number): Promise<EbayObservedProviderAccount | null> => account(externalAccountId)),
    getAccessToken: vi.fn(async (_channelId: number) => `test-only-${externalAccountId}`),
    observeProviderAccount: vi.fn(async (_token: string) => account(externalAccountId)),
    getEnvironment: vi.fn((): "sandbox" | "production" => "production"),
  };
}

function harness() {
  const channels = { getChannelById: vi.fn(async (id: number): Promise<Channel | undefined> => channel(id, "shopify")) };
  const identities = { shopifyConnection: vi.fn(async (id: number) => connection(id)) };
  const auth = ebayAuth();
  const authFactory = vi.fn(() => auth);
  const shopifyRequest = vi.fn<typeof fetch>(async () => Response.json({ data: { accepted: true } }));
  const clients = createChannelFulfillmentProviderClients({ channels, identities, ebayAuth: authFactory, shopifyRequest });
  return { channels, identities, auth, authFactory, shopifyRequest, clients };
}

function identityOwnerWithRows(rows: ShopifyIdentityConnection[]) {
  interface IdentityReadQuery {
    from: () => IdentityReadQuery;
    innerJoin: () => IdentityReadQuery;
    where: () => IdentityReadQuery;
    limit: () => Promise<ShopifyIdentityConnection[]>;
  }
  const query: IdentityReadQuery = {
    from: vi.fn(() => query),
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(async () => rows),
  };
  const db = {
    select: vi.fn(() => query),
    transaction: vi.fn(() => { throw new Error("Unexpected transaction during account resolution"); }),
  };
  // This terminal-read double deliberately implements only the owner's read chain.
  const identities = new ChannelIdentityService(db as unknown as ConstructorParameters<typeof ChannelIdentityService>[0]);
  return { identities, db, query };
}

function fulfillment(trackingNumber = "tracking-31"): EbayShippingFulfillmentRequest {
  return {
    lineItems: [{ lineItemId: "line-1", quantity: 2 }],
    shippedDate: timestamp.toISOString(), shippingCarrierCode: "USPS", trackingNumber,
  };
}

function fulfillmentRead(fulfillmentId = "fulfillment-31", trackingNumber = "tracking-31") {
  return Response.json({
    total: 1,
    fulfillments: [{ fulfillmentId, shipmentTrackingNumber: trackingNumber, lineItems: [{ lineItemId: "line-1", quantity: 2 }] }],
  });
}

beforeEach(() => {
  vi.stubEnv("DRY_RUN", "false");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => { throw new Error("Unexpected external request"); }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("channel-owned Shopify fulfillment accounts", () => {
  it("keeps two stores and tokens independent across interleaved requests", async () => {
    const h = harness();
    const [first, second] = await Promise.all([h.clients.shopify(11), h.clients.shopify(22)]);
    await Promise.all([
      first.client.request("query First { shop { id } }"),
      second.client.request("mutation Second { fulfillmentCreate }", { order: "second-order" }),
    ]);
    await first.client.request("mutation First { fulfillmentCreate }", { order: "first-order" });

    expect(h.identities.shopifyConnection.mock.calls).toEqual([[11], [22]]);
    expect(first).toMatchObject({ channelId: 11, connectionId: 111, externalAccountId: "store-11.myshopify.com" });
    expect(second).toMatchObject({ channelId: 22, connectionId: 122, externalAccountId: "store-22.myshopify.com" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(h.shopifyRequest.mock.calls.map(([url, init]) => [url, new Headers(init?.headers).get("X-Shopify-Access-Token")])).toEqual([
      ["https://store-11.myshopify.com/admin/api/2024-01/graphql.json", "test-only-shopify-11"],
      ["https://store-22.myshopify.com/admin/api/2024-01/graphql.json", "test-only-shopify-22"],
      ["https://store-11.myshopify.com/admin/api/2024-01/graphql.json", "test-only-shopify-11"],
    ]);
    expect(h.authFactory).not.toHaveBeenCalled();
  });

  it("pins a copy of connection credentials for the full attempt", async () => {
    const h = harness();
    const source = connection(11);
    h.identities.shopifyConnection.mockResolvedValue(source);
    const selected = await h.clients.shopify(11);
    await selected.client.request("query Before { shop { id } }");
    Object.assign(source, { shopDomain: "changed.myshopify.com", accessToken: "changed-token", apiVersion: "2099-01", shopifyLocationId: "999" });
    await selected.client.request("mutation After { fulfillmentCreate }");

    expect(selected).toMatchObject({ externalAccountId: "store-11.myshopify.com" });
    for (const [url, init] of h.shopifyRequest.mock.calls) {
      expect(url).toBe("https://store-11.myshopify.com/admin/api/2024-01/graphql.json");
      expect(new Headers(init?.headers).get("X-Shopify-Access-Token")).toBe("test-only-shopify-11");
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])("rejects invalid channel %s before storage or provider access", async (channelId) => {
    const h = harness();
    await expect(h.clients.shopify(channelId)).rejects.toMatchObject({ code: "FULFILLMENT_CHANNEL_INVALID", failureClass: "permanent" });
    expect(h.channels.getChannelById).not.toHaveBeenCalled();
    expect(h.identities.shopifyConnection).not.toHaveBeenCalled();
    expect(h.shopifyRequest).not.toHaveBeenCalled();
  });

  it.each([undefined, channel(11, "ebay")])("rejects a missing or wrong-provider channel before resolving credentials", async (row) => {
    const h = harness();
    h.channels.getChannelById.mockResolvedValue(row);
    await expect(h.clients.shopify(11)).rejects.toMatchObject({ code: "FULFILLMENT_CHANNEL_PROVIDER_MISMATCH", failureClass: "permanent" });
    expect(h.identities.shopifyConnection).not.toHaveBeenCalled();
    expect(h.shopifyRequest).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", rows: [] },
    { label: "ambiguous", rows: [connection(11), { ...connection(11), id: 112 }] },
  ])("rejects $label connections through the real identity owner before GraphQL", async ({ rows }) => {
    const h = harness();
    const owner = identityOwnerWithRows(rows);
    const clients = createChannelFulfillmentProviderClients({ channels: h.channels, identities: owner.identities, ebayAuth: h.authFactory, shopifyRequest: h.shopifyRequest });

    await expect(clients.shopify(11)).rejects.toMatchObject({ name: "ChannelFulfillmentProviderError", code: "CHANNEL_CONNECTION_UNRESOLVED", failureClass: "permanent" });
    expect(owner.query.limit).toHaveBeenCalledWith(2);
    expect(owner.db.transaction).not.toHaveBeenCalled();
    expect(h.shopifyRequest).not.toHaveBeenCalled();
  });

  it.each([{ channelId: 22 }, { id: 0 }, { id: 1.5 }])("rejects inconsistent connection identity %j before GraphQL", async (override) => {
    const h = harness();
    h.identities.shopifyConnection.mockResolvedValue({ ...connection(11), ...override });
    await expect(h.clients.shopify(11)).rejects.toMatchObject({ code: "SHOPIFY_FULFILLMENT_CONNECTION_MISMATCH" });
    expect(h.shopifyRequest).not.toHaveBeenCalled();
  });

  it.each([null, "1011", "gid://shopify/Location/1011"])("does not treat the primary inventory location %s as shipment-location evidence", async (shopifyLocationId) => {
    const h = harness();
    h.identities.shopifyConnection.mockResolvedValue({ ...connection(11), shopifyLocationId });
    const selected = await h.clients.shopify(11);
    expect(selected).toMatchObject({ channelId: 11, connectionId: 111 });
    expect(selected).not.toHaveProperty("locationId");
    expect(h.shopifyRequest).not.toHaveBeenCalled();
  });
});

describe("channel-owned eBay fulfillment accounts", () => {
  it("pins one verified access token through the real duplicate GET, POST, and verification GET", async () => {
    const h = harness();
    h.channels.getChannelById.mockResolvedValue(channel(31, "ebay"));
    const fetchMock = vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ total: 0, fulfillments: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 201, headers: { Location: "https://api.ebay.com/sell/fulfillment/v1/order/order-31/shipping_fulfillment/fulfillment-31" } }))
      .mockResolvedValueOnce(fulfillmentRead());

    const selected = await h.clients.ebay(31);
    h.auth.getAccessToken.mockResolvedValue("changed-after-authorization");
    expect(selected.client).toBeInstanceOf(EbayApiClient);
    await expect(selected.client.createShippingFulfillment("order-31", fulfillment())).resolves.toEqual({ fulfillmentId: "fulfillment-31" });

    expect(selected).toMatchObject({ channelId: 31, externalAccountId: "seller-31" });
    expect(h.auth.getVerifiedProviderAccount.mock.calls).toEqual([[31], [31]]);
    expect(h.auth.getAccessToken).toHaveBeenCalledExactlyOnceWith(31);
    expect(h.auth.observeProviderAccount).toHaveBeenCalledExactlyOnceWith("test-only-seller-31");
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET"]);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("https://api.ebay.com/sell/fulfillment/v1/order/order-31/shipping_fulfillment");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-only-seller-31");
    }
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual(fulfillment());
    expect(h.identities.shopifyConnection).not.toHaveBeenCalled();
    expect(h.shopifyRequest).not.toHaveBeenCalled();
  });

  it("keeps independent auth instances and tokens for concurrent eBay accounts", async () => {
    const h = harness();
    const secondAuth = ebayAuth("seller-32");
    h.channels.getChannelById.mockImplementation(async (id) => channel(id, "ebay"));
    h.authFactory.mockReturnValueOnce(h.auth).mockReturnValueOnce(secondAuth);
    const fetchMock = vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const token = new Headers(init?.headers).get("Authorization");
      if (token === "Bearer test-only-seller-31") return fulfillmentRead("fulfillment-31", "tracking-31");
      if (token === "Bearer test-only-seller-32") return fulfillmentRead("fulfillment-32", "tracking-32");
      throw new Error("Unexpected credential escaped the selected account");
    });

    const [first, second] = await Promise.all([h.clients.ebay(31), h.clients.ebay(32)]);
    await expect(Promise.all([
      first.client.createShippingFulfillment("order-31", fulfillment()),
      second.client.createShippingFulfillment("order-32", fulfillment("tracking-32")),
    ])).resolves.toEqual([{ fulfillmentId: "fulfillment-31" }, { fulfillmentId: "fulfillment-32" }]);

    expect(h.authFactory).toHaveBeenCalledTimes(2);
    expect(h.auth.getAccessToken).toHaveBeenCalledExactlyOnceWith(31);
    expect(secondAuth.getAccessToken).toHaveBeenCalledExactlyOnceWith(32);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, new Headers(init?.headers).get("Authorization")])).toEqual([
      ["https://api.ebay.com/sell/fulfillment/v1/order/order-31/shipping_fulfillment", "GET", "Bearer test-only-seller-31"],
      ["https://api.ebay.com/sell/fulfillment/v1/order/order-32/shipping_fulfillment", "GET", "Bearer test-only-seller-32"],
    ]);
  });

  it("uses the verified auth owner's sandbox environment for fulfillment reads", async () => {
    const h = harness();
    h.channels.getChannelById.mockResolvedValue(channel(31, "ebay"));
    h.auth.getEnvironment.mockReturnValue("sandbox");
    vi.mocked(fetch).mockResolvedValueOnce(fulfillmentRead());
    const selected = await h.clients.ebay(31);
    await selected.client.createShippingFulfillment("order-31", fulfillment());
    expect(fetch).toHaveBeenCalledWith("https://api.sandbox.ebay.com/sell/fulfillment/v1/order/order-31/shipping_fulfillment", expect.objectContaining({ method: "GET" }));
  });

  it("rejects a wrong provider before constructing or loading eBay authorization", async () => {
    const h = harness();
    await expect(h.clients.ebay(31)).rejects.toMatchObject({ code: "FULFILLMENT_CHANNEL_PROVIDER_MISMATCH" });
    expect(h.authFactory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires persisted verified account evidence before acquiring an access token", async () => {
    const h = harness();
    h.channels.getChannelById.mockResolvedValue(channel(31, "ebay"));
    h.auth.getVerifiedProviderAccount.mockResolvedValue(null);
    await expect(h.clients.ebay(31)).rejects.toMatchObject({ code: "EBAY_FULFILLMENT_ACCOUNT_UNVERIFIED", failureClass: "permanent" });
    expect(h.auth.getAccessToken).not.toHaveBeenCalled();
    expect(h.auth.observeProviderAccount).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { label: "actual token belongs to another seller", observed: account("seller-other"), after: account() },
    { label: "persisted account changed during observation", observed: account(), after: account("seller-other") },
    { label: "persisted account disappeared during observation", observed: account(), after: null },
  ])("permanently rejects when $label, with no fulfillment I/O", async ({ observed, after }) => {
    const h = harness();
    h.channels.getChannelById.mockResolvedValue(channel(31, "ebay"));
    h.auth.getVerifiedProviderAccount.mockResolvedValueOnce(account()).mockResolvedValueOnce(after);
    h.auth.observeProviderAccount.mockResolvedValue(observed);

    await expect(h.clients.ebay(31)).rejects.toMatchObject({ code: "EBAY_FULFILLMENT_ACCOUNT_CHANGED", failureClass: "permanent" });
    expect(h.auth.getAccessToken).toHaveBeenCalledExactlyOnceWith(31);
    expect(h.auth.observeProviderAccount).toHaveBeenCalledExactlyOnceWith("test-only-seller-31");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a changed persisted identity scheme before fulfillment I/O", async () => {
    const h = harness();
    h.channels.getChannelById.mockResolvedValue(channel(31, "ebay"));
    // Simulate malformed persisted evidence crossing the owner's runtime boundary.
    const changedScheme = { ...account(), externalAccountIdentityScheme: "legacy_username" } as unknown as EbayObservedProviderAccount;
    h.auth.getVerifiedProviderAccount.mockResolvedValueOnce(account()).mockResolvedValueOnce(changedScheme);
    await expect(h.clients.ebay(31)).rejects.toMatchObject({ code: "EBAY_FULFILLMENT_ACCOUNT_CHANGED", failureClass: "permanent" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["getAccessToken", "observeProviderAccount"] as const)("sanitizes %s failures before they reach durable fulfillment error handling", async (method) => {
    const h = harness();
    h.channels.getChannelById.mockResolvedValue(channel(31, "ebay"));
    h.auth[method].mockRejectedValue(new Error("private eBay response test-only-seller-31"));
    const error = await h.clients.ebay(31).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "EBAY_FULFILLMENT_AUTHORIZATION_FAILED", failureClass: "transient", message: "eBay account authorization could not be verified" });
    expect(String(error)).not.toContain("private eBay response");
    expect(JSON.stringify(error)).not.toContain("test-only-seller-31");
    expect(fetch).not.toHaveBeenCalled();
    if (method === "getAccessToken") expect(h.auth.observeProviderAccount).not.toHaveBeenCalled();
  });

  it("classifies the auth owner's persisted-account conflict as permanent, not retryable", async () => {
    const h = harness();
    h.channels.getChannelById.mockResolvedValue(channel(31, "ebay"));
    h.auth.getAccessToken.mockRejectedValue(new EbayProviderAccountIdentityConflictError({
      channelId: 31, environment: "production", persistedExternalAccountId: "seller-31", observedExternalAccountId: "seller-other",
    }));
    await expect(h.clients.ebay(31)).rejects.toMatchObject({ code: "EBAY_FULFILLMENT_ACCOUNT_CHANGED", failureClass: "permanent" });
    expect(h.auth.observeProviderAccount).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("fulfillment eBay authorization transport", () => {
  function configuredAuth(request: typeof fetch) {
    vi.stubEnv("EBAY_CLIENT_ID", "test-only-client");
    vi.stubEnv("EBAY_CLIENT_SECRET", "test-only-secret");
    vi.stubEnv("EBAY_RUNAME", "test-only-runame");
    vi.stubEnv("EBAY_ENVIRONMENT", "production");
    const unexpectedDatabaseAccess = () => { throw new Error("Identity observation must not access the database"); };
    const db = {
      select: vi.fn(unexpectedDatabaseAccess), insert: vi.fn(unexpectedDatabaseAccess),
      update: vi.fn(unexpectedDatabaseAccess), delete: vi.fn(unexpectedDatabaseAccess),
    };
    return { auth: createFulfillmentEbayAuth(db, request), db };
  }

  it("bounds the real auth owner's identity request and refuses credential redirects", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const request = vi.fn<typeof fetch>(async () => Response.json({ userId: "seller-31", username: "Test seller" }));
    const { auth, db } = configuredAuth(request);
    await expect(auth.observeProviderAccount("test-only-seller-31")).resolves.toMatchObject({ externalAccountId: "seller-31", externalAccountIdentityScheme: "provider_user_id" });

    expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000);
    expect(request).toHaveBeenCalledExactlyOnceWith("https://apiz.ebay.com/commerce/identity/v1/user/", {
      method: "GET", redirect: "error", signal: expect.any(AbortSignal),
      headers: { Authorization: "Bearer test-only-seller-31", Accept: "application/json" },
    });
    for (const method of Object.values(db)) expect(method).not.toHaveBeenCalled();
  });

  it("propagates its abort signal through a stalled auth request without waiting for real time", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const request = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      if (!init?.signal) throw new Error("Authorization request did not supply an abort signal");
      init.signal.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const { auth } = configuredAuth(request);
    const rejected = expect(auth.observeProviderAccount("test-only-seller-31")).rejects.toMatchObject({
      code: "EBAY_FULFILLMENT_AUTHORIZATION_FAILED", failureClass: "transient",
    });
    controller.abort();
    await rejected;
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(request.mock.calls[0][1]?.redirect).toBe("error");
  });

  it.each([
    [401, "permanent"], [403, "permanent"],
    [408, "transient"], [429, "transient"], [503, "transient"],
  ])("classifies authorization HTTP %s without reading or retaining provider secrets", async (status, failureClass) => {
    const response = new Response("private-provider-body test-only-seller-31", { status: Number(status) });
    const readBody = vi.spyOn(response, "text");
    const request = vi.fn<typeof fetch>(async () => response);
    const { auth } = configuredAuth(request);
    const error = await auth.observeProviderAccount("test-only-seller-31").catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "EBAY_FULFILLMENT_AUTHORIZATION_REJECTED", failureClass });
    expect(String(error)).not.toContain("private-provider-body");
    expect(JSON.stringify(error)).not.toContain("test-only-seller-31");
    expect(readBody).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
