import { describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import type { DropshipEbayRegistrationCredentialProvider } from "../../infrastructure/dropship-ebay-registration-credentials";
import { EbayDropshipListingSetupDirectory } from "../../infrastructure/dropship-ebay-listing-setup.directory";

describe("EbayDropshipListingSetupDirectory", () => {
  it("loads, filters, paginates, deduplicates, and sorts the real eBay choices", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      urls.push(value);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-token");
      if (value.includes("/sell/inventory/v1/location") && !value.includes("offset=2")) {
        return jsonResponse({
          locations: [
            { merchantLocationKey: "west", name: "West", merchantLocationStatus: "ENABLED" },
            { merchantLocationKey: "disabled", name: "Disabled", merchantLocationStatus: "DISABLED" },
          ],
          next: "https://api.ebay.com/sell/inventory/v1/location?limit=200&offset=2",
        });
      }
      if (value.includes("/sell/inventory/v1/location") && value.includes("offset=2")) {
        return jsonResponse({
          locations: [
            { merchantLocationKey: "east", name: "East", merchantLocationStatus: "ENABLED" },
            { merchantLocationKey: "west", name: "West", merchantLocationStatus: "ENABLED" },
          ],
        });
      }
      if (value.includes("fulfillment_policy")) {
        return jsonResponse({
          fulfillmentPolicies: [
            policy("fulfillmentPolicyId", "fulfillment-z", "Z standard"),
            policy("fulfillmentPolicyId", "motors-only", "Motors only", "MOTORS_VEHICLES"),
            policy("fulfillmentPolicyId", "fulfillment-a", "A expedited"),
          ],
        });
      }
      if (value.includes("return_policy")) {
        return jsonResponse({ returnPolicies: [policy("returnPolicyId", "return-1", "Thirty days")] });
      }
      if (value.includes("payment_policy")) {
        return jsonResponse({ paymentPolicies: [policy("paymentPolicyId", "payment-1", "Managed payments")] });
      }
      throw new Error(`Unexpected eBay URL: ${value}`);
    });
    const directory = new EbayDropshipListingSetupDirectory(credentials(), fetchFn as typeof fetch);

    const result = await directory.discoverWithAccessToken({
      accessToken: "access-token",
      environment: "production",
      marketplaceId: "EBAY_US",
      storeConnectionId: 44,
    });

    expect(result).toEqual({
      marketplaceId: "EBAY_US",
      merchantLocations: [
        { id: "east", name: "East" },
        { id: "west", name: "West" },
      ],
      fulfillmentPolicies: [
        parsedFulfillmentPolicy("fulfillment-a", "A expedited"),
        parsedFulfillmentPolicy("fulfillment-z", "Z standard"),
      ],
      returnPolicies: [{ id: "return-1", name: "Thirty days" }],
      paymentPolicies: [{ id: "payment-1", name: "Managed payments" }],
    });
    expect(urls).toHaveLength(5);
    expect(urls.every((url) => url.startsWith("https://api.ebay.com/"))).toBe(true);
  });

  it("loads one selected fulfillment policy for a forced pre-push check", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(
        "https://api.ebay.com/sell/account/v1/fulfillment_policy/policy%2Fone",
      );
      return jsonResponse(policy(
        "fulfillmentPolicyId",
        "policy/one",
        "Ground",
      ));
    });
    const directory = new EbayDropshipListingSetupDirectory(
      credentials(),
      fetchFn as typeof fetch,
    );

    await expect(directory.getFulfillmentPolicyWithAccessToken({
      accessToken: "access-token",
      environment: "production",
      storeConnectionId: 44,
      fulfillmentPolicyId: "policy/one",
    })).resolves.toEqual(parsedFulfillmentPolicy("policy/one", "Ground"));
  });

  it.each([
    {
      label: "shipping option",
      mutate: (value: Record<string, unknown>) => {
        value.shippingOptions = [null];
      },
    },
    {
      label: "shipping service",
      mutate: (value: Record<string, unknown>) => {
        value.shippingOptions = [{ optionType: "DOMESTIC", shippingServices: [{}] }];
      },
    },
    {
      label: "provider boolean",
      mutate: (value: Record<string, unknown>) => {
        value.localPickup = "false";
      },
    },
  ])("rejects a malformed fulfillment-policy $label", async ({ mutate }) => {
    const malformed = policy("fulfillmentPolicyId", "policy-1", "Ground");
    mutate(malformed);
    const directory = new EbayDropshipListingSetupDirectory(
      credentials(),
      vi.fn(async () => jsonResponse(malformed)) as unknown as typeof fetch,
    );

    await expect(directory.getFulfillmentPolicyWithAccessToken({
      accessToken: "access-token",
      environment: "production",
      storeConnectionId: 44,
      fulfillmentPolicyId: "policy-1",
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_INVALID_RESPONSE",
      context: { resource: "fulfillmentPolicies" },
    });
  });

  it("classifies eBay Inventory or Account authorization failures without exposing the body", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/sell/inventory/v1/location")) {
        return new Response("provider diagnostic that must remain private", { status: 403 });
      }
      return emptyResourceResponse(String(url));
    });
    const directory = new EbayDropshipListingSetupDirectory(credentials(), fetchFn as typeof fetch);

    await expect(directory.discoverWithAccessToken({
      accessToken: "access-token",
      environment: "production",
      marketplaceId: "EBAY_US",
      storeConnectionId: 44,
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
      message: "eBay did not grant the Inventory and Account API access required for listing setup.",
      context: {
        storeConnectionId: 44,
        resource: "merchantLocations",
        status: 403,
        retryable: false,
      },
    });
  });

  it("rejects an inventory pagination URL that leaves the eBay API origin", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/sell/inventory/v1/location")) {
        return jsonResponse({
          locations: [],
          next: "https://attacker.invalid/steal-token",
        });
      }
      return emptyResourceResponse(String(url));
    });
    const directory = new EbayDropshipListingSetupDirectory(credentials(), fetchFn as typeof fetch);

    await expect(directory.discoverWithAccessToken({
      accessToken: "access-token",
      environment: "production",
      marketplaceId: "EBAY_US",
      storeConnectionId: 44,
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_INVALID_RESPONSE",
      context: { resource: "merchantLocations" },
    });
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes("attacker.invalid"))).toBe(false);
  });

  it("uses the provider environment persisted with the connected store", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => emptyResourceResponse(String(url)));
    const directory = new EbayDropshipListingSetupDirectory(credentials(), fetchFn as typeof fetch);

    await directory.discoverWithAccessToken({
      accessToken: "sandbox-token",
      environment: "sandbox",
      marketplaceId: "EBAY_US",
      storeConnectionId: 44,
    });

    expect(fetchFn.mock.calls.every(([url]) => String(url).startsWith("https://api.sandbox.ebay.com/"))).toBe(true);
  });

  it.each([
    new DropshipError(
      "DROPSHIP_STORE_ACCESS_TOKEN_REQUIRED",
      "Dropship store access token is required.",
      { storeConnectionId: 44, retryable: false },
    ),
    new DropshipError(
      "DROPSHIP_STORE_REFRESH_TOKEN_REQUIRED",
      "Dropship store refresh token is required.",
      { storeConnectionId: 44, retryable: false },
    ),
    new DropshipError(
      "DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED",
      "eBay refresh token is required.",
      { storeConnectionId: 44, retryable: false },
    ),
    new DropshipError(
      "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
      "eBay token refresh failed with HTTP 400.",
      {
        storeConnectionId: 44,
        status: 400,
        authFailureStatus: "needs_reauth",
        providerErrorCode: "invalid_grant",
        retryable: false,
      },
    ),
  ])("converts a credential authorization failure into an actionable setup error", async (credentialError) => {
    const directory = new EbayDropshipListingSetupDirectory({
      async loadFreshForStoreConnection() {
        throw credentialError;
      },
    }, vi.fn() as unknown as typeof fetch);

    await expect(directory.discoverForStoreConnection({
      vendorId: 5,
      storeConnectionId: 44,
      marketplaceId: "EBAY_US",
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
      context: {
        storeConnectionId: 44,
        resource: "authorization",
        retryable: false,
      },
    });
  });

  it("does not misclassify a retryable token refresh outage as a reauthorization failure", async () => {
    const refreshError = new DropshipError(
      "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
      "eBay token refresh failed before a response was received.",
      { retryable: true, errorName: "TypeError" },
    );
    const directory = new EbayDropshipListingSetupDirectory({
      async loadFreshForStoreConnection() {
        throw refreshError;
      },
    }, vi.fn() as unknown as typeof fetch);

    await expect(directory.discoverForStoreConnection({
      vendorId: 5,
      storeConnectionId: 44,
      marketplaceId: "EBAY_US",
    })).rejects.toBe(refreshError);
  });

  it("does not misclassify a retained invalid-scope grant as a revoked authorization", async () => {
    const refreshError = new DropshipError(
      "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
      "eBay token refresh failed with HTTP 400.",
      {
        status: 400,
        authFailureStatus: "refresh_failed",
        providerErrorCode: "invalid_scope",
        retryable: false,
      },
    );
    const directory = new EbayDropshipListingSetupDirectory({
      async loadFreshForStoreConnection() {
        throw refreshError;
      },
    }, vi.fn() as unknown as typeof fetch);

    await expect(directory.discoverForStoreConnection({
      vendorId: 5,
      storeConnectionId: 44,
      marketplaceId: "EBAY_US",
    })).rejects.toBe(refreshError);
  });
});

function credentials(): DropshipEbayRegistrationCredentialProvider {
  return {
    async loadFreshForStoreConnection() {
      throw new Error("This test uses the explicit access-token path.");
    },
  };
}

function policy(
  idKey: "fulfillmentPolicyId" | "returnPolicyId" | "paymentPolicyId",
  id: string,
  name: string,
  categoryType = "ALL_EXCLUDING_MOTORS_VEHICLES",
): Record<string, unknown> {
  return {
    [idKey]: id,
    name,
    categoryTypes: [{ name: categoryType }],
    ...(idKey === "fulfillmentPolicyId" ? {
      marketplaceId: "EBAY_US",
      handlingTime: { value: 1, unit: "DAY" },
      shippingOptions: [{
        optionType: "DOMESTIC",
        shippingServices: [{ shippingServiceCode: "USPSGround" }],
      }],
      localPickup: false,
      freightShipping: false,
      pickupDropOff: false,
    } : {}),
  };
}

function parsedFulfillmentPolicy(id: string, name: string) {
  return {
    id,
    name,
    marketplaceId: "EBAY_US",
    handlingTime: { value: 1, unit: "DAY" },
    shippingOptions: [{
      optionType: "DOMESTIC",
      shippingServiceCodes: ["USPSGround"],
    }],
    localPickup: false,
    freightShipping: false,
    pickupDropOff: false,
  };
}

function emptyResourceResponse(url: string): Response {
  if (url.includes("/sell/inventory/v1/location")) return jsonResponse({ locations: [] });
  if (url.includes("fulfillment_policy")) return jsonResponse({ fulfillmentPolicies: [] });
  if (url.includes("return_policy")) return jsonResponse({ returnPolicies: [] });
  if (url.includes("payment_policy")) return jsonResponse({ paymentPolicies: [] });
  throw new Error(`Unexpected eBay URL: ${url}`);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
