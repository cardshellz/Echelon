import { sql, type SQL } from "drizzle-orm";
import { allocateReturnCosts } from "../infrastructure/return-cost-allocation.repository";
import { lockInventoryCostGraph, recordLotCostContribution } from "../infrastructure/cost-evidence.repository";
import { recordLotCostFollowUp } from "../infrastructure/lot-cost-follow-up.repository";
import { roundedMillsToCents, moneyToSafeNumber } from "../domain/lot-cost";
import { canonicalJson } from "@shared/utils/canonical-json";
import { openOperationalQuantityPosting } from "../infrastructure/operational-quantity-posting";

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
  inventoryLotIds: number[];
  inventoryTransactionIds: number[];
  replayed: boolean;
}

export class ReturnRestockError extends Error {
  readonly statusCode = 409;
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
  order_id: unknown;
  order_item_id: unknown;
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

export interface ApplyReturnedStockInput {
  productVariantId: number; warehouseLocationId: number; quantity: number;
  wmsOrderId: number; wmsOrderItemId: number | null; actor: string; notes: string | null; now: Date;
  operationKey: string; referenceType: "return_inventory_treatment" | "order_return_command";
  referenceId: string; lotNumberPrefix: string;
}

/** Compatibility entry for canonical Return Case dispositions. */
export async function applyReturnRestock(executor: ReturnRestockExecutor, rawInput: ApplyReturnRestockInput): Promise<ApplyReturnRestockResult> {
  const input = normalizeInput(rawInput);
  return applyReturnedStock(executor, { ...input,
    operationKey: `return_inventory_treatment:${input.dispositionItemId}`,
    referenceType: "return_inventory_treatment", referenceId: String(input.dispositionItemId),
    lotNumberPrefix: buildLotNumber(input.caseNumber,input.dispositionItemId),
  });
}

/** One physical return owner for canonical dispositions and supported legacy
 * returns. Exact source allocations are separate from physical authorization.
 * Every layer, journal entry and unresolved-cost obligation shares the caller's
 * transaction; the stable command returns committed evidence before mutable checks.
 */
export async function applyReturnedStock(executor: ReturnRestockExecutor, input: ApplyReturnedStockInput): Promise<ApplyReturnRestockResult> {
  for (const [field,value] of Object.entries({ productVariantId: input.productVariantId,
    warehouseLocationId: input.warehouseLocationId, quantity: input.quantity, wmsOrderId: input.wmsOrderId })) {
    if (!Number.isSafeInteger(value) || value<=0) throw new ReturnRestockError("RETURN_RESTOCK_INPUT_INVALID",`${field} must be a positive safe integer.`);
  }
  if (typeof input.actor !== "string" || !input.actor.trim()
    || typeof input.operationKey !== "string" || !input.operationKey.trim() || input.operationKey.length>240
    || typeof input.referenceId !== "string" || !input.referenceId.trim() || input.referenceId.length>240
    || !["return_inventory_treatment","order_return_command"].includes(input.referenceType)
    || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())
    || typeof input.lotNumberPrefix !== "string" || !input.lotNumberPrefix.trim() || input.lotNumberPrefix.length>50
    || (input.wmsOrderItemId !== null && (!Number.isSafeInteger(input.wmsOrderItemId) || input.wmsOrderItemId<=0))) {
    throw new ReturnRestockError("RETURN_RESTOCK_INPUT_INVALID","An exact audited return operation is required.");
  }
  const costTx = { execute: async (query: unknown) => {
    const result = await executor.execute(query as SQL);
    return { rows: rowsOf<any>(result) };
  }, select: executor.select.bind(executor) };
  await lockInventoryCostGraph(costTx);
  const quantityPosting = await openOperationalQuantityPosting(executor);
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.operationKey}))`);
  const existing = rowsOf<ExistingTransactionRow>(await executor.execute(sql`
    SELECT id,order_id,order_item_id,product_variant_id,to_location_id,variant_qty_delta,inventory_lot_id
    FROM inventory.inventory_transactions WHERE transaction_type='return'
      AND reference_type=${input.referenceType} AND reference_id=${input.referenceId}
      AND voided_at IS NULL ORDER BY id FOR UPDATE
  `));
  if (existing.length > 0) return validateReplay(existing,input);

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

  const layers = await allocateReturnCosts(costTx,{
    wmsOrderId: input.wmsOrderId,wmsOrderItemId: input.wmsOrderItemId,
    productVariantId: input.productVariantId,quantity: input.quantity,
  });
  const inventoryLotIds: number[] = [];
  const inventoryTransactionIds: number[] = [];
  let runningQuantity = quantityBefore;
  for (const [index,layer] of layers.entries()) {
    // Existing numeric columns are compatibility mirrors when financial evidence
    // is unknown. The authoritative return allocation stores a null price and an
    // explicit unknown state; zero is never certified as a known cost in that case.
    const totalMills = layer.costs?.totalMills ?? BigInt(0);
    const poMills = layer.costs?.poMills ?? BigInt(0);
    const packagingMills = layer.costs?.packagingMills ?? BigInt(0);
    const landedMills = layer.costs?.landedMills ?? BigInt(0);
    const cents = moneyToSafeNumber(roundedMillsToCents(totalMills),"return.unitCostCents");
    const lotNumber = layers.length === 1 ? input.lotNumberPrefix
      : `${input.lotNumberPrefix.slice(0,40)}-L${index+1}`;
    const lot = firstRow<InsertedIdRow>(await executor.execute(sql`
      INSERT INTO inventory.inventory_lots (
        lot_number,product_variant_id,warehouse_location_id,unit_cost_cents,po_unit_cost_cents,
        packaging_cost_cents,landed_cost_cents,total_unit_cost_cents,unit_cost_mills,po_unit_cost_mills,
        packaging_cost_mills,landed_cost_mills,total_unit_cost_mills,qty_on_hand,qty_reserved,qty_picked,
        qty_received,qty_consumed,received_at,status,cost_provisional,cost_source,notes,created_at,cost_precision_version
      ) VALUES (${lotNumber},${input.productVariantId},${input.warehouseLocationId},${cents},
        ${roundedMillsToCents(poMills).toString()},${roundedMillsToCents(packagingMills).toString()},${roundedMillsToCents(landedMills).toString()},${cents},
        ${totalMills.toString()},${poMills.toString()},${packagingMills.toString()},${landedMills.toString()},${totalMills.toString()},
        ${quantityPosting ? 0 : layer.quantity},0,0,${layer.quantity},0,${input.now},'active',
        ${layer.evidenceState === "confirmed" ? 0 : 1},${layer.sourceOrderItemCostId !== null ? "order_cogs" : layer.costs ? "return_estimate" : "unresolved"},
        ${input.notes},${input.now},${layer.costs === null ? 0 : 1}) RETURNING id
    `));
    if (!lot) throw integrity("RETURN_RESTOCK_LOT_INSERT_FAILED","Return inventory lot was not created.",input);
    const inventoryLotId = readPositiveInteger(lot.id,"return inventory lot id");
    inventoryLotIds.push(inventoryLotId);
    await executor.execute(sql`INSERT INTO inventory.return_cost_allocations
      (returned_lot_id,operation_key,source_order_item_cost_id,wms_order_id,wms_order_item_id,
       product_variant_id,quantity,evidence_state,source_evidence,recorded_by,recorded_at)
      VALUES (${inventoryLotId},${input.operationKey},${layer.sourceOrderItemCostId},${input.wmsOrderId},${input.wmsOrderItemId},
        ${input.productVariantId},${layer.quantity},${layer.evidenceState},${canonicalJson(layer.sourceEvidence)}::jsonb,${input.actor},${input.now})`);
    if (layer.sourceLotId !== null) await recordLotCostContribution(costTx,{
      sourceLotId: layer.sourceLotId,outputLotId: inventoryLotId,sourceQty: layer.quantity,outputQty: layer.quantity,
      operationKind: "return",operationKey: input.operationKey,
    },input.actor,input.now);
    if (layer.evidenceState !== "confirmed") await recordLotCostFollowUp(costTx,{
      inventoryLotId,operationKey: input.operationKey,
      issueCode: layer.sourceOrderItemCostId === null ? "COST_RETURN_SOURCE_MISSING" : "COST_SOURCE_UNRESOLVED",
      evidence: { sourceOrderItemCostId: layer.sourceOrderItemCostId,evidenceState: layer.evidenceState,
        unitMills: layer.costs?.totalMills.toString() ?? null,source: layer.sourceEvidence },actor: input.actor,occurredAt: input.now,
    });
    const nextQuantity = checkedAdd(runningQuantity,layer.quantity,input);
    const transaction = firstRow<InsertedIdRow>(await executor.execute(sql`
      INSERT INTO inventory.inventory_transactions (product_variant_id,to_location_id,transaction_type,
        variant_qty_delta,variant_qty_before,variant_qty_after,source_state,target_state,unit_cost_cents,
        inventory_lot_id,order_id,order_item_id,reference_type,reference_id,notes,user_id,created_at)
      VALUES (${input.productVariantId},${input.warehouseLocationId},'return',${layer.quantity},${runningQuantity},${nextQuantity},
        'customer_return','on_hand',${cents},${inventoryLotId},${input.wmsOrderId},${input.wmsOrderItemId},
        ${input.referenceType},${input.referenceId},${input.notes},${input.actor},${input.now}) RETURNING id
    `));
    if (!transaction) throw integrity("RETURN_RESTOCK_LEDGER_INSERT_FAILED","Return inventory transaction was not created.",input);
    inventoryTransactionIds.push(readPositiveInteger(transaction.id,"return inventory transaction id"));
    if (quantityPosting) await quantityPosting.addLot(inventoryLotId,{ onHand: layer.quantity,reserved: 0,picked: 0,packed: 0 });
    runningQuantity=nextQuantity;
  }
  if (runningQuantity !== quantityAfter || inventoryLotIds.length === 0) {
    throw integrity("RETURN_RESTOCK_LAYER_QUANTITY_INVALID","Return layers do not conserve the authorized quantity.",input);
  }
  if (!quantityPosting) await executor.execute(sql`UPDATE inventory.inventory_levels
    SET variant_qty=${quantityAfter},updated_at=${input.now} WHERE id=${readPositiveInteger(level.id,"inventory level id")}`);
  if (quantityPosting) await quantityPosting.post({ idempotencyKey: input.operationKey,kind: "return",actor: input.actor,
    reason: input.notes || "Approved physical return",reference: { type: input.referenceType,id: input.referenceId },occurredAt: input.now.toISOString() });
  return { productVariantId: input.productVariantId,warehouseLocationId: input.warehouseLocationId,quantity: input.quantity,
    inventoryTransactionId: inventoryTransactionIds[0],inventoryLotId: inventoryLotIds[0],inventoryLotIds,inventoryTransactionIds,replayed: false };
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

function validateReplay(rows: ExistingTransactionRow[], input: ApplyReturnedStockInput): ApplyReturnRestockResult {
  let quantity = 0;
  const inventoryLotIds: number[] = [];
  const inventoryTransactionIds: number[] = [];
  for (const row of rows) {
    if (readPositiveInteger(row.order_id,"existing return WMS order") !== input.wmsOrderId
      || (row.order_item_id === null ? null : readPositiveInteger(row.order_item_id,"existing return WMS item")) !== input.wmsOrderItemId
      || readPositiveInteger(row.product_variant_id,"existing return variant") !== input.productVariantId
      || readPositiveInteger(row.to_location_id,"existing return location") !== input.warehouseLocationId) {
      throw conflict("RETURN_RESTOCK_REPLAY_CONFLICT","Existing return evidence identifies different stock.",input);
    }
    quantity=checkedAdd(quantity,readPositiveInteger(row.variant_qty_delta,"existing return quantity"),input);
    inventoryLotIds.push(readPositiveInteger(row.inventory_lot_id,"existing return lot"));
    inventoryTransactionIds.push(readPositiveInteger(row.id,"existing return transaction"));
  }
  if (quantity !== input.quantity) throw conflict("RETURN_RESTOCK_REPLAY_CONFLICT","Existing return quantity differs from this command.",input);
  return { productVariantId: input.productVariantId,warehouseLocationId: input.warehouseLocationId,quantity,
    inventoryTransactionId: inventoryTransactionIds[0],inventoryLotId: inventoryLotIds[0],inventoryLotIds,inventoryTransactionIds,replayed: true };
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


function conflict(code: string, message: string, context: object): ReturnRestockError {
  return new ReturnRestockError(code, message, { ...context });
}

function integrity(code: string, message: string, context: object): ReturnRestockError {
  return new ReturnRestockError(code, message, { ...context });
}
