import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  currentPublicationEvidenceSchema,
  inventoryActivationDryRunSchema,
  type CurrentPublicationEvidence,
  type InventoryActivationDryRun,
} from "@shared/types/inventory-availability-phase4";
import { canonicalJson } from "@shared/utils/canonical-json";

import { pool } from "../../../db";
import type {
  InventoryAvailabilityActivationDryRunStore,
  PersistActivationDryRunInput,
  PublicationEvidenceKey,
} from "../application/inventory-availability-activation-dry-run.service";

type ClientPool = Pick<Pool, "connect">;
const PRODUCT_EVIDENCE_BATCH_SIZE = 250;

export class InventoryAvailabilityActivationDryRunRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryAvailabilityActivationDryRunRepositoryError";
  }
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new InventoryAvailabilityActivationDryRunRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a positive PostgreSQL integer.`,
      { field, value },
    );
  }
  return parsed;
}

function nonnegativeQuantity(value: unknown, field: string): string {
  try {
    const parsed = BigInt(String(value));
    if (parsed < BigInt(0) || parsed > BigInt("9223372036854775807")) throw new Error("out of range");
    return parsed.toString();
  } catch (cause) {
    throw new InventoryAvailabilityActivationDryRunRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a nonnegative PostgreSQL bigint quantity.`,
      { field, value, cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

function iso(value: unknown, field: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new InventoryAvailabilityActivationDryRunRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a timestamp.`,
      { field, value },
    );
  }
  return parsed.toISOString();
}

function nullableIso(value: unknown, field: string): string | null {
  return value == null ? null : iso(value, field);
}

function jsonObject(value: unknown, field: string): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
    } catch {
      // Classified below.
    }
  }
  throw new InventoryAvailabilityActivationDryRunRepositoryError(
    "INVALID_DATABASE_EVIDENCE",
    `${field} must be a JSON object.`,
    { field },
  );
}

function uniqueKeys(keys: readonly PublicationEvidenceKey[]): PublicationEvidenceKey[] {
  const byKey = new Map<string, PublicationEvidenceKey>();
  for (const key of keys) {
    const channelId = positiveInteger(key.channelId, "publicationKey.channelId");
    const productVariantId = positiveInteger(key.productVariantId, "publicationKey.productVariantId");
    byKey.set(`${channelId}:${productVariantId}`, { channelId, productVariantId });
  }
  return [...byKey.values()].sort((left, right) =>
    left.channelId - right.channelId || left.productVariantId - right.productVariantId);
}

async function inTransaction<T>(
  connectionPool: ClientPool,
  begin: "BEGIN" | "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await connectionPool.connect();
  let began = false;
  try {
    await client.query(begin);
    began = true;
    const result = await work(client);
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Activation dry-run transaction and rollback both failed.",
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresInventoryAvailabilityActivationDryRunRepository
implements InventoryAvailabilityActivationDryRunStore {
  constructor(private readonly connectionPool: ClientPool = pool) {}

  async captureCurrentPublicationEvidence(
    rawKeys: readonly PublicationEvidenceKey[],
  ): Promise<CurrentPublicationEvidence[]> {
    const keys = uniqueKeys(rawKeys);
    if (keys.length === 0) return [];
    const channelIds = [...new Set(keys.map((key) => key.channelId))].sort((a, b) => a - b);
    const variantIds = [...new Set(keys.map((key) => key.productVariantId))].sort((a, b) => a - b);
    return inTransaction(
      this.connectionPool,
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      async (client) => {
        const feedRows = (await client.query<Record<string, any>>(
          `SELECT id, channel_id, product_variant_id, is_active,
                  channel_inventory_item_id, last_synced_qty, last_synced_at,
                  quarantined_at
           FROM channels.channel_feeds
           WHERE channel_id = ANY($1::integer[])
             AND product_variant_id = ANY($2::integer[])
           ORDER BY channel_id, product_variant_id, id`,
          [channelIds, variantIds],
        )).rows;
        const targetRows = (await client.query<Record<string, any>>(
          `SELECT target.id, target.channel_id, target.channel_connection_id,
                  target.fulfillment_node_id,
                  node.warehouse_id, target.provider_scope_type,
                  target.external_scope_id, target.publication_authority, target.state,
                  target.revision
           FROM inventory.inventory_publication_targets AS target
           JOIN warehouse.fulfillment_nodes AS node ON node.id = target.fulfillment_node_id
           WHERE target.channel_id = ANY($1::integer[])
           ORDER BY target.channel_id, target.fulfillment_node_id, target.id`,
          [channelIds],
        )).rows;
        const targetIds = targetRows.map((row) => positiveInteger(row.id, "publicationTarget.id"));
        const mappingRows = targetIds.length === 0 ? [] : (await client.query<Record<string, any>>(
          `SELECT DISTINCT ON (head.publication_target_id, head.product_variant_id)
                  head.publication_target_id, head.product_variant_id,
                  pointer.pointer_type, mapping.id AS mapping_id, mapping.version,
                  mapping.definition_hash, mapping.external_inventory_item_id,
                  mapping.external_sku
           FROM inventory.publication_variant_mapping_heads AS head
           CROSS JOIN LATERAL (
             VALUES ('draft', head.draft_mapping_id), ('active', head.active_mapping_id)
           ) AS pointer(pointer_type, mapping_id)
           JOIN inventory.publication_variant_mapping_versions AS mapping
             ON mapping.id = pointer.mapping_id
           WHERE head.publication_target_id = ANY($1::integer[])
             AND head.product_variant_id = ANY($2::integer[])
           ORDER BY head.publication_target_id, head.product_variant_id,
                    CASE pointer.pointer_type WHEN 'draft' THEN 0 ELSE 1 END`,
          [targetIds, variantIds],
        )).rows;
        const readbackRows = targetIds.length === 0 ? [] : (await client.query<Record<string, any>>(
           `SELECT DISTINCT ON (readback.publication_target_id, readback.product_variant_id)
                   readback.publication_target_id,
                   readback.product_variant_id,
                   readback.observed_quantity,
                   readback.observed_at,
                   COALESCE(
                     readback.external_inventory_item_id_snapshot,
                     publication.external_inventory_item_id_snapshot
                   ) AS external_inventory_item_id_snapshot
            FROM inventory.inventory_publication_readbacks AS readback
            LEFT JOIN inventory.inventory_publication_outbox AS publication
              ON publication.id = readback.outbox_id
            WHERE readback.publication_target_id = ANY($1::integer[])
             AND readback.product_variant_id = ANY($2::integer[])
           ORDER BY readback.publication_target_id, readback.product_variant_id,
                     readback.observed_at DESC, readback.id DESC`,
          [targetIds, variantIds],
        )).rows;

        const feedByKey = new Map(feedRows.map((row) => [
          `${positiveInteger(row.channel_id, "feed.channelId")}:${positiveInteger(row.product_variant_id, "feed.variantId")}`,
          row,
        ] as const));
        const targetRowsByChannel = new Map<number, Record<string, any>[]>();
        for (const row of targetRows) {
          const channelId = positiveInteger(row.channel_id, "publicationTarget.channelId");
          const rows = targetRowsByChannel.get(channelId) ?? [];
          rows.push(row);
          targetRowsByChannel.set(channelId, rows);
        }
        const readbackByKey = new Map(readbackRows.map((row) => [
          `${positiveInteger(row.publication_target_id, "readback.targetId")}:${positiveInteger(row.product_variant_id, "readback.variantId")}`,
          row,
        ] as const));
        const mappingByKey = new Map(mappingRows.map((row) => [
          `${positiveInteger(row.publication_target_id, "mapping.targetId")}:${positiveInteger(row.product_variant_id, "mapping.variantId")}`,
          row,
        ] as const));

        return keys.map((key) => {
          const feed = feedByKey.get(`${key.channelId}:${key.productVariantId}`);
          const configuredTargets = (targetRowsByChannel.get(key.channelId) ?? []).map((target) => {
            const publicationTargetId = positiveInteger(target.id, "publicationTarget.id");
            const readback = readbackByKey.get(`${publicationTargetId}:${key.productVariantId}`);
            const mapping = mappingByKey.get(`${publicationTargetId}:${key.productVariantId}`);
            return {
              publicationTargetId,
              channelConnectionId: positiveInteger(
                target.channel_connection_id,
                "publicationTarget.channelConnectionId",
              ),
              fulfillmentNodeId: positiveInteger(
                target.fulfillment_node_id,
                "publicationTarget.fulfillmentNodeId",
              ),
              warehouseId: positiveInteger(target.warehouse_id, "publicationTarget.warehouseId"),
              providerScopeType: target.provider_scope_type,
              externalScopeId: String(target.external_scope_id),
              publicationAuthority: target.publication_authority,
              state: target.state,
              revision: String(target.revision),
              mapping: mapping ? {
                mappingId: positiveInteger(mapping.mapping_id, "mapping.id"),
                version: positiveInteger(mapping.version, "mapping.version"),
                definitionHash: String(mapping.definition_hash),
                authority: String(mapping.pointer_type),
                externalInventoryItemId: String(mapping.external_inventory_item_id),
                externalSku: mapping.external_sku == null ? null : String(mapping.external_sku),
              } : null,
              latestReadbackUnits: readback
                ? nonnegativeQuantity(readback.observed_quantity, "readback.observedQuantity")
                : null,
              latestReadbackAt: readback
                ? iso(readback.observed_at, "readback.observedAt")
                : null,
              latestReadbackExternalInventoryItemId:
                readback?.external_inventory_item_id_snapshot == null
                  ? null
                  : String(readback.external_inventory_item_id_snapshot),
            };
          });
          const mappingState = !feed
            ? "missing" as const
            : feed.quarantined_at != null
              ? "quarantined" as const
              : Number(feed.is_active) === 1
                ? "active" as const
                : "inactive" as const;
          return currentPublicationEvidenceSchema.parse({
            channelId: key.channelId,
            productVariantId: key.productVariantId,
            feedId: feed ? positiveInteger(feed.id, "feed.id") : null,
            mappingState,
            channelInventoryItemId: feed?.channel_inventory_item_id == null
              ? null
              : String(feed.channel_inventory_item_id),
            lastAcknowledgedUnits: feed?.last_synced_qty == null
              ? null
              : nonnegativeQuantity(feed.last_synced_qty, "feed.lastSyncedQty"),
            lastAcknowledgedAt: nullableIso(feed?.last_synced_at, "feed.lastSyncedAt"),
            configuredTargets,
          });
        });
      },
    );
  }

  async persistActivationDryRun(input: PersistActivationDryRunInput): Promise<InventoryActivationDryRun> {
    const evidencePayload = {
      summary: input.summary,
      products: input.products,
      blockers: input.blockers,
    };
    return inTransaction(this.connectionPool, "BEGIN", async (client) => {
      const inserted = (await client.query<{ id: string }>(
        `INSERT INTO inventory.availability_activation_runs (
           mode, scope, state, request_hash, result_hash,
           expected_catalog_input_hash, expected_catalog_result_hash,
           captured_catalog_input_hash, captured_catalog_result_hash,
           evidence_payload, blocker_codes, idempotency_key, reason, requested_by,
           runtime_authority_changed, provider_write_attempted, outbox_enqueued,
           started_at, completed_at
         ) VALUES (
           'dry_run', 'full_catalog', $1, $2, $3, $4, $5, $6, $7,
           $8::jsonb, $9::jsonb, $10, $11, $12, false, false, false, $13, $14
         )
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          input.state,
          input.requestHash,
          input.resultHash,
          input.expectedCatalogInputHash,
          input.expectedCatalogResultHash,
          input.catalogInputHash,
          input.catalogResultHash,
          JSON.stringify(evidencePayload),
          JSON.stringify([...new Set([
            ...input.blockers.map((entry) => entry.code),
            ...input.products.flatMap((product) => product.blockers.map((entry) => entry.code)),
          ])].sort()),
          input.idempotencyKey,
          input.reason,
          input.requestedBy,
          input.startedAt.toISOString(),
          input.completedAt.toISOString(),
        ],
      )).rows[0];

      if (inserted) {
        for (let offset = 0; offset < input.products.length; offset += PRODUCT_EVIDENCE_BATCH_SIZE) {
          const batch = input.products.slice(offset, offset + PRODUCT_EVIDENCE_BATCH_SIZE);
          const values: unknown[] = [];
          const tuples = batch.map((product, index) => {
            const base = index * 5;
            const evidenceHash = createHash("sha256")
              .update(canonicalJson(product), "utf8")
              .digest("hex");
            values.push(inserted.id, product.productId, product.status, evidenceHash, JSON.stringify(product));
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb)`;
          });
          if (tuples.length > 0) {
            await client.query(
              `INSERT INTO inventory.availability_activation_product_evidence (
                 activation_run_id, product_id, status, evidence_hash, evidence_payload
               ) VALUES ${tuples.join(", ")}`,
              values,
            );
          }
        }
        await client.query(
          `INSERT INTO inventory.availability_activation_events (
             activation_run_id, from_state, to_state, actor, reason, evidence_hash, occurred_at
           ) VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
          [
            inserted.id,
            input.state,
            input.requestedBy,
            input.reason,
            input.resultHash,
            input.completedAt.toISOString(),
          ],
        );
      }

      const row = (await client.query<Record<string, any>>(
        `SELECT id, mode, scope, state, request_hash, result_hash,
                captured_catalog_input_hash, captured_catalog_result_hash,
                evidence_payload, requested_by, reason, started_at, completed_at,
                runtime_authority_changed, provider_write_attempted, outbox_enqueued
         FROM inventory.availability_activation_runs
         WHERE id = COALESCE($1::bigint, (
           SELECT id FROM inventory.availability_activation_runs WHERE idempotency_key = $2
         ))
         FOR SHARE`,
        [inserted?.id ?? null, input.idempotencyKey],
      )).rows[0];
      if (!row) {
        throw new InventoryAvailabilityActivationDryRunRepositoryError(
          "IDEMPOTENCY_CONFLICT_NOT_VISIBLE",
          "The idempotency key conflicted but the existing activation dry run was not visible.",
          { idempotencyKey: input.idempotencyKey },
        );
      }
      if (String(row.request_hash) !== input.requestHash) {
        throw new InventoryAvailabilityActivationDryRunRepositoryError(
          "IDEMPOTENCY_KEY_REUSED",
          "The idempotency key already belongs to a different activation dry-run request.",
          { idempotencyKey: input.idempotencyKey },
        );
      }
      const evidence = jsonObject(row.evidence_payload, "activationRun.evidencePayload");
      return inventoryActivationDryRunSchema.parse({
        activationRunId: String(row.id),
        mode: row.mode,
        scope: row.scope,
        state: row.state,
        requestHash: String(row.request_hash),
        resultHash: String(row.result_hash),
        catalogInputHash: String(row.captured_catalog_input_hash),
        catalogResultHash: String(row.captured_catalog_result_hash),
        requestedBy: String(row.requested_by),
        reason: String(row.reason),
        startedAt: iso(row.started_at, "activationRun.startedAt"),
        completedAt: iso(row.completed_at, "activationRun.completedAt"),
        summary: evidence.summary,
        products: evidence.products,
        blockers: evidence.blockers,
        runtimeAuthorityChanged: row.runtime_authority_changed,
        providerWriteAttempted: row.provider_write_attempted,
        outboxEnqueued: row.outbox_enqueued,
        alreadyApplied: !inserted,
      });
    });
  }
}
