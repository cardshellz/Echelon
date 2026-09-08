import type {
  DropshipEbayListingSetupDirectory,
  DropshipEbayListingSetupDiscovery,
  DropshipEbayListingSetupOption,
} from "../application/dropship-ebay-listing-setup-service";
import type {
  DropshipEbayFulfillmentPolicy,
} from "../domain/ebay-fulfillment-policy-compatibility";
import { DropshipError } from "../domain/errors";
import type { DropshipEbayRegistrationCredentialProvider } from "./dropship-ebay-registration-credentials";
import { resolveDropshipEbayProviderEnvironment } from "./dropship-ebay-registration-credentials";
import { ebayResourceErrorIdentifiers, withEbaySafeReadRecovery } from "./dropship-ebay-safe-read-recovery";
import { defaultEbaySetupReadRuntime, EBAY_SETUP_READ_TIMEOUT_MS, retryAfterMilliseconds,
  retryEbaySetupRead, type EbaySetupReadRuntime } from "./dropship-ebay-setup-read-retry";

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
    private readonly readRuntime: EbaySetupReadRuntime = defaultEbaySetupReadRuntime,
  ) {}

  async discoverForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
    marketplaceId: string;
  }): Promise<DropshipEbayListingSetupDiscovery> {
    return withEbaySafeReadRecovery({
      ...input,
      credentials: this.credentials,
      operation: "listing_setup_discovery",
      reauthorizationCode: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
      read: (credential) => this.discoverWithAccessToken({
        accessToken: credential.accessToken,
        environment: resolveDropshipEbayProviderEnvironment(credential),
        marketplaceId: input.marketplaceId,
        storeConnectionId: input.storeConnectionId,
      }),
    });
  }

  async getFulfillmentPolicyForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
    fulfillmentPolicyId: string;
  }): Promise<DropshipEbayFulfillmentPolicy> {
    return withEbaySafeReadRecovery({
      ...input,
      credentials: this.credentials,
      operation: "fulfillment_policy_read",
      reauthorizationCode: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
      read: (credential) => this.getFulfillmentPolicyWithAccessToken({
        accessToken: credential.accessToken,
        environment: resolveDropshipEbayProviderEnvironment(credential),
        storeConnectionId: input.storeConnectionId,
        fulfillmentPolicyId: input.fulfillmentPolicyId,
      }),
    });
  }

  async getFulfillmentPolicyWithAccessToken(input: {
    accessToken: string;
    environment: "sandbox" | "production";
    storeConnectionId: number;
    fulfillmentPolicyId: string;
  }): Promise<DropshipEbayFulfillmentPolicy> {
    const fulfillmentPolicyId = requiredIdentifier(
      input.fulfillmentPolicyId,
      "fulfillmentPolicyId",
    );
    const accessToken = input.accessToken.trim();
    if (!accessToken) {
      throw new DropshipError(
        "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED",
        "eBay fulfillment-policy verification requires an access token.",
        { storeConnectionId: input.storeConnectionId, retryable: false },
      );
    }
    const resource: ProviderResource = {
      key: "fulfillmentPolicies",
      path: `/sell/account/v1/fulfillment_policy/${encodeURIComponent(fulfillmentPolicyId)}`,
    };
    const body = await this.fetchResource({
      accessToken,
      baseUrl: EBAY_API_BASE_URLS[input.environment],
      resource,
      storeConnectionId: input.storeConnectionId,
    });
    const policy = parseFulfillmentPolicyValue(body, input.storeConnectionId);
    if (!policy || policy.id !== fulfillmentPolicyId) {
      throw invalidResponse(input.storeConnectionId, "fulfillmentPolicies");
    }
    return policy;
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
    const [merchantLocations, fulfillmentBody, returnBody, paymentBody] = await Promise.all([
      this.fetchAllMerchantLocations({
        accessToken,
        baseUrl,
        resource: resources[0],
        storeConnectionId: input.storeConnectionId,
      }),
      this.fetchResource({
        accessToken,
        baseUrl,
        resource: resources[1],
        storeConnectionId: input.storeConnectionId,
      }),
      this.fetchResource({
        accessToken,
        baseUrl,
        resource: resources[2],
        storeConnectionId: input.storeConnectionId,
      }),
      this.fetchResource({
        accessToken,
        baseUrl,
        resource: resources[3],
        storeConnectionId: input.storeConnectionId,
      }),
    ]);
    return {
      marketplaceId,
      merchantLocations,
      fulfillmentPolicies: parseFulfillmentPolicies(
        fulfillmentBody,
        input.storeConnectionId,
      ),
      returnPolicies: parseOptions(
        "returnPolicies",
        returnBody,
        input.storeConnectionId,
      ),
      paymentPolicies: parseOptions(
        "paymentPolicies",
        paymentBody,
        input.storeConnectionId,
      ),
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
    return retryEbaySetupRead(() => this.fetchResourceOnce(input), this.readRuntime);
  }

  private async fetchResourceOnce(input: {
    accessToken: string;
    baseUrl: string;
    resource: ProviderResource;
    storeConnectionId: number;
  }): Promise<Record<string, unknown>> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetchFn(`${input.baseUrl}${input.resource.path}`, {
        method: "GET",
        signal: AbortSignal.timeout(EBAY_SETUP_READ_TIMEOUT_MS),
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.accessToken}`,
        },
      });
      text = await readBoundedSetupResponse(response, input.storeConnectionId, input.resource.key);
    } catch (error) {
      if (error instanceof DropshipError) throw error;
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
    if (!response.ok) {
      const permissionRequired = response.status === 401 || response.status === 403;
      throw new DropshipError(
        permissionRequired
          ? "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED"
          : "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE",
        permissionRequired
          ? "eBay denied access to Inventory or Account settings. Card Shellz support must check application permissions and seller API eligibility."
          : "eBay did not return the connected store's listing setup.",
        {
          storeConnectionId: input.storeConnectionId,
          resource: input.resource.key,
          status: response.status,
          ...ebayResourceErrorIdentifiers(text),
          retryable: response.status === 429 || response.status >= 500,
          retryAfterMs: retryAfterMilliseconds(response.headers.get("Retry-After"), this.readRuntime.now()),
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

async function readBoundedSetupResponse(response: Response, storeConnectionId: number, resource: ProviderResource["key"]): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw invalidResponse(storeConnectionId, resource);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { reader.releaseLock(); }
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

export function parseFulfillmentPolicies(
  body: Record<string, unknown>,
  storeConnectionId: number,
): DropshipEbayFulfillmentPolicy[] {
  const raw = body.fulfillmentPolicies;
  if (!Array.isArray(raw) || raw.length > MAX_SETUP_OPTIONS) {
    throw invalidResponse(storeConnectionId, "fulfillmentPolicies");
  }
  const policies = raw.flatMap((value): DropshipEbayFulfillmentPolicy[] => {
    const policy = parseFulfillmentPolicyValue(value, storeConnectionId);
    return policy ? [policy] : [];
  });
  const deduplicated = new Map<string, DropshipEbayFulfillmentPolicy>();
  for (const policy of policies) {
    const existing = deduplicated.get(policy.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(policy)) {
      throw invalidResponse(storeConnectionId, "fulfillmentPolicies");
    }
    deduplicated.set(policy.id, policy);
  }
  return [...deduplicated.values()].sort((left, right) => (
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  ));
}

function parseFulfillmentPolicyValue(
  value: unknown,
  storeConnectionId: number,
): DropshipEbayFulfillmentPolicy | null {
  if (!isRecord(value) || !supportsNonMotorListings(value.categoryTypes)) return null;
  const id = optionalIdentifier(value.fulfillmentPolicyId);
  if (!id) return null;
  return {
    id,
    name: optionalName(value.name) ?? id,
    marketplaceId: optionalIdentifier(value.marketplaceId),
    handlingTime: parseHandlingTime(value.handlingTime),
    shippingOptions: parseShippingOptions(value.shippingOptions, storeConnectionId),
    localPickup: optionalProviderBoolean(
      value.localPickup,
      storeConnectionId,
    ),
    freightShipping: optionalProviderBoolean(
      value.freightShipping,
      storeConnectionId,
    ),
    pickupDropOff: optionalProviderBoolean(
      value.pickupDropOff,
      storeConnectionId,
    ),
  };
}

function parseHandlingTime(value: unknown): DropshipEbayFulfillmentPolicy["handlingTime"] {
  if (!isRecord(value)) return null;
  const unit = optionalBoundedString(value.unit, 30);
  const rawValue = value.value;
  const handlingValue = typeof rawValue === "number"
    && Number.isInteger(rawValue)
    && rawValue >= 0
    && rawValue <= 365
    ? rawValue
    : null;
  return { value: handlingValue, unit };
}

function parseShippingOptions(
  value: unknown,
  storeConnectionId: number,
): DropshipEbayFulfillmentPolicy["shippingOptions"] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw invalidResponse(storeConnectionId, "fulfillmentPolicies");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw invalidResponse(storeConnectionId, "fulfillmentPolicies");
    }
    const optionType = optionalBoundedString(entry.optionType, 40);
    if (!optionType) {
      throw invalidResponse(storeConnectionId, "fulfillmentPolicies");
    }
    const rawServices = entry.shippingServices;
    if (!Array.isArray(rawServices) || rawServices.length > 100) {
      throw invalidResponse(storeConnectionId, "fulfillmentPolicies");
    }
    const shippingServiceCodes = rawServices.map((service) => {
      if (!isRecord(service)) {
        throw invalidResponse(storeConnectionId, "fulfillmentPolicies");
      }
      const code = optionalBoundedString(service.shippingServiceCode, 100);
      if (!code) {
        throw invalidResponse(storeConnectionId, "fulfillmentPolicies");
      }
      return code;
    });
    return {
      optionType,
      shippingServiceCodes: [...new Set(shippingServiceCodes)].sort(),
    };
  });
}

function optionalProviderBoolean(
  value: unknown,
  storeConnectionId: number,
): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw invalidResponse(storeConnectionId, "fulfillmentPolicies");
  }
  return value;
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

function optionalBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
