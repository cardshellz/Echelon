import { sql } from "drizzle-orm";
import { IntegrityError } from "../../../shared/errors";

export interface RepairShopifyOmsOrderCustomerScope {
  shopDomain: string;
  externalOrderId: string;
  numericOrderId: string;
}

export interface RepairShopifyOmsOrderCustomerData {
  customerName: string;
  customerEmail: string | null;
  shippingName: string | null;
  shippingAddress1: string | null;
  shippingAddress2: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingPostalCode: string | null;
  shippingCountry: string | null;
}

export async function repairShopifyOmsOrderCustomer(
  db: any,
  scope: RepairShopifyOmsOrderCustomerScope,
  data: RepairShopifyOmsOrderCustomerData,
): Promise<number> {
  return db.transaction(async (tx: any) => {
    // Hold the resolved channel and connection through the write. A default
    // channel or display number can never establish provider ownership.
    const connections = await tx.execute(sql`
      SELECT c.id AS channel_id
      FROM channels.channels c
      JOIN channels.channel_connections cc ON cc.channel_id = c.id
      WHERE c.provider = 'shopify' AND c.status = 'active'
        AND LOWER(BTRIM(cc.shop_domain)) = ${scope.shopDomain}
      ORDER BY c.id, cc.id
      LIMIT 2
      FOR SHARE OF c, cc
    `);
    if (connections.rows.length !== 1) {
      throw new IntegrityError(
        "Customer repair requires one active Shopify channel connection for the configured shop.",
      );
    }
    const channelId = connections.rows[0].channel_id;
    const matches = await tx.execute(sql`
      SELECT id FROM oms.oms_orders
      WHERE channel_id = ${channelId}
        AND external_order_id IN (${scope.numericOrderId}, ${scope.externalOrderId})
      ORDER BY id LIMIT 2 FOR UPDATE
    `);
    if (matches.rows.length === 0) return 0;
    if (matches.rows.length !== 1) {
      throw new IntegrityError(
        "Customer repair requires one OMS order for the exact Shopify order and channel.",
      );
    }
    const result = await tx.execute(sql`
      UPDATE oms.oms_orders SET
        customer_name = ${data.customerName},
        customer_email = ${data.customerEmail},
        ship_to_name = ${data.shippingName},
        ship_to_address1 = ${data.shippingAddress1},
        ship_to_address2 = ${data.shippingAddress2},
        ship_to_city = ${data.shippingCity},
        ship_to_state = ${data.shippingState},
        ship_to_zip = ${data.shippingPostalCode},
        ship_to_country = ${data.shippingCountry}
      WHERE id = ${matches.rows[0].id} AND channel_id = ${channelId}
        AND external_order_id IN (${scope.numericOrderId}, ${scope.externalOrderId})
    `);
    return result.rowCount || 0;
  });
}

export async function countOmsOrdersMissingCustomerName(db: any): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*) as count FROM oms.oms_orders WHERE customer_name IS NULL
  `);
  return parseInt(result.rows[0]?.count || "0", 10);
}
