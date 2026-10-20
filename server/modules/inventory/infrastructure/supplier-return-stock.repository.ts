import { sql } from "drizzle-orm";
import {
  supplierReturnOptionsQuerySchema, supplierReturnPreviewInputSchema, supplierReturnStockOptionsSchema,
  supplierReturnStockPreviewLineSchema, supplierReturnStockPreviewSchema,
  type SupplierReturnPreviewInput, type SupplierReturnStockPreview, type SupplierReturnStockPreviewLine,
} from "@shared/procurement/supplier-return";
import { costFingerprint, costInteger, type CostEvidenceTransaction } from "./cost-evidence.repository";
import { readLotCostQuantityState } from "./cost-quantity.repository";
import { lotCostNeedsReview } from "../domain/lot-cost";
import {
  MAX_SUPPLIER_RETURN_ANCESTORS, SupplierReturnStockError, planSupplierReturnQuantity, proveSupplierReturnProvenance,
  type SupplierReturnOriginEvidence, type SupplierReturnProvenanceLot, type SupplierReturnTransferEvidence,
} from "../domain/supplier-return-stock";

const MAX_SOURCE_LOTS = 10_000;
type Row = Record<string, unknown>;
const id = (value: unknown, field: string) => costInteger(value, field, 1);
const nullableId = (value: unknown, field: string) => value == null ? null : id(value, field);
const flag = (value: unknown) => value === true;
const text = (value: unknown) => value == null ? null : String(value);
const unitLabel = (units: number | null) => units === null ? "Unverified lot unit" : units === 1 ? "piece" : `${units} pieces per lot unit`;

interface SourceGraph {
  rows: Map<number, Row>;
  lots: SupplierReturnProvenanceLot[];
  origins: SupplierReturnOriginEvidence[];
  transfers: SupplierReturnTransferEvidence[];
  quantityAuthority: "pre_opening" | "ledger";
}

/** All choices and exact previews share this provenance read. The caller owns
 * a repeatable-read snapshot for reads and the graph fence for execution. */
async function readSourceGraph(tx: CostEvidenceTransaction, selectedIds: readonly number[]): Promise<SourceGraph> {
  const opening = (await tx.execute(sql`SELECT command_id FROM inventory.quantity_ledger_opening WHERE singleton_key=true`)).rows;
  if (opening.length > 1) throw new Error("Supplier return quantity authority is ambiguous.");
  const quantityAuthority = opening.length === 1 ? "ledger" : "pre_opening";
  const ancestors = (await tx.execute(sql`
    WITH RECURSIVE ancestors(id,depth,path) AS (
      SELECT value::integer,0,ARRAY[value::integer] FROM jsonb_array_elements_text(${JSON.stringify(selectedIds)}::jsonb)
      UNION ALL
      SELECT edge.source_lot_id,parent.depth+1,parent.path||edge.source_lot_id
      FROM inventory.lot_cost_contributions edge JOIN ancestors parent ON edge.output_lot_id=parent.id
      WHERE parent.depth<${MAX_SUPPLIER_RETURN_ANCESTORS}
        AND NOT edge.source_lot_id=ANY(parent.path)
    ) SELECT DISTINCT id FROM ancestors ORDER BY id LIMIT ${MAX_SOURCE_LOTS + 1}
  `)).rows;
  if (ancestors.length > MAX_SOURCE_LOTS) throw new SupplierReturnStockError("SUPPLIER_RETURN_SOURCE_LIMIT", "The selected source graph exceeds the bounded return review.");
  const ancestorIds = ancestors.map(row => id(row.id, "ancestorLotId"));
  const lotRows = (await tx.execute(sql`
    SELECT lot.*,variant.product_id,variant.sku,location.code AS location_code,location.warehouse_id,
      location.is_active AS location_active,location.cycle_count_freeze_id,warehouse.is_active AS warehouse_active,
      level.id AS inventory_level_id,level.variant_qty AS level_on_hand,level.reserved_qty AS level_reserved,
      level.picked_qty AS level_picked,level.packed_qty AS level_packed,
      ${quantityAuthority === "ledger" ? sql`journal.on_hand AS journal_on_hand,journal.reserved AS journal_reserved,
        journal.picked AS journal_picked,journal.packed AS journal_packed,
        level_journal.on_hand AS journal_level_on_hand,level_journal.reserved AS journal_level_reserved,
        level_journal.picked AS journal_level_picked,level_journal.packed AS journal_level_packed`
        : sql`NULL AS journal_on_hand,NULL AS journal_reserved,NULL AS journal_picked,NULL AS journal_packed,
        NULL AS journal_level_on_hand,NULL AS journal_level_reserved,NULL AS journal_level_picked,NULL AS journal_level_packed`}
    FROM inventory.inventory_lots lot JOIN catalog.product_variants variant ON variant.id=lot.product_variant_id
    JOIN warehouse.warehouse_locations location ON location.id=lot.warehouse_location_id
    LEFT JOIN warehouse.warehouses warehouse ON warehouse.id=location.warehouse_id
    LEFT JOIN inventory.inventory_levels level ON level.product_variant_id=lot.product_variant_id AND level.warehouse_location_id=lot.warehouse_location_id
    ${quantityAuthority === "ledger" ? sql`LEFT JOIN inventory.quantity_lot_balances journal ON journal.inventory_lot_id=lot.id
      LEFT JOIN inventory.quantity_level_balances level_journal ON level_journal.inventory_level_id=level.id` : sql``}
    WHERE lot.id=ANY(${sql.param(ancestorIds)}::integer[]) ORDER BY lot.id
  `)).rows as Row[];
  const rows = new Map(lotRows.map(row => [id(row.id, "inventoryLotId"), row]));
  if (rows.size !== lotRows.length) throw new Error("Supplier return source has duplicate physical level identity.");
  const lots: SupplierReturnProvenanceLot[] = lotRows.map(row => ({
    id: id(row.id, "inventoryLotId"), productId: id(row.product_id, "productId"), productVariantId: id(row.product_variant_id, "productVariantId"),
    receivedQuantity: costInteger(row.qty_received, "receivedQuantity"),
    purchaseOrderId: nullableId(row.purchase_order_id, "purchaseOrderId"), purchaseOrderLineId: nullableId(row.po_line_id, "purchaseOrderLineId"),
    receivingOrderId: nullableId(row.receiving_order_id, "receivingOrderId"),
  }));
  const origins = (await tx.execute(sql`
    SELECT origin.*,line.receiving_order_id,line.purchase_order_line_id AS current_po_line_id,
      line.product_id AS receipt_product_id,line.product_variant_id AS receipt_variant_id,line.units_per_variant_snapshot AS receipt_units,
      line.received_qty,line.cost_source_kind,receipt.status AS receipt_status,po_line.purchase_order_id,po.vendor_id,
      po_line.product_id AS po_product_id,
      (SELECT COALESCE(sum(other.received_variant_qty),0) FROM inventory.effective_lot_cost_origins other
        WHERE other.receiving_line_id=origin.receiving_line_id) AS origin_received_quantity,
      EXISTS(SELECT 1 FROM procurement.receipt_reversals reversal WHERE reversal.receiving_line_id=origin.receiving_line_id) AS has_reversal
    FROM inventory.effective_lot_cost_origins origin JOIN procurement.receiving_lines line ON line.id=origin.receiving_line_id
    JOIN procurement.receiving_orders receipt ON receipt.id=line.receiving_order_id
    JOIN procurement.purchase_order_lines po_line ON po_line.id=origin.purchase_order_line_id
    JOIN procurement.purchase_orders po ON po.id=po_line.purchase_order_id
    WHERE origin.inventory_lot_id=ANY(${sql.param(ancestorIds)}::integer[]) ORDER BY origin.inventory_lot_id
  `)).rows.map((row): SupplierReturnOriginEvidence => ({
    origin: {
      inventoryLotId: id(row.inventory_lot_id, "origin.inventoryLotId"), receivingLineId: id(row.receiving_line_id, "receivingLineId"),
      receivingOrderId: id(row.receiving_order_id, "receivingOrderId"), purchaseOrderLineId: id(row.purchase_order_line_id, "purchaseOrderLineId"),
      purchaseOrderId: id(row.purchase_order_id, "purchaseOrderId"), vendorId: id(row.vendor_id, "vendorId"),
      productId: id(row.po_product_id, "productId"), productVariantId: id(rows.get(Number(row.inventory_lot_id))?.product_variant_id, "origin.productVariantId"),
      unitsPerVariant: id(row.units_per_variant_snapshot, "unitsPerVariant"), receivedVariantQuantity: id(row.received_variant_qty, "receivedVariantQuantity"),
      purchaseStartBasePiece: costInteger(row.purchase_start_base_piece, "purchaseStartBasePiece"),
      inboundShipmentLineId: nullableId(row.inbound_shipment_line_id, "inboundShipmentLineId"),
      shipmentStartBasePiece: row.shipment_start_base_piece == null ? null : costInteger(row.shipment_start_base_piece, "shipmentStartBasePiece"),
    },
    receipt: {
      receivingOrderId: id(row.receiving_order_id, "receiptId"), purchaseOrderLineId: nullableId(row.current_po_line_id, "receipt.poLineId"),
      productId: nullableId(row.receipt_product_id, "receipt.productId"), productVariantId: nullableId(row.receipt_variant_id, "receipt.variantId"),
      unitsPerVariant: nullableId(row.receipt_units, "receipt.units"), receivedQuantity: costInteger(row.received_qty, "receipt.receivedQuantity"),
      recordedOriginQuantity: costInteger(row.origin_received_quantity, "receipt.originQuantity"), closed: row.receipt_status === "closed",
      hasReversal: flag(row.has_reversal), costSourceKind: text(row.cost_source_kind),
    },
  }));
  const transfers = (await tx.execute(sql`
    SELECT edge.*,mapping.allocation_id,allocation.inventory_lot_id AS allocation_lot_id,allocation.quantity AS allocation_quantity,
      allocation.direction,allocation.intervals,
      EXISTS(SELECT 1 FROM inventory.lot_cost_quantity_allocations reversal
        WHERE reversal.reverses_allocation_id=allocation.id) AS has_allocation_reversal
    FROM inventory.lot_cost_contributions edge
    LEFT JOIN inventory.lot_cost_contribution_allocations mapping ON mapping.contribution_id=edge.id
    LEFT JOIN inventory.lot_cost_quantity_allocations allocation ON allocation.id=mapping.allocation_id
    WHERE edge.output_lot_id=ANY(${sql.param(ancestorIds)}::integer[]) ORDER BY edge.id LIMIT ${MAX_SOURCE_LOTS + 1}
  `)).rows;
  if (transfers.length > MAX_SOURCE_LOTS) throw new SupplierReturnStockError("SUPPLIER_RETURN_SOURCE_LIMIT", "The source contribution set exceeds the bounded return review.");
  return {
    rows, lots, origins, quantityAuthority,
    transfers: transfers.map(row => ({
      transfer: {
        contributionId: id(row.id, "contributionId"), sourceLotId: id(row.source_lot_id, "sourceLotId"), outputLotId: id(row.output_lot_id, "outputLotId"),
        sourceQuantity: id(row.source_qty, "sourceQuantity"), outputQuantity: id(row.output_qty, "outputQuantity"),
        outputStartQuantity: costInteger(row.output_start_qty, "outputStartQuantity"),
        // Missing exact allocations remain explicit ineligibility, never an
        // invented allocation identity in a successful public proof.
        allocationId: row.allocation_id == null ? 0 : id(row.allocation_id, "allocationId"), intervals: row.intervals ?? [],
      },
      operationKind: String(row.operation_kind), allocationLotId: row.allocation_lot_id == null ? 0 : id(row.allocation_lot_id, "allocationLotId"),
      allocationQuantity: row.allocation_quantity == null ? 0 : id(row.allocation_quantity, "allocationQuantity"),
      allocationDirection: row.direction == null ? 0 : costInteger(row.direction, "direction", -1), hasAllocationReversal: flag(row.has_allocation_reversal),
    })),
  };
}

function stockBalances(row: Row, mode: SourceGraph["quantityAuthority"]) {
  const lot = { onHand: costInteger(row.qty_on_hand, "lot.onHand"), reserved: costInteger(row.qty_reserved, "lot.reserved"),
    picked: costInteger(row.qty_picked, "lot.picked"), packed: costInteger(row.qty_packed, "lot.packed") };
  const level = { onHand: costInteger(row.level_on_hand, "level.onHand"), reserved: costInteger(row.level_reserved, "level.reserved"),
    picked: costInteger(row.level_picked, "level.picked"), packed: costInteger(row.level_packed, "level.packed") };
  if (mode === "ledger") {
    for (const key of ["onHand", "reserved", "picked", "packed"] as const) {
      const column = key === "onHand" ? "on_hand" : key;
      if (lot[key] !== costInteger(row[`journal_${column}`] ?? 0, `journal.${key}`)
        || level[key] !== costInteger(row[`journal_level_${column}`] ?? 0, `journal.level.${key}`)) {
        throw new SupplierReturnStockError("SUPPLIER_RETURN_QUANTITY_AUTHORITY_MISMATCH", "Inventory quantity projections disagree with their ledger. Resolve the stock evidence before returning goods.");
      }
    }
  }
  return { lot, level };
}

async function planLine(tx: CostEvidenceTransaction, graph: SourceGraph, vendorId: number, selection: SupplierReturnPreviewInput["lines"][number]) {
  const row = graph.rows.get(selection.inventoryLotId);
  if (!row) throw new SupplierReturnStockError("SUPPLIER_RETURN_LOT_MISSING", "The selected stock lot no longer exists.");
  const proof = proveSupplierReturnProvenance({ inventoryLotId: selection.inventoryLotId, vendorId, ...graph });
  if (row.inventory_level_id == null || row.warehouse_id == null) throw new SupplierReturnStockError("SUPPLIER_RETURN_LOCATION_REQUIRED", "The lot needs an exact warehouse location and inventory level.");
  if (row.location_active !== 1 || row.warehouse_active !== 1) throw new SupplierReturnStockError("SUPPLIER_RETURN_LOCATION_INACTIVE", "Supplier returns require an active warehouse and stock location.");
  if (row.cycle_count_freeze_id != null) throw new SupplierReturnStockError("SUPPLIER_RETURN_LOCATION_FROZEN", "Finish the location's cycle count before returning this stock.");
  const balances = stockBalances(row, graph.quantityAuthority);
  const custody = await readLotCostQuantityState(tx, { ...row, id: row.id });
  const plan = planSupplierReturnQuantity({ lot: row, quantity: selection.quantity, onHand: balances.lot.onHand,
    reserved: balances.lot.reserved, ...custody });
  if (balances.level.reserved > balances.level.onHand || selection.quantity > balances.level.onHand - balances.level.reserved) {
    throw new SupplierReturnStockError("SUPPLIER_RETURN_LEVEL_UNAVAILABLE", "The selected quantity is not available at its inventory location.");
  }
  const line = supplierReturnStockPreviewLineSchema.parse({
    inventoryLotId: selection.inventoryLotId, inventoryLevelId: id(row.inventory_level_id, "inventoryLevelId"),
    warehouseLocationId: id(row.warehouse_location_id, "warehouseLocationId"), warehouseId: id(row.warehouse_id, "warehouseId"),
    productId: id(row.product_id, "productId"), productVariantId: id(row.product_variant_id, "productVariantId"),
    lotNumber: String(row.lot_number), sku: text(row.sku), locationCode: String(row.location_code),
    quantity: selection.quantity, availableQuantity: plan.availableQuantity, levelAvailableQuantity: balances.level.onHand - balances.level.reserved,
    unitsPerVariant: proof.origin.unitsPerVariant, unitLabel: unitLabel(proof.origin.unitsPerVariant),
    basePieces: costInteger((BigInt(selection.quantity) * BigInt(proof.origin.unitsPerVariant)).toString(), "basePieces", 1),
    sourceProof: proof, intervals: plan.intervals, costs: plan.costs, costProvisional: lotCostNeedsReview(row),
  });
  return { line, fingerprintEvidence: { balances, custody, costs: line.costs, proof, quantity: line.quantity,
    inventoryLotId: line.inventoryLotId, inventoryLevelId: line.inventoryLevelId, warehouseLocationId: line.warehouseLocationId, warehouseId: line.warehouseId } };
}

export async function readSupplierReturnStockSnapshot(tx: CostEvidenceTransaction, rawInput: SupplierReturnPreviewInput) {
  const input = supplierReturnPreviewInputSchema.parse(rawInput);
  const selections = [...input.lines].sort((a, b) => a.inventoryLotId - b.inventoryLotId);
  const graph = await readSourceGraph(tx, selections.map(line => line.inventoryLotId));
  const planned = [];
  for (const selection of selections) planned.push(await planLine(tx, graph, input.vendorId, selection));
  const lines = planned.map(item => item.line);
  const levelTotals = new Map<number, bigint>();
  for (const line of lines) {
    const total = (levelTotals.get(line.inventoryLevelId) ?? BigInt(0)) + BigInt(line.quantity);
    if (total > BigInt(line.levelAvailableQuantity)) throw new SupplierReturnStockError("SUPPLIER_RETURN_LEVEL_UNAVAILABLE", "The selected lots together exceed unreserved stock at their location.");
    levelTotals.set(line.inventoryLevelId, total);
  }
  const sum = (key: keyof SupplierReturnStockPreview["totals"]) => costInteger(lines.reduce((total, line) => total + BigInt(line.costs[key]), BigInt(0)).toString(), key);
  const preview = supplierReturnStockPreviewSchema.parse({
    vendorId: input.vendorId, currency: "USD", sourceFingerprint: costFingerprint({ contractVersion: 1, vendorId: input.vendorId,
      quantityAuthority: graph.quantityAuthority, lines: planned.map(item => item.fingerprintEvidence) }),
    lines, totals: { productMills: sum("productMills"), packagingMills: sum("packagingMills"), landedMills: sum("landedMills"), totalMills: sum("totalMills") },
    costProvisional: lines.some(line => line.costProvisional),
  });
  return { preview, rows: graph.rows, quantityAuthority: graph.quantityAuthority };
}

/** Lock physical identities in the same order as the quantity ledger. The
 * application must already hold admission and the cost graph fence. */
export async function lockSupplierReturnStock(tx: CostEvidenceTransaction, lotIds: readonly number[]): Promise<void> {
  await tx.execute(sql`SELECT location.id FROM warehouse.warehouse_locations location
    WHERE location.id IN (SELECT warehouse_location_id FROM inventory.inventory_lots WHERE id=ANY(${sql.param(lotIds)}::integer[]))
    ORDER BY location.id FOR SHARE`);
  await tx.execute(sql`SELECT warehouse.id FROM warehouse.warehouses warehouse WHERE warehouse.id IN (
    SELECT location.warehouse_id FROM warehouse.warehouse_locations location JOIN inventory.inventory_lots lot ON lot.warehouse_location_id=location.id
    WHERE lot.id=ANY(${sql.param(lotIds)}::integer[])) ORDER BY warehouse.id FOR SHARE`);
  await tx.execute(sql`SELECT level.id FROM inventory.inventory_levels level WHERE EXISTS(
    SELECT 1 FROM inventory.inventory_lots lot WHERE lot.id=ANY(${sql.param(lotIds)}::integer[])
      AND lot.warehouse_location_id=level.warehouse_location_id AND lot.product_variant_id=level.product_variant_id)
    ORDER BY level.warehouse_location_id,level.product_variant_id,level.id FOR UPDATE`);
  await tx.execute(sql`SELECT id FROM inventory.inventory_lots WHERE id=ANY(${sql.param(lotIds)}::integer[])
    ORDER BY warehouse_location_id,product_variant_id,received_at,id FOR UPDATE`);
}

export async function readSupplierReturnStockOptions(tx: CostEvidenceTransaction, rawInput: unknown) {
  const input = supplierReturnOptionsQuerySchema.parse(rawInput);
  const candidates = (await tx.execute(sql`
    WITH RECURSIVE supplier_lots(id,purchase_order_id,receiving_order_id,purchase_order_line_id) AS (
      SELECT origin.inventory_lot_id,po.id,line.receiving_order_id,origin.purchase_order_line_id
      FROM inventory.effective_lot_cost_origins origin JOIN procurement.purchase_order_lines po_line ON po_line.id=origin.purchase_order_line_id
      JOIN procurement.purchase_orders po ON po.id=po_line.purchase_order_id
      JOIN procurement.receiving_lines line ON line.id=origin.receiving_line_id
      WHERE po.vendor_id=${input.vendorId} AND (${input.purchaseOrderId ?? null}::integer IS NULL OR po.id=${input.purchaseOrderId ?? null})
        AND (${input.receivingOrderId ?? null}::integer IS NULL OR line.receiving_order_id=${input.receivingOrderId ?? null})
      UNION SELECT edge.output_lot_id,parent.purchase_order_id,parent.receiving_order_id,parent.purchase_order_line_id
        FROM inventory.lot_cost_contributions edge JOIN supplier_lots parent ON edge.source_lot_id=parent.id
    )
    SELECT lot.id,MIN(source.purchase_order_id) AS purchase_order_id,MIN(source.receiving_order_id) AS receiving_order_id,
      MIN(source.purchase_order_line_id) AS purchase_order_line_id
    FROM supplier_lots source JOIN inventory.inventory_lots lot ON lot.id=source.id
    WHERE lot.id>${input.afterLotId ?? 0} AND lot.qty_on_hand>0 GROUP BY lot.id
    ORDER BY lot.id LIMIT ${input.limit + 1}
  `)).rows;
  const page = candidates.slice(0, input.limit);
  if (page.length === 0) return supplierReturnStockOptionsSchema.parse({ items: [], nextAfterLotId: null });
  const graph = await readSourceGraph(tx, page.map(row => id(row.id, "lotId")));
  const items = [];
  for (const candidate of page) {
    const inventoryLotId = id(candidate.id, "lotId");
    const row = graph.rows.get(inventoryLotId);
    if (!row) throw new Error("A supplier return option disappeared inside the source snapshot.");
    let line: SupplierReturnStockPreviewLine | undefined;
    let units: number | null = null;
    const issues: { code: string; message: string }[] = [];
    try {
      units = proveSupplierReturnProvenance({ inventoryLotId, vendorId: input.vendorId, ...graph }).origin.unitsPerVariant;
      line = (await planLine(tx, graph, input.vendorId, { inventoryLotId, quantity: 1 })).line;
    } catch (error) {
      if (!(error instanceof SupplierReturnStockError)) throw error;
      issues.push({ code: error.code, message: error.message });
    }
    items.push({
      inventoryLotId, inventoryLevelId: nullableId(row.inventory_level_id, "inventoryLevelId"),
      warehouseLocationId: id(row.warehouse_location_id, "warehouseLocationId"), warehouseId: nullableId(row.warehouse_id, "warehouseId"),
      productId: id(row.product_id, "productId"), productVariantId: id(row.product_variant_id, "productVariantId"),
      lotNumber: String(row.lot_number), sku: text(row.sku), locationCode: String(row.location_code), unitLabel: unitLabel(units),
      purchaseOrderId: id(candidate.purchase_order_id, "purchaseOrderId"), receivingOrderId: id(candidate.receiving_order_id, "receivingOrderId"),
      purchaseOrderLineId: id(candidate.purchase_order_line_id, "purchaseOrderLineId"), unitsPerVariant: units,
      availableQuantity: line?.availableQuantity ?? Math.max(0, costInteger(row.qty_on_hand, "onHand") - costInteger(row.qty_reserved, "reserved")),
      eligible: line !== undefined, issues,
    });
  }
  return supplierReturnStockOptionsSchema.parse({ items, nextAfterLotId: candidates.length > input.limit ? id(page.at(-1)!.id, "nextAfterLotId") : null });
}
