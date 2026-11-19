import { channelCatalogItemSchema } from "@shared/types/channel-catalog";
import {
  stockLinkDestinationSchema, stockLinkOfferLookupSchema, type StockLinkDestination, type StockLinkOfferLookup,
} from "@shared/types/stock-link";
import type { StockLinkOfferAdapter, StockLinkProviderCallOptions } from "../../../inventory-planning/application/stock-link.ports";
import { STOCK_LINK_ERROR_CODES, StockLinkError } from "../../../inventory-planning/domain/stock-link-errors";
import { isActiveSellerShipNode, type WalmartChannelService } from "./walmart-channel.service";
import { WalmartApiError } from "./walmart-client";
import type { WalmartConnectionRecord } from "./walmart-connection.repository";

/**
 * The stock-link engine's Walmart adapter (channels PR4, PLAN-CH-v3 §2 "Adapters", §9 PR4): what Walmart holds for one
 * Card Shellz Walmart SKU, read with the destination's own Walmart login. Moved from the old every-minute connection
 * scan (walmart-stock-connection.service.ts): the account and ship-node check, then the catalog item of the SKU.
 * Walmart keeps one item per seller SKU (HYPOTHESIS, PLAN-CH-v3 §5), so the answer is zero or one offer; the offer id
 * is the SKU (the link and the outbox write by SKU) and its listing id is the WPID. On sale = ACTIVE + PUBLISHED + WPID
 * (anything else, SYSTEM_PROBLEM and retired items included, is UNPUBLISHED and never gains stock). Read-only, no retry
 * inside, decides nothing; every refusal is a classified StockLinkError.
 */

const C = STOCK_LINK_ERROR_CODES;
/** The account check is reused for this long, so one tick's ≤ 20 lookups do not each read the account again. */
export const WALMART_STOCK_LINK_ACCOUNT_CHECK_TTL_MS = 60_000;
export const WALMART_STOCK_LINK_MARKETPLACE = "WALMART_US";

export interface WalmartStockLinkAdapterDependencies {
  readonly channels: Pick<WalmartChannelService, "connection" | "requireRuntime" | "api">;
  readonly clock: () => Date;
}

function refusal(code: string, message: string, context: Readonly<Record<string, unknown>> = {},
  options?: ErrorOptions & { retryAfterMs?: number | null }): StockLinkError {
  return new StockLinkError(code, message, context, options);
}

function scopeOf(destination: StockLinkDestination): { channelId: number; connectionId: number; shipNodeId: string } {
  const parsed = stockLinkDestinationSchema.safeParse(destination);
  if (!parsed.success || parsed.data.destinationKind !== "channel_connection" || parsed.data.providerKey !== "walmart"
    || parsed.data.channelConnectionId === null || parsed.data.providerScopeType !== "location") {
    throw refusal(C.adapterContract, "The Walmart stock-link adapter was given another kind of destination.");
  }
  return { channelId: parsed.data.channelId, connectionId: parsed.data.channelConnectionId, shipNodeId: parsed.data.externalScopeId };
}

/** A Walmart refusal as the engine classifies it: the login, the store, a throttle, or this one SKU's request. */
export function classifyWalmartStockLinkError(error: unknown, context: Readonly<Record<string, unknown>>): StockLinkError {
  if (error instanceof StockLinkError) return error;
  if (error instanceof WalmartApiError) {
    const status = error.status;
    if (status === 401 || status === 403) return refusal(C.storeAuthRefused, `Walmart refused the login (HTTP ${status}).`, { ...context, status }, { cause: error });
    if (status === 429) return refusal(C.providerThrottled, "Walmart throttled the item read.", { ...context, status }, { cause: error });
    if (error.retryable || status === null || status === 408 || status >= 500)
      return refusal(C.providerUnavailable, "Walmart could not answer the item read now.", { ...context, status, code: error.code }, { cause: error });
    return refusal(C.lookupRejected, `Walmart refused the item read (HTTP ${status}).`, { ...context, status, code: error.code }, { cause: error });
  }
  return refusal(C.providerUnavailable, "Walmart did not answer the item read.", { ...context,
    errorName: error instanceof Error ? error.name : "UnknownError" }, { cause: error });
}

export class WalmartStockLinkAdapter implements StockLinkOfferAdapter {
  readonly destinationKind = "channel_connection" as const;
  readonly providerKey = "walmart";
  private readonly verified = new Map<number, { revision: number; at: number }>();

  constructor(private readonly deps: WalmartStockLinkAdapterDependencies) {}

  async findOffersBySku(destination: StockLinkDestination, sku: string, _options: StockLinkProviderCallOptions): Promise<StockLinkOfferLookup> {
    const scope = scopeOf(destination);
    const asked = sku.trim();
    if (asked.length === 0 || asked !== sku) throw refusal(C.adapterContract, "A Walmart item read needs one trimmed SKU.");
    const context = { channelId: scope.channelId, connectionId: scope.connectionId };
    let connection: WalmartConnectionRecord;
    try {
      connection = await this.deps.channels.connection(scope.channelId, scope.connectionId);
      this.deps.channels.requireRuntime(connection);
    } catch (error) {
      // No connection, or Walmart switched off by configuration: nothing is read for now; the pause lifts on an answer.
      throw refusal(C.storeUnavailable, "The Walmart connection is not usable now.", { ...context,
        code: error instanceof WalmartApiError ? error.code : null }, { cause: error });
    }
    if (connection.ship_node_id !== scope.shipNodeId) {
      throw refusal(C.storeAuthRefused, "The Walmart connection's fulfillment center is not the destination's.", context);
    }
    const api = this.deps.channels.api(connection);
    try {
      await this.verifyAccount(connection, api);
      const observedAt = this.deps.clock().toISOString();
      let raw: unknown;
      try { raw = await api.catalogItem(asked); }
      catch (error) {
        if (error instanceof WalmartApiError && error.status === 404) return this.lookup(observedAt, asked, []);
        throw error;
      }
      const item = channelCatalogItemSchema.safeParse(raw);
      if (!item.success) throw refusal(C.providerResponseInvalid, "Walmart's item read did not fit its contract.", context);
      if (item.data.sku !== asked || item.data.externalInventoryItemId !== asked) {
        // Walmart answered for another inventory identity: this SKU's read is refused, the store goes on.
        throw refusal(C.lookupRejected, "Walmart returned a different inventory identity for the SKU.", context);
      }
      const onSale = item.data.lifecycleStatus === "ACTIVE" && item.data.publishedStatus === "PUBLISHED" && item.data.externalProductId !== null;
      return this.lookup(observedAt, asked, [{ offerId: asked, sku: asked, status: onSale ? "PUBLISHED" : "UNPUBLISHED",
        listingId: item.data.externalProductId }]);
    } catch (error) {
      throw classifyWalmartStockLinkError(error, context);
    }
  }

  private async verifyAccount(connection: WalmartConnectionRecord, api: ReturnType<WalmartStockLinkAdapterDependencies["channels"]["api"]>) {
    const now = this.deps.clock().getTime();
    const cached = this.verified.get(connection.connection_id);
    if (cached && cached.revision === connection.revision && now - cached.at >= 0 && now - cached.at < WALMART_STOCK_LINK_ACCOUNT_CHECK_TTL_MS) return;
    const account = await api.account();
    if (account.partnerId !== connection.partner_id
      || !account.nodes.some(node => node.shipNode === connection.ship_node_id && isActiveSellerShipNode(node))) {
      this.verified.delete(connection.connection_id);
      throw refusal(C.storeAuthRefused, "Verify the changed Walmart account or fulfillment center before connecting stock.",
        { channelId: connection.channel_id, connectionId: connection.connection_id });
    }
    this.verified.set(connection.connection_id, { revision: connection.revision, at: now });
  }

  private lookup(observedAt: string, sku: string, offers: StockLinkOfferLookup["offers"]): StockLinkOfferLookup {
    const parsed = stockLinkOfferLookupSchema.safeParse({ observedAt, sku, marketplaceId: WALMART_STOCK_LINK_MARKETPLACE, offers });
    if (!parsed.success) throw refusal(C.adapterContract, "Walmart's item does not fit the stock-link contract.", { sku });
    return parsed.data;
  }
}

export function createWalmartStockLinkAdapter(deps: WalmartStockLinkAdapterDependencies): WalmartStockLinkAdapter {
  return new WalmartStockLinkAdapter(deps);
}
