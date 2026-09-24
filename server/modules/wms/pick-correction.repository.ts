import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { missingPickQuantity, pickCorrectionSchema, type PickCorrection } from "@shared/pick-corrections";
import { canonicalJson } from "@shared/utils/canonical-json";

export interface CorrectionExecutor {
  execute(statement: SQL): Promise<{ rows: any[] }>;
}
export class PickCorrectionError extends Error {
  readonly isOperational = true;
  readonly statusCode = 409;
  constructor(public readonly code: string, message: string) { super(message); }
}
export const correctionHash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const correctionView = sql`
  SELECT c.id, oi.order_id AS "orderId", oi.id AS "orderItemId", o.order_number AS "orderNumber",
    oi.sku, oi.name, oi.barcode, oi.location, c.declared_quantity AS "declaredQuantity",
    oi.picked_quantity AS "pickedQuantity", c.revision, c.state, c.answer,
    c.assigned_picker_id AS "assignedPickerId", c.review_reason AS "reviewReason"
  FROM wms.pick_corrections c JOIN wms.order_items oi ON oi.id = c.order_item_id
  JOIN wms.orders o ON o.id = oi.order_id`;

export async function readPickCorrections(db: CorrectionExecutor): Promise<PickCorrection[]> {
  const result = await db.execute(sql`${correctionView}
    WHERE c.state <> 'resolved' AND o.warehouse_status <> 'cancelled'
    ORDER BY c.id LIMIT 200`);
  return result.rows.map(row => pickCorrectionSchema.parse(row));
}
export async function readPickCorrection(db: CorrectionExecutor, id: number): Promise<PickCorrection> {
  const result = await db.execute(sql`${correctionView} WHERE c.id = ${id}`);
  if (result.rows.length !== 1) throw new PickCorrectionError("CORRECTION_NOT_FOUND", "Pick correction was not found.");
  return pickCorrectionSchema.parse(result.rows[0]);
}

/** A repeated command may recover a failure, but never authorize a later declaration. */
export async function hasNewerPickDeclaration(db: CorrectionExecutor, id: number, revision: number): Promise<boolean> {
  const result = await db.execute(sql`SELECT id FROM wms.pick_correction_events
    WHERE correction_id=${id} AND action='missing_pick_detected'
      AND (after_state->>'revision')::integer > ${revision} LIMIT 1`);
  return result.rows.length > 0;
}

export async function recordCorrectionEvent(db: CorrectionExecutor, input: {
  correctionId: number; commandId: string; requestHash: string; actor: string; action: string;
  before: unknown; after: unknown; occurredAt: Date;
}): Promise<void> {
  await db.execute(sql`INSERT INTO wms.pick_correction_events
    (correction_id,command_id,request_hash,actor,action,before_state,after_state,created_at)
    VALUES (${input.correctionId},${input.commandId},${input.requestHash},${input.actor},${input.action},
      ${JSON.stringify(input.before)}::jsonb,${JSON.stringify(input.after)}::jsonb,${input.occurredAt})`);
}

/** Caller holds the order lock. The declaration is already exact provider-owned package evidence. */
export async function observeMissingPick(db: CorrectionExecutor, input: {
  orderItemId: number; physicalShipmentId: number; declaredQuantity: number; pickedQuantity: number;
  occurredAt: Date;
}): Promise<void> {
  const missing = missingPickQuantity(input.declaredQuantity, input.pickedQuantity);
  const existing = await db.execute(sql`SELECT * FROM wms.pick_corrections
    WHERE order_item_id = ${input.orderItemId} FOR UPDATE`);
  const before = existing.rows[0] ?? null;
  if (missing === 0) {
    // Only an authoritative contents reduction can withdraw unresolved work. An
    // unchanged old label is never allowed to override a person's answer.
    if (before && before.state !== "resolved" && input.declaredQuantity < Number(before.declared_quantity)) {
      const saved = await db.execute(sql`UPDATE wms.pick_corrections SET state='resolved',revision=revision+1,
        review_reason=NULL,updated_at=${input.occurredAt} WHERE id=${before.id} RETURNING *`);
      const after = saved.rows[0];
      await recordCorrectionEvent(db, { correctionId: before.id,
        commandId: `withdrawn:${before.id}:${after.revision}`, requestHash: correctionHash(input),
        actor: "system:shipment_projection", action: "shipment_declaration_reduced", before, after, occurredAt: input.occurredAt });
    }
    return;
  }
  // Replaying the same old label can never erase a person's No or change ownership.
  if (before && before.state !== "resolved" && Number(before.declared_quantity) === input.declaredQuantity) return;
  const saved = await db.execute(sql`INSERT INTO wms.pick_corrections
    (order_item_id,physical_shipment_id,declared_quantity,state,created_at,updated_at)
    VALUES (${input.orderItemId},${input.physicalShipmentId},${input.declaredQuantity},
      'confirmation_required',${input.occurredAt},${input.occurredAt})
    ON CONFLICT (order_item_id) DO UPDATE SET
      declared_quantity = EXCLUDED.declared_quantity, physical_shipment_id = EXCLUDED.physical_shipment_id,
      state = 'confirmation_required', answer = NULL, revision = wms.pick_corrections.revision + 1,
      review_reason = NULL, updated_at = EXCLUDED.updated_at
    RETURNING *`);
  const after = saved.rows[0];
  await recordCorrectionEvent(db, { correctionId: after.id,
    commandId: `declaration:${input.physicalShipmentId}:${input.orderItemId}:${after.revision}`,
    requestHash: correctionHash(input), actor: "system:shipment_projection", action: "missing_pick_detected",
    before, after, occurredAt: input.occurredAt });
}

/** Never resurrect a terminal customer order. Authorization applies only to this exact pick gap. */
export async function requireCorrectivePick(db: CorrectionExecutor, input: {
  correctionId: number; orderItemId: number; targetPickedQuantity: number; actor?: string;
  expectedRevision?: number;
}): Promise<PickCorrection> {
  const correction = await readPickCorrection(db, input.correctionId);
  if (correction.orderItemId !== input.orderItemId || correction.state !== "picking_required"
    || input.targetPickedQuantity > correction.declaredQuantity
    || correction.assignedPickerId !== input.actor || correction.revision !== input.expectedRevision) {
    throw new PickCorrectionError("CORRECTION_CHANGED", "Refresh the correction before picking these units.");
  }
  return correction;
}

export async function resolveCorrectivePick(db: CorrectionExecutor, correctionId: number, actor: string, occurredAt: Date): Promise<void> {
  const before = await readPickCorrection(db, correctionId);
  if (before.state === "resolved" || before.pickedQuantity < before.declaredQuantity) return;
  await db.execute(sql`UPDATE wms.pick_corrections SET state='resolved',review_reason=NULL,
    revision=revision+1,updated_at=${occurredAt} WHERE id=${correctionId} AND state='picking_required'`);
  const after = await readPickCorrection(db, correctionId);
  if (after.state !== "resolved") return;
  await recordCorrectionEvent(db, { correctionId, commandId: `resolved:${correctionId}:${after.revision}`,
    requestHash: correctionHash(after), actor, action: "pick_reconciled", before, after, occurredAt });
}

export async function assertNoOpenPickCorrection(db: CorrectionExecutor, orderItemId: number): Promise<void> {
  const result = await db.execute(sql`SELECT id FROM wms.pick_corrections
    WHERE order_item_id=${orderItemId} AND state <> 'resolved'`);
  if (result.rows.length > 0) throw new PickCorrectionError("PICK_CORRECTION_REQUIRED",
    "Shipment inventory is waiting for the picker to resolve its missing pick record.");
}

export async function lockClaimPickCorrection(client: {
  query(statement: string, parameters?: any[]): Promise<{ rows?: any[] }>;
}, correctionId: number, orderItemId: number, targetQuantity: number, actor: string, expectedRevision?: number): Promise<void> {
  const result = await client.query(`SELECT id FROM wms.pick_corrections
    WHERE id=$1 AND order_item_id=$2 AND state='picking_required' AND declared_quantity >= $3
      AND assigned_picker_id=$4 AND revision=$5 FOR UPDATE`,
    [correctionId, orderItemId, targetQuantity, actor, expectedRevision ?? null]);
  if (result.rows?.length !== 1) throw new PickCorrectionError("CORRECTION_CHANGED", "Corrective pick authorization changed.");
}

export async function savePickCorrectionAnswer(db: CorrectionExecutor, id: number,
  answer: "yes" | "no", actor: string, occurredAt: Date): Promise<void> {
  await db.execute(sql`UPDATE wms.pick_corrections SET state='picking_required',answer=${answer},
    assigned_picker_id=${actor},review_reason=NULL,revision=revision+1,updated_at=${occurredAt} WHERE id=${id}`);
}

export async function savePickCorrectionReview(db: CorrectionExecutor, id: number,
  message: string, occurredAt: Date): Promise<void> {
  await db.execute(sql`UPDATE wms.pick_corrections SET review_reason=${message.slice(0,1000)},
    revision=revision+1,updated_at=${occurredAt} WHERE id=${id}`);
}

export async function saveCorrectivePickIntent(db: CorrectionExecutor, id: number, occurredAt: Date): Promise<void> {
  // Fence other commands from the same stale screen before releasing the decision
  // transaction. The movement owner independently fences cumulative pick progress.
  await db.execute(sql`UPDATE wms.pick_corrections SET revision=revision+1,updated_at=${occurredAt} WHERE id=${id}`);
}

/** The caller must first lock the WMS order, shared with declaration and pick writers. */
export async function assertNoOpenPickCorrectionPg(client: {
  query(statement: string, parameters?: any[]): Promise<{ rows?: any[] }>;
}, orderItemId: number): Promise<void> {
  const result = await client.query("SELECT id FROM wms.pick_corrections WHERE order_item_id=$1 AND state <> 'resolved'", [orderItemId]);
  if (result.rows?.length) throw new PickCorrectionError("PICK_CORRECTION_REQUIRED",
    "Shipment inventory is waiting for the picker to resolve its missing pick record.");
}
