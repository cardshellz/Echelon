import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultShopifyAdminClient } from "../../admin-gql-client";

vi.mock("../../../integrations/shopify", () => ({
  getShopifyConfig: () => ({
    domain: "synthetic.myshopify.com",
    accessToken: "synthetic-token",
  }),
}));
afterEach(() => vi.unstubAllGlobals());

describe("shared Shopify GraphQL transport options", () => {
  it("pins bounded merchandise reads without changing the legacy caller's API version", async () => {
    const request = vi.fn<typeof fetch>(
      async (_input, _init) =>
        new Response(JSON.stringify({ data: { value: "read-only" } })),
    );
    vi.stubGlobal("fetch", request);
    await expect(
      createDefaultShopifyAdminClient({
        apiVersion: "2026-10",
        timeoutMs: 15_000,
      }).request("query Merchandise { shop { id } }"),
    ).resolves.toEqual({ value: "read-only" });
    expect(request.mock.calls[0][0]).toBe(
      "https://synthetic.myshopify.com/admin/api/2026-10/graphql.json",
    );
    expect(request.mock.calls[0][1]).toMatchObject({
      signal: expect.any(AbortSignal),
    });
    await createDefaultShopifyAdminClient().request(
      "query Legacy { shop { id } }",
    );
    expect(request.mock.calls[1][0]).toBe(
      "https://synthetic.myshopify.com/admin/api/2024-10/graphql.json",
    );
    expect(request.mock.calls[1][1]).not.toHaveProperty("signal");
  });
  it.each([
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: 0.5 },
    { apiVersion: "2026-13" },
  ])(
    "rejects an invalid transport contract before requesting Shopify: %j",
    async (options) => {
      const request = vi.fn();
      vi.stubGlobal("fetch", request);
      await expect(
        createDefaultShopifyAdminClient(options).request(
          "query { shop { id } }",
        ),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );
});
