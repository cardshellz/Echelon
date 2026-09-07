import { sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { costFingerprint, costInteger, lockInventoryCostGraph, type CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";

type Database = CostEvidenceTransaction & { transaction<T>(work: (tx: any) => Promise<T>): Promise<T> };
export type ReceiptCostReconciler = { reconcilePurchaseOrderLine(lineId: number, tx: any, actorId?: string): Promise<unknown> };
export interface ReceiptCostRequestResult {
  requestId: number;
  purchaseOrderLineId: number;
  state: "applied" | "review_required" | "retry_required";
  issues: Array<{ code: string; message: string }>;
  attemptRecorded: boolean;
}
export interface ReceiptCostQueueResult {
  state: "applied" | "review_required" | "retry_required" | "not_applicable";
  requests: ReceiptCostRequestResult[];
}

const reconciliationSchema = z.object({ costApplications: z.array(z.object({
  status: z.enum(["applied", "review_required"]),
  issues: z.array(z.object({ code: z.string(), message: z.string() })),
}).passthrough()).min(1) }).passthrough();

/** This request commits with stock. A later AP failure cannot erase the work
 * item or require the operator to post the physical receipt a second time. */
export async function enqueueReceiptCostRequests(tx: CostEvidenceTransaction, receiptId: number, lineIds: number[], actor: string, now: Date): Promise<void> {
  costInteger(receiptId, "receiptId", 1);
  if (!actor.trim() || !Number.isFinite(now.getTime())) throw new Error("Receipt cost request requires audit identity");
  for (const lineId of [...new Set(lineIds)].sort((a, b) => a - b)) {
    costInteger(lineId, "purchaseOrderLineId", 1);
    await tx.execute(sql`
      INSERT INTO procurement.receipt_cost_requests(receiving_order_id,purchase_order_line_id,requested_by,requested_at)
      VALUES (${receiptId},${lineId},${actor},${now})
      ON CONFLICT(receiving_order_id,purchase_order_line_id) DO NOTHING
    `);
  }
}

/** Each successful component application and its queue result commit together.
 * Failure rolls back financial effects, then records a separate retry outcome.
 * Even if that failure log cannot commit, the immutable request remains pending. */
export async function processReceiptCostRequests(db: Database, receiptId: number, owner: ReceiptCostReconciler | null, actor: string, clock: () => Date): Promise<ReceiptCostQueueResult> {
  costInteger(receiptId, "receiptId", 1);
  if (!actor.trim()) throw new Error("Receipt cost retry requires an actor");
  let pending: Array<{ id: unknown; purchase_order_line_id: unknown }>;
  try {
    pending = (await db.execute(sql`SELECT id,purchase_order_line_id FROM procurement.receipt_cost_requests WHERE receiving_order_id=${receiptId} ORDER BY id`)).rows;
  } catch (error) {
    console.error(JSON.stringify({ code: "RECEIPT_COST_QUEUE_UNAVAILABLE", receiptId, actor, error: error instanceof Error ? error.message : "unknown" }));
    return { state: "retry_required", requests: [] };
  }
  const requests: ReceiptCostRequestResult[] = [];
  for (const request of pending) {
    const requestId = costInteger(request.id, "requestId", 1);
    const purchaseOrderLineId = costInteger(request.purchase_order_line_id, "purchaseOrderLineId", 1);
    try {
      const result = await db.transaction(async (tx) => {
        await lockInventoryCostGraph(tx);
        const latest = (await tx.execute(sql`SELECT state,result FROM procurement.receipt_cost_attempts WHERE request_id=${requestId} ORDER BY id DESC LIMIT 1`)).rows[0];
        if (latest?.state === "applied") return { ...latest.result.summary, attemptRecorded: true } as ReceiptCostRequestResult;
        if (!owner) throw new Error("Approved invoice cost owner is unavailable");
        const reconciliation = reconciliationSchema.parse(await owner.reconcilePurchaseOrderLine(purchaseOrderLineId, tx, actor));
        const issues = reconciliation.costApplications.flatMap((application) => application.issues);
        const state = reconciliation.costApplications.every((application) => application.status === "applied") ? "applied" : "review_required";
        const summary: ReceiptCostRequestResult = { requestId, purchaseOrderLineId, state, issues, attemptRecorded: true };
        const evidence = { summary, reconciliation };
        if (latest?.state !== state || costFingerprint(latest.result) !== costFingerprint(evidence)) {
          await appendAttempt(tx, requestId, state, evidence, actor, clock());
        }
        return summary;
      });
      requests.push(result);
    } catch (error) {
      console.error(JSON.stringify({ code: "RECEIPT_COST_RETRY_REQUIRED", receiptId, requestId, purchaseOrderLineId, actor, error: error instanceof Error ? error.message : "unknown" }));
      const summary: ReceiptCostRequestResult = { requestId, purchaseOrderLineId, state: "retry_required", attemptRecorded: false,
        issues: [{ code: "RECEIPT_COST_RETRY_REQUIRED", message: "Stock was received. The cost transaction rolled back; retry cost reconciliation." }] };
      try {
        await db.transaction(async (tx) => {
          await lockInventoryCostGraph(tx);
          // Another retry may have completed while this failure was being logged.
          const latest = (await tx.execute(sql`SELECT state,result FROM procurement.receipt_cost_attempts WHERE request_id=${requestId} ORDER BY id DESC LIMIT 1`)).rows[0];
          if (latest?.state === "applied") { Object.assign(summary, latest.result.summary); return; }
          await appendAttempt(tx, requestId, "retry_required", { summary: { ...summary, attemptRecorded: true } }, actor, clock());
        });
        summary.attemptRecorded = true;
      } catch (recordError) {
        console.error(JSON.stringify({ code: "RECEIPT_COST_FAILURE_RECORD_UNAVAILABLE", receiptId, requestId, actor,
          error: recordError instanceof Error ? recordError.message : "unknown" }));
      }
      requests.push(summary);
    }
  }
  return { state: requests.some((request) => request.state === "retry_required") ? "retry_required"
    : requests.some((request) => request.state === "review_required") ? "review_required"
    : requests.length > 0 ? "applied" : "not_applicable", requests };
}

async function appendAttempt(tx: CostEvidenceTransaction, requestId: number, state: ReceiptCostRequestResult["state"], result: unknown, actor: string, now: Date): Promise<void> {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid receipt cost attempt clock");
  await tx.execute(sql`
    INSERT INTO procurement.receipt_cost_attempts(request_id,state,result,recorded_by,recorded_at)
    VALUES (${requestId},${state},${canonicalJson(result)}::jsonb,${actor},${now})
  `);
}
