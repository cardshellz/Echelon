import type {
  IChannelAdapter, ChannelListingPayload, PricingPushItem, ChannelOrder,
  FulfillmentPayload, CancellationPayload, InventoryPushItem, InventoryPushResult,
  InventoryReadItem, InventoryReadResult, InventoryPublicationContext,
} from "../../channel-adapter.interface";
import { WalmartChannelService } from "./walmart-channel.service";
import { WalmartApiError } from "./walmart-client";

export class WalmartAdapter implements IChannelAdapter {
  readonly adapterName = "Walmart US";
  readonly providerKey = "walmart";
  readonly shippingCapabilities = { acceptsEngineQuotes: false, managesOwnRates: true, enforcesDestinationEligibility: true };
  readonly inventoryPublicationScopeTypes = ["location"] as const;
  constructor(private readonly channels: WalmartChannelService) {}

  private async scope(channelId: number, context?: InventoryPublicationContext) {
    if (!context || context.authority !== "canonical_outbox" || context.providerScopeType !== "location") {
      throw new WalmartApiError("WALMART_PUBLICATION_AUTHORITY_REQUIRED", "Use an approved inventory publication destination", false);
    }
    const connection = await this.channels.connection(channelId, context.channelConnectionId);
    this.channels.requireRuntime(connection);
    if (connection.ship_node_id !== context.externalScopeId) throw new WalmartApiError("WALMART_INVENTORY_SCOPE_MISMATCH", "Inventory destination differs from the configured Walmart fulfillment center", false);
    const mappings = await this.channels.repository.mappings(channelId);
    return { api: this.channels.api(connection), connection, mappings };
  }

  async pushInventory(channelId: number, items: InventoryPushItem[], context?: InventoryPublicationContext): Promise<InventoryPushResult[]> {
    return this.channels.repository.withLock(channelId, async () => {
      const scope = await this.scope(channelId, context);
      // A conservative zero must remain publishable after supply is withdrawn.
      // Positive promises require the active, exact warehouse supply binding.
      if (items.some(item => item.allocatedQty > 0)) {
        await this.channels.repository.assertWarehouse(scope.connection);
        await this.channels.repository.assertInventorySupply(scope.connection);
      }
      const results: InventoryPushResult[] = [];
      for (const item of items) {
        try {
          const sku = scope.mappings.find(mapping => mapping.product_variant_id === item.variantId)?.channel_sku;
          if (!sku || sku !== item.externalInventoryItemId
            || (item.externalVariantId !== null && sku !== item.externalVariantId)
            || (item.sku !== null && sku !== item.sku)) {
            throw new WalmartApiError("WALMART_INVENTORY_MAPPING_MISMATCH", "Inventory command must match the explicit Walmart SKU mapping", false);
          }
          await scope.api.setInventory(sku, scope.connection.ship_node_id, item.allocatedQty);
          results.push({ variantId: item.variantId, pushedQty: item.allocatedQty, status: "success" });
        } catch (error) {
          const failure = safeFailure(error);
          results.push({ variantId: item.variantId, pushedQty: 0, status: "error", ...failure });
        }
      }
      return results;
    });
  }

  async readInventory(channelId: number, items: InventoryReadItem[], context: InventoryPublicationContext): Promise<InventoryReadResult[]> {
    const scope = await this.scope(channelId, context);
    const results: InventoryReadResult[] = [];
    for (const item of items) {
      try {
        const sku = scope.mappings.find(mapping => mapping.product_variant_id === item.variantId)?.channel_sku;
        if (!sku || sku !== item.externalInventoryItemId || item.providerScopeType !== "location" || item.externalScopeId !== scope.connection.ship_node_id) {
          throw new WalmartApiError("WALMART_INVENTORY_MAPPING_MISMATCH", "Readback must match the explicit Walmart SKU and fulfillment center", false);
        }
        const observedQty = await scope.api.inventory(sku, scope.connection.ship_node_id);
        results.push({ variantId: item.variantId, observedQty, status: "success", providerResponse: { sku, shipNode: scope.connection.ship_node_id, quantity: observedQty } });
      } catch (error) { results.push({ variantId: item.variantId, observedQty: 0, status: "error", ...safeFailure(error) }); }
    }
    return results;
  }

  async pushListings(_id: number, listings: ChannelListingPayload[]) {
    return listings.map(listing => ({ productId: listing.productId, status: "error" as const, error: "Manage Walmart listings in Seller Center; link existing SKUs in Echelon" }));
  }
  async pushPricing(_id: number, items: PricingPushItem[]) {
    return items.map(item => ({ variantId: item.variantId, status: "error" as const, error: "Manage Walmart prices in Seller Center" }));
  }
  async pullOrders(): Promise<ChannelOrder[]> { throw new WalmartApiError("WALMART_ORDER_WORKER_REQUIRED", "Walmart orders require the acknowledgment-aware order worker", false); }
  async receiveOrder(): Promise<ChannelOrder | null> { throw new WalmartApiError("WALMART_WEBHOOK_UNSUPPORTED", "Walmart order intake uses authenticated polling", false); }
  async pushFulfillment(_id: number, payloads: FulfillmentPayload[]) {
    return payloads.map(payload => ({ externalOrderId: payload.externalOrderId, status: "error" as const, error: "Walmart tracking requires a durable shipment fulfillment command" }));
  }
  async pushCancellation(_id: number, payloads: CancellationPayload[]) {
    return payloads.map(payload => ({ externalOrderId: payload.externalOrderId, status: "not_supported" as const, error: "Cancel Walmart orders in Seller Center; Echelon imports the disposition" }));
  }
}

function safeFailure(error: unknown) {
  return error instanceof WalmartApiError
    ? { error: error.message, errorCode: error.code, retryable: error.retryable }
    : { error: "Walmart inventory operation failed", errorCode: "WALMART_INVENTORY_FAILED", retryable: true };
}
