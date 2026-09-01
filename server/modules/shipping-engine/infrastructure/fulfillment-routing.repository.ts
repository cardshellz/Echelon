import type { Pool, PoolClient } from "pg";
import type {
  ShippingFulfillmentRouteMethod,
  ShippingFulfillmentRoutingServiceLevel,
} from "@shared/types/shipping-fulfillment-routing";
import { pool as defaultPool } from "../../../db";
import {
  FulfillmentRoutingError,
  type CreateFulfillmentRoutingRevisionInput,
  type FulfillmentRoutingProfileState,
  type FulfillmentRoutingRevisionIdentity,
  type FulfillmentRoutingStore,
  type FulfillmentRoutingTransaction,
} from "../application/fulfillment-routing.service";

interface ServiceLevelRow {
  id: number;
  code: string;
  display_name: string;
  fulfillment_mode: string;
  is_active: boolean;
}

interface ProfileRow {
  service_level_id: number;
  revision: number;
  current_revision_id: string | number | null;
  updated_by: string | null;
  updated_at: Date;
}

interface MethodRow {
  provider: string;
  provider_account_id: string | null;
  provider_account_name: string | null;
  carrier: string;
  carrier_name: string | null;
  service_code: string;
  service_name: string | null;
  priority: number;
  domestic: boolean;
  international: boolean;
  revision_id: string | number | null;
  is_active: boolean;
}

interface RevisionRow {
  id: string | number;
  service_level_id: number;
  revision: number;
  request_hash: string;
}

export class PostgresFulfillmentRoutingStore implements FulfillmentRoutingStore {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async getServiceLevel(
    serviceLevelId: number,
  ): Promise<ShippingFulfillmentRoutingServiceLevel | null> {
    const result = await this.dbPool.query<ServiceLevelRow>(
      `SELECT id, code, display_name, fulfillment_mode, is_active
       FROM shipping.service_levels
       WHERE id = $1
       LIMIT 1`,
      [serviceLevelId],
    );
    return result.rows[0] ? mapServiceLevel(result.rows[0]) : null;
  }

  async getProfile(serviceLevelId: number): Promise<FulfillmentRoutingProfileState> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const profile = await loadProfile(client, serviceLevelId, false);
      await client.query("COMMIT");
      return profile;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async transaction<T>(
    work: (tx: FulfillmentRoutingTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new PostgresFulfillmentRoutingTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

class PostgresFulfillmentRoutingTransaction
implements FulfillmentRoutingTransaction {
  constructor(private readonly client: PoolClient) {}

  async getServiceLevelForUpdate(
    serviceLevelId: number,
  ): Promise<ShippingFulfillmentRoutingServiceLevel | null> {
    const result = await this.client.query<ServiceLevelRow>(
      `SELECT id, code, display_name, fulfillment_mode, is_active
       FROM shipping.service_levels
       WHERE id = $1
       FOR UPDATE`,
      [serviceLevelId],
    );
    return result.rows[0] ? mapServiceLevel(result.rows[0]) : null;
  }

  async ensureProfile(serviceLevelId: number, now: Date): Promise<void> {
    await this.client.query(
      `INSERT INTO shipping.fulfillment_routing_profiles
        (service_level_id, revision, current_revision_id, updated_by, updated_at)
       VALUES ($1, 0, NULL, NULL, $2)
       ON CONFLICT (service_level_id) DO NOTHING`,
      [serviceLevelId, now],
    );
  }

  getProfileForUpdate(serviceLevelId: number): Promise<FulfillmentRoutingProfileState> {
    return loadProfile(this.client, serviceLevelId, true);
  }

  async findRevisionByIdempotencyKey(
    serviceLevelId: number,
    idempotencyKey: string,
  ): Promise<FulfillmentRoutingRevisionIdentity | null> {
    const result = await this.client.query<RevisionRow>(
      `SELECT id, service_level_id, revision, request_hash
       FROM shipping.fulfillment_routing_revisions
       WHERE service_level_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [serviceLevelId, idempotencyKey],
    );
    const row = result.rows[0];
    return row ? {
      id: safeId(row.id, "fulfillment routing revision id"),
      serviceLevelId: row.service_level_id,
      revision: row.revision,
      requestHash: row.request_hash,
    } : null;
  }

  async createRevision(input: CreateFulfillmentRoutingRevisionInput): Promise<number> {
    const result = await this.client.query<{ id: string | number }>(
      `INSERT INTO shipping.fulfillment_routing_revisions
        (service_level_id, revision, idempotency_key, request_hash, catalog_hash,
         catalog_fetched_at, supersedes_revision_id, methods_snapshot, actor_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       RETURNING id`,
      [
        input.serviceLevelId,
        input.revision,
        input.idempotencyKey,
        input.requestHash,
        input.catalogHash,
        input.catalogFetchedAt,
        input.supersedesRevisionId,
        JSON.stringify(input.methods),
        input.actorUserId,
        input.now,
      ],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw dataIntegrityError("Revision insert did not return an id.");
    return safeId(id, "fulfillment routing revision id");
  }

  async replaceMethods(input: {
    serviceLevelId: number;
    revisionId: number;
    methods: ShippingFulfillmentRouteMethod[];
    now: Date;
  }): Promise<void> {
    await this.client.query(
      `DELETE FROM shipping.service_level_methods WHERE service_level_id = $1`,
      [input.serviceLevelId],
    );
    if (input.methods.length === 0) return;

    const payload = input.methods.map((method) => ({
      provider: method.provider,
      provider_account_id: method.providerAccountId,
      provider_account_name: method.providerAccountName,
      carrier: method.carrierCode,
      carrier_name: method.carrierName,
      service_code: method.serviceCode,
      service_name: method.serviceName,
      priority: method.priority,
      domestic: method.domestic,
      international: method.international,
    }));
    await this.client.query(
      `INSERT INTO shipping.service_level_methods
        (service_level_id, provider, provider_account_id, provider_account_name,
         carrier, carrier_name, service_code, service_name, priority, domestic,
         international, revision_id, is_active, created_at, updated_at)
       SELECT $1,
              method.provider,
              method.provider_account_id,
              method.provider_account_name,
              method.carrier,
              method.carrier_name,
              method.service_code,
              method.service_name,
              method.priority,
              method.domestic,
              method.international,
              $2,
              TRUE,
              $4,
              $4
       FROM jsonb_to_recordset($3::jsonb) AS method(
         provider TEXT,
         provider_account_id TEXT,
         provider_account_name TEXT,
         carrier TEXT,
         carrier_name TEXT,
         service_code TEXT,
         service_name TEXT,
         priority INTEGER,
         domestic BOOLEAN,
         international BOOLEAN
       )`,
      [input.serviceLevelId, input.revisionId, JSON.stringify(payload), input.now],
    );
  }

  async advanceProfile(input: {
    serviceLevelId: number;
    expectedRevision: number;
    nextRevision: number;
    revisionId: number;
    actorUserId: string;
    now: Date;
  }): Promise<void> {
    const result = await this.client.query(
      `UPDATE shipping.fulfillment_routing_profiles
       SET revision = $3,
           current_revision_id = $4,
           updated_by = $5,
           updated_at = $6
       WHERE service_level_id = $1 AND revision = $2`,
      [
        input.serviceLevelId,
        input.expectedRevision,
        input.nextRevision,
        input.revisionId,
        input.actorUserId,
        input.now,
      ],
    );
    if (result.rowCount !== 1) {
      throw new FulfillmentRoutingError(
        409,
        "SHIPPING_FULFILLMENT_ROUTING_REVISION_CONFLICT",
        "The fulfillment routing profile changed. Refresh it before saving.",
      );
    }
  }
}

async function loadProfile(
  client: PoolClient,
  serviceLevelId: number,
  forUpdate: boolean,
): Promise<FulfillmentRoutingProfileState> {
  const profileResult = await client.query<ProfileRow>(
    `SELECT service_level_id, revision, current_revision_id, updated_by, updated_at
     FROM shipping.fulfillment_routing_profiles
     WHERE service_level_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [serviceLevelId],
  );
  const methodResult = await client.query<MethodRow>(
    `SELECT provider, provider_account_id, provider_account_name, carrier,
            carrier_name, service_code, service_name, priority, domestic,
            international, revision_id, is_active
     FROM shipping.service_level_methods
     WHERE service_level_id = $1
     ORDER BY priority ASC, id ASC${forUpdate ? " FOR UPDATE" : ""}`,
    [serviceLevelId],
  );
  const head = profileResult.rows[0] ?? null;
  const scopedRows = methodResult.rows.filter((row) => row.provider_account_id !== null);
  const legacyUnscopedMethodCount = methodResult.rows.length - scopedRows.length;
  const currentRevisionId = head?.current_revision_id == null
    ? null
    : safeId(head.current_revision_id, "current fulfillment routing revision id");

  if (!head && scopedRows.length > 0) {
    throw dataIntegrityError("Scoped fulfillment methods exist without a routing profile head.");
  }
  if (head && scopedRows.some((row) => (
    row.revision_id == null
    || safeId(row.revision_id, "fulfillment method revision id") !== currentRevisionId
  ))) {
    throw dataIntegrityError("A fulfillment method does not belong to the profile's current revision.");
  }

  return {
    serviceLevelId,
    revision: head?.revision ?? 0,
    currentRevisionId,
    methods: scopedRows.filter((row) => row.is_active).map(mapMethod),
    legacyUnscopedMethodCount,
    updatedBy: head?.updated_by ?? null,
    updatedAt: head ? new Date(head.updated_at) : null,
  };
}

function mapServiceLevel(row: ServiceLevelRow): ShippingFulfillmentRoutingServiceLevel {
  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    fulfillmentMode: row.fulfillment_mode,
    isActive: row.is_active,
  };
}

function mapMethod(row: MethodRow): ShippingFulfillmentRouteMethod {
  if (
    row.provider !== "shipstation_v2"
    || row.provider_account_id === null
    || row.provider_account_name === null
    || row.carrier_name === null
    || row.service_name === null
  ) {
    throw dataIntegrityError("A scoped fulfillment method has incomplete provider identity.");
  }
  return {
    provider: "shipstation_v2",
    providerAccountId: row.provider_account_id,
    providerAccountName: row.provider_account_name,
    carrierCode: row.carrier,
    carrierName: row.carrier_name,
    serviceCode: row.service_code,
    serviceName: row.service_name,
    priority: row.priority,
    domestic: row.domestic,
    international: row.international,
  };
}

function safeId(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw dataIntegrityError(`${field} is outside the supported integer range.`);
  }
  return parsed;
}

function dataIntegrityError(detail: string): FulfillmentRoutingError {
  return new FulfillmentRoutingError(
    500,
    "SHIPPING_FULFILLMENT_ROUTING_DATA_INTEGRITY_ERROR",
    "Fulfillment routing data is inconsistent.",
    [detail],
  );
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}
