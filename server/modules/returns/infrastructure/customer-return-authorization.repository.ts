import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  CustomerReturnAuthorizationPersistenceError,
  type CustomerReturnAuthorizationCommand,
  type CustomerReturnAuthorizationResult,
  type CustomerReturnAuthorizationStore,
  type CustomerReturnAuthorizationTransaction,
  type LockedCustomerReturnAuthorizationSource,
  type PersistCustomerReturnAuthorizationInput,
} from "../application/customer-return-authorization.ports";

export interface CustomerReturnAuthorizationSqlExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

export interface CustomerReturnAuthorizationDatabase {
  transaction<T>(work: (tx: CustomerReturnAuthorizationSqlExecutor) => Promise<T>): Promise<T>;
}

// Existing admin intake and Shopify refund cascade use this same order lock.
const RETURN_QUANTITY_LOCK_NAMESPACE = 918413;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_SNAPSHOT_BYTES = 65_536;
const MAX_SNAPSHOT_DEPTH = 16;
const MAX_LINES_PER_AUTHORIZATION = 250;
const MAX_ALLOCATIONS_PER_LINE = 250;
const positiveId = z.number().int().positive().safe();
const quantity = positiveId.max(POSTGRES_INTEGER_MAX);
const boundedText = (max: number) => z.string().min(1).max(max).refine((value) => value.trim().length > 0);
const commandSchema = z.object({ channelId: positiveId.max(POSTGRES_INTEGER_MAX), idempotencyKey: boundedText(160) }).strict();
const sourceSchema = z.object({
  channelId: positiveId.max(POSTGRES_INTEGER_MAX),
  omsOrderId: positiveId,
  omsOrderLineIds: z.array(positiveId).min(1).max(MAX_LINES_PER_AUTHORIZATION),
}).strict();
const inputSchema = commandSchema.extend({
  omsOrderId: positiveId,
  semanticHash: z.string().regex(/^[a-f0-9]{64}$/),
  eligibilityRevision: z.string().regex(/^[a-f0-9]{64}$/),
  actor: boundedText(255),
  now: z.date(),
  policySnapshot: z.unknown(),
  warehouseSnapshot: z.unknown(),
  lines: z.array(z.object({
    omsOrderLineId: positiveId,
    externalLineItemId: boundedText(100),
    quantity,
    reasonCode: boundedText(100).nullable(),
    allocations: z.array(z.object({
      wmsOrderItemId: positiveId.max(POSTGRES_INTEGER_MAX),
      fulfillmentId: boundedText(200),
      fulfillmentLineItemId: boundedText(200),
      quantity,
      originalQuantity: quantity,
      eligibleQuantity: quantity,
      deliveryEvidence: z.unknown(),
    }).strict()).min(1).max(MAX_ALLOCATIONS_PER_LINE),
  }).strict()).min(1).max(MAX_LINES_PER_AUTHORIZATION),
}).strict();

export class PostgresCustomerReturnAuthorizationStore implements CustomerReturnAuthorizationStore {
  constructor(private readonly database: CustomerReturnAuthorizationDatabase) {}

  transaction<T>(work: (tx: CustomerReturnAuthorizationTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) => work(new PostgresCustomerReturnAuthorizationTransaction(tx)));
  }
}

class PostgresCustomerReturnAuthorizationTransaction implements CustomerReturnAuthorizationTransaction {
  private readonly lockedCommands = new Set<string>();
  private source: LockedCustomerReturnAuthorizationSource | null = null;
  private sourceLockAttempted = false;
  private persisted = false;

  constructor(private readonly tx: CustomerReturnAuthorizationSqlExecutor) {}

  async lockCommand(command: CustomerReturnAuthorizationCommand): Promise<void> {
    validate(commandSchema, command);
    const key = commandKey(command);
    if (this.lockedCommands.has(key)) return;
    if (this.sourceLockAttempted || this.lockedCommands.size > 0) {
      fail("RETURN_AUTHORIZATION_LOCK_REQUIRED", "One command must be locked before its source in each transaction.");
    }
    await this.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-return-command:${key}`}, 0))`);
    this.lockedCommands.add(key);
  }

  async findCommand(command: CustomerReturnAuthorizationCommand): Promise<{
    semanticHash: string;
    result: CustomerReturnAuthorizationResult;
  } | null> {
    validate(commandSchema, command);
    this.requireCommandLock(command);
    const row = rows(await this.tx.execute(sql`
      SELECT c.semantic_hash, c.response, a.id, a.authorization_number
      FROM returns.customer_return_authorization_commands c
      JOIN returns.customer_return_authorizations a ON a.id = c.authorization_id AND a.channel_id = c.channel_id
      WHERE c.channel_id = ${command.channelId} AND c.idempotency_key = ${command.idempotencyKey}
    `))[0];
    if (!row) return null;
    const response = row.response;
    const authorizationId = readInteger(row.id, "authorization id", true);
    const authorizationNumber = readText(row.authorization_number, "authorization number");
    if (!isRecord(response)
      || response.authorizationId !== authorizationId || response.authorizationNumber !== authorizationNumber
      || response.replayed !== false || typeof row.semantic_hash !== "string" || !/^[a-f0-9]{64}$/.test(row.semantic_hash)) {
      fail("RETURN_AUTHORIZATION_DATA_INVALID", "The persisted command response is invalid.");
    }
    return { semanticHash: row.semantic_hash, result: { authorizationId, authorizationNumber, replayed: true } };
  }

  async lockSource(input: {
    channelId: number;
    omsOrderId: number;
    omsOrderLineIds: readonly number[];
  }): Promise<LockedCustomerReturnAuthorizationSource | null> {
    validate(sourceSchema, input);
    if (this.sourceLockAttempted) {
      fail("RETURN_AUTHORIZATION_LOCK_REQUIRED", "Only one source can be locked per transaction.");
    }
    this.sourceLockAttempted = true;
    const lineIds = [...new Set(input.omsOrderLineIds)].sort((a, b) => a - b);
    if (lineIds.length !== input.omsOrderLineIds.length) invalid("Duplicate source line ids.");

    // The historical two-int advisory API cannot represent larger bigint IDs.
    // The OMS row lock below remains shared with those writers for every ID.
    if (input.omsOrderId <= POSTGRES_INTEGER_MAX) {
      await this.tx.execute(sql`SELECT pg_advisory_xact_lock(${RETURN_QUANTITY_LOCK_NAMESPACE}, ${input.omsOrderId})`);
    }
    const order = rows(await this.tx.execute(sql`
      SELECT id FROM oms.oms_orders WHERE id = ${input.omsOrderId} AND channel_id = ${input.channelId} FOR UPDATE
    `))[0];
    if (!order) return null;
    const lineRows = rows(await this.tx.execute(sql`
      SELECT id, external_line_item_id, quantity FROM oms.oms_order_lines
      WHERE order_id = ${input.omsOrderId} AND id = ANY(ARRAY[${sql.join(lineIds, sql`, `)}]::bigint[])
      ORDER BY id FOR UPDATE
    `));
    if (lineRows.length !== lineIds.length) return null;
    // Lock every partition/item for the source order before reading quantities.
    // A claim for one line can otherwise race a legacy writer on another split.
    await this.tx.execute(sql`
      SELECT id FROM wms.orders WHERE oms_fulfillment_order_id = ${String(input.omsOrderId)} ORDER BY id FOR UPDATE
    `);
    const itemRows = rows(await this.tx.execute(sql`
      SELECT wi.id, wi.order_id, wi.oms_order_line_id, wi.fulfilled_quantity
      FROM wms.order_items wi JOIN wms.orders wo ON wo.id = wi.order_id
      WHERE wo.oms_fulfillment_order_id = ${String(input.omsOrderId)}
      ORDER BY wi.id FOR UPDATE OF wi
    `));
    const legacyRows = rows(await this.tx.execute(sql`
      SELECT ri.order_item_id, ri.oms_order_line_id, ri.expected_qty,
        wi.oms_order_line_id AS item_oms_order_line_id,
        returned_order.oms_fulfillment_order_id AS return_source_order_id,
        item_order.oms_fulfillment_order_id AS item_source_order_id
      FROM wms.return_items ri JOIN wms.returns r ON r.id = ri.return_id
      JOIN wms.orders returned_order ON returned_order.id = r.order_id
      LEFT JOIN wms.order_items wi ON wi.id = ri.order_item_id
      LEFT JOIN wms.orders item_order ON item_order.id = wi.order_id
      WHERE returned_order.oms_fulfillment_order_id = ${String(input.omsOrderId)}
        OR item_order.oms_fulfillment_order_id = ${String(input.omsOrderId)}
        OR ri.oms_order_line_id = ANY(ARRAY[${sql.join(lineIds, sql`, `)}]::bigint[])
    `));
    const claimRows = rows(await this.tx.execute(sql`
      SELECT aa.wms_order_item_id, al.oms_order_line_id, aa.fulfillment_id, aa.fulfillment_line_item_id,
        SUM(aa.quantity)::bigint AS quantity
      FROM returns.customer_return_authorization_allocations aa
      JOIN returns.customer_return_authorization_lines al ON al.id = aa.authorization_line_id
      JOIN returns.customer_return_authorizations a ON a.id = aa.authorization_id
      WHERE a.oms_order_id = ${input.omsOrderId} AND a.channel_id = ${input.channelId}
      GROUP BY aa.wms_order_item_id, al.oms_order_line_id, aa.fulfillment_id, aa.fulfillment_line_item_id
    `));
    const legacyByItem = new Map<number, number>();
    for (const row of legacyRows) {
      if (row.order_item_id == null || row.item_oms_order_line_id == null
        || row.return_source_order_id !== String(input.omsOrderId) || row.item_source_order_id !== String(input.omsOrderId)
        || (row.oms_order_line_id != null && readInteger(row.oms_order_line_id, "legacy OMS line id", true)
          !== readInteger(row.item_oms_order_line_id, "WMS OMS line id", true))) {
        fail("RETURN_AUTHORIZATION_SOURCE_CONFLICT", "An existing return has missing or inconsistent ordered-line mapping.");
      }
      const itemId = readInteger(row.order_item_id, "legacy WMS item id", true);
      legacyByItem.set(itemId, add(legacyByItem.get(itemId) ?? 0, readInteger(row.expected_qty, "legacy expected quantity", true)));
    }
    const claimedByItem = new Map<number, number>();
    const claimedByLine = new Map<number, number>();
    const allocationClaims: LockedCustomerReturnAuthorizationSource["allocationClaims"] = [];
    const allocationLines = new Map<string, number>();
    for (const row of claimRows) {
      const itemId = readInteger(row.wms_order_item_id, "claimed WMS item id", true);
      const claimedQuantity = readInteger(row.quantity, "claimed quantity");
      claimedByItem.set(itemId, add(claimedByItem.get(itemId) ?? 0, claimedQuantity));
      const claim = {
        omsOrderLineId: readInteger(row.oms_order_line_id, "claimed OMS line id", true),
        wmsOrderItemId: itemId,
        fulfillmentId: readText(row.fulfillment_id, "fulfillment id"),
        fulfillmentLineItemId: readText(row.fulfillment_line_item_id, "fulfillment line id"),
        quantity: claimedQuantity,
      };
      const currentItem = itemRows.find((item) => readInteger(item.id, "WMS item id", true) === itemId);
      if (!currentItem || currentItem.oms_order_line_id == null
        || readInteger(currentItem.oms_order_line_id, "WMS OMS line id", true) !== claim.omsOrderLineId) {
        fail("RETURN_AUTHORIZATION_SOURCE_CONFLICT", "A claimed allocation's source mapping changed.");
      }
      claimedByLine.set(claim.omsOrderLineId, add(claimedByLine.get(claim.omsOrderLineId) ?? 0, claimedQuantity));
      const key = allocationKey(claim.fulfillmentId, claim.fulfillmentLineItemId);
      const existingLine = allocationLines.get(key);
      if (existingLine !== undefined && existingLine !== claim.omsOrderLineId) {
        fail("RETURN_AUTHORIZATION_DATA_INVALID", "A fulfillment line is linked to conflicting ordered lines.");
      }
      allocationLines.set(key, claim.omsOrderLineId);
      allocationClaims.push(claim);
    }
    const source: LockedCustomerReturnAuthorizationSource = {
      channelId: input.channelId,
      omsOrderId: input.omsOrderId,
      lines: lineRows.map((line) => {
        const omsOrderLineId = readInteger(line.id, "OMS line id", true);
        const wmsItems = itemRows.filter((item) => item.oms_order_line_id != null
          && readInteger(item.oms_order_line_id, "WMS OMS line id", true) === omsOrderLineId).map((item) => {
          const wmsOrderItemId = readInteger(item.id, "WMS item id", true);
          return {
            wmsOrderId: readInteger(item.order_id, "WMS order id", true),
            wmsOrderItemId,
            fulfilledQuantity: readInteger(item.fulfilled_quantity, "fulfilled quantity"),
            legacyExpectedQuantity: legacyByItem.get(wmsOrderItemId) ?? 0,
            claimedQuantity: claimedByItem.get(wmsOrderItemId) ?? 0,
          };
        });
        return {
          omsOrderLineId,
          externalLineItemId: line.external_line_item_id == null ? null : readText(line.external_line_item_id, "external line id"),
          orderedQuantity: readInteger(line.quantity, "ordered quantity"),
          legacyExpectedQuantity: wmsItems.reduce((total, item) => add(total, item.legacyExpectedQuantity), 0),
          claimedQuantity: claimedByLine.get(omsOrderLineId) ?? 0,
          wmsItems,
        };
      }),
      allocationClaims,
    };
    this.source = structuredClone(source);
    return source;
  }

  async persist(rawInput: PersistCustomerReturnAuthorizationInput): Promise<CustomerReturnAuthorizationResult> {
    validate(inputSchema, rawInput);
    validateSnapshot(rawInput.policySnapshot, "policy snapshot");
    validateSnapshot(rawInput.warehouseSnapshot, "warehouse snapshot");
    for (const line of rawInput.lines) for (const allocation of line.allocations) {
      validateSnapshot(allocation.deliveryEvidence, "delivery evidence");
      validateSnapshot({ ...allocation.deliveryEvidence, wmsOriginalQuantity: allocation.originalQuantity }, "delivery evidence");
    }
    // Keep the validated command stable across awaits even if a caller retains
    // and changes its object while PostgreSQL is waiting on another transaction.
    const input = structuredClone(rawInput);
    this.requireCommandLock(input);
    const previous = await this.findCommand({ channelId: input.channelId, idempotencyKey: input.idempotencyKey });
    if (previous) {
      if (previous.semanticHash !== input.semanticHash) {
        fail("RETURN_AUTHORIZATION_COMMAND_CONFLICT", "The idempotency key was already used for different return intent.");
      }
      return previous.result;
    }
    if (this.persisted || !this.source || this.source.channelId !== input.channelId || this.source.omsOrderId !== input.omsOrderId) {
      fail("RETURN_AUTHORIZATION_LOCK_REQUIRED", "The matching source must be locked before authorization persistence.");
    }
    assertCapacity(input, this.source);
    const root = rows(await this.tx.execute(sql`
      INSERT INTO returns.customer_return_authorizations
        (channel_id, oms_order_id, eligibility_revision, policy_snapshot, warehouse_snapshot, actor, created_at)
      VALUES (${input.channelId}, ${input.omsOrderId}, ${input.eligibilityRevision},
        ${JSON.stringify(input.policySnapshot)}::jsonb, ${JSON.stringify(input.warehouseSnapshot)}::jsonb, ${input.actor}, ${input.now})
      RETURNING id, authorization_number
    `))[0];
    const result: CustomerReturnAuthorizationResult = {
      authorizationId: readInteger(root?.id, "authorization id", true),
      authorizationNumber: readText(root?.authorization_number, "authorization number"),
      replayed: false,
    };
    for (const line of [...input.lines].sort((a, b) => a.omsOrderLineId - b.omsOrderLineId)) {
      const savedLine = rows(await this.tx.execute(sql`
        INSERT INTO returns.customer_return_authorization_lines
          (authorization_id, oms_order_line_id, external_line_item_id, quantity, reason_code, created_at)
        VALUES (${result.authorizationId}, ${line.omsOrderLineId}, ${line.externalLineItemId}, ${line.quantity}, ${line.reasonCode}, ${input.now})
        RETURNING id
      `))[0];
      const lineId = readInteger(savedLine?.id, "authorization line id", true);
      for (const allocation of line.allocations) {
        await this.tx.execute(sql`
          INSERT INTO returns.customer_return_authorization_allocations
            (authorization_id, authorization_line_id, wms_order_item_id, fulfillment_id, fulfillment_line_item_id,
             quantity, eligible_quantity, delivery_evidence, created_at)
          VALUES (${result.authorizationId}, ${lineId}, ${allocation.wmsOrderItemId}, ${allocation.fulfillmentId},
            ${allocation.fulfillmentLineItemId}, ${allocation.quantity}, ${allocation.eligibleQuantity},
            ${JSON.stringify({ ...allocation.deliveryEvidence, wmsOriginalQuantity: allocation.originalQuantity })}::jsonb, ${input.now})
        `);
      }
    }
    await this.tx.execute(sql`
      INSERT INTO returns.customer_return_authorization_commands
        (channel_id, idempotency_key, semantic_hash, authorization_id, response, actor, created_at)
      VALUES (${input.channelId}, ${input.idempotencyKey}, ${input.semanticHash}, ${result.authorizationId},
        ${JSON.stringify(result)}::jsonb, ${input.actor}, ${input.now})
    `);
    const details = {
      before: null,
      after: { authorizationId: result.authorizationId, authorizationNumber: result.authorizationNumber },
      channelId: input.channelId,
      omsOrderId: input.omsOrderId,
      semanticHash: input.semanticHash,
      eligibilityRevision: input.eligibilityRevision,
      lineCount: input.lines.length,
      quantity: input.lines.reduce((total, line) => add(total, line.quantity), 0),
    };
    await this.tx.execute(sql`
      INSERT INTO returns.customer_return_authorization_events (authorization_id, event_type, actor, details, occurred_at)
      VALUES (${result.authorizationId}, 'customer_return_authorized', ${input.actor}, ${JSON.stringify(details)}::jsonb, ${input.now})
    `);
    await this.tx.execute(sql`
      INSERT INTO returns.customer_return_authorization_outbox (authorization_id, topic, payload, occurred_at)
      VALUES (${result.authorizationId}, 'customer_return_authorization.created',
        ${JSON.stringify({ authorizationId: result.authorizationId, channelId: input.channelId })}::jsonb, ${input.now})
    `);
    this.persisted = true;
    return result;
  }

  private requireCommandLock(command: CustomerReturnAuthorizationCommand): void {
    if (!this.lockedCommands.has(commandKey(command))) {
      fail("RETURN_AUTHORIZATION_LOCK_REQUIRED", "The scoped command must be locked first.");
    }
  }
}

function assertCapacity(input: PersistCustomerReturnAuthorizationInput, source: LockedCustomerReturnAuthorizationSource): void {
  const selectedLines = new Set<number>();
  const requestedByItem = new Map<number, number>();
  const originalByItem = new Map<number, number>();
  const requestedByAllocation = new Map<string, { omsOrderLineId: number; quantity: number; capacity: number }>();
  for (const line of input.lines) {
    if (selectedLines.has(line.omsOrderLineId)) invalid("Duplicate ordered lines are not allowed.");
    selectedLines.add(line.omsOrderLineId);
    const sourceLine = source.lines.find((candidate) => candidate.omsOrderLineId === line.omsOrderLineId);
    if (!sourceLine || sourceLine.externalLineItemId !== line.externalLineItemId) {
      fail("RETURN_AUTHORIZATION_SOURCE_CONFLICT", "An ordered line does not match its locked source.", { omsOrderLineId: line.omsOrderLineId });
    }
    if (add(add(sourceLine.legacyExpectedQuantity, sourceLine.claimedQuantity), line.quantity) > sourceLine.orderedQuantity) {
      exceeded("The ordered quantity has already been claimed.", line.omsOrderLineId);
    }
    let allocatedQuantity = 0;
    const exactAllocations = new Set<string>();
    for (const allocation of line.allocations) {
      const item = sourceLine.wmsItems.find((candidate) => candidate.wmsOrderItemId === allocation.wmsOrderItemId);
      if (!item) fail("RETURN_AUTHORIZATION_SOURCE_CONFLICT", "An allocation does not belong to its ordered line.", { wmsOrderItemId: allocation.wmsOrderItemId });
      const key = allocationKey(allocation.fulfillmentId, allocation.fulfillmentLineItemId);
      const exactKey = JSON.stringify([allocation.wmsOrderItemId, key]);
      if (exactAllocations.has(exactKey)) invalid("Duplicate fulfillment allocations are not allowed.");
      exactAllocations.add(exactKey);
      allocatedQuantity = add(allocatedQuantity, allocation.quantity);
      const itemQuantity = add(requestedByItem.get(item.wmsOrderItemId) ?? 0, allocation.quantity);
      requestedByItem.set(item.wmsOrderItemId, itemQuantity);
      if (add(add(item.legacyExpectedQuantity, item.claimedQuantity), itemQuantity) > item.fulfilledQuantity) {
        exceeded("The WMS fulfilled quantity has already been claimed.", line.omsOrderLineId);
      }
      const originalQuantity = add(originalByItem.get(item.wmsOrderItemId) ?? 0, allocation.originalQuantity);
      originalByItem.set(item.wmsOrderItemId, originalQuantity);
      if (originalQuantity > item.fulfilledQuantity) {
        fail("RETURN_AUTHORIZATION_SOURCE_CONFLICT", "An original fulfillment allocation exceeds its WMS source.");
      }
      const previous = requestedByAllocation.get(key);
      if (previous && (previous.omsOrderLineId !== line.omsOrderLineId || previous.capacity !== allocation.eligibleQuantity)) {
        fail("RETURN_AUTHORIZATION_SOURCE_CONFLICT", "A fulfillment line has conflicting identity or eligible capacity.");
      }
      const current = { omsOrderLineId: line.omsOrderLineId, capacity: allocation.eligibleQuantity, quantity: add(previous?.quantity ?? 0, allocation.quantity) };
      requestedByAllocation.set(key, current);
      const claims = source.allocationClaims.filter((candidate) => allocationKey(candidate.fulfillmentId, candidate.fulfillmentLineItemId) === key);
      if (claims.some(claim => claim.omsOrderLineId !== line.omsOrderLineId)) {
        fail("RETURN_AUTHORIZATION_SOURCE_CONFLICT", "A fulfillment line was previously claimed against another ordered line.");
      }
      const exactClaimed = claims.filter(claim => claim.wmsOrderItemId === allocation.wmsOrderItemId)
        .reduce((total, claim) => add(total, claim.quantity), 0);
      if (add(exactClaimed, allocation.quantity) > allocation.originalQuantity) {
        exceeded("The original fulfillment's WMS allocation has already been claimed.", line.omsOrderLineId);
      }
      const claimedQuantity = claims.reduce((total, claim) => add(total, claim.quantity), 0);
      if (add(claimedQuantity, current.quantity) > current.capacity) {
        exceeded("The original fulfillment's eligible quantity has already been claimed.", line.omsOrderLineId);
      }
    }
    if (allocatedQuantity !== line.quantity) invalid("The allocation quantities must exactly equal their ordered-line selection.");
  }
}

function commandKey(command: CustomerReturnAuthorizationCommand): string {
  return JSON.stringify([command.channelId, command.idempotencyKey]);
}

function allocationKey(fulfillmentId: string, fulfillmentLineItemId: string): string {
  return JSON.stringify([fulfillmentId, fulfillmentLineItemId]);
}

function rows(result: unknown): Record<string, unknown>[] {
  if (!result || typeof result !== "object" || !("rows" in result) || !Array.isArray(result.rows)) {
    fail("RETURN_AUTHORIZATION_DATA_INVALID", "Database result did not contain rows.");
  }
  if (!result.rows.every(isRecord)) fail("RETURN_AUTHORIZATION_DATA_INVALID", "Database result contained invalid rows.");
  return result.rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readInteger(value: unknown, field: string, positive = false): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < (positive ? 1 : 0)) {
    fail("RETURN_AUTHORIZATION_DATA_INVALID", `${field} is not a supported integer.`);
  }
  return parsed;
}

function readText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail("RETURN_AUTHORIZATION_DATA_INVALID", `${field} is missing.`);
  return value;
}

function add(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) fail("RETURN_AUTHORIZATION_DATA_INVALID", "Aggregate quantity exceeds the supported integer range.");
  return total;
}

function validate(schema: z.ZodTypeAny, value: unknown): void {
  if (!schema.safeParse(value).success) invalid("The authorization input does not match its contract.");
}

function validateSnapshot(value: unknown, name: string): void {
  const seen = new Set<object>();
  function visit(node: unknown, depth: number): void {
    if (depth > MAX_SNAPSHOT_DEPTH) invalid(`${name} is too deeply nested.`);
    if (node === null || typeof node === "string" || typeof node === "boolean") return;
    if (typeof node === "number" && Number.isFinite(node)) return;
    if (typeof node !== "object" || node === undefined) invalid(`${name} must contain only JSON values.`);
    if (seen.has(node)) invalid(`${name} contains circular references.`);
    if (!Array.isArray(node) && Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null) {
      invalid(`${name} must contain only plain JSON objects.`);
    }
    seen.add(node);
    for (const child of Object.values(node)) visit(child, depth + 1);
    seen.delete(node);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object.`);
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_SNAPSHOT_BYTES) invalid(`${name} exceeds the maximum size.`);
}

function invalid(message: string): never {
  return fail("RETURN_AUTHORIZATION_INPUT_INVALID", message);
}

function exceeded(message: string, omsOrderLineId: number): never {
  return fail("RETURN_AUTHORIZATION_QUANTITY_EXCEEDED", message, { omsOrderLineId });
}

function fail(code: CustomerReturnAuthorizationPersistenceError["code"], message: string, context: Readonly<Record<string, string | number>> = {}): never {
  throw new CustomerReturnAuthorizationPersistenceError(code, message, context);
}
