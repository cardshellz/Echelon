import { eq } from "drizzle-orm";
import { orders, pickingLogs, type Order } from "@shared/schema";
import type { db } from "../../db";
import { readPickingReleaseActor } from "../identity";
import type { PickingAssignmentReleaseRepository } from "./picking-assignment-release.service";

type Database = Pick<typeof db, "transaction">;

function assignmentAuditState(order: Order) {
  return {
    warehouseStatus: order.warehouseStatus,
    assignedPickerId: order.assignedPickerId,
    startedAt: order.startedAt?.toISOString() ?? null,
    onHold: order.onHold,
    heldAt: order.heldAt?.toISOString() ?? null,
    pickedCount: order.pickedCount,
  };
}

export function createPickingAssignmentReleaseRepository(database: Database): PickingAssignmentReleaseRepository {
  return {
    transaction: run => database.transaction(async tx => run({
      readActor: userId => readPickingReleaseActor(tx, userId),
      lockOrder: async orderId => (await tx.select().from(orders)
        .where(eq(orders.id, orderId)).for("update"))[0],
      clearAssignment: async orderId => {
        const [order] = await tx.update(orders).set({
          warehouseStatus: "ready", assignedPickerId: null, startedAt: null,
        }).where(eq(orders.id, orderId)).returning();
        if (!order) throw new Error("Locked picking order disappeared during release");
        return order;
      },
      recordRelease: async (before, after, actor, command, now) => {
        await tx.insert(pickingLogs).values({
          timestamp: now, actionType: "order_released",
          pickerId: actor.id, pickerName: actor.name, pickerRole: actor.role,
          orderId: before.id, orderNumber: before.orderNumber,
          orderStatusBefore: before.warehouseStatus, orderStatusAfter: after.warehouseStatus,
          reason: command.reason ?? "Picking assignment released; progress and holds preserved",
          deviceType: command.deviceType, sessionId: command.sessionId,
          metadata: {
            operation: "release_picking_assignment",
            authority: before.assignedPickerId === actor.id ? "own_assignment" : "picking:release_any",
            before: assignmentAuditState(before), after: assignmentAuditState(after),
          },
        });
      },
    })),
  };
}
