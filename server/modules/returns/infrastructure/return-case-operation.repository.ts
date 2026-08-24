import { sql, type SQL } from "drizzle-orm";
import type {
  ReturnDispositionInspectionResolution,
  ReturnDispositionTreatment,
} from "@shared/schema";
import { db } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import {
  applyReturnRestock,
  ReturnRestockError,
} from "../../inventory/application/return-restock.use-case";
import {
  receiveExpectedWmsReturn,
  WmsReturnReceiptCommandError,
} from "../../wms/return-receipt-commands";
import {
  ReturnCaseOperationError,
  type ApplyReturnInventoryTreatmentResult,
  type CompleteReturnInspectionResult,
  type ExistingReturnCaseCommand,
  type PersistReturnInventoryTreatmentInput,
  type PersistCompleteInspectionInput,
  type PersistReturnDispositionInput,
  type PersistReturnReceiptInput,
  type PersistStartInspectionInput,
  type RecordReturnDispositionResult,
  type RecordReturnReceiptResult,
  type ReturnCaseOperationAggregate,
  type ReturnCaseOperationResult,
  type ReturnCaseOperationStore,
  type ReturnCaseOperationTransaction,
  type StartReturnInspectionResult,
} from "../application/return-case-operations.service";
import {
  ReturnCaseActionDomainError,
  deriveReturnCaseActionPlan,
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
  wms_order_id: unknown;
  wms_return_id: unknown;
  business_context: unknown;
  channel_provider: unknown;
  vendor_id: unknown;
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
interface DispositionHeaderRow {
  id: unknown;
}

interface DispositionItemRow {
  id: unknown;
  disposition_id: unknown;
  return_case_item_id: unknown;
  treatment: unknown;
  quantity: unknown;
}

interface OperationItemRow {
  return_case_item_id: unknown;
  oms_order_line_id: unknown;
  wms_order_item_id: unknown;
  product_variant_id: unknown;
}

interface InventoryTreatmentHeaderRow { id: unknown }
interface InventoryTreatmentItemRow {
  disposition_item_id: unknown;
  return_case_item_id: unknown;
  treatment: unknown;
  quantity: unknown;
  warehouse_location_id: unknown;
  inventory_transaction_id: unknown;
  inventory_lot_id: unknown;
}

interface InsertedDispositionRow { id: unknown }


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
        return_case.id, return_case.case_number, return_case.oms_order_id,
        return_case.wms_order_id, return_case.wms_return_id, return_case.business_context,
        channel.provider AS channel_provider, return_case.vendor_id, return_case.case_status,
        return_case.approval_status, return_case.logistics_status, return_case.inspection_status,
        return_case.customer_refund_status, return_case.vendor_settlement_status,
        return_case.policy_id, return_case.policy_version, return_case.policy_snapshot
      FROM returns.return_cases return_case
      LEFT JOIN channels.channels channel ON channel.id = return_case.channel_id
      WHERE return_case.id = ${caseId}
      FOR UPDATE OF return_case
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
    const operationItemResult = await this.tx.execute(sql`
      SELECT
        case_item.id AS return_case_item_id,
        case_item.oms_order_line_id,
        case_item.wms_order_item_id,
        oms_line.product_variant_id
      FROM returns.return_case_items case_item
      LEFT JOIN oms.oms_order_lines oms_line
        ON oms_line.id = case_item.oms_order_line_id
      WHERE case_item.return_case_id = ${caseId}
      ORDER BY case_item.id
      FOR UPDATE OF case_item
    `);
    const inspectionResult = await this.tx.execute(sql`
      SELECT id, status, started_at, started_by, completed_at, completed_by
      FROM returns.return_case_inspections
      WHERE return_case_id = ${caseId}
        AND status IN ('in_progress', 'approved', 'rejected')
      ORDER BY
        CASE WHEN status = 'in_progress' THEN 0 ELSE 1 END,
        id DESC
      LIMIT 1
      FOR UPDATE
    `);
    const dispositionResult = await this.tx.execute(sql`
      SELECT id
      FROM returns.return_case_dispositions
      WHERE return_case_id = ${caseId}
      ORDER BY id
      FOR UPDATE
    `);
    const dispositionItemResult = await this.tx.execute(sql`
      SELECT
        item.id,
        item.disposition_id,
        item.return_case_item_id,
        item.treatment,
        item.quantity
      FROM returns.return_case_disposition_items item
      JOIN returns.return_case_dispositions disposition
        ON disposition.id = item.disposition_id
      WHERE disposition.return_case_id = ${caseId}
      ORDER BY item.disposition_id, item.id
      FOR UPDATE OF item
    `);
    const inventoryTreatmentResult = await this.tx.execute(sql`
      SELECT id
      FROM returns.return_case_inventory_treatments
      WHERE return_case_id = ${caseId}
      ORDER BY id
      FOR UPDATE
    `);
    const inventoryTreatmentItemResult = await this.tx.execute(sql`
      SELECT
        item.disposition_item_id,
        item.return_case_item_id,
        item.treatment,
        item.quantity,
        item.warehouse_location_id,
        item.inventory_transaction_id,
        item.inventory_lot_id
      FROM returns.return_case_inventory_treatment_items item
      JOIN returns.return_case_inventory_treatments treatment
        ON treatment.id = item.inventory_treatment_id
      WHERE treatment.return_case_id = ${caseId}
      ORDER BY item.disposition_item_id
      FOR UPDATE OF item
    `);

    const receiptItems = rowsOf<ReceiptItemRow>(receiptResult).map(mapReceiptItem);
    const canonicalItemCount = readNonNegativeInteger(
      rowsOf<CountRow>(canonicalCountResult)[0]?.total ?? 0,
      "canonical return item count",
    );
    const inspections = rowsOf<InspectionRow>(inspectionResult);
    const operationItems = rowsOf<OperationItemRow>(operationItemResult).map((item) => ({
      returnCaseItemId: readPositiveInteger(item.return_case_item_id, "operation return case item id"),
      omsOrderLineId: readNullablePositiveInteger(item.oms_order_line_id, "operation OMS order line id"),
      wmsOrderItemId: readNullablePositiveInteger(item.wms_order_item_id, "operation WMS order item id"),
      productVariantId: readNullablePositiveInteger(item.product_variant_id, "operation product variant id"),
    }));
    const dispositionIds = rowsOf<DispositionHeaderRow>(dispositionResult)
      .map((row) => readPositiveInteger(row.id, "disposition id"));
    const dispositionLines = rowsOf<DispositionItemRow>(dispositionItemResult).map((line) => ({
      dispositionItemId: readPositiveInteger(line.id, "disposition item id"),
      dispositionId: readPositiveInteger(line.disposition_id, "disposition id"),
      returnCaseItemId: readPositiveInteger(line.return_case_item_id, "disposition case item id"),
      treatment: readDispositionTreatment(line.treatment, "disposition treatment"),
      quantity: readPositiveInteger(line.quantity, "disposition quantity"),
    }));
    const inventoryTreatmentIds = rowsOf<InventoryTreatmentHeaderRow>(inventoryTreatmentResult)
      .map((header) => readPositiveInteger(header.id, "inventory treatment id"));
    const inventoryTreatmentLines = rowsOf<InventoryTreatmentItemRow>(inventoryTreatmentItemResult).map((line) => ({
      dispositionItemId: readPositiveInteger(line.disposition_item_id, "inventory treatment disposition item id"),
      returnCaseItemId: readPositiveInteger(line.return_case_item_id, "inventory treatment return case item id"),
      treatment: readDispositionTreatment(line.treatment, "inventory treatment"),
      quantity: readPositiveInteger(line.quantity, "inventory treatment quantity"),
      warehouseLocationId: readNullablePositiveInteger(line.warehouse_location_id, "inventory treatment warehouse location id"),
      inventoryTransactionId: readNullablePositiveInteger(line.inventory_transaction_id, "inventory treatment transaction id"),
      inventoryLotId: readNullablePositiveInteger(line.inventory_lot_id, "inventory treatment lot id"),
    }));

    return {
      caseId: readPositiveInteger(row.id, "return case id"),
      caseNumber: readText(row.case_number, "return case number"),
      omsOrderId,
      wmsOrderId: readPositiveInteger(row.wms_order_id, "WMS order id"),
      wmsReturnId,
      items: operationItems,
      actionContext: {
        businessContext: readBusinessContext(row.business_context),
        channelProvider: readNullableText(row.channel_provider),
        vendorId: readNullablePositiveInteger(row.vendor_id, "return case vendor id"),
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
        disposition: dispositionIds.length > 0 ? {
          recordCount: dispositionIds.length,
          lines: dispositionLines,
        } : null,
        inventoryTreatment: inventoryTreatmentIds.length > 0 ? {
          recordCount: inventoryTreatmentIds.length,
          lines: inventoryTreatmentLines,
        } : null,
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

  async persistCompleteInspection(input: PersistCompleteInspectionInput): Promise<CompleteReturnInspectionResult> {
    const policy = input.aggregate.actionContext.policy;
    if (!policy) {
      throw new ReturnCaseOperationError(
        "RETURN_POLICY_SNAPSHOT_INVALID",
        "Return inspection completion requires a valid immutable policy snapshot.",
        500,
        { caseId: input.aggregate.caseId },
      );
    }
    const inspectionUpdate = await this.tx.execute(sql`
      UPDATE returns.return_case_inspections
      SET status = ${input.outcome},
          completed_at = ${input.now},
          completed_by = ${input.actor},
          completion_notes = ${input.notes},
          updated_at = ${input.now}
      WHERE id = ${input.inspectionId}
        AND return_case_id = ${input.aggregate.caseId}
        AND status = 'in_progress'
        AND completed_at IS NULL
        AND completed_by IS NULL
      RETURNING id
    `);
    requireSingleInspectionMutation(inspectionUpdate, input, "inspection");

    const caseUpdate = await this.tx.execute(sql`
      UPDATE returns.return_cases
      SET inspection_status = ${input.outcome},
          updated_at = ${input.now}
      WHERE id = ${input.aggregate.caseId}
        AND inspection_status = 'in_progress'
      RETURNING id
    `);
    requireSingleInspectionMutation(caseUpdate, input, "case");

    const details = {
      requestHash: input.requestHash,
      inspectionId: input.inspectionId,
      outcome: input.outcome,
      notes: input.notes,
      policyId: policy.id,
      policyVersion: policy.version,
    };
    await appendEvent(
      this.tx,
      input.aggregate.caseId,
      "return_inspection_completed",
      input.actor,
      details,
      input.now,
    );
    const result: CompleteReturnInspectionResult = {
      commandType: "complete_inspection",
      caseId: input.aggregate.caseId,
      caseNumber: input.aggregate.caseNumber,
      inspectionId: input.inspectionId,
      inspectionStatus: input.outcome,
      completedAt: input.now.toISOString(),
      replayed: false,
    };
    await persistCommand(
      this.tx,
      input.aggregate.caseId,
      input.idempotencyKey,
      input.requestHash,
      result,
      input.actor,
      input.now,
    );
    await persistAuditEvent(this.tx, {
      actor: input.actor,
      action: "RETURN_CASE_INSPECTION_COMPLETED",
      target: `returns.return_cases:${input.aggregate.caseId}`,
      changes: {
        before: {
          inspectionStatus: input.aggregate.actionContext.lifecycle.inspectionStatus,
          inspectionId: input.inspectionId,
        },
        after: { inspectionStatus: input.outcome, inspectionId: input.inspectionId },
      },
      context: details,
    }, { timestamp: input.now, emitStructuredLog: false });
    return result;
  }

  async persistDisposition(input: PersistReturnDispositionInput): Promise<RecordReturnDispositionResult> {
    const dispositionResult = await this.tx.execute(sql`
      INSERT INTO returns.return_case_dispositions (
        return_case_id, inspection_id, inspection_resolution,
        idempotency_key, request_hash, recorded_by, notes, recorded_at, created_at
      ) VALUES (
        ${input.aggregate.caseId}, ${input.inspectionId}, ${input.inspectionResolution},
        ${input.idempotencyKey}, ${input.requestHash}, ${input.actor}, ${input.notes},
        ${input.now}, ${input.now}
      )
      RETURNING id
    `);
    const insertedRows = rowsOf<InsertedDispositionRow>(dispositionResult);
    if (insertedRows.length !== 1) {
      throw new ReturnCaseOperationError(
        "RETURN_CASE_DATABASE_RESULT_INVALID",
        "Disposition evidence insert did not return exactly one record.",
        500,
        { caseId: input.aggregate.caseId, affectedRows: insertedRows.length },
      );
    }
    const dispositionId = readPositiveInteger(insertedRows[0].id, "return disposition id");

    for (const line of input.lines) {
      await this.tx.execute(sql`
        INSERT INTO returns.return_case_disposition_items (
          disposition_id, return_case_item_id, treatment, quantity, created_at
        ) VALUES (
          ${dispositionId}, ${line.returnCaseItemId}, ${line.treatment}, ${line.quantity}, ${input.now}
        )
      `);
    }

    const resultLines = input.lines.map((line) => ({
      returnCaseItemId: line.returnCaseItemId,
      quantity: line.quantity,
      treatment: line.treatment,
    }));
    const details = {
      requestHash: input.requestHash,
      dispositionId,
      inspectionId: input.inspectionId,
      inspectionResolution: input.inspectionResolution,
      notes: input.notes,
      lines: input.lines.map((line) => ({
        returnCaseItemId: line.returnCaseItemId,
        quantity: line.quantity,
        treatment: line.treatment,
        expectedCurrentReceivedQuantity: line.expectedCurrentReceivedQuantity,
        expectedCurrentDisposedQuantity: line.expectedCurrentDisposedQuantity,
      })),
      dispositionSummary: input.dispositionSummary,
    };
    await appendEvent(
      this.tx,
      input.aggregate.caseId,
      "return_disposition_recorded",
      input.actor,
      details,
      input.now,
    );

    const result: RecordReturnDispositionResult = {
      commandType: "record_disposition",
      caseId: input.aggregate.caseId,
      caseNumber: input.aggregate.caseNumber,
      dispositionId,
      inspectionId: input.inspectionId,
      inspectionResolution: input.inspectionResolution,
      lines: resultLines,
      dispositionSummary: input.dispositionSummary,
      recordedAt: input.now.toISOString(),
      replayed: false,
    };
    await persistCommand(
      this.tx,
      input.aggregate.caseId,
      input.idempotencyKey,
      input.requestHash,
      result,
      input.actor,
      input.now,
    );
    await persistAuditEvent(this.tx, {
      actor: input.actor,
      action: "RETURN_CASE_DISPOSITION_RECORDED",
      target: `returns.return_cases:${input.aggregate.caseId}`,
      changes: {
        before: {
          dispositionRecordCount: input.aggregate.actionContext.disposition?.recordCount ?? 0,
          dispositionLineCount: input.aggregate.actionContext.disposition?.lines.length ?? 0,
        },
        after: { dispositionId, dispositionSummary: input.dispositionSummary },
      },
      context: details,
    }, { timestamp: input.now, emitStructuredLog: false });
    return result;
  }

  async persistInventoryTreatment(
    input: PersistReturnInventoryTreatmentInput,
  ): Promise<ApplyReturnInventoryTreatmentResult> {
    const headerResult = await this.tx.execute(sql`
      INSERT INTO returns.return_case_inventory_treatments (
        return_case_id, idempotency_key, request_hash, applied_by,
        notes, applied_at, created_at
      ) VALUES (
        ${input.aggregate.caseId}, ${input.idempotencyKey}, ${input.requestHash},
        ${input.actor}, ${input.notes}, ${input.now}, ${input.now}
      )
      RETURNING id
    `);
    const inventoryTreatmentId = readPositiveInteger(
      rowsOf<{ id: unknown }>(headerResult)[0]?.id,
      "return inventory treatment id",
    );

    const aggregateItemById = new Map(
      input.aggregate.items.map((item) => [item.returnCaseItemId, item] as const),
    );
    const resultLines: ApplyReturnInventoryTreatmentResult["lines"] = [];
    for (const line of input.lines) {
      const caseItem = aggregateItemById.get(line.returnCaseItemId);
      if (!caseItem) {
        throw new ReturnCaseOperationError(
          "RETURN_INVENTORY_TREATMENT_STATE_STALE",
          "The returned item changed while inventory treatment was being applied.",
          409,
          { caseId: input.aggregate.caseId, returnCaseItemId: line.returnCaseItemId },
        );
      }

      let inventoryTransactionId: number | null = null;
      let inventoryLotId: number | null = null;
      if (line.treatment === "restock_sellable") {
        if (line.productVariantId === null || line.warehouseLocationId === null) {
          throw new ReturnCaseOperationError(
            "RETURN_INVENTORY_TREATMENT_VARIANT_MISSING",
            "Sellable restock requires an exact catalog variant and pickable warehouse location.",
            409,
            { caseId: input.aggregate.caseId, dispositionItemId: line.dispositionItemId },
          );
        }
        try {
          const restock = await applyReturnRestock(this.tx, {
            dispositionItemId: line.dispositionItemId,
            returnCaseId: input.aggregate.caseId,
            caseNumber: input.aggregate.caseNumber,
            productVariantId: line.productVariantId,
            warehouseLocationId: line.warehouseLocationId,
            quantity: line.quantity,
            omsOrderId: input.aggregate.omsOrderId,
            wmsOrderId: input.aggregate.wmsOrderId,
            wmsOrderItemId: caseItem.wmsOrderItemId,
            actor: input.actor,
            notes: input.notes,
            now: input.now,
          });
          inventoryTransactionId = restock.inventoryTransactionId;
          inventoryLotId = restock.inventoryLotId;
        } catch (error) {
          if (error instanceof ReturnRestockError) throw mapReturnRestockError(error, input);
          throw error;
        }
      }

      await this.tx.execute(sql`
        INSERT INTO returns.return_case_inventory_treatment_items (
          inventory_treatment_id, disposition_item_id, return_case_item_id,
          treatment, quantity, warehouse_location_id,
          inventory_transaction_id, inventory_lot_id, created_at
        ) VALUES (
          ${inventoryTreatmentId}, ${line.dispositionItemId}, ${line.returnCaseItemId},
          ${line.treatment}, ${line.quantity}, ${line.warehouseLocationId},
          ${inventoryTransactionId}, ${inventoryLotId}, ${input.now}
        )
      `);
      resultLines.push({
        dispositionItemId: line.dispositionItemId,
        returnCaseItemId: line.returnCaseItemId,
        productVariantId: line.productVariantId,
        treatment: line.treatment,
        quantity: line.quantity,
        warehouseLocationId: line.warehouseLocationId,
        inventoryTransactionId,
        inventoryLotId,
      });
    }

    const existing = input.aggregate.actionContext.inventoryTreatment;
    const inventoryTreatmentSummary = deriveReturnCaseActionPlan({
      ...input.aggregate.actionContext,
      inventoryTreatment: {
        recordCount: (existing?.recordCount ?? 0) + 1,
        lines: [
          ...(existing?.lines ?? []),
          ...resultLines.map((line) => ({
            dispositionItemId: line.dispositionItemId,
            returnCaseItemId: line.returnCaseItemId,
            treatment: line.treatment,
            quantity: line.quantity,
            warehouseLocationId: line.warehouseLocationId,
            inventoryTransactionId: line.inventoryTransactionId,
            inventoryLotId: line.inventoryLotId,
          })),
        ],
      },
    }).inventoryTreatmentSummary;
    const result: ApplyReturnInventoryTreatmentResult = {
      commandType: "apply_inventory_treatment",
      caseId: input.aggregate.caseId,
      caseNumber: input.aggregate.caseNumber,
      inventoryTreatmentId,
      lines: resultLines,
      inventoryTreatmentSummary,
      appliedAt: input.now.toISOString(),
      replayed: false,
    };
    const details = {
      requestHash: input.requestHash,
      inventoryTreatmentId,
      notes: input.notes,
      lines: resultLines,
      inventoryTreatmentSummary,
    };
    await appendEvent(this.tx, input.aggregate.caseId, "return_inventory_treatment_applied", input.actor, details, input.now);
    await persistCommand(this.tx, input.aggregate.caseId, input.idempotencyKey, input.requestHash, result, input.actor, input.now);
    await persistAuditEvent(this.tx, {
      actor: input.actor,
      action: "RETURN_CASE_INVENTORY_TREATMENT_APPLIED",
      target: `returns.return_cases:${input.aggregate.caseId}`,
      changes: {
        before: input.aggregate.actionContext.inventoryTreatment,
        after: { inventoryTreatmentId, inventoryTreatmentSummary },
      },
      context: details,
    }, { timestamp: input.now, emitStructuredLog: false });
    return result;
  }
}

function mapReturnRestockError(
  error: ReturnRestockError,
  input: PersistReturnInventoryTreatmentInput,
): ReturnCaseOperationError {
  const integrityFailure = error.code.includes("DATA_INVALID")
    || error.code.includes("INSERT_FAILED")
    || error.code.includes("LEVEL_MISSING")
    || error.code.includes("OVERFLOW");
  return new ReturnCaseOperationError(
    error.code,
    error.message,
    integrityFailure ? 500 : 409,
    { ...error.context, caseId: input.aggregate.caseId },
  );
}

function requireSingleInspectionMutation(
  result: unknown,
  input: PersistCompleteInspectionInput,
  target: "inspection" | "case",
): void {
  const rows = rowsOf<{ id: unknown }>(result);
  if (rows.length !== 1) {
    throw new ReturnCaseOperationError(
      "RETURN_CASE_INSPECTION_STATE_STALE",
      "The inspection changed while completion was being recorded. Refresh the return case and try again.",
      409,
      {
        caseId: input.aggregate.caseId,
        inspectionId: input.inspectionId,
        target,
        affectedRows: rows.length,
      },
    );
  }
  readPositiveInteger(rows[0].id, `${target} completion id`);
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
  if (commandType === "record_disposition") {
    return readStoredDispositionResult(row);
  }
  if (commandType === "apply_inventory_treatment") {
    return readStoredInventoryTreatmentResult(row);
  }
  if (commandType === "start_inspection") {
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
  const inspectionStatus = readText(row.inspectionStatus, "stored inspection completion status");
  if (inspectionStatus !== "approved" && inspectionStatus !== "rejected") {
    throw new ReturnCaseOperationError("RETURN_CASE_COMMAND_DATA_INVALID", "Stored inspection completion status is invalid.", 500);
  }
  return {
    commandType,
    caseId: readPositiveInteger(row.caseId, "stored case id"),
    caseNumber: readText(row.caseNumber, "stored case number"),
    inspectionId: readPositiveInteger(row.inspectionId, "stored inspection id"),
    inspectionStatus,
    completedAt: readDate(row.completedAt, "stored inspection completion").toISOString(),
    replayed: readBoolean(row.replayed, "stored replayed"),
  };
}


function readStoredDispositionResult(row: Record<string, unknown>): RecordReturnDispositionResult {
  const inspectionResolution = readDispositionInspectionResolution(
    row.inspectionResolution,
    "stored disposition inspection resolution",
  );
  const inspectionId = readNullablePositiveInteger(row.inspectionId, "stored disposition inspection id");
  if ((inspectionResolution === "not_required") !== (inspectionId === null)) {
    throw storedCommandInvalid("Stored disposition inspection evidence is inconsistent.");
  }

  const seenCaseItemIds = new Set<number>();
  const lines = readStoredObjectArray(row.lines, "stored disposition lines").map((line) => {
    const returnCaseItemId = readPositiveInteger(line.returnCaseItemId, "stored disposition case item id");
    if (seenCaseItemIds.has(returnCaseItemId)) {
      throw storedCommandInvalid("Stored disposition lines contain a duplicate return case item.", {
        returnCaseItemId,
      });
    }
    seenCaseItemIds.add(returnCaseItemId);
    return {
      returnCaseItemId,
      quantity: readPositiveInteger(line.quantity, "stored disposition quantity"),
      treatment: readDispositionTreatment(line.treatment, "stored disposition treatment"),
    };
  });
  if (lines.length === 0) {
    throw storedCommandInvalid("Stored disposition lines are empty.");
  }

  const dispositionSummary = readStoredDispositionSummary(row.dispositionSummary);
  const summaryItemIds = new Set(dispositionSummary.items.map((item) => item.returnCaseItemId));
  if (lines.some((line) => !summaryItemIds.has(line.returnCaseItemId))) {
    throw storedCommandInvalid("Stored disposition lines do not match the stored summary.");
  }

  return {
    commandType: "record_disposition",
    caseId: readPositiveInteger(row.caseId, "stored case id"),
    caseNumber: readText(row.caseNumber, "stored case number"),
    dispositionId: readPositiveInteger(row.dispositionId, "stored disposition id"),
    inspectionId,
    inspectionResolution,
    lines,
    dispositionSummary,
    recordedAt: readDate(row.recordedAt, "stored disposition recorded at").toISOString(),
    replayed: readBoolean(row.replayed, "stored replayed"),
  };
}

function readStoredDispositionSummary(value: unknown): RecordReturnDispositionResult["dispositionSummary"] {
  const row = readStoredObject(value, "stored disposition summary");
  const itemRows = readStoredObjectArray(row.items, "stored disposition summary items");
  if (itemRows.length === 0) {
    throw storedCommandInvalid("Stored disposition summary items are empty.");
  }
  const seenCaseItemIds = new Set<number>();
  const items = itemRows.map((item) => {
    const returnCaseItemId = readPositiveInteger(item.returnCaseItemId, "stored summary case item id");
    if (seenCaseItemIds.has(returnCaseItemId)) {
      throw storedCommandInvalid("Stored disposition summary contains a duplicate return case item.", {
        returnCaseItemId,
      });
    }
    seenCaseItemIds.add(returnCaseItemId);
    const receivedQuantity = readNonNegativeInteger(item.receivedQuantity, "stored received quantity");
    const restockSellableQuantity = readNonNegativeInteger(
      item.restockSellableQuantity,
      "stored restock sellable quantity",
    );
    const holdNonSellableQuantity = readNonNegativeInteger(
      item.holdNonSellableQuantity,
      "stored hold non-sellable quantity",
    );
    const recordedQuantity = readNonNegativeInteger(item.recordedQuantity, "stored recorded quantity");
    const remainingQuantity = readNonNegativeInteger(item.remainingQuantity, "stored remaining quantity");
    if (checkedSum([restockSellableQuantity, holdNonSellableQuantity], "stored treatment quantity")
      !== recordedQuantity
      || checkedSum([recordedQuantity, remainingQuantity], "stored item quantity") !== receivedQuantity) {
      throw storedCommandInvalid("Stored disposition item summary totals are inconsistent.", {
        returnCaseItemId,
      });
    }
    return {
      returnCaseItemId,
      receivedQuantity,
      restockSellableQuantity,
      holdNonSellableQuantity,
      recordedQuantity,
      remainingQuantity,
    };
  });

  const receivedUnits = readNonNegativeInteger(row.receivedUnits, "stored disposition received units");
  const recordedUnits = readNonNegativeInteger(row.recordedUnits, "stored disposition recorded units");
  const remainingUnits = readNonNegativeInteger(row.remainingUnits, "stored disposition remaining units");
  const actualReceivedUnits = checkedSum(items.map((item) => item.receivedQuantity), "stored received units");
  const actualRecordedUnits = checkedSum(items.map((item) => item.recordedQuantity), "stored recorded units");
  const actualRemainingUnits = checkedSum(items.map((item) => item.remainingQuantity), "stored remaining units");
  const fullyRecorded = readBoolean(row.fullyRecorded, "stored fully recorded");
  const partiallyRecorded = readBoolean(row.partiallyRecorded, "stored partially recorded");
  if (receivedUnits <= 0
    || receivedUnits !== actualReceivedUnits
    || recordedUnits !== actualRecordedUnits
    || remainingUnits !== actualRemainingUnits
    || checkedSum([recordedUnits, remainingUnits], "stored disposition units") !== receivedUnits
    || fullyRecorded !== (remainingUnits === 0)
    || partiallyRecorded !== (recordedUnits > 0 && remainingUnits > 0)) {
    throw storedCommandInvalid("Stored disposition summary totals are inconsistent.");
  }

  return { receivedUnits, recordedUnits, remainingUnits, fullyRecorded, partiallyRecorded, items };
}

function readStoredInventoryTreatmentResult(
  row: Record<string, unknown>,
): ApplyReturnInventoryTreatmentResult {
  const seenDispositionItems = new Set<number>();
  const lines = readStoredObjectArray(row.lines, "stored inventory treatment lines").map((line) => {
    const dispositionItemId = readPositiveInteger(line.dispositionItemId, "stored disposition item id");
    if (seenDispositionItems.has(dispositionItemId)) {
      throw storedCommandInvalid("Stored inventory treatment contains a duplicate disposition item.");
    }
    seenDispositionItems.add(dispositionItemId);
    const treatment = readDispositionTreatment(line.treatment, "stored inventory treatment");
    const productVariantId = readNullablePositiveInteger(line.productVariantId, "stored product variant id");
    const warehouseLocationId = readNullablePositiveInteger(line.warehouseLocationId, "stored warehouse location id");
    const inventoryTransactionId = readNullablePositiveInteger(line.inventoryTransactionId, "stored inventory transaction id");
    const inventoryLotId = readNullablePositiveInteger(line.inventoryLotId, "stored inventory lot id");
    if (treatment === "restock_sellable"
      ? productVariantId === null || warehouseLocationId === null || inventoryTransactionId === null || inventoryLotId === null
      : productVariantId !== null || warehouseLocationId !== null || inventoryTransactionId !== null || inventoryLotId !== null) {
      throw storedCommandInvalid("Stored inventory treatment evidence is inconsistent.", { dispositionItemId });
    }
    return {
      dispositionItemId,
      returnCaseItemId: readPositiveInteger(line.returnCaseItemId, "stored return case item id"),
      productVariantId,
      treatment,
      quantity: readPositiveInteger(line.quantity, "stored inventory treatment quantity"),
      warehouseLocationId,
      inventoryTransactionId,
      inventoryLotId,
    };
  });
  if (lines.length === 0) throw storedCommandInvalid("Stored inventory treatment lines are empty.");
  const inventoryTreatmentSummary = readStoredInventoryTreatmentSummary(row.inventoryTreatmentSummary);
  if (lines.some((line) => !inventoryTreatmentSummary.items.some(
    (item) => item.dispositionItemId === line.dispositionItemId && item.applied,
  ))) {
    throw storedCommandInvalid("Stored inventory treatment lines do not match the stored summary.");
  }
  return {
    commandType: "apply_inventory_treatment",
    caseId: readPositiveInteger(row.caseId, "stored case id"),
    caseNumber: readText(row.caseNumber, "stored case number"),
    inventoryTreatmentId: readPositiveInteger(row.inventoryTreatmentId, "stored inventory treatment id"),
    lines,
    inventoryTreatmentSummary,
    appliedAt: readDate(row.appliedAt, "stored inventory treatment timestamp").toISOString(),
    replayed: readBoolean(row.replayed, "stored replayed"),
  };
}

function readStoredInventoryTreatmentSummary(
  value: unknown,
): ApplyReturnInventoryTreatmentResult["inventoryTreatmentSummary"] {
  const row = readStoredObject(value, "stored inventory treatment summary");
  const items = readStoredObjectArray(row.items, "stored inventory treatment summary items").map((item) => ({
    dispositionItemId: readPositiveInteger(item.dispositionItemId, "stored summary disposition item id"),
    returnCaseItemId: readPositiveInteger(item.returnCaseItemId, "stored summary return case item id"),
    treatment: readDispositionTreatment(item.treatment, "stored summary inventory treatment"),
    quantity: readPositiveInteger(item.quantity, "stored summary inventory treatment quantity"),
    warehouseLocationId: readNullablePositiveInteger(item.warehouseLocationId, "stored summary warehouse location id"),
    inventoryTransactionId: readNullablePositiveInteger(item.inventoryTransactionId, "stored summary transaction id"),
    inventoryLotId: readNullablePositiveInteger(item.inventoryLotId, "stored summary lot id"),
    applied: readBoolean(item.applied, "stored summary applied"),
  }));
  if (items.length === 0 || new Set(items.map((item) => item.dispositionItemId)).size !== items.length) {
    throw storedCommandInvalid("Stored inventory treatment summary items are invalid.");
  }
  const dispositionUnits = readPositiveInteger(row.dispositionUnits, "stored disposition units");
  const appliedUnits = readNonNegativeInteger(row.appliedUnits, "stored applied units");
  const remainingUnits = readNonNegativeInteger(row.remainingUnits, "stored remaining units");
  const fullyApplied = readBoolean(row.fullyApplied, "stored fully applied");
  const partiallyApplied = readBoolean(row.partiallyApplied, "stored partially applied");
  const actualDispositionUnits = checkedSum(items.map((item) => item.quantity), "stored disposition units");
  const actualAppliedUnits = checkedSum(items.filter((item) => item.applied).map((item) => item.quantity), "stored applied units");
  if (dispositionUnits !== actualDispositionUnits
    || appliedUnits !== actualAppliedUnits
    || remainingUnits !== dispositionUnits - appliedUnits
    || fullyApplied !== (remainingUnits === 0)
    || partiallyApplied !== (appliedUnits > 0 && remainingUnits > 0)) {
    throw storedCommandInvalid("Stored inventory treatment summary totals are inconsistent.");
  }
  return { dispositionUnits, appliedUnits, remainingUnits, fullyApplied, partiallyApplied, items };
}

function readStoredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw storedCommandInvalid(`${field} is invalid.`, { field });
  }
  return value as Record<string, unknown>;
}

function readStoredObjectArray(value: unknown, field: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw storedCommandInvalid(`${field} is invalid.`, { field });
  return value.map((item) => readStoredObject(item, field));
}

function storedCommandInvalid(
  message: string,
  context?: Record<string, unknown>,
): ReturnCaseOperationError {
  return new ReturnCaseOperationError("RETURN_CASE_COMMAND_DATA_INVALID", message, 500, context);
}
function readCommandType(value: unknown): ExistingReturnCaseCommand["commandType"] {
  if (value === "record_receipt"
    || value === "start_inspection"
    || value === "complete_inspection"
    || value === "record_disposition"
    || value === "apply_inventory_treatment") return value;
  throw new ReturnCaseOperationError("RETURN_CASE_COMMAND_DATA_INVALID", "Stored return command type is invalid.", 500);
}

function readDispositionTreatment(value: unknown, field: string): ReturnDispositionTreatment {
  if (value === "restock_sellable" || value === "hold_non_sellable") return value;
  throw new ReturnCaseOperationError("RETURN_CASE_DATA_INVALID", `${field} is invalid.`, 500, { field, value });
}

function readDispositionInspectionResolution(
  value: unknown,
  field: string,
): ReturnDispositionInspectionResolution {
  if (value === "approved" || value === "rejected" || value === "not_required") return value;
  throw new ReturnCaseOperationError("RETURN_CASE_DATA_INVALID", `${field} is invalid.`, 500, { field, value });
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

function readBusinessContext(
  value: unknown,
): ReturnCaseOperationAggregate["actionContext"]["businessContext"] {
  if (value === "retail" || value === "dropship") return value;
  throw new ReturnCaseOperationError("RETURN_CASE_DATA_INVALID", "Return case business context is invalid.", 500);
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
