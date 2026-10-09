import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import type { ServiceRegistry } from "../../services";
import { OrderEditService } from "./application/order-edit.service";
import { PostgresOrderEditStore } from "./infrastructure/postgres-order-edit.store";
import { ShopifyOrderEditProvider } from "./infrastructure/shopify-order-edit.provider";
import { OrderEditWarehouseGateway } from "./infrastructure/order-edit-warehouse.gateway";
import { OrderEditOmsSynchronizer } from "./infrastructure/order-edit-oms-synchronizer";
import { OrderEditPaidProjection } from "../oms/order-edit-paid-projection";
import { OrderEditPreviewService } from "./application/order-edit-preview.service";
import { createMemberPlanPresentationReader } from "../membership";

const credentialSchema = z.object({
  connectionId: z.number().int().positive(),
  channelId: z.number().int().positive(),
  shopDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
  accessToken: z.string().min(1),
});

export function createOrderEditService(
  pool: Pool,
  services: Pick<ServiceRegistry, "shipStation" | "wmsSync" | "reservation">,
): OrderEditService {
  const clock = () => new Date();
  const provider = new ShopifyOrderEditProvider({
    clock,
    memberPresentation: createMemberPlanPresentationReader(pool),
    report: (event) =>
      console.error(
        JSON.stringify({
          event: "order_edit_quote_preflight_failure",
          ...event,
        }),
      ),
    credentials: {
      async get(connectionId) {
        const rows = (
          await pool.query(
            `SELECT cc.id AS "connectionId",cc.channel_id AS "channelId",cc.shop_domain AS "shopDomain",cc.access_token AS "accessToken"
        FROM channels.channel_connections cc JOIN channels.channels c ON c.id=cc.channel_id
        WHERE cc.id=$1 AND c.provider='shopify' AND c.status='active' AND (cc.expires_at IS NULL OR cc.expires_at>$2)`,
            [connectionId, clock()],
          )
        ).rows;
        if (rows.length !== 1) return null;
        return credentialSchema.parse(rows[0]);
      },
    },
  });
  const paidProjection = new OrderEditPaidProjection(pool, clock);
  const synchronize = new OrderEditOmsSynchronizer(
    pool,
    services.wmsSync,
    services.reservation,
    (orderId, operationId, snapshot) =>
      paidProjection.project(orderId, operationId, snapshot),
  );
  const store = new PostgresOrderEditStore(pool);
  const warehouse = new OrderEditWarehouseGateway(
    pool,
    services.shipStation,
    (id, snapshot, operationId) =>
      synchronize.synchronize(id, snapshot, operationId),
  );
  return new OrderEditService(
    store,
    provider,
    warehouse,
    clock,
    randomUUID,
    (event) =>
      console.error(
        JSON.stringify({ event: "order_edit_requires_attention", ...event }),
      ),
    new OrderEditPreviewService(store, provider, warehouse, clock),
    provider.catalog,
  );
}
