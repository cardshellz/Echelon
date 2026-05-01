import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  CreateDropshipShippingQuoteSnapshotInput,
  DropshipInsurancePoolPolicy,
  DropshipShippingMarkupPolicy,
  DropshipShippingQuoteRepository,
  DropshipShippingQuoteSnapshotRecord,
  DropshipShippingStoreContext,
} from "../application/dropship-shipping-quote-service";
import { DropshipError } from "../domain/errors";

interface StoreContextRow {
  vendor_id: number;
  vendor_status: DropshipShippingStoreContext["vendorStatus"];
  entitlement_status: string;
  store_connection_id: number;
  store_status: DropshipShippingStoreContext["storeStatus"];
  platform: string;
}

interface ShippingMarkupPolicyRow {
  id: number;
  markup_bps: number;
  fixed_markup_cents: string | number;
  min_markup_cents: string | number | null;
  max_markup_cents: string | number | null;
}

interface InsurancePoolPolicyRow {
  id: number;
  fee_bps: number;
  min_fee_cents: string | number | null;
  max_fee_cents: string | number | null;
}

interface QuoteSnapshotRow {
  id: number;
  vendor_id: number;
  store_connection_id: number | null;
  warehouse_id: number;
  rate_table_id: number | null;
  destination_country: string;
  destination_postal_code: string | null;
  currency: string;
  idempotency_key: string | null;
  request_hash: string | null;
  package_count: number;
  base_rate_cents: string | number;
  markup_cents: string | number;
  insurance_pool_cents: string | number;
  dunnage_cents: string | number;
  total_shipping_cents: string | number;
  quote_payload: Record<string, unknown>;
  created_at: Date;
}

export class PgDropshipShippingQuoteRepository implements DropshipShippingQuoteRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async findQuoteSnapshotByIdempotencyKey(input: {
    vendorId: number;
    idempotencyKey: string;
  }): Promise<DropshipShippingQuoteSnapshotRecord | null> {
    const client = await this.dbPool.connect();
    try {
      return findQuoteSnapshotByIdempotencyKeyWithClient(client, input);
    } finally {
      client.release();
    }
  }

  async loadStoreContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipShippingStoreContext | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<StoreContextRow>(
        `SELECT
           v.id AS vendor_id,
           v.status AS vendor_status,
           v.entitlement_status,
           sc.id AS store_connection_id,
           sc.status AS store_status,
           sc.platform
         FROM dropship.dropship_vendors v
         INNER JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
         WHERE v.id = $1
           AND sc.id = $2
         LIMIT 1`,
        [input.vendorId, input.storeConnectionId],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      if (row.platform !== "ebay" && row.platform !== "shopify") {
        throw new DropshipError(
          "DROPSHIP_SHIPPING_UNSUPPORTED_PLATFORM",
          "Dropship shipping quote only supports launch marketplace platforms.",
          { platform: row.platform },
        );
      }
      return {
        vendorId: row.vendor_id,
        vendorStatus: row.vendor_status,
        entitlementStatus: row.entitlement_status,
        storeConnectionId: row.store_connection_id,
        storeStatus: row.store_status,
        platform: row.platform,
      };
    } finally {
      client.release();
    }
  }

  async getActiveShippingMarkupPolicy(quotedAt: Date): Promise<DropshipShippingMarkupPolicy | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<ShippingMarkupPolicyRow>(
        `SELECT id, markup_bps, fixed_markup_cents, min_markup_cents, max_markup_cents
         FROM dropship.dropship_shipping_markup_config
         WHERE is_active = true
           AND effective_from <= $1
           AND (effective_to IS NULL OR effective_to > $1)
         ORDER BY effective_from DESC, id DESC
         LIMIT 1`,
        [quotedAt],
      );
      const row = result.rows[0];
      return row ? {
        id: row.id,
        source: "config",
        markupBps: row.markup_bps,
        fixedMarkupCents: Number(row.fixed_markup_cents),
        minMarkupCents: row.min_markup_cents === null ? null : Number(row.min_markup_cents),
        maxMarkupCents: row.max_markup_cents === null ? null : Number(row.max_markup_cents),
      } : null;
    } finally {
      client.release();
    }
  }

  async getActiveInsurancePoolPolicy(quotedAt: Date): Promise<DropshipInsurancePoolPolicy | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<InsurancePoolPolicyRow>(
        `SELECT id, fee_bps, min_fee_cents, max_fee_cents
         FROM dropship.dropship_insurance_pool_config
         WHERE is_active = true
           AND effective_from <= $1
           AND (effective_to IS NULL OR effective_to > $1)
         ORDER BY effective_from DESC, id DESC
         LIMIT 1`,
        [quotedAt],
      );
      const row = result.rows[0];
      return row ? {
        id: row.id,
        source: "config",
        feeBps: row.fee_bps,
        minFeeCents: row.min_fee_cents === null ? null : Number(row.min_fee_cents),
        maxFeeCents: row.max_fee_cents === null ? null : Number(row.max_fee_cents),
      } : null;
    } finally {
      client.release();
    }
  }

  async createQuoteSnapshot(
    input: CreateDropshipShippingQuoteSnapshotInput,
  ): Promise<DropshipShippingQuoteSnapshotRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");

      const replay = await findQuoteSnapshotByIdempotencyKeyWithClient(client, {
        vendorId: input.vendorId,
        idempotencyKey: input.idempotencyKey,
        forUpdate: true,
      });
      if (replay) {
        if (replay.requestHash !== input.requestHash) {
          throw new DropshipError(
            "DROPSHIP_IDEMPOTENCY_CONFLICT",
            "Dropship shipping quote idempotency key was reused with a different request.",
            { vendorId: input.vendorId },
          );
        }
        await client.query("COMMIT");
        return replay;
      }

      const inserted = await client.query<QuoteSnapshotRow>(
        `INSERT INTO dropship.dropship_shipping_quote_snapshots
          (vendor_id, store_connection_id, warehouse_id, rate_table_id,
           destination_country, destination_postal_code, currency,
           idempotency_key, request_hash, package_count, base_rate_cents,
           markup_cents, insurance_pool_cents, dunnage_cents, total_shipping_cents,
           quote_payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13, $14, $15, $16::jsonb, $17)
         RETURNING id, vendor_id, store_connection_id, warehouse_id, rate_table_id,
                   destination_country, destination_postal_code, currency,
                   idempotency_key, request_hash, package_count, base_rate_cents,
                   markup_cents, insurance_pool_cents, dunnage_cents,
                   total_shipping_cents, quote_payload, created_at`,
        [
          input.vendorId,
          input.storeConnectionId,
          input.warehouseId,
          input.rateTableId,
          input.destination.country,
          input.destination.postalCode,
          input.currency,
          input.idempotencyKey,
          input.requestHash,
          input.packageCount,
          input.baseRateCents,
          input.markupCents,
          input.insurancePoolCents,
          input.dunnageCents,
          input.totalShippingCents,
          JSON.stringify(input.quotePayload),
          input.createdAt,
        ],
      );
      const snapshot = mapQuoteSnapshotRow(requiredRow(
        inserted.rows[0],
        "Dropship shipping quote insert did not return a row.",
      ));

      await recordQuoteAuditEvent(client, input, snapshot);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        const replay = await this.findQuoteSnapshotByIdempotencyKey({
          vendorId: input.vendorId,
          idempotencyKey: input.idempotencyKey,
        });
        if (replay && replay.requestHash === input.requestHash) {
          return replay;
        }
        if (replay) {
          throw new DropshipError(
            "DROPSHIP_IDEMPOTENCY_CONFLICT",
            "Dropship shipping quote idempotency key was reused with a different request.",
            { vendorId: input.vendorId },
          );
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

async function findQuoteSnapshotByIdempotencyKeyWithClient(
  client: PoolClient,
  input: {
    vendorId: number;
    idempotencyKey: string;
    forUpdate?: boolean;
  },
): Promise<DropshipShippingQuoteSnapshotRecord | null> {
  const result = await client.query<QuoteSnapshotRow>(
    `SELECT id, vendor_id, store_connection_id, warehouse_id, rate_table_id,
            destination_country, destination_postal_code, currency,
            idempotency_key, request_hash, package_count, base_rate_cents,
            markup_cents, insurance_pool_cents, dunnage_cents,
            total_shipping_cents, quote_payload, created_at
     FROM dropship.dropship_shipping_quote_snapshots
     WHERE vendor_id = $1
       AND idempotency_key = $2
     LIMIT 1
     ${input.forUpdate ? "FOR UPDATE" : ""}`,
    [input.vendorId, input.idempotencyKey],
  );
  const row = result.rows[0];
  return row ? mapQuoteSnapshotRow(row) : null;
}

async function recordQuoteAuditEvent(
  client: PoolClient,
  input: CreateDropshipShippingQuoteSnapshotInput,
  snapshot: DropshipShippingQuoteSnapshotRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_shipping_quote_snapshot', $3, 'shipping_quote_created',
             $4, $5, 'info', $6::jsonb, $7)`,
    [
      input.vendorId,
      input.storeConnectionId,
      String(snapshot.quoteSnapshotId),
      input.actor.actorType,
      input.actor.actorId ?? null,
      JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        warehouseId: input.warehouseId,
        packageCount: input.packageCount,
        totalShippingCents: input.totalShippingCents,
        currency: input.currency,
      }),
      input.createdAt,
    ],
  );
}

function mapQuoteSnapshotRow(row: QuoteSnapshotRow): DropshipShippingQuoteSnapshotRecord {
  return {
    quoteSnapshotId: row.id,
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    warehouseId: row.warehouse_id,
    rateTableId: row.rate_table_id,
    destinationCountry: row.destination_country,
    destinationPostalCode: row.destination_postal_code,
    currency: row.currency,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    packageCount: row.package_count,
    baseRateCents: Number(row.base_rate_cents),
    markupCents: Number(row.markup_cents),
    insurancePoolCents: Number(row.insurance_pool_cents),
    dunnageCents: Number(row.dunnage_cents),
    totalShippingCents: Number(row.total_shipping_cents),
    quotePayload: row.quote_payload,
    createdAt: row.created_at,
  };
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
