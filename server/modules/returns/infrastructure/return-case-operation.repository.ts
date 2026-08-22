import { sql, type SQL } from "drizzle-orm";
import { db } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import {
  receiveExpectedWmsReturn,
  WmsReturnReceiptCommandError,
} from "../../wms/return-receipt-commands";
import {
  ReturnCaseOperationError,
  type ExistingReturnCaseCommand,
  type PersistReturnReceiptInput,
  type PersistStartInspectionInput,
  type RecordReturnReceiptResult,
  type ReturnCaseOperationAggregate,
  type ReturnCaseOperationResult,
  type ReturnCaseOperationStore,
  type ReturnCaseOperationTransaction,
  type StartReturnInspectionResult,
} from "../application/return-case-operations.service";
import {
  ReturnCaseActionDomainError,
  parseReturnPolicySnapshot,
  type ReturnInspectionFacts,
  type ReturnReceiptItemFacts,
} from "../domain/return-case-actions";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface SqlExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

interface CaseRow {
  id: unknown;
  case_number: unknown;
  oms_order_id: unknown;
  wms_return_id: unknown;
  case_status: unknown;
  approval_status: unknown;
  logistics_status: unknown;
  inspection_status: unknown;
  customer_refund_status: unknown;
  vendor_settlement_status: unknown;
  policy_id: unknown;
  policy_version: unknown;
  policy_snapshot: unknown;
}

interface WmsReturnRow {
  id: unknown;
  status: unknown;
  received_at: unknown;
  restocked: unknown;
}

interface ReceiptItemRow {
  return_case_item_id: unknown;
  canonical_quantity: unknown;
  wms_return_item_id: unknown;
  expected_qty: unknown;
  received_qty: unknown;
  status: unknown;
}

interface CountRow { total: unknown }

interface InspectionRow {
  id: unknown;
  status: unknown;
  started_at: unknown;
  started_by: unknown;
  completed_at: unknown;
  completed_by: unknown;
}

interface CommandRow {
  command_type: unknown;
  request_hash: unknown;
  response: unknown;
}

interface InsertedInspectionRow { id: unknown }

const RETURN_QUANTITY_LOCK_NAMESPACE = 918413;

export class PostgresReturnCaseOperationStore implements ReturnCaseOperationStore {
  transaction<T>(work: (tx: ReturnCaseOperationTransaction) => Promise<T>): Promise<T> {
    return db.transaction((tx) => work(new PostgresReturnCaseOperationTransaction(tx)));
  }
}

class PostgresReturnCaseOperationTransaction implements ReturnCaseOperationTransaction {
  constructor(private readonly tx: Transaction) {}

  async lockCommand(idempotencyKey: string): Promise<void> {
    await this.tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${`return-case-operation:${idempotencyKey}`}))
    `);
  }

  async findCommand(idempotencyKey: string): Promise<ExistingReturnCaseCommand | null> {
    const result = await this.tx.execute(sql`
      SELECT command_type, request_hash, response
      FROM returns.return_case_commands
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `);
    const row = rowsOf<CommandRow>(result)[0];
    if (!row) return null;
    const commandType = readCommandType(row.command_type);
    return {
      commandType,
      requestHash: readHash(row.request_hash),
      result: readStoredResult(row.response, commandType),
    };
  }

  async loadForUpdate(caseId: number): Promise<ReturnCaseOperationAggregate | null> {
    const identityResult = await this.tx.execute(sql`
      SELECT oms_order_id
      FROM returns.return_cases
      WHERE id = ${caseId}
    `);
    const identityRow = rowsOf<Pick<CaseRow, "oms_order_id">>(identityResult)[0];
    if (!identityRow) return null;

    const omsOrderId = readPositiveInteger(identityRow.oms_order_id, "OMS order id");
    await this.tx.execute(sql`
      SELECT pg_advisory_xact_lock(${RETURN_QUANTITY_LOCK_NAMESPACE}, ${omsOrderId})
    `);

    const caseResult = await this.tx.execute(sql`
      SELECT
        id, case_number, oms_order_id, wms_return_id, case_status,
        approval_status, logistics_status, inspection_status,
        customer_refund_status, vendor_settlement_status,
        policy_id, policy_version, policy_snapshot
      FROM returns.return_cases
      WHERE id = ${caseId}
      FOR UPDATE
    `);
    const row = rowsOf<CaseRow>(caseResult)[0];
    if (!row) return null;

    const lockedOmsOrderId = readPositiveInteger(row.oms_order_id, "OMS order id");
    if (lockedOmsOrderId !== omsOrderId) {
      throw new ReturnCaseOperationError(
        "RETURN_CASE_DATA_INVALID",
        "Return case OMS order identity changed while acquiring the quantity lock.",
        500,
        { caseId, expectedOmsOrderId: omsOrderId, actualOmsOrderId: lockedOmsOrderId },
      );
    }
    const wmsReturnId = readPositiveInteger(row.wms_return_id, "WMS return id");

    const wmsReturnResult = await this.tx.execute(sql`
      SELECT id, status, received_at, restocked
      FROM wms.returns
      WHERE id = ${wmsReturnId}
      FOR UPDATE
    `);
    const wmsReturn = rowsOf<WmsReturnRow>(wmsReturnResult)[0];

    const receiptResult = await this.tx.execute(sql`
      SELECT
        rci.id AS return_case_item_id,
        rci.quantity AS canonical_quantity,
        ri.id AS wms_return_item_id,
        ri.expected_qty,
        ri.received_qty,
        ri.status
      FROM wms.return_items ri
      LEFT JOIN returns.return_case_items rci
        ON rci.return_case_id = ${caseId}
       AND rci.wms_return_item_id = ri.id
      WHERE ri.return_id = ${wmsReturnId}
      ORDER BY ri.id
      FOR UPDATE OF ri
    `);
    const canonicalCountResult = await this.tx.execute(sql`
      SELECT COUNT(*)::integer AS total
      FROM returns.return_case_items
      WHERE return_case_id = ${caseId}
    `);
    const inspectionResult = await this.tx.execute(sql`
      SELECT id, status, started_at, started_by, completed_at, completed_by
      FROM returns.return_case_inspections
      WHERE return_case_id = ${caseId}
        AND status = 'in_progress'
      ORDER BY id
      FOR UPDATE
    `);

    const receiptItems = rowsOf<ReceiptItemRow>(receiptResult).map(mapReceiptItem);
    const canonicalItemCount = readNonNegativeInteger(
      rowsOf<CountRow>(canonicalCountResult)[0]?.total ?? 0,
      "canonical return item count",
    );
    const inspections = rowsOf<InspectionRow>(inspectionResult);
    if (inspections.length > 1) {
      throw new ReturnCaseOperationError(
        "RETURN_CASE_INSPECTION_DATA_INVALID",
        "Return case has more than one active inspection.",
        500,
        { caseId, activeInspectionCount: inspections.length },
      );
    }

    return {
      caseId: readPositiveInteger(row.id, "return case id"),
      caseNumber: readText(row.case_number, "return case number"),
      omsOrderId,
      wmsReturnId,
      actionContext: {
        lifecycle: {
          caseStatus: readText(row.case_status, "case status") as ReturnCaseOperationAggregate["actionContext"]["lifecycle"]["caseStatus"],
          approvalStatus: readText(row.approval_status, "approval status") as ReturnCaseOperationAggregate["actionContext"]["lifecycle"]["approvalStatus"],
          logisticsStatus: readText(row.logistics_status, "logistics status") as ReturnCaseOperationAggregate["actionContext"]["lifecycle"]["logisticsStatus"],
          inspectionStatus: readText(row.inspection_status, "inspection status") as ReturnCaseOperationAggregate["actionContext"]["lifecycle"]["inspectionStatus"],
          customerRefundStatus: readText(row.customer_refund_status, "customer refund status") as ReturnCaseOperationAggregate["actionContext"]["lifecycle"]["customerRefundStatus"],
          vendorSettlementStatus: readText(row.vendor_settlement_status, "vendor settlement status") as ReturnCaseOperationAggregate["actionContext"]["lifecycle"]["vendorSettlementStatus"],
        },
        policy: parseStoredPolicy(row.policy_snapshot, row.policy_id, row.policy_version),
        receipt: wmsReturn
          ? {
              wmsReturnId: readPositiveInteger(wmsReturn.id, "WMS return id"),
              wmsStatus: readText(wmsReturn.status, "WMS return status"),
              receivedAt: readNullableDate(wmsReturn.received_at, "WMS return received at"),
              restocked: readBoolean(wmsReturn.restocked, "WMS return restocked"),
              canonicalItemCount,
              items: receiptItems,
            }
          : null,
        inspection: inspections[0] ? mapInspection(inspections[0]) : null,
        conditionalInspectionDecision: null,
      },
    };
  }

  async persistReceipt(input: PersistReturnReceiptInput): Promise<RecordReturnReceiptResult> {
    let receipt;
    try {
      receipt = await receiveExpectedWmsReturn(this.tx, {
        returnId: input.aggregate.wmsReturnId,
        items: input.lines.map((line) => ({
          returnItemId: line.wmsReturnItemId,
          expectedCurrentReceivedQty: line.expectedCurrentReceivedQuantity,
          targetReceivedQty: line.targetReceivedQuantity,
        })),
        now: input.now,
      });
    } catch (error) {
      if (error instanceof WmsReturnReceiptCommandError) {
        throw new ReturnCaseOperationError(
          `RETURN_CASE_WMS_${error.code}`,
          error.message,
          error.code === "DATA_INTEGRITY_ERROR" ? 500 : 409,
          { ...error.context, caseId: input.aggregate.caseId },
        );
      }
      throw error;
    }
    if (receipt.status === "expected") {
      throw new ReturnCaseOperationError(
        "RETURN_CASE_RECEIPT_STATE_INVALID",
        "Receipt command did not record any received quantity.",
        500,
        { caseId: input.aggregate.caseId, wmsReturnId: input.aggregate.wmsReturnId },
      );
    }

    const expectedUnits = checkedSum(receipt.items.map((item) => item.expectedQty), "expected units");
    const receivedUnits = checkedSum(receipt.items.map((item) => item.receivedQty), "received units");
    const remainingUnits = expectedUnits - receivedUnits;
    const logisticsStatus = receipt.status;
    await this.tx.execute(sql`
      UPDATE returns.return_cases
      SET logistics_status = ${logisticsStatus},
          updated_at = ${input.now}
      WHERE id = ${input.aggregate.caseId}
    `);

    const details = {
      requestHash: input.requestHash,
      notes: input.notes,
      wmsReturnId: receipt.returnId,
      logisticsStatus,
      expectedUnits,
      receivedUnits,
      remainingUnits,
      lines: input.lines.map((line) => ({
        returnCaseItemId: line.returnCaseItemId,
        wmsReturnItemId: line.wmsReturnItemId,
        previousReceivedQuantity: line.expectedCurrentReceivedQuantity,
        targetReceivedQuantity: line.targetReceivedQuantity,
      })),
    };
    await appendEvent(this.tx, input.aggregate.caseId, "return_receipt_recorded", input.actor, details, input.now);

    const result: RecordReturnReceiptResult = {
      commandType: "record_receipt",
      caseId: input.aggregate.caseId,
      caseNumber: input.aggregate.caseNumber,
      wmsReturnId: receipt.returnId,
      logisticsStatus,
      expectedUnits,
      receivedUnits,
      remainingUnits,
      replayed: false,
    };
    await persistCommand(this.tx, input.aggregate.caseId, input.idempotencyKey, input.requestHash, result, input.actor, input.now);
    await persistAuditEvent(this.tx, {
      actor: input.actor,
      action: "RETURN_CASE_RECEIPT_RECORDED",
      target: `returns.return_cases:${input.aggregate.caseId}`,
      changes: {
        before: {
          logisticsStatus: input.aggregate.actionContext.lifecycle.logisticsStatus,
          receivedUnits: input.aggregate.actionContext.receipt?.items.reduce(
            (total, item) => total + item.wmsReceivedQuantity,
            0,
          ) ?? 0,
        },
        after: { logisticsStatus, receivedUnits },
      },
      context: details,
    }, { timestamp: input.now, emitStructuredLog: false });
    return result;
  }

  async persistStartInspection(input: PersistStartInspectionInput): Promise<StartReturnInspectionResult> {
    const inspectionResult = await this.tx.execute(sql`
      INSERT INTO returns.return_case_inspections (
        return_case_id, status, started_at, started_by, notes, created_at, updated_at
      ) VALUES (
        ${input.aggregate.caseId}, 'in_progress', ${input.now}, ${input.actor},
        ${input.notes}, ${input.now}, ${input.now}
      )
      RETURNING id
    `);
    const inspectionId = readPositiveInteger(
      rowsOf<InsertedInspectionRow>(inspectionResult)[0]?.id,
      "return inspection id",
    );
    await this.tx.execute(sql`
      UPDATE returns.return_cases
      SET inspection_status = 'in_progress',
          updated_at = ${input.now}
      WHERE id = ${input.aggregate.caseId}
    `);

    const details = {
      requestHash: input.requestHash,
      inspectionId,
      notes: input.notes,
    };
    await appendEvent(this.tx, input.aggregate.caseId, "return_inspection_started", input.actor, details, input.now);
    const result: StartReturnInspectionResult = {
      commandType: "start_inspection",
      caseId: input.aggregate.caseId,
      caseNumber: input.aggregate.caseNumber,
      inspectionId,
      inspectionStatus: "in_progress",
      startedAt: input.now.toISOString(),
      replayed: false,
    };
    await persistCommand(this.tx, input.aggregate.caseId, input.idempotencyKey, input.requestHash, result, input.actor, input.now);
    await persistAuditEvent(this.tx, {
      actor: input.actor,
      action: "RETURN_CASE_INSPECTION_STARTED",
      target: `returns.return_cases:${input.aggregate.caseId}`,
      changes: {
        before: { inspectionStatus: input.aggregate.actionContext.lifecycle.inspectionStatus },
        after: { inspectionStatus: "in_progress", inspectionId },
      },
      context: details,
    }, { timestamp: input.now, emitStructuredLog: false });
    return result;
  }
}

async function appendEvent(
  executor: SqlExecutor,
  caseId: number,
  eventType: string,
  actor: string,
  details: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO returns.return_case_events (
      return_case_id, event_type, actor, details, occurred_at, created_at
    ) VALUES (
      ${caseId}, ${eventType}, ${actor}, ${JSON.stringify(details)}::jsonb, ${now}, ${now}
    )
  `);
}

async function persistCommand(
  executor: SqlExecutor,
  caseId: number,
  idempotencyKey: string,
  requestHash: string,
  result: ReturnCaseOperationResult,
  actor: string,
  now: Date,
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO returns.return_case_commands (
      return_case_id, command_type, idempotency_key, request_hash,
      response, actor, created_at
    ) VALUES (
      ${caseId}, ${result.commandType}, ${idempotencyKey}, ${requestHash},
      ${JSON.stringify(result)}::jsonb, ${actor}, ${now}
    )
  `);
}

function mapReceiptItem(row: ReceiptItemRow): ReturnReceiptItemFacts {
  return {
    returnCaseItemId: readNullablePositiveInteger(row.return_case_item_id, "return case item id"),
    wmsReturnItemId: readPositiveInteger(row.wms_return_item_id, "WMS return item id"),
    caseExpectedQuantity: readNullablePositiveInteger(row.canonical_quantity, "canonical expected quantity"),
    wmsExpectedQuantity: readPositiveInteger(row.expected_qty, "WMS expected quantity"),
    wmsReceivedQuantity: readNonNegativeInteger(row.received_qty, "WMS received quantity"),
    wmsStatus: readText(row.status, "WMS return item status"),
  };
}

function parseStoredPolicy(
  value: unknown,
  policyIdValue: unknown,
  policyVersionValue: unknown,
): ReturnCaseOperationAggregate["actionContext"]["policy"] {
  const policyId = readPositiveInteger(policyIdValue, "return policy id");
  const policyVersion = readPositiveInteger(policyVersionValue, "return policy version");
  try {
    const policy = parseReturnPolicySnapshot(value);
    return policy.id === policyId && policy.version === policyVersion ? policy : null;
  } catch (error) {
    if (error instanceof ReturnCaseActionDomainError
      && error.code === "RETURN_POLICY_SNAPSHOT_INVALID") {
      return null;
    }
    throw error;
  }
}

function mapInspection(row: InspectionRow): ReturnInspectionFacts {
  return {
    inspectionId: readPositiveInteger(row.id, "inspection id"),
    status: readText(row.status, "inspection status") as ReturnInspectionFacts["status"],
    startedAt: readDate(row.started_at, "inspection started at"),
    startedBy: readText(row.started_by, "inspection started by"),
    completedAt: readNullableDate(row.completed_at, "inspection completed at"),
    completedBy: readNullableText(row.completed_by),
  };
}

function readStoredResult(value: unknown, commandType: ExistingReturnCaseCommand["commandType"]): ReturnCaseOperationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReturnCaseOperationError("RETURN_CASE_COMMAND_DATA_INVALID", "Stored return command response is invalid.", 500);
  }
  const row = value as Record<string, unknown>;
  if (row.commandType !== commandType) {
    throw new ReturnCaseOperationError("RETURN_CASE_COMMAND_DATA_INVALID", "Stored return command type is inconsistent.", 500);
  }
  if (commandType === "record_receipt") {
    const status = readText(row.logisticsStatus, "stored logistics status");
    if (status !== "partially_received" && status !== "received") {
      throw new ReturnCaseOperationError("RETURN_CASE_COMMAND_DATA_INVALID", "Stored receipt status is invalid.", 500);
    }
    return {
      commandType,
      caseId: readPositiveInteger(row.caseId, "stored case id"),
      caseNumber: readText(row.caseNumber, "stored case number"),
      wmsReturnId: readPositiveInteger(row.wmsReturnId, "stored WMS return id"),
      logisticsStatus: status,
      expectedUnits: readPositiveInteger(row.expectedUnits, "stored expected units"),
      receivedUnits: readPositiveInteger(row.receivedUnits, "stored received units"),
      remainingUnits: readNonNegativeInteger(row.remainingUnits, "stored remaining units"),
      replayed: readBoolean(row.replayed, "stored replayed"),
    };
  }
  const inspectionStatus = readText(row.inspectionStatus, "stored inspection status");
  if (inspectionStatus !== "in_progress") {
    throw new ReturnCaseOperationError("RETURN_CASE_COMMAND_DATA_INVALID", "Stored inspection status is invalid.", 500);
  }
  return {
    commandType,
    caseId: readPositiveInteger(row.caseId, "stored case id"),
    caseNumber: readText(row.caseNumber, "stored case number"),
    inspectionId: readPositiveInteger(row.inspectionId, "stored inspection id"),
    inspectionStatus,
    startedAt: readDate(row.startedAt, "stored inspection start").toISOString(),
    replayed: readBoolean(row.replayed, "stored replayed"),
  };
}

function readCommandType(value: unknown): ExistingReturnCaseCommand["commandType"] {
  if (value === "record_receipt" || value === "start_inspection") return value;
  throw new ReturnCaseOperationError("RETURN_CASE_COMMAND_DATA_INVALID", "Stored return command type is invalid.", 500);
}

function readHash(value: unknown): string {
  const hash = readText(value, "stored request hash");
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new ReturnCaseOperationError("RETURN_CASE_COMMAND_DATA_INVALID", "Stored return command hash is invalid.", 500);
  }
  return hash;
}

function rowsOf<T>(result: unknown): T[] {
  if (!result || typeof result !== "object" || !("rows" in result) || !Array.isArray((result as { rows: unknown }).rows)) {
    throw new ReturnCaseOperationError("RETURN_CASE_DATABASE_RESULT_INVALID", "Database result did not contain rows.", 500);
  }
  return (result as { rows: T[] }).rows;
}

function readPositiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ReturnCaseOperationError("RETURN_CASE_DATA_INVALID", `${field} is invalid.`, 500, { field, value });
  }
  return parsed;
}

function readNullablePositiveInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : readPositiveInteger(value, field);
}

function readNonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ReturnCaseOperationError("RETURN_CASE_DATA_INVALID", `${field} is invalid.`, 500, { field, value });
  }
  return parsed;
}

function readText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReturnCaseOperationError("RETURN_CASE_DATA_INVALID", `${field} is invalid.`, 500, { field, value });
  }
  return value;
}

function readNullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ReturnCaseOperationError("RETURN_CASE_DATA_INVALID", `${field} is invalid.`, 500, { field, value });
  }
  return value;
}

function readDate(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new ReturnCaseOperationError("RETURN_CASE_DATA_INVALID", `${field} is invalid.`, 500, { field, value });
  }
  return parsed;
}

function readNullableDate(value: unknown, field: string): Date | null {
  return value === null || value === undefined ? null : readDate(value, field);
}

function checkedSum(values: readonly number[], field: string): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ReturnCaseOperationError("RETURN_CASE_DATA_INVALID", `${field} exceeds the supported range.`, 500);
  }
  return total;
}
