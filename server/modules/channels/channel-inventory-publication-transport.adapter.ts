import type { IChannelAdapter } from "./channel-adapter.interface";
import { InventoryPublicationConfigurationError } from "./channel-adapter.interface";
import {
  InventoryPublicationTransportConfigurationError,
  InventoryPublicationTransportError,
  type AbsoluteInventoryPublicationRequest,
  type AbsoluteInventoryPublicationResult,
  type AbsoluteInventoryReadRequest,
  type AbsoluteInventoryReadResult,
  type InventoryPublicationTransportAdapter,
} from "../inventory-planning/application/inventory-publication-transport";

/** Bridges a Channels-owned provider adapter into the exact-destination port. */
export class ChannelInventoryPublicationTransportAdapter
  implements InventoryPublicationTransportAdapter
{
  readonly destinationKind = "channel_connection" as const;
  readonly providerKey: string;
  readonly supportedScopeTypes: readonly ("account" | "location")[];

  constructor(private readonly adapter: IChannelAdapter) {
    this.providerKey = adapter.providerKey.trim().toLowerCase();
    this.supportedScopeTypes = adapter.inventoryPublicationScopeTypes ?? [];
  }

  async publishAbsolute(
    request: AbsoluteInventoryPublicationRequest,
  ): Promise<AbsoluteInventoryPublicationResult> {
    const channelConnectionId = this.channelConnectionId(request);
    try {
      const results = await this.adapter.pushInventory(request.channelId, [{
        variantId: request.productVariantId,
        sku: request.externalSku,
        externalVariantId: null,
        externalInventoryItemId: request.externalInventoryItemId,
        allocatedQty: request.desiredQuantity,
      }], {
        authority: "canonical_outbox",
        channelConnectionId,
        providerScopeType: request.providerScopeType,
        externalScopeId: request.externalScopeId,
      });
      const result = singleResult(results, request.productVariantId, "publication");
      if (result.status !== "success" || result.pushedQty !== request.desiredQuantity) {
        throw new InventoryPublicationTransportError(
          result.errorCode ?? "PROVIDER_PUBLICATION_REJECTED",
          result.error ?? `Provider reported ${result.status} for inventory publication.`,
          result.retryable !== false,
        );
      }
      return { publishedQuantity: result.pushedQty, providerResponse: result };
    } catch (error) {
      throw translateConfigurationError(error);
    }
  }

  async readAbsolute(
    request: AbsoluteInventoryReadRequest,
  ): Promise<AbsoluteInventoryReadResult> {
    const channelConnectionId = this.channelConnectionId(request);
    if (!this.adapter.readInventory) {
      throw new InventoryPublicationTransportConfigurationError(
        "PUBLICATION_READBACK_UNSUPPORTED",
        `The ${this.providerKey} adapter cannot verify provider inventory readback.`,
      );
    }
    try {
      const results = await this.adapter.readInventory(request.channelId, [{
        variantId: request.productVariantId,
        sku: request.externalSku,
        externalInventoryItemId: request.externalInventoryItemId,
        providerScopeType: request.providerScopeType,
        externalScopeId: request.externalScopeId,
      }], {
        authority: "canonical_outbox",
        channelConnectionId,
        providerScopeType: request.providerScopeType,
        externalScopeId: request.externalScopeId,
      });
      const result = singleResult(results, request.productVariantId, "readback");
      if (result.status !== "success") {
        throw new InventoryPublicationTransportError(
          result.errorCode ?? "PROVIDER_READBACK_FAILED",
          result.error ?? "Provider inventory readback failed.",
          true,
        );
      }
      if (!Number.isSafeInteger(result.observedQty) || result.observedQty < 0) {
        throw new InventoryPublicationTransportError(
          "PROVIDER_READBACK_INVALID",
          "Provider returned an invalid inventory quantity.",
          true,
        );
      }
      return { observedQuantity: result.observedQty, providerResponse: result };
    } catch (error) {
      throw translateConfigurationError(error);
    }
  }

  private channelConnectionId(
    request: AbsoluteInventoryPublicationRequest | AbsoluteInventoryReadRequest,
  ): number {
    if (request.destination.kind !== this.destinationKind) {
      throw new InventoryPublicationTransportConfigurationError(
        "PUBLICATION_DESTINATION_KIND_MISMATCH",
        "The publication request destination does not match the Channels transport adapter.",
        { expectedKind: this.destinationKind, actualKind: request.destination.kind },
      );
    }
    if (!this.supportedScopeTypes.includes(request.providerScopeType)) {
      throw new InventoryPublicationTransportConfigurationError(
        "PUBLICATION_SCOPE_UNSUPPORTED",
        `The ${this.providerKey} adapter cannot address ${request.providerScopeType}-scoped inventory without inference.`,
      );
    }
    return request.destination.channelConnectionId;
  }
}

function singleResult<T extends { variantId: number }>(
  results: T[],
  productVariantId: number,
  operation: string,
): T {
  if (results.length !== 1 || results[0]?.variantId !== productVariantId) {
    throw new InventoryPublicationTransportError(
      "PROVIDER_RESPONSE_INVALID",
      `Provider ${operation} did not return exactly one matching variant result.`,
      true,
    );
  }
  return results[0];
}

function translateConfigurationError(error: unknown): unknown {
  if (error instanceof InventoryPublicationConfigurationError) {
    return new InventoryPublicationTransportConfigurationError(
      error.code,
      error.message,
      {},
      { cause: error },
    );
  }
  return error;
}
