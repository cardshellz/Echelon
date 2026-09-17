import type { Pool, PoolClient } from "pg";

import {
  inventoryPublicationTargetCommandResultSchema,
  type InventoryPublicationTargetCommandResult,
} from "@shared/types/inventory-channel-exposure";
import {
  quantityPublicationScopeSchema,
  type QuantityPublicationScope,
} from "../domain/quantity-publication-admission";

import { pool } from "../../../db";
import type {
  InventoryPublicationTargetStopCommand,
  InventoryPublicationTargetStopStore,
} from "../application/inventory-publication-target-stop.service";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";
import { quantityPublicationScopeLockKey } from "./quantity-publication-admission.repository";

const IDEMPOTENCY_LOCK_NAMESPACE = 918420;
export const PUBLICATION_TARGET_SCOPE_LOCK_SEED = 918420;
const SCOPE_LOCK_SEED = PUBLICATION_TARGET_SCOPE_LOCK_SEED;
const RECEIPT_PREFIX = "inventory-publication-target:";

/** The destination identity a scope lookup needs; the stop repository's own row satisfies it. */
export interface PublicationTargetScopeSource {
  id: number;
  destination_kind: string;
  channel_connection_id: number | null;
  dropship_store_connection_id: number | null;
  provider_key: string | null;
  provider_scope_type: string;
  external_scope_id: string;
}

type TargetRow = {
  id: number;
  state: string;
  revision: string;
  destination_kind: string;
  channel_connection_id: number | null;
  dropship_store_connection_id: number | null;
  provider_key: string | null;
  provider_scope_type: string;
  external_scope_id: string;
};

export class PostgresInventoryPublicationTargetStopStore
implements InventoryPublicationTargetStopStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = pool) {}

  async stop(
    command: InventoryPublicationTargetStopCommand,
  ): Promise<InventoryPublicationTargetCommandResult> {
    const client = await this.connectionPool.connect();
    const scopeKeys: string[] = [];
    let inTransaction = false;
    let result: InventoryPublicationTargetCommandResult | undefined;
    let workError: unknown;
    let discard: Error | undefined;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      await client.query(
        "SELECT pg_advisory_xact_lock($1, hashtext($2))",
        [IDEMPOTENCY_LOCK_NAMESPACE, command.idempotencyKey],
      );
      const receiptKey = `${RECEIPT_PREFIX}${command.idempotencyKey}`;
      const replay = await loadReplay(client, receiptKey, command.requestHash);
      if (replay) {
        result = replay;
        await client.query("COMMIT");
        inTransaction = false;
      } else {
        const targetRows = (await client.query<TargetRow>(
          `SELECT target.id, target.state, target.revision::text,
                  target.destination_kind, target.channel_connection_id,
                  target.dropship_store_connection_id,
                  lower(CASE target.destination_kind
                    WHEN 'channel_connection' THEN channel_row.provider
                    WHEN 'dropship_store_connection' THEN dropship_connection.platform
                  END) AS provider_key,
                  target.provider_scope_type, target.external_scope_id
           FROM inventory.inventory_publication_targets AS target
           JOIN channels.channels AS channel_row ON channel_row.id = target.channel_id
           LEFT JOIN dropship.dropship_store_connections AS dropship_connection
             ON dropship_connection.id = target.dropship_store_connection_id
           WHERE target.id = $1
           FOR UPDATE OF target`,
          [command.publicationTargetId],
        )).rows;
        if (targetRows.length !== 1) {
          throw targetError(404, "INVENTORY_PUBLICATION_TARGET_NOT_FOUND",
            "The publication target does not exist.");
        }
        const target = targetRows[0]!;
        if (target.revision !== command.expectedRevision) {
          throw targetError(409, "INVENTORY_PUBLICATION_TARGET_STOP_STALE",
            "The publication target changed. Reload it before stopping publication.");
        }
        if (target.state !== "live") {
          throw targetError(409, "INVENTORY_PUBLICATION_TARGET_NOT_LIVE",
            "Only a live publication target can be stopped by this command.");
        }

        const scopes = await loadPublicationTargetScopes(client, target);
        for (const scope of scopes.sort((left, right) =>
          quantityPublicationScopeLockKey(left).localeCompare(quantityPublicationScopeLockKey(right)))) {
          const scopeKey = quantityPublicationScopeLockKey(scope);
          const acquired = (await client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,$2)) AS acquired",
            [scopeKey, SCOPE_LOCK_SEED],
          )).rows[0]?.acquired === true;
          if (!acquired) {
            throw targetError(
              409,
              "INVENTORY_PUBLICATION_TARGET_BUSY",
              "A provider quantity request is in flight for this target. Retry after it finishes; the target was not changed.",
            );
          }
          scopeKeys.push(scopeKey);
        }

        await client.query(
          `INSERT INTO public.idempotency_keys(
             key, request_hash, response_body, created_at, expires_at
           ) VALUES ($1,$2,NULL,$3,NULL)`,
          [receiptKey, command.requestHash, command.occurredAt],
        );
        const updated = await client.query<{ revision: string }>(
          `UPDATE inventory.inventory_publication_targets
           SET state='disabled', activated_by=NULL, activated_at=NULL,
               revision=revision+1, updated_at=$3
           WHERE id=$1 AND revision=$2::bigint AND state='live'
           RETURNING revision::text`,
          [command.publicationTargetId, command.expectedRevision, command.occurredAt],
        );
        if (updated.rowCount !== 1) {
          throw targetError(409, "INVENTORY_PUBLICATION_TARGET_STOP_CONCURRENT_CHANGE",
            "A concurrent target change prevented the stop command. Reload and retry.");
        }
        await client.query(
          `UPDATE inventory.inventory_publication_outbox
           SET state='superseded', lease_token=NULL, lease_expires_at=NULL,
               last_error_class='PUBLICATION_TARGET_STOPPED',
               last_error_message=$2, updated_at=$3
           WHERE publication_target_id=$1
             AND state IN ('desired','queued','leased','retryable','drifted')`,
          [command.publicationTargetId, command.changeReason, command.occurredAt],
        );
        result = inventoryPublicationTargetCommandResultSchema.parse({
          publicationTargetId: command.publicationTargetId,
          revision: updated.rows[0]!.revision,
          state: "disabled",
          alreadyApplied: false,
          runtimeAuthorityChanged: false,
          providerWriteAttempted: false,
          outboxEnqueued: false,
        });
        await client.query(
          `INSERT INTO public.audit_events(
             timestamp, level, actor, action, target, changes, context
           ) VALUES ($1,'AUDIT',$2,$3,$4,$5::jsonb,$6::jsonb)`,
          [
            command.occurredAt,
            command.actorId,
            "inventory_availability.publication_target.stopped",
            `inventory.inventory_publication_target:${command.publicationTargetId}`,
            JSON.stringify({
              before: { state: "live", revision: command.expectedRevision },
              after: { state: "disabled", revision: result.revision },
            }),
            JSON.stringify({
              reason: command.changeReason,
              idempotencyKey: command.idempotencyKey,
              requestHash: command.requestHash,
              exactScopeCount: scopes.length,
            }),
          ],
        );
        await client.query(
          `UPDATE public.idempotency_keys
           SET response_body=$2::jsonb
           WHERE key=$1`,
          [receiptKey, JSON.stringify({ commandType: "inventory_publication_target_stop", result })],
        );
        await client.query("COMMIT");
        inTransaction = false;
      }
    } catch (error) {
      workError = error;
      if (inTransaction) {
        try {
          await client.query("ROLLBACK");
          inTransaction = false;
        } catch (rollbackError) {
          discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
      }
    } finally {
      for (const scopeKey of scopeKeys.reverse()) {
        try {
          const released = (await client.query<{ released: boolean }>(
            "SELECT pg_advisory_unlock(hashtextextended($1,$2)) AS released",
            [scopeKey, SCOPE_LOCK_SEED],
          )).rows[0]?.released;
          if (!released) discard = new Error("Publication target scope-lock release was not confirmed.");
        } catch (error) {
          discard = error instanceof Error ? error : new Error(String(error));
        }
      }
      client.release(discard);
    }
    if (workError) throw workError;
    if (discard) {
      throw targetError(
        503,
        "INVENTORY_PUBLICATION_TARGET_STOP_CLEANUP_UNCERTAIN",
        "The target command outcome may have committed, but connection cleanup was uncertain. Retry the same idempotency key.",
      );
    }
    if (!result) {
      throw targetError(500, "INVENTORY_PUBLICATION_TARGET_STOP_RESULT_MISSING",
        "The target-stop transaction returned no result.");
    }
    return result;
  }
}

/**
 * Every exact provider quantity scope a live target can currently touch: its
 * active SKU mappings plus any outbox rows still in flight. Commands that
 * change what the target publishes lock these first, so they never race a
 * provider request that is mid-flight for the same SKU.
 */
export async function loadPublicationTargetScopes(
  client: PoolClient,
  target: PublicationTargetScopeSource,
): Promise<QuantityPublicationScope[]> {
  const connectionId = target.destination_kind === "channel_connection"
    ? target.channel_connection_id
    : target.dropship_store_connection_id;
  if (!connectionId || !target.provider_key) {
    throw targetError(409, "INVENTORY_PUBLICATION_TARGET_IDENTITY_INVALID",
      "The live publication target has an incomplete destination identity.");
  }
  const inventoryItems = (await client.query<{ external_inventory_item_id: string }>(
    `SELECT mapping.external_inventory_item_id
     FROM inventory.publication_variant_mapping_heads AS head
     JOIN inventory.publication_variant_mapping_versions AS mapping
       ON mapping.id=head.active_mapping_id
     WHERE head.publication_target_id=$1
     UNION
     SELECT outbox.external_inventory_item_id_snapshot
     FROM inventory.inventory_publication_outbox AS outbox
     WHERE outbox.publication_target_id=$1
       AND outbox.state IN ('desired','queued','leased','retryable','drifted','acknowledged')
     ORDER BY 1`,
    [target.id],
  )).rows;
  const scopes = inventoryItems.map((item) => quantityPublicationScopeSchema.parse({
    destinationKind: target.destination_kind,
    connectionId,
    providerKey: target.provider_key,
    providerScopeType: target.provider_scope_type,
    externalScopeId: target.external_scope_id,
    externalInventoryItemId: item.external_inventory_item_id,
    productId: null,
    productVariantId: null,
  }));
  const unique = new Map(scopes.map((scope) => [quantityPublicationScopeLockKey(scope), scope]));
  return [...unique.values()];
}

async function loadReplay(
  client: PoolClient,
  receiptKey: string,
  requestHash: string,
): Promise<InventoryPublicationTargetCommandResult | null> {
  const receipt = (await client.query<{ request_hash: string; response_body: unknown }>(
    "SELECT request_hash,response_body FROM public.idempotency_keys WHERE key=$1",
    [receiptKey],
  )).rows[0];
  if (!receipt) return null;
  if (receipt.request_hash !== requestHash) {
    throw targetError(409, "INVENTORY_PUBLICATION_TARGET_IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used with different inputs.");
  }
  const body = receipt.response_body as Record<string, unknown> | null;
  const parsed = inventoryPublicationTargetCommandResultSchema.safeParse(body?.result);
  if (!parsed.success) {
    throw targetError(500, "INVENTORY_PUBLICATION_TARGET_RECEIPT_INVALID",
      "The prior target command has an incomplete receipt.");
  }
  return { ...parsed.data, alreadyApplied: true };
}

function targetError(status: number, code: string, message: string): InventoryAvailabilityMasterDataError {
  return new InventoryAvailabilityMasterDataError(status, code, message);
}
