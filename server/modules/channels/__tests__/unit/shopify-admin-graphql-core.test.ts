import { describe, expect, it, vi } from "vitest";
import {
  isShopifyAdminGraphQLConnectionValid, requestShopifyAdminGraphQL, type ShopifyAdminGraphQLFailure,
  type ShopifyAdminGraphQLResponseMeta,
} from "../../adapters/shopify-admin-graphql.core";

/**
 * The shared Shopify Admin GraphQL request path (PLAN-CH2 v4.1 §6.1, SAF-14). The fulfillment client's own unit tests
 * (shopify-fulfillment-client.test.ts, unchanged) pin its codes on this core; these pin what the core itself promises
 * to every caller: one request, no redirect, the caller's signal, the response meta and a closed failure description.
 */

const connection = { shopDomain: "test-store.myshopify.com", accessToken: "test-only-core-token" };
const operation = { query: "query Test { shop { id } }", variables: { first: 1 } };

class Refused extends Error {
  constructor(readonly failure: ShopifyAdminGraphQLFailure) { super(failure.kind); }
}

function run(request: typeof fetch, options: { signal?: AbortSignal; apiVersion?: string } = {}) {
  const metas: ShopifyAdminGraphQLResponseMeta[] = [];
  const result = requestShopifyAdminGraphQL(connection, operation, {
    apiVersion: options.apiVersion ?? "2026-10", timeoutMs: 15_000, signal: options.signal,
    errorFactory: failure => new Refused(failure), onResponseMeta: meta => { metas.push(meta); },
  }, request);
  return { result, metas };
}

async function failure(promise: Promise<unknown>): Promise<ShopifyAdminGraphQLFailure> {
  const error = await promise.then(() => { throw new Error("Expected a refusal"); }, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(Refused);
  return (error as Refused).failure;
}

describe("shared Shopify Admin GraphQL core", () => {
  it("sends one POST to the pinned endpoint with the caller's version and returns the data object", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: { shop: { id: "1" } }, extensions: { cost: { requestedQueryCost: 1 } } },
      { headers: { "X-Shopify-API-Version": "2026-10" } }));
    const { result, metas } = run(request);
    await expect(result).resolves.toEqual({ shop: { id: "1" } });
    expect(request).toHaveBeenCalledExactlyOnceWith("https://test-store.myshopify.com/admin/api/2026-10/graphql.json", {
      method: "POST", redirect: "error", signal: expect.any(AbortSignal),
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": "test-only-core-token" },
      body: JSON.stringify(operation),
    });
    expect(metas).toEqual([{ status: 200, retryAfter: null, apiVersion: "2026-10", extensions: { cost: { requestedQueryCost: 1 } } }]);
  });

  it.each([
    { name: "a scheme in the domain", value: { ...connection, shopDomain: "https://test-store.myshopify.com" }, version: "2026-10" },
    { name: "a look-alike host", value: { ...connection, shopDomain: "test-store.myshopify.com.attacker.example" }, version: "2026-10" },
    { name: "a blank token", value: { ...connection, accessToken: " " }, version: "2026-10" },
    { name: "an undated version", value: connection, version: "unstable" },
  ])("refuses $name before any HTTP", async ({ value, version }) => {
    const request = vi.fn<typeof fetch>();
    expect(isShopifyAdminGraphQLConnectionValid(value, version)).toBe(false);
    const result = requestShopifyAdminGraphQL(value, operation, { apiVersion: version, timeoutMs: 15_000,
      errorFactory: kind => new Refused(kind) }, request);
    expect(await failure(result)).toEqual({ kind: "connection_invalid" });
    expect(request).not.toHaveBeenCalled();
  });

  it("reports a refused status with its Retry-After and served version, never reading the body", async () => {
    const body = vi.fn();
    const request = vi.fn<typeof fetch>(async () => {
      const response = new Response("private provider detail", { status: 429, headers: { "Retry-After": "4", "X-Shopify-API-Version": "2026-10" } });
      Object.defineProperty(response, "json", { value: body });
      return response;
    });
    const { result, metas } = run(request);
    expect(await failure(result)).toEqual({ kind: "http", status: 429 });
    expect(metas).toEqual([{ status: 429, retryAfter: "4", apiVersion: "2026-10", extensions: null }]);
    expect(body).not.toHaveBeenCalled();
  });

  it("keeps only GraphQL error codes (upper-cased; null when absent; null list when errors is not a list)", async () => {
    const listed = vi.fn<typeof fetch>(async () => Response.json({ data: { partial: true }, errors: [
      { message: "private", extensions: { code: "throttled" } }, { message: "private" }, "private", { extensions: { code: 7 } }] }));
    expect(await failure(run(listed).result)).toEqual({ kind: "graphql", codes: ["THROTTLED", null, null, null] });
    const prose = vi.fn<typeof fetch>(async () => Response.json({ errors: "private provider prose" }));
    expect(await failure(run(prose).result)).toEqual({ kind: "graphql", codes: null });
    const empty = vi.fn<typeof fetch>(async () => Response.json({ data: { ok: true }, errors: [] }));
    await expect(run(empty).result).resolves.toEqual({ ok: true });
  });

  it.each([
    { name: "invalid JSON", response: () => new Response("not json"), reason: "json" },
    { name: "a list envelope", response: () => Response.json([]), reason: "envelope" },
    { name: "no data", response: () => Response.json({ extensions: {} }), reason: "data" },
  ])("describes $name without provider text", async ({ response, reason }) => {
    const { result, metas } = run(vi.fn<typeof fetch>(async () => response()));
    expect(await failure(result)).toEqual({ kind: "response_invalid", reason });
    expect(metas).toHaveLength(1);
  });

  it("stops at the caller's signal as well as its own timeout; a stopped request is a transport failure", async () => {
    const caller = new AbortController();
    const request = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("aborted with test-only-core-token")), { once: true });
    }));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const { result } = run(request, { signal: caller.signal });
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000);
      expect(request.mock.calls[0]![1]!.signal).not.toBe(caller.signal);
      caller.abort();
      expect(await failure(result)).toEqual({ kind: "transport" });
    } finally { timeout.mockRestore(); }
  });
});
