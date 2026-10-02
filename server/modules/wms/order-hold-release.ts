import { eq } from "drizzle-orm";
import { wmsOrders, type WmsOrder } from "@shared/schema";
import { IntegrityError } from "@shared/errors";
import { decideOrderHoldRelease, type OrderHoldReleaseDecision } from "@shared/wms-hold-release";
import type { db as appDb } from "../../db";

type Database = Pick<typeof appDb, "transaction">;
export type OrderHoldReleaseTransaction = Parameters<Parameters<typeof appDb.transaction>[0]>[0];

export type OrderHoldSnapshot = Pick<WmsOrder, "onHold" | "heldAt" | "warehouseStatus">;

/** `order` is the row after a release, or as found when nothing changed. */
export type OrderHoldReleaseResult =
  | { outcome: "released"; order: WmsOrder; before: OrderHoldSnapshot }
  | { outcome: Exclude<OrderHoldReleaseDecision, "release" | "not_found">; order: WmsOrder; before: OrderHoldSnapshot }
  | { outcome: "not_found"; order: null; before: null };

/** Runs inside the release transaction, so durable follow-ups commit with it. */
export type OrderHoldReleaseFollowUp = (tx: OrderHoldReleaseTransaction) => Promise<void>;

/**
 * Guarded order-level release (decideOrderHoldRelease). The row lock makes a
 * concurrent hold or second release wait, so the decision and the write see
 * the same state, and only a real release changes anything. The caller's
 * durable follow-up (the ShipStation hold-sync row) commits in the same
 * transaction: a crash after commit cannot strand ShipStation on a hold that
 * WMS already released, and a failed follow-up rolls the release back.
 */
export async function releaseWmsOrderHold(
  db: Database,
  args: { orderId: number; now: Date; followUp?: OrderHoldReleaseFollowUp },
): Promise<OrderHoldReleaseResult> {
  return db.transaction(async (tx): Promise<OrderHoldReleaseResult> => {
    const [current] = await tx.select().from(wmsOrders).where(eq(wmsOrders.id, args.orderId)).for("update");
    if (!current) return { outcome: "not_found", order: null, before: null };
    const before: OrderHoldSnapshot = {
      onHold: current.onHold,
      heldAt: current.heldAt,
      warehouseStatus: current.warehouseStatus,
    };
    const decision = decideOrderHoldRelease(current);
    if (decision === "not_found") return { outcome: "not_found", order: null, before: null };
    if (decision !== "release") return { outcome: decision, order: current, before };

    const [released] = await tx.update(wmsOrders)
      .set({ onHold: 0, heldAt: null, updatedAt: args.now })
      .where(eq(wmsOrders.id, args.orderId))
      .returning();
    // Unreachable while the row lock is held; throwing rolls the release back.
    if (!released) throw new IntegrityError(`Order ${args.orderId} vanished during hold release`);
    if (args.followUp) await args.followUp(tx);
    return { outcome: "released", order: released, before };
  });
}
