export type InventoryPublicationDestinationKind =
  | "channel_connection"
  | "dropship_store_connection";

export type InventoryPublicationDestination =
  | {
      kind: "channel_connection";
      channelConnectionId: number;
      dropshipStoreConnectionId: null;
    }
  | {
      kind: "dropship_store_connection";
      channelConnectionId: null;
      dropshipStoreConnectionId: number;
    };

export interface AbsoluteInventoryPublicationRequest {
  destination: InventoryPublicationDestination;
  channelId: number;
  providerScopeType: "account" | "location";
  externalScopeId: string;
  productVariantId: number;
  externalInventoryItemId: string;
  externalSku: string | null;
  desiredQuantity: number;
}

export interface AbsoluteInventoryReadRequest {
  destination: InventoryPublicationDestination;
  channelId: number;
  providerScopeType: "account" | "location";
  externalScopeId: string;
  productVariantId: number;
  externalInventoryItemId: string;
  externalSku: string | null;
}

export interface AbsoluteInventoryPublicationResult {
  publishedQuantity: number;
  providerResponse: unknown;
}

export interface AbsoluteInventoryReadResult {
  observedQuantity: number;
  providerResponse: unknown;
}

/**
 * Exact-destination provider boundary. Implementations translate credentials
 * and provider payloads only; desiredQuantity is already the canonical ATP and
 * channel-exposure result and must never be recalculated here.
 */
export interface InventoryPublicationTransportAdapter {
  readonly destinationKind: InventoryPublicationDestinationKind;
  readonly providerKey: string;
  readonly supportedScopeTypes: readonly ("account" | "location")[];
  publishAbsolute(
    request: AbsoluteInventoryPublicationRequest,
  ): Promise<AbsoluteInventoryPublicationResult>;
  readAbsolute(
    request: AbsoluteInventoryReadRequest,
  ): Promise<AbsoluteInventoryReadResult>;
}

export class InventoryPublicationTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly context: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryPublicationTransportError";
  }
}

export class InventoryPublicationTransportConfigurationError
  extends InventoryPublicationTransportError
{
  constructor(
    code: string,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(code, message, false, context, options);
    this.name = "InventoryPublicationTransportConfigurationError";
  }
}

export class InventoryPublicationTransportRegistry {
  private readonly adapters = new Map<string, InventoryPublicationTransportAdapter>();

  register(adapter: InventoryPublicationTransportAdapter): void {
    const providerKey = normalizedProviderKey(adapter.providerKey);
    if (providerKey !== adapter.providerKey) {
      throw new InventoryPublicationTransportConfigurationError(
        "PUBLICATION_ADAPTER_PROVIDER_KEY_INVALID",
        "Inventory publication adapter provider keys must already be normalized.",
        { providerKey: adapter.providerKey },
      );
    }
    if (adapter.supportedScopeTypes.length === 0) {
      throw new InventoryPublicationTransportConfigurationError(
        "PUBLICATION_ADAPTER_SCOPE_EMPTY",
        "Inventory publication adapters must declare at least one exact provider scope.",
        { destinationKind: adapter.destinationKind, providerKey },
      );
    }
    const key = adapterKey(adapter.destinationKind, providerKey);
    if (this.adapters.has(key)) {
      throw new InventoryPublicationTransportConfigurationError(
        "PUBLICATION_ADAPTER_DUPLICATE",
        "An inventory publication adapter is already registered for this destination and provider.",
        { destinationKind: adapter.destinationKind, providerKey },
      );
    }
    this.adapters.set(key, adapter);
  }

  get(
    destinationKind: InventoryPublicationDestinationKind,
    providerKey: string,
  ): InventoryPublicationTransportAdapter | undefined {
    return this.adapters.get(adapterKey(destinationKind, normalizedProviderKey(providerKey)));
  }
}

function adapterKey(
  destinationKind: InventoryPublicationDestinationKind,
  providerKey: string,
): string {
  return `${destinationKind}:${providerKey}`;
}

function normalizedProviderKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new InventoryPublicationTransportConfigurationError(
      "PUBLICATION_ADAPTER_PROVIDER_KEY_INVALID",
      "Inventory publication adapter provider keys cannot be blank.",
    );
  }
  return normalized;
}
