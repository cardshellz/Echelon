import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { replenRules, replenTasks } from "@shared/schema";
import { assertReplenishmentTaskTransition } from "@shared/types/replenishment-task-command";
import type { db as applicationDatabase } from "../../../db";

type ReplenishmentArchiveTx = Pick<typeof applicationDatabase, "select" | "update">;

export const ARCHIVABLE_REPLEN_TASK_STATUSES = [
  "pending",
  "assigned",
  "in_progress",
  "blocked",
] as const;

export async function deactivateProductReplenishmentRulesInTx(
  tx: Pick<typeof applicationDatabase, "update">,
  productId: number,
  now: Date = new Date(),
): Promise<number> {
  const deactivated = await tx
    .update(replenRules)
    .set({ isActive: 0, updatedAt: now })
    .where(and(eq(replenRules.productId, productId), eq(replenRules.isActive, 1)))
    .returning({ id: replenRules.id });
  return deactivated.length;
}

export async function cancelProductReplenishmentTasksInTx(
  tx: ReplenishmentArchiveTx,
  productId: number,
  now: Date = new Date(),
): Promise<number> {
  const openTasks = await tx
    .select({
      id: replenTasks.id,
      status: replenTasks.status,
    })
    .from(replenTasks)
    .where(
      and(
        eq(replenTasks.productId, productId),
        inArray(replenTasks.status, [...ARCHIVABLE_REPLEN_TASK_STATUSES]),
      ),
    )
    .orderBy(asc(replenTasks.id))
    .for("update");

  if (openTasks.length === 0) {
    return 0;
  }

  for (const task of openTasks) {
    assertReplenishmentTaskTransition(task.status, "cancelled");
  }

  const cancelled = await tx
    .update(replenTasks)
    .set({
      status: "cancelled",
      completedAt: now,
      revision: sql`coalesce(${replenTasks.revision}, 0) + 1`,
    })
    .where(
      and(
        eq(replenTasks.productId, productId),
        inArray(
          replenTasks.id,
          openTasks.map((task) => task.id),
        ),
      ),
    )
    .returning({ id: replenTasks.id });

  return cancelled.length;
}

export async function archiveProductReplenishmentInTx(
  tx: ReplenishmentArchiveTx,
  productId: number,
  now: Date = new Date(),
): Promise<{ replenDeactivated: number; replenTasksCancelled: number }> {
  const replenDeactivated = await deactivateProductReplenishmentRulesInTx(tx, productId, now);
  const replenTasksCancelled = await cancelProductReplenishmentTasksInTx(tx, productId, now);
  return { replenDeactivated, replenTasksCancelled };
}
