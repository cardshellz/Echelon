import { sql, type SQL } from "drizzle-orm";
import type { ChannelFulfillmentProviderCommandInput } from "./fulfillment-push.service";
import { ChannelFulfillmentProviderError } from "../channels/channel-fulfillment-provider.error";

/** Recheck inside the order lock, and again immediately before the remote
 * create. Claim-time filtering alone cannot revoke an already claimed command. */
export async function assertShopifyCommandLabelActive(db: { execute(query: SQL): Promise<unknown> }, command: ChannelFulfillmentProviderCommandInput): Promise<void> {
  const result = await db.execute(sql`SELECT command.id, label.id AS label_id, label.label_status
    FROM oms.channel_fulfillment_pushes command
    JOIN wms.physical_shipments package ON package.id = command.physical_shipment_id
    LEFT JOIN wms.shipping_provider_labels label ON label.provider = package.provider
      AND label.provider_label_id = package.provider_physical_shipment_id
    WHERE command.id = ${command.commandId} AND command.physical_shipment_id = ${command.physicalShipmentId}
      AND command.oms_order_id = ${command.omsOrderId} AND command.channel_provider = 'shopify'
      AND command.tracking_number = ${command.trackingNumber}`);
  const rows = (result as { rows?: Array<{ id: string; label_id: string | null; label_status: string | null }> })?.rows;
  if (!Array.isArray(rows) || rows.length !== 1) throw new ChannelFulfillmentProviderError(
    'SHOPIFY_LABEL_COMMAND_NOT_FOUND', 'The exact Shopify package command is not persisted');
  // Pre-ledger legacy packages have no label row. Preserve their existing
  // reconciliation path; a known inactive label can never use that fallback.
  if (rows[0].label_id !== null && rows[0].label_status !== 'active') throw new ChannelFulfillmentProviderError(
    'PACKAGE_LABEL_INACTIVE', 'The shipping engine label is no longer active');
}
