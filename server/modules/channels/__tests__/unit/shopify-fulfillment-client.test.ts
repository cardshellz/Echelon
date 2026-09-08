import { describe, expect, it, vi } from "vitest";
import { createShopifyFulfillmentClient } from "../../adapters/shopify-fulfillment.client";

const connection = {
  shopDomain: "test-store.myshopify.com", accessToken: "test-only-private-token", apiVersion: "2024-01",
};

describe("connection-scoped Shopify fulfillment transport", () => {
  it("sends exact GraphQL variables to the pinned HTTPS store without following redirects", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: { fulfillment: { id: "fulfillment-1" } } }));
    const client = createShopifyFulfillmentClient(connection, request);
    const query = "mutation ExactPackage($input: FulfillmentInput!) { fulfillmentCreate(fulfillment: $input) { fulfillment { id } } }";
    const variables = { input: { orderId: "gid://shopify/Order/1", quantity: 2 } };

    await expect(client.request(query, variables)).resolves.toEqual({ fulfillment: { id: "fulfillment-1" } });
    expect(request).toHaveBeenCalledExactlyOnceWith("https://test-store.myshopify.com/admin/api/2024-01/graphql.json", {
      method: "POST", redirect: "error", signal: expect.any(AbortSignal),
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": "test-only-private-token" },
      body: JSON.stringify({ query, variables }),
    });
    expect(Object.isFrozen(client)).toBe(true);
  });

  it.each([
    { shopDomain: "https://test-store.myshopify.com" },
    { shopDomain: "test-store.myshopify.com.attacker.example" },
    { shopDomain: "test-store.myshopify.com:8443" },
    { shopDomain: "test-store.myshopify.com/other" },
    { shopDomain: "user@test-store.myshopify.com" },
    { accessToken: " " },
    { apiVersion: "latest" },
    { apiVersion: "2024-01/../../other" },
  ])("rejects unsafe connection input %j before HTTP", (override) => {
    const request = vi.fn<typeof fetch>();
    expect(() => createShopifyFulfillmentClient({ ...connection, ...override }, request)).toThrow(expect.objectContaining({
      code: "SHOPIFY_FULFILLMENT_CONNECTION_INVALID", failureClass: "permanent",
    }));
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { status: 302, failureClass: "permanent" },
    { status: 401, failureClass: "permanent" },
    { status: 403, failureClass: "permanent" },
    { status: 429, failureClass: "transient" },
    { status: 500, failureClass: "transient" },
    { status: 503, failureClass: "transient" },
  ])("classifies HTTP $status without persisting the response body", async ({ status, failureClass }) => {
    const privateBody = "private provider detail test-only-private-token";
    const request = vi.fn<typeof fetch>(async () => new Response(privateBody, { status, headers: { Location: "https://attacker.example/credentials" } }));
    const error = await createShopifyFulfillmentClient(connection, request).request("query Test { shop { id } }").catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "SHOPIFY_FULFILLMENT_HTTP_REJECTED", failureClass, message: `Shopify fulfillment returned HTTP ${status}` });
    expect(String(error)).not.toContain(privateBody);
    expect(JSON.stringify(error)).not.toContain(connection.accessToken);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]?.redirect).toBe("error");
  });

  it("sanitizes rejected redirect or network errors without retrying another destination", async () => {
    const request = vi.fn<typeof fetch>(async (_url, options) => {
      expect(options?.redirect).toBe("error");
      throw new Error("redirect https://attacker.example/ test-only-private-token");
    });
    const error = await createShopifyFulfillmentClient(connection, request).request("query Test { shop { id } }").catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "SHOPIFY_FULFILLMENT_TRANSPORT_FAILED", failureClass: "transient", message: "Shopify fulfillment request did not complete" });
    expect(String(error)).not.toContain("attacker.example");
    expect(JSON.stringify(error)).not.toContain(connection.accessToken);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON without returning the provider body", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("private invalid-json test-only-private-token"));
    const error = await createShopifyFulfillmentClient(connection, request).request("query Test { shop { id } }").catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "SHOPIFY_FULFILLMENT_RESPONSE_INVALID", failureClass: "transient" });
    expect(String(error)).not.toContain("private invalid-json");
    expect(JSON.stringify(error)).not.toContain(connection.accessToken);
  });

  it("aborts a stalled request through its configured timeout signal without waiting for real time", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const request = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        if (!init?.signal) throw new Error("Fulfillment request requires an abort signal");
        init.signal.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
      const rejected = expect(createShopifyFulfillmentClient(connection, request).request("query Test { shop { id } }")).rejects.toMatchObject({
        code: "SHOPIFY_FULFILLMENT_TRANSPORT_FAILED", failureClass: "transient",
      });
      controller.abort(new Error("test-only-private-token"));
      await rejected;
      expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][1]?.signal).toBe(controller.signal);
    } finally { timeout.mockRestore(); }
  });

  it("keeps the timeout signal effective while the successful response body is stalled", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      let notifyBodyRead!: () => void;
      const bodyReadStarted = new Promise<void>((resolve) => { notifyBodyRead = resolve; });
      const request = vi.fn<typeof fetch>(async (_url, init) => {
        if (!init?.signal) throw new Error("Fulfillment response requires the request abort signal");
        const signal = init.signal;
        return new Response(new ReadableStream<Uint8Array>({
          start(stream) { signal.addEventListener("abort", () => stream.error(signal.reason), { once: true }); },
          pull() { notifyBodyRead(); },
        }), { headers: { "Content-Type": "application/json" } });
      });
      const result = createShopifyFulfillmentClient(connection, request).request("query Test { shop { id } }").catch((cause: unknown) => cause);
      await bodyReadStarted;
      controller.abort(new Error("test-only-private-token"));
      const error = await result;
      expect(error).toMatchObject({ code: "SHOPIFY_FULFILLMENT_RESPONSE_INVALID", failureClass: "transient" });
      expect(String(error)).not.toContain(connection.accessToken);
      expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000);
      expect(request).toHaveBeenCalledTimes(1);
    } finally { timeout.mockRestore(); }
  });

  it.each([null, [], "private provider text", {}, { data: null }, { data: [] }, { data: "not-an-object" }])("rejects an invalid GraphQL envelope %j", async (body) => {
    const request = vi.fn<typeof fetch>(async () => Response.json(body));
    await expect(createShopifyFulfillmentClient(connection, request).request("query Test { shop { id } }")).rejects.toMatchObject({
      code: "SHOPIFY_FULFILLMENT_RESPONSE_INVALID", failureClass: "transient",
    });
  });

  it.each([
    { errors: [{ message: "private provider detail test-only-private-token" }] },
    { data: { partial: true }, errors: [{ message: "private provider detail test-only-private-token" }] },
    { data: { partial: true }, errors: "private provider detail test-only-private-token" },
  ])("rejects GraphQL errors including partial data without leaking provider detail", async (body) => {
    const request = vi.fn<typeof fetch>(async () => Response.json(body));
    const error = await createShopifyFulfillmentClient(connection, request).request("query Test { shop { id } }").catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "SHOPIFY_FULFILLMENT_GRAPHQL_REJECTED", failureClass: "permanent", message: "Shopify rejected the fulfillment GraphQL request" });
    expect(String(error)).not.toContain("private provider detail");
    expect(JSON.stringify(error)).not.toContain(connection.accessToken);
  });

  it.each([
    { codes: ["THROTTLED"], failureClass: "transient" },
    { codes: ["INTERNAL_SERVER_ERROR"], failureClass: "transient" },
    { codes: ["INTERNAL_ERROR", "SERVICE_UNAVAILABLE"], failureClass: "transient" },
    { codes: ["ACCESS_DENIED"], failureClass: "permanent" },
    { codes: ["GRAPHQL_VALIDATION_FAILED"], failureClass: "permanent" },
    { codes: ["UNKNOWN_PROVIDER_ERROR"], failureClass: "permanent" },
    { codes: ["THROTTLED", "ACCESS_DENIED"], failureClass: "permanent" },
  ])("classifies GraphQL codes $codes as $failureClass", async ({ codes, failureClass }) => {
    const request = vi.fn<typeof fetch>(async () => Response.json({
      errors: codes.map((code) => ({ message: "private provider detail", extensions: { code } })),
    }));
    await expect(createShopifyFulfillmentClient(connection, request).request("query Test { shop { id } }")).rejects.toMatchObject({
      code: "SHOPIFY_FULFILLMENT_GRAPHQL_REJECTED", failureClass,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns data when the provider explicitly supplies an empty errors list", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: { shop: { id: "store-1" } }, errors: [] }));
    await expect(createShopifyFulfillmentClient(connection, request).request("query Test { shop { id } }")).resolves.toEqual({ shop: { id: "store-1" } });
  });
});
