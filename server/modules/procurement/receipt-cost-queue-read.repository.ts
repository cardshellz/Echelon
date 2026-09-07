import { sql } from "drizzle-orm";
import { receiptCostQueueReadSchema, type ReceiptCostQueueRead } from "./receipt-cost-queue-read.service";
import { dateValues, moneyValues, readRows, type Transaction } from "./purchase-workspace-read";

const HISTORY_LIMIT = 1_000;
export async function readReceiptCostQueue(tx: Transaction, purchaseOrderId: number): Promise<ReceiptCostQueueRead> {
  const [requests, attempts] = [
    await readRows(tx, sql`
      SELECT request.id, request.receiving_order_id AS "receiptId", receipt.status AS "receiptStatus", request.purchase_order_line_id AS "purchaseOrderLineId",
        request.requested_by AS "requestedBy", request.requested_at AS "requestedAt",
        CASE WHEN recovery.request_id IS NULL THEN NULL ELSE jsonb_build_object(
          'state',recovery.state,'attemptCount',recovery.attempt_count,'maxAttempts',recovery.max_attempts,
          'nextAttemptAt',recovery.next_attempt_at,'leaseExpiresAt',recovery.lease_expires_at,
          'lastErrorCode',recovery.last_error_code,'updatedAt',recovery.updated_at) END AS "automaticRecovery"
      FROM procurement.receipt_cost_requests request
      JOIN procurement.purchase_order_lines line ON line.id=request.purchase_order_line_id
      JOIN procurement.receiving_orders receipt ON receipt.id=request.receiving_order_id
      LEFT JOIN procurement.receipt_cost_recovery_jobs recovery ON recovery.request_id=request.id
      WHERE line.purchase_order_id=${purchaseOrderId} ORDER BY request.id DESC LIMIT ${HISTORY_LIMIT + 1}
    `, "receipt cost requests", HISTORY_LIMIT),
    await readRows(tx, sql`
      SELECT attempt.id, attempt.request_id AS "requestId", attempt.state, attempt.result->'summary' AS summary,
        attempt.result#>'{reconciliation,costApplications}' AS applications,
        attempt.recorded_by AS "recordedBy", attempt.recorded_at AS "recordedAt"
      FROM procurement.receipt_cost_attempts attempt
      JOIN procurement.receipt_cost_requests request ON request.id=attempt.request_id
      JOIN procurement.purchase_order_lines line ON line.id=request.purchase_order_line_id
      WHERE line.purchase_order_id=${purchaseOrderId} ORDER BY attempt.id DESC LIMIT ${HISTORY_LIMIT + 1}
    `, "receipt cost attempts", HISTORY_LIMIT),
  ] as const;
  return receiptCostQueueReadSchema.parse({
    requests: requests.map((row) => dateValues(moneyValues(row, ["id"]), ["requestedAt"])),
    attempts: attempts.map((row) => dateValues(moneyValues(row, ["id", "requestId"]), ["recordedAt"])),
  });
}
