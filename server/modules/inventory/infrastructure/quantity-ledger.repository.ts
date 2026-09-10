import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { openingVerificationSchema } from "@shared/types/inventory-cutover-opening";
import type { InventoryQuantityPostingPort, InventoryQuantityPostingResult, InventoryQuantityTransaction } from "../application/quantity-ledger.port";
import { applyQuantityDelta, emptyQuantityBalance, InventoryQuantityError, normalizeQuantityCommand,
  quantityBalanceSchema, quantityIdentitySchema, type QuantityBalance, type QuantityCommand } from "../domain/quantity-ledger";

const bigintId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= BigInt("9223372036854775807"));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const openingReceiptSchema = z.object({ verifiedOpeningId: bigintId, authorityRevision: bigintId, sourceEvidenceHash: hash }).strict();
export type QuantityOpeningReceipt = z.infer<typeof openingReceiptSchema>;
const resultBalanceSchema = quantityIdentitySchema.extend({ before: quantityBalanceSchema, after: quantityBalanceSchema }).strict();

/** occurredAt records the first accepted attempt; retry clocks are not business intent. */
export function quantityCommandHash(input: QuantityCommand): string {
  const { occurredAt: _occurredAt, ...semantic } = normalizeQuantityCommand(input);
  return createHash("sha256").update(canonicalJson(semantic)).digest("hex");
}

/**
 * Sole journal/projection writer. No provider calls, costing, FIFO selection,
 * reservation ownership or transaction commit belongs here. The caller plans
 * exact lot movements and commits its business receipt/outbox in this transaction.
 */
export class PostgresInventoryQuantityLedger implements InventoryQuantityPostingPort {
  async postInsideTransaction(client: InventoryQuantityTransaction, input: QuantityCommand): Promise<InventoryQuantityPostingResult> {
    const command = normalizeQuantityCommand(input);
    if (command.kind === "opening") throw new InventoryQuantityError("QUANTITY_OPENING_OWNER_REQUIRED", "Only the admitted cutover owner can establish an opening");
    return this.post(client, command, null);
  }

  async openInsideTransaction(client: InventoryQuantityTransaction, input: QuantityCommand,
    rawReceipt: QuantityOpeningReceipt): Promise<InventoryQuantityPostingResult> {
    const command = normalizeQuantityCommand(input);
    const receipt = openingReceiptSchema.parse(rawReceipt);
    if (command.kind !== "opening") throw new InventoryQuantityError("QUANTITY_OPENING_COMMAND_REQUIRED", "An opening receipt requires an opening posting");
    return this.post(client, command, receipt);
  }

  private async post(client: InventoryQuantityTransaction, command: QuantityCommand,
    opening: QuantityOpeningReceipt | null): Promise<InventoryQuantityPostingResult> {
    // SAVEPOINT fails in autocommit: accidentally passing a Pool cannot leave a
    // command or one projection committed without the rest of the business work.
    await client.query("SAVEPOINT inventory_quantity_post");
    try {
      const admission = await client.query("SELECT epoch::text FROM inventory.cutover_admission_fence WHERE singleton_key = true FOR SHARE NOWAIT");
      if (admission.rows.length !== 1) throw new InventoryQuantityError("QUANTITY_ADMISSION_MISSING", "Inventory writer admission is unavailable");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`inventory_quantity:${command.idempotencyKey}`]);
      const requestHash = quantityCommandHash(command);
      const replay = await this.loadReplay(client, command.idempotencyKey, requestHash);
      if (replay) {
        if (opening) {
          const rows = (await client.query(`SELECT command_id::text, verified_opening_id::text, authority_revision::text, source_evidence_hash
            FROM inventory.quantity_ledger_opening WHERE singleton_key = true`)).rows;
          const row = rows[0];
          if (rows.length !== 1 || row.command_id !== replay.commandId || row.verified_opening_id !== opening.verifiedOpeningId
            || row.authority_revision !== opening.authorityRevision || row.source_evidence_hash !== opening.sourceEvidenceHash) {
            throw new InventoryQuantityError("QUANTITY_IDEMPOTENCY_CONFLICT", "This opening key was accepted with different cutover evidence");
          }
        }
        await client.query("RELEASE SAVEPOINT inventory_quantity_post");
        return replay;
      }
      if (opening) await this.validateOpening(client, command, opening);
      else if ((await client.query("SELECT command_id FROM inventory.quantity_ledger_opening WHERE singleton_key = true")).rows.length !== 1) {
        throw new InventoryQuantityError("QUANTITY_LEDGER_NOT_ACTIVE", "A verified opening must precede operational ledger postings");
      }

      const levelIds = [...new Set(command.movements.map(row => row.inventoryLevelId))].sort((a,b) => a-b);
      const lotIds = command.movements.map(row => row.inventoryLotId).sort((a,b) => a-b);
      const levels = (await client.query(`SELECT level.id, level.product_variant_id, level.warehouse_location_id, location.warehouse_id
        FROM inventory.inventory_levels level JOIN warehouse.warehouse_locations location ON location.id = level.warehouse_location_id
        WHERE level.id = ANY($1::integer[]) ORDER BY level.warehouse_location_id, level.product_variant_id, level.id FOR UPDATE OF level`, [levelIds])).rows;
      const lots = (await client.query(`SELECT id, product_variant_id, warehouse_location_id FROM inventory.inventory_lots
        WHERE id = ANY($1::integer[]) ORDER BY warehouse_location_id, product_variant_id, received_at, id FOR UPDATE`, [lotIds])).rows;
      const levelById = new Map(levels.map(row => [row.id, row]));
      const lotById = new Map(lots.map(row => [row.id, row]));
      if (levels.length !== levelIds.length || lots.length !== lotIds.length) {
        throw new InventoryQuantityError("QUANTITY_IDENTITY_MISSING", "Every posting must name existing exact lot/level identities");
      }
      // Read balances from journal algebra, never from the two legacy counters.
      const ledger = (await client.query(`SELECT inventory_lot_id, on_hand::text, reserved::text, picked::text, packed::text
        FROM inventory.quantity_lot_balances WHERE inventory_lot_id = ANY($1::integer[])`, [lotIds])).rows;
      const beforeByLot = new Map(ledger.map(row => [row.inventory_lot_id, readBalance(row)]));
      const balances = command.movements.map(movement => {
        const level = levelById.get(movement.inventoryLevelId)!;
        const lot = lotById.get(movement.inventoryLotId)!;
        if (level.product_variant_id !== movement.productVariantId || level.warehouse_location_id !== movement.warehouseLocationId
          || level.warehouse_id !== movement.warehouseId || lot.product_variant_id !== movement.productVariantId
          || lot.warehouse_location_id !== movement.warehouseLocationId) {
          throw new InventoryQuantityError("QUANTITY_IDENTITY_CHANGED", "Locked lot/level identity differs from the planned movement", { inventoryLotId: movement.inventoryLotId });
        }
        const before = beforeByLot.get(movement.inventoryLotId) ?? emptyQuantityBalance();
        const { delta: _delta, ...identity } = movement;
        return { ...identity, before, after: applyQuantityDelta(before, movement) };
      });
      const inserted = await client.query(`INSERT INTO inventory.quantity_commands
        (idempotency_key, request_hash, kind, actor, reason, reference_type, reference_id, reverses_command_id,
         occurred_at, request_payload, line_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING id::text`,
      [command.idempotencyKey, requestHash, command.kind, command.actor, command.reason, command.reference.type,
        command.reference.id, command.reversesCommandId, command.occurredAt, JSON.stringify(command), command.movements.length]);
      const commandId = bigintId.parse(inserted.rows[0]?.id);
      const entries = command.movements.map((movement, index) => ({ ...movement, before: balances[index].before, after: balances[index].after }));
      await client.query(`INSERT INTO inventory.quantity_entries
        (command_id, inventory_lot_id, inventory_level_id, product_variant_id, warehouse_location_id, warehouse_id,
         on_hand_delta, reserved_delta, picked_delta, packed_delta, on_hand_before, reserved_before, picked_before, packed_before,
         on_hand_after, reserved_after, picked_after, packed_after)
        SELECT $1, (row->>'inventoryLotId')::integer, (row->>'inventoryLevelId')::integer,
          (row->>'productVariantId')::integer, (row->>'warehouseLocationId')::integer, (row->>'warehouseId')::integer,
          (row->'delta'->>'onHand')::integer, (row->'delta'->>'reserved')::integer, (row->'delta'->>'picked')::integer, (row->'delta'->>'packed')::integer,
          (row->'before'->>'onHand')::integer, (row->'before'->>'reserved')::integer, (row->'before'->>'picked')::integer, (row->'before'->>'packed')::integer,
          (row->'after'->>'onHand')::integer, (row->'after'->>'reserved')::integer, (row->'after'->>'picked')::integer, (row->'after'->>'packed')::integer
        FROM jsonb_array_elements($2::jsonb) row
        ORDER BY (row->>'inventoryLevelId')::integer, (row->>'inventoryLotId')::integer`, [commandId, JSON.stringify(entries)]);
      if (opening) await client.query(`INSERT INTO inventory.quantity_ledger_opening
        (command_id, verified_opening_id, authority_revision, source_evidence_hash) VALUES ($1,$2,$3,$4)`,
      [commandId, opening.verifiedOpeningId, opening.authorityRevision, opening.sourceEvidenceHash]);
      await this.project(client, lotIds, levelIds, command.occurredAt, opening !== null);
      await client.query("RELEASE SAVEPOINT inventory_quantity_post");
      return { commandId, requestHash, alreadyApplied: false, balances };
    } catch (error) {
      // Restore only this posting, then propagate; the caller must roll back its
      // whole business transaction. Preserve the original SQLSTATE for retries.
      await client.query("ROLLBACK TO SAVEPOINT inventory_quantity_post");
      await client.query("RELEASE SAVEPOINT inventory_quantity_post");
      throw error;
    }
  }

  private async loadReplay(client: InventoryQuantityTransaction, key: string, expectedHash: string): Promise<InventoryQuantityPostingResult | null> {
    const commands = (await client.query("SELECT id::text, request_hash, request_payload, line_count FROM inventory.quantity_commands WHERE idempotency_key = $1", [key])).rows;
    if (commands.length === 0) return null;
    const stored = commands[0];
    if (commands.length !== 1 || quantityCommandHash(stored.request_payload as QuantityCommand) !== stored.request_hash) {
      throw new InventoryQuantityError("QUANTITY_RECEIPT_INVALID", "The persisted inventory command failed integrity validation");
    }
    if (stored.request_hash !== expectedHash) throw new InventoryQuantityError("QUANTITY_IDEMPOTENCY_CONFLICT", "This key was already accepted for a different inventory movement");
    const commandId = bigintId.parse(stored.id);
    const rows = (await client.query(`SELECT inventory_lot_id, inventory_level_id, product_variant_id, warehouse_location_id, warehouse_id,
      on_hand_before, reserved_before, picked_before, packed_before, on_hand_after, reserved_after, picked_after, packed_after
      FROM inventory.quantity_entries WHERE command_id = $1 ORDER BY inventory_level_id, inventory_lot_id`, [commandId])).rows;
    if (rows.length !== stored.line_count) throw new InventoryQuantityError("QUANTITY_RECEIPT_INVALID", "The persisted inventory command is incomplete");
    const balances = rows.map(row => resultBalanceSchema.parse({ inventoryLotId: row.inventory_lot_id,
      inventoryLevelId: row.inventory_level_id, productVariantId: row.product_variant_id,
      warehouseLocationId: row.warehouse_location_id, warehouseId: row.warehouse_id,
      before: { onHand: row.on_hand_before, reserved: row.reserved_before, picked: row.picked_before, packed: row.packed_before },
      after: { onHand: row.on_hand_after, reserved: row.reserved_after, picked: row.picked_after, packed: row.packed_after } }));
    return { commandId, requestHash: expectedHash, alreadyApplied: true, balances };
  }

  private async validateOpening(client: InventoryQuantityTransaction, command: QuantityCommand, receipt: QuantityOpeningReceipt): Promise<void> {
    await client.query("SELECT inventory.assert_cutover_admission_fence_owner()");
    if ((await client.query("SELECT command_id FROM inventory.quantity_ledger_opening")).rows.length !== 0) {
      throw new InventoryQuantityError("QUANTITY_OPENING_ALREADY_ESTABLISHED", "Inventory quantity authority cannot be opened twice");
    }
    const rows = (await client.query(`SELECT authority_revision::text, source_evidence_hash, verification_payload, assessment_payload
      FROM inventory.availability_cutover_opening_snapshots WHERE id = $1`, [receipt.verifiedOpeningId])).rows;
    const row = rows[0];
    if (rows.length !== 1 || row.source_evidence_hash !== receipt.sourceEvidenceHash
      || BigInt(bigintId.parse(row.authority_revision)) + BigInt(1) !== BigInt(receipt.authorityRevision)
      || !(row.assessment_payload as { ready?: boolean } | null)?.ready) {
      throw new InventoryQuantityError("QUANTITY_OPENING_EVIDENCE_INVALID", "Opening quantities require the exact approved cutover verification");
    }
    const verification = openingVerificationSchema.parse(row.verification_payload);
    const verified = new Map(verification.lots.map(lot => [lot.id, lot]));
    const postedIds = new Set(command.movements.map(movement => movement.inventoryLotId));
    if (verified.size !== verification.lots.length || verification.lots.some(lot =>
      (BigInt(lot.onHandQty) !== BigInt(0) || BigInt(lot.reservedQty) !== BigInt(0) || BigInt(lot.pickedQty) !== BigInt(0)) && !postedIds.has(lot.id))) {
      throw new InventoryQuantityError("QUANTITY_OPENING_CENSUS_CHANGED", "The opening must post every nonzero verified lot; explicit zero observations remain in its immutable census");
    }
    for (const movement of command.movements) {
      const lot = verified.get(movement.inventoryLotId);
      if (!lot || movement.productVariantId !== lot.productVariantId || movement.warehouseLocationId !== lot.warehouseLocationId
        || movement.delta.onHand !== Number(lot.onHandQty) || movement.delta.reserved !== Number(lot.reservedQty)
        || movement.delta.picked !== Number(lot.pickedQty) || movement.delta.packed !== 0) {
        throw new InventoryQuantityError("QUANTITY_OPENING_OBSERVATION_MISMATCH", "Opening movements must use verified custody, not a legacy balance or invented lot", { inventoryLotId: movement.inventoryLotId });
      }
    }
  }

  private async project(client: InventoryQuantityTransaction, lotIds: number[], levelIds: number[], occurredAt: string, opening: boolean): Promise<void> {
    await client.query(`UPDATE inventory.inventory_lots lot SET qty_on_hand = coalesce(balance.on_hand,0)::integer,
      qty_reserved = coalesce(balance.reserved,0)::integer, qty_picked = coalesce(balance.picked,0)::integer, qty_packed = coalesce(balance.packed,0)::integer,
      status = CASE WHEN lot.status = 'active' AND coalesce(balance.on_hand,0) = 0 AND coalesce(balance.reserved,0) = 0 AND coalesce(balance.picked,0) = 0 AND coalesce(balance.packed,0) = 0 THEN 'depleted'
        WHEN lot.status = 'depleted' AND (balance.on_hand > 0 OR balance.picked > 0 OR balance.packed > 0) THEN 'active' ELSE lot.status END
      FROM inventory.inventory_lots identity LEFT JOIN inventory.quantity_lot_balances balance ON balance.inventory_lot_id = identity.id
      WHERE lot.id = identity.id AND ($2::boolean OR lot.id = ANY($1::integer[]))`, [lotIds, opening]);
    await client.query(`UPDATE inventory.inventory_levels level SET variant_qty = coalesce(balance.on_hand,0)::integer,
      reserved_qty = coalesce(balance.reserved,0)::integer, picked_qty = coalesce(balance.picked,0)::integer,
      packed_qty = coalesce(balance.packed,0)::integer, updated_at = $2
      FROM inventory.inventory_levels identity LEFT JOIN inventory.quantity_level_balances balance ON balance.inventory_level_id = identity.id
      WHERE level.id = identity.id AND ($3::boolean OR level.id = ANY($1::integer[]))`, [levelIds, occurredAt, opening]);
  }
}

function readBalance(row: Record<string, unknown>): QuantityBalance {
  const value = (key: string): number => {
    const raw = row[key];
    if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw) || BigInt(raw) > BigInt(2_147_483_647)) {
      throw new InventoryQuantityError("QUANTITY_LEDGER_BALANCE_INVALID", "The quantity ledger contains an invalid balance", { inventoryLotId: row.inventory_lot_id, bucket: key });
    }
    return Number(raw);
  };
  return quantityBalanceSchema.parse({ onHand: value("on_hand"), reserved: value("reserved"), picked: value("picked"), packed: value("packed") });
}
