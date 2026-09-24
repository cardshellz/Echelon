import { sql } from "drizzle-orm";
import {
  answerPickCorrectionSchema, completeCorrectivePickSchema, type PickCorrection,
} from "@shared/pick-corrections";
import {
  correctionHash, PickCorrectionError, readPickCorrection, readPickCorrections,
  recordCorrectionEvent, resolveCorrectivePick, savePickCorrectionAnswer, savePickCorrectionReview,
  saveCorrectivePickIntent, hasNewerPickDeclaration, type CorrectionExecutor,
} from "../wms/pick-correction.repository";
import type { PickingUseCases } from "./picking.use-cases";

export interface CorrectionDatabase extends CorrectionExecutor {
  transaction<T>(work: (tx: CorrectionExecutor) => Promise<T>): Promise<T>;
}
export interface CorrectivePicker {
  (input: { correction: PickCorrection; targetQuantity: number; actor: string; method: "scan" | "missed_pick_confirmation" }): Promise<void>;
}

/** Durable answer first; inventory movement is then committed by the existing picker owner.
 * A crash between the two leaves an actionable, replayable correction, never a lost Yes.
 */
export class PickCorrectionService {
  constructor(private readonly db: CorrectionDatabase, private readonly pick: CorrectivePicker,
    private readonly clock: () => Date = () => new Date()) {}

  list(): Promise<PickCorrection[]> { return readPickCorrections(this.db); }

  private async lock(tx: CorrectionExecutor, id: number): Promise<PickCorrection> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new PickCorrectionError("INVALID_INPUT", "Invalid correction ID.");
    const initial = await readPickCorrection(tx, id);
    const order = await tx.execute(sql`SELECT warehouse_status,on_hold FROM wms.orders
      WHERE id=${initial.orderId} FOR UPDATE`);
    if (!order.rows[0] || order.rows[0].warehouse_status === "cancelled" || Number(order.rows[0].on_hold) === 1)
      throw new PickCorrectionError("ORDER_NOT_PICKABLE", "This order is cancelled or on hold.");
    await tx.execute(sql`SELECT id FROM wms.order_items WHERE id=${initial.orderItemId} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM wms.pick_corrections WHERE id=${id} FOR UPDATE`);
    return readPickCorrection(tx, id);
  }

  async answer(id: number, raw: unknown, actor: string): Promise<PickCorrection> {
    const command = answerPickCorrectionSchema.parse(raw);
    if (!actor.trim()) throw new PickCorrectionError("INVALID_ACTOR", "A signed-in picker is required.");
    const hash = correctionHash({ id, actor, command });
    const correction = await this.db.transaction(async tx => {
      const before = await this.lock(tx, id);
      const replay = await tx.execute(sql`SELECT request_hash,after_state FROM wms.pick_correction_events WHERE command_id=${command.commandId}`);
      if (replay.rows.length) {
        if (replay.rows[0].request_hash !== hash) throw new PickCorrectionError("IDEMPOTENCY_CONFLICT", "This command was already used for a different answer.");
        if (before.state !== "resolved" && (before.declaredQuantity !== replay.rows[0].after_state.declaredQuantity
          || before.answer !== command.answer
          || await hasNewerPickDeclaration(tx, id, command.expectedRevision)))
          throw new PickCorrectionError("CORRECTION_CHANGED", "A newer shipment declaration needs a new answer.");
        return before;
      }
      const retryConfirmed = before.state === "picking_required" && before.answer === "yes" && command.answer === "yes";
      if (before.revision !== command.expectedRevision || (before.state !== "confirmation_required" && !retryConfirmed)
        || (before.assignedPickerId !== null && before.assignedPickerId !== actor)) {
        throw new PickCorrectionError("CORRECTION_CHANGED", "This correction changed or belongs to another picker. Refresh it.");
      }
      if (!retryConfirmed) await savePickCorrectionAnswer(tx, id, command.answer, actor, this.clock());
      const after = await readPickCorrection(tx, id);
      await recordCorrectionEvent(tx, { correctionId: id, commandId: command.commandId, requestHash: hash,
        actor, action: command.answer === "yes" ? "pick_confirmed_by_operator" : "corrective_pick_requested",
        before, after, occurredAt: this.clock() });
      return after;
    });
    if (command.answer === "yes" && correction.state !== "resolved" && correction.pickedQuantity < correction.declaredQuantity) {
      await this.applyPick(correction, correction.declaredQuantity, actor, "missed_pick_confirmation");
    }
    await this.finishIfPicked(id, actor);
    return readPickCorrection(this.db, id);
  }

  async complete(id: number, raw: unknown, actor: string): Promise<PickCorrection> {
    const command = completeCorrectivePickSchema.parse(raw);
    if (!actor.trim()) throw new PickCorrectionError("INVALID_ACTOR", "A signed-in picker is required.");
    const hash = correctionHash({ id, actor, command });
    const correction = await this.db.transaction(async tx => {
      const before = await this.lock(tx, id);
      const replay = await tx.execute(sql`SELECT request_hash,before_state FROM wms.pick_correction_events WHERE command_id=${command.commandId}`);
      if (replay.rows.length) {
        if (replay.rows[0].request_hash !== hash) throw new PickCorrectionError("IDEMPOTENCY_CONFLICT", "This command was already used for another pick.");
        if (before.state !== "resolved" && (before.state !== "picking_required"
          || before.answer !== "no"
          || before.declaredQuantity !== replay.rows[0].before_state.declaredQuantity
          || await hasNewerPickDeclaration(tx, id, command.expectedRevision)))
          throw new PickCorrectionError("CORRECTION_CHANGED", "A newer shipment declaration needs a new answer.");
        return before;
      }
      if (before.state !== "picking_required" || before.answer !== "no"
        || before.assignedPickerId !== actor || before.revision !== command.expectedRevision
        || command.pickedQuantity <= before.pickedQuantity || command.pickedQuantity > before.declaredQuantity) {
        throw new PickCorrectionError("CORRECTION_CHANGED", "Refresh the correction before confirming this pick.");
      }
      if (command.barcode !== before.barcode && command.barcode !== before.sku)
        throw new PickCorrectionError("WRONG_ITEM", "That barcode does not match the item that needs picking.");
      await saveCorrectivePickIntent(tx, id, this.clock());
      await recordCorrectionEvent(tx, { correctionId: id, commandId: command.commandId, requestHash: hash,
        actor, action: "corrective_pick_scanned", before, after: command, occurredAt: this.clock() });
      return readPickCorrection(tx, id);
    });
    if (correction.state !== "resolved" && correction.pickedQuantity < command.pickedQuantity)
      await this.applyPick(correction, command.pickedQuantity, actor, "scan");
    await this.finishIfPicked(id, actor);
    return readPickCorrection(this.db, id);
  }

  private async finishIfPicked(id: number, actor: string): Promise<void> {
    await this.db.transaction(async tx => {
      await this.lock(tx, id);
      await resolveCorrectivePick(tx, id, actor, this.clock());
    });
  }

  private async applyPick(correction: PickCorrection, targetQuantity: number, actor: string,
    method: "scan" | "missed_pick_confirmation"): Promise<void> {
    try {
      await this.pick({ correction, targetQuantity, actor, method });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Corrective pick failed. No completion was recorded.";
      const committedByAnotherAttempt = await this.db.transaction(async tx => {
        const before = await this.lock(tx, correction.id);
        if (before.pickedQuantity >= targetQuantity) return true;
        // A stale attempt must not add its error to a newer operator decision.
        if (before.state === "resolved" || before.revision !== correction.revision) return false;
        await savePickCorrectionReview(tx, correction.id, message, this.clock());
        const after = await readPickCorrection(tx, correction.id);
        await recordCorrectionEvent(tx, { correctionId: correction.id, commandId: `review:${correction.id}:${after.revision}`,
          requestHash: correctionHash(after), actor, action: "pick_needs_review", before, after, occurredAt: this.clock() });
        return false;
      });
      if (committedByAnotherAttempt) return;
      throw error;
    }
  }
}

/** Compose with the existing inventory-owning picker, never a second stock writer. */
export function createPickCorrectionService(
  db: CorrectionDatabase,
  storage: {
    getOrderItemById(id: number): Promise<{
      id: number; quantity: number; inventoryTracking?: boolean | null; catalogProductId?: number | null;
    } | undefined>;
    getOrderById(id: number): Promise<{ warehouseId: number | null } | undefined>;
    getAllWarehouseLocations(): Promise<Array<{ id: number; code: string; warehouseId: number | null }>>;
  },
  picking: Pick<PickingUseCases, "pickItem">,
  clock: () => Date = () => new Date(),
): PickCorrectionService {
  return new PickCorrectionService(db, async ({ correction, targetQuantity, actor, method }) => {
    const item = await storage.getOrderItemById(correction.orderItemId);
    if (!item) throw new PickCorrectionError("ITEM_NOT_FOUND", "The order item no longer exists.");
    let warehouseLocationId: number | undefined;
    // The frozen non-inventory policy still uses the normal confirmation owner,
    // but must not invent a bin or stock movement for a non-stock physical item.
    if (!(item.inventoryTracking === false && item.catalogProductId != null)) {
      if (["", "U", "UNASSIGNED"].includes(correction.location.trim().toUpperCase()))
        throw new PickCorrectionError("SOURCE_BIN_REQUIRED", "The original source bin is not recorded. Inventory review is required; no stock was moved.");
      const order = await storage.getOrderById(correction.orderId);
      const locations = await storage.getAllWarehouseLocations();
      const sources = locations.filter(location => order?.warehouseId != null
        && location.warehouseId === order.warehouseId
        && location.code.trim().toUpperCase() === correction.location.trim().toUpperCase());
      if (sources.length !== 1) throw new PickCorrectionError("SOURCE_BIN_REQUIRED",
        "The recorded bin must identify one location in this order's warehouse. No stock was moved.");
      warehouseLocationId = sources[0].id;
    }
    const result = await picking.pickItem(item.id, {
      status: targetQuantity === item.quantity ? "completed" : "in_progress",
      pickedQuantity: targetQuantity, pickMethod: method, userId: actor,
      pickCorrectionId: correction.id,
      pickCorrectionRevision: correction.revision,
      warehouseLocationId,
    });
    if (!result.success) throw new PickCorrectionError(result.error ?? "PICK_FAILED", result.message ?? "The correction could not be saved.");
    if (result.item.pickedQuantity !== targetQuantity) throw new PickCorrectionError("PICK_NOT_RECORDED",
      "The inventory owner did not confirm this pick. The correction remains open for review.");
    // The service closes the workflow from committed progress, including crash recovery.
  }, clock);
}
