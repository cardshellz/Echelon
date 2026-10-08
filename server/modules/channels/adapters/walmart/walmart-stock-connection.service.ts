import { z } from "zod";
import { getSchedulerDisableReason } from "../../../../infrastructure/scheduler-config";
import { channelCatalogItemSchema } from "@shared/types/channel-catalog";
import type { VerifiedListingStockService } from "../../../inventory-planning/application/verified-listing-stock.service";
import { isActiveSellerShipNode, type WalmartChannelService } from "./walmart-channel.service";
import { WalmartApiError } from "./walmart-client";

const BATCH_SIZE = 50;
const SCAN_INTERVAL_MS = 60_000;
const codeOf = (error: unknown): string => error !== null && typeof error === "object" && "code" in error
  && typeof error.code === "string" ? error.code : "WALMART_STOCK_CONNECTION_FAILED";

/** Stateful scan cursor prevents rejected listings at the start of a large
 * account from starving later SKUs. Durable idempotency stays with inventory. */
export class WalmartStockConnectionService {
  private readonly cursors = new Map<number, number>();
  constructor(private readonly channels: WalmartChannelService,
    private readonly inventory: Pick<VerifiedListingStockService, "pending" | "connect">,
    private readonly now: () => Date = () => new Date(),
    private readonly logger: Pick<Console, "info" | "error"> = console) {}

  async processDue(limit = BATCH_SIZE): Promise<{ processed: number; failed: number }> {
    z.number().int().min(1).max(500).parse(limit);
    let processed = 0;
    let failed = 0;
    for (const channelId of await this.channels.repository.enabledChannels()) {
      try {
        const connection = await this.channels.connection(channelId);
        this.channels.requireRuntime(connection);
        const mappings = await this.channels.repository.mappings(channelId);
        const after = this.cursors.get(channelId) ?? 0;
        const ordered = [...mappings.filter(row => row.product_variant_id > after),
          ...mappings.filter(row => row.product_variant_id <= after)];
        const pending: typeof mappings = [];
        for (let offset = 0; offset < ordered.length && pending.length < limit; offset += 500) {
          const batch = ordered.slice(offset, offset + 500);
          const ids = new Set(await this.inventory.pending(channelId, connection.connection_id, batch.map(row => row.product_variant_id)));
          pending.push(...batch.filter(row => ids.has(row.product_variant_id)).slice(0, limit - pending.length));
        }
        if (!pending.length) continue;
        const api = this.channels.api(connection);
        const account = await api.account();
        if (account.partnerId !== connection.partner_id
          || !account.nodes.some(node => node.shipNode === connection.ship_node_id && isActiveSellerShipNode(node))) {
          throw new WalmartApiError("WALMART_ACCOUNT_CHANGED", "Verify the changed Walmart account or fulfillment center before connecting stock.", false);
        }
        for (const mapping of pending) {
          this.cursors.set(channelId, mapping.product_variant_id);
          try {
            const item = channelCatalogItemSchema.parse(await api.catalogItem(mapping.channel_sku));
            if (item.sku !== mapping.channel_sku || item.externalInventoryItemId !== mapping.channel_sku) {
              throw new WalmartApiError("WALMART_STOCK_IDENTITY_CHANGED", "Walmart returned a different inventory identity.", false);
            }
            // SYSTEM_PROBLEM, retired and unknown listings must never gain stock.
            if (item.lifecycleStatus !== "ACTIVE" || item.publishedStatus !== "PUBLISHED" || !item.externalProductId) continue;
            const result = await this.inventory.connect({ channelId, connectionId: connection.connection_id,
              accountId: connection.partner_id, environment: connection.environment, externalScopeId: connection.ship_node_id,
              productVariantId: mapping.product_variant_id, sku: mapping.channel_sku, externalProductId: item.externalProductId,
              lifecycleStatus: "ACTIVE", publishedStatus: "PUBLISHED", observedAt: this.now().toISOString() });
            if (result.state === "connected") {
              processed++;
              this.logger.info(JSON.stringify({ event: "walmart_stock_connected", channelId, variantId: mapping.product_variant_id,
                publicationRows: result.receipt?.publicationRows, quantities: result.quantities }));
            }
          } catch (error) {
            failed++;
            this.logger.error(JSON.stringify({ event: "walmart_stock_connection_failed", code: codeOf(error), channelId, variantId: mapping.product_variant_id }));
          }
        }
      } catch (error) {
        failed++;
        this.logger.error(JSON.stringify({ event: "walmart_stock_connection_failed", code: codeOf(error), channelId }));
      }
    }
    return { processed, failed };
  }
}

export function startWalmartStockConnectionWorker(service: WalmartStockConnectionService): (() => void) | undefined {
  const disabled = getSchedulerDisableReason("WALMART_STOCK_CONNECTION_DISABLED");
  if (disabled) {
    console.info(JSON.stringify({ event: "walmart_stock_connection_disabled", reason: disabled }));
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await service.processDue(); }
    catch (error) { console.error(JSON.stringify({ event: "walmart_stock_scan_failed", code: codeOf(error) })); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, SCAN_INTERVAL_MS);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
