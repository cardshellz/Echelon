import type { Pool } from "pg";
import { z } from "zod";
import { customerAccountOrderSummariesInputSchema } from "@shared/customer-account/customer-account-orders";
import { customerOrderActionReferenceKey, customerOrderActionPageSchema, customerOrderActionsSchema, customerOrderActionSnapshotSchema, type CustomerOrderActionSnapshot } from "@shared/customer-account/order-actions";
import { orderActionScopeSchema, orderActionMaintenanceIdsSchema, type OrderActionScope, type OrderActionProjectionStore } from "../application/order-action-projection.ports";
import { logger } from "../../../platform/observability/logger";

const LEASE_MS = 5 * 60_000;
const principalSchema = z.object({ channelId: z.number().int().positive().safe(), externalCustomerId: z.string().regex(/^[1-9][0-9]*$/).max(30) });
const resultRowSchema = z.object({
  externalOrderId: z.string(), orderReference: z.string(), omsOrderId: z.coerce.number().int().positive().safe(),
  snapshot: z.unknown().nullable(), current: z.boolean(), failed: z.boolean(),
  verifiedAt: z.coerce.date().nullable(), validUntil: z.coerce.date().nullable(),
});

/** The customer read is a bounded local lookup. It cannot enqueue work or call
 * a provider. Ownership is checked against current OMS, not the cached document. */
export class PostgresOrderActionProjectionStore implements OrderActionProjectionStore {
  private readonly shopDomains: readonly string[];
  private readonly maintenanceIds: readonly number[] | null;
  constructor(private readonly pool: Pick<Pool, "query">, shopDomains: readonly string[] = [], maintenanceIds?: readonly number[]) {
    this.shopDomains = Object.freeze(z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)).max(20).parse(shopDomains));
    this.maintenanceIds = maintenanceIds === undefined ? null : Object.freeze(orderActionMaintenanceIdsSchema.parse(maintenanceIds));
  }

  async read(raw: Parameters<OrderActionProjectionStore["read"]>[0], now: Date) {
    const { channelId, externalCustomerId } = principalSchema.parse(raw);
    const input = customerAccountOrderSummariesInputSchema.parse({ orders: raw.orders });
    z.date().parse(now);
    const ids = input.orders.map(order => order.externalOrderId);
    const result = await this.pool.query(`SELECT replace(o.external_order_id,'gid://shopify/Order/','') AS "externalOrderId",
      o.external_order_number AS "orderReference",o.id AS "omsOrderId",p.snapshot,
      COALESCE(p.computed_generation=p.generation AND p.valid_until>$4 AND p.verified_at<=$4
        AND NOT EXISTS(SELECT 1 FROM oms.customer_order_action_invalidations dirty WHERE dirty.oms_order_id=o.id),false) AS current,
      COALESCE(p.last_error_code IS NOT NULL,false) AS failed,p.verified_at AS "verifiedAt",p.valid_until AS "validUntil"
      FROM oms.oms_orders o LEFT JOIN oms.customer_order_actions p ON p.oms_order_id=o.id
      WHERE o.channel_id=$1 AND o.external_customer_id=$2
      AND (o.external_order_id=ANY($3::text[]) OR o.external_order_id=ANY($5::text[]))`,
    [channelId, externalCustomerId, ids, now, ids.map(id => `gid://shopify/Order/${id}`)]);
    const rows = z.array(resultRowSchema).max(ids.length * 2).parse(result.rows);
    return customerOrderActionPageSchema.parse({ orders: input.orders.map(identity => {
      const matches = rows.filter(row => row.externalOrderId === identity.externalOrderId
        && customerOrderActionReferenceKey(row.orderReference) === customerOrderActionReferenceKey(identity.orderReference));
      // Ambiguous and foreign orders never acquire capabilities through a cache.
      const row = matches.length === 1 ? matches[0] : null;
      const value = { ...identity, omsOrderId: row?.omsOrderId ?? null,
        state: !row ? "not_managed" : row.current && row.snapshot ? "ready" : row.failed ? "failed" : "refreshing",
        snapshot: row?.current && row.snapshot ? row.snapshot : null,
        verifiedAt: row?.verifiedAt?.toISOString() ?? null, validUntil: row?.validUntil?.toISOString() ?? null };
      const parsed = customerOrderActionsSchema.safeParse(value);
      if (parsed.success) return parsed.data;
      logger.error("customer_order_action_lookup", { outcome: "invalid", omsOrderId: row?.omsOrderId,
        error_code: "ORDER_ACTION_PROJECTION_INVALID" });
      return { ...value, state: "failed", snapshot: null };
    }) });
  }

  async drainInvalidations(limit: number): Promise<number> {
    z.number().int().min(1).max(1_000).parse(limit);
    // Source transactions only append events. Coalescing/locking a derived row
    // belongs to this worker, so source writes cannot deadlock on cache updates.
    const result = await this.pool.query(`WITH pending AS MATERIALIZED (
      SELECT id,oms_order_id FROM oms.customer_order_action_invalidations ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
    ), refreshed AS (
      INSERT INTO oms.customer_order_actions(oms_order_id)
      SELECT DISTINCT o.id FROM pending dirty JOIN oms.oms_orders o ON o.id=dirty.oms_order_id
      JOIN channels.channels c ON c.id=o.channel_id WHERE c.provider='shopify' AND o.external_customer_id ~ '^[1-9][0-9]*$'
      AND EXISTS(SELECT 1 FROM channels.channel_connections cc WHERE cc.channel_id=c.id AND cc.shop_domain=ANY($2::text[]))
      ORDER BY o.id ON CONFLICT(oms_order_id) DO UPDATE SET
        generation=oms.customer_order_actions.generation+1,next_refresh_at='-infinity',attempts=0,last_error_code=NULL,last_error_class=NULL
      RETURNING oms_order_id
    ) DELETE FROM oms.customer_order_action_invalidations WHERE id IN (SELECT id FROM pending)
      AND (SELECT count(*) FROM refreshed)>=0`, [limit, this.shopDomains]);
    return result.rowCount ?? 0;
  }

  async seed(limit: number): Promise<number> {
    z.number().int().min(1).max(200).parse(limit);
    const result = await this.pool.query(`INSERT INTO oms.customer_order_actions(oms_order_id)
      SELECT o.id FROM oms.oms_orders o JOIN channels.channels c ON c.id=o.channel_id
      WHERE c.provider='shopify' AND c.status='active' AND o.external_customer_id ~ '^[1-9][0-9]*$'
      AND EXISTS(SELECT 1 FROM channels.channel_connections cc WHERE cc.channel_id=c.id AND cc.shop_domain=ANY($2::text[]))
      AND ($3::bigint[] IS NULL OR o.id=ANY($3::bigint[]))
      AND NOT EXISTS(SELECT 1 FROM oms.customer_order_actions p WHERE p.oms_order_id=o.id)
      ORDER BY o.id DESC LIMIT $1 ON CONFLICT DO NOTHING`, [limit, this.shopDomains, this.maintenanceIds]);
    return result.rowCount ?? 0;
  }

  async claim(limit: number, now: Date, leaseId: string): Promise<OrderActionScope[]> {
    z.number().int().min(1).max(10).parse(limit); z.date().parse(now); z.string().uuid().parse(leaseId);
    const result = await this.pool.query(`WITH pending AS (
      SELECT p.oms_order_id,cc.id AS connection_id FROM oms.customer_order_actions p
      JOIN oms.oms_orders o ON o.id=p.oms_order_id JOIN channels.channels c ON c.id=o.channel_id
      JOIN channels.channel_connections cc ON cc.channel_id=c.id AND cc.shop_domain IS NOT NULL
      WHERE c.provider='shopify' AND c.status='active' AND o.external_customer_id ~ '^[1-9][0-9]*$'
      AND cc.shop_domain=ANY($5::text[])
      AND ($6::bigint[] IS NULL OR o.id=ANY($6::bigint[]))
      AND o.external_order_id ~ '^(gid://shopify/Order/)?[1-9][0-9]*$'
      AND o.external_order_number IS NOT NULL AND p.next_refresh_at<=$2
      AND (p.lease_until IS NULL OR p.lease_until<=$2)
      AND NOT EXISTS(SELECT 1 FROM oms.customer_order_action_invalidations dirty WHERE dirty.oms_order_id=o.id)
      AND (SELECT count(*) FROM channels.channel_connections sibling WHERE sibling.channel_id=c.id AND sibling.shop_domain IS NOT NULL)=1
      -- Keep published evidence fresh while initial history is being populated.
      -- New rows start at -infinity; ordering only by due time would starve every
      -- already-built panel until the entire historical backlog had completed.
      ORDER BY (p.verified_at IS NOT NULL) DESC,p.next_refresh_at,p.oms_order_id DESC LIMIT $1 FOR UPDATE OF p SKIP LOCKED
    ), leased AS (UPDATE oms.customer_order_actions p SET lease_id=$3,lease_until=$4
      FROM pending WHERE pending.oms_order_id=p.oms_order_id
      RETURNING p.*,pending.connection_id)
    SELECT p.oms_order_id AS "omsOrderId",o.channel_id AS "channelId",p.connection_id AS "connectionId",
      replace(o.external_order_id,'gid://shopify/Order/','') AS "externalOrderId",o.external_customer_id AS "externalCustomerId",
      o.external_order_number AS "orderReference",p.generation::text AS generation,p.lease_id::text AS "leaseId",p.attempts
      FROM leased p JOIN oms.oms_orders o ON o.id=p.oms_order_id`, [limit, now, leaseId, new Date(now.getTime() + LEASE_MS), this.shopDomains, this.maintenanceIds]);
    return z.array(orderActionScopeSchema.extend({ omsOrderId: z.coerce.number().int().positive().safe() })).max(limit).parse(result.rows);
  }

  async complete(raw: OrderActionScope, snapshot: CustomerOrderActionSnapshot, now: Date, validUntil: Date,
    failureClass?: "permanent" | "transient"): Promise<boolean> {
    const scope = orderActionScopeSchema.parse(raw); const value = customerOrderActionSnapshotSchema.parse(snapshot);
    z.date().parse(now); z.date().min(now).parse(validUntil);
    customerOrderActionsSchema.parse({ externalOrderId: scope.externalOrderId, orderReference: scope.orderReference,
      omsOrderId: scope.omsOrderId, state: "ready", verifiedAt: now.toISOString(), validUntil: validUntil.toISOString(), snapshot: value });
    if (value.order && value.order.connectionId !== scope.connectionId) throw new Error("ORDER_ACTION_CONNECTION_MISMATCH");
    const failed = value.orderFailed || value.returnFailed;
    const classification = failed ? z.enum(["permanent", "transient"]).parse(failureClass ?? "transient") : null;
    const result = await this.pool.query(`UPDATE oms.customer_order_actions p SET
      snapshot=$4::jsonb,computed_generation=generation,verified_at=$5,valid_until=$6,
      next_refresh_at=CASE WHEN $11::text='permanent' OR ($11::text='transient' AND attempts>=4) THEN 'infinity'::timestamptz ELSE $6 END,
      lease_id=NULL,lease_until=NULL,attempts=CASE WHEN $11::text IS NULL THEN 0 ELSE LEAST(attempts+1,30) END,
      last_error_code=CASE WHEN $11::text IS NULL THEN NULL ELSE 'ORDER_ACTION_PARTIAL_INSPECTION_FAILED' END,
      last_error_class=CASE WHEN $11::text='transient' AND attempts>=4 THEN 'permanent' ELSE $11::text END
      WHERE oms_order_id=$1 AND generation=$2::bigint AND lease_id=$3 AND lease_until>$5
      AND NOT EXISTS(SELECT 1 FROM oms.customer_order_action_invalidations dirty WHERE dirty.oms_order_id=p.oms_order_id)
      AND EXISTS(SELECT 1 FROM oms.oms_orders o WHERE o.id=p.oms_order_id AND o.channel_id=$7
        AND o.external_customer_id=$8 AND o.external_order_id IN ($9,$10))`,
    [scope.omsOrderId, scope.generation, scope.leaseId, JSON.stringify(value), now, validUntil, scope.channelId,
      scope.externalCustomerId, scope.externalOrderId, `gid://shopify/Order/${scope.externalOrderId}`, classification]);
    if (!result.rowCount) await this.pool.query(`UPDATE oms.customer_order_actions SET lease_id=NULL,lease_until=NULL
      WHERE oms_order_id=$1 AND lease_id=$2`, [scope.omsOrderId, scope.leaseId]);
    return result.rowCount === 1;
  }

  async fail(raw: OrderActionScope, now: Date, retryAt: Date, code: string): Promise<void> {
    const scope = orderActionScopeSchema.parse(raw); z.date().parse(now); z.date().min(now).parse(retryAt);
    z.literal("ORDER_ACTION_INSPECTION_FAILED").parse(code);
    await this.pool.query(`UPDATE oms.customer_order_actions SET lease_id=NULL,lease_until=NULL,
      attempts=CASE WHEN generation=$2::bigint THEN LEAST(attempts+1,30) ELSE 0 END,
      last_error_code=CASE WHEN generation=$2::bigint THEN $4 ELSE NULL END,
      last_error_class=CASE WHEN generation<>$2::bigint THEN NULL WHEN attempts>=4 THEN 'permanent' ELSE 'transient' END,
      next_refresh_at=CASE WHEN generation<>$2::bigint THEN next_refresh_at WHEN attempts>=4 THEN 'infinity'::timestamptz ELSE $5 END
      WHERE oms_order_id=$1 AND lease_id=$3`, [scope.omsOrderId, scope.generation, scope.leaseId, code, retryAt]);
  }
}
