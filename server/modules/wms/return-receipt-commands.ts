import { sql, type SQL } from "drizzle-orm";

export interface WmsReturnReceiptExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

export type WmsReturnReceiptStatus =
  | "expected"
  | "partially_received"
  | "received";

export interface ReceiveExpectedWmsReturnItemInput {
  returnItemId: number;
  expectedCurrentReceivedQty: number;
  targetReceivedQty: number;
}

export interface ReceiveExpectedWmsReturnInput {
  returnId: number;
  items: readonly ReceiveExpectedWmsReturnItemInput[];
  now: Date;
}

export interface ReceivedWmsReturnItemResult {
  returnItemId: number;
  expectedQty: number;
  previousReceivedQty: number;
  receivedQty: number;
  status: WmsReturnReceiptStatus;
}

export interface ReceiveExpectedWmsReturnResult {
  returnId: number;
  status: WmsReturnReceiptStatus;
  receivedAt: Date | null;
  items: ReceivedWmsReturnItemResult[];
}

export type WmsReturnReceiptCommandErrorCode =
  | "INVALID_INPUT"
  | "RETURN_NOT_FOUND"
  | "RETURN_ITEM_NOT_FOUND"
  | "INVALID_RETURN_STATE"
  | "STALE_RECEIPT_STATE"
  | "DATA_INTEGRITY_ERROR";

export class WmsReturnReceiptCommandError extends Error {
  constructor(
    public readonly code: WmsReturnReceiptCommandErrorCode,
    message: string,
    public readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "WmsReturnReceiptCommandError";
  }
}

interface RawReturnHeaderRow {
  id: unknown;
  status: unknown;
  received_at: unknown;
}

interface RawReturnItemRow {
  id: unknown;
  expected_qty: unknown;
  received_qty: unknown;
  status: unknown;
}

interface LockedReturnItem {
  id: number;
  expectedQty: number;
  receivedQty: number;
  status: string;
}

interface RawIdRow {
  id: unknown;
}

const ALLOWED_RETURN_STATUSES = new Set<WmsReturnReceiptStatus>([
  "expected",
  "partially_received",
  "received",
]);

function rowsOf<T>(result: unknown): T[] {
  if (!result || typeof result !== "object") return [];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WmsReturnReceiptCommandError(
      "INVALID_INPUT",
      `${field} must be a positive safe integer`,
      { field, value },
    );
  }
  return value;
}

function requireNonnegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WmsReturnReceiptCommandError(
      "INVALID_INPUT",
      `${field} must be a nonnegative safe integer`,
      { field, value },
    );
  }
  return value;
}

function requireDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new WmsReturnReceiptCommandError(
      "INVALID_INPUT",
      `${field} must be a valid date`,
      { field },
    );
  }
  return value;
}

function readPositiveSafeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new WmsReturnReceiptCommandError(
      "DATA_INTEGRITY_ERROR",
      `${field} is not a positive safe integer`,
      { field, value },
    );
  }
  return parsed;
}

function readNonnegativeSafeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new WmsReturnReceiptCommandError(
      "DATA_INTEGRITY_ERROR",
      `${field} is not a nonnegative safe integer`,
      { field, value },
    );
  }
  return parsed;
}

function readStatus(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WmsReturnReceiptCommandError(
      "DATA_INTEGRITY_ERROR",
      `${field} is not a valid status`,
      { field, value },
    );
  }
  return value;
}

function readOptionalDate(value: unknown, field: string): Date | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new WmsReturnReceiptCommandError(
      "DATA_INTEGRITY_ERROR",
      `${field} is not a valid date`,
      { field, value },
    );
  }
  return parsed;
}

function validateInput(
  input: ReceiveExpectedWmsReturnInput,
): ReceiveExpectedWmsReturnItemInput[] {
  requirePositiveSafeInteger(input.returnId, "returnId");
  requireDate(input.now, "now");
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 200) {
    throw new WmsReturnReceiptCommandError(
      "INVALID_INPUT",
      "items must contain 1-200 entries",
      { itemCount: Array.isArray(input.items) ? input.items.length : null },
    );
  }

  const returnItemIds = new Set<number>();
  const normalizedItems = input.items.map((item, index) => {
    const returnItemId = requirePositiveSafeInteger(
      item.returnItemId,
      `items[${index}].returnItemId`,
    );
    if (returnItemIds.has(returnItemId)) {
      throw new WmsReturnReceiptCommandError(
        "INVALID_INPUT",
        `items contains duplicate returnItemId ${returnItemId}`,
        { returnItemId },
      );
    }
    returnItemIds.add(returnItemId);

    const expectedCurrentReceivedQty = requireNonnegativeSafeInteger(
      item.expectedCurrentReceivedQty,
      `items[${index}].expectedCurrentReceivedQty`,
    );
    const targetReceivedQty = requirePositiveSafeInteger(
      item.targetReceivedQty,
      `items[${index}].targetReceivedQty`,
    );
    if (targetReceivedQty < expectedCurrentReceivedQty) {
      throw new WmsReturnReceiptCommandError(
        "INVALID_INPUT",
        "targetReceivedQty cannot reduce the received quantity",
        { returnItemId, expectedCurrentReceivedQty, targetReceivedQty },
      );
    }

    return { returnItemId, expectedCurrentReceivedQty, targetReceivedQty };
  });

  return normalizedItems.sort((left, right) => left.returnItemId - right.returnItemId);
}

function parseLockedItem(row: RawReturnItemRow): LockedReturnItem {
  const id = readPositiveSafeInteger(row.id, "wms.return_items.id");
  const expectedQty = readPositiveSafeInteger(
    row.expected_qty,
    `wms.return_items[${id}].expected_qty`,
  );
  const receivedQty = readNonnegativeSafeInteger(
    row.received_qty,
    `wms.return_items[${id}].received_qty`,
  );
  if (receivedQty > expectedQty) {
    throw new WmsReturnReceiptCommandError(
      "DATA_INTEGRITY_ERROR",
      `WMS return item ${id} has received quantity above expected quantity`,
      { returnItemId: id, expectedQty, receivedQty },
    );
  }
  return {
    id,
    expectedQty,
    receivedQty,
    status: readStatus(row.status, `wms.return_items[${id}].status`),
  };
}

function deriveParentStatus(items: readonly LockedReturnItem[]): WmsReturnReceiptStatus {
  if (items.every((item) => item.receivedQty === item.expectedQty)) return "received";
  if (items.some((item) => item.receivedQty > 0)) return "partially_received";
  return "expected";
}

export async function receiveExpectedWmsReturn(
  executor: WmsReturnReceiptExecutor,
  rawInput: ReceiveExpectedWmsReturnInput,
): Promise<ReceiveExpectedWmsReturnResult> {
  const items = validateInput(rawInput);

  // The caller owns the transaction. Lock the aggregate before its children so
  // every caller takes locks in the same order and derives one coherent state.
  const headerRows = rowsOf<RawReturnHeaderRow>(await executor.execute(sql`
    SELECT id, status, received_at
    FROM wms.returns
    WHERE id = ${rawInput.returnId}
    FOR UPDATE
  `));
  if (headerRows.length === 0) {
    throw new WmsReturnReceiptCommandError(
      "RETURN_NOT_FOUND",
      `WMS return ${rawInput.returnId} does not exist`,
      { returnId: rawInput.returnId },
    );
  }
  if (headerRows.length !== 1) {
    throw new WmsReturnReceiptCommandError(
      "DATA_INTEGRITY_ERROR",
      `WMS return ${rawInput.returnId} resolved to multiple rows`,
      { returnId: rawInput.returnId, rowCount: headerRows.length },
    );
  }
  const lockedReturnId = readPositiveSafeInteger(headerRows[0].id, "wms.returns.id");
  const currentReturnStatus = readStatus(headerRows[0].status, "wms.returns.status");
  if (!ALLOWED_RETURN_STATUSES.has(currentReturnStatus as WmsReturnReceiptStatus)) {
    throw new WmsReturnReceiptCommandError(
      "INVALID_RETURN_STATE",
      `WMS return ${lockedReturnId} cannot receive items from status ${currentReturnStatus}`,
      { returnId: lockedReturnId, status: currentReturnStatus },
    );
  }

  const lockedItems = rowsOf<RawReturnItemRow>(await executor.execute(sql`
    SELECT id, expected_qty, received_qty, status
    FROM wms.return_items
    WHERE return_id = ${lockedReturnId}
    ORDER BY id ASC
    FOR UPDATE
  `)).map(parseLockedItem);
  if (lockedItems.length === 0) {
    throw new WmsReturnReceiptCommandError(
      "DATA_INTEGRITY_ERROR",
      `WMS return ${lockedReturnId} has no return items`,
      { returnId: lockedReturnId },
    );
  }

  const lockedItemsById = new Map<number, LockedReturnItem>();
  for (const item of lockedItems) {
    if (lockedItemsById.has(item.id)) {
      throw new WmsReturnReceiptCommandError(
        "DATA_INTEGRITY_ERROR",
        `WMS return ${lockedReturnId} contains duplicate return item ${item.id}`,
        { returnId: lockedReturnId, returnItemId: item.id },
      );
    }
    lockedItemsById.set(item.id, item);
  }

  for (const item of items) {
    const lockedItem = lockedItemsById.get(item.returnItemId);
    if (!lockedItem) {
      throw new WmsReturnReceiptCommandError(
        "RETURN_ITEM_NOT_FOUND",
        `WMS return item ${item.returnItemId} does not belong to return ${lockedReturnId}`,
        { returnId: lockedReturnId, returnItemId: item.returnItemId },
      );
    }
    if (lockedItem.receivedQty !== item.expectedCurrentReceivedQty) {
      throw new WmsReturnReceiptCommandError(
        "STALE_RECEIPT_STATE",
        `WMS return item ${item.returnItemId} changed before receipt was applied`,
        {
          returnId: lockedReturnId,
          returnItemId: item.returnItemId,
          expectedCurrentReceivedQty: item.expectedCurrentReceivedQty,
          actualCurrentReceivedQty: lockedItem.receivedQty,
        },
      );
    }
    if (item.targetReceivedQty > lockedItem.expectedQty) {
      throw new WmsReturnReceiptCommandError(
        "INVALID_INPUT",
        `targetReceivedQty exceeds expected quantity for WMS return item ${item.returnItemId}`,
        {
          returnItemId: item.returnItemId,
          targetReceivedQty: item.targetReceivedQty,
          expectedQty: lockedItem.expectedQty,
        },
      );
    }
  }

  const targetValues = sql.join(
    items.map((item) => sql`(
      ${item.returnItemId}::bigint,
      ${item.targetReceivedQty}::integer
    )`),
    sql`, `,
  );
  const quantityUpdateRows = rowsOf<RawIdRow>(await executor.execute(sql`
    WITH targets(return_item_id, target_received_qty) AS (
      VALUES ${targetValues}
    )
    UPDATE wms.return_items AS return_item
    SET received_qty = targets.target_received_qty,
        updated_at = CASE
          WHEN return_item.received_qty IS DISTINCT FROM targets.target_received_qty
            THEN ${rawInput.now}
          ELSE return_item.updated_at
        END
    FROM targets
    WHERE return_item.id = targets.return_item_id
      AND return_item.return_id = ${lockedReturnId}
    RETURNING return_item.id
  `));
  const updatedItemIds = new Set(
    quantityUpdateRows.map((row) => readPositiveSafeInteger(row.id, "updated return item id")),
  );
  if (
    updatedItemIds.size !== items.length ||
    items.some((item) => !updatedItemIds.has(item.returnItemId))
  ) {
    throw new WmsReturnReceiptCommandError(
      "DATA_INTEGRITY_ERROR",
      `Not every targeted item for WMS return ${lockedReturnId} was updated`,
      {
        returnId: lockedReturnId,
        expectedItemIds: items.map((item) => item.returnItemId),
        updatedItemIds: [...updatedItemIds].sort((left, right) => left - right),
      },
    );
  }

  // Reconcile every child, not only the submitted targets. Parent state is
  // therefore derived from the complete locked aggregate.
  const reconciledItems = rowsOf<RawReturnItemRow>(await executor.execute(sql`
    UPDATE wms.return_items AS return_item
    SET status = CASE
          WHEN return_item.received_qty = 0 THEN 'expected'
          WHEN return_item.received_qty < return_item.expected_qty THEN 'partially_received'
          ELSE 'received'
        END,
        updated_at = CASE
          WHEN return_item.status IS DISTINCT FROM CASE
            WHEN return_item.received_qty = 0 THEN 'expected'
            WHEN return_item.received_qty < return_item.expected_qty THEN 'partially_received'
            ELSE 'received'
          END THEN ${rawInput.now}
          ELSE return_item.updated_at
        END
    WHERE return_item.return_id = ${lockedReturnId}
    RETURNING id, expected_qty, received_qty, status
  `)).map(parseLockedItem).sort((left, right) => left.id - right.id);

  for (const item of reconciledItems) {
    if (!ALLOWED_RETURN_STATUSES.has(item.status as WmsReturnReceiptStatus)) {
      throw new WmsReturnReceiptCommandError(
        "DATA_INTEGRITY_ERROR",
        `WMS return item ${item.id} persisted an unexpected status`,
        { returnId: lockedReturnId, returnItemId: item.id, status: item.status },
      );
    }
  }

  if (
    reconciledItems.length !== lockedItems.length ||
    reconciledItems.some((item, index) => item.id !== [...lockedItems].sort(
      (left, right) => left.id - right.id,
    )[index]?.id)
  ) {
    throw new WmsReturnReceiptCommandError(
      "DATA_INTEGRITY_ERROR",
      `WMS return ${lockedReturnId} item membership changed while locked`,
      { returnId: lockedReturnId },
    );
  }

  const parentStatus = deriveParentStatus(reconciledItems);
  const hasReceivedQuantity = reconciledItems.some((item) => item.receivedQty > 0);
  const updatedHeaderRows = rowsOf<RawReturnHeaderRow>(await executor.execute(sql`
    UPDATE wms.returns
    SET status = ${parentStatus},
        received_at = CASE
          WHEN ${hasReceivedQuantity} THEN COALESCE(received_at, ${rawInput.now})
          ELSE received_at
        END,
        updated_at = CASE
          WHEN status IS DISTINCT FROM ${parentStatus}
            OR (${hasReceivedQuantity} AND received_at IS NULL)
            THEN ${rawInput.now}
          ELSE updated_at
        END
    WHERE id = ${lockedReturnId}
    RETURNING id, status, received_at
  `));
  if (updatedHeaderRows.length !== 1) {
    throw new WmsReturnReceiptCommandError(
      "DATA_INTEGRITY_ERROR",
      `WMS return ${lockedReturnId} could not be updated`,
      { returnId: lockedReturnId, rowCount: updatedHeaderRows.length },
    );
  }
  const persistedParentStatus = readStatus(
    updatedHeaderRows[0].status,
    "updated wms.returns.status",
  );
  if (persistedParentStatus !== parentStatus) {
    throw new WmsReturnReceiptCommandError(
      "DATA_INTEGRITY_ERROR",
      `WMS return ${lockedReturnId} persisted an unexpected status`,
      { returnId: lockedReturnId, expectedStatus: parentStatus, persistedParentStatus },
    );
  }

  const previousReceivedQtyById = new Map(
    lockedItems.map((item) => [item.id, item.receivedQty] as const),
  );
  return {
    returnId: lockedReturnId,
    status: parentStatus,
    receivedAt: readOptionalDate(
      updatedHeaderRows[0].received_at,
      "updated wms.returns.received_at",
    ),
    items: reconciledItems.map((item) => ({
      returnItemId: item.id,
      expectedQty: item.expectedQty,
      previousReceivedQty: previousReceivedQtyById.get(item.id) ?? item.receivedQty,
      receivedQty: item.receivedQty,
      status: item.status as WmsReturnReceiptStatus,
    })),
  };
}
