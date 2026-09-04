import type { Pool } from "pg";

import { pool as defaultPool } from "../../../db";
import {
  InventoryPublicationTransportConfigurationError,
  InventoryPublicationTransportError,
  type AbsoluteInventoryPublicationRequest,
  type AbsoluteInventoryPublicationResult,
  type AbsoluteInventoryReadRequest,
  type AbsoluteInventoryReadResult,
  type InventoryPublicationTransportAdapter,
} from "../../inventory-planning/application/inventory-publication-transport";
import { DropshipError } from "../domain/errors";
import {
  isEbayResourceAuthFailureStatus,
} from "./dropship-ebay-auth-failure";
import {
  RefreshingDropshipEbayRegistrationCredentialProvider,
  resolveDropshipEbayProviderEnvironment,
  type DropshipEbayRegistrationCredentialProvider,
} from "./dropship-ebay-registration-credentials";
import {
  createDropshipMarketplaceCredentialRepositoryFromEnv,
  type DropshipMarketplaceCredentialRepository,
  type DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";

const EBAY_BASE_URLS = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
} as const;

interface DropshipInventoryPublicationDestination {
  storeConnectionId: number;
  vendorId: number;
  providerKey: string;
  status: string;
}

export interface DropshipInventoryPublicationDestinationReader {
  load(storeConnectionId: number): Promise<DropshipInventoryPublicationDestination | null>;
}

export class PgDropshipInventoryPublicationDestinationReader
  implements DropshipInventoryPublicationDestinationReader
{
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = defaultPool) {}

  async load(storeConnectionId: number): Promise<DropshipInventoryPublicationDestination | null> {
    const client = await this.connectionPool.connect();
    try {
      const row = (await client.query<{
        id: number;
        vendor_id: number;
        platform: string;
        status: string;
      }>(
        `SELECT id, vendor_id, platform, status
         FROM dropship.dropship_store_connections
         WHERE id = $1`,
        [storeConnectionId],
      )).rows[0];
      if (!row) return null;
      return {
        storeConnectionId: positiveInteger(row.id, "storeConnectionId"),
        vendorId: positiveInteger(row.vendor_id, "vendorId"),
        providerKey: nonblank(row.platform, "providerKey").toLowerCase(),
        status: nonblank(row.status, "status"),
      };
    } finally {
      client.release();
    }
  }
}

/**
 * eBay transport for a Dropship-owned store. It accepts an already-planned
 * absolute quantity and never reads ATP, allocation policy, or warehouse data.
 */
export class EbayDropshipInventoryPublicationTransportAdapter
  implements InventoryPublicationTransportAdapter
{
  readonly destinationKind = "dropship_store_connection" as const;
  readonly providerKey = "ebay";
  readonly supportedScopeTypes = ["account"] as const;

  constructor(
    private readonly destinations: DropshipInventoryPublicationDestinationReader,
    private readonly credentials: DropshipEbayRegistrationCredentialProvider,
    private readonly credentialHealth: Pick<DropshipMarketplaceCredentialRepository, "recordAuthFailure">,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}

  async publishAbsolute(
    request: AbsoluteInventoryPublicationRequest,
  ): Promise<AbsoluteInventoryPublicationResult> {
    const context = await this.loadContext(request);
    const sku = exactEbayInventoryItemKey(request);
    const current = await this.requestJson({
      ...context,
      method: "GET",
      path: inventoryItemPath(sku),
    });
    const payload = withAbsoluteQuantity(current, request.desiredQuantity);
    const response = await this.requestNoContent({
      ...context,
      method: "PUT",
      path: inventoryItemPath(sku),
      body: payload,
    });
    return {
      publishedQuantity: request.desiredQuantity,
      providerResponse: response,
    };
  }

  async readAbsolute(
    request: AbsoluteInventoryReadRequest,
  ): Promise<AbsoluteInventoryReadResult> {
    const context = await this.loadContext(request);
    const sku = exactEbayInventoryItemKey(request);
    const payload = await this.requestJson({
      ...context,
      method: "GET",
      path: inventoryItemPath(sku),
    });
    const observedQuantity = inventoryQuantity(payload);
    return {
      observedQuantity,
      providerResponse: { status: 200, observedQuantity },
    };
  }

  private async loadContext(
    request: AbsoluteInventoryPublicationRequest | AbsoluteInventoryReadRequest,
  ): Promise<{
    destination: DropshipInventoryPublicationDestination;
    credential: DropshipMarketplaceStoreCredentials;
    baseUrl: string;
  }> {
    if (request.destination.kind !== this.destinationKind) {
      throw configurationError(
        "PUBLICATION_DESTINATION_KIND_MISMATCH",
        "The publication request destination does not match the Dropship transport adapter.",
        { expectedKind: this.destinationKind, actualKind: request.destination.kind },
      );
    }
    if (request.providerScopeType !== "account") {
      throw configurationError(
        "DROPSHIP_EBAY_INVENTORY_SCOPE_UNSUPPORTED",
        "Dropship eBay inventory publication requires an exact account scope.",
        { providerScopeType: request.providerScopeType },
      );
    }
    const destination = await this.destinations.load(
      request.destination.dropshipStoreConnectionId,
    );
    if (!destination
      || destination.storeConnectionId !== request.destination.dropshipStoreConnectionId) {
      throw configurationError(
        "DROPSHIP_INVENTORY_DESTINATION_NOT_FOUND",
        "The exact Dropship store connection does not exist.",
        { storeConnectionId: request.destination.dropshipStoreConnectionId },
      );
    }
    if (destination.providerKey !== this.providerKey) {
      throw configurationError(
        "DROPSHIP_INVENTORY_PROVIDER_MISMATCH",
        "The Dropship store provider does not match the selected inventory adapter.",
        { storeConnectionId: destination.storeConnectionId, providerKey: destination.providerKey },
      );
    }
    if (destination.status !== "connected") {
      throw configurationError(
        "DROPSHIP_INVENTORY_DESTINATION_NOT_CONNECTED",
        "The Dropship store must be connected before inventory can be published.",
        { storeConnectionId: destination.storeConnectionId, status: destination.status },
      );
    }
    let credential: DropshipMarketplaceStoreCredentials;
    try {
      credential = await this.credentials.loadFreshForStoreConnection({
        vendorId: destination.vendorId,
        storeConnectionId: destination.storeConnectionId,
      });
    } catch (error) {
      throw translateDropshipError(error);
    }
    if (credential.vendorId !== destination.vendorId
      || credential.storeConnectionId !== destination.storeConnectionId
      || credential.platform !== this.providerKey) {
      throw configurationError(
        "DROPSHIP_INVENTORY_CREDENTIAL_OWNER_MISMATCH",
        "The refreshed credential does not belong to the exact Dropship destination.",
        { storeConnectionId: destination.storeConnectionId, vendorId: destination.vendorId },
      );
    }
    if (credential.externalAccountIdentityScheme !== "provider_user_id"
      || credential.externalAccountId?.trim() !== request.externalScopeId.trim()) {
      throw configurationError(
        "DROPSHIP_INVENTORY_ACCOUNT_IDENTITY_MISMATCH",
        "The publication target account does not match the verified Dropship provider account.",
        {
          storeConnectionId: destination.storeConnectionId,
          targetExternalScopeId: request.externalScopeId,
          credentialExternalAccountId: credential.externalAccountId,
          credentialIdentityScheme: credential.externalAccountIdentityScheme,
        },
      );
    }
    const environment = resolveDropshipEbayProviderEnvironment(credential);
    return { destination, credential, baseUrl: EBAY_BASE_URLS[environment] };
  }

  private async requestJson(input: {
    destination: DropshipInventoryPublicationDestination;
    credential: DropshipMarketplaceStoreCredentials;
    baseUrl: string;
    method: "GET";
    path: string;
  }): Promise<Record<string, unknown>> {
    const response = await this.request(input);
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Classified below without exposing the provider body.
    }
    throw new InventoryPublicationTransportError(
      "DROPSHIP_EBAY_INVENTORY_RESPONSE_INVALID",
      "eBay inventory read returned invalid JSON.",
      true,
      { status: response.status },
    );
  }

  private async requestNoContent(input: {
    destination: DropshipInventoryPublicationDestination;
    credential: DropshipMarketplaceStoreCredentials;
    baseUrl: string;
    method: "PUT";
    path: string;
    body: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const response = await this.request(input);
    return { status: response.status };
  }

  private async request(input: {
    destination: DropshipInventoryPublicationDestination;
    credential: DropshipMarketplaceStoreCredentials;
    baseUrl: string;
    method: "GET" | "PUT";
    path: string;
    body?: Record<string, unknown>;
  }): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(`${input.baseUrl}${input.path}`, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${input.credential.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Language": "en-US",
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      });
    } catch (error) {
      throw new InventoryPublicationTransportError(
        "DROPSHIP_EBAY_INVENTORY_NETWORK_ERROR",
        "eBay inventory publication failed before a response was received.",
        true,
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        { cause: error },
      );
    }
    if (response.ok) return response;
    const responseBody = (await response.text()).slice(0, 1_000);
    const accessTokenRejected = isEbayResourceAuthFailureStatus(response.status);
    if (accessTokenRejected) {
      const now = this.clock.now();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw configurationError(
          "DROPSHIP_EBAY_INVENTORY_CLOCK_INVALID",
          "The inventory publication clock returned an invalid time.",
        );
      }
      await this.credentialHealth.recordAuthFailure?.({
        vendorId: input.destination.vendorId,
        storeConnectionId: input.destination.storeConnectionId,
        platform: "ebay",
        status: "refresh_failed",
        failureCode: "DROPSHIP_EBAY_INVENTORY_HTTP_ERROR",
        message: `eBay inventory publication failed with HTTP ${response.status}.`,
        retryable: true,
        statusCode: response.status,
        invalidateAccessToken: true,
        now,
      });
    }
    const retryable = accessTokenRejected
      || response.status === 408
      || response.status === 425
      || response.status === 429
      || response.status >= 500;
    throw new InventoryPublicationTransportError(
      "DROPSHIP_EBAY_INVENTORY_HTTP_ERROR",
      `eBay inventory publication failed with HTTP ${response.status}.`,
      retryable,
      { status: response.status, body: responseBody },
    );
  }
}

export function createEbayDropshipInventoryPublicationTransportAdapterFromEnv():
EbayDropshipInventoryPublicationTransportAdapter {
  const credentialRepository = createDropshipMarketplaceCredentialRepositoryFromEnv();
  return new EbayDropshipInventoryPublicationTransportAdapter(
    new PgDropshipInventoryPublicationDestinationReader(),
    RefreshingDropshipEbayRegistrationCredentialProvider.fromEnv(credentialRepository),
    credentialRepository,
  );
}

function inventoryItemPath(sku: string): string {
  return `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
}

function withAbsoluteQuantity(
  input: Record<string, unknown>,
  quantity: number,
): Record<string, unknown> {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw configurationError(
      "DROPSHIP_EBAY_INVENTORY_QUANTITY_INVALID",
      "The desired eBay inventory quantity must be a nonnegative safe integer.",
      { quantity },
    );
  }
  const availability = requiredRecord(input.availability, "availability");
  const shipToLocationAvailability = requiredRecord(
    availability.shipToLocationAvailability,
    "availability.shipToLocationAvailability",
  );
  return {
    ...input,
    availability: {
      ...availability,
      shipToLocationAvailability: {
        ...shipToLocationAvailability,
        quantity,
      },
    },
  };
}

function inventoryQuantity(input: Record<string, unknown>): number {
  const availability = requiredRecord(input.availability, "availability");
  const shipToLocationAvailability = requiredRecord(
    availability.shipToLocationAvailability,
    "availability.shipToLocationAvailability",
  );
  const quantity = shipToLocationAvailability.quantity;
  if (!Number.isSafeInteger(quantity) || Number(quantity) < 0) {
    throw new InventoryPublicationTransportError(
      "DROPSHIP_EBAY_INVENTORY_QUANTITY_INVALID",
      "eBay did not return a nonnegative integer inventory quantity.",
      true,
    );
  }
  return Number(quantity);
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new InventoryPublicationTransportError(
    "DROPSHIP_EBAY_INVENTORY_RESPONSE_INVALID",
    `eBay inventory response is missing ${field}.`,
    true,
  );
}

function exactEbayInventoryItemKey(
  request: AbsoluteInventoryPublicationRequest | AbsoluteInventoryReadRequest,
): string {
  const inventoryItemId = request.externalInventoryItemId.trim();
  if (!inventoryItemId) {
    throw configurationError(
      "DROPSHIP_EBAY_INVENTORY_ID_REQUIRED",
      "Dropship eBay inventory publication requires the exact provider inventory-item ID.",
    );
  }
  const externalSku = request.externalSku?.trim() || null;
  if (externalSku !== null && externalSku !== inventoryItemId) {
    throw configurationError(
      "DROPSHIP_EBAY_INVENTORY_IDENTITY_MISMATCH",
      "The eBay inventory-item ID must equal the external SKU recorded by eBay registration.",
      { externalInventoryItemId: inventoryItemId, externalSku },
    );
  }
  return inventoryItemId;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw configurationError(
      "DROPSHIP_INVENTORY_DESTINATION_INVALID",
      `${field} must be a positive safe integer.`,
    );
  }
  return parsed;
}

function nonblank(value: unknown, field: string): string {
  const parsed = String(value ?? "").trim();
  if (!parsed) {
    throw configurationError(
      "DROPSHIP_INVENTORY_DESTINATION_INVALID",
      `${field} is required.`,
    );
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function translateDropshipError(error: unknown): unknown {
  if (!(error instanceof DropshipError)) return error;
  return new InventoryPublicationTransportError(
    error.code,
    error.message,
    error.context?.retryable === true,
    error.context ?? {},
    { cause: error },
  );
}

function configurationError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): InventoryPublicationTransportConfigurationError {
  return new InventoryPublicationTransportConfigurationError(code, message, context);
}
