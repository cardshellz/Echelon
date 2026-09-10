import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { cutoverReconstructionCommitSchema, openingReservationRebaseSchema } from "@shared/types/inventory-cutover-reconstruction";
import type { InventoryOpeningReservationPort } from "../../inventory-planning/application/inventory-opening-reservation.port";

const translationSchema = z.object({
  command: cutoverReconstructionCommitSchema,
  snapshotId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  sourceEvidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  rebases: z.array(openingReservationRebaseSchema).min(1).max(50_000),
}).strict();
type LockedPosition = {
  id: number; warehouse_location_id: number; product_variant_id: number; warehouse_id: number;
  variant_qty: string; reserved_qty: string; picked_qty: string; packed_qty: string;
};
type LotTotals = { id: number; on_hand: string; reserved: string; picked: string; invalid: boolean };

export class InventoryOpeningReservationError extends Error {
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(message, options); this.name = "InventoryOpeningReservationError";
  }
}

/** Requires the admitted activation transaction. No lot, physical stock, costs,
 * orders or historical transactions are rewritten. Outer cutover owns replay. */
export class PostgresInventoryOpeningReservationRepository implements InventoryOpeningReservationPort {
  async translate(input: Parameters<InventoryOpeningReservationPort["translate"]>[0]): Promise<number[]> {
    const parsed = translationSchema.safeParse({ command: input.command, snapshotId: input.snapshotId,
      sourceEvidenceHash: input.sourceEvidenceHash, rebases: input.rebases });
    if (!parsed.success) throw new InventoryOpeningReservationError("OPENING_REBASE_INPUT_INVALID",
      "Counter translation requires a valid command and exact opening evidence.", { issues: parsed.error.issues });
    const { command, snapshotId, sourceEvidenceHash: sourceHash, rebases } = parsed.data;
    if (new Set(rebases.map(row => row.inventoryLevelId)).size !== rebases.length) throw new InventoryOpeningReservationError(
      "OPENING_REBASE_DUPLICATE", "Every translated position must be unique.");
    try {
      await input.client.query("SELECT inventory.assert_cutover_admission_fence_owner()");
      // The planning reader already validates/rebuilds all immutable hashes and
      // fresh source equality. Also bind this writer to the saved exact proposal.
      const proof = (await input.client.query<{ rebases: unknown; evidence_hash: string }>(`SELECT
          assessment_payload->'plan'->'openingReservationRebases' AS rebases,
          assessment_payload->'plan'->>'evidenceHash' AS evidence_hash
        FROM inventory.availability_cutover_opening_snapshots
        WHERE id=$1 AND source_evidence_hash=$2
          AND verification_payload->>'reservationBasis'='verified_current_lot_custody'
          AND assessment_payload->>'ready'='true'`, [snapshotId, sourceHash])).rows;
      if (proof.length !== 1 || proof[0].evidence_hash !== command.expectedEvidenceHash
        || canonicalJson(proof[0].rebases) !== canonicalJson(rebases)) throw new InventoryOpeningReservationError(
        "OPENING_REBASE_PROOF_CHANGED", "The exact verified counter translation is not present in the immutable opening.");
      const ids = rebases.map(row => row.inventoryLevelId);
      const locked = (await input.client.query<LockedPosition>(`SELECT level.id,level.warehouse_location_id,level.product_variant_id,
          location.warehouse_id,level.variant_qty::text,level.reserved_qty::text,level.picked_qty::text,level.packed_qty::text
        FROM inventory.inventory_levels level JOIN warehouse.warehouse_locations location ON location.id=level.warehouse_location_id
        WHERE level.id=ANY($1::integer[]) ORDER BY level.id FOR UPDATE OF level`, [ids])).rows;
      if (locked.length !== ids.length) throw new InventoryOpeningReservationError("OPENING_REBASE_POSITION_CHANGED", "A verified position is missing.");
      await input.client.query(`SELECT lot.id FROM inventory.inventory_lots lot JOIN inventory.inventory_levels level
        ON level.product_variant_id=lot.product_variant_id AND level.warehouse_location_id=lot.warehouse_location_id
        WHERE level.id=ANY($1::integer[]) ORDER BY lot.id FOR UPDATE OF lot`, [ids]);
      const totals = (await input.client.query<LotTotals>(`SELECT level.id,
          COALESCE(sum(lot.qty_on_hand),0)::text AS on_hand,COALESCE(sum(lot.qty_reserved),0)::text AS reserved,
          COALESCE(sum(lot.qty_picked),0)::text AS picked,
          COALESCE(bool_or(lot.qty_on_hand<0 OR lot.qty_reserved<0 OR lot.qty_picked<0 OR lot.qty_reserved>lot.qty_on_hand),false) AS invalid
        FROM inventory.inventory_levels level LEFT JOIN inventory.inventory_lots lot
          ON level.product_variant_id=lot.product_variant_id AND level.warehouse_location_id=lot.warehouse_location_id
        WHERE level.id=ANY($1::integer[]) GROUP BY level.id`, [ids])).rows;
      const levelsById = new Map(locked.map(row => [row.id, row]));
      const totalsById = new Map(totals.map(row => [row.id, row]));
      for (const rebase of rebases) {
        const row = levelsById.get(rebase.inventoryLevelId), lot = totalsById.get(rebase.inventoryLevelId);
        if (!row || !lot || lot.invalid || row.warehouse_id !== rebase.warehouseId
          || row.warehouse_location_id !== rebase.warehouseLocationId || row.product_variant_id !== rebase.productVariantId
          || row.variant_qty !== rebase.variantQty || row.reserved_qty !== rebase.reservedQty
          || row.picked_qty !== rebase.pickedQty || row.packed_qty !== rebase.packedQty
          || lot.on_hand !== rebase.variantQty || lot.picked !== rebase.pickedQty || lot.reserved !== rebase.physicalReservedQty) {
          throw new InventoryOpeningReservationError("OPENING_REBASE_POSITION_CHANGED", "Verified physical custody or counters changed.", { inventoryLevelId: rebase.inventoryLevelId });
        }
      }
      const transactionIds: number[] = [];
      for (const row of rebases) {
        const result = await input.client.query(`UPDATE inventory.inventory_levels SET reserved_qty=$2::integer,updated_at=$3::timestamptz
          WHERE id=$1 AND reserved_qty=$4::integer AND variant_qty=$5::integer AND picked_qty=$6::integer AND packed_qty=0`,
        [row.inventoryLevelId, row.physicalReservedQty, command.occurredAt, row.reservedQty, row.variantQty, row.pickedQty]);
        if (result.rowCount !== 1) throw new InventoryOpeningReservationError("OPENING_REBASE_COUNTER_CONFLICT", "Verified counter translation was not applied exactly once.");
        const audit = await input.client.query<{ id: number }>(`INSERT INTO inventory.inventory_transactions
          (product_variant_id,from_location_id,transaction_type,variant_qty_delta,variant_qty_before,variant_qty_after,
           reserved_qty_delta,source_state,target_state,reference_type,reference_id,user_id,notes,created_at)
          VALUES($1,$2,'unreserve',0,$3::integer,$3::integer,$4::integer,'committed','on_hand',
            'availability_opening_rebase',$5,$6,$7,$8::timestamptz) RETURNING id`,
        [row.productVariantId,row.warehouseLocationId,row.variantQty,(BigInt(row.physicalReservedQty)-BigInt(row.reservedQty)).toString(),
          `opening:${snapshotId}:level:${row.inventoryLevelId}`,command.actor,
          `Verified opening ${snapshotId}; before reserved=${row.reservedQty}; after=${row.physicalReservedQty}; demand preserved; history unresolved; evidence ${sourceHash}; ${command.reason}`,command.occurredAt]);
        const id = audit.rows[0]?.id;
        if (audit.rows.length !== 1 || !Number.isSafeInteger(id) || id <= 0) throw new InventoryOpeningReservationError("OPENING_REBASE_AUDIT_INVALID", "Counter translation requires one audit transaction.");
        transactionIds.push(id);
      }
      return transactionIds;
    } catch (cause) {
      if (cause instanceof InventoryOpeningReservationError) throw cause;
      const postgresCode = cause !== null && typeof cause === "object" && "code" in cause ? String(cause.code) : null;
      throw new InventoryOpeningReservationError("OPENING_REBASE_DATABASE_ERROR", "Verified counter translation failed; activation must roll back.", { postgresCode }, { cause });
    }
  }
}
