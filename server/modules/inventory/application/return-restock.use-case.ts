import { sql, type SQL } from "drizzle-orm";
import { resolveReturnCost } from "../cost-resolver";

export interface ReturnRestockExecutor {
  execute(query: SQL): Promise<unknown>;
  select: (...args: any[]) => any;
}

export interface ApplyReturnRestockInput {
  dispositionItemId: number;
  returnCaseId: number;
  caseNumber: string;
  productVariantId: number;
  warehouseLocationId: number;
  quantity: number;
  omsOrderId: number;
  wmsOrderId: number;
  wmsOrderItemId: number | null;
  actor: string;
  notes: string | null;
  now: Date;
}

export interface ApplyReturnRestockResult {
  productVariantId: number;
  warehouseLocationId: number;
  quantity: number;
  inventoryTransactionId: number;
  inventoryLotId: number;
  replayed: boolean;
}

export class ReturnRestockError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReturnRestockError";
  }
}

interface ExistingTransactionRow {
  id: unknown;
  product_variant_id: unknown;
  to_location_id: unknown;
  variant_qty_delta: unknown;
  inventory_lot_id: unknown;
}

interface LocationRow {
  id: unknown;
  warehouse_id: unknown;
  is_active: unknown;
  is_pickable: unknown;
  cycle_count_freeze_id: unknown;
}

interface VariantRow { id: unknown; is_active: unknown }
interface LevelRow { id: unknown; variant_qty: unknown }
interface InsertedIdRow { id: unknown }

const REFERENCE_TYPE = "return_inventory_treatment";

export async function applyReturnRestock(
  executor: ReturnRestockExecutor,
  rawInput: ApplyReturnRestockInput,
): Promise<ApplyReturnRestockResult> {
  const input = normalizeInput(rawInput);
  await executor.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtext('inventory.apply_return_restock'),
      ${input.dispositionItemId}
    )
  `);

  const existing = firstRow<ExistingTransactionRow>(await executor.execute(sql`
    SELECT id, product_variant_id, to_location_id, variant_qty_delta, inventory_lot_id
    FROM inventory.inventory_transactions
    WHERE transaction_type = 'return'
      AND reference_type = ${REFERENCE_TYPE}
      AND reference_id = ${String(input.dispositionItemId)}
      AND voided_at IS NULL
    LIMIT 1
    FOR UPDATE
  `));
  if (existing) return validateReplay(existing, input);

  const location = firstRow<LocationRow>(await executor.execute(sql`
    SELECT id, warehouse_id, is_active, is_pickable, cycle_count_freeze_id
    FROM warehouse.warehouse_locations
    WHERE id = ${input.warehouseLocationId}
    FOR UPDATE
  `));
  if (!location) throw conflict("RETURN_RESTOCK_LOCATION_NOT_FOUND", "The selected warehouse location no longer exists.", input);
  if (readInteger(location.is_active, "location active") !== 1
    || readInteger(location.is_pickable, "location pickable") !== 1
    || location.warehouse_id === null) {
    throw conflict("RETURN_RESTOCK_LOCATION_NOT_PICKABLE", "Sellable returns require an active, pickable warehouse location.", input);
  }
  if (location.cycle_count_freeze_id !== null) {
    throw conflict("RETURN_RESTOCK_LOCATION_FROZEN", "The selected warehouse location is frozen for cycle counting.", input);
  }

  const variant = firstRow<VariantRow>(await executor.execute(sql`
    SELECT id, is_active
    FROM catalog.product_variants
    WHERE id = ${input.productVariantId}
    FOR UPDATE
  `));
  if (!variant || variant.is_active !== true) {
    throw conflict("RETURN_RESTOCK_VARIANT_INACTIVE", "Sellable returns require an active catalog variant.", input);
  }

  await executor.execute(sql`
    INSERT INTO inventory.inventory_levels (
      warehouse_location_id, product_variant_id, variant_qty, reserved_qty,
      picked_qty, packed_qty, backorder_qty, updated_at
    ) VALUES (
      ${input.warehouseLocationId}, ${input.productVariantId}, 0, 0, 0, 0, 0, ${input.now}
    )
    ON CONFLICT (product_variant_id, warehouse_location_id) DO NOTHING
  `);
  const level = firstRow<LevelRow>(await executor.execute(sql`
    SELECT id, variant_qty
    FROM inventory.inventory_levels
    WHERE product_variant_id = ${input.productVariantId}
      AND warehouse_location_id = ${input.warehouseLocationId}
    FOR UPDATE
  `));
  if (!level) throw integrity("RETURN_RESTOCK_LEVEL_MISSING", "Inventory level could not be created or locked.", input);
  const quantityBefore = readNonNegativeInteger(level.variant_qty, "inventory quantity before");
  const quantityAfter = checkedAdd(quantityBefore, input.quantity, input);

  const cost = await resolveReturnCost(executor, input.productVariantId, input.omsOrderId);
  const unitCostCents = readNonNegativeInteger(cost.costCents, "return unit cost cents");
  const unitCostMills = checkedMultiply(unitCostCents, 100, input);
  const lotNumber = buildLotNumber(input.caseNumber, input.dispositionItemId);
  const lot = firstRow<InsertedIdRow>(await executor.execute(sql`
    INSERT INTO inventory.inventory_lots (
      lot_number, product_variant_id, warehouse_location_id,
      unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
      landed_cost_cents, total_unit_cost_cents,
      unit_cost_mills, po_unit_cost_mills, packaging_cost_mills,
      landed_cost_mills, total_unit_cost_mills,
      qty_on_hand, qty_reserved, qty_picked, qty_received, qty_consumed,
      received_at, status, cost_provisional, cost_source, notes, created_at
    ) VALUES (
      ${lotNumber}, ${input.productVariantId}, ${input.warehouseLocationId},
      ${unitCostCents}, ${unitCostCents}, 0, 0, ${unitCostCents},
      ${unitCostMills}, ${unitCostMills}, 0, 0, ${unitCostMills},
      ${input.quantity}, 0, 0, ${input.quantity}, 0,
      ${input.now}, 'active', ${cost.provisional ? 1 : 0}, ${cost.source},
      ${input.notes}, ${input.now}
    )
    RETURNING id
  `));
  if (!lot) throw integrity("RETURN_RESTOCK_LOT_INSERT_FAILED", "Return inventory lot was not created.", input);
  const inventoryLotId = readPositiveInteger(lot.id, "return inventory lot id");

  await executor.execute(sql`
    UPDATE inventory.inventory_levels
    SET variant_qty = ${quantityAfter}, updated_at = ${input.now}
    WHERE id = ${readPositiveInteger(level.id, "inventory level id")}
  `);

  const transaction = firstRow<InsertedIdRow>(await executor.execute(sql`
    INSERT INTO inventory.inventory_transactions (
      product_variant_id, to_location_id, transaction_type,
      variant_qty_delta, variant_qty_before, variant_qty_after,
      source_state, target_state, unit_cost_cents, inventory_lot_id,
      order_id, order_item_id, reference_type, reference_id,
      notes, user_id, created_at
    ) VALUES (
      ${input.productVariantId}, ${input.warehouseLocationId}, 'return',
      ${input.quantity}, ${quantityBefore}, ${quantityAfter},
      'customer_return', 'on_hand', ${unitCostCents}, ${inventoryLotId},
      ${input.wmsOrderId}, ${input.wmsOrderItemId}, ${REFERENCE_TYPE},
      ${String(input.dispositionItemId)}, ${input.notes}, ${input.actor}, ${input.now}
    )
    RETURNING id
  `));
  if (!transaction) throw integrity("RETURN_RESTOCK_LEDGER_INSERT_FAILED", "Return inventory transaction was not created.", input);

  return {
    productVariantId: input.productVariantId,
    warehouseLocationId: input.warehouseLocationId,
    quantity: input.quantity,
    inventoryTransactionId: readPositiveInteger(transaction.id, "return inventory transaction id"),
    inventoryLotId,
    replayed: false,
  };
}

function normalizeInput(input: ApplyReturnRestockInput): ApplyReturnRestockInput {
  for (const [field, value] of Object.entries({
    dispositionItemId: input.dispositionItemId,
    returnCaseId: input.returnCaseId,
    productVariantId: input.productVariantId,
    warehouseLocationId: input.warehouseLocationId,
    quantity: input.quantity,
    omsOrderId: input.omsOrderId,
    wmsOrderId: input.wmsOrderId,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ReturnRestockError("RETURN_RESTOCK_INPUT_INVALID", `${field} must be a positive safe integer.`, { field, value });
    }
  }
  if (input.wmsOrderItemId !== null
    && (!Number.isSafeInteger(input.wmsOrderItemId) || input.wmsOrderItemId <= 0)) {
    throw new ReturnRestockError("RETURN_RESTOCK_INPUT_INVALID", "wmsOrderItemId must be null or a positive safe integer.");
  }
  if (typeof input.caseNumber !== "string" || input.caseNumber.trim() === ""
    || typeof input.actor !== "string" || input.actor.trim() === ""
    || !(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new ReturnRestockError("RETURN_RESTOCK_INPUT_INVALID", "Return restock identity, actor, and timestamp are required.");
  }
  return { ...input, caseNumber: input.caseNumber.trim(), actor: input.actor.trim() };
}

function validateReplay(row: ExistingTransactionRow, input: ApplyReturnRestockInput): ApplyReturnRestockResult {
  const inventoryLotId = readPositiveInteger(row.inventory_lot_id, "existing return inventory lot id");
  const actual = {
    productVariantId: readPositiveInteger(row.product_variant_id, "existing return product variant id"),
    warehouseLocationId: readPositiveInteger(row.to_location_id, "existing return warehouse location id"),
    quantity: readPositiveInteger(row.variant_qty_delta, "existing return quantity"),
  };
  if (actual.productVariantId !== input.productVariantId
    || actual.warehouseLocationId !== input.warehouseLocationId
    || actual.quantity !== input.quantity) {
    throw conflict("RETURN_RESTOCK_REPLAY_CONFLICT", "Existing return inventory evidence does not match this command.", {
      ...input,
      actual,
    });
  }
  return {
    ...actual,
    inventoryTransactionId: readPositiveInteger(row.id, "existing return transaction id"),
    inventoryLotId,
    replayed: true,
  };
}

function buildLotNumber(caseNumber: string, dispositionItemId: number): string {
  const suffix = `-D${dispositionItemId}`;
  const prefix = caseNumber.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 50 - suffix.length);
  return `${prefix}${suffix}`;
}

function rowsOf<T>(result: unknown): T[] {
  if (!result || typeof result !== "object") return [];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

function firstRow<T>(result: unknown): T | null {
  return rowsOf<T>(result)[0] ?? null;
}

function readPositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ReturnRestockError("RETURN_RESTOCK_DATA_INVALID", `${field} is invalid.`, { field, value });
  }
  return parsed;
}

function readNonNegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ReturnRestockError("RETURN_RESTOCK_DATA_INVALID", `${field} is invalid.`, { field, value });
  }
  return parsed;
}

function readInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ReturnRestockError("RETURN_RESTOCK_DATA_INVALID", `${field} is invalid.`, { field, value });
  }
  return parsed;
}

function checkedAdd(left: number, right: number, context: object): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw integrity("RETURN_RESTOCK_QUANTITY_OVERFLOW", "Return quantity exceeds the supported range.", context);
  return result;
}

function checkedMultiply(left: number, right: number, context: object): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw integrity("RETURN_RESTOCK_COST_OVERFLOW", "Return cost exceeds the supported range.", context);
  return result;
}

function conflict(code: string, message: string, context: object): ReturnRestockError {
  return new ReturnRestockError(code, message, { ...context });
}

function integrity(code: string, message: string, context: object): ReturnRestockError {
  return new ReturnRestockError(code, message, { ...context });
}
