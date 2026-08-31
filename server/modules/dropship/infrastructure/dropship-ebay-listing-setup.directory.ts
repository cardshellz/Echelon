import type {
  DropshipEbayListingSetupDirectory,
  DropshipEbayListingSetupDiscovery,
  DropshipEbayListingSetupOption,
} from "../application/dropship-ebay-listing-setup-service";
import { DropshipError } from "../domain/errors";
import { isEbayTokenRefreshAuthFailureStatus } from "./dropship-ebay-auth-failure";
import type { DropshipEbayRegistrationCredentialProvider } from "./dropship-ebay-registration-credentials";
import { resolveDropshipEbayProviderEnvironment } from "./dropship-ebay-registration-credentials";

type FetchLike = typeof fetch;

const EBAY_API_BASE_URLS = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
} as const;
const MAX_SETUP_OPTIONS = 500;
const MAX_SETUP_PAGES = 10;
const MAX_RESPONSE_BYTES = 2_000_000;

interface ProviderResource {
  key: "merchantLocations" | "fulfillmentPolicies" | "returnPolicies" | "paymentPolicies";
  path: string;
}

export class EbayDropshipListingSetupDirectory implements DropshipEbayListingSetupDirectory {
  constructor(
    private readonly credentials: DropshipEbayRegistrationCredentialProvider,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  async discoverForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
    marketplaceId: string;
  }): Promise<DropshipEbayListingSetupDiscovery> {
    let credential;
    try {
      credential = await this.credentials.loadFreshForStoreConnection(input);
    } catch (error) {
      if (requiresEbayListingSetupReauthorization(error)) {
        throw new DropshipError(
          "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
          "eBay authorization must be refreshed before listing setup can be loaded.",
          {
            storeConnectionId: input.storeConnectionId,
            resource: "authorization",
            status: providerStatus(error),
            retryable: false,
          },
        );
      }
      throw error;
    }
    return this.discoverWithAccessToken({
      accessToken: credential.accessToken,
      environment: resolveDropshipEbayProviderEnvironment(credential),
      marketplaceId: input.marketplaceId,
      storeConnectionId: input.storeConnectionId,
    });
  }

  async discoverWithAccessToken(input: {
    accessToken: string;
    environment: "sandbox" | "production";
    marketplaceId: string;
    storeConnectionId: number;
  }): Promise<DropshipEbayListingSetupDiscovery> {
    const marketplaceId = requiredIdentifier(input.marketplaceId, "marketplaceId");
    const accessToken = input.accessToken.trim();
    if (!accessToken) {
      throw new DropshipError(
        "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED",
        "eBay listing setup requires an access token.",
        { storeConnectionId: input.storeConnectionId, retryable: false },
      );
    }
    const baseUrl = EBAY_API_BASE_URLS[input.environment];
    const resources: ProviderResource[] = [
      {
        key: "merchantLocations",
        path: "/sell/inventory/v1/location?limit=200",
      },
      {
        key: "fulfillmentPolicies",
        path: `/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`,
      },
      {
        key: "returnPolicies",
        path: `/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`,
      },
      {
        key: "paymentPolicies",
        path: `/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`,
      },
    ];
    const entries = await Promise.all(resources.map(async (resource) => {
      const parsedOptions = resource.key === "merchantLocations"
        ? await this.fetchAllMerchantLocations({
            accessToken,
            baseUrl,
            resource,
            storeConnectionId: input.storeConnectionId,
          })
        : parseOptions(resource.key, await this.fetchResource({
            accessToken,
            baseUrl,
            resource,
            storeConnectionId: input.storeConnectionId,
          }), input.storeConnectionId);
      return [resource.key, parsedOptions] as const;
    }));
    const options = Object.fromEntries(entries) as Record<ProviderResource["key"], DropshipEbayListingSetupOption[]>;
    return {
      marketplaceId,
      merchantLocations: options.merchantLocations,
      fulfillmentPolicies: options.fulfillmentPolicies,
      returnPolicies: options.returnPolicies,
      paymentPolicies: options.paymentPolicies,
    };
  }

  private async fetchAllMerchantLocations(input: {
    accessToken: string;
    baseUrl: string;
    resource: ProviderResource;
    storeConnectionId: number;
  }): Promise<DropshipEbayListingSetupOption[]> {
    const locations: unknown[] = [];
    const visitedPaths = new Set<string>();
    let path: string | null = input.resource.path;
    while (path) {
      if (visitedPaths.has(path) || visitedPaths.size >= MAX_SETUP_PAGES) {
        throw invalidResponse(input.storeConnectionId, input.resource.key);
      }
      visitedPaths.add(path);
      const body = await this.fetchResource({
        accessToken: input.accessToken,
        baseUrl: input.baseUrl,
        resource: { ...input.resource, path },
        storeConnectionId: input.storeConnectionId,
      });
      const page = body.locations;
      if (!Array.isArray(page) || locations.length + page.length > MAX_SETUP_OPTIONS) {
        throw invalidResponse(input.storeConnectionId, input.resource.key);
      }
      locations.push(...page);
      path = nextInventoryLocationPath(body.next, input.baseUrl, input.storeConnectionId);
    }
    return parseOptions("merchantLocations", { locations }, input.storeConnectionId);
  }

  private async fetchResource(input: {
    accessToken: string;
    baseUrl: string;
    resource: ProviderResource;
    storeConnectionId: number;
  }): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchFn(`${input.baseUrl}${input.resource.path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.accessToken}`,
        },
      });
    } catch (error) {
      throw new DropshipError(
        "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE",
        "eBay listing setup could not be loaded.",
        {
          storeConnectionId: input.storeConnectionId,
          resource: input.resource.key,
          retryable: true,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      );
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw invalidResponse(input.storeConnectionId, input.resource.key);
    }
    if (!response.ok) {
      const permissionRequired = response.status === 401 || response.status === 403;
      throw new DropshipError(
        permissionRequired
          ? "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED"
          : "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE",
        permissionRequired
          ? "eBay did not grant the Inventory and Account API access required for listing setup."
          : "eBay did not return the connected store's listing setup.",
        {
          storeConnectionId: input.storeConnectionId,
          resource: input.resource.key,
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        },
      );
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed)) throw new Error("response was not an object");
      return parsed;
    } catch {
      throw new DropshipError(
        "DROPSHIP_EBAY_LISTING_SETUP_INVALID_RESPONSE",
        "eBay returned an invalid listing setup response.",
        {
          storeConnectionId: input.storeConnectionId,
          resource: input.resource.key,
          retryable: false,
        },
      );
    }
  }
}

function requiresEbayListingSetupReauthorization(error: unknown): error is DropshipError {
  if (!(error instanceof DropshipError)) return false;
  if (
    error.code === "DROPSHIP_STORE_ACCESS_TOKEN_REQUIRED"
    || error.code === "DROPSHIP_STORE_REFRESH_TOKEN_REQUIRED"
    || error.code === "DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED"
  ) {
    return true;
  }
  return error.code === "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED"
    && isEbayTokenRefreshAuthFailureStatus(providerStatus(error) ?? 0);
}

function providerStatus(error: DropshipError): number | undefined {
  const value = error.context?.status;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function nextInventoryLocationPath(
  value: unknown,
  baseUrl: string,
  storeConnectionId: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2_048) {
    throw invalidResponse(storeConnectionId, "merchantLocations");
  }
  let parsed: URL;
  try {
    parsed = new URL(value, baseUrl);
  } catch {
    throw invalidResponse(storeConnectionId, "merchantLocations");
  }
  if (
    parsed.origin !== new URL(baseUrl).origin
    || parsed.pathname !== "/sell/inventory/v1/location"
  ) {
    throw invalidResponse(storeConnectionId, "merchantLocations");
  }
  return `${parsed.pathname}${parsed.search}`;
}

function parseOptions(
  key: ProviderResource["key"],
  body: Record<string, unknown>,
  storeConnectionId: number,
): DropshipEbayListingSetupOption[] {
  const collectionKey = key === "merchantLocations"
    ? "locations"
    : key;
  const raw = body[collectionKey];
  if (!Array.isArray(raw) || raw.length > MAX_SETUP_OPTIONS) {
    throw invalidResponse(storeConnectionId, key);
  }
  const options = raw.flatMap((value): DropshipEbayListingSetupOption[] => {
    if (!isRecord(value)) return [];
    if (key === "merchantLocations") {
      if (value.merchantLocationStatus !== "ENABLED") return [];
      const id = optionalIdentifier(value.merchantLocationKey);
      if (!id) return [];
      return [{ id, name: optionalName(value.name) ?? id }];
    }
    if (!supportsNonMotorListings(value.categoryTypes)) return [];
    const idKey = key === "fulfillmentPolicies"
      ? "fulfillmentPolicyId"
      : key === "returnPolicies"
        ? "returnPolicyId"
        : "paymentPolicyId";
    const id = optionalIdentifier(value[idKey]);
    if (!id) return [];
    return [{ id, name: optionalName(value.name) ?? id }];
  });
  const deduplicated = new Map<string, DropshipEbayListingSetupOption>();
  for (const option of options) {
    const existing = deduplicated.get(option.id);
    if (existing && existing.name !== option.name) {
      throw invalidResponse(storeConnectionId, key);
    }
    deduplicated.set(option.id, option);
  }
  return [...deduplicated.values()].sort((left, right) => {
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}

function supportsNonMotorListings(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    return isRecord(entry) && entry.name === "ALL_EXCLUDING_MOTORS_VEHICLES";
  });
}

function invalidResponse(
  storeConnectionId: number,
  resource: ProviderResource["key"],
): DropshipError {
  return new DropshipError(
    "DROPSHIP_EBAY_LISTING_SETUP_INVALID_RESPONSE",
    "eBay returned an invalid listing setup response.",
    { storeConnectionId, resource, retryable: false },
  );
}

function requiredIdentifier(value: unknown, field: string): string {
  const normalized = optionalIdentifier(value);
  if (!normalized) {
    throw new DropshipError(
      "DROPSHIP_EBAY_LISTING_SETUP_INVALID_INPUT",
      "eBay listing setup identifier is invalid.",
      { field, retryable: false },
    );
  }
  return normalized;
}

function optionalIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 100 ? normalized : null;
}

function optionalName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 300 ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
