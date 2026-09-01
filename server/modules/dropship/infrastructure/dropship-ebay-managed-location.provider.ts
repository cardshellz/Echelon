import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipEbayManagedLocation,
  DropshipEbayManagedLocationProvider,
} from "../application/dropship-ebay-managed-location-service";
import {
  managedMerchantLocationKeyForWarehouse,
} from "../application/dropship-ebay-managed-location-service";
import { DropshipError } from "../domain/errors";
import type {
  DropshipEbayRegistrationCredentialProvider,
} from "./dropship-ebay-registration-credentials";
import {
  resolveDropshipEbayProviderEnvironment,
} from "./dropship-ebay-registration-credentials";

type FetchLike = typeof fetch;

const EBAY_API_BASE_URLS = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
} as const;
const MAX_RESPONSE_BYTES = 100_000;

interface ManagedWarehouseRow {
  id: number;
  code: string;
  name: string;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  is_active: number;
}

interface ManagedWarehouse {
  id: number;
  code: string;
  name: string;
  city: string | null;
  state: string | null;
  postalCode: string;
  country: "US";
}

interface EbayInventoryLocationResponse {
  merchantLocationKey?: unknown;
  merchantLocationStatus?: unknown;
  name?: unknown;
  locationTypes?: unknown;
  location?: unknown;
}

export class PgDropshipEbayManagedLocationProvider
implements DropshipEbayManagedLocationProvider {
  constructor(private readonly deps: {
    credentials: DropshipEbayRegistrationCredentialProvider;
    dbPool?: Pool;
    fetchFn?: FetchLike;
  }) {}

  async ensureForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
    originWarehouseId: number;
  }): Promise<DropshipEbayManagedLocation> {
    const credential = await this.deps.credentials.loadFreshForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
    });
    return this.ensureWithAccessToken({
      accessToken: credential.accessToken,
      environment: resolveDropshipEbayProviderEnvironment(credential),
      storeConnectionId: input.storeConnectionId,
      originWarehouseId: input.originWarehouseId,
    });
  }

  async ensureWithAccessToken(input: {
    accessToken: string;
    environment: "sandbox" | "production";
    storeConnectionId: number;
    originWarehouseId: number;
  }): Promise<DropshipEbayManagedLocation> {
    const accessToken = input.accessToken.trim();
    if (!accessToken) {
      throw new DropshipError(
        "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED",
        "The Card Shellz-managed eBay inventory location requires an access token.",
        { storeConnectionId: input.storeConnectionId, retryable: false },
      );
    }
    const warehouse = await this.loadWarehouse(input.originWarehouseId);
    const merchantLocationKey = managedMerchantLocationKeyForWarehouse(warehouse.id);
    const name = managedLocationName(warehouse);
    const baseUrl = EBAY_API_BASE_URLS[input.environment];
    const existing = await this.getLocation({
      accessToken,
      baseUrl,
      merchantLocationKey,
      storeConnectionId: input.storeConnectionId,
    });
    if (!existing) {
      const created = await this.createLocation({
        accessToken,
        baseUrl,
        merchantLocationKey,
        storeConnectionId: input.storeConnectionId,
        warehouse,
        name,
      });
      if (created) {
        return {
          merchantLocationKey,
          name,
          originWarehouseId: warehouse.id,
          action: "created",
        };
      }
      // Another application instance may have created the deterministic key
      // after our initial GET. Re-read it before classifying the operation.
      const raced = await this.requireLocation({
        accessToken,
        baseUrl,
        merchantLocationKey,
        storeConnectionId: input.storeConnectionId,
      });
      return this.reconcileExistingLocation({
        accessToken,
        baseUrl,
        existing: raced,
        merchantLocationKey,
        name,
        storeConnectionId: input.storeConnectionId,
        warehouse,
      });
    }
    return this.reconcileExistingLocation({
      accessToken,
      baseUrl,
      existing,
      merchantLocationKey,
      name,
      storeConnectionId: input.storeConnectionId,
      warehouse,
    });
  }

  private async loadWarehouse(originWarehouseId: number): Promise<ManagedWarehouse> {
    managedMerchantLocationKeyForWarehouse(originWarehouseId);
    const client = await (this.deps.dbPool ?? defaultPool).connect();
    try {
      const result = await client.query<ManagedWarehouseRow>(
        `SELECT id, code, name, city, state, postal_code, country, is_active
         FROM warehouse.warehouses
         WHERE id = $1
         LIMIT 1`,
        [originWarehouseId],
      );
      const row = result.rows[0];
      if (!row || row.is_active !== 1) {
        throw new DropshipError(
          "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_REQUIRED",
          "The configured dropship origin warehouse is missing or inactive.",
          { originWarehouseId, retryable: false },
        );
      }
      const postalCode = requiredWarehouseText(row.postal_code, "postalCode", originWarehouseId, 20);
      const country = requiredWarehouseText(row.country, "country", originWarehouseId, 2).toUpperCase();
      if (country !== "US") {
        throw new DropshipError(
          "DROPSHIP_EBAY_MANAGED_LOCATION_COUNTRY_UNSUPPORTED",
          "EBAY_US dropship listings require a United States origin warehouse.",
          { originWarehouseId, country, retryable: false },
        );
      }
      return {
        id: row.id,
        code: requiredWarehouseText(row.code, "code", originWarehouseId, 20),
        name: requiredWarehouseText(row.name, "name", originWarehouseId, 200),
        city: optionalWarehouseText(row.city, 100),
        state: optionalWarehouseText(row.state, 50),
        postalCode,
        country,
      };
    } finally {
      client.release();
    }
  }

  private async reconcileExistingLocation(input: {
    accessToken: string;
    baseUrl: string;
    existing: EbayInventoryLocationResponse;
    merchantLocationKey: string;
    name: string;
    storeConnectionId: number;
    warehouse: ManagedWarehouse;
  }): Promise<DropshipEbayManagedLocation> {
    let action: DropshipEbayManagedLocation["action"] = "unchanged";
    if (!locationMatches(input.existing, input.merchantLocationKey, input.name, input.warehouse)) {
      await this.postLocationRequest({
        accessToken: input.accessToken,
        baseUrl: input.baseUrl,
        body: updateLocationPayload(input.warehouse, input.name),
        merchantLocationKey: input.merchantLocationKey,
        pathSuffix: "/update_location_details",
        storeConnectionId: input.storeConnectionId,
        operation: "update",
      });
      action = "updated";
    }
    if (input.existing.merchantLocationStatus !== "ENABLED") {
      await this.postLocationRequest({
        accessToken: input.accessToken,
        baseUrl: input.baseUrl,
        merchantLocationKey: input.merchantLocationKey,
        pathSuffix: "/enable",
        storeConnectionId: input.storeConnectionId,
        operation: "enable",
      });
      action = "enabled";
    }
    return {
      merchantLocationKey: input.merchantLocationKey,
      name: input.name,
      originWarehouseId: input.warehouse.id,
      action,
    };
  }

  private async createLocation(input: {
    accessToken: string;
    baseUrl: string;
    merchantLocationKey: string;
    storeConnectionId: number;
    warehouse: ManagedWarehouse;
    name: string;
  }): Promise<boolean> {
    const response = await this.request({
      accessToken: input.accessToken,
      baseUrl: input.baseUrl,
      body: createLocationPayload(input.warehouse, input.name),
      method: "POST",
      path: `/sell/inventory/v1/location/${encodeURIComponent(input.merchantLocationKey)}`,
      storeConnectionId: input.storeConnectionId,
      operation: "create",
      allowConflict: true,
    });
    return response !== null;
  }

  private async getLocation(input: {
    accessToken: string;
    baseUrl: string;
    merchantLocationKey: string;
    storeConnectionId: number;
  }): Promise<EbayInventoryLocationResponse | null> {
    const response = await this.request({
      accessToken: input.accessToken,
      baseUrl: input.baseUrl,
      method: "GET",
      path: `/sell/inventory/v1/location/${encodeURIComponent(input.merchantLocationKey)}`,
      storeConnectionId: input.storeConnectionId,
      operation: "read",
      allowNotFound: true,
    });
    if (response === null) return null;
    const parsed = parseJsonObject(response.text, input.storeConnectionId);
    const returnedKey = normalizedString(parsed.merchantLocationKey, 50);
    if (returnedKey && returnedKey !== input.merchantLocationKey) {
      throw invalidProviderResponse(input.storeConnectionId);
    }
    return parsed;
  }

  private async requireLocation(input: {
    accessToken: string;
    baseUrl: string;
    merchantLocationKey: string;
    storeConnectionId: number;
  }): Promise<EbayInventoryLocationResponse> {
    const location = await this.getLocation(input);
    if (!location) {
      throw new DropshipError(
        "DROPSHIP_EBAY_MANAGED_LOCATION_CREATE_CONFLICT",
        "The managed eBay inventory location could not be confirmed after a concurrent create.",
        { storeConnectionId: input.storeConnectionId, retryable: true },
      );
    }
    return location;
  }

  private async postLocationRequest(input: {
    accessToken: string;
    baseUrl: string;
    body?: Record<string, unknown>;
    merchantLocationKey: string;
    pathSuffix: string;
    storeConnectionId: number;
    operation: "update" | "enable";
  }): Promise<void> {
    await this.request({
      accessToken: input.accessToken,
      baseUrl: input.baseUrl,
      body: input.body,
      method: "POST",
      path: `/sell/inventory/v1/location/${encodeURIComponent(input.merchantLocationKey)}${input.pathSuffix}`,
      storeConnectionId: input.storeConnectionId,
      operation: input.operation,
    });
  }

  private async request(input: {
    accessToken: string;
    baseUrl: string;
    body?: Record<string, unknown>;
    method: "GET" | "POST";
    path: string;
    storeConnectionId: number;
    operation: "read" | "create" | "update" | "enable";
    allowNotFound?: boolean;
    allowConflict?: boolean;
  }): Promise<{ status: number; text: string } | null> {
    let response: Response;
    try {
      response = await (this.deps.fetchFn ?? fetch)(`${input.baseUrl}${input.path}`, {
        method: input.method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.accessToken}`,
          ...(input.body ? { "Content-Type": "application/json" } : {}),
        },
        body: input.body ? JSON.stringify(input.body) : undefined,
      });
    } catch (error) {
      throw new DropshipError(
        "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE",
        "The Card Shellz-managed eBay inventory location could not be synchronized.",
        {
          storeConnectionId: input.storeConnectionId,
          operation: input.operation,
          errorName: error instanceof Error ? error.name : "UnknownError",
          retryable: true,
        },
      );
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw invalidProviderResponse(input.storeConnectionId);
    }
    if (response.ok) return { status: response.status, text };
    if (input.allowNotFound && response.status === 404) return null;
    if (input.allowConflict && (response.status === 400 || response.status === 409)) return null;
    const permissionRequired = response.status === 401 || response.status === 403;
    throw new DropshipError(
      permissionRequired
        ? "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED"
        : "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE",
      permissionRequired
        ? "eBay did not grant the Inventory API access required to manage the dropship warehouse location."
        : "The Card Shellz-managed eBay inventory location could not be synchronized.",
      {
        storeConnectionId: input.storeConnectionId,
        operation: input.operation,
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      },
    );
  }
}

function createLocationPayload(
  warehouse: ManagedWarehouse,
  name: string,
): Record<string, unknown> {
  return {
    ...updateLocationPayload(warehouse, name),
    merchantLocationStatus: "ENABLED",
  };
}

function updateLocationPayload(
  warehouse: ManagedWarehouse,
  name: string,
): Record<string, unknown> {
  return {
    location: { address: warehouseAddress(warehouse) },
    locationTypes: ["WAREHOUSE"],
    name,
  };
}

function warehouseAddress(warehouse: ManagedWarehouse): Record<string, string> {
  return {
    ...(warehouse.city ? { city: warehouse.city } : {}),
    ...(warehouse.state ? { stateOrProvince: warehouse.state } : {}),
    postalCode: warehouse.postalCode,
    country: warehouse.country,
  };
}

function managedLocationName(warehouse: ManagedWarehouse): string {
  return `Card Shellz Dropship - ${warehouse.code}`.slice(0, 300);
}

function locationMatches(
  location: EbayInventoryLocationResponse,
  merchantLocationKey: string,
  name: string,
  warehouse: ManagedWarehouse,
): boolean {
  const returnedKey = normalizedString(location.merchantLocationKey, 50);
  if (returnedKey && returnedKey !== merchantLocationKey) return false;
  if (normalizedString(location.name, 300) !== name) return false;
  const locationTypes = Array.isArray(location.locationTypes)
    ? location.locationTypes.filter((value): value is string => typeof value === "string")
    : [];
  if (!locationTypes.includes("WAREHOUSE")) return false;
  if (!isRecord(location.location) || !isRecord(location.location.address)) return false;
  const address = location.location.address;
  const expected = warehouseAddress(warehouse);
  return Object.entries(expected).every(([key, value]) => (
    normalizedString(address[key], 200)?.toUpperCase() === value.toUpperCase()
  ));
}

function parseJsonObject(text: string, storeConnectionId: number): EbayInventoryLocationResponse {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) throw new Error("response was not an object");
    return parsed;
  } catch {
    throw invalidProviderResponse(storeConnectionId);
  }
}

function invalidProviderResponse(storeConnectionId: number): DropshipError {
  return new DropshipError(
    "DROPSHIP_EBAY_MANAGED_LOCATION_INVALID_RESPONSE",
    "eBay returned an invalid managed inventory location response.",
    { storeConnectionId, retryable: false },
  );
}

function requiredWarehouseText(
  value: unknown,
  field: string,
  originWarehouseId: number,
  maxLength: number,
): string {
  const normalized = normalizedString(value, maxLength);
  if (!normalized) {
    throw new DropshipError(
      "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_ADDRESS_REQUIRED",
      "The dropship origin warehouse is missing eBay location address data.",
      { originWarehouseId, field, retryable: false },
    );
  }
  return normalized;
}

function optionalWarehouseText(value: unknown, maxLength: number): string | null {
  return normalizedString(value, maxLength);
}

function normalizedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
