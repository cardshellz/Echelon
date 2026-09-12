import Papa from "papaparse";
import { openingVerificationSchema, requiredOpeningItems } from "@shared/types/inventory-cutover-opening";
import type { OpeningSource, OpeningVerification } from "./inventory-cutover-opening-document";

export const OPENING_SPREADSHEET_LIMIT_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50_000;
const INTEGER_MAX = BigInt(2_147_483_647);

export type OpeningSpreadsheetKind = "stock" | "orders" | "allocations";
export type OpeningSpreadsheetDocument = { name: string; text: string };
export type OpeningSpreadsheetMetadata = {
  verificationReference: string;
  verifiedAt: string;
  reservationBasis?: OpeningVerification["reservationBasis"];
};

const STOCK_HEADERS = [
  "worksheet_type", "source_snapshot_do_not_edit", "snapshot_captured_at", "sku", "warehouse", "bin",
  "stock_position_id_do_not_edit", "lot_id_do_not_edit", "product_variant_id_do_not_edit",
  "warehouse_location_id_do_not_edit", "recorded_on_hand", "recorded_reserved", "recorded_picked",
  "enter_verified_on_hand", "enter_verified_reserved", "enter_verified_picked", "lot_status",
  "recorded_unit_cost_dollars", "recorded_po_unit_cost_dollars", "recorded_packaging_unit_cost_dollars",
  "recorded_landed_unit_cost_dollars",
] as const;

const ORDER_HEADERS = [
  "worksheet_type", "source_snapshot_do_not_edit", "snapshot_captured_at", "order_number", "external_order_id",
  "wms_order_id_do_not_edit", "order_line_id_do_not_edit", "channel_id", "source", "sku", "source_item_id",
  "warehouse", "recorded_ordered", "recorded_fulfilled", "recorded_current_picked",
  "enter_verified_remaining", "enter_verified_physical_reserved", "enter_verified_physical_picked",
  "allocation_candidate_rows",
] as const;

const ALLOCATION_HEADERS = [
  "worksheet_type", "source_snapshot_do_not_edit", "snapshot_captured_at", "order_number", "external_order_id",
  "wms_order_id_do_not_edit", "order_line_id_do_not_edit", "sku", "warehouse", "bin",
  "stock_position_id_do_not_edit", "lot_id_do_not_edit", "product_variant_id_do_not_edit",
  "warehouse_location_id_do_not_edit", "recorded_lot_reserved", "recorded_lot_picked",
  "available_original_cost_ids", "available_original_cost_details", "enter_unlisted_lot_id",
  "enter_verified_reserved",
  "enter_verified_picked", "enter_original_cost_ids_or_all",
] as const;

type CsvRow = Record<string, string>;
type CandidateIdentity = {
  key: string;
  orderId: number;
  orderItemId: number;
  inventoryLevelId: number;
  inventoryLotId: number;
  originalCostIds: number[];
};
type Candidate = CandidateIdentity & { row: CsvRow };

function labelMap(source: OpeningSource): Map<string, string> {
  return new Map(source.labels.map((row) => [`${row.kind}:${row.id}`, row.label]));
}

function label(labels: Map<string, string>, kind: string, id: number | null): string {
  return id === null ? "Unassigned" : labels.get(`${kind}:${id}`) ?? `${kind} ${id} (label unavailable)`;
}

function csv(fields: readonly string[], data: CsvRow[]): string {
  return `\uFEFF${Papa.unparse({ fields: [...fields], data }, {
    newline: "\r\n",
    escapeFormulae: true,
  })}`;
}

function millsToDollars(value: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const padded = digits.padStart(4, "0");
  const dollars = padded.slice(0, -3);
  const mills = padded.slice(-3);
  return `${negative ? "-" : ""}${dollars}.${mills}`;
}

function levelForLot(source: OpeningSource, lot: OpeningSource["evidence"]["lots"][number]) {
  const matches = source.evidence.levels.filter((level) => level.productVariantId === lot.productVariantId
    && level.warehouseLocationId === lot.warehouseLocationId);
  return matches.length === 1 ? matches[0] : null;
}

function allocationCandidates(source: OpeningSource): Candidate[] {
  const labels = labelMap(source);
  const orders = new Map(source.evidence.orders.map((order) => [order.id, order]));
  const items = new Map(requiredOpeningItems(source.evidence).map((item) => [item.id, item]));
  const lotsById = new Map(source.evidence.lots.map((lot) => [lot.id, lot]));
  const variantsBySku = new Map<string, OpeningSource["evidence"]["variants"]>();
  for (const variant of source.evidence.variants) if (variant.isActive && variant.requiresShipping && variant.trackInventory) {
    const key = variant.sku.toUpperCase();
    const rows = variantsBySku.get(key) ?? [];
    rows.push(variant);
    variantsBySku.set(key, rows);
  }
  const levelsByWarehouseVariant = new Map<string, OpeningSource["evidence"]["levels"]>();
  for (const level of source.evidence.levels) if (level.warehouseId !== null) {
    const key = `${level.warehouseId}:${level.productVariantId}`;
    const rows = levelsByWarehouseVariant.get(key) ?? [];
    rows.push(level);
    levelsByWarehouseVariant.set(key, rows);
  }
  const lotsByLocationVariant = new Map<string, OpeningSource["evidence"]["lots"]>();
  for (const lot of source.evidence.lots) if (lot.warehouseLocationId !== null) {
    const key = `${lot.warehouseLocationId}:${lot.productVariantId}`;
    const rows = lotsByLocationVariant.get(key) ?? [];
    rows.push(lot);
    lotsByLocationVariant.set(key, rows);
  }
  const costsByOwnerLot = new Map<string, OpeningSource["evidence"]["costs"]>();
  for (const cost of source.evidence.costs) {
    const key = `${cost.orderId}:${cost.orderItemId}:${cost.inventoryLotId}:${cost.productVariantId}`;
    const rows = costsByOwnerLot.get(key) ?? [];
    rows.push(cost);
    costsByOwnerLot.set(key, rows);
  }
  const candidates: Candidate[] = [];
  const candidateKeys = new Set<string>();
  const addCandidate = (item: OpeningSource["evidence"]["items"][number],
    level: OpeningSource["evidence"]["levels"][number], lot: OpeningSource["evidence"]["lots"][number]) => {
    const order = orders.get(item.orderId);
    const variants = variantsBySku.get(item.sku.toUpperCase()) ?? [];
    const variant = variants.length === 1 ? variants[0] : null;
    if (!order || order.warehouseId === null || !variant || variant.id !== level.productVariantId
      || lot.productVariantId !== variant.id || lot.warehouseLocationId !== level.warehouseLocationId
      || level.warehouseId !== order.warehouseId) return;
    const originalCosts = [...(costsByOwnerLot.get(`${item.orderId}:${item.id}:${lot.id}:${lot.productVariantId}`) ?? [])]
      .sort((a, b) => a.id - b.id);
    const key = `${item.id}:${level.id}:${lot.id}`;
    if (candidateKeys.has(key)) return;
    candidateKeys.add(key);
    candidates.push({ key, orderId: item.orderId, orderItemId: item.id, inventoryLevelId: level.id,
      inventoryLotId: lot.id, originalCostIds: originalCosts.map((cost) => cost.id), row: {
        worksheet_type: "LOT_OWNERSHIP",
        source_snapshot_do_not_edit: source.evidenceHash,
        snapshot_captured_at: source.capturedAt,
        order_number: label(labels, "order", item.orderId),
        external_order_id: order.externalOrderId ?? "",
        wms_order_id_do_not_edit: String(item.orderId),
        order_line_id_do_not_edit: String(item.id),
        sku: item.sku,
        warehouse: label(labels, "warehouse", order.warehouseId),
        bin: label(labels, "location", level.warehouseLocationId),
        stock_position_id_do_not_edit: String(level.id),
        lot_id_do_not_edit: String(lot.id),
        product_variant_id_do_not_edit: String(variant.id),
        warehouse_location_id_do_not_edit: String(level.warehouseLocationId),
        recorded_lot_reserved: lot.reservedQty,
        recorded_lot_picked: lot.pickedQty,
        available_original_cost_ids: originalCosts.map((cost) => cost.id).join(","),
        available_original_cost_details: originalCosts.map((cost) =>
          `${cost.id}: qty ${cost.quantity} at $${millsToDollars(cost.unitCostMills)}`).join("; "),
        enter_unlisted_lot_id: "",
        enter_verified_reserved: "",
        enter_verified_picked: "",
        enter_original_cost_ids_or_all: "",
      } });
  };
  // Pre-populate only exact persisted owner/location or original-cost links.
  // A full owner-by-lot Cartesian product is both misleading and unbounded.
  for (const journal of source.evidence.journals) {
    if (journal.orderItemId === null || journal.productVariantId === null || journal.warehouseLocationId === null) continue;
    const item = items.get(journal.orderItemId);
    const order = item ? orders.get(item.orderId) : null;
    if (!item || (journal.orderId !== null && journal.orderId !== item.orderId) || !order || order.warehouseId === null) continue;
    const levels = (levelsByWarehouseVariant.get(`${order.warehouseId}:${journal.productVariantId}`) ?? [])
      .filter((level) => level.warehouseLocationId === journal.warehouseLocationId);
    const lots = lotsByLocationVariant.get(`${journal.warehouseLocationId}:${journal.productVariantId}`) ?? [];
    for (const level of levels) for (const lot of lots) addCandidate(item, level, lot);
  }
  for (const cost of source.evidence.costs) {
    const item = items.get(cost.orderItemId);
    const lot = lotsById.get(cost.inventoryLotId);
    const level = lot ? levelForLot(source, lot) : null;
    if (item && cost.orderId === item.orderId && lot && cost.productVariantId === lot.productVariantId && level) {
      addCandidate(item, level, lot);
    }
  }
  if (candidates.length > MAX_ROWS) {
    throw new Error(`The ownership worksheet would contain more than ${MAX_ROWS} candidate rows. Narrow the source safely before exporting it.`);
  }
  return candidates.sort((a, b) => a.orderItemId - b.orderItemId
    || a.inventoryLevelId - b.inventoryLevelId || a.inventoryLotId - b.inventoryLotId);
}

export function createOpeningSpreadsheets(source: OpeningSource): Record<OpeningSpreadsheetKind, string> {
  const labels = labelMap(source);
  const candidates = allocationCandidates(source);
  const requiredItems = requiredOpeningItems(source.evidence);
  const candidateCounts = new Map<number, number>();
  const candidatesByOwner = new Map<number, Candidate[]>();
  for (const candidate of candidates) candidateCounts.set(candidate.orderItemId, (candidateCounts.get(candidate.orderItemId) ?? 0) + 1);
  for (const candidate of candidates) {
    const rows = candidatesByOwner.get(candidate.orderItemId) ?? [];
    rows.push(candidate);
    candidatesByOwner.set(candidate.orderItemId, rows);
  }
  const orders = new Map(source.evidence.orders.map((order) => [order.id, order]));

  const stockRows = [...source.evidence.lots].sort((a, b) => a.id - b.id).map((lot): CsvRow => {
    const level = levelForLot(source, lot);
    return {
      worksheet_type: "STOCK_LOT",
      source_snapshot_do_not_edit: source.evidenceHash,
      snapshot_captured_at: source.capturedAt,
      sku: label(labels, "variant", lot.productVariantId),
      warehouse: label(labels, "warehouse", level?.warehouseId ?? null),
      bin: label(labels, "location", lot.warehouseLocationId),
      stock_position_id_do_not_edit: level ? String(level.id) : "",
      lot_id_do_not_edit: String(lot.id),
      product_variant_id_do_not_edit: String(lot.productVariantId),
      warehouse_location_id_do_not_edit: lot.warehouseLocationId === null ? "" : String(lot.warehouseLocationId),
      recorded_on_hand: lot.onHandQty,
      recorded_reserved: lot.reservedQty,
      recorded_picked: lot.pickedQty,
      enter_verified_on_hand: "",
      enter_verified_reserved: "",
      enter_verified_picked: "",
      lot_status: lot.status,
      recorded_unit_cost_dollars: millsToDollars(lot.unitCostMills),
      recorded_po_unit_cost_dollars: millsToDollars(lot.poUnitCostMills),
      recorded_packaging_unit_cost_dollars: millsToDollars(lot.packagingUnitCostMills),
      recorded_landed_unit_cost_dollars: millsToDollars(lot.landedUnitCostMills),
    };
  });

  const orderRows = requiredItems.map((item): CsvRow => {
    const order = orders.get(item.orderId);
    return {
      worksheet_type: "OPEN_ORDER",
      source_snapshot_do_not_edit: source.evidenceHash,
      snapshot_captured_at: source.capturedAt,
      order_number: label(labels, "order", item.orderId),
      external_order_id: order?.externalOrderId ?? "",
      wms_order_id_do_not_edit: String(item.orderId),
      order_line_id_do_not_edit: String(item.id),
      channel_id: order?.channelId === null || order?.channelId === undefined ? "" : String(order.channelId),
      source: order?.source ?? "",
      sku: item.sku,
      source_item_id: item.sourceItemId ?? "",
      warehouse: label(labels, "warehouse", order?.warehouseId ?? null),
      recorded_ordered: String(item.quantity),
      recorded_fulfilled: String(item.fulfilledQuantity),
      recorded_current_picked: String(item.pickedQuantity - item.fulfilledQuantity),
      enter_verified_remaining: "",
      enter_verified_physical_reserved: "",
      enter_verified_physical_picked: "",
      allocation_candidate_rows: String(candidateCounts.get(item.id) ?? 0),
    };
  });

  const allocationRows = requiredItems.flatMap((item): CsvRow[] => {
    const order = orders.get(item.orderId);
    const template: CsvRow = {
      worksheet_type: "LOT_OWNERSHIP",
      source_snapshot_do_not_edit: source.evidenceHash,
      snapshot_captured_at: source.capturedAt,
      order_number: label(labels, "order", item.orderId),
      external_order_id: order?.externalOrderId ?? "",
      wms_order_id_do_not_edit: String(item.orderId),
      order_line_id_do_not_edit: String(item.id),
      sku: item.sku,
      warehouse: label(labels, "warehouse", order?.warehouseId ?? null),
      bin: "",
      stock_position_id_do_not_edit: "",
      lot_id_do_not_edit: "",
      product_variant_id_do_not_edit: "",
      warehouse_location_id_do_not_edit: "",
      recorded_lot_reserved: "",
      recorded_lot_picked: "",
      available_original_cost_ids: "",
      available_original_cost_details: "",
      enter_unlisted_lot_id: "",
      enter_verified_reserved: "",
      enter_verified_picked: "",
      enter_original_cost_ids_or_all: "",
    };
    return [...(candidatesByOwner.get(item.id) ?? []).map((candidate) => candidate.row), template];
  });
  if (allocationRows.length > MAX_ROWS) {
    throw new Error(`The ownership worksheet would contain more than ${MAX_ROWS} review rows. Resolve the source scope before exporting it.`);
  }

  return {
    stock: csv(STOCK_HEADERS, stockRows),
    orders: csv(ORDER_HEADERS, orderRows),
    allocations: csv(ALLOCATION_HEADERS, allocationRows),
  };
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function normalizedHeader(header: string): string {
  return header.replace(/^\uFEFF/, "").trim().toLowerCase();
}

function parseCsv(document: OpeningSpreadsheetDocument): { fields: string[]; rows: CsvRow[] } {
  if (bytes(document.text) > OPENING_SPREADSHEET_LIMIT_BYTES) {
    throw new Error(`${document.name} exceeds 10MB. No spreadsheet data was imported.`);
  }
  const parsed = Papa.parse<CsvRow>(document.text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: normalizedHeader,
  });
  if (parsed.errors.length > 0) {
    const issue = parsed.errors[0];
    throw new Error(`${document.name} is not valid CSV near row ${(issue.row ?? 0) + 2}: ${issue.message}`);
  }
  if (parsed.data.length > MAX_ROWS) throw new Error(`${document.name} contains more than ${MAX_ROWS} rows.`);
  return { fields: parsed.meta.fields ?? [], rows: parsed.data };
}

function spreadsheetKind(fields: string[], rows: CsvRow[], name: string): OpeningSpreadsheetKind {
  const type = rows[0]?.worksheet_type?.trim().toUpperCase();
  const kind = type === "STOCK_LOT" || (rows.length === 0 && fields.includes("enter_verified_on_hand")) ? "stock"
    : type === "OPEN_ORDER" || (rows.length === 0 && fields.includes("allocation_candidate_rows")) ? "orders"
    : type === "LOT_OWNERSHIP" || (rows.length === 0 && fields.includes("available_original_cost_ids")) ? "allocations" : null;
  if (!kind) throw new Error(`${name} is not one of the inventory opening spreadsheets.`);
  return kind;
}

function assertHeaders(actual: string[], expected: readonly string[], name: string): void {
  const missing = expected.filter((field) => !actual.includes(field));
  const unexpected = actual.filter((field) => !expected.includes(field));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [...missing.map((field) => `missing ${field}`), ...unexpected.map((field) => `unexpected ${field}`)].slice(0, 8);
    throw new Error(`${name} has changed columns: ${details.join(", ")}. Download a fresh worksheet and copy only entered values.`);
  }
}

function integer(value: string | undefined, row: number, field: string, options: { required?: boolean; positive?: boolean } = {}): string | null {
  const text = value?.trim() ?? "";
  if (!text && !options.required) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(text) || BigInt(text) > INTEGER_MAX || (options.positive && text === "0")) {
    throw new Error(`Row ${row} ${field} must be ${options.positive ? "a positive" : "a non-negative"} whole number.`);
  }
  return text;
}

function identifier(value: string | undefined, row: number, field: string): number {
  const parsed = integer(value, row, field, { required: true, positive: true });
  return Number(parsed);
}

function assertSnapshot(row: CsvRow, source: OpeningSource, rowNumber: number): void {
  if (row.source_snapshot_do_not_edit?.trim() !== source.evidenceHash || row.snapshot_captured_at?.trim() !== source.capturedAt) {
    throw new Error(`Row ${rowNumber} belongs to a different inventory snapshot. Download and complete fresh spreadsheets.`);
  }
}

function same(value: string | undefined, expected: string, row: number, field: string): void {
  const actual = value ?? "";
  const spreadsheetSafeExpected = /^[=+\-@\t\r]/.test(expected) ? `'${expected}` : expected;
  if (actual !== expected && actual !== spreadsheetSafeExpected) {
    throw new Error(`Row ${row} changed ${field}. Download a fresh worksheet and copy only entered values.`);
  }
}

function parseStock(rows: CsvRow[], source: OpeningSource): OpeningVerification["lots"] {
  const expected = new Map(source.evidence.lots.map((lot) => [lot.id, lot]));
  const seen = new Set<number>();
  const result: OpeningVerification["lots"] = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    assertSnapshot(row, source, rowNumber);
    const id = identifier(row.lot_id_do_not_edit, rowNumber, "lot_id_do_not_edit");
    const lot = expected.get(id);
    if (!lot || seen.has(id)) throw new Error(`Row ${rowNumber} has an unknown or duplicate lot ID ${id}.`);
    seen.add(id);
    same(row.worksheet_type, "STOCK_LOT", rowNumber, "worksheet_type");
    same(row.product_variant_id_do_not_edit, String(lot.productVariantId), rowNumber, "product_variant_id_do_not_edit");
    same(row.warehouse_location_id_do_not_edit, lot.warehouseLocationId === null ? "" : String(lot.warehouseLocationId), rowNumber, "warehouse_location_id_do_not_edit");
    same(row.recorded_on_hand, lot.onHandQty, rowNumber, "recorded_on_hand");
    same(row.recorded_reserved, lot.reservedQty, rowNumber, "recorded_reserved");
    same(row.recorded_picked, lot.pickedQty, rowNumber, "recorded_picked");
    same(row.lot_status, lot.status, rowNumber, "lot_status");
    same(row.recorded_unit_cost_dollars, millsToDollars(lot.unitCostMills), rowNumber, "recorded_unit_cost_dollars");
    same(row.recorded_po_unit_cost_dollars, millsToDollars(lot.poUnitCostMills), rowNumber, "recorded_po_unit_cost_dollars");
    same(row.recorded_packaging_unit_cost_dollars, millsToDollars(lot.packagingUnitCostMills), rowNumber, "recorded_packaging_unit_cost_dollars");
    same(row.recorded_landed_unit_cost_dollars, millsToDollars(lot.landedUnitCostMills), rowNumber, "recorded_landed_unit_cost_dollars");
    result.push({ ...lot,
      onHandQty: integer(row.enter_verified_on_hand, rowNumber, "enter_verified_on_hand", { required: true })!,
      reservedQty: integer(row.enter_verified_reserved, rowNumber, "enter_verified_reserved", { required: true })!,
      pickedQty: integer(row.enter_verified_picked, rowNumber, "enter_verified_picked", { required: true })!,
    });
  });
  if (seen.size !== expected.size) throw new Error(`The stock spreadsheet covers ${seen.size} of ${expected.size} required lots. No partial count was imported.`);
  return result.sort((a, b) => a.id - b.id);
}

function parseOrders(rows: CsvRow[], source: OpeningSource): Omit<OpeningVerification["owners"][number], "allocations">[] {
  const required = requiredOpeningItems(source.evidence);
  const expected = new Map(required.map((item) => [item.id, item]));
  const seen = new Set<number>();
  const result: Omit<OpeningVerification["owners"][number], "allocations">[] = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    assertSnapshot(row, source, rowNumber);
    const itemId = identifier(row.order_line_id_do_not_edit, rowNumber, "order_line_id_do_not_edit");
    const item = expected.get(itemId);
    if (!item || seen.has(itemId)) throw new Error(`Row ${rowNumber} has an unknown or duplicate order line ID ${itemId}.`);
    seen.add(itemId);
    same(row.worksheet_type, "OPEN_ORDER", rowNumber, "worksheet_type");
    same(row.wms_order_id_do_not_edit, String(item.orderId), rowNumber, "wms_order_id_do_not_edit");
    same(row.recorded_ordered, String(item.quantity), rowNumber, "recorded_ordered");
    same(row.recorded_fulfilled, String(item.fulfilledQuantity), rowNumber, "recorded_fulfilled");
    same(row.recorded_current_picked, String(item.pickedQuantity - item.fulfilledQuantity), rowNumber, "recorded_current_picked");
    result.push({ orderId: item.orderId, orderItemId: item.id,
      remainingQty: integer(row.enter_verified_remaining, rowNumber, "enter_verified_remaining", { required: true })!,
      reservedQty: integer(row.enter_verified_physical_reserved, rowNumber, "enter_verified_physical_reserved", { required: true })!,
      pickedQty: integer(row.enter_verified_physical_picked, rowNumber, "enter_verified_physical_picked", { required: true })!,
    });
  });
  if (seen.size !== expected.size) throw new Error(`The order spreadsheet covers ${seen.size} of ${expected.size} required order lines. No partial review was imported.`);
  return result.sort((a, b) => a.orderItemId - b.orderItemId);
}

function parseCostIds(value: string | undefined, candidate: CandidateIdentity, row: number, pickedQty: string): number[] {
  const text = value?.trim() ?? "";
  if (pickedQty === "0") {
    if (text && text.toUpperCase() !== "NONE") throw new Error(`Row ${row} cannot assign original costs when verified picked quantity is zero.`);
    return [];
  }
  if (!text) throw new Error(`Row ${row} must identify the original cost rows for its verified picked units.`);
  const ids = text.toUpperCase() === "ALL" ? candidate.originalCostIds
    : text.split(/[;,\s]+/).filter(Boolean).map((raw) => identifier(raw, row, "enter_original_cost_ids_or_all"));
  if (ids.length === 0 || new Set(ids).size !== ids.length || ids.some((id) => !candidate.originalCostIds.includes(id))) {
    throw new Error(`Row ${row} original cost IDs must be distinct IDs listed in available_original_cost_ids, or ALL.`);
  }
  return ids.sort((a, b) => a - b);
}

function parseAllocations(rows: CsvRow[], source: OpeningSource) {
  const items = new Map(requiredOpeningItems(source.evidence).map((item) => [item.id, item]));
  const orders = new Map(source.evidence.orders.map((order) => [order.id, order]));
  const levels = new Map(source.evidence.levels.map((level) => [level.id, level]));
  const lots = new Map(source.evidence.lots.map((lot) => [lot.id, lot]));
  const costs = new Map(source.evidence.costs.map((cost) => [cost.id, cost]));
  const seen = new Set<string>();
  const selected: Array<CandidateIdentity & { reservedQty: string; pickedQty: string; originalCostIds: number[] }> = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    assertSnapshot(row, source, rowNumber);
    same(row.worksheet_type, "LOT_OWNERSHIP", rowNumber, "worksheet_type");
    const itemId = identifier(row.order_line_id_do_not_edit, rowNumber, "order_line_id_do_not_edit");
    const item = items.get(itemId);
    if (!item) throw new Error(`Row ${rowNumber} has an unknown order line ID ${itemId}.`);
    same(row.wms_order_id_do_not_edit, String(item.orderId), rowNumber, "wms_order_id_do_not_edit");
    const reserved = integer(row.enter_verified_reserved, rowNumber, "enter_verified_reserved");
    const picked = integer(row.enter_verified_picked, rowNumber, "enter_verified_picked");
    if (reserved === null && picked === null) return;
    if (reserved === null || picked === null) throw new Error(`Row ${rowNumber} must enter both verified reserved and picked quantities, using 0 where applicable.`);
    if (reserved === "0" && picked === "0") return;
    const listedLot = row.lot_id_do_not_edit?.trim() ?? "";
    const enteredLot = row.enter_unlisted_lot_id?.trim() ?? "";
    if (listedLot && enteredLot && listedLot !== enteredLot) {
      throw new Error(`Row ${rowNumber} cannot select a different lot on a pre-listed ownership row. Use its blank extra row instead.`);
    }
    const lotId = identifier(listedLot || enteredLot, rowNumber, listedLot ? "lot_id_do_not_edit" : "enter_unlisted_lot_id");
    const lot = lots.get(lotId);
    const order = orders.get(item.orderId);
    const variants = source.evidence.variants.filter((variant) => variant.isActive && variant.requiresShipping
      && variant.trackInventory && variant.sku.toUpperCase() === item.sku.toUpperCase());
    if (!lot || !order || order.warehouseId === null || variants.length !== 1 || lot.productVariantId !== variants[0].id
      || lot.warehouseLocationId === null) {
      throw new Error(`Row ${rowNumber} lot ${lotId} does not belong to this order line's exact SKU and warehouse.`);
    }
    const enteredLevelId = integer(row.stock_position_id_do_not_edit, rowNumber, "stock_position_id_do_not_edit", { positive: true });
    const matchingLevels = source.evidence.levels.filter((level) => level.warehouseId === order.warehouseId
      && level.productVariantId === variants[0].id && level.warehouseLocationId === lot.warehouseLocationId);
    const level = enteredLevelId === null
      ? (matchingLevels.length === 1 ? matchingLevels[0] : null)
      : levels.get(Number(enteredLevelId));
    if (!level || !matchingLevels.some((match) => match.id === level.id)) {
      throw new Error(`Row ${rowNumber} cannot resolve one exact stock position for lot ${lotId} in the order warehouse.`);
    }
    if (row.product_variant_id_do_not_edit?.trim()) {
      same(row.product_variant_id_do_not_edit, String(lot.productVariantId), rowNumber, "product_variant_id_do_not_edit");
    }
    if (row.warehouse_location_id_do_not_edit?.trim()) {
      same(row.warehouse_location_id_do_not_edit, String(lot.warehouseLocationId), rowNumber, "warehouse_location_id_do_not_edit");
    }
    const originalCostIds = source.evidence.costs.filter((cost) => cost.orderId === item.orderId
      && cost.orderItemId === item.id && cost.inventoryLotId === lot.id && cost.productVariantId === lot.productVariantId)
      .sort((a, b) => a.id - b.id).map((cost) => cost.id);
    if (row.available_original_cost_ids?.trim()) {
      same(row.available_original_cost_ids, originalCostIds.join(","), rowNumber, "available_original_cost_ids");
    }
    if (row.recorded_lot_reserved?.trim()) same(row.recorded_lot_reserved, lot.reservedQty, rowNumber, "recorded_lot_reserved");
    if (row.recorded_lot_picked?.trim()) same(row.recorded_lot_picked, lot.pickedQty, rowNumber, "recorded_lot_picked");
    const candidate: CandidateIdentity = { key: `${item.id}:${level.id}:${lot.id}`, orderId: item.orderId,
      orderItemId: item.id, inventoryLevelId: level.id, inventoryLotId: lot.id, originalCostIds };
    if (seen.has(candidate.key)) throw new Error(`Row ${rowNumber} duplicates the same order/bin/lot assignment.`);
    seen.add(candidate.key);
    const selectedCostIds = parseCostIds(row.enter_original_cost_ids_or_all, candidate, rowNumber, picked);
    const selectedCostQty = selectedCostIds.reduce((total, id) => total + BigInt(costs.get(id)!.quantity), BigInt(0));
    if (selectedCostQty !== BigInt(picked)) {
      throw new Error(`Row ${rowNumber} selected original cost rows cover ${selectedCostQty} picked units, not ${picked}.`);
    }
    selected.push({ ...candidate, reservedQty: reserved, pickedQty: picked, originalCostIds: selectedCostIds });
  });
  const byOwner = new Map<number, Map<number, { inventoryLevelId: number; lots: Array<{
    inventoryLotId: number; reservedQty: string; pickedQty: string; originalCostIds: number[];
  }> }>>();
  for (const row of selected) {
    const levels = byOwner.get(row.orderItemId) ?? new Map();
    const allocation = levels.get(row.inventoryLevelId) ?? { inventoryLevelId: row.inventoryLevelId, lots: [] };
    allocation.lots.push({ inventoryLotId: row.inventoryLotId, reservedQty: row.reservedQty,
      pickedQty: row.pickedQty, originalCostIds: row.originalCostIds });
    levels.set(row.inventoryLevelId, allocation);
    byOwner.set(row.orderItemId, levels);
  }
  return byOwner;
}

async function sha256Hex(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("This browser cannot securely hash the completed spreadsheets.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function parseOpeningSpreadsheets(documents: OpeningSpreadsheetDocument[], source: OpeningSource,
  metadata: OpeningSpreadsheetMetadata): Promise<OpeningVerification> {
  if (source.runtimeAuthority !== "legacy") throw new Error("Opening verification is available only before inventory authority changes.");
  if (documents.length !== 3) throw new Error("Select the completed stock, open-order and lot-ownership CSV files together.");
  const parsedByKind = new Map<OpeningSpreadsheetKind, { document: OpeningSpreadsheetDocument; fields: string[]; rows: CsvRow[] }>();
  for (const document of documents) {
    const parsed = parseCsv(document);
    const kind = spreadsheetKind(parsed.fields, parsed.rows, document.name);
    if (parsedByKind.has(kind)) throw new Error(`More than one ${kind} spreadsheet was selected.`);
    parsedByKind.set(kind, { document, ...parsed });
  }
  const stock = parsedByKind.get("stock"), orders = parsedByKind.get("orders"), allocations = parsedByKind.get("allocations");
  if (!stock || !orders || !allocations) throw new Error("Select one stock, one open-order and one lot-ownership CSV file.");
  assertHeaders(stock.fields, STOCK_HEADERS, stock.document.name);
  assertHeaders(orders.fields, ORDER_HEADERS, orders.document.name);
  assertHeaders(allocations.fields, ALLOCATION_HEADERS, allocations.document.name);
  const verificationReference = metadata.verificationReference.trim();
  if (!verificationReference) throw new Error("Enter the count or review reference before importing the completed spreadsheets.");
  const verifiedAt = new Date(metadata.verifiedAt);
  if (!metadata.verifiedAt || Number.isNaN(verifiedAt.getTime())) throw new Error("Enter when the physical count and order review were completed.");
  const ownerAllocations = parseAllocations(allocations.rows, source);
  const ownersWithQuantities = parseOrders(orders.rows, source);
  for (const owner of ownersWithQuantities) {
    const assigned = [...(ownerAllocations.get(owner.orderItemId)?.values() ?? [])].flatMap((allocation) => allocation.lots);
    const assignedReserved = assigned.reduce((total, lot) => total + BigInt(lot.reservedQty), BigInt(0));
    const assignedPicked = assigned.reduce((total, lot) => total + BigInt(lot.pickedQty), BigInt(0));
    if (assignedReserved !== BigInt(owner.reservedQty) || assignedPicked !== BigInt(owner.pickedQty)) {
      throw new Error(`Order line ${owner.orderItemId} says it physically holds ${owner.reservedQty} reserved and ${owner.pickedQty} picked units, but its lot ownership rows assign ${assignedReserved} and ${assignedPicked}.`);
    }
  }
  const verificationEvidenceHash = await sha256Hex(JSON.stringify({
    stock: stock.document.text,
    orders: orders.document.text,
    allocations: allocations.document.text,
  }));
  const result = openingVerificationSchema.safeParse({
    contractVersion: "inventory_cutover_opening_v2",
    expectedEvidenceHash: source.evidenceHash,
    expectedAuthorityRevision: source.authorityRevision,
    expectedConfigurationRunId: source.configurationRunId,
    verificationReference,
    verificationEvidenceHash,
    verifiedAt: verifiedAt.toISOString(),
    historicalDisposition: "preserve_unresolved",
    ...(metadata.reservationBasis ? { reservationBasis: metadata.reservationBasis } : {}),
    levels: source.evidence.levels.map((level) => ({ ...level, variantQty: "0", reservedQty: "0", pickedQty: "0", packedQty: "0" })),
    lots: parseStock(stock.rows, source),
    owners: ownersWithQuantities.map((owner) => ({ ...owner,
      allocations: [...(ownerAllocations.get(owner.orderItemId)?.values() ?? [])]
        .sort((a, b) => a.inventoryLevelId - b.inventoryLevelId)
        .map((allocation) => ({ ...allocation, lots: allocation.lots.sort((a, b) => a.inventoryLotId - b.inventoryLotId) })),
    })),
  });
  if (!result.success) {
    const fields = result.error.issues.slice(0, 8).map((issue) => issue.path.join(".") || "spreadsheet");
    throw new Error(`The completed spreadsheets failed verification contract validation: ${fields.join(", ")}.`);
  }
  return result.data;
}
