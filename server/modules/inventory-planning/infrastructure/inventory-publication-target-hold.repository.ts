import type { Pool, PoolClient } from "pg";

import {
  inventoryPublicationTargetHoldResultSchema,
  type InventoryPublicationTargetHoldDestination,
  type InventoryPublicationTargetHoldResult,
} from "@shared/types/inventory-channel-exposure";

import { pool } from "../../../db";
import type {
  InventoryPublicationTargetHoldCommand,
  InventoryPublicationTargetHoldStore,
} from "../application/inventory-publication-target-hold.service";
import { InventoryAvailabilityRuntimePublicationError } from "../application/inventory-availability-runtime-publication.service";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";
import { createTransactionScopedInventoryPublicationService } from "./inventory-availability-runtime-publication.repository";
import {
  loadPublicationTargetScopes,
  PUBLICATION_TARGET_SCOPE_LOCK_SEED,
} from "./inventory-publication-target-stop.repository";
import { quantityPublicationScopeLockKey } from "./quantity-publication-admission.repository";

/**
 * Applies a hold or a release to every live Echelon target of one destination
 * and republishes the affected products in the same transaction, so the
 * marketplace sees the zeros (or the restored quantities) as soon as the
 * outbox drains. Mirrors the target-stop store: idempotency receipts in
 * `public.idempotency_keys`, session advisory locks on every exact provider
 * scope so an in-flight quantity request is never raced, an audit row per
 * changed target, and a SERIALIZABLE transaction because the transaction-
 * scoped publisher demands one.
 */

const RECEIPT_PREFIX = "inventory-publication-target:";
const PRODUCT_SAVEPOINT = "publication_target_hold_product";

interface TargetRow {
  id: number;
  state: string;
  revision: string;
  channel_id: number;
  destination_kind: string;
  channel_connection_id: number | null;
  dropship_store_connection_id: number | null;
  provider_key: string | null;
  provider_scope_type: string;
  external_scope_id: string;
  hold_reason: string | null;
}

interface RepublishOutcome {
  publicationRows: number;
  blockedProductIds: number[];
}

export class PostgresInventoryPublicationTargetHoldStore implements InventoryPublicationTargetHoldStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = pool) {}

  async apply(command: InventoryPublicationTargetHoldCommand): Promise<InventoryPublicationTargetHoldResult> {
    const client = await this.connectionPool.connect();
    const scopeKeys: string[] = [];
    let inTransaction = false;
    let result: InventoryPublicationTargetHoldResult | undefined;
    let workError: unknown;
    let discard: Error | undefined;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      inTransaction = true;
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      const receiptKey = `${RECEIPT_PREFIX}${command.idempotencyKey}`;
      const replay = await loadReplay(client, receiptKey, command.requestHash);
      if (replay) {
        result = replay;
        await client.query("COMMIT");
        inTransaction = false;
      } else {
        const targets = await loadLiveTargets(client, command.destination);
        const wantsHold = command.command === "hold";
        const changing = targets.filter((target) => (target.hold_reason === null) === wantsHold);

        // Lock every exact provider scope of a target that is about to change
        // what it publishes; a quantity request already in flight wins.
        for (const target of changing) {
          const scopes = await loadPublicationTargetScopes(client, target);
          for (const scope of scopes.sort((left, right) =>
            quantityPublicationScopeLockKey(left).localeCompare(quantityPublicationScopeLockKey(right)))) {
            const scopeKey = quantityPublicationScopeLockKey(scope);
            const acquired = (await client.query<{ acquired: boolean }>(
              "SELECT pg_try_advisory_lock(hashtextextended($1,$2)) AS acquired",
              [scopeKey, PUBLICATION_TARGET_SCOPE_LOCK_SEED],
            )).rows[0]?.acquired === true;
            if (!acquired) {
              throw holdError(
                409,
                "INVENTORY_PUBLICATION_TARGET_BUSY",
                "A provider quantity request is in flight for this destination. Retry after it finishes; nothing was changed.",
              );
            }
            scopeKeys.push(scopeKey);
          }
        }

        await client.query(
          `INSERT INTO public.idempotency_keys(
             key, request_hash, response_body, created_at, expires_at
           ) VALUES ($1,$2,NULL,$3,NULL)`,
          [receiptKey, command.requestHash, command.occurredAt],
        );

        const targetResults: InventoryPublicationTargetHoldResult["targets"] = [];
        for (const target of targets) {
          const changed = changing.includes(target);
          if (!changed) {
            targetResults.push({
              publicationTargetId: target.id,
              revision: target.revision,
              changed: false,
              publicationRows: 0,
              blockedProductIds: [],
            });
            continue;
          }
          const updated = await client.query<{ revision: string }>(
            wantsHold
              ? `UPDATE inventory.inventory_publication_targets
                 SET hold_reason=$3, held_at=$4, held_by=$5, revision=revision+1, updated_at=$4
                 WHERE id=$1 AND revision=$2::bigint AND state='live' AND hold_reason IS NULL
                 RETURNING revision::text`
              : `UPDATE inventory.inventory_publication_targets
                 SET hold_reason=NULL, held_at=NULL, held_by=NULL, revision=revision+1, updated_at=$4
                 WHERE id=$1 AND revision=$2::bigint AND state='live' AND hold_reason IS NOT NULL
                 RETURNING revision::text`,
            wantsHold
              ? [target.id, target.revision, command.reason, command.occurredAt, command.actorId]
              : [target.id, target.revision, null, command.occurredAt],
          );
          if (updated.rowCount !== 1) {
            throw holdError(
              409,
              "INVENTORY_PUBLICATION_TARGET_HOLD_CONCURRENT_CHANGE",
              `A concurrent target change prevented the ${command.command} command. Retry it.`,
            );
          }
          const republished = await republishTarget(client, target, command);
          targetResults.push({
            publicationTargetId: target.id,
            revision: updated.rows[0]!.revision,
            changed: true,
            publicationRows: republished.publicationRows,
            blockedProductIds: republished.blockedProductIds,
          });
          await client.query(
            `INSERT INTO public.audit_events(
               timestamp, level, actor, action, target, changes, context
             ) VALUES ($1,'AUDIT',$2,$3,$4,$5::jsonb,$6::jsonb)`,
            [
              command.occurredAt,
              command.actorId,
              wantsHold
                ? "inventory_availability.publication_target.held"
                : "inventory_availability.publication_target.released",
              `inventory.inventory_publication_target:${target.id}`,
              JSON.stringify({
                before: { hold: wantsHold ? null : { reason: target.hold_reason }, revision: target.revision },
                after: { hold: wantsHold ? { reason: command.reason } : null, revision: updated.rows[0]!.revision },
              }),
              JSON.stringify({
                reason: command.reason,
                destination: command.destination,
                idempotencyKey: command.idempotencyKey,
                requestHash: command.requestHash,
                publicationRows: republished.publicationRows,
                blockedProductIds: republished.blockedProductIds,
              }),
            ],
          );
        }

        result = inventoryPublicationTargetHoldResultSchema.parse({
          destination: command.destination,
          command: command.command,
          targets: targetResults,
          alreadyApplied: false,
          runtimeAuthorityChanged: false,
          providerWriteAttempted: false,
          outboxEnqueued: targetResults.some((target) => target.publicationRows > 0),
        });
        await client.query(
          `UPDATE public.idempotency_keys
           SET response_body=$2::jsonb
           WHERE key=$1`,
          [receiptKey, JSON.stringify({ commandType: `inventory_publication_target_${command.command}`, result })],
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
            [scopeKey, PUBLICATION_TARGET_SCOPE_LOCK_SEED],
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
      throw holdError(
        503,
        "INVENTORY_PUBLICATION_TARGET_HOLD_CLEANUP_UNCERTAIN",
        "The command outcome may have committed, but connection cleanup was uncertain. Retry the same idempotency key.",
      );
    }
    if (!result) {
      throw holdError(500, "INVENTORY_PUBLICATION_TARGET_HOLD_RESULT_MISSING",
        "The publication-target hold transaction returned no result.");
    }
    return result;
  }
}

async function loadLiveTargets(
  client: PoolClient,
  destination: InventoryPublicationTargetHoldDestination,
): Promise<TargetRow[]> {
  return (await client.query<TargetRow>(
    `SELECT target.id, target.state, target.revision::text, target.channel_id,
            target.destination_kind, target.channel_connection_id,
            target.dropship_store_connection_id,
            lower(CASE target.destination_kind
              WHEN 'channel_connection' THEN channel_row.provider
              WHEN 'dropship_store_connection' THEN dropship_connection.platform
            END) AS provider_key,
            target.provider_scope_type, target.external_scope_id, target.hold_reason
     FROM inventory.inventory_publication_targets AS target
     JOIN channels.channels AS channel_row ON channel_row.id = target.channel_id
     LEFT JOIN dropship.dropship_store_connections AS dropship_connection
       ON dropship_connection.id = target.dropship_store_connection_id
     WHERE target.state = 'live'
       AND target.publication_authority = 'echelon'
       AND target.destination_kind = $1
       AND COALESCE(target.channel_connection_id, target.dropship_store_connection_id) = $2
     ORDER BY target.id
     FOR UPDATE OF target`,
    [destination.destinationKind, destination.connectionId],
  )).rows;
}

/**
 * Republish every mapped, sellable product of the target so the outbox carries
 * the post-command quantities. A product the canonical planner refuses is
 * recorded and skipped under a savepoint rather than failing the command: a
 * hold is a safety action and must land even when one product's evidence is
 * incomplete. While legacy authority owns publication there is nothing to
 * enqueue; the hold is still recorded for the runtime to honor later.
 */
async function republishTarget(
  client: PoolClient,
  target: TargetRow,
  command: InventoryPublicationTargetHoldCommand,
): Promise<RepublishOutcome> {
  const publisher = createTransactionScopedInventoryPublicationService(client, { channelId: target.channel_id });
  const productIds = await listTargetProductIds(client, target.id);
  const outcome: RepublishOutcome = { publicationRows: 0, blockedProductIds: [] };
  for (const productId of productIds) {
    await client.query(`SAVEPOINT ${PRODUCT_SAVEPOINT}`);
    try {
      const routed = await publisher.publishProduct({
        productId,
        publicationTargetId: target.id,
        channelId: target.channel_id,
        dryRun: false,
        triggeredBy: command.command === "hold" ? "publication_target_hold" : "publication_target_release",
      }, async () => null);
      await client.query(`RELEASE SAVEPOINT ${PRODUCT_SAVEPOINT}`);
      if (routed.authority === "legacy") {
        return outcome;
      }
      outcome.publicationRows += routed.publication.enqueuedRows;
    } catch (error) {
      if (!(error instanceof InventoryAvailabilityRuntimePublicationError)) throw error;
      await client.query(`ROLLBACK TO SAVEPOINT ${PRODUCT_SAVEPOINT}`);
      outcome.blockedProductIds.push(productId);
    }
  }
  return outcome;
}

async function listTargetProductIds(client: PoolClient, publicationTargetId: number): Promise<number[]> {
  const rows = (await client.query<{ product_id: number }>(
    `SELECT DISTINCT variant.product_id
     FROM inventory.publication_variant_mapping_heads AS mapping_head
     JOIN catalog.product_variants AS variant
       ON variant.id = mapping_head.product_variant_id
     WHERE mapping_head.publication_target_id = $1
       AND mapping_head.active_mapping_id IS NOT NULL
       AND variant.is_active = true
       AND variant.requires_shipping = true
       AND COALESCE(variant.track_inventory, true) = true
       AND variant.sales_eligibility = 'sellable'
     ORDER BY variant.product_id`,
    [publicationTargetId],
  )).rows;
  return rows.map((row) => Number(row.product_id));
}

async function loadReplay(
  client: PoolClient,
  receiptKey: string,
  requestHash: string,
): Promise<InventoryPublicationTargetHoldResult | null> {
  const receipt = (await client.query<{ request_hash: string; response_body: unknown }>(
    "SELECT request_hash,response_body FROM public.idempotency_keys WHERE key=$1",
    [receiptKey],
  )).rows[0];
  if (!receipt) return null;
  if (receipt.request_hash !== requestHash) {
    throw holdError(409, "INVENTORY_PUBLICATION_TARGET_IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used with different inputs.");
  }
  const body = receipt.response_body as Record<string, unknown> | null;
  const parsed = inventoryPublicationTargetHoldResultSchema.safeParse(body?.result);
  if (!parsed.success) {
    throw holdError(500, "INVENTORY_PUBLICATION_TARGET_RECEIPT_INVALID",
      "The prior target command has an incomplete receipt.");
  }
  return { ...parsed.data, alreadyApplied: true };
}

function holdError(status: number, code: string, message: string): InventoryAvailabilityMasterDataError {
  return new InventoryAvailabilityMasterDataError(status, code, message);
}
