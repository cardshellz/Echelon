import { z } from "zod";
import { getSchedulerDisableReason } from "../../../../infrastructure/scheduler-config";
import { channelCatalogItemSchema } from "@shared/types/channel-catalog";
import { logger as platformLogger } from "../../../../platform/observability/logger";
import type { VerifiedListingStockService } from "../../../inventory-planning/application/verified-listing-stock.service";
import { isActiveSellerShipNode, walmartListingAccount, type WalmartChannelService } from "./walmart-channel.service";
import { WalmartApiError } from "./walmart-client";

const BATCH_SIZE = 50;
const SCAN_INTERVAL_MS = 60_000;
const ACTION = "channels.walmart.stock_scan";
const codeOf = (error: unknown): string => error !== null && typeof error === "object" && "code" in error
  && typeof error.code === "string" ? error.code : "WALMART_STOCK_SCAN_FAILED";

/** Asks the stock-link engine to check these sizes of a Walmart connection now (IP requestStockLinkChecks). */
export type WalmartStockLinkNudge = (input: { channelConnectionId: number; productVariantIds: number[] }) => Promise<number[]>;
export type WalmartStockScanLogger = Pick<typeof platformLogger, "debug" | "info" | "warn">;

/**
 * Walmart's every-minute scan (channels PR4, PLAN-CH-v3 §5, §9 PR4). It keeps two jobs and no longer links:
 * 1. presence: every retained mapping's listing presence is observed (a deleted Walmart item is recorded missing by
 *    the listing owner, which then refuses stock writes to it);
 * 2. PUBLISHED detection: a size that still needs its stock link (no sealed link, or one whose SKU is not the feed's
 *    current SKU) and that Walmart now reports ACTIVE + PUBLISHED + WPID is nudged to the stock-link engine, which links
 *    it on its next tick with its own store read, guard and audited transaction (walmart-stock-link-source.ts).
 * A rotating cursor bounds provider reads without starving later SKUs; it is a scan position only (durable state is
 * the engine's check rows). Expected outcomes (missing, not published, stopped) are DEBUG; a failed read is one WARN
 * per pass and channel (the old per-SKU console ERROR every minute is gone).
 */
export class WalmartStockConnectionService {
  private readonly cursors = new Map<number, number>();
  constructor(private readonly channels: WalmartChannelService,
    private readonly inventory: Pick<VerifiedListingStockService, "pending">,
    private readonly nudge: WalmartStockLinkNudge,
    private readonly logger: WalmartStockScanLogger = platformLogger) {}

  async processDue(limit = BATCH_SIZE): Promise<{ nudged: number; failed: number }> {
    z.number().int().min(1).max(500).parse(limit);
    let nudged = 0;
    let failed = 0;
    for (const channelId of await this.channels.repository.enabledChannels()) {
      const context = { channel_id: channelId };
      try {
        const connection = await this.channels.connection(channelId);
        this.channels.requireRuntime(connection);
        const correlation = { ...context, connection_id: connection.connection_id };
        const mappings = await this.channels.repository.mappings(channelId);
        const after = this.cursors.get(channelId) ?? 0;
        const ordered = [...mappings.filter(row => row.product_variant_id > after),
          ...mappings.filter(row => row.product_variant_id <= after)];
        const batch = ordered.slice(0, limit);
        if (!batch.length) continue;
        const pending = new Set(await this.inventory.pending(channelId, connection.connection_id, batch.map(row => row.product_variant_id)));
        const api = this.channels.api(connection);
        const account = await api.account();
        if (account.partnerId !== connection.partner_id
          || !account.nodes.some(node => node.shipNode === connection.ship_node_id && isActiveSellerShipNode(node))) {
          throw new WalmartApiError("WALMART_ACCOUNT_CHANGED", "Verify the changed Walmart account or fulfillment center before connecting stock.", false);
        }
        const published: number[] = [];
        const failures: { productVariantId: number; code: string }[] = [];
        for (const mapping of batch) {
          this.cursors.set(channelId, mapping.product_variant_id);
          try {
            const presence = await this.channels.observeListingPresence(walmartListingAccount(connection), mapping.channel_sku);
            if (presence?.state === "missing" || !pending.has(mapping.product_variant_id)) continue;
            const item = channelCatalogItemSchema.parse(await api.catalogItem(mapping.channel_sku));
            // SYSTEM_PROBLEM, retired, unknown and other-identity items are never nudged; the engine re-reads anyway.
            if (item.sku !== mapping.channel_sku || item.externalInventoryItemId !== mapping.channel_sku
              || item.lifecycleStatus !== "ACTIVE" || item.publishedStatus !== "PUBLISHED" || !item.externalProductId) continue;
            published.push(mapping.product_variant_id);
          } catch (error) {
            if (codeOf(error) === "LISTING_PUBLICATION_STOPPED") continue;
            failures.push({ productVariantId: mapping.product_variant_id, code: codeOf(error) });
          }
        }
        if (published.length) {
          const due = await this.nudge({ channelConnectionId: connection.connection_id, productVariantIds: published });
          nudged += due.length;
          this.logger.info(ACTION, { ...correlation, outcome: "nudged", product_variant_ids: published, due_product_variant_ids: due });
        }
        if (failures.length) {
          failed += failures.length;
          this.logger.warn(ACTION, { ...correlation, outcome: "read_failed", failures, error_code: failures[0]!.code });
        }
      } catch (error) {
        failed++;
        this.logger.warn(ACTION, { ...context, outcome: "channel_failed", error_code: codeOf(error) });
      }
    }
    return { nudged, failed };
  }
}

export function startWalmartStockConnectionWorker(service: WalmartStockConnectionService,
  logger: WalmartStockScanLogger = platformLogger): (() => void) | undefined {
  const disabled = getSchedulerDisableReason("WALMART_STOCK_CONNECTION_DISABLED");
  if (disabled) {
    logger.info(ACTION, { outcome: "disabled", reason: disabled });
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await service.processDue(); }
    catch (error) { logger.warn(ACTION, { outcome: "scan_failed", error_code: codeOf(error) }); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, SCAN_INTERVAL_MS);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
