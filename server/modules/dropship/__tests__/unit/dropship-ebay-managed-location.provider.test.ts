import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  managedMerchantLocationKeyForWarehouse,
} from "../../application/dropship-ebay-managed-location-service";
import type {
  DropshipEbayRegistrationCredentialProvider,
} from "../../infrastructure/dropship-ebay-registration-credentials";
import {
  PgDropshipEbayManagedLocationProvider,
} from "../../infrastructure/dropship-ebay-managed-location.provider";

const warehouse = {
  id: 1,
  code: "HQ",
  name: "Main warehouse",
  city: "Cranberry Township",
  state: "PA",
  postal_code: "16066",
  country: "US",
  is_active: 1,
};

describe("PgDropshipEbayManagedLocationProvider", () => {
  it("creates one deterministic enabled warehouse location when it is absent", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return requests.length === 1
        ? new Response("", { status: 404 })
        : new Response(null, { status: 204 });
    });
    const provider = providerWith({ fetchFn });

    await expect(provider.ensureWithAccessToken({
      accessToken: "access-token",
      environment: "production",
      storeConnectionId: 44,
      originWarehouseId: 1,
    })).resolves.toEqual({
      merchantLocationKey: "cardshellz-dropship-wh-1",
      name: "Card Shellz Dropship - HQ",
      originWarehouseId: 1,
      action: "created",
    });

    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      ["GET", "https://api.ebay.com/sell/inventory/v1/location/cardshellz-dropship-wh-1"],
      ["POST", "https://api.ebay.com/sell/inventory/v1/location/cardshellz-dropship-wh-1"],
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      location: {
        address: {
          city: "Cranberry Township",
          stateOrProvince: "PA",
          postalCode: "16066",
          country: "US",
        },
      },
      locationTypes: ["WAREHOUSE"],
      name: "Card Shellz Dropship - HQ",
      merchantLocationStatus: "ENABLED",
    });
    expect(new Headers(requests[1]?.init?.headers).get("Authorization")).toBe(
      "Bearer access-token",
    );
  });

  it("repairs and enables a stale managed location", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      if (urls.length === 1) {
        return jsonResponse({
          merchantLocationKey: "cardshellz-dropship-wh-1",
          merchantLocationStatus: "DISABLED",
          name: "Old name",
          locationTypes: ["STORE"],
          location: { address: { postalCode: "00000", country: "US" } },
        });
      }
      return new Response(null, { status: 204 });
    });

    await expect(providerWith({ fetchFn }).ensureWithAccessToken({
      accessToken: "access-token",
      environment: "production",
      storeConnectionId: 44,
      originWarehouseId: 1,
    })).resolves.toMatchObject({ action: "enabled" });
    expect(urls).toEqual([
      "https://api.ebay.com/sell/inventory/v1/location/cardshellz-dropship-wh-1",
      "https://api.ebay.com/sell/inventory/v1/location/cardshellz-dropship-wh-1/update_location_details",
      "https://api.ebay.com/sell/inventory/v1/location/cardshellz-dropship-wh-1/enable",
    ]);
  });

  it("does not mutate an already matching enabled managed location", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(matchingLocation()));

    await expect(providerWith({ fetchFn }).ensureWithAccessToken({
      accessToken: "access-token",
      environment: "sandbox",
      storeConnectionId: 44,
      originWarehouseId: 1,
    })).resolves.toMatchObject({ action: "unchanged" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("api.sandbox.ebay.com");
  });

  it("recovers deterministically when another instance wins the create race", async () => {
    const responses = [
      new Response("", { status: 404 }),
      new Response("already exists", { status: 409 }),
      jsonResponse(matchingLocation()),
    ];
    const fetchFn = vi.fn(async () => responses.shift()!);

    await expect(providerWith({ fetchFn }).ensureWithAccessToken({
      accessToken: "access-token",
      environment: "production",
      storeConnectionId: 44,
      originWarehouseId: 1,
    })).resolves.toMatchObject({ action: "unchanged" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the warehouse address is incomplete", async () => {
    const provider = providerWith({
      warehouseRow: { ...warehouse, postal_code: null },
      fetchFn: vi.fn(),
    });

    await expect(provider.ensureWithAccessToken({
      accessToken: "access-token",
      environment: "production",
      storeConnectionId: 44,
      originWarehouseId: 1,
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_ADDRESS_REQUIRED",
      context: { originWarehouseId: 1, field: "postalCode", retryable: false },
    });
  });

  it("classifies eBay authorization failures without returning the provider body", async () => {
    const provider = providerWith({
      fetchFn: vi.fn(async () => new Response("secret diagnostic", { status: 403 })),
    });

    await expect(provider.ensureWithAccessToken({
      accessToken: "access-token",
      environment: "production",
      storeConnectionId: 44,
      originWarehouseId: 1,
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
      context: { storeConnectionId: 44, operation: "read", status: 403, retryable: false },
    });
  });

  it("derives only bounded keys from positive warehouse ids", () => {
    expect(managedMerchantLocationKeyForWarehouse(123)).toBe("cardshellz-dropship-wh-123");
    expect(() => managedMerchantLocationKeyForWarehouse(0)).toThrowError(
      expect.objectContaining({ code: "DROPSHIP_EBAY_MANAGED_LOCATION_INVALID_INPUT" }),
    );
  });
});

function providerWith(input: {
  fetchFn: typeof fetch;
  warehouseRow?: typeof warehouse;
}): PgDropshipEbayManagedLocationProvider {
  const client = new FakePgClient(rows([input.warehouseRow ?? warehouse]));
  return new PgDropshipEbayManagedLocationProvider({
    credentials: {
      loadFreshForStoreConnection: vi.fn(),
    } as unknown as DropshipEbayRegistrationCredentialProvider,
    dbPool: {
      connect: async () => client as unknown as PoolClient,
    } as unknown as Pool,
    fetchFn: input.fetchFn,
  });
}

class FakePgClient {
  released = false;

  constructor(private readonly response: QueryResult) {}

  async query(): Promise<QueryResult> {
    return this.response;
  }

  release(): void {
    this.released = true;
  }
}

function matchingLocation() {
  return {
    merchantLocationKey: "cardshellz-dropship-wh-1",
    merchantLocationStatus: "ENABLED",
    name: "Card Shellz Dropship - HQ",
    locationTypes: ["WAREHOUSE"],
    location: {
      address: {
        city: "Cranberry Township",
        stateOrProvince: "PA",
        postalCode: "16066",
        country: "US",
      },
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function rows<T extends Record<string, unknown>>(data: T[]): QueryResult<T> {
  return {
    command: "SELECT",
    rowCount: data.length,
    oid: 0,
    fields: [],
    rows: data,
  };
}
