import type { Pool, PoolClient } from "pg";

import {
  inventoryPublicationTargetVariantHoldResultSchema,
  type InventoryPublicationTargetVariantHoldResult,
} from "@shared/types/inventory-channel-exposure";

import { pool } from "../../../db";
import type {
  InventoryPublicationTargetVariantHoldCommand,
  InventoryPublicationTargetVariantHoldStore,
} from "../application/inventory-publication-target-variant-hold.service";
import { InventoryAvailabilityRuntimePublicationError } from "../application/inventory-availability-runtime-publication.service";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";
import { createTransactionScopedInventoryPublicationService } from "./inventory-availability-runtime-publication.repository";
import {
  loadLiveTargets,
  type PublicationTargetHoldTargetRow,
} from "./inventory-publication-target-hold.repository";
import {
  loadPublicationTargetScopes,
  PUBLICATION_TARGET_SCOPE_LOCK_SEED,
} from "./inventory-publication-target-stop.repository";
import { quantityPublicationScopeLockKey } from "./quantity-publication-admission.repository";

/**
 * Applies a SKU-level hold or release to every live Echelon target of one
 * destination and republishes the affected products in the same transaction,
 * so the marketplace sees the zeros (or the restored quantities) as soon as
 * the outbox drains. Mirrors the destination hold store: idempotency receipts
 * in `public.idempotency_keys`, session advisory locks on every exact provider
 * scope of a target about to change so an in-flight quantity request is never
 * raced, a revision bump and an audit row per changed target, and a
 * SERIALIZABLE transaction because the transaction-scoped publisher demands
 * one.
 *
 * A SKU already in the requested state is left alone and reported as
 * unchanged; a hold on a SKU the target has no mapping for is still recorded,
 * so a listing created later publishes zero from its first plan.
 */

const RECEIPT_PREFIX = "inventory-publication-target-variant:";
const PRODUCT_SAVEPOINT = "publication_target_variant_hold_product";

interface HeldVariantRow {
  product_variant_id: number;
}

interface RepublishOutcome {
  publicationRows: number;
  blockedProductIds: number[];
}

interface TargetPlan {
  target: PublicationTargetHoldTargetRow;
  /** The named SKUs this target currently holds, before the command. */
  heldBefore: number[];
  /** The named SKUs whose hold state the command changes on this target. */
  changing: number[];
}

export class PostgresInventoryPublicationTargetVariantHoldStore
implements InventoryPublicationTargetVariantHoldStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = pool) {}

  async apply(
    command: InventoryPublicationTargetVariantHoldCommand,
  ): Promise<InventoryPublicationTargetVariantHoldResult> {
    const client = await this.connectionPool.connect();
    const scopeKeys: string[] = [];
    let inTransaction = false;
    let result: InventoryPublicationTargetVariantHoldResult | undefined;
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
        const wantsHold = command.command === "hold";
        const targets = await loadLiveTargets(client, command.destination);
        const plans: TargetPlan[] = [];
        for (const target of targets) {
          const heldBefore = await loadHeldVariantIds(client, target.id, command.productVariantIds);
          const held = new Set(heldBefore);
          plans.push({
            target,
            heldBefore,
            changing: command.productVariantIds.filter((productVariantId) => held.has(productVariantId) !== wantsHold),
          });
        }

        // Lock every exact provider scope of a target that is about to change
        // what it publishes; a quantity request already in flight wins.
        for (const plan of plans.filter((candidate) => candidate.changing.length > 0)) {
          const scopes = await loadPublicationTargetScopes(client, plan.target);
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

        const targetResults: InventoryPublicationTargetVariantHoldResult["targets"] = [];
        for (const plan of plans) {
          const { target, changing } = plan;
          if (changing.length === 0) {
            targetResults.push({
              publicationTargetId: target.id,
              revision: target.revision,
              changedProductVariantIds: [],
              publicationRows: 0,
              blockedProductIds: [],
            });
            continue;
          }
          const written = wantsHold
            ? await client.query(
                `INSERT INTO inventory.inventory_publication_target_variant_holds
                   (publication_target_id, product_variant_id, hold_reason, held_at, held_by)
                 SELECT $1, product_variant_id, $3, $4, $5
                 FROM unnest($2::integer[]) AS requested(product_variant_id)
                 ON CONFLICT (publication_target_id, product_variant_id) DO NOTHING`,
                [target.id, changing, command.reason, command.occurredAt, command.actorId],
              )
            : await client.query(
                `DELETE FROM inventory.inventory_publication_target_variant_holds
                 WHERE publication_target_id = $1
                   AND product_variant_id = ANY($2::integer[])`,
                [target.id, changing],
              );
          if (written.rowCount !== changing.length) {
            throw holdError(
              409,
              "INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_CONCURRENT_CHANGE",
              `A concurrent SKU hold change prevented the ${command.command} command. Retry it.`,
            );
          }
          const updated = await client.query<{ revision: string }>(
            `UPDATE inventory.inventory_publication_targets
             SET revision=revision+1, updated_at=$3
             WHERE id=$1 AND revision=$2::bigint AND state='live'
             RETURNING revision::text`,
            [target.id, target.revision, command.occurredAt],
          );
          if (updated.rowCount !== 1) {
            throw holdError(
              409,
              "INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_CONCURRENT_CHANGE",
              `A concurrent target change prevented the ${command.command} command. Retry it.`,
            );
          }
          const republished = await republishChangedProducts(client, target, changing, command);
          const heldAfter = wantsHold
            ? [...new Set([...plan.heldBefore, ...changing])].sort((a, b) => a - b)
            : plan.heldBefore.filter((productVariantId) => !changing.includes(productVariantId));
          targetResults.push({
            publicationTargetId: target.id,
            revision: updated.rows[0]!.revision,
            changedProductVariantIds: changing,
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
                ? "inventory_availability.publication_target.variants_held"
                : "inventory_availability.publication_target.variants_released",
              `inventory.inventory_publication_target:${target.id}`,
              JSON.stringify({
                before: { heldProductVariantIds: plan.heldBefore, revision: target.revision },
                after: { heldProductVariantIds: heldAfter, revision: updated.rows[0]!.revision },
              }),
              JSON.stringify({
                reason: command.reason,
                destination: command.destination,
                productVariantIds: command.productVariantIds,
                changedProductVariantIds: changing,
                idempotencyKey: command.idempotencyKey,
                requestHash: command.requestHash,
                publicationRows: republished.publicationRows,
                blockedProductIds: republished.blockedProductIds,
              }),
            ],
          );
        }

        result = inventoryPublicationTargetVariantHoldResultSchema.parse({
          destination: command.destination,
          command: command.command,
          productVariantIds: command.productVariantIds,
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
          [receiptKey, JSON.stringify({ commandType: `inventory_publication_target_variant_${command.command}`, result })],
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
        "INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_CLEANUP_UNCERTAIN",
        "The command outcome may have committed, but connection cleanup was uncertain. Retry the same idempotency key.",
      );
    }
    if (!result) {
      throw holdError(500, "INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_RESULT_MISSING",
        "The publication-target SKU hold transaction returned no result.");
    }
    return result;
  }
}

/** The named SKUs this target currently holds, locked for the rest of the command. */
async function loadHeldVariantIds(
  client: PoolClient,
  publicationTargetId: number,
  productVariantIds: readonly number[],
): Promise<number[]> {
  const rows = (await client.query<HeldVariantRow>(
    `SELECT product_variant_id
     FROM inventory.inventory_publication_target_variant_holds
     WHERE publication_target_id = $1
       AND product_variant_id = ANY($2::integer[])
     ORDER BY product_variant_id
     FOR UPDATE`,
    [publicationTargetId, productVariantIds],
  )).rows;
  return rows.map((row) => Number(row.product_variant_id));
}

/**
 * Republish the mapped, sellable products of the SKUs the command changed so
 * the outbox carries the post-command quantities. A product the canonical
 * planner refuses is recorded and skipped under a savepoint rather than
 * failing the command: a hold is a safety action and must land even when one
 * product's evidence is incomplete. While legacy authority owns publication
 * there is nothing to enqueue; the hold is still recorded for the runtime to
 * honor later.
 */
async function republishChangedProducts(
  client: PoolClient,
  target: PublicationTargetHoldTargetRow,
  productVariantIds: readonly number[],
  command: InventoryPublicationTargetVariantHoldCommand,
): Promise<RepublishOutcome> {
  const publisher = createTransactionScopedInventoryPublicationService(client, { channelId: target.channel_id });
  const productIds = await listMappedProductIds(client, target.id, productVariantIds);
  const outcome: RepublishOutcome = { publicationRows: 0, blockedProductIds: [] };
  for (const productId of productIds) {
    await client.query(`SAVEPOINT ${PRODUCT_SAVEPOINT}`);
    try {
      const routed = await publisher.publishProduct({
        productId,
        publicationTargetId: target.id,
        channelId: target.channel_id,
        dryRun: false,
        triggeredBy: command.command === "hold"
          ? "publication_target_variant_hold"
          : "publication_target_variant_release",
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

async function listMappedProductIds(
  client: PoolClient,
  publicationTargetId: number,
  productVariantIds: readonly number[],
): Promise<number[]> {
  const rows = (await client.query<{ product_id: number }>(
    `SELECT DISTINCT variant.product_id
     FROM inventory.publication_variant_mapping_heads AS mapping_head
     JOIN catalog.product_variants AS variant
       ON variant.id = mapping_head.product_variant_id
     WHERE mapping_head.publication_target_id = $1
       AND mapping_head.product_variant_id = ANY($2::integer[])
       AND mapping_head.active_mapping_id IS NOT NULL
       AND variant.is_active = true
       AND variant.requires_shipping = true
       AND COALESCE(variant.track_inventory, true) = true
       AND variant.sales_eligibility = 'sellable'
     ORDER BY variant.product_id`,
    [publicationTargetId, productVariantIds],
  )).rows;
  return rows.map((row) => Number(row.product_id));
}

async function loadReplay(
  client: PoolClient,
  receiptKey: string,
  requestHash: string,
): Promise<InventoryPublicationTargetVariantHoldResult | null> {
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
  const parsed = inventoryPublicationTargetVariantHoldResultSchema.safeParse(body?.result);
  if (!parsed.success) {
    throw holdError(500, "INVENTORY_PUBLICATION_TARGET_RECEIPT_INVALID",
      "The prior target command has an incomplete receipt.");
  }
  return { ...parsed.data, alreadyApplied: true };
}

function holdError(status: number, code: string, message: string): InventoryAvailabilityMasterDataError {
  return new InventoryAvailabilityMasterDataError(status, code, message);
}
