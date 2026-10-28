import type { InventoryAvailabilityTransactionQueryClient } from "../application/inventory-availability-transaction-query.port";
import { STOCK_LINK_ERROR_CODES, StockLinkError } from "../domain/stock-link-errors";
import { assertInventoryCutoverFenceHeldInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { PUBLICATION_IDENTITY_RETIRED } from "./inventory-publication-outbox.repository";

/**
 * The stock-link engine's retire step (channels PR2, PLAN-CH2 v4.1 §4.3 step 7): a sealed link that no longer names
 * this size's store item stops being the link. The head loses its active version (revision + 1), the version moves
 * sealed → retired (the only lifecycle move migrations/0633_inventory_publication_readiness.sql allows after sealing),
 * and every outbox row of the pair that still names the retired item and can still reach the store is superseded,
 * so no stock is sent to an item that is no longer this size's. A stale publisher that enqueues the old item after
 * this commit is stopped at the worker by the identity check in runIfCurrent (§4.8, N5).
 *
 * Does not open a transaction: the caller owns it, the inventory cutover fence (mapping heads and versions are
 * fence-pinned tables, migrations/236_inventory_cutover_admission.sql) and the pair/scope locks of §4.3 step 6. A
 * retire runs before any draft of the same command (§4.3 steps 7-8), so the draft writer's identity check
 * (inventory-channel-exposure-admin.repository.ts saveVariantMappingDraftInsideTransaction) no longer sees the
 * freed item and its new version takes the retired one as predecessor (§4.4).
 *
 * No provider I/O. A CHECK refusal (23514) is left raw: classifyStockLinkFailure makes it the permanent
 * STOCK_LINK_CHECK_VIOLATION (BUILD-NOTES D-P2-6).
 */

/** Every outbox state that can still reach a provider: the target stop path's set
 * (inventory-publication-target-stop.repository.ts). A leased row is included: its worker is not inside
 * runIfCurrent (the engine holds the pair key there, §4.3 step 6), so superseding it ends that lease and the worker
 * finds PUBLICATION_LEASE_LOST before any provider call. */
export const STOCK_LINK_RETIRE_SUPERSEDE_STATES: readonly string[] = Object.freeze(
  ["desired", "queued", "leased", "retryable", "drifted"]);

const SUPERSEDED_MESSAGE = "The stock link to this store item was retired; no provider request was made.";

export interface StockLinkRetireMember {
  productVariantId: number;
  /** The sealed version the head's active pointer names now (the decision's replacesMappingId). */
  mappingId: number;
  /** The head revision the decision was made on; any other revision means the head changed since. */
  expectedHeadRevision: string;
}

export interface StockLinkRetireInput {
  publicationTargetId: number;
  members: readonly StockLinkRetireMember[];
  actor: string;
  reason: string;
  /** The injected clock. retired_at = GREATEST(now, sealed_at): the version CHECK requires retired_at >= sealed_at,
   * and a version sealed by another process whose clock runs ahead must still retire (PG 10). */
  now: Date;
}

export interface StockLinkRetiredMapping {
  productVariantId: number;
  mappingId: number;
  externalInventoryItemId: string;
  externalSku: string | null;
  sealedAt: string;
  retiredAt: string;
  /** The head revision after the retire; a draft written for the same size in this command expects it. */
  headRevision: string;
  /** Outbox rows of the pair superseded with PUBLICATION_IDENTITY_RETIRED, in id order. */
  supersededOutboxIds: string[];
}

export async function retireStockLinkMappingsInsideTransaction(client: InventoryAvailabilityTransactionQueryClient,
  input: StockLinkRetireInput): Promise<StockLinkRetiredMapping[]> {
  const targetId = positiveId(input.publicationTargetId, "publicationTargetId");
  const actor = boundedText(input.actor, "actor", 100);
  const reason = boundedText(input.reason, "reason", 1000);
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime()))
    throw invalid("A retire needs a valid clock time.", { now: String(input.now) });
  const members = [...input.members].sort((left, right) => left.productVariantId - right.productVariantId);
  if (members.length === 0) return [];
  for (const [index, member] of members.entries()) {
    positiveId(member.productVariantId, "productVariantId");
    positiveId(member.mappingId, "mappingId");
    if (!/^[1-9][0-9]*$/.test(member.expectedHeadRevision))
      throw invalid("A retire needs the head revision it was decided on.", { productVariantId: member.productVariantId });
    if (index > 0 && members[index - 1]!.productVariantId === member.productVariantId)
      throw invalid("A retire names a size twice.", { productVariantId: member.productVariantId });
  }
  await assertInventoryCutoverFenceHeldInsideTransaction(client);
  const retired: StockLinkRetiredMapping[] = [];
  for (const member of members) {
    const head = await client.query<{ revision: string }>(
      `UPDATE inventory.publication_variant_mapping_heads
       SET active_mapping_id = NULL, revision = revision + 1, updated_by = $5, update_reason = $6
       WHERE publication_target_id = $1 AND product_variant_id = $2 AND active_mapping_id = $3 AND revision = $4::bigint
       RETURNING revision::text`,
      [targetId, member.productVariantId, member.mappingId, member.expectedHeadRevision, actor, reason]);
    if (head.rowCount !== 1 || head.rows.length !== 1) {
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.headChanged,
        "The size's stock link changed after it was checked; it is decided again on the next check.",
        { publicationTargetId: targetId, productVariantId: member.productVariantId, mappingId: member.mappingId,
          expectedHeadRevision: member.expectedHeadRevision });
    }
    const version = await client.query<{ external_inventory_item_id: string; external_sku: string | null;
      sealed_at: Date; retired_at: Date }>(
      `UPDATE inventory.publication_variant_mapping_versions
       SET lifecycle_status = 'retired', retired_by = $4, retired_at = GREATEST($5::timestamptz, sealed_at)
       WHERE id = $1 AND publication_target_id = $2 AND product_variant_id = $3 AND lifecycle_status = 'sealed'
       RETURNING external_inventory_item_id, external_sku, sealed_at, retired_at`,
      [member.mappingId, targetId, member.productVariantId, actor, input.now.toISOString()]);
    if (version.rowCount !== 1 || version.rows.length !== 1) {
      // The head named this version as active, so the deferred coherence trigger guarantees it was sealed: a miss
      // here is a broken invariant, not a race.
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid,
        "The active stock link of a size is not a sealed version of that size.",
        { publicationTargetId: targetId, productVariantId: member.productVariantId, mappingId: member.mappingId });
    }
    const mapping = version.rows[0]!;
    // The planner trims the mapping's item before it becomes the outbox snapshot
    // (inventory-channel-exposure-runtime.repository.ts nonblank), so the item is matched trimmed on both sides.
    const superseded = await client.query<{ id: string }>(
      `UPDATE inventory.inventory_publication_outbox
       SET state = 'superseded', lease_token = NULL, lease_expires_at = NULL,
           last_error_class = $4, last_error_message = $5
       WHERE publication_target_id = $1 AND product_variant_id = $2
         AND btrim(external_inventory_item_id_snapshot) = btrim($3)
         AND state = ANY($6::text[])
       RETURNING id::text`,
      [targetId, member.productVariantId, mapping.external_inventory_item_id.trim(), PUBLICATION_IDENTITY_RETIRED,
        SUPERSEDED_MESSAGE, STOCK_LINK_RETIRE_SUPERSEDE_STATES]);
    retired.push({
      productVariantId: member.productVariantId, mappingId: member.mappingId,
      externalInventoryItemId: mapping.external_inventory_item_id, externalSku: mapping.external_sku,
      sealedAt: new Date(mapping.sealed_at).toISOString(), retiredAt: new Date(mapping.retired_at).toISOString(),
      headRevision: head.rows[0]!.revision,
      supersededOutboxIds: superseded.rows.map(row => row.id).sort((left, right) => compareDecimal(left, right)),
    });
  }
  return retired;
}

function compareDecimal(left: string, right: string): number {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}

function positiveId(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(`A retire needs a positive ${field}.`, { [field]: value });
  return value;
}

function boundedText(value: string, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > max || value !== value.trim())
    throw invalid(`A retire needs a trimmed ${field} of 1 to ${max} characters.`, { field });
  return value;
}

function invalid(message: string, context: Record<string, unknown>): StockLinkError {
  return new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, message, context);
}
