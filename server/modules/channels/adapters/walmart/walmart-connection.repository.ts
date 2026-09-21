import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import { walmartStatusSchema, type WalmartChannelStatus, type WalmartConnectInput } from "@shared/types/walmart-channel";
import type { FulfillmentProviderCredentialRecord } from "../../../shipping-engine/application/connected-fulfillment-method-catalog.service";
import { WalmartApiError } from "./walmart-client";
import { VARIANT_SALES_ELIGIBILITY_LOCK_NAMESPACE } from "@shared/catalog/variant-sales-eligibility";

const LOCK_NAMESPACE = 94122;
const positiveId = z.number().int().positive().max(2_147_483_647);
export interface WalmartConnectionRecord {
  channel_id: number; connection_id: number; partner_id: string; partner_name: string;
  channel_status: string;
  environment: "production" | "sandbox"; ship_node_id: string; warehouse_id: number;
  encrypted_credentials: FulfillmentProviderCredentialRecord; orders_enabled: boolean;
  import_since: Date; checkpoint_at: Date | null; last_poll_at: Date | null;
  last_success_at: Date | null; last_error_code: string | null; revision: number;
}
const rowSchema = z.object({
  channel_id: positiveId, connection_id: positiveId, partner_id: z.string().min(1), partner_name: z.string(),
  channel_status: z.string(),
  environment: z.enum(["production", "sandbox"]), ship_node_id: z.string().min(1), warehouse_id: positiveId,
  encrypted_credentials: z.object({ connectionId: positiveId, keyId: z.string(), ciphertext: z.string(), iv: z.string(), authTag: z.string() }),
  orders_enabled: z.boolean(), import_since: z.date(), checkpoint_at: z.date().nullable(),
  last_poll_at: z.date().nullable(), last_success_at: z.date().nullable(), last_error_code: z.string().nullable(), revision: positiveId,
});

export class WalmartConnectionRepository {
  constructor(readonly pool: Pick<Pool, "connect">) {}

  private async query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
    const client = await this.pool.connect();
    try { return await client.query<T>(sql, values); }
    finally { client.release(); }
  }

  async withLock<T>(channelId: number, action: () => Promise<T>): Promise<T> {
    positiveId.parse(channelId);
    const client = await this.pool.connect();
    let locked = false;
    try {
      locked = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [LOCK_NAMESPACE, channelId])).rows[0]?.locked === true;
      if (!locked) throw new WalmartApiError("WALMART_CHANNEL_BUSY", "Another operation is using this Walmart channel; retry shortly", true);
      return await action();
    } finally {
      if (locked) {
        try { await client.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_NAMESPACE, channelId]); }
        catch (error) {
          console.error(JSON.stringify({ code: "WALMART_LOCK_RELEASE_FAILED", channelId }));
          client.release(error instanceof Error ? error : new Error("Walmart lock release failed")); locked = false;
        }
        if (locked) client.release();
      } else client.release();
    }
  }

  async get(channelId: number): Promise<WalmartConnectionRecord | null> {
    positiveId.parse(channelId);
    const result = await this.query(`SELECT wc.*,c.status AS channel_status FROM channels.walmart_connections wc
      JOIN channels.channels c ON c.id = wc.channel_id AND c.provider = 'walmart'
      JOIN channels.channel_connections cc ON cc.id = wc.connection_id AND cc.channel_id = wc.channel_id
      WHERE wc.channel_id = $1`, [channelId]);
    if (result.rows.length === 0) return null;
    return rowSchema.parse(result.rows[0]);
  }

  async status(channelId: number): Promise<WalmartChannelStatus | null> {
    const row = await this.get(channelId);
    if (!row) return null;
    const count = await this.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM channels.channel_feeds
      WHERE channel_id = $1 AND is_active = 1 AND quarantined_at IS NULL`, [channelId]);
    return walmartStatusSchema.parse({ channelId, connectionId: row.connection_id, partnerId: row.partner_id,
      partnerName: row.partner_name, environment: row.environment, shipNodeId: row.ship_node_id,
      warehouseId: row.warehouse_id, ordersEnabled: row.orders_enabled && row.channel_status === "active", importSince: row.import_since.toISOString(),
      lastPollAt: row.last_poll_at?.toISOString() ?? null, lastSuccessAt: row.last_success_at?.toISOString() ?? null,
      lastErrorCode: row.last_error_code, revision: row.revision, mappedSkus: count.rows[0].count });
  }

  async save(input: WalmartConnectInput, channelId: number, partnerName: string, actor: string, now: Date,
    seal: (connectionId: number) => FulfillmentProviderCredentialRecord): Promise<void> {
    await this.transaction(async client => {
      const channel = await client.query("SELECT id,status FROM channels.channels WHERE id = $1 AND provider = 'walmart' FOR UPDATE", [channelId]);
      if (channel.rowCount !== 1) throw new WalmartApiError("WALMART_CHANNEL_INVALID", "Select a Walmart sales channel", false);
      const warehouse = await client.query("SELECT id FROM warehouse.warehouses WHERE id = $1 AND is_active = 1 AND warehouse_type <> '3pl' FOR SHARE", [input.warehouseId]);
      if (warehouse.rowCount !== 1) throw new WalmartApiError("WALMART_WAREHOUSE_INVALID", "Select an active Echelon warehouse", false);
      const existing = await client.query("SELECT * FROM channels.walmart_connections WHERE channel_id = $1 FOR UPDATE", [channelId]);
      const before = existing.rows[0] ? rowSchema.parse({ ...existing.rows[0], channel_status: channel.rows[0].status }) : null;
      if (before && (before.partner_id !== input.expectedPartnerId || before.environment !== input.environment
        || before.ship_node_id !== input.shipNodeId || before.warehouse_id !== input.warehouseId
        || before.import_since.getTime() !== new Date(input.importSince).getTime())) {
        throw new WalmartApiError("WALMART_CONNECTION_IDENTITY_CONFLICT", "An existing connection's account, environment, warehouse, ship node and import boundary cannot be replaced", false);
      }
      let connectionId = before?.connection_id;
      if (connectionId === undefined) {
        const stray = await client.query("SELECT id FROM channels.channel_connections WHERE channel_id = $1", [channelId]);
        if (stray.rowCount !== 0) throw new WalmartApiError("WALMART_CONNECTION_AMBIGUOUS", "This channel already has an unmanaged connection", false);
        const inserted = await client.query<{ id: number }>(`INSERT INTO channels.channel_connections
          (channel_id, api_version, sync_status, metadata, created_at, updated_at)
          VALUES ($1, '3.1', 'never', $2::jsonb, $3, $3) RETURNING id`,
        [channelId, JSON.stringify({ environment: input.environment, market: "us" }), now]);
        connectionId = inserted.rows[0].id;
      }
      const credential = seal(connectionId);
      await client.query(`INSERT INTO channels.walmart_connections
        (channel_id, connection_id, partner_id, partner_name, environment, ship_node_id, warehouse_id, encrypted_credentials, import_since, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$10)
        ON CONFLICT (channel_id) DO UPDATE SET encrypted_credentials = EXCLUDED.encrypted_credentials,
        partner_name = EXCLUDED.partner_name, revision = walmart_connections.revision + 1, updated_at = EXCLUDED.updated_at`,
      [channelId, connectionId, input.expectedPartnerId, partnerName, input.environment, input.shipNodeId, input.warehouseId,
        JSON.stringify(credential), input.importSince, now]);
      if (!before) {
        await client.query(`INSERT INTO channels.channel_warehouse_assignments (channel_id,warehouse_id,enabled,priority)
          VALUES ($1,$2,true,0) ON CONFLICT (channel_id,warehouse_id) DO UPDATE SET enabled = true`, [channelId, input.warehouseId]);
      }
      await this.event(client, channelId, actor, before ? "credentials_rotated" : "connected",
        before ? { partnerId: before.partner_id, revision: before.revision } : null,
        { partnerId: input.expectedPartnerId, environment: input.environment, shipNodeId: input.shipNodeId,
          warehouseId: input.warehouseId, revision: (before?.revision ?? 0) + 1 }, now);
    });
  }

  async control(channelId: number, enabled: boolean, revision: number, actor: string, now: Date): Promise<void> {
    await this.transaction(async client => {
      const before = await client.query("SELECT orders_enabled, revision FROM channels.walmart_connections WHERE channel_id = $1 FOR UPDATE", [channelId]);
      if (before.rows[0]?.revision !== revision) throw new WalmartApiError("WALMART_REVISION_CONFLICT", "Connection settings changed; reload before saving", false);
      await client.query("UPDATE channels.walmart_connections SET orders_enabled=$2, revision=revision+1, updated_at=$3 WHERE channel_id=$1", [channelId, enabled, now]);
      await client.query("UPDATE channels.channels SET status=$2, updated_at=$3 WHERE id=$1 AND provider='walmart'", [channelId, enabled ? "active" : "paused", now]);
      await this.event(client, channelId, actor, "order_intake_changed", { ordersEnabled: before.rows[0].orders_enabled }, { ordersEnabled: enabled }, now);
    });
  }

  async enabledChannels(): Promise<number[]> {
    const result = await this.query<{ channel_id: number }>(`SELECT wc.channel_id FROM channels.walmart_connections wc
      JOIN channels.channels c ON c.id = wc.channel_id WHERE wc.orders_enabled AND c.provider='walmart' AND c.status='active' ORDER BY wc.channel_id`);
    return result.rows.map(row => positiveId.parse(row.channel_id));
  }
  async assertWarehouse(row: WalmartConnectionRecord): Promise<void> {
    const result = await this.query<{ warehouse_id: number }>(`SELECT a.warehouse_id FROM channels.channel_warehouse_assignments a
      JOIN warehouse.warehouses w ON w.id=a.warehouse_id AND w.is_active=1
      WHERE a.channel_id=$1 AND a.enabled`, [row.channel_id]);
    if (result.rows.length !== 1 || result.rows[0].warehouse_id !== row.warehouse_id) {
      throw new WalmartApiError("WALMART_WAREHOUSE_SCOPE_CHANGED", "The channel must route to its explicitly configured warehouse", false);
    }
  }
  async resolveWarehouse(channelId: number): Promise<{ warehouseId: number; warehouseType: string } | null> {
    const result = await this.query(`SELECT c.provider,wc.warehouse_id,w.warehouse_type,w.is_active
      FROM channels.channels c LEFT JOIN channels.walmart_connections wc ON wc.channel_id=c.id
      LEFT JOIN warehouse.warehouses w ON w.id=wc.warehouse_id WHERE c.id=$1`, [channelId]);
    const row = result.rows[0];
    if (row?.provider !== "walmart") return null;
    if (row.is_active !== 1 || !row.warehouse_id || row.warehouse_type === "3pl") {
      throw new WalmartApiError("WALMART_WAREHOUSE_INVALID", "Walmart requires its configured active seller-operated warehouse", false);
    }
    return { warehouseId: positiveId.parse(row.warehouse_id), warehouseType: z.string().min(1).parse(row.warehouse_type) };
  }
  async exceptions(channelId: number) {
    const result = await this.query<{ purchase_order_id: string; error_code: string; observed_at: Date }>(`SELECT purchase_order_id,error_code,observed_at
      FROM channels.walmart_order_receipts WHERE channel_id=$1 AND status='failed' ORDER BY observed_at DESC,purchase_order_id LIMIT 50`, [channelId]);
    return result.rows.map(row => ({ purchaseOrderId: row.purchase_order_id, errorCode: row.error_code, observedAt: row.observed_at.toISOString() }));
  }
  async catalogSearch(query: string) {
    const term = z.string().trim().min(2).max(100).parse(query);
    const result = await this.query<{ id: number; sku: string; name: string }>(`SELECT id,sku,name FROM catalog.product_variants
      WHERE is_active=true AND COALESCE(sales_eligibility,'sellable')='sellable'
        AND requires_shipping IS DISTINCT FROM false AND track_inventory IS DISTINCT FROM false
        AND sku ILIKE $1 ORDER BY sku,id LIMIT 25`, [`%${term.replace(/[\\%_]/g, "\\$&")}%`]);
    return result.rows;
  }
  async mappings(channelId: number) {
    const result = await this.query<{ product_variant_id: number; channel_sku: string }>(`SELECT product_variant_id,channel_sku
      FROM channels.channel_feeds WHERE channel_id=$1 AND is_active=1 AND quarantined_at IS NULL ORDER BY product_variant_id`, [channelId]);
    return result.rows;
  }
  async linkSku(channelId: number, variantId: number, sku: string, actor: string, now: Date): Promise<void> {
    await this.transaction(async client => {
      const connection = await client.query("SELECT channel_id FROM channels.walmart_connections WHERE channel_id=$1 FOR UPDATE", [channelId]);
      if (connection.rowCount !== 1) throw new WalmartApiError("WALMART_CONNECTION_REQUIRED", "Connect the Walmart account first", false);
      await client.query("SELECT pg_advisory_xact_lock($1,$2)", [VARIANT_SALES_ELIGIBILITY_LOCK_NAMESPACE, variantId]);
      const variant = await client.query(`SELECT id FROM catalog.product_variants WHERE id=$1 AND is_active=true
        AND COALESCE(sales_eligibility,'sellable')='sellable' AND requires_shipping IS DISTINCT FROM false
        AND track_inventory IS DISTINCT FROM false FOR SHARE`, [variantId]);
      if (variant.rowCount !== 1) throw new WalmartApiError("WALMART_VARIANT_INVALID", "Select an active Echelon variant", false);
      const prior = await client.query(`SELECT product_variant_id,channel_sku,is_active,quarantined_at FROM channels.channel_feeds
        WHERE channel_id=$1 AND (product_variant_id=$2 OR channel_sku=$3) FOR UPDATE`, [channelId, variantId, sku]);
      if (prior.rows.some(row => row.product_variant_id !== variantId || row.channel_sku !== sku)) {
        throw new WalmartApiError("WALMART_MAPPING_CONFLICT", "The SKU or variant is already linked to another identity", false);
      }
      if (prior.rows.length) {
        if (prior.rows[0].is_active !== 1 || prior.rows[0].quarantined_at !== null) {
          throw new WalmartApiError("WALMART_MAPPING_INACTIVE", "This existing mapping is disabled or quarantined and needs reviewed repair", false);
        }
        return;
      }
      await client.query(`INSERT INTO channels.channel_feeds (channel_id,product_variant_id,channel_type,channel_variant_id,
        channel_sku,channel_inventory_item_id,is_active,created_at,updated_at) VALUES ($1,$2,'walmart',$3,$3,$3,1,$4,$4)`, [channelId, variantId, sku, now]);
      await this.event(client, channelId, actor, "sku_linked", null, { variantId, sku }, now);
    });
  }
  async markPoll(channelId: number, now: Date, outcome: { checkpoint?: Date; errorCode?: string } = {}): Promise<void> {
    await this.query(`UPDATE channels.walmart_connections SET last_poll_at=$2,
      checkpoint_at=COALESCE($3,checkpoint_at), last_success_at=CASE WHEN $3::timestamptz IS NOT NULL THEN $2 ELSE last_success_at END,
      last_error_code=$4, updated_at=$2 WHERE channel_id=$1`, [channelId, now, outcome.checkpoint ?? null, outcome.errorCode ?? null]);
  }
  async receipt(channelId: number, purchaseOrderId: string): Promise<{ source_hash: string; status: string; oms_order_id: number | null } | null> {
    const row = (await this.query<{ source_hash: string; status: string; oms_order_id: string | null }>(`SELECT source_hash,status,oms_order_id
      FROM channels.walmart_order_receipts WHERE channel_id=$1 AND purchase_order_id=$2`, [channelId, purchaseOrderId])).rows[0];
    return row ? { ...row, oms_order_id: row.oms_order_id === null ? null : z.coerce.number().int().positive().safe().parse(row.oms_order_id) } : null;
  }
  async recordReceipt(channelId: number, purchaseOrderId: string, hash: string, status: "processing" | "completed" | "failed" | "ignored",
    orderId: number | null, errorCode: string | null, now: Date): Promise<void> {
    await this.query(`INSERT INTO channels.walmart_order_receipts (channel_id,purchase_order_id,source_hash,status,oms_order_id,error_code,observed_at,completed_at)
      VALUES ($1,$2,$3,$4::varchar,$5,$6,$7,CASE WHEN $4::varchar='completed' THEN $7::timestamptz ELSE NULL END)
      ON CONFLICT (channel_id,purchase_order_id) DO UPDATE SET source_hash=EXCLUDED.source_hash,status=EXCLUDED.status,
      oms_order_id=COALESCE(EXCLUDED.oms_order_id,walmart_order_receipts.oms_order_id),error_code=EXCLUDED.error_code,
      observed_at=EXCLUDED.observed_at,completed_at=EXCLUDED.completed_at`, [channelId, purchaseOrderId, hash, status, orderId, errorCode, now]);
  }
  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await action(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  private async event(client: PoolClient, channelId: number, actor: string, type: string, before: unknown, after: unknown, now: Date) {
    z.string().trim().min(1).parse(actor);
    await client.query(`INSERT INTO channels.walmart_connection_events (channel_id,actor,event_type,before_state,after_state,occurred_at)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`, [channelId, actor, type, JSON.stringify(before), JSON.stringify(after), now]);
  }
}
