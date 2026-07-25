import { describe, expect, it, vi } from "vitest";

import {
  createShopifyProductMappingVerifier,
} from "../../shopify-product-mapping-verifier";

const credentials = {
  shopDomain: "cardshellz.myshopify.com",
  accessToken: "shpat_test",
  apiVersion: "2024-01",
};

function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

describe("Shopify product mapping verifier", () => {
  it("rejects an invalid Shopify domain before making a request", async () => {
    const fetchImpl = vi.fn();
    const verifier = createShopifyProductMappingVerifier({ fetchImpl });

    await expect(verifier.lookupProducts(
      { ...credentials, shopDomain: "attacker.example" },
      ["9001"],
    )).rejects.toMatchObject({
      code: "SHOPIFY_MAPPING_SHOP_DOMAIN_INVALID",
      statusCode: 500,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns live product state and explicit missing-product state", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      data: {
        nodes: [
          {
            __typename: "Product",
            id: "gid://shopify/Product/9001",
            title: "100PT Toploader",
            status: "ACTIVE",
            shippingGroup: { value: "\"protection\"" },
          },
          null,
        ],
      },
    }));
    const verifier = createShopifyProductMappingVerifier({ fetchImpl });

    const result = await verifier.lookupProducts(
      credentials,
      ["9002", "9001", "9001"],
    );

    expect([...result.entries()]).toEqual([
      ["9001", {
        productId: "9001",
        exists: true,
        title: "100PT Toploader",
        status: "ACTIVE",
        shippingGroupCode: "protection",
      }],
      ["9002", {
        productId: "9002",
        exists: false,
        title: null,
        status: null,
        shippingGroupCode: null,
      }],
    ]);
    const request = JSON.parse(
      String(fetchImpl.mock.calls[0][1]?.body),
    ) as { variables: { ids: string[] } };
    expect(request.variables.ids).toEqual([
      "gid://shopify/Product/9001",
      "gid://shopify/Product/9002",
    ]);
  });

  it("verifies the product and every referenced variant before retirement", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      data: {
        nodes: [
          null,
          {
            __typename: "ProductVariant",
            id: "gid://shopify/ProductVariant/2001",
            product: { id: "gid://shopify/Product/9009" },
          },
          null,
        ],
      },
    }));
    const verifier = createShopifyProductMappingVerifier({ fetchImpl });

    await expect(verifier.verifyProductAndVariants(
      credentials,
      "9001",
      ["2002", "2001", "2001"],
    )).resolves.toEqual({
      remoteProductExists: false,
      liveVariantIds: ["2001"],
    });
  });

  it("rejects a node whose type or identity does not match the request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      data: {
        nodes: [{
          __typename: "ProductVariant",
          id: "gid://shopify/ProductVariant/9001",
        }],
      },
    }));
    const verifier = createShopifyProductMappingVerifier({ fetchImpl });

    await expect(
      verifier.lookupProducts(credentials, ["9001"]),
    ).rejects.toMatchObject({
      code: "SHOPIFY_MAPPING_RESPONSE_INVALID",
      statusCode: 502,
    });
  });

  it("retries a rate-limited request and honors Retry-After", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(
        { errors: [{ message: "Throttled" }] },
        429,
        { "Retry-After": "3" },
      ))
      .mockResolvedValueOnce(response({
        data: {
          nodes: [{
            __typename: "Product",
            id: "gid://shopify/Product/9001",
            title: "100PT Toploader",
            status: "ACTIVE",
            shippingGroup: null,
          }],
        },
      }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const verifier = createShopifyProductMappingVerifier({
      fetchImpl,
      sleep,
    });

    await expect(
      verifier.lookupProducts(credentials, ["9001"]),
    ).resolves.toBeInstanceOf(Map);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3_000);
  });

  it("fails after retryable Shopify server errors exhaust all attempts", async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(response({ error: "unavailable" }, 503)));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const verifier = createShopifyProductMappingVerifier({
      fetchImpl,
      sleep,
    });

    await expect(
      verifier.lookupProducts(credentials, ["9001"]),
    ).rejects.toMatchObject({
      code: "SHOPIFY_MAPPING_LOOKUP_FAILED",
      statusCode: 502,
      context: { responseStatus: 503 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
