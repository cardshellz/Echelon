import type { Pool } from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { wmsOmsOrderIdSql } from "../../oms/oms-wms-order-link.sql";
import type { CustomerAccountOrderContextReader, CustomerAccountOrderContext } from "../application/customer-account-order-queries.service";
import { CUSTOMER_ACCOUNT_ORDER_PAGE_SIZE } from "@shared/customer-account/customer-account-orders";
import { OrderEditError } from "../../order-edits/domain/order-edit-error";

const id = z.number().int().positive().safe();
const inputSchema = z
  .object({
    channelId: id,
    externalCustomerId: z.string().regex(/^[1-9]\d*$/),
    externalOrderIds: z
      .array(z.string().regex(/^[1-9]\d*$/))
      .min(1)
      .max(CUSTOMER_ACCOUNT_ORDER_PAGE_SIZE),
  })
  .strict();
const rowSchema = z
  .object({
    externalOrderId: z.string(),
    omsOrderId: z.coerce.number().int().positive().safe(),
    warehouseStatuses: z.array(z.string()),
    held: z.boolean(),
  })
  .strict();
const binding = new PgDialect().sqlToQuery(
  wmsOmsOrderIdSql({
    source: sql.raw("wo.source"),
    omsFulfillmentOrderId: sql.raw("wo.oms_fulfillment_order_id"),
    legacySourceTableId: sql.raw("wo.source_table_id"),
  }),
).sql;

export class PostgresCustomerAccountOrderContextReader
  implements CustomerAccountOrderContextReader
{
  constructor(private readonly pool: Pick<Pool, "query">) {}
  async read(raw: Parameters<CustomerAccountOrderContextReader["read"]>[0]): Promise<CustomerAccountOrderContext[]> {
    const input = inputSchema.parse(raw);
    try {
      const result = await this.pool.query(
        `SELECT replace(o.external_order_id,'gid://shopify/Order/','') AS "externalOrderId",o.id AS "omsOrderId",
        COALESCE(array_agg(wo.warehouse_status ORDER BY wo.id) FILTER (WHERE wo.id IS NOT NULL),ARRAY[]::text[]) AS "warehouseStatuses",
        COALESCE(bool_or(wo.on_hold<>0 OR wo.order_edit_operation_id IS NOT NULL),false) AS held
        FROM oms.oms_orders o LEFT JOIN wms.orders wo ON ${binding}=o.id AND wo.channel_id=o.channel_id
        WHERE o.channel_id=$1 AND o.external_customer_id=$2 AND (o.external_order_id=ANY($3::text[]) OR o.external_order_id=ANY($4::text[]))
        GROUP BY o.id,o.external_order_id ORDER BY o.id`,
        [
          input.channelId,
          input.externalCustomerId,
          input.externalOrderIds,
          input.externalOrderIds.map((id) => `gid://shopify/Order/${id}`),
        ],
      );
      // Numeric native IDs and legacy Shopify GIDs are the two stored forms.
      return z
        .array(rowSchema)
        .max(CUSTOMER_ACCOUNT_ORDER_PAGE_SIZE * 2)
        .parse(result.rows);
    } catch (cause) {
      const error = new OrderEditError(
        "CUSTOMER_ACCOUNT_STATUS_UNAVAILABLE",
        "Order status could not be loaded. Please try again.",
        503,
      );
      error.cause = cause;
      throw error;
    }
  }
}
