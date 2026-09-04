import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  inventoryPublicationReadbackRunSchema,
  type InventoryPublicationReadbackRun,
} from "@shared/types/inventory-availability-phase4";
import { canonicalJson } from "@shared/utils/canonical-json";

import { pool } from "../../../db";
import type {
  BeginPublicationReadbackResult,
  InventoryPublicationReadbackStore,
  PublicationReadbackFailure,
  PublicationReadbackTarget,
} from "../application/inventory-publication-readback.service";

type ClientPool = Pick<Pool, "connect">;

export class InventoryPublicationReadbackRepositoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "InventoryPublicationReadbackRepositoryError";
  }
}

export class PostgresInventoryPublicationReadbackRepository
implements InventoryPublicationReadbackStore {
  constructor(private readonly connectionPool: ClientPool = pool) {}

  async begin(input: {
    idempotencyKey: string;
    requestHash: string;
    requestedBy: string;
    reason: string;
    startedAt: Date;
  }): Promise<BeginPublicationReadbackResult> {
    return inTransaction(this.connectionPool, async (client) => {
      const inserted = (await client.query<{ id: string }>(
        `INSERT INTO inventory.inventory_publication_readback_runs (
           state, idempotency_key, request_hash, requested_by, reason, started_at
         ) VALUES ('running', $1, $2, $3, $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [input.idempotencyKey, input.requestHash, input.requestedBy, input.reason, input.startedAt.toISOString()],
      )).rows[0];
      if (!inserted) {
        const existing = (await client.query<Record<string, unknown>>(
          `SELECT * FROM inventory.inventory_publication_readback_runs
           WHERE idempotency_key = $1 FOR SHARE`,
          [input.idempotencyKey],
        )).rows[0];
        if (!existing || String(existing.request_hash) !== input.requestHash) {
          throw new InventoryPublicationReadbackRepositoryError(
            "PUBLICATION_READBACK_IDEMPOTENCY_KEY_REUSED",
            "The idempotency key belongs to a different provider-readback request.",
          );
        }
        if (String(existing.state) === "running") {
          throw new InventoryPublicationReadbackRepositoryError(
            "PUBLICATION_READBACK_ALREADY_RUNNING",
            "This provider-readback request is still running or was interrupted; use a new idempotency key after review.",
          );
        }
        return {
          kind: "replay",
          result: inventoryPublicationReadbackRunSchema.parse({
            ...jsonObject(existing.result_payload),
            alreadyApplied: true,
          }),
        };
      }
      return { kind: "started", readbackRunId: inserted.id, targets: await loadTargets(client) };
    });
  }

  async recordObserved(
    readbackRunId: string,
    target: PublicationReadbackTarget,
    observedQuantity: number,
    observedAt: Date,
  ): Promise<void> {
    await inTransaction(this.connectionPool, async (client) => {
      await lockRunningRun(client, readbackRunId);
      const evidence = { ...target, observedQuantity, observedAt: observedAt.toISOString() };
      const evidenceHash = hash(evidence);
      await client.query(
        `INSERT INTO inventory.inventory_publication_readback_run_items (
           readback_run_id, publication_target_id, product_variant_id,
           status, evidence_hash, evidence_payload
         ) VALUES ($1, $2, $3, 'observed', $4, $5::jsonb)`,
        [readbackRunId, target.publicationTargetId, target.productVariantId,
          evidenceHash, JSON.stringify(evidence)],
      );
      await client.query(
        `INSERT INTO inventory.inventory_publication_readbacks (
           publication_target_id, product_variant_id, outbox_id,
           observed_quantity, matches_desired, evidence_hash,
           external_inventory_item_id_snapshot, readback_run_id,
           destination_kind_snapshot, channel_connection_id_snapshot,
           dropship_store_connection_id_snapshot, provider_scope_type_snapshot,
           external_scope_id_snapshot, publication_target_revision_snapshot,
           observed_at
         ) VALUES ($1, $2, NULL, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [target.publicationTargetId, target.productVariantId, observedQuantity,
          evidenceHash, target.externalInventoryItemId, readbackRunId,
          target.destinationKind, target.channelConnectionId, target.dropshipStoreConnectionId,
          target.providerScopeType, target.externalScopeId, target.publicationTargetRevision,
          observedAt.toISOString()],
      );
    });
  }

  async recordFailure(
    readbackRunId: string,
    target: PublicationReadbackTarget,
    failure: PublicationReadbackFailure,
  ): Promise<void> {
    await inTransaction(this.connectionPool, async (client) => {
      await lockRunningRun(client, readbackRunId);
      const evidence = { ...target, failure };
      await client.query(
        `INSERT INTO inventory.inventory_publication_readback_run_items (
           readback_run_id, publication_target_id, product_variant_id,
           status, evidence_hash, evidence_payload
         ) VALUES ($1, $2, $3, 'failed', $4, $5::jsonb)`,
        [readbackRunId, target.publicationTargetId, target.productVariantId,
          hash(evidence), JSON.stringify(evidence)],
      );
    });
  }

  async complete(input: {
    readbackRunId: string;
    requestedBy: string;
    reason: string;
    startedAt: Date;
    completedAt: Date;
    targetRows: number;
    failures: PublicationReadbackFailure[];
  }): Promise<InventoryPublicationReadbackRun> {
    return inTransaction(this.connectionPool, async (client) => {
      await lockRunningRun(client, input.readbackRunId);
      const counts = (await client.query<{ observed: string; failed: string }>(
        `SELECT count(*) FILTER (WHERE status = 'observed')::text AS observed,
                count(*) FILTER (WHERE status = 'failed')::text AS failed
         FROM inventory.inventory_publication_readback_run_items
         WHERE readback_run_id = $1`,
        [input.readbackRunId],
      )).rows[0];
      const observedRows = Number(counts?.observed ?? "0");
      const failedRows = Number(counts?.failed ?? "0");
      if (observedRows + failedRows !== input.targetRows || failedRows !== input.failures.length) {
        throw new InventoryPublicationReadbackRepositoryError(
          "PUBLICATION_READBACK_EVIDENCE_INCOMPLETE",
          "Durable provider-readback item evidence does not match the completed run summary.",
        );
      }
      const result = inventoryPublicationReadbackRunSchema.parse({
        readbackRunId: input.readbackRunId,
        state: failedRows === 0 ? "completed" : "partial",
        requestedBy: input.requestedBy,
        reason: input.reason,
        startedAt: input.startedAt.toISOString(),
        completedAt: input.completedAt.toISOString(),
        targetRows: input.targetRows,
        observedRows,
        failedRows,
        failures: input.failures,
        alreadyApplied: false,
      });
      const persistedResult = resultWithoutReplay(result);
      const updated = await client.query(
        `UPDATE inventory.inventory_publication_readback_runs
         SET state = $2, result_hash = $3, result_payload = $4::jsonb, completed_at = $5
         WHERE id = $1 AND state = 'running'`,
        [input.readbackRunId, result.state, hash(persistedResult), JSON.stringify(persistedResult),
          input.completedAt.toISOString()],
      );
      if (updated.rowCount !== 1) {
        throw new InventoryPublicationReadbackRepositoryError(
          "PUBLICATION_READBACK_RUN_NOT_RUNNING",
          "The provider-readback run is no longer open for completion.",
        );
      }
      return result;
    });
  }
}

async function loadTargets(client: PoolClient): Promise<PublicationReadbackTarget[]> {
  const rows = (await client.query<Record<string, unknown>>(
    `SELECT target.id AS publication_target_id, target.revision AS publication_target_revision,
            target.destination_kind,
            target.channel_id,
            target.channel_connection_id, target.dropship_store_connection_id,
            CASE target.destination_kind
              WHEN 'channel_connection' THEN channel.provider
              WHEN 'dropship_store_connection' THEN dropship_connection.platform
            END AS provider_key,
            target.provider_scope_type, target.external_scope_id,
            head.product_variant_id, mapping.external_inventory_item_id,
            mapping.external_sku
     FROM inventory.inventory_publication_targets AS target
     JOIN channels.channels AS channel ON channel.id = target.channel_id
     LEFT JOIN dropship.dropship_store_connections AS dropship_connection
       ON dropship_connection.id = target.dropship_store_connection_id
     JOIN inventory.publication_variant_mapping_heads AS head
       ON head.publication_target_id = target.id
     JOIN inventory.publication_variant_mapping_versions AS mapping
       ON mapping.id = CASE WHEN target.state = 'preview'
         THEN COALESCE(head.draft_mapping_id, head.active_mapping_id)
         ELSE head.active_mapping_id
       END
     WHERE target.publication_authority = 'echelon'
       AND target.state IN ('preview', 'live')
     ORDER BY target.id, head.product_variant_id`,
  )).rows;
  return rows.map((row) => {
    const targetDestinationKind = destinationKind(row.destination_kind);
    const channelConnectionId = nullablePositiveInteger(row.channel_connection_id, "channelConnectionId");
    const dropshipStoreConnectionId = nullablePositiveInteger(
      row.dropship_store_connection_id,
      "dropshipStoreConnectionId",
    );
    assertDestination(targetDestinationKind, channelConnectionId, dropshipStoreConnectionId);
    return {
      publicationTargetId: positiveInteger(row.publication_target_id, "publicationTargetId"),
      publicationTargetRevision: positiveBigint(row.publication_target_revision, "publicationTargetRevision"),
      productVariantId: positiveInteger(row.product_variant_id, "productVariantId"),
      destinationKind: targetDestinationKind,
      channelId: positiveInteger(row.channel_id, "channelId"),
      channelConnectionId,
      dropshipStoreConnectionId,
      providerKey: nonblank(row.provider_key, "providerKey"),
      providerScopeType: scope(row.provider_scope_type),
      externalScopeId: nonblank(row.external_scope_id, "externalScopeId"),
      externalInventoryItemId: nonblank(row.external_inventory_item_id, "externalInventoryItemId"),
      externalSku: row.external_sku == null ? null : nonblank(row.external_sku, "externalSku"),
    };
  });
}

async function lockRunningRun(client: PoolClient, readbackRunId: string): Promise<void> {
  const run = (await client.query<{ state: string }>(
    `SELECT state FROM inventory.inventory_publication_readback_runs WHERE id = $1 FOR UPDATE`,
    [readbackRunId],
  )).rows[0];
  if (!run || run.state !== "running") {
    throw new InventoryPublicationReadbackRepositoryError(
      "PUBLICATION_READBACK_RUN_NOT_RUNNING",
      "The provider-readback run is not open for evidence.",
    );
  }
}

async function inTransaction<T>(connectionPool: ClientPool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await connectionPool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    const result = await work(client);
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function resultWithoutReplay(result: InventoryPublicationReadbackRun): Omit<InventoryPublicationReadbackRun, "alreadyApplied"> {
  const { alreadyApplied: _alreadyApplied, ...persisted } = result;
  return persisted;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InventoryPublicationReadbackRepositoryError("PUBLICATION_READBACK_DATABASE_INVALID", `${field} must be positive.`);
  }
  return parsed;
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  return value == null ? null : positiveInteger(value, field);
}

function destinationKind(value: unknown): "channel_connection" | "dropship_store_connection" {
  if (value === "channel_connection" || value === "dropship_store_connection") return value;
  throw new InventoryPublicationReadbackRepositoryError(
    "PUBLICATION_READBACK_DATABASE_INVALID",
    "Publication destination kind is invalid.",
  );
}

function assertDestination(
  kind: "channel_connection" | "dropship_store_connection",
  channelConnectionId: number | null,
  dropshipStoreConnectionId: number | null,
): void {
  if ((kind === "channel_connection" && channelConnectionId !== null && dropshipStoreConnectionId === null)
    || (kind === "dropship_store_connection" && channelConnectionId === null
      && dropshipStoreConnectionId !== null)) return;
  throw new InventoryPublicationReadbackRepositoryError(
    "PUBLICATION_READBACK_DATABASE_INVALID",
    "Publication destination ownership is inconsistent.",
  );
}

function positiveBigint(value: unknown, field: string): string {
  const parsed = String(value ?? "");
  if (!/^[1-9]\d*$/.test(parsed)) {
    throw new InventoryPublicationReadbackRepositoryError("PUBLICATION_READBACK_DATABASE_INVALID", `${field} must be positive.`);
  }
  return parsed;
}

function nonblank(value: unknown, field: string): string {
  const parsed = String(value ?? "").trim();
  if (!parsed) {
    throw new InventoryPublicationReadbackRepositoryError("PUBLICATION_READBACK_DATABASE_INVALID", `${field} is required.`);
  }
  return parsed;
}

function scope(value: unknown): "account" | "location" {
  if (value === "account" || value === "location") return value;
  throw new InventoryPublicationReadbackRepositoryError("PUBLICATION_READBACK_DATABASE_INVALID", "Provider scope is invalid.");
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Classified below.
    }
  }
  throw new InventoryPublicationReadbackRepositoryError(
    "PUBLICATION_READBACK_DATABASE_INVALID",
    "Persisted provider-readback result payload is invalid.",
  );
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
