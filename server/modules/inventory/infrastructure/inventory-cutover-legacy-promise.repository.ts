import { z } from "zod";
import { cutoverLegacyPromiseReleaseSchema, cutoverReconstructionCommitSchema } from "@shared/types/inventory-cutover-reconstruction";
import type { InventoryCutoverLegacyPromisePort } from "../../inventory-planning/application/inventory-cutover-legacy-promise.port";
import { readInventoryCutoverReconstruction } from "./inventory-cutover-reconstruction.reader";

export class InventoryCutoverLegacyPromiseError extends Error {
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(message, options); this.name = "InventoryCutoverLegacyPromiseError";
  }
}

/** This is not a generic reservation repair. It only removes a reviewed,
 * completely owned, unbacked empty-bin promise immediately before its accepted
 * demand is replanned in the SAME admitted transaction. Lots and COGS never move. */
export class PostgresInventoryCutoverLegacyPromiseRepository implements InventoryCutoverLegacyPromisePort {
  async releaseForReplanning(input: Parameters<InventoryCutoverLegacyPromisePort["releaseForReplanning"]>[0]): Promise<number[]> {
    const command = cutoverReconstructionCommitSchema.safeParse(input.command);
    const parsed = z.array(cutoverLegacyPromiseReleaseSchema).safeParse(input.releases);
    if (!command.success || !parsed.success) throw new InventoryCutoverLegacyPromiseError(
      "CUTOVER_PROMISE_INPUT_INVALID", "Invalid reviewed legacy promise handoff.");
    const releases = [...parsed.data].sort((a, b) => a.inventoryLevelId - b.inventoryLevelId);
    const levelIds = releases.map((release) => release.inventoryLevelId);
    const ownerIds = releases.flatMap((release) => release.owners.map((owner) => owner.orderItemId));
    if (new Set(levelIds).size !== levelIds.length || new Set(ownerIds).size !== ownerIds.length) {
      throw new InventoryCutoverLegacyPromiseError("CUTOVER_PROMISE_INPUT_INVALID", "Promise levels and owners must be unique.");
    }
    if (releases.length === 0) return [];
    try {
      const fence = (await input.client.query<{ epoch: string }>(
        "SELECT inventory.assert_cutover_admission_fence_owner()::text AS epoch")).rows;
      if (fence.length !== 1 || !/^[1-9][0-9]*$/.test(fence[0].epoch)) {
        throw new InventoryCutoverLegacyPromiseError("CUTOVER_PROMISE_FENCE_REQUIRED", "Exclusive cutover admission is required.");
      }
      const locked = await input.client.query(`SELECT id FROM inventory.inventory_levels
        WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE`, [levelIds]);
      if (locked.rows.length !== levelIds.length) throw new InventoryCutoverLegacyPromiseError(
        "CUTOVER_PROMISE_POSITION_CHANGED", "A reviewed promise level no longer exists.");
      await input.client.query(`SELECT lot.id FROM inventory.inventory_lots lot
        JOIN inventory.inventory_levels level ON level.warehouse_location_id=lot.warehouse_location_id
          AND level.product_variant_id=lot.product_variant_id
        WHERE level.id=ANY($1::integer[]) ORDER BY lot.id FOR UPDATE OF lot`, [levelIds]);
      // Reuse the inventory owner's exact journal hash, including unowned
      // transfers at BOTH endpoints. Never rebuild ownership by FIFO guessing.
      const evidence = await readInventoryCutoverReconstruction(input.client);
      const levels = new Map(evidence.levels.map((level) => [level.id, level]));
      const positionKey = (location: number | null, variant: number | null) => `${location}:${variant}`;
      const heldPositions = new Set(evidence.lots.filter((lot) => lot.onHandQty !== "0" || lot.reservedQty !== "0")
        .map((lot) => positionKey(lot.warehouseLocationId, lot.productVariantId)));
      for (const hold of evidence.buildReservations) heldPositions.add(positionKey(hold.sourceLocationId, hold.componentVariantId));
      const journalsByPosition = new Map<string, typeof evidence.journals>();
      for (const journal of evidence.journals) {
        const key = positionKey(journal.warehouseLocationId, journal.productVariantId);
        const group = journalsByPosition.get(key) ?? []; group.push(journal); journalsByPosition.set(key, group);
      }
      for (const release of releases) {
        const level = levels.get(release.inventoryLevelId);
        if (!level || level.warehouseId !== release.warehouseId || level.warehouseLocationId !== release.warehouseLocationId
          || level.productVariantId !== release.productVariantId || level.variantQty !== release.variantQty
          || level.reservedQty !== release.reservedQty || level.pickedQty !== release.pickedQty || level.packedQty !== release.packedQty) {
          throw new InventoryCutoverLegacyPromiseError("CUTOVER_PROMISE_POSITION_CHANGED", "Reviewed empty-bin counters or identity changed.",
            { inventoryLevelId: release.inventoryLevelId });
        }
        if (heldPositions.has(positionKey(release.warehouseLocationId, release.productVariantId))) {
          throw new InventoryCutoverLegacyPromiseError("CUTOVER_PROMISE_LOT_HOLD_CHANGED", "A promise position contains physical or independent lot holds.",
            { inventoryLevelId: release.inventoryLevelId });
        }
        const journals = journalsByPosition.get(positionKey(release.warehouseLocationId, release.productVariantId)) ?? [];
        const holds = journals.filter((journal) => journal.reservedQty !== "0");
        const holdsByOwner = new Map(holds.map((journal) => [`${journal.orderId}:${journal.orderItemId}`, journal]));
        if (holds.length !== release.owners.length || holdsByOwner.size !== holds.length || journals.some((journal) => journal.unknownCount !== "0")
          || release.owners.some((owner) => {
            const match = holdsByOwner.get(`${owner.orderId}:${owner.orderItemId}`);
            return !match || match.reservedQty !== owner.reservedQty || match.pickedQty !== "0"
              || match.shippedQty !== "0" || match.journalCount !== owner.journalCount || match.journalHash !== owner.journalHash;
          })) {
          throw new InventoryCutoverLegacyPromiseError("CUTOVER_PROMISE_OWNER_CHANGED", "Exact signed promise ownership changed or became incomplete.",
            { inventoryLevelId: release.inventoryLevelId });
        }
      }
      // Validate the whole batch before its first mutation. The outer transaction
      // also rolls these writes back if fresh allocation or later cutover fails.
      const transactionIds: number[] = [];
      for (const release of releases) {
        const updated = await input.client.query(`UPDATE inventory.inventory_levels
          SET reserved_qty=reserved_qty-$2::integer,updated_at=$3::timestamptz
          WHERE id=$1 AND warehouse_location_id=$4 AND product_variant_id=$5
            AND variant_qty=0 AND reserved_qty=$2::integer AND picked_qty=$6::integer AND packed_qty=0`,
        [release.inventoryLevelId, release.reservedQty, command.data.occurredAt, release.warehouseLocationId, release.productVariantId, release.pickedQty]);
        if (updated.rowCount !== 1) throw new InventoryCutoverLegacyPromiseError(
          "CUTOVER_PROMISE_COUNTER_CONFLICT", "The complete reviewed promise counter could not be handed off.", { inventoryLevelId: release.inventoryLevelId });
        for (const owner of release.owners) {
          const result = await input.client.query<{ id: number }>(`INSERT INTO inventory.inventory_transactions
            (product_variant_id,from_location_id,transaction_type,variant_qty_delta,variant_qty_before,variant_qty_after,
             reserved_qty_delta,source_state,target_state,order_id,order_item_id,reference_type,reference_id,user_id,notes,created_at)
            VALUES ($1,$2,'unreserve',0,0,0,$3::integer,'committed','on_hand',$4,$5,'inventory_cutover_promise',$6,$7,$8,$9::timestamptz) RETURNING id`,
          [release.productVariantId, release.warehouseLocationId, (-BigInt(owner.reservedQty)).toString(), owner.orderId, owner.orderItemId,
            `cutover:${command.data.activationRunId}:item:${owner.orderItemId}`, command.data.actor,
            `Demand preserved for canonical replanning; evidence ${command.data.expectedEvidenceHash}; journal ${owner.journalHash}; ${command.data.reason}`,
            command.data.occurredAt]);
          const id = result.rows[0]?.id;
          if (result.rows.length !== 1 || !Number.isSafeInteger(id) || id <= 0) throw new InventoryCutoverLegacyPromiseError(
            "CUTOVER_PROMISE_AUDIT_INVALID", "The promise handoff did not return a valid audit transaction identity.");
          transactionIds.push(id);
        }
      }
      return transactionIds;
    } catch (cause) {
      if (cause instanceof InventoryCutoverLegacyPromiseError) throw cause;
      const postgresCode = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : null;
      throw new InventoryCutoverLegacyPromiseError("CUTOVER_PROMISE_DATABASE_ERROR", "The legacy promise handoff failed; its caller must roll back.",
        { postgresCode }, { cause });
    }
  }
}
