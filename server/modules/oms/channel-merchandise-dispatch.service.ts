import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { assertChannelMerchandiseDispatchQuantities } from "./domain/channel-merchandise-dispatch";
import { readChannelShopifyMerchandise } from "./infrastructure/channel-shopify-merchandise-reader";
import {
  shopifyMerchandiseSnapshotSchema,
  type ShopifyMerchandiseSnapshot,
} from "./infrastructure/shopify-merchandise-snapshot";
import { readChannelMerchandiseCapability, type ChannelMerchandiseCapabilityReader } from "./infrastructure/channel-merchandise-policy";

export async function verifyRefundedChannelMerchandise(
  db: { execute(statement: SQL): Promise<{ rows: unknown[] }> },
  omsOrderId: number,
  purpose: "dispatch" | "observation",
  ports: {
    usesChannelMerchandise?: ChannelMerchandiseCapabilityReader;
    readSnapshot?: (input: {
      channelId: number;
      orderId: string;
    }) => Promise<ShopifyMerchandiseSnapshot>;
  } = {},
): Promise<boolean> {
  z.number().int().positive().safe().parse(omsOrderId);
  const result =
    await db.execute(sql`SELECT channel_id,external_order_id,status,financial_status,cancelled_at
    FROM oms.oms_orders WHERE id=${omsOrderId}`);
  const source = z
    .object({
      channel_id: z.number().int().positive(),
      external_order_id: z.string(),
      status: z.string(),
      financial_status: z.string().nullable(),
      cancelled_at: z.unknown().nullable(),
    })
    .parse(result.rows[0]);
  if (
    ["cancelled", "refunded"].includes(source.status) ||
    source.cancelled_at !== null ||
    source.financial_status === "voided"
  )
    return false;
  const usesChannelQuantities = ports.usesChannelMerchandise
    ? await ports.usesChannelMerchandise(source.channel_id)
    : await readChannelMerchandiseCapability(db, source.channel_id);
  if (!usesChannelQuantities) return false;
  const scope = {
    channelId: source.channel_id,
    orderId: source.external_order_id,
  };
  const snapshot = shopifyMerchandiseSnapshotSchema.parse(
    await (ports.readSnapshot
      ? ports.readSnapshot(scope)
      : readChannelShopifyMerchandise(db, scope)),
  );
  if (snapshot.cancelled) return false;
  const lines =
    await db.execute(sql`SELECT external_line_item_id AS "externalLineItemId",paid_quantity AS "paidQuantity",
    authority_fulfillable_quantity AS "authorityFulfillableQuantity",channel_current_quantity AS "channelCurrentQuantity",
    channel_quantity_updated_at AS "channelQuantityUpdatedAt" FROM oms.oms_order_lines WHERE order_id=${omsOrderId}`);
  assertChannelMerchandiseDispatchQuantities({
    orderId: source.external_order_id,
    snapshot,
    lines: lines.rows,
    requireDispatchPermission: purpose === "dispatch",
  });
  return true;
}
