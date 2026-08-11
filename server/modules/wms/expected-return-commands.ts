import { sql, type SQL } from "drizzle-orm";

export interface ExpectedReturnExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

export interface ExpectedReturnItemInput {
  orderItemId: number;
  omsOrderLineId: number | null;
  externalLineItemId: string | null;
  sku?: string | null;
  expectedQuantity: number;
  restockPolicy: string;
  locationId?: string | null;
}

export interface CreateExpectedWmsReturnInput {
  orderId: number;
  shipmentId?: number | null;
  source: string;
  sourceEventKey: string;
  reason: string;
  refundExternalId?: string | null;
  refundedAt?: Date | null;
  notes?: string | null;
  items: readonly ExpectedReturnItemInput[];
  now: Date;
}

export interface ExpectedReturnItemResult {
  id: number;
  orderItemId: number;
  created: boolean;
}

export interface CreateExpectedWmsReturnResult {
  returnId: number;
  created: boolean;
  items: ExpectedReturnItemResult[];
}

interface IdRow {
  id: unknown;
}

function rowsOf<T>(result: unknown): T[] {
  if (!result || typeof result !== "object") return [];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function requireText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${field} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function optionalText(value: string | null | undefined, field: string, maxLength: number): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new Error(`${field} must contain at most ${maxLength} characters`);
  }
  return normalized;
}

function requireDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${field} must be a valid date`);
  }
  return value;
}

function readId(result: unknown, field: string): number | null {
  const raw = rowsOf<IdRow>(result)[0]?.id;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

function validateInput(input: CreateExpectedWmsReturnInput): CreateExpectedWmsReturnInput {
  requirePositiveInteger(input.orderId, "orderId");
  if (input.shipmentId != null) requirePositiveInteger(input.shipmentId, "shipmentId");
  requireText(input.source, "source", 64);
  requireText(input.sourceEventKey, "sourceEventKey", 255);
  requireText(input.reason, "reason", 200);
  optionalText(input.refundExternalId, "refundExternalId", 255);
  optionalText(input.notes, "notes", 10_000);
  requireDate(input.now, "now");
  if (input.refundedAt != null) requireDate(input.refundedAt, "refundedAt");
  if (input.items.length === 0 || input.items.length > 200) {
    throw new Error("items must contain 1-200 entries");
  }
  const orderItemIds = new Set<number>();
  for (const item of input.items) {
    requirePositiveInteger(item.orderItemId, "item.orderItemId");
    if (orderItemIds.has(item.orderItemId)) {
      throw new Error(`items contains duplicate orderItemId ${item.orderItemId}`);
    }
    orderItemIds.add(item.orderItemId);
    if (item.omsOrderLineId != null) requirePositiveInteger(item.omsOrderLineId, "item.omsOrderLineId");
    requirePositiveInteger(item.expectedQuantity, "item.expectedQuantity");
    requireText(item.restockPolicy, "item.restockPolicy", 32);
    optionalText(item.externalLineItemId, "item.externalLineItemId", 255);
    optionalText(item.sku, "item.sku", 255);
    optionalText(item.locationId, "item.locationId", 255);
  }
  return input;
}

export async function createExpectedWmsReturn(
  executor: ExpectedReturnExecutor,
  rawInput: CreateExpectedWmsReturnInput,
): Promise<CreateExpectedWmsReturnResult> {
  const input = validateInput(rawInput);
  const source = input.source.trim();
  const sourceEventKey = input.sourceEventKey.trim();
  const reason = input.reason.trim();
  const refundExternalId = optionalText(input.refundExternalId, "refundExternalId", 255);
  const notes = optionalText(input.notes, "notes", 10_000);

  const insertedReturn = await executor.execute(sql`
    INSERT INTO wms.returns (
      shipment_id, order_id, source, source_event_key, reason,
      refund_external_id, restocked, status, received_at, refunded_at,
      notes, created_at, updated_at
    ) VALUES (
      ${input.shipmentId ?? null}, ${input.orderId}, ${source}, ${sourceEventKey}, ${reason},
      ${refundExternalId}, false, 'expected', NULL, ${input.refundedAt ?? null},
      ${notes}, ${input.now}, ${input.now}
    )
    ON CONFLICT (source_event_key) WHERE NULLIF(BTRIM(source_event_key), '') IS NOT NULL
    DO NOTHING
    RETURNING id
  `);
  let returnId = readId(insertedReturn, "return id");
  const created = returnId != null;
  if (returnId == null) {
    returnId = readId(await executor.execute(sql`
      SELECT id
      FROM wms.returns
      WHERE source_event_key = ${sourceEventKey}
      LIMIT 1
      FOR UPDATE
    `), "return id");
  }
  if (returnId == null) {
    throw new Error(`Could not resolve expected return for ${sourceEventKey}`);
  }

  const itemResults: ExpectedReturnItemResult[] = [];
  for (const item of input.items) {
    const sku = optionalText(item.sku, "item.sku", 255);
    const externalLineItemId = optionalText(item.externalLineItemId, "item.externalLineItemId", 255);
    const restockPolicy = item.restockPolicy.trim();
    const locationId = optionalText(item.locationId, "item.locationId", 255);
    const insertedItem = await executor.execute(sql`
      INSERT INTO wms.return_items (
        return_id, order_item_id, oms_order_line_id, external_line_item_id,
        sku, expected_qty, received_qty, restock_policy, location_id,
        status, created_at, updated_at
      )
      SELECT
        ${returnId}, ${item.orderItemId}, ${item.omsOrderLineId}, ${externalLineItemId},
        COALESCE(${sku}, (SELECT sku FROM wms.order_items WHERE id = ${item.orderItemId})),
        ${item.expectedQuantity}, 0, ${restockPolicy}, ${locationId},
        'expected', ${input.now}, ${input.now}
      WHERE NOT EXISTS (
        SELECT 1
        FROM wms.return_items existing
        WHERE existing.return_id = ${returnId}
          AND existing.order_item_id = ${item.orderItemId}
      )
      RETURNING id
    `);
    let returnItemId = readId(insertedItem, "return item id");
    const itemCreated = returnItemId != null;
    if (returnItemId == null) {
      returnItemId = readId(await executor.execute(sql`
        SELECT id
        FROM wms.return_items
        WHERE return_id = ${returnId}
          AND order_item_id = ${item.orderItemId}
        LIMIT 1
        FOR UPDATE
      `), "return item id");
    }
    if (returnItemId == null) {
      throw new Error(`Could not resolve expected return item for order item ${item.orderItemId}`);
    }
    itemResults.push({ id: returnItemId, orderItemId: item.orderItemId, created: itemCreated });
  }

  return { returnId, created, items: itemResults };
}
