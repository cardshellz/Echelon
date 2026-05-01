import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type { DropshipStoreListingConfig } from "../application/dropship-marketplace-listing-provider";
import type {
  DropshipListingPushWorkerClaim,
  DropshipListingPushWorkerItemRecord,
  DropshipListingPushWorkerJobRecord,
  DropshipListingPushWorkerRepository,
  DropshipListingPushWorkerResult,
} from "../application/dropship-listing-push-worker-service";
import { summarizeWorkerItems } from "../application/dropship-listing-push-worker-service";

interface JobRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  platform: DropshipStoreListingConfig["platform"];
  status: string;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface StoreListingConfigRow {
  id: number;
  store_connection_id: number;
  platform: DropshipStoreListingConfig["platform"];
  listing_mode: DropshipStoreListingConfig["listingMode"];
  inventory_mode: DropshipStoreListingConfig["inventoryMode"];
  price_mode: DropshipStoreListingConfig["priceMode"];
  marketplace_config: Record<string, unknown> | null;
  required_config_keys: unknown;
  required_product_fields: unknown;
  is_active: boolean;
}

interface JobItemRow {
  id: number;
  job_id: number;
  listing_id: number | null;
  product_variant_id: number;
  status: string;
  preview_hash: string | null;
  external_listing_id: string | null;
  error_code: string | null;
  error_message: string | null;
  result: Record<string, unknown> | null;
  listing_status: string | null;
  listing_external_listing_id: string | null;
  listing_external_offer_id: string | null;
  listing_last_preview_hash: string | null;
}

interface CountByStatusRow {
  status: string;
  count: string | number;
}

export class PgDropshipListingPushWorkerRepository implements DropshipListingPushWorkerRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async claimJob(input: {
    jobId: number;
    workerId: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<DropshipListingPushWorkerClaim> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const job = await findJobForUpdate(client, input.jobId);
      if (!job) {
        throw new DropshipError("DROPSHIP_LISTING_JOB_NOT_FOUND", "Dropship listing push job was not found.", {
          jobId: input.jobId,
        });
      }
      const config = await loadStoreListingConfig(client, job.store_connection_id);
      if (!config) {
        throw new DropshipError("DROPSHIP_LISTING_CONFIG_REQUIRED", "Store listing configuration is required.", {
          jobId: input.jobId,
          storeConnectionId: job.store_connection_id,
        });
      }

      if (job.status === "processing") {
        throw new DropshipError("DROPSHIP_LISTING_JOB_ALREADY_PROCESSING", "Dropship listing push job is already processing.", {
          jobId: input.jobId,
        });
      }

      let claimed = false;
      let currentJob = job;
      if (job.status === "queued") {
        const updated = await client.query<JobRow>(
        `UPDATE dropship.dropship_listing_push_jobs AS j
           SET status = 'processing',
               updated_at = $2
           WHERE j.id = $1
           RETURNING j.id, j.vendor_id, j.store_connection_id,
                     (SELECT sc.platform FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS platform,
                     j.status, j.idempotency_key, j.request_hash, j.created_at, j.updated_at, j.completed_at`,
          [input.jobId, input.now],
        );
        currentJob = requiredRow(updated.rows[0], "Dropship listing push job claim did not return a row.");
        claimed = true;
        await recordAuditEvent(client, {
          vendorId: currentJob.vendor_id,
          storeConnectionId: currentJob.store_connection_id,
          entityType: "dropship_listing_push_job",
          entityId: String(currentJob.id),
          eventType: "listing_push_job_claimed",
          actorId: input.workerId,
          payload: { idempotencyKey: input.idempotencyKey },
          occurredAt: input.now,
        });
      }

      const items = await listJobItemsWithClient(client, input.jobId);
      await client.query("COMMIT");
      return {
        job: mapJobRow(currentJob),
        config,
        items,
        claimed,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async markItemProcessing(input: {
    jobId: number;
    itemId: number;
    now: Date;
  }): Promise<boolean> {
    const result = await this.dbPool.query(
      `UPDATE dropship.dropship_listing_push_job_items
       SET status = 'processing',
           updated_at = $3
       WHERE job_id = $1
         AND id = $2
         AND status = 'queued'`,
      [input.jobId, input.itemId, input.now],
    );
    return result.rowCount === 1;
  }

  async completeItem(input: Parameters<DropshipListingPushWorkerRepository["completeItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await updateJobItemTerminalStatus(client, {
        itemId: input.item.itemId,
        status: "completed",
        externalListingId: input.pushResult.externalListingId,
        errorCode: null,
        errorMessage: null,
        resultPatch: {
          push: {
            status: input.pushResult.status,
            externalListingId: input.pushResult.externalListingId,
            externalOfferId: input.pushResult.externalOfferId,
            rawResult: input.pushResult.rawResult,
            pushedAt: input.now.toISOString(),
            workerId: input.workerId,
          },
        },
        now: input.now,
      });
      await client.query(
        `UPDATE dropship.dropship_vendor_listings
         SET status = 'active',
             external_listing_id = $2,
             external_offer_id = $3,
             pushed_quantity = $4,
             vendor_retail_price_cents = $5,
             last_pushed_at = $6,
             metadata = COALESCE(metadata, '{}'::jsonb) || $7::jsonb,
             updated_at = $6
         WHERE id = $1`,
        [
          input.item.listingId,
          input.pushResult.externalListingId,
          input.pushResult.externalOfferId,
          input.intent.quantity,
          input.intent.priceCents,
          input.now,
          JSON.stringify({
            lastPush: {
              jobId: input.job.jobId,
              jobItemId: input.item.itemId,
              status: input.pushResult.status,
              workerId: input.workerId,
            },
          }),
        ],
      );
      await recordListingSyncEvent(client, {
        listingId: requiredNumber(input.item.listingId, "Listing id is required for listing sync event."),
        eventType: "listing_push_completed",
        source: "dropship_worker",
        payload: {
          jobId: input.job.jobId,
          jobItemId: input.item.itemId,
          externalListingId: input.pushResult.externalListingId,
          externalOfferId: input.pushResult.externalOfferId,
          quantity: input.intent.quantity,
          priceCents: input.intent.priceCents,
        },
        occurredAt: input.now,
      });
      await recordAuditEvent(client, {
        vendorId: input.job.vendorId,
        storeConnectionId: input.job.storeConnectionId,
        entityType: "dropship_listing_push_job_item",
        entityId: String(input.item.itemId),
        eventType: "listing_push_item_completed",
        actorId: input.workerId,
        payload: {
          jobId: input.job.jobId,
          listingId: input.item.listingId,
          externalListingId: input.pushResult.externalListingId,
        },
        occurredAt: input.now,
      });
      const item = await getJobItemWithClient(client, input.item.itemId);
      await client.query("COMMIT");
      return item;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async failItem(input: Parameters<DropshipListingPushWorkerRepository["failItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    return this.markItemTerminalFailure({
      ...input,
      status: "failed",
      eventType: "listing_push_item_failed",
    });
  }

  async blockItem(input: Parameters<DropshipListingPushWorkerRepository["blockItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    return this.markItemTerminalFailure({
      ...input,
      status: "blocked",
      retryable: false,
      eventType: "listing_push_item_blocked",
    });
  }

  async finalizeJob(input: {
    jobId: number;
    workerId: string;
    now: Date;
  }): Promise<DropshipListingPushWorkerResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const job = await findJobForUpdate(client, input.jobId);
      if (!job) {
        throw new DropshipError("DROPSHIP_LISTING_JOB_NOT_FOUND", "Dropship listing push job was not found.", {
          jobId: input.jobId,
        });
      }
      const counts = await client.query<CountByStatusRow>(
        `SELECT status, COUNT(*) AS count
         FROM dropship.dropship_listing_push_job_items
         WHERE job_id = $1
         GROUP BY status`,
        [input.jobId],
      );
      const statusCounts = new Map(counts.rows.map((row) => [row.status, Number(row.count)]));
      const pendingCount = (statusCounts.get("queued") ?? 0) + (statusCounts.get("processing") ?? 0);
      const failedCount = (statusCounts.get("failed") ?? 0) + (statusCounts.get("blocked") ?? 0);
      const nextStatus = pendingCount > 0
        ? "processing"
        : failedCount > 0
          ? "failed"
          : "completed";
      const updated = await client.query<JobRow>(
        `UPDATE dropship.dropship_listing_push_jobs AS j
         SET status = $2,
             completed_at = CASE WHEN $2 IN ('completed','failed') THEN $3 ELSE completed_at END,
             updated_at = $3,
             error_message = CASE WHEN $2 = 'failed' THEN $4 ELSE NULL END
         WHERE j.id = $1
         RETURNING j.id, j.vendor_id, j.store_connection_id,
                   (SELECT sc.platform FROM dropship.dropship_store_connections sc WHERE sc.id = j.store_connection_id) AS platform,
                   j.status, j.idempotency_key, j.request_hash, j.created_at, j.updated_at, j.completed_at`,
        [
          input.jobId,
          nextStatus,
          input.now,
          failedCount > 0 ? "One or more listing push items failed or were blocked." : null,
        ],
      );
      const currentJob = mapJobRow(requiredRow(updated.rows[0], "Dropship listing push job finalize did not return a row."));
      const items = await listJobItemsWithClient(client, input.jobId);
      await recordAuditEvent(client, {
        vendorId: currentJob.vendorId,
        storeConnectionId: currentJob.storeConnectionId,
        entityType: "dropship_listing_push_job",
        entityId: String(input.jobId),
        eventType: "listing_push_job_finalized",
        actorId: input.workerId,
        payload: { status: currentJob.status, summary: summarizeWorkerItems(items) },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return {
        job: currentJob,
        items,
        summary: summarizeWorkerItems(items),
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async markItemTerminalFailure(input: {
    job: DropshipListingPushWorkerJobRecord;
    item: DropshipListingPushWorkerItemRecord;
    status: "failed" | "blocked";
    code: string;
    message: string;
    retryable: boolean;
    workerId: string;
    eventType: string;
    now: Date;
  }): Promise<DropshipListingPushWorkerItemRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await updateJobItemTerminalStatus(client, {
        itemId: input.item.itemId,
        status: input.status,
        externalListingId: input.item.externalListingId,
        errorCode: input.code,
        errorMessage: input.message,
        resultPatch: {
          push: {
            status: input.status,
            errorCode: input.code,
            errorMessage: input.message,
            retryable: input.retryable,
            workerId: input.workerId,
            processedAt: input.now.toISOString(),
          },
        },
        now: input.now,
      });
      if (input.item.listingId !== null) {
        await client.query(
          `UPDATE dropship.dropship_vendor_listings
           SET status = $2,
               metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
               updated_at = $4
           WHERE id = $1`,
          [
            input.item.listingId,
            input.status,
            JSON.stringify({
              lastPushError: {
                jobId: input.job.jobId,
                jobItemId: input.item.itemId,
                code: input.code,
                message: input.message,
                retryable: input.retryable,
                workerId: input.workerId,
              },
            }),
            input.now,
          ],
        );
        await recordListingSyncEvent(client, {
          listingId: input.item.listingId,
          eventType: input.status === "blocked" ? "listing_push_blocked" : "listing_push_failed",
          source: "dropship_worker",
          payload: {
            jobId: input.job.jobId,
            jobItemId: input.item.itemId,
            code: input.code,
            message: input.message,
            retryable: input.retryable,
          },
          occurredAt: input.now,
        });
      }
      await recordAuditEvent(client, {
        vendorId: input.job.vendorId,
        storeConnectionId: input.job.storeConnectionId,
        entityType: "dropship_listing_push_job_item",
        entityId: String(input.item.itemId),
        eventType: input.eventType,
        actorId: input.workerId,
        payload: {
          jobId: input.job.jobId,
          listingId: input.item.listingId,
          code: input.code,
          message: input.message,
          retryable: input.retryable,
        },
        occurredAt: input.now,
      });
      const item = await getJobItemWithClient(client, input.item.itemId);
      await client.query("COMMIT");
      return item;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function findJobForUpdate(client: PoolClient, jobId: number): Promise<JobRow | null> {
  const result = await client.query<JobRow>(
    `SELECT j.id, j.vendor_id, j.store_connection_id, sc.platform, j.status,
            j.idempotency_key, j.request_hash, j.created_at, j.updated_at, j.completed_at
     FROM dropship.dropship_listing_push_jobs j
     INNER JOIN dropship.dropship_store_connections sc ON sc.id = j.store_connection_id
     WHERE j.id = $1
     FOR UPDATE OF j`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

async function loadStoreListingConfig(
  client: PoolClient,
  storeConnectionId: number,
): Promise<DropshipStoreListingConfig | null> {
  const result = await client.query<StoreListingConfigRow>(
    `SELECT id, store_connection_id, platform, listing_mode, inventory_mode, price_mode,
            marketplace_config, required_config_keys, required_product_fields, is_active
     FROM dropship.dropship_store_listing_configs
     WHERE store_connection_id = $1
     LIMIT 1`,
    [storeConnectionId],
  );
  return result.rows[0] ? mapStoreListingConfigRow(result.rows[0]) : null;
}

async function listJobItemsWithClient(
  client: PoolClient,
  jobId: number,
): Promise<DropshipListingPushWorkerItemRecord[]> {
  const result = await client.query<JobItemRow>(
    `SELECT i.id, i.job_id, i.listing_id, i.product_variant_id, i.status,
            i.preview_hash, i.external_listing_id, i.error_code, i.error_message, i.result,
            l.status AS listing_status,
            l.external_listing_id AS listing_external_listing_id,
            l.external_offer_id AS listing_external_offer_id,
            l.last_preview_hash AS listing_last_preview_hash
     FROM dropship.dropship_listing_push_job_items i
     LEFT JOIN dropship.dropship_vendor_listings l ON l.id = i.listing_id
     WHERE i.job_id = $1
     ORDER BY i.id ASC`,
    [jobId],
  );
  return result.rows.map(mapJobItemRow);
}

async function getJobItemWithClient(
  client: PoolClient,
  itemId: number,
): Promise<DropshipListingPushWorkerItemRecord> {
  const result = await client.query<JobItemRow>(
    `SELECT i.id, i.job_id, i.listing_id, i.product_variant_id, i.status,
            i.preview_hash, i.external_listing_id, i.error_code, i.error_message, i.result,
            l.status AS listing_status,
            l.external_listing_id AS listing_external_listing_id,
            l.external_offer_id AS listing_external_offer_id,
            l.last_preview_hash AS listing_last_preview_hash
     FROM dropship.dropship_listing_push_job_items i
     LEFT JOIN dropship.dropship_vendor_listings l ON l.id = i.listing_id
     WHERE i.id = $1
     LIMIT 1`,
    [itemId],
  );
  return mapJobItemRow(requiredRow(result.rows[0], "Dropship listing push job item was not found."));
}

async function updateJobItemTerminalStatus(
  client: PoolClient,
  input: {
    itemId: number;
    status: "completed" | "failed" | "blocked";
    externalListingId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    resultPatch: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await client.query(
    `UPDATE dropship.dropship_listing_push_job_items
     SET status = $2,
         external_listing_id = $3,
         error_code = $4,
         error_message = $5,
         result = COALESCE(result, '{}'::jsonb) || $6::jsonb,
         updated_at = $7
     WHERE id = $1`,
    [
      input.itemId,
      input.status,
      input.externalListingId,
      input.errorCode,
      input.errorMessage,
      JSON.stringify(input.resultPatch),
      input.now,
    ],
  );
}

async function recordListingSyncEvent(
  client: PoolClient,
  input: {
    listingId: number;
    eventType: string;
    source: string;
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_listing_sync_events
      (listing_id, event_type, source, payload, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [
      input.listingId,
      input.eventType,
      input.source,
      JSON.stringify(input.payload),
      input.occurredAt,
    ],
  );
}

async function recordAuditEvent(
  client: PoolClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    entityType: string;
    entityId: string;
    eventType: string;
    actorId: string;
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, 'job', $6, 'info', $7::jsonb, $8)`,
    [
      input.vendorId,
      input.storeConnectionId,
      input.entityType,
      input.entityId,
      input.eventType,
      input.actorId,
      JSON.stringify(input.payload),
      input.occurredAt,
    ],
  );
}

function mapJobRow(row: JobRow): DropshipListingPushWorkerJobRecord {
  return {
    jobId: row.id,
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapStoreListingConfigRow(row: StoreListingConfigRow): DropshipStoreListingConfig {
  return {
    id: row.id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    listingMode: row.listing_mode,
    inventoryMode: row.inventory_mode,
    priceMode: row.price_mode,
    marketplaceConfig: row.marketplace_config ?? {},
    requiredConfigKeys: stringArrayFromJson(row.required_config_keys),
    requiredProductFields: stringArrayFromJson(row.required_product_fields),
    isActive: row.is_active,
  };
}

function mapJobItemRow(row: JobItemRow): DropshipListingPushWorkerItemRecord {
  return {
    itemId: row.id,
    jobId: row.job_id,
    listingId: row.listing_id,
    productVariantId: row.product_variant_id,
    status: row.status,
    previewHash: row.preview_hash,
    externalListingId: row.external_listing_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    result: row.result,
    listing: row.listing_id === null ? null : {
      listingId: row.listing_id,
      productVariantId: row.product_variant_id,
      status: row.listing_status ?? "not_listed",
      externalListingId: row.listing_external_listing_id,
      externalOfferId: row.listing_external_offer_id,
      lastPreviewHash: row.listing_last_preview_hash,
    },
  };
}

function stringArrayFromJson(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function requiredNumber(value: number | null, message: string): number {
  if (value === null) {
    throw new Error(message);
  }
  return value;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
