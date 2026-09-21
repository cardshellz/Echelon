import { z } from "zod";
import type { OmsService } from "../../../oms/oms.service";
import { ChannelOrderObservationError, type ChannelOrderObservationWriter } from "../../../oms/channel-order-observation";
import { WalmartApiError } from "./walmart-client";
import { WalmartChannelService } from "./walmart-channel.service";
import { parseWalmartOrder } from "./walmart-us-api";
import { mapWalmartOrder, mapWalmartOrderObservation, walmartOrderHash, validateWalmartOrderScope } from "./walmart-order.domain";

const OVERLAP_MS = 24 * 60 * 60 * 1_000;
const MAX_PAGES = 100;
function failureCode(error: unknown, fallback: string): string {
  return error instanceof WalmartApiError || error instanceof ChannelOrderObservationError ? error.code : fallback;
}
export class WalmartOrderPollService {
  constructor(private readonly channels: WalmartChannelService,
    private readonly oms: Pick<OmsService, "ingestOrder">,
    private readonly syncToWms: (orderId: number) => Promise<unknown>,
    private readonly observations: ChannelOrderObservationWriter,
    private readonly now: () => Date = () => new Date()) {}

  async poll(channelId: number): Promise<{ observed: number; processed: number }> {
    const repository = this.channels.repository;
    return repository.withLock(channelId, async () => {
      const row = await this.channels.connection(channelId);
      this.channels.requireRuntime(row);
      if (!row.orders_enabled || row.channel_status !== "active") throw new WalmartApiError("WALMART_INTAKE_PAUSED", "Order intake is paused", false);
      await repository.assertWarehouse(row);
      const api = this.channels.api(row), now = this.now();
      const start = new Date(Math.max(row.import_since.getTime(), (row.checkpoint_at ?? row.import_since).getTime() - OVERLAP_MS));
      let observed = 0, processed = 0;
      let failure: string | null = null;
      const seen = new Set<string>();
      try {
        await repository.markPoll(channelId, now);
        const mappings = await repository.mappings(channelId);
        const mappedSkus = new Set(mappings.map(mapping => mapping.channel_sku));
        // Creation and modification windows are both needed for late cancellations.
        for (const field of ["created", "lastModified"] as const) {
          let query: URLSearchParams | null = new URLSearchParams({
            [`${field}StartDate`]: start.toISOString(), [`${field}EndDate`]: now.toISOString(),
            limit: "100", shipNodeType: "SellerFulfilled", shipNode: row.ship_node_id, replacementInfo: "true",
          });
          const cursors = new Set<string>();
          for (let page = 0; query; page++) {
            if (page >= MAX_PAGES) throw new WalmartApiError("WALMART_PAGE_LIMIT", "Order scan exceeded its page limit; checkpoint retained", false);
            const response = await api.orders(query);
            for (const raw of response.orders) {
              const identity = z.object({ purchaseOrderId: z.string().trim().min(1).max(100) }).safeParse(raw);
              if (!identity.success) { failure = "WALMART_ORDER_ID_INVALID"; continue; }
              const id = identity.data.purchaseOrderId;
              if (seen.has(id)) continue;
              seen.add(id); observed++;
              const hash = walmartOrderHash(raw);
              const receipt = await repository.receipt(channelId, id);
              let orderId = receipt?.oms_order_id ?? await this.observations.findOrder({ channelId, provider: "walmart", externalOrderId: id });
              try {
                let order = parseWalmartOrder(raw);
                const normalizedHash = walmartOrderHash(order);
                if (receipt?.source_hash === normalizedHash && ["completed", "ignored"].includes(receipt.status)) continue;
                await repository.recordReceipt(channelId, id, normalizedHash, "processing", orderId, null, now);
                validateWalmartOrderScope(order, row.ship_node_id);
                // Validate all monetary data and mappings before accepting the order.
                mapWalmartOrder(order, row.ship_node_id, false);
                if (order.orderLines.orderLine.some(line => !mappedSkus.has(line.item.sku))) {
                  throw new WalmartApiError("WALMART_SKU_UNMAPPED", "Link every order SKU to an Echelon variant before acknowledgment", false);
                }
                const states = order.orderLines.orderLine.flatMap(line => line.orderLineStatuses.orderLineStatus);
                if (orderId === null && states.some(state => ["Shipped", "Delivered"].includes(state.status))
                  && states.some(state => ["Created", "Acknowledged"].includes(state.status))) {
                  throw new WalmartApiError("WALMART_PARTIAL_HISTORY_REVIEW", "An order shipped partly outside Echelon needs quantity reconciliation before import", false);
                }
                if (states.some(state => state.status === "Created")) {
                  // Persist the observation with zero warehouse authority before the remote acknowledgment.
                  const observation = mapWalmartOrder(order, row.ship_node_id, false);
                  if (orderId === null) orderId = (await this.oms.ingestOrder(channelId, id, observation)).id;
                  else await this.observations.reconcile(mapWalmartOrderObservation(channelId, orderId, order, observation, now));
                  await repository.recordReceipt(channelId, id, hash, "processing", orderId, null, now);
                  order = await api.acknowledge(id);
                  validateWalmartOrderScope(order, row.ship_node_id);
                  if (order.orderLines.orderLine.some(line => !mappedSkus.has(line.item.sku))) {
                    throw new WalmartApiError("WALMART_SKU_UNMAPPED", "The acknowledged order contains an unmapped SKU", false);
                  }
                  if (order.orderLines.orderLine.some(line => line.orderLineStatuses.orderLineStatus.some(state => state.status === "Created"))) {
                    throw new WalmartApiError("WALMART_ACKNOWLEDGMENT_UNCONFIRMED", "Walmart has not confirmed order acknowledgment", true);
                  }
                }
                const data = mapWalmartOrder(order, row.ship_node_id, true);
                // Reconcile terminal header/disposition before granting authority
                // to an existing observation, including recovery after an ACK
                // succeeded remotely but its local receipt was never written.
                if (orderId !== null) await this.observations.reconcile(mapWalmartOrderObservation(channelId, orderId, order, data, now));
                const existingOrderId = orderId;
                orderId = (await this.oms.ingestOrder(channelId, id, data)).id;
                if (existingOrderId === null) await this.observations.reconcile(mapWalmartOrderObservation(channelId, orderId, order, data, now));
                const warehouseOrderId = await this.syncToWms(orderId);
                if (warehouseOrderId == null && data.status !== "cancelled" && data.fulfillmentStatus !== "fulfilled"
                  && data.lineItems.some(line => (line.fulfillableQuantity ?? 0) > 0)) {
                  throw new WalmartApiError("WALMART_WMS_SYNC_INCOMPLETE", "The acknowledged order has not completed warehouse materialization", true);
                }
                await repository.recordReceipt(channelId, id, walmartOrderHash(order), "completed", orderId, null, now);
                processed++;
              } catch (error) {
                const code = failureCode(error, "WALMART_ORDER_PROCESSING_FAILED");
                failure = code;
                await repository.recordReceipt(channelId, id, hash, "failed", orderId, code, now);
                console.error(JSON.stringify({ code, channelId, purchaseOrderId: id, omsOrderId: orderId }));
              }
            }
            if (!response.nextCursor) { query = null; continue; }
            if (!response.nextCursor.startsWith("?") || cursors.has(response.nextCursor)) {
              throw new WalmartApiError("WALMART_CURSOR_INVALID", "Walmart returned an invalid or repeated pagination cursor", false);
            }
            cursors.add(response.nextCursor);
            query = new URLSearchParams(response.nextCursor.slice(1));
            // Provider cursors cannot change the fulfillment scope of this worker.
            query.set("shipNodeType", "SellerFulfilled"); query.set("shipNode", row.ship_node_id); query.set("replacementInfo", "true");
          }
        }
        if (failure) throw new WalmartApiError(failure, "One or more Walmart orders require retry or review; checkpoint retained", true);
        await repository.markPoll(channelId, now, { checkpoint: now });
        return { observed, processed };
      } catch (error) {
        await repository.markPoll(channelId, now, { errorCode: failureCode(error, "WALMART_POLL_FAILED") });
        throw error;
      }
    });
  }
}

export function startWalmartOrderPolling(service: WalmartOrderPollService, channels: WalmartChannelService): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const channelId of await channels.repository.enabledChannels()) {
        try { await service.poll(channelId); }
        catch (error) { console.error(JSON.stringify({ code: failureCode(error, "WALMART_POLL_FAILED"), channelId })); }
      }
    } catch { console.error(JSON.stringify({ code: "WALMART_CHANNEL_SCAN_FAILED" })); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 5 * 60 * 1_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
