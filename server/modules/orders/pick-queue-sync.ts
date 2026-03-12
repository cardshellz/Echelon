import { orderMethods as ordersStorage } from "./orders.storage";
import { warehouseStorage } from "../warehouse";
import { broadcastOrdersUpdated } from "../../websocket";

/**
 * After a product location changes, update pending order items so pickers
 * see the correct bin location in the queue.  Fire-and-forget — callers
 * should `.catch(() => {})` to avoid blocking the request.
 */
export async function syncPickQueueForSku(sku: string) {
  try {
    const freshLocation = await warehouseStorage.getBinLocationFromInventoryBySku(sku);
    if (!freshLocation) return;

    const rows = await ordersStorage.getPendingOrderItemsForSku(sku);

    let updated = 0;
    for (const row of rows) {
      if (row.location !== freshLocation.location || row.zone !== freshLocation.zone) {
        await ordersStorage.updateOrderItemLocation(
          row.id,
          freshLocation.location,
          freshLocation.zone,
          freshLocation.barcode || null,
          freshLocation.imageUrl || null,
        );
        updated++;
      }
    }

    if (updated > 0) {
      broadcastOrdersUpdated();
      console.log(`[Queue Sync] Updated ${updated} pending items for SKU ${sku} → ${freshLocation.location}`);
    }
  } catch (err: any) {
    console.warn(`[Queue Sync] Failed to sync SKU ${sku}:`, err?.message);
  }
}
