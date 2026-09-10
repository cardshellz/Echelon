import { sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { InventoryQuantityTransaction } from "../application/quantity-ledger.port";
import { InventoryQuantityError, quantityIdentitySchema, type QuantityCommand, type QuantityMovement } from "../domain/quantity-ledger";
import { PostgresInventoryQuantityLedger } from "./quantity-ledger.repository";

export interface QuantityDrizzleTransaction { execute(query: SQL): Promise<unknown> }

/** Adapt internal, parameterized ledger SQL without escaping values into SQL text. */
export function quantityTransactionFromDrizzle(transaction: QuantityDrizzleTransaction): InventoryQuantityTransaction {
  return {
    async query(text, values = []) {
      const chunks: SQL[] = [];
      let cursor = 0;
      for (const placeholder of text.matchAll(/\$([1-9][0-9]*)\b/g)) {
        const index = Number(placeholder[1]) - 1;
        if (index >= values.length) throw new InventoryQuantityError("QUANTITY_SQL_PARAMETER_MISSING", "Inventory posting SQL has an unbound parameter");
        chunks.push(sql.raw(text.slice(cursor, placeholder.index)), sql`${sql.param(values[index])}`);
        cursor = placeholder.index! + placeholder[0].length;
      }
      chunks.push(sql.raw(text.slice(cursor)));
      const result = await transaction.execute(sql.join(chunks, sql.raw("")));
      if (!result || typeof result !== "object" || !Array.isArray((result as { rows?: unknown }).rows)) {
        throw new InventoryQuantityError("QUANTITY_SQL_RESULT_INVALID", "Inventory posting requires a PostgreSQL result");
      }
      return result as { rows: Record<string, unknown>[]; rowCount?: number | null };
    },
  };
}

/**
 * Explicit unit of work for FIFO owners. It collects their chosen lot movements,
 * not changes to legacy counters. The caller must post before committing costs,
 * receipts and outbox. Creating a session never commits or opens a connection.
 */
export class OperationalQuantityPosting {
  private readonly movements = new Map<number, QuantityMovement>();
  private posted = false;
  private operation: { key: string; hash: string } | null = null;
  private commandId: string | null = null;
  private finished = false;

  constructor(private readonly client: InventoryQuantityTransaction) {}

  /** Replay is checked before FIFO selection or new lot/receipt creation. */
  async beginOperation(key: string | undefined, intent: Record<string, unknown>): Promise<{ result: Record<string, unknown> } | null> {
    if (!key?.trim() || key.length > 200) throw new InventoryQuantityError("QUANTITY_COMMAND_KEY_REQUIRED", "This inventory operation requires a stable command key supplied by its owner");
    // The ledger normalizes outer whitespace. Reject aliases before taking a
    // different operation lock or creating a second replay receipt for one key.
    if (key !== key.trim()) throw new InventoryQuantityError("QUANTITY_COMMAND_KEY_INVALID", "Inventory command keys cannot contain leading or trailing whitespace");
    if (this.operation) throw new InventoryQuantityError("QUANTITY_OPERATION_ALREADY_STARTED", "An inventory posting may own only one replay receipt");
    const hash = createHash("sha256").update(canonicalJson(intent)).digest("hex");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`inventory_quantity_operation:${key}`]);
    const rows = (await this.client.query(`SELECT request_hash, result FROM inventory.quantity_operation_receipts WHERE idempotency_key = $1`, [key])).rows;
    if (rows.length > 1) throw new InventoryQuantityError("QUANTITY_OPERATION_RECEIPT_INVALID", "Inventory operation replay is ambiguous");
    if (rows.length === 1) {
      if (rows[0].request_hash !== hash) throw new InventoryQuantityError("QUANTITY_IDEMPOTENCY_CONFLICT", "The inventory command key already belongs to different intent");
      if (!rows[0].result || typeof rows[0].result !== "object" || Array.isArray(rows[0].result)) {
        throw new InventoryQuantityError("QUANTITY_OPERATION_RECEIPT_INVALID", "Inventory operation replay result is invalid");
      }
      return { result: rows[0].result as Record<string, unknown> };
    }
    this.operation = { key, hash };
    return null;
  }

  async finishOperation(result: Record<string, unknown>): Promise<void> {
    if (this.finished) throw new InventoryQuantityError("QUANTITY_OPERATION_CLOSED", "An operation may complete only once");
    if (!this.operation || !this.commandId) throw new InventoryQuantityError("QUANTITY_OPERATION_NOT_POSTED", "An inventory replay receipt requires its completed quantity posting");
    await this.client.query(`INSERT INTO inventory.quantity_operation_receipts(idempotency_key, request_hash, quantity_command_id, result)
      VALUES ($1,$2,$3,$4::jsonb)`, [this.operation.key, this.operation.hash, this.commandId, JSON.stringify(result)]);
    this.finished = true;
  }

  /** Record an inspected empty operation without inventing a physical event. */
  async finishNoMovement(result: Record<string, unknown>): Promise<void> {
    if (this.finished) throw new InventoryQuantityError("QUANTITY_OPERATION_CLOSED", "An operation may complete only once");
    if (!this.operation || this.posted || this.commandId || this.movements.size !== 0) {
      throw new InventoryQuantityError("QUANTITY_NO_MOVEMENT_INVALID", "A no-movement receipt requires started intent and no staged or posted physical changes");
    }
    await this.client.query(`INSERT INTO inventory.quantity_operation_receipts(idempotency_key, request_hash, quantity_command_id, outcome, result)
      VALUES ($1,$2,NULL,'no_movement',$3::jsonb)`, [this.operation.key, this.operation.hash, JSON.stringify(result)]);
    this.finished = true;
  }

  async addLot(inventoryLotId: number, delta: QuantityMovement["delta"]): Promise<void> {
    if (this.posted || this.finished) throw new InventoryQuantityError("QUANTITY_POSTING_CLOSED", "A closed operation cannot acquire more movements");
    const rows = (await this.client.query(`SELECT lot.id AS "inventoryLotId", level.id AS "inventoryLevelId",
      lot.product_variant_id AS "productVariantId", lot.warehouse_location_id AS "warehouseLocationId",
      location.warehouse_id AS "warehouseId"
      FROM inventory.inventory_lots lot
      JOIN inventory.inventory_levels level ON level.product_variant_id = lot.product_variant_id
        AND level.warehouse_location_id = lot.warehouse_location_id
      JOIN warehouse.warehouse_locations location ON location.id = lot.warehouse_location_id
      WHERE lot.id = $1`, [inventoryLotId])).rows;
    if (rows.length !== 1) throw new InventoryQuantityError("QUANTITY_IDENTITY_MISSING", "A lot movement requires one exact SKU/location level", { inventoryLotId });
    const identity = quantityIdentitySchema.parse(rows[0]);
    const previous = this.movements.get(inventoryLotId);
    const combined = previous ? {
      onHand: previous.delta.onHand + delta.onHand,
      reserved: previous.delta.reserved + delta.reserved,
      picked: previous.delta.picked + delta.picked,
      packed: previous.delta.packed + delta.packed,
    } : { ...delta };
    this.movements.set(inventoryLotId, { ...identity, delta: combined });
  }

  async post(command: Omit<QuantityCommand, "contractVersion" | "movements" | "reversesCommandId"> & { reversesCommandId?: string | null }): Promise<void> {
    if (this.posted || this.finished) throw new InventoryQuantityError("QUANTITY_POSTING_CLOSED", "An operation may post only once");
    if (this.operation && command.idempotencyKey !== this.operation.key) {
      throw new InventoryQuantityError("QUANTITY_OPERATION_KEY_CHANGED", "The posting must use the operation intent key checked before planning");
    }
    const result = await new PostgresInventoryQuantityLedger().postInsideTransaction(this.client, {
      ...command, contractVersion: "inventory_quantity_v1", reversesCommandId: command.reversesCommandId ?? null,
      movements: [...this.movements.values()],
    });
    this.commandId = result.commandId;
    this.posted = true;
  }
}

/** Missing schema/errors are not permission to fall back to legacy writers. */
export async function openOperationalQuantityPosting(transaction: QuantityDrizzleTransaction): Promise<OperationalQuantityPosting | null> {
  const client = quantityTransactionFromDrizzle(transaction);
  const admission = await client.query("SELECT epoch FROM inventory.cutover_admission_fence WHERE singleton_key = true FOR SHARE NOWAIT");
  if (admission.rows.length !== 1) throw new InventoryQuantityError("QUANTITY_ADMISSION_MISSING", "Inventory admission is unavailable");
  const opening = await client.query("SELECT command_id FROM inventory.quantity_ledger_opening WHERE singleton_key = true");
  if (opening.rows.length > 1) throw new InventoryQuantityError("QUANTITY_OPENING_INVALID", "Inventory quantity authority is ambiguous");
  if (opening.rows.length === 0) return null;
  // Fail before metadata, costs or old audit receipts can be committed by an
  // accidentally supplied autocommit executor. post() repeats this protection.
  await client.query("SAVEPOINT inventory_quantity_context");
  await client.query("RELEASE SAVEPOINT inventory_quantity_context");
  return new OperationalQuantityPosting(client);
}
